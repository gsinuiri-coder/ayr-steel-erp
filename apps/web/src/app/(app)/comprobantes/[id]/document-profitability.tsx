'use client';

import { useQuery } from '@tanstack/react-query';
import {
  DOCUMENT_PROFIT_COST_BASIS_LABELS,
  DOCUMENT_PROFIT_LINE_STATUS_LABELS,
  PROFIT_SOURCES_NOTICE,
  toDecimal,
  type DocumentProfitFiguresDto,
  type DocumentProfitLineDto,
  type DocumentProfitLineStatus,
  type DocumentProfitabilityDto,
} from '@ayr/shared';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatMoney, formatQty, unitSymbol } from '@/lib/format';

const STATUS_VARIANT: Record<DocumentProfitLineStatus, 'done' | 'warning' | 'outline'> = {
  COMPLETE: 'done',
  PARTIAL: 'warning',
  NO_COST_YET: 'warning',
  UNTRACEABLE: 'outline',
  NO_COST: 'outline',
};

/**
 * C06 — **Rentabilidad** del comprobante (solo ADMINISTRADOR: quien la monta ya lo comprobó, y el
 * API responde 403 a cualquier otro rol). Nunca va en el PDF ni en lo que se envía a SUNAT: es
 * una ruta aparte (`/reports/documents/:id/profitability`).
 *
 * La clave cuelga de `['fiscal-document', id]`, así la invalida todo lo que ya invalida el
 * comprobante (emitir, una nota de crédito, anular).
 */
export function DocumentProfitability({ documentId }: { documentId: string }) {
  const query = useQuery({
    queryKey: ['fiscal-document', documentId, 'profitability'],
    queryFn: () => api<DocumentProfitabilityDto>(`/reports/documents/${documentId}/profitability`),
  });
  const data = query.data;

  return (
    <Section title="Rentabilidad" className="gap-2" bodyClassName="grid gap-2">
      <div data-testid="rentabilidad">
        <p className="px-2.5 text-xs text-muted-foreground" data-testid="aviso-costeo">
          {PROFIT_SOURCES_NOTICE}
        </p>
        {query.isPending && <Skeleton className="mt-2 h-24 w-full" />}
        {query.isError && (
          <p role="alert" className="px-2.5 text-sm text-destructive">
            No se pudo calcular la rentabilidad.
          </p>
        )}
        {data && !data.applies && (
          <p className="px-2.5 text-sm text-muted-foreground">{data.notApplicableReason}</p>
        )}
        {data?.applies && (
          <div className="mt-2 grid gap-3">
            <ProfitTable
              lines={data.lines}
              total={data.total}
              uncostedSalesPen={data.uncostedSalesPen}
              totalLabel="Total con costo"
              testId="rentabilidad-lineas"
            />
            {data.credited && data.net && (
              <>
                <div className="px-2.5 text-xs font-semibold">
                  Acreditado por{' '}
                  {data.credited.notes.map((n) => n.number ?? 'nota de crédito').join(', ')}
                </div>
                <ProfitTable
                  lines={data.credited.lines}
                  total={data.credited.total}
                  uncostedSalesPen={data.credited.uncostedSalesPen}
                  totalLabel="Total acreditado"
                  testId="rentabilidad-acreditado"
                />
                <Table data-testid="rentabilidad-neto">
                  <TableBody>
                    <TableRow className="bg-muted/40 font-semibold">
                      <TableCell colSpan={3}>Neto (comprobante − acreditado)</TableCell>
                      <FigureCells figures={data.net} />
                      <TableCell colSpan={2} />
                    </TableRow>
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function ProfitTable({
  lines,
  total,
  uncostedSalesPen,
  totalLabel,
  testId,
}: {
  lines: DocumentProfitLineDto[];
  total: DocumentProfitFiguresDto;
  uncostedSalesPen: string;
  totalLabel: string;
  testId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId} className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Línea</TableHead>
            <TableHead className="text-right">Cantidad</TableHead>
            <TableHead className="text-right">ML</TableHead>
            <TableHead className="text-right">Kg teórico</TableHead>
            <TableHead className="text-right">Kg real</TableHead>
            <TableHead className="text-right">Venta s/IGV</TableHead>
            <TableHead className="text-right">Costo</TableHead>
            <TableHead className="text-right">Utilidad</TableHead>
            <TableHead className="text-right">Margen</TableHead>
            <TableHead className="text-right">Precio/kg</TableHead>
            <TableHead className="text-right">Costo/kg</TableHead>
            <TableHead className="text-right">Ganancia/kg</TableHead>
            <TableHead className="text-right">Precio/ML</TableHead>
            <TableHead className="text-right">Costo/ML</TableHead>
            <TableHead className="text-right">Ganancia/ML</TableHead>
            <TableHead className="text-right" title="Costo ÷ cantidad">
              Costo prom./unidad
            </TableHead>
            <TableHead>Base de costo</TableHead>
            <TableHead>Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.itemId} data-testid="rentabilidad-fila">
              <TableCell>{line.lineNumber}</TableCell>
              <TableCell>
                <div className="font-medium">{line.sku ?? line.description}</div>
                {line.sku && <div className="text-muted-foreground">{line.description}</div>}
              </TableCell>
              <TableCell className="text-right">
                {toDecimal(line.qty).isZero()
                  ? '—'
                  : formatQty(line.qty, line.unit === null ? undefined : unitSymbol(line.unit))}
              </TableCell>
              <FigureCells figures={line} unit={line.unit} />
              <TableCell>
                {line.costBasis === null ? (
                  '—'
                ) : (
                  <>
                    <div>{DOCUMENT_PROFIT_COST_BASIS_LABELS[line.costBasis]}</div>
                    {line.costBasisDetail && (
                      <div className="text-muted-foreground">{line.costBasisDetail}</div>
                    )}
                  </>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[line.status]}>
                  {DOCUMENT_PROFIT_LINE_STATUS_LABELS[line.status]}
                </Badge>
                {line.note && <div className="mt-0.5 text-muted-foreground">{line.note}</div>}
                {toDecimal(line.uncostedSalesPen).isZero() ? null : (
                  <div className="text-muted-foreground">
                    Sin costo: {formatMoney(line.uncostedSalesPen)}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="font-semibold">
            <TableCell colSpan={3}>{totalLabel}</TableCell>
            <FigureCells figures={total} />
            <TableCell colSpan={2}>
              {toDecimal(uncostedSalesPen).isZero()
                ? null
                : `Venta sin costo: ${formatMoney(uncostedSalesPen)}`}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

/** Un cociente o una cifra que no aplica: «—», nunca 0 ni NaN. */
function money4(value: string | null): string {
  return value === null ? '—' : formatMoney(value, 'PEN', 4);
}

function FigureCells({
  figures,
  unit,
}: {
  figures: DocumentProfitFiguresDto;
  unit?: string | null;
}) {
  const perUnit =
    figures.costPerUnitPen === null
      ? '—'
      : unit
        ? `${money4(figures.costPerUnitPen)} /${unitSymbol(unit)}`
        : money4(figures.costPerUnitPen);
  return (
    <>
      <TableCell className="text-right">
        {figures.metersSold === null ? '—' : formatQty(figures.metersSold, 'm')}
      </TableCell>
      <TableCell className="text-right">
        {figures.theoreticalKg === null ? '—' : formatQty(figures.theoreticalKg, 'kg')}
      </TableCell>
      <TableCell className="text-right">
        {figures.realKg === null ? '—' : formatQty(figures.realKg, 'kg')}
      </TableCell>
      <TableCell className="text-right">{formatMoney(figures.salesPen)}</TableCell>
      <TableCell className="text-right">{formatMoney(figures.costPen)}</TableCell>
      <TableCell className="text-right">{formatMoney(figures.profitPen)}</TableCell>
      <TableCell className="text-right">
        {figures.marginPct === null ? '—' : `${figures.marginPct} %`}
      </TableCell>
      <TableCell className="text-right">{money4(figures.pricePerKgPen)}</TableCell>
      <TableCell className="text-right">{money4(figures.costPerKgPen)}</TableCell>
      <TableCell className="text-right">{money4(figures.marginPerKgPen)}</TableCell>
      <TableCell className="text-right">{money4(figures.pricePerMeterPen)}</TableCell>
      <TableCell className="text-right">{money4(figures.costPerMeterPen)}</TableCell>
      <TableCell className="text-right">{money4(figures.marginPerMeterPen)}</TableCell>
      <TableCell className="text-right">{perUnit}</TableCell>
    </>
  );
}
