'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  DISPATCH_STATUS_LABELS,
  DISPATCH_STATUSES,
  Role,
  TRANSFER_MODE_LABELS,
  type DispatchListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatQty } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { RoleGate } from '@/components/role-gate';
import {
  DispatchStatusBadge,
  FiscalDocumentStatusBadge,
} from '@/components/invoicing/status-badges';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL = 'ALL';

/**
 * §3.4 + D-074: despachar es un acto de **almacén**, así que planta entra acá aunque no
 * entre al resto del módulo comercial. El despacho no muestra ningún precio.
 */
const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;

/** RF-77..RF-79: listado de despachos. */
export function DespachosView() {
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);

  const params = new URLSearchParams();
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch) params.set('search', debouncedSearch);
  const query = params.toString();

  const dispatches = useQuery({
    queryKey: ['dispatches', status, debouncedSearch],
    queryFn: () => api<DispatchListItemDto[]>(`/dispatches${query ? `?${query}` : ''}`),
  });

  const rows = dispatches.data ?? [];

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Despachos</h1>
          <p className="text-sm text-muted-foreground">
            El despacho saca la mercadería: mueve el kardex y cierra el pedido. Facturar no lo
            cierra.
          </p>
        </div>
        <Button asChild>
          <Link href="/despachos/nuevo">Nuevo despacho</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por cliente, placa o transportista…"
          className="max-w-sm"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los estados</SelectItem>
            {DISPATCH_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DISPATCH_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {dispatches.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Despacho</TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Traslado</TableHead>
                <TableHead className="text-right">Peso</TableHead>
                <TableHead>Guía</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} className={d.status === 'REVERSED' ? 'opacity-60' : undefined}>
                  <TableCell>
                    <Link
                      href={`/despachos/${d.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {d.code}
                    </Link>
                    <div className="text-xs text-muted-foreground">{d.itemCount} líneas</div>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/pedidos/${d.salesOrderId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {d.salesOrderCode}
                    </Link>
                  </TableCell>
                  <TableCell>{d.customerName}</TableCell>
                  <TableCell>{formatDate(d.dispatchDate)}</TableCell>
                  <TableCell>
                    <div className="text-sm">{TRANSFER_MODE_LABELS[d.transferMode]}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.transferMode === 'PRIVATE' ? d.vehiclePlate : d.carrierName}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{formatQty(d.totalWeightKg, 'kg')}</TableCell>
                  <TableCell>
                    {d.dispatchNoteStatus ? (
                      <div className="space-y-1">
                        <div className="text-xs">{d.dispatchNoteNumber ?? 'Borrador'}</div>
                        <FiscalDocumentStatusBadge status={d.dispatchNoteStatus} />
                      </div>
                    ) : (
                      <Badge variant="outline">Sin guía</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DispatchStatusBadge status={d.status} />
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No hay despachos que coincidan.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </RoleGate>
  );
}
