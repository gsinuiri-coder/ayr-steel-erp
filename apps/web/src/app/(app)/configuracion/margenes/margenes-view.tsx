'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BUSINESS_LINE_LABELS, Role, type PricingSettingDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PRICING_QUERY_KEY = ['pricing'] as const;

/** D-032/P-09: margen sugerido y margen mínimo por línea. Solo ADMINISTRADOR edita. */
export function MargenesView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { marginPct: string; minMarginPct: string }>>(
    {},
  );

  const settings = useQuery({
    queryKey: PRICING_QUERY_KEY,
    queryFn: () => api<PricingSettingDto[]>('/pricing'),
  });

  const save = useMutation({
    mutationFn: ({
      businessLineId,
      body,
    }: {
      businessLineId: string;
      body: Record<string, string>;
    }) => api<PricingSettingDto>(`/pricing/${businessLineId}`, { method: 'PATCH', body }),
    onSuccess: (updated) => {
      toast.success(`Margen de ${BUSINESS_LINE_LABELS[updated.businessLineCode]} actualizado`);
      void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEY });
      setEdits((e) => {
        const { [updated.businessLineId]: _removed, ...rest } = e;
        return rest;
      });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar el margen');
    },
  });

  if (user.role !== Role.ADMINISTRADOR) {
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        No tienes permiso para ver esta sección.
      </div>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Márgenes</h1>
        <p className="text-sm text-muted-foreground">
          Precio sugerido = costo promedio × (1 + margen%). El margen mínimo es el piso que un
          VENDEDOR no puede bajar (D-032).
        </p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Línea</TableHead>
              <TableHead>Margen sugerido (%)</TableHead>
              <TableHead>Margen mínimo (%)</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {settings.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {settings.isError && (
              <TableRow>
                <TableCell colSpan={4} className="text-destructive">
                  No se pudieron cargar los márgenes.
                </TableCell>
              </TableRow>
            )}
            {settings.data?.map((s) => {
              const edit = edits[s.businessLineId] ?? {
                marginPct: s.marginPct,
                minMarginPct: s.minMarginPct,
              };
              const dirty = edit.marginPct !== s.marginPct || edit.minMarginPct !== s.minMarginPct;
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {BUSINESS_LINE_LABELS[s.businessLineCode]}
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-28"
                      inputMode="decimal"
                      aria-label={`Margen sugerido de ${BUSINESS_LINE_LABELS[s.businessLineCode]}`}
                      value={edit.marginPct}
                      onChange={(e) => {
                        setEdits((prev) => ({
                          ...prev,
                          [s.businessLineId]: { ...edit, marginPct: e.target.value },
                        }));
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8 w-28"
                      inputMode="decimal"
                      aria-label={`Margen mínimo de ${BUSINESS_LINE_LABELS[s.businessLineCode]}`}
                      value={edit.minMarginPct}
                      onChange={(e) => {
                        setEdits((prev) => ({
                          ...prev,
                          [s.businessLineId]: { ...edit, minMarginPct: e.target.value },
                        }));
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      disabled={!dirty || save.isPending}
                      onClick={() => {
                        save.mutate({ businessLineId: s.businessLineId, body: edit });
                      }}
                    >
                      Guardar
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
