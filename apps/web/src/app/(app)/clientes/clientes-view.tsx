'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  DOC_TYPE_LABELS,
  Role,
  type CustomerDto,
  type PaginatedResult,
  type CustomerQuery,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { HeaderActions } from '@/components/header-actions';
import { useSession } from '@/lib/session';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/sortable-table-head';
import { useSort } from '@/lib/use-sort';
import { CustomerDialog } from '@/components/customers/customer-dialog';
import { ListStateRows } from '@/components/list-state';
import { RowActions } from '@/components/row-actions';

/**
 * Prefijo de invalidación: React Query hace *match* parcial, así que
 * `invalidateQueries({ queryKey: CUSTOMERS_QUERY_KEY })` alcanza a la consulta paginada
 * de abajo sin importar en qué página o búsqueda esté el usuario cuando activa o
 * desactiva un cliente.
 */
const CUSTOMERS_QUERY_KEY = ['customers'] as const;

/**
 * RF-80/RF-82/RF-84: clientes.
 *
 * `autoOpenNew` es lo que hace que `/clientes/nuevo` sea una ruta de verdad y no un enlace
 * a ninguna parte: el alta vive en un diálogo (patrón de todos los maestros del proyecto),
 * así que la ruta abre ese mismo diálogo sobre la lista en vez de duplicar el formulario.
 */
export function ClientesView({ autoOpenNew = false }: { autoOpenNew?: boolean }) {
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
  // D-172: `?search=` deja que otra pantalla linkee a "este cliente" sin una ficha propia
  // (T4).
  // D-289: `?search=&page=&pageSize=` es el mismo mecanismo que el resto de las listas.
  const [url, setUrl] = useUrlState({ ...URL_PAGINATION_DEFAULTS, search: '' });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const [searchText, setSearchText, debouncedSearch] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

  // Solo al montar (y solo si el rol puede dar de alta): cerrar el diálogo no debe
  // reabrirlo, y navegar a /clientes tampoco.
  useEffect(() => {
    if (autoOpenNew && isAdmin) setDialog((d) => ({ open: true, nonce: d.nonce + 1 }));
  }, [autoOpenNew, isAdmin]);

  // D-323: el orden por columna es del servidor (todas estas columnas son de la propia fila).
  const [sort, toggleSort] = useSort<NonNullable<CustomerQuery['sort']>>();

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (sort.key) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }

  const customers = useQuery({
    queryKey: [...CUSTOMERS_QUERY_KEY, page, pageSize, debouncedSearch, sort.key, sort.dir],
    queryFn: () => api<PaginatedResult<CustomerDto>>(`/customers?${params.toString()}`),
  });
  const rows = customers.data?.items ?? [];

  const toggleActive = useMutation({
    mutationFn: (c: CustomerDto) =>
      api<CustomerDto>(`/customers/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Cliente activado' : 'Cliente desactivado');
      void queryClient.invalidateQueries({ queryKey: CUSTOMERS_QUERY_KEY });
    },
    onError: (err) => toast.error(errorMessage(err, 'No se pudo actualizar')),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Clientes</h1>
          <p className="text-xs text-muted-foreground">Alta, edición y baja de clientes.</p>
        </div>
        <div className="flex gap-2">
          {/* cc26 M2: el Excel lleva la búsqueda y el orden de la lista (todas las páginas). */}
          <HeaderActions
            primary={['xlsx']}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: listXlsxHref('/customers', params),
              },
            ]}
          />
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

      {autoOpenNew && !isAdmin && (
        <Alert>
          <AlertDescription>
            Solo un administrador da de alta clientes. Pídeselo con el número de documento a mano:
            la búsqueda por RUC completa el resto.
          </AlertDescription>
        </Alert>
      )}

      <Input
        placeholder="Buscar por nombre o número de documento…"
        className="max-w-sm"
        value={searchText}
        onChange={(e) => {
          setSearchText(e.target.value);
        }}
      />

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortableTableHead
                active={sort.key === 'docNumber'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('docNumber');
                }}
              >
                Documento
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'name'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('name');
                }}
              >
                Nombre
              </SortableTableHead>
              <TableHead className="hidden md:table-cell">Contacto</TableHead>
              <SortableTableHead
                className="hidden sm:table-cell"
                active={sort.key === 'creditDays'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('creditDays');
                }}
              >
                Días de crédito
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id} data-state={c.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">
                  {DOC_TYPE_LABELS[c.docType]} {c.docNumber}
                </TableCell>
                <TableCell>
                  {c.name}
                  {c.needsReview && (
                    <Badge variant="outline" className="ml-2 text-tone-warning-foreground">
                      Por completar
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {c.email ?? c.phone ?? '—'}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{c.creditDays}</TableCell>
                <TableCell>
                  {c.isActive ? (
                    <Badge variant="secondary">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    <RowActions
                      label={c.name}
                      primary="edit"
                      actions={[
                        {
                          key: 'edit',
                          label: 'Editar',
                          onSelect: () => {
                            openDialog(c);
                          },
                        },
                        {
                          key: 'toggle',
                          label: c.isActive ? 'Desactivar' : 'Activar',
                          disabled: toggleActive.isPending,
                          pending: toggleActive.isPending && toggleActive.variables?.id === c.id,
                          onSelect: () => {
                            if (toggleActive.isPending) return;
                            toggleActive.mutate(c);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
            <ListStateRows
              query={customers}
              colSpan={6}
              isEmpty={rows.length === 0}
              filtered={Boolean(debouncedSearch)}
              emptyTitle="Todavía no hay clientes"
              emptyHint={isAdmin ? 'Da de alta el primero con «Nuevo cliente».' : undefined}
              noResultsTitle={`Ningún cliente coincide con «${debouncedSearch}»`}
              onClearFilters={() => {
                setSearchText('');
              }}
              errorTitle="No se pudieron cargar los clientes"
            />
          </TableBody>
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={customers.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={customers.isFetching}
      />

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
