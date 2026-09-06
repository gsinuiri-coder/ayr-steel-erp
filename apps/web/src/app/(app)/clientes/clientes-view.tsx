'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DOC_TYPE_LABELS,
  ImportEntity,
  Role,
  type CustomerDto,
  type PaginatedResult,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { usePagination } from '@/lib/use-pagination';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
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
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  // Solo al montar (y solo si el rol puede dar de alta): cerrar el diálogo no debe
  // reabrirlo, y navegar a /clientes tampoco.
  useEffect(() => {
    if (autoOpenNew && isAdmin) setDialog((d) => ({ open: true, nonce: d.nonce + 1 }));
  }, [autoOpenNew, isAdmin]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (debouncedSearch) params.set('search', debouncedSearch);

  const customers = useQuery({
    queryKey: [...CUSTOMERS_QUERY_KEY, page, pageSize, debouncedSearch],
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

      {autoOpenNew && !isAdmin && (
        <Alert>
          <AlertDescription>
            Solo un administrador da de alta clientes (RF-85). Pídeselo con el número de documento a
            mano: la búsqueda por RUC completa el resto.
          </AlertDescription>
        </Alert>
      )}

      <Input
        placeholder="Buscar por nombre o número de documento…"
        className="max-w-sm"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          resetPage();
        }}
      />

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Documento</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead className="hidden md:table-cell">Contacto</TableHead>
              <TableHead className="hidden sm:table-cell">Días de crédito</TableHead>
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
            {rows.map((c) => (
              <TableRow key={c.id} data-state={c.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">
                  {DOC_TYPE_LABELS[c.docType]} {c.docNumber}
                </TableCell>
                <TableCell>{c.name}</TableCell>
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
            {customers.isSuccess && rows.length === 0 && (
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
