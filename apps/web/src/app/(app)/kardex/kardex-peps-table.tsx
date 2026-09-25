'use client';

import { useQuery } from '@tanstack/react-query';
import type { KardexPepsReportDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoneyOrDash, formatQty } from '@/lib/format';
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
 * D-296: el kardex valorizado por **PEPS** (formato 13.1 de SUNAT) en pantalla, junto al costo
 * promedio del kardex. Muestra las mismas filas que el Excel («Descargar PEPS»), que salen del
 * mismo servicio: saldo inicial, cada movimiento con su comprobante, entradas, salidas y saldo,
 * y los totales. No recalcula nada y no cambia la valorización del sistema (D-028): es un
 * reporte, solo del administrador.
 *
 * El rango es el que se eligió en el kardex; «Todo» se lee desde el principio de los tiempos
 * hasta hoy, porque el formato siempre declara un período.
 */
export function KardexPepsTable({
  itemType,
  itemId,
  from,
  to,
}: {
  itemType: 'COIL' | 'PRODUCT';
  itemId: string;
  from: string;
  to: string;
}) {
  const valid = from <= to;
  const report = useQuery({
    queryKey: ['reports', 'kardex-peps', itemType, itemId, from, to],
    queryFn: () =>
      api<KardexPepsReportDto>(
        `/reports/kardex-peps?itemType=${itemType}&itemId=${encodeURIComponent(itemId)}&from=${from}&to=${to}`,
      ),
    enabled: valid,
  });

  if (!valid) {
    return (
      <p className="text-sm text-destructive">
        El rango termina antes de empezar: corrige «Desde» y «Hasta».
      </p>
    );
  }
  if (report.isPending) return <Skeleton className="h-40 w-full" />;
  if (report.isError || !report.data) {
    return <p className="text-sm text-destructive">No se pudo cargar el kardex PEPS.</p>;
  }
  const r = report.data;
  const money = (v: string | null) => formatMoneyOrDash(v, 'PEN', 4);
  const qty = (v: string | null) => (v === null ? '—' : formatQty(v));

  return (
    <div className="grid gap-2" data-testid="kardex-peps">
      <p className="text-xs text-muted-foreground">
        Kardex valorizado por PEPS (formato 13.1 de SUNAT) de {r.itemCode} · {r.itemDescription},
        del {formatDate(r.from)} al {formatDate(r.to)}. Es un reporte: la valorización del sistema
        sigue en costo promedio.
      </p>
      {r.warnings.length > 0 && (
        <p className="text-xs text-destructive">
          {r.warnings.length} advertencia(s) del cálculo PEPS: ver la columna Observación.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead rowSpan={2}>Fecha</TableHead>
              <TableHead rowSpan={2}>Documento</TableHead>
              <TableHead rowSpan={2}>Operación</TableHead>
              <TableHead colSpan={3} className="text-center">
                Entradas
              </TableHead>
              <TableHead colSpan={3} className="text-center">
                Salidas
              </TableHead>
              <TableHead colSpan={3} className="text-center">
                Saldo final
              </TableHead>
              <TableHead rowSpan={2}>Observación</TableHead>
            </TableRow>
            <TableRow>
              {[
                'Cant.',
                'C. unit.',
                'Total',
                'Cant.',
                'C. unit.',
                'Total',
                'Cant.',
                'C. unit.',
                'Total',
              ].map((label, i) => (
                <TableHead key={i} className="text-right">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="bg-muted/30">
              <TableCell colSpan={9} className="font-medium">
                Saldo inicial
              </TableCell>
              <TableCell className="text-right">{qty(r.opening.qty)}</TableCell>
              <TableCell className="text-right">{money(r.opening.unitCost)}</TableCell>
              <TableCell className="text-right">{money(r.opening.total)}</TableCell>
              <TableCell />
            </TableRow>
            {r.rows.map((row) => (
              <TableRow key={row.movementId}>
                <TableCell className="whitespace-nowrap">{formatDate(row.operationDate)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {row.docTypeCode}
                  {row.series || row.number ? ` ${row.series}-${row.number}` : ''}
                </TableCell>
                <TableCell>
                  {row.operationCode} · {row.operationLabel}
                </TableCell>
                <TableCell className="text-right">{qty(row.inQty)}</TableCell>
                <TableCell className="text-right">{money(row.inUnitCost)}</TableCell>
                <TableCell className="text-right">{money(row.inTotal)}</TableCell>
                <TableCell className="text-right">{qty(row.outQty)}</TableCell>
                <TableCell className="text-right">{money(row.outUnitCost)}</TableCell>
                <TableCell className="text-right">{money(row.outTotal)}</TableCell>
                <TableCell className="text-right font-medium">{qty(row.balanceQty)}</TableCell>
                <TableCell className="text-right">{money(row.balanceUnitCost)}</TableCell>
                <TableCell className="text-right">{money(row.balanceTotal)}</TableCell>
                <TableCell
                  className="max-w-xs truncate text-muted-foreground"
                  title={row.observation ?? undefined}
                >
                  {row.observation ?? ''}
                </TableCell>
              </TableRow>
            ))}
            {r.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={13} className="text-center text-muted-foreground">
                  No hay movimientos en este rango.
                </TableCell>
              </TableRow>
            )}
            <TableRow className="bg-muted/30 font-medium">
              <TableCell colSpan={3}>Totales</TableCell>
              <TableCell className="text-right">{qty(r.totals.inQty)}</TableCell>
              <TableCell />
              <TableCell className="text-right">{money(r.totals.inTotal)}</TableCell>
              <TableCell className="text-right">{qty(r.totals.outQty)}</TableCell>
              <TableCell />
              <TableCell className="text-right">{money(r.totals.outTotal)}</TableCell>
              <TableCell className="text-right">{qty(r.closing.qty)}</TableCell>
              <TableCell className="text-right">{money(r.closing.unitCost)}</TableCell>
              <TableCell className="text-right">{money(r.closing.total)}</TableCell>
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
