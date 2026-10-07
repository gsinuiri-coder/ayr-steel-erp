'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import { DOC_TYPE_LABELS, Role, type SupplierDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { HeaderActions } from '@/components/header-actions';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SupplierDialog } from './supplier-dialog';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';
import { RowActions } from '@/components/row-actions';
import { ConfirmDialog } from '@/components/confirm-dialog';

const SUPPLIERS_QUERY_KEY = ['suppliers'] as const;

/** RF-81/RF-83/RF-84: proveedores, incluido si prestan corte tercerizado (D-033/P-10). */
export function ProveedoresView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<
    'code' | 'document' | 'name' | 'cutting' | 'credit' | 'status'
  >();
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
  // cc31: la búsqueda vive en la URL como en las demás listas (D-289). El filtro es local y usa
  // lo tecleado al instante; la URL se actualiza al dejar de teclear.
  const [url, setUrl] = useUrlState({ search: '' });
  const [search, setSearch] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

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

  // cc31 (ESPEC §6): desactivar pide confirmación; activar no.
  const [toDeactivate, setToDeactivate] = useState<SupplierDto | null>(null);

  const toggleActive = useMutation({
    mutationFn: (s: SupplierDto) =>
      api<SupplierDto>(`/suppliers/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }),
    onSuccess: (updated) => {
      setToDeactivate(null);
      toast.success(updated.isActive ? 'Proveedor activado' : 'Proveedor desactivado');
      void queryClient.invalidateQueries({ queryKey: SUPPLIERS_QUERY_KEY });
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo actualizar')),
  });

  const searching = search.trim() !== '';
  const shownCount = filtered?.length ?? 0;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Proveedores</h1>
            {searching && (
              <span className="text-muted-foreground">que coinciden con la búsqueda</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Alta, edición y baja de proveedores.</p>
        </div>
        <HeaderActions
          primary={['new']}
          actions={[
            {
              key: 'new',
              label: 'Nuevo proveedor',
              show: isAdmin,
              onSelect: () => {
                openDialog();
              },
            },
          ]}
        />
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
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="code">
                Código
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="document">
                Documento
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="name">
                Nombre
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="cutting">
                Corte tercerizado
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="credit">
                Días de crédito
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortRows(filtered ?? [], sort, {
              code: { text: (s) => s.code },
              document: { text: (s) => `${s.docType} ${s.docNumber}` },
              name: { text: (s) => s.name },
              cutting: { text: (s) => (s.providesCuttingService ? 'Sí' : 'No') },
              credit: { decimal: (s) => String(s.creditDays) },
              status: { text: (s) => (s.isActive ? 'Activo' : 'Inactivo') },
            }).map((s) => (
              <TableRow key={s.id} data-state={s.isActive ? undefined : 'inactive'}>
                <TableCell className="font-mono font-medium">{s.code}</TableCell>
                <TableCell>
                  {DOC_TYPE_LABELS[s.docType]} {s.docNumber}
                </TableCell>
                <TableCell>
                  {s.name}
                  {s.needsReview && (
                    <Badge variant="outline" className="ml-2 text-tone-warning-foreground">
                      Por completar
                    </Badge>
                  )}
                </TableCell>
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
                  <RowActions
                    label={s.name}
                    primary="account"
                    actions={[
                      {
                        key: 'account',
                        label: 'Estado de cuenta',
                        show: isAdmin,
                        href: `/proveedores/${s.id}/estado-cuenta`,
                      },
                      {
                        key: 'edit',
                        label: 'Editar',
                        show: isAdmin,
                        onSelect: () => {
                          openDialog(s);
                        },
                      },
                      {
                        key: 'toggle',
                        label: s.isActive ? 'Desactivar' : 'Activar',
                        show: isAdmin,
                        disabled: toggleActive.isPending,
                        pending: toggleActive.isPending && toggleActive.variables?.id === s.id,
                        onSelect: () => {
                          if (toggleActive.isPending) return;
                          if (s.isActive) setToDeactivate(s);
                          else toggleActive.mutate(s);
                        },
                      },
                    ]}
                  />
                </TableCell>
              </TableRow>
            ))}
            <ListStateRows
              query={suppliers}
              colSpan={7}
              isEmpty={shownCount === 0}
              filtered={searching}
              emptyTitle="Todavía no hay proveedores"
              emptyHint={isAdmin ? 'Da de alta el primero con «Nuevo proveedor».' : undefined}
              noResultsTitle={`Ningún proveedor coincide con «${search.trim()}»`}
              onClearFilters={() => {
                setSearch('');
                setUrl({ search: '' });
              }}
              errorTitle="No se pudieron cargar los proveedores"
            />
          </TableBody>
          {shownCount > 0 && (
            <ListFooterRow
              shown={shownCount}
              total={suppliers.data?.length ?? shownCount}
              noun={searching ? 'proveedores que coinciden con la búsqueda' : 'proveedores'}
              colCount={7}
            />
          )}
        </Table>
      </div>

      {toDeactivate && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setToDeactivate(null);
          }}
          title={`Desactivar a ${toDeactivate.name}`}
          consequences="Ya no podrás registrarle compras ni órdenes de corte nuevas; lo registrado se conserva y puedes volver a activarlo."
          pending={toggleActive.isPending}
          onConfirm={() => {
            toggleActive.mutate(toDeactivate);
          }}
        />
      )}

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
