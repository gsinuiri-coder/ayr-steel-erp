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
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Márgenes</h1>
        {/*
          D-163: la página dejó de ser informativa. El margen mínimo es ahora el **piso duro**
          de toda cotización y pedido nuevos, así que la fórmula tiene que estar a la vista de
          quien la edita: subirla un punto sube el mínimo de todo el catálogo de esa línea.
        */}
        <p className="text-sm text-muted-foreground">
          El margen es <strong>sobre la venta</strong>, no sobre el costo:{' '}
          <span className="tabular-nums">precio mínimo = costo promedio ÷ (1 − margen) × 1.18</span>
          . Con un costo de S/ 100 y un 20%, el valor de venta es S/ 125 (no S/ 120) y el precio con
          IGV, S/ 147.50.
        </p>
        <p className="text-sm text-muted-foreground">
          El <strong>margen mínimo</strong> es el piso: ninguna cotización ni pedido nuevo se puede
          guardar por debajo de él, tampoco un administrador. Bajar un precio legítimamente se hace
          acá, y queda auditado. El <strong>margen sugerido</strong> es solo el objetivo.
        </p>
        <p className="text-sm text-muted-foreground">
          Un SKU que nunca entró al kardex no tiene costo promedio y por lo tanto no tiene piso. Los
          documentos ya emitidos y los que carga el importador no se recalculan.
        </p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Línea</TableHead>
              <TableHead>Margen sugerido (%)</TableHead>
              <TableHead>Margen mínimo (%) — piso duro</TableHead>
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
            {settings.isSuccess && settings.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No hay líneas de negocio configuradas todavía.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
