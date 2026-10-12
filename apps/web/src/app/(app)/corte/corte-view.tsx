'use client';

import { SelectFilterField } from '@/components/select-filter-field';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  CUTTING_ORDER_STATUS_LABELS,
  CUTTING_ORDER_STATUSES,
  Role,
  type BusinessLine,
  type CuttingOrderListItemDto,
  type CuttingOrderStatus,
} from '@ayr/shared';
import { CUTTING_ORDER_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { formatTimestampDate } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { FiltersDialog, TableToolbar } from '@/components/table-toolbar';
import { useSort } from '@/lib/use-sort';

const ALL = 'ALL';

/** Órdenes de corte tercerizado (RF-40..42, RF-22), filtrables por línea y estado. */
export function CorteView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<'supplier' | 'line' | 'coils' | 'sent' | 'status'>();
  // cc31: los filtros viven en la URL (D-289); «Todas» y «Todos» no se escriben.
  const [url, setUrl] = useUrlState({ line: ALL, status: ALL });
  // Un valor de la URL que no existe se ignora (iría al API y daría 400).
  const businessLine = (BUSINESS_LINES as readonly string[]).includes(url.line)
    ? (url.line as BusinessLine)
    : ALL;
  const status = (CUTTING_ORDER_STATUSES as readonly string[]).includes(url.status)
    ? (url.status as CuttingOrderStatus)
    : ALL;

  const params = new URLSearchParams();
  if (businessLine !== ALL) params.set('businessLine', businessLine);
  if (status !== ALL) params.set('status', status);
  const queryString = params.toString();

  const orders = useQuery({
    queryKey: ['cutting-orders', queryString],
    queryFn: () =>
      api<CuttingOrderListItemDto[]>(`/cutting${queryString ? `?${queryString}` : ''}`),
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Corte tercerizado</h1>
          <p className="text-xs text-muted-foreground">
            Bobinas enviadas a un tercero para partir en flejes. El envío no mueve kardex: la bobina
            sigue siendo propia hasta que se recibe.
          </p>
        </div>
        <Button asChild>
          <Link href="/corte/nueva">Enviar bobinas a corte</Link>
        </Button>
      </div>

      {/* cc47 (D-615): «Filtros» (línea y estado). La lista no tiene buscar ni Excel. */}
      <TableToolbar
        filters={
          <FiltersDialog<{ line: string; status: string }>
            value={{ line: businessLine, status }}
            empty={{ line: ALL, status: ALL }}
            activeCount={(businessLine === ALL ? 0 : 1) + (status === ALL ? 0 : 1)}
            onApply={(next) => {
              setUrl(next);
            }}
          >
            {(draft, update) => (
              <>
                <SelectFilterField
                  id="filtro-linea"
                  label="Línea de negocio"
                  value={draft.line}
                  onChange={(v) => {
                    update({ line: v });
                  }}
                  allLabel="Todas las líneas"
                  allValue={ALL}
                  options={BUSINESS_LINES.map((line) => ({
                    value: line,
                    label: BUSINESS_LINE_LABELS[line],
                  }))}
                />
                <SelectFilterField
                  id="filtro-estado"
                  label="Estado"
                  value={draft.status}
                  onChange={(v) => {
                    update({ status: v });
                  }}
                  allLabel="Todos los estados"
                  allValue={ALL}
                  options={CUTTING_ORDER_STATUSES.map((st) => ({
                    value: st,
                    label: CUTTING_ORDER_STATUS_LABELS[st],
                  }))}
                />
              </>
            )}
          </FiltersDialog>
        }
      />

      <div className="rounded-lg border">
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="supplier">
                Proveedor
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="line">
                Línea
              </SortHead>
              <SortHead
                sort={sort}
                onSort={toggleSort}
                k="coils"
                className="text-right"
                align="right"
              >
                Bobinas
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="sent">
                Enviada
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
              <TableHead>Notas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {orders.isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-destructive">
                  No se pudieron cargar las órdenes de corte.
                </TableCell>
              </TableRow>
            )}
            {sortRows(orders.data ?? [], sort, {
              supplier: { text: (o) => o.supplierName },
              line: { text: (o) => o.businessLine },
              coils: { decimal: (o) => String(o.coilCount) },
              sent: { text: (o) => o.sentAt ?? '' },
              status: { text: (o) => o.status },
            }).map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-medium">
                  <Link href={`/corte/${o.id}`} className={LINK_CLASSNAME}>
                    {o.supplierName}
                  </Link>
                </TableCell>
                <TableCell>{BUSINESS_LINE_LABELS[o.businessLine]}</TableCell>
                <TableCell className="text-right">{o.coilCount}</TableCell>
                <TableCell>{formatTimestampDate(o.sentAt)}</TableCell>
                <TableCell>
                  <Badge variant={CUTTING_ORDER_TONE[o.status]}>
                    {CUTTING_ORDER_STATUS_LABELS[o.status]}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {o.notes ?? ''}
                </TableCell>
              </TableRow>
            ))}
            {orders.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No hay órdenes de corte que coincidan con los filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
