'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  Role,
  BUSINESS_LINES,
  PURCHASE_STATUS_LABELS,
  PURCHASE_STATUSES,
  PURCHASE_TYPE_LABELS,
  PURCHASE_TYPES,
  type PaginatedResult,
  type PurchaseListItemDto,
  type PurchaseQuery,
} from '@ayr/shared';
import { PURCHASE_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { listXlsxHref } from '@/lib/list-export';
import { HeaderActions } from '@/components/header-actions';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import { PaginationBar } from '@/components/pagination-bar';
import { RoleGate } from '@/components/role-gate';
import { formatDate, formatMoney } from '@/lib/format';
import { FilterChip } from '@/components/filter-chip';
import { ListFooterRow } from '@/components/list-footer';
import { ListStateRows } from '@/components/list-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LINK_CLASSNAME } from '@/lib/utils';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { receiveSequentially, summarizeOutcomes, type ReceiveOutcome } from '@/lib/receive-batch';

const ALL = 'ALL';

/** Lista central de compras (D-030), filtrable por línea, tipo, estado y saldo. */
export function ComprasView() {
  // D-289: filtros, búsqueda y página viven en la URL.
  const [url, setUrl] = useUrlState({
    ...URL_PAGINATION_DEFAULTS,
    line: '',
    type: '',
    status: '',
    balance: '',
    search: '',
  });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const { line: businessLine, type, status } = url;
  const onlyWithBalance = url.balance === '1';

  // D-323: el orden por columna es del servidor (todas estas columnas son de la propia fila).
  const [sort, toggleSort] = useSort<NonNullable<PurchaseQuery['sort']>>();

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (businessLine) params.set('businessLine', businessLine);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (onlyWithBalance) params.set('onlyWithBalance', 'true');
  if (search) params.set('search', search);
  if (sort.key) {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }
  const queryString = params.toString();

  const purchases = useQuery({
    queryKey: ['purchases', queryString],
    queryFn: () => api<PaginatedResult<PurchaseListItemDto>>(`/purchases?${queryString}`),
  });

  const rows = purchases.data?.items ?? [];

  // D-353: «Recibir seleccionadas» — solo borradores; cada una por su propio `receive()`.
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<ReceiveOutcome[] | null>(null);
  const receiveMany = useMutation({
    mutationFn: () =>
      receiveSequentially(
        Object.entries(selected).map(([id, label]) => ({ id, label })),
        (id) => api(`/purchases/${id}/receive`, { method: 'POST', body: {} }),
      ),
    onSuccess: (result) => {
      setOutcomes(result);
      setSelected({});
      void queryClient.invalidateQueries({ queryKey: ['purchases'] });
      void queryClient.invalidateQueries({ queryKey: ['coils'] });
    },
  });
  const selectedCount = Object.keys(selected).length;

  // cc31: el filtro activo acompaña al título y al pie («4 de 38 compras con saldo»).
  const filterParts: string[] = [];
  if (businessLine) {
    filterParts.push(
      `de ${BUSINESS_LINE_LABELS[businessLine as keyof typeof BUSINESS_LINE_LABELS]}`,
    );
  }
  if (type) {
    filterParts.push(
      `de tipo «${PURCHASE_TYPE_LABELS[type as keyof typeof PURCHASE_TYPE_LABELS]}»`,
    );
  }
  if (status === 'CANCELLED') {
    filterParts.push('anuladas');
  } else if (status) {
    filterParts.push(
      `en «${PURCHASE_STATUS_LABELS[status as keyof typeof PURCHASE_STATUS_LABELS]}»`,
    );
  }
  if (onlyWithBalance) filterParts.push('con saldo');
  if (filterParts.length === 0 && search) filterParts.push('que coinciden con la búsqueda');
  const filterLabel = filterParts.join(', ');
  const filtered = Boolean(search || businessLine || type || status) || onlyWithBalance;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-semibold">Compras</h1>
            {filterLabel && <span className="text-muted-foreground">{filterLabel}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Bobinas, producto terminado, servicios y gastos, con su saldo por pagar.
          </p>
        </div>
        {/* cc31: un solo botón principal y lo demás en «Más opciones». cc26 M2: el Excel lleva
            los filtros y el orden de la lista (todas las páginas); los importes solo van en el
            del ADMINISTRADOR (D-438). D-351: la carga en tanda desde planilla. */}
        <HeaderActions
          primary={['new']}
          actions={[
            { key: 'new', label: 'Nueva compra', href: '/compras/nueva' },
            {
              key: 'xlsx',
              label: 'Descargar Excel',
              download: listXlsxHref('/purchases', params),
            },
            { key: 'import', label: 'Importar compras', href: '/compras/importar' },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={businessLine || ALL}
          onValueChange={(v) => {
            setUrl({ line: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-52" aria-label="Línea de negocio">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todas las líneas</SelectItem>
            {BUSINESS_LINES.map((line) => (
              <SelectItem key={line} value={line}>
                {BUSINESS_LINE_LABELS[line]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={type || ALL}
          onValueChange={(v) => {
            setUrl({ type: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-52" aria-label="Tipo de compra">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los tipos</SelectItem>
            {PURCHASE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {PURCHASE_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <StatusFilter
          value={status}
          onChange={(v) => {
            setUrl({ status: v });
          }}
          options={PURCHASE_STATUSES.filter((s) => s !== 'CANCELLED').map((s) => ({
            value: s,
            label: PURCHASE_STATUS_LABELS[s],
          }))}
          negativeValue="CANCELLED"
          className="w-44"
        />

        <FilterChip
          active={onlyWithBalance}
          onToggle={() => {
            setUrl({ balance: onlyWithBalance ? '' : '1' });
          }}
        >
          Solo con saldo
        </FilterChip>

        <Input
          aria-label="Buscar compras"
          placeholder="Buscar por comprobante o proveedor…"
          className="max-w-xs"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
        {selectedCount > 0 && (
          <Button
            disabled={receiveMany.isPending}
            pending={receiveMany.isPending}
            pendingText="Recibiendo…"
            onClick={() => {
              receiveMany.mutate();
            }}
          >
            Recibir seleccionadas ({selectedCount})
          </Button>
        )}
      </div>

      {outcomes && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">{summarizeOutcomes(outcomes)}.</p>
            <ul className="mt-1 grid gap-0.5 text-xs">
              {outcomes.map((o) => (
                <li key={o.id} className={o.ok ? '' : 'text-destructive'}>
                  {o.label}: {o.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">Seleccionar para recibir</span>
              </TableHead>
              <SortableTableHead
                active={sort.key === 'number'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('number');
                }}
              >
                Comprobante
              </SortableTableHead>
              <SortableTableHead
                active={sort.key === 'supplier'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('supplier');
                }}
              >
                Proveedor
              </SortableTableHead>
              <TableHead className="hidden lg:table-cell">Línea</TableHead>
              <SortableTableHead
                className="hidden md:table-cell"
                active={sort.key === 'type'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('type');
                }}
              >
                Tipo
              </SortableTableHead>
              <SortableTableHead
                className="hidden sm:table-cell"
                active={sort.key === 'issueDate'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('issueDate');
                }}
              >
                Emisión
              </SortableTableHead>
              <SortableTableHead
                className="hidden md:table-cell"
                active={sort.key === 'dueDate'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('dueDate');
                }}
              >
                Vence
              </SortableTableHead>
              <SortableTableHead
                className="text-right"
                align="right"
                active={sort.key === 'total'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('total');
                }}
              >
                Total
              </SortableTableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  {p.status === 'DRAFT' && (
                    <Checkbox
                      aria-label={`Seleccionar ${p.documentLabel} para recibir`}
                      checked={selected[p.id] !== undefined}
                      disabled={receiveMany.isPending}
                      onCheckedChange={(checked) => {
                        setSelected((prev) =>
                          checked === true
                            ? { ...prev, [p.id]: p.documentLabel }
                            : Object.fromEntries(
                                Object.entries(prev).filter(([id]) => id !== p.id),
                              ),
                        );
                      }}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/compras/${p.id}`} className={LINK_CLASSNAME}>
                    {p.documentLabel}
                  </Link>
                </TableCell>
                <TableCell>{p.supplierName}</TableCell>
                <TableCell className="hidden lg:table-cell">
                  {BUSINESS_LINE_LABELS[p.businessLine]}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {PURCHASE_TYPE_LABELS[p.type]}
                </TableCell>
                <TableCell className="hidden sm:table-cell">{formatDate(p.issueDate)}</TableCell>
                <TableCell className="hidden md:table-cell">{formatDate(p.dueDate)}</TableCell>
                <TableCell className="text-right">{formatMoney(p.total, p.currency)}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatMoney(p.balance, p.currency)}
                </TableCell>
                <TableCell>
                  <Badge variant={PURCHASE_TONE[p.status]}>
                    {PURCHASE_STATUS_LABELS[p.status]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            <ListStateRows
              query={purchases}
              colSpan={10}
              isEmpty={rows.length === 0}
              filtered={filtered}
              emptyTitle="Todavía no hay compras"
              emptyHint="Registra la primera con «Nueva compra»."
              noResultsTitle={
                search
                  ? `Ninguna compra coincide con «${search}»`
                  : 'Ninguna compra con este filtro'
              }
              onClearFilters={() => {
                setSearchText('');
                setUrl({ search: '', line: '', type: '', status: '', balance: '' });
              }}
              errorTitle="No se pudieron cargar las compras"
            />
          </TableBody>
          {/* La moneda va por fila (PEN o USD): el pie solo cuenta, no suma. */}
          {rows.length > 0 && (
            <ListFooterRow
              shown={rows.length}
              total={purchases.data?.total ?? rows.length}
              noun={filterLabel ? `compras ${filterLabel}` : 'compras'}
              colCount={10}
            />
          )}
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={purchases.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={purchases.isFetching}
      />
    </RoleGate>
  );
}
