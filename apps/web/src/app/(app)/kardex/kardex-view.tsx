'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  INVENTORY_ITEM_TYPE_LABELS,
  INVENTORY_ITEM_TYPES,
  INVENTORY_MOVEMENT_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  Role,
  type InventoryItemType,
  type InventoryMovementDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatMoneyOrDash, formatQty, unitSymbol } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
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

/**
 * Kardex de un producto o de una bobina (RF-53). Con `?item=` viene el saldo corrido
 * después de cada movimiento; sin él es el listado mezclado de los más recientes, donde
 * un saldo corrido no significaría nada y el API lo manda en `null`.
 */
export function KardexView() {
  const params = useSearchParams();
  const itemId = params.get('item') ?? '';
  // La URL la escribe cualquiera: un  inventado solo lograría un 400 y un
  // "no se pudo cargar" sin explicación.
  const rawItemType = params.get('itemType');
  const itemType: InventoryItemType = INVENTORY_ITEM_TYPES.includes(
    rawItemType as InventoryItemType,
  )
    ? (rawItemType as InventoryItemType)
    : 'COIL';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = new URLSearchParams();
  if (itemId) {
    query.set('itemId', itemId);
    query.set('itemType', itemType);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) query.set('from', from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) query.set('to', to);
  const queryString = query.toString();

  const movements = useQuery({
    queryKey: ['inventory', 'movements', queryString],
    queryFn: () =>
      api<InventoryMovementDto[]>(`/inventory/movements${queryString ? `?${queryString}` : ''}`),
  });

  const singleItem = Boolean(itemId);
  // 8 columnas base; con un ítem concreto se suman saldo y costo promedio.
  const columnCount = singleItem ? 9 : 8;
  const header = movements.data?.[0];

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Kardex</h1>
          <p className="text-sm text-muted-foreground">
            {singleItem
              ? `Movimientos de ${header ? `${INVENTORY_ITEM_TYPE_LABELS[header.itemType]} ${header.itemLabel}` : 'el ítem seleccionado'}, con saldo corrido (RF-53).`
              : 'Últimos movimientos de inventario. Elige un ítem desde /inventario o /bobinas para ver su saldo corrido.'}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Desde</span>
            <Input
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Hasta</span>
            <Input
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
              }}
            />
          </label>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              {!singleItem && <TableHead>Ítem</TableHead>}
              <TableHead>Movimiento</TableHead>
              <TableHead>Origen</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Costo unit. (S/)</TableHead>
              <TableHead className="text-right">Total (S/)</TableHead>
              {singleItem && <TableHead className="text-right">Saldo</TableHead>}
              {singleItem && <TableHead className="text-right">Costo prom.</TableHead>}
              <TableHead>Motivo / usuario</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movements.isPending && (
              <TableRow>
                <TableCell colSpan={columnCount}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            )}
            {movements.isError && (
              <TableRow>
                <TableCell colSpan={columnCount} className="text-destructive">
                  No se pudo cargar el kardex.
                </TableCell>
              </TableRow>
            )}
            {movements.data?.map((m) => (
              <TableRow key={m.id} className={m.reversedById ? 'opacity-60' : undefined}>
                <TableCell className="whitespace-nowrap">
                  {new Date(m.at).toLocaleString('es-PE')}
                </TableCell>
                {!singleItem && (
                  <TableCell className="font-mono">
                    <Link
                      className="underline underline-offset-4"
                      href={`/kardex?itemType=${m.itemType}&item=${m.itemId}`}
                    >
                      {m.itemLabel}
                    </Link>
                  </TableCell>
                )}
                <TableCell>
                  <Badge variant={m.type === 'IN' ? 'secondary' : 'outline'}>
                    {INVENTORY_MOVEMENT_TYPE_LABELS[m.type]}
                  </Badge>
                  {m.reversalOfId && (
                    <span className="ml-2 text-xs text-muted-foreground">anulación</span>
                  )}
                </TableCell>
                <TableCell>
                  {INVENTORY_REF_TYPE_LABELS[m.refType]}
                  {!singleItem && ` · ${BUSINESS_LINE_LABELS[m.businessLine]}`}
                </TableCell>
                <TableCell className="text-right">
                  {/* Un ADJUST no mueve cantidad: su `qty` son los kilos sobre los que se
                      repartió el costo, mostrarlo como movimiento confundiría el saldo. */}
                  {m.type === 'ADJUST' ? '—' : formatQty(m.qty, unitSymbol(m.unit))}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoneyOrDash(m.unitCost, 'PEN', 4)}
                </TableCell>
                <TableCell className="text-right">{formatMoneyOrDash(m.totalCost)}</TableCell>
                {singleItem && (
                  <TableCell className="text-right font-medium">
                    {m.balanceQty ? formatQty(m.balanceQty, unitSymbol(m.unit)) : '—'}
                  </TableCell>
                )}
                {singleItem && (
                  <TableCell className="text-right">
                    {formatMoneyOrDash(m.balanceAvgCost, 'PEN', 4)}
                  </TableCell>
                )}
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {m.notes ?? ''}
                  {m.notes && m.actorName ? ' · ' : ''}
                  {m.actorName ?? ''}
                </TableCell>
              </TableRow>
            ))}
            {movements.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={columnCount} className="text-center text-muted-foreground">
                  No hay movimientos para este filtro.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
