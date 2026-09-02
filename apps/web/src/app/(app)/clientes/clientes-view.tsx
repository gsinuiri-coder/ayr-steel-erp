'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DOC_TYPE_LABELS, ImportEntity, Role, type CustomerDto } from '@ayr/shared';
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
import { ImportDialog } from '@/components/imports/import-dialog';
import { CustomerDialog } from './customer-dialog';

const CUSTOMERS_QUERY_KEY = ['customers'] as const;

/** RF-80/RF-82/RF-84: clientes. */
export function ClientesView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [dialog, setDialog] = useState<{ open: boolean; customer?: CustomerDto; nonce: number }>({
    open: false,
    nonce: 0,
  });
  const openDialog = (customer?: CustomerDto) => {
    setDialog((d) => ({ open: true, customer, nonce: d.nonce + 1 }));
  };
  const [search, setSearch] = useState('');

  const customers = useQuery({
    queryKey: CUSTOMERS_QUERY_KEY,
    queryFn: () => api<CustomerDto[]>('/customers'),
  });
  const filtered = customers.data?.filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.docNumber.toLowerCase().includes(q);
  });

  const toggleActive = useMutation({
    mutationFn: (c: CustomerDto) =>
      api<CustomerDto>(`/customers/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Cliente activado' : 'Cliente desactivado');
      void queryClient.invalidateQueries({ queryKey: CUSTOMERS_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Clientes</h1>
          <p className="text-sm text-muted-foreground">Alta, edición y baja de clientes (RF-80).</p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <ImportDialog
              entity={ImportEntity.CUSTOMERS}
              invalidateQueryKey={CUSTOMERS_QUERY_KEY}
            />
          )}
          {isAdmin && (
            <Button
              onClick={() => {
                openDialog();
              }}
            >
              Nuevo cliente
            </Button>
          )}
        </div>
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
              <TableHead>Documento</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Contacto</TableHead>
              <TableHead>Días de crédito</TableHead>
              <TableHead>Estado</TableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {customers.isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-destructive">
                  No se pudieron cargar los clientes.
                </TableCell>
              </TableRow>
            )}
            {filtered?.map((c) => (
              <TableRow key={c.id} data-state={c.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">
                  {DOC_TYPE_LABELS[c.docType]} {c.docNumber}
                </TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell className="text-muted-foreground">{c.email ?? c.phone ?? '—'}</TableCell>
                <TableCell>{c.creditDays}</TableCell>
                <TableCell>
                  {c.isActive ? (
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
                        openDialog(c);
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggleActive.isPending}
                      onClick={() => {
                        toggleActive.mutate(c);
                      }}
                    >
                      {c.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {filtered?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {search
                    ? 'Ningún cliente coincide con la búsqueda.'
                    : 'No hay clientes registrados.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin && (
        <CustomerDialog
          key={`${dialog.customer?.id ?? 'nuevo'}-${dialog.nonce}`}
          open={dialog.open}
          customer={dialog.customer}
          onOpenChange={(open) => {
            setDialog((d) => ({ ...d, open }));
          }}
        />
      )}
    </>
  );
}
