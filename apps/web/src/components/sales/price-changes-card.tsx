'use client';

import { money, salePriceFromValue, toFixedString, type SalesPriceChangeDto } from '@ayr/shared';
import { formatMoney } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Fecha y hora del cambio, en Lima. */
function formatChangedAt(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * D-162: el precio se muestra **con IGV**, que es el número que se negoció con el cliente; la
 * fila guarda el valor sin IGV. En una plancha negociada por metro (D-161) se muestra el precio
 * por metro, que es el que se tipeó.
 */
function priceLabel(unitValuePen: string, valuePerMeterPen: string | null): string {
  const value = valuePerMeterPen ?? unitValuePen;
  const price = formatMoney(toFixedString(money(salePriceFromValue(value)), 'MONEY'));
  return valuePerMeterPen === null ? price : `${price} /m`;
}

/**
 * D-187: el registro de cambios de precio de una cotización o de un pedido — quién, cuándo,
 * de cuánto a cuánto. No se pinta si no hubo ninguno.
 */
export function PriceChangesCard({ changes }: { changes: SalesPriceChangeDto[] }) {
  if (changes.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Cambios de precio</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table aria-label="Cambios de precio">
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Usuario</TableHead>
              <TableHead>Línea</TableHead>
              <TableHead className="text-right">Antes (con IGV)</TableHead>
              <TableHead className="text-right">Después (con IGV)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changes.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="tabular-nums">{formatChangedAt(c.changedAt)}</TableCell>
                <TableCell>{c.changedByName ?? '—'}</TableCell>
                <TableCell>
                  L{c.lineNumber} · {c.productSku}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {priceLabel(c.beforeUnitValuePen, c.beforeValuePerMeterPen)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {priceLabel(c.afterUnitValuePen, c.afterValuePerMeterPen)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
