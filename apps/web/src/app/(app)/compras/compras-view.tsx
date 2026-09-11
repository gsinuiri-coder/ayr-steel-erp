'use client';

import { useEffect, useState } from 'react';
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
  type BusinessLine,
  type PaginatedResult,
  type PurchaseListItemDto,
  type PurchaseStatus,
  type PurchaseType,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePagination } from '@/lib/use-pagination';
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

const STATUS_VARIANT: Record<PurchaseStatus, 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'outline',
  RECEIVED: 'secondary',
  CANCELLED: 'outline',
};

/** Lista central de compras (D-030), filtrable por línea, tipo, estado y saldo. */
export function ComprasView() {
  const [businessLine, setBusinessLine] = useState<BusinessLine | typeof ALL>(ALL);
  const [type, setType] = useState<PurchaseType | typeof ALL>(ALL);
  const [status, setStatus] = useState<PurchaseStatus | typeof ALL>(ALL);
  const [onlyWithBalance, setOnlyWithBalance] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  useEffect(() => {
    resetPage();
  }, [businessLine, type, status, onlyWithBalance, debouncedSearch, resetPage]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (businessLine !== ALL) params.set('businessLine', businessLine);
  if (type !== ALL) params.set('type', type);
  if (status !== ALL) params.set('status', status);
  if (onlyWithBalance) params.set('onlyWithBalance', 'true');
  if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
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
          value={businessLine}
          onValueChange={(v) => {
            setBusinessLine(v as BusinessLine | typeof ALL);
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
          value={type}
          onValueChange={(v) => {
            setType(v as PurchaseType | typeof ALL);
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

        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v as PurchaseStatus | typeof ALL);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Estado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {PURCHASE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {PURCHASE_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={onlyWithBalance ? 'default' : 'outline'}
          aria-pressed={onlyWithBalance}
          onClick={() => {
            setOnlyWithBalance((v) => !v);
          }}
        >
          Solo con saldo
        </Button>

        <Input
          aria-label="Buscar compras"
          placeholder="Buscar por comprobante o proveedor…"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
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
                  <Badge variant={STATUS_VARIANT[p.status]}>
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
