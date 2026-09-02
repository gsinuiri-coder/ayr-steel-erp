'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Role, type FinishDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FinishDialog } from './finish-dialog';

const FINISHES_QUERY_KEY = ['finishes'] as const;

/** RF-25: catálogo de acabados de bobina, con su factor de densidad. */
export function AcabadosView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [dialog, setDialog] = useState<{ open: boolean; finish?: FinishDto; nonce: number }>({
    open: false,
    nonce: 0,
  });
  const openDialog = (finish?: FinishDto) => {
    setDialog((d) => ({ open: true, finish, nonce: d.nonce + 1 }));
  };

  const finishes = useQuery({
    queryKey: FINISHES_QUERY_KEY,
    queryFn: () => api<FinishDto[]>('/finishes'),
  });

  const toggleActive = useMutation({
    mutationFn: (f: FinishDto) =>
      api<FinishDto>(`/finishes/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Acabado activado' : 'Acabado desactivado');
      void queryClient.invalidateQueries({ queryKey: FINISHES_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Acabados</h1>
          <p className="text-sm text-muted-foreground">
            Catálogo de acabados de bobina y su factor de densidad (RF-25).
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => {
              openDialog();
            }}
          >
            Nuevo acabado
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Factor de densidad</TableHead>
              <TableHead>Estado</TableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {finishes.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {finishes.isError && (
              <TableRow>
                <TableCell colSpan={5} className="text-destructive">
                  No se pudieron cargar los acabados.
                </TableCell>
              </TableRow>
            )}
            {finishes.data?.map((f) => (
              <TableRow key={f.id} data-state={f.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">{f.code}</TableCell>
                <TableCell>{f.name}</TableCell>
                <TableCell>{f.densityFactor}</TableCell>
                <TableCell>
                  {f.isActive ? (
                    <Badge variant="secondary">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openDialog(f);
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleActive.isPending}
                      onClick={() => {
                        toggleActive.mutate(f);
                      }}
                    >
                      {f.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {finishes.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No hay acabados registrados.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin && (
        <FinishDialog
          key={`${dialog.finish?.id ?? 'nuevo'}-${dialog.nonce}`}
          open={dialog.open}
          finish={dialog.finish}
          onOpenChange={(open) => {
            setDialog((d) => ({ ...d, open }));
          }}
        />
      )}
    </>
  );
}
