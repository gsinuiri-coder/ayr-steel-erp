'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DOC_TYPE_LABELS, Role, type SupplierDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
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
import { SupplierDialog } from './supplier-dialog';

const SUPPLIERS_QUERY_KEY = ['suppliers'] as const;

/** RF-81/RF-83/RF-84: proveedores, incluido si prestan corte tercerizado (D-033/P-10). */
export function ProveedoresView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [dialog, setDialog] = useState<{ open: boolean; supplier?: SupplierDto; nonce: number }>({
    open: false,
    nonce: 0,
  });
  const openDialog = (supplier?: SupplierDto) => {
    setDialog((d) => ({ open: true, supplier, nonce: d.nonce + 1 }));
  };
  const [search, setSearch] = useState('');

  const suppliers = useQuery({
    queryKey: SUPPLIERS_QUERY_KEY,
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });
  const filtered = suppliers.data?.filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.docNumber.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q)
    );
  });

  const toggleActive = useMutation({
    mutationFn: (s: SupplierDto) =>
      api<SupplierDto>(`/suppliers/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Proveedor activado' : 'Proveedor desactivado');
      void queryClient.invalidateQueries({ queryKey: SUPPLIERS_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Proveedores</h1>
          <p className="text-sm text-muted-foreground">
            Alta, edición y baja de proveedores (RF-81).
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => {
              openDialog();
            }}
          >
            Nuevo proveedor
          </Button>
        )}
      </div>

      <Input
        placeholder="Buscar por nombre o número de documento…"
        className="max-w-sm"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
      />

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Documento</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Corte tercerizado</TableHead>
              <TableHead>Días de crédito</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {suppliers.isError && (
              <TableRow>
                <TableCell colSpan={7} className="text-destructive">
                  No se pudieron cargar los proveedores.
                </TableCell>
              </TableRow>
            )}
            {filtered?.map((s) => (
              <TableRow key={s.id} data-state={s.isActive ? undefined : 'inactive'}>
                <TableCell className="font-mono font-medium">{s.code}</TableCell>
                <TableCell>
                  {DOC_TYPE_LABELS[s.docType]} {s.docNumber}
                </TableCell>
                <TableCell>{s.name}</TableCell>
                <TableCell>
                  {s.providesCuttingService ? (
                    <Badge variant="secondary">Sí</Badge>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell>{s.creditDays}</TableCell>
                <TableCell>
                  {s.isActive ? (
                    <Badge variant="secondary">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/proveedores/${s.id}/estado-cuenta`}>Estado de cuenta</Link>
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openDialog(s);
                      }}
                    >
                      Editar
                    </Button>
                  )}
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleActive.isPending}
                      onClick={() => {
                        toggleActive.mutate(s);
                      }}
                    >
                      {s.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filtered?.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {search
                    ? 'Ningún proveedor coincide con la búsqueda.'
                    : 'No hay proveedores registrados.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin && (
        <SupplierDialog
          key={`${dialog.supplier?.id ?? 'nuevo'}-${dialog.nonce}`}
          open={dialog.open}
          supplier={dialog.supplier}
          onOpenChange={(open) => {
            setDialog((d) => ({ ...d, open }));
          }}
        />
      )}
    </>
  );
}
