'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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
} from '@ayr/shared';
import { PURCHASE_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
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

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (businessLine) params.set('businessLine', businessLine);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (onlyWithBalance) params.set('onlyWithBalance', 'true');
  if (search) params.set('search', search);
  const queryString = params.toString();

  const purchases = useQuery({
    queryKey: ['purchases', queryString],
    queryFn: () => api<PaginatedResult<PurchaseListItemDto>>(`/purchases?${queryString}`),
  });

  const rows = purchases.data?.items ?? [];

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Compras</h1>
          <p className="text-xs text-muted-foreground">
            Bobinas, producto terminado, servicios y gastos, con su saldo por pagar (D-030).
          </p>
        </div>
        <Button asChild>
          <Link href="/compras/nueva">Nueva compra</Link>
        </Button>
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

        <Button
          variant={onlyWithBalance ? 'default' : 'outline'}
          aria-pressed={onlyWithBalance}
          onClick={() => {
            setUrl({ balance: onlyWithBalance ? '' : '1' });
          }}
        >
          Solo con saldo
        </Button>

        <Input
          aria-label="Buscar compras"
          placeholder="Buscar por comprobante o proveedor…"
          className="max-w-xs"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Proveedor</TableHead>
              <TableHead className="hidden lg:table-cell">Línea</TableHead>
              <TableHead className="hidden md:table-cell">Tipo</TableHead>
              <TableHead className="hidden sm:table-cell">Emisión</TableHead>
              <TableHead className="hidden md:table-cell">Vence</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <TableHead>Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purchases.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {purchases.isError && (
              <TableRow>
                <TableCell colSpan={9} className="text-destructive">
                  No se pudieron cargar las compras.
                </TableCell>
              </TableRow>
            )}
            {rows.map((p) => (
              <TableRow key={p.id}>
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
            {purchases.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No hay compras que coincidan con los filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
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
