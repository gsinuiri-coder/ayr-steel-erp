'use client';

import { useQuery } from '@tanstack/react-query';
import {
  PROFIT_SOURCES_NOTICE,
  BUSINESS_LINE_LABELS,
  FISCAL_DOC_TYPE_LABELS,
  NO_COST_REPORT_LINES,
  Role,
  SALES_MARGIN_LINES,
  businessToday,
  toDecimal,
  type MarginCostStatus,
  type SalesMarginDto,
  type SalesMarginOrderDto,
} from '@ayr/shared';
import { Stat, StatStrip } from '@/components/stat-strip';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { useUrlState } from '@/lib/use-url-state';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
 * Ventas y margen por rango (RF-S4a/M2). **Solo administrador**.
 *
 * La pantalla insiste en una distinción que un reporte de margen normalmente esconde: qué
 * tan comparable es el costo con la venta del rango. Una fila `PARCIAL` tiene costo de
 * verdad pero incompleto —el margen es un techo—, y una `NO_COMPARABLE` se muestra sin
 * costo y **fuera de los totales**, porque su venta del rango es una porción de un pedido
 * cuyo costo cubre más que eso. Prorratear daría un número inventado.
 */
export function VentasMargenView() {
  // cc23 (D-395): el rango va en la URL, como los filtros de D-289, para que refrescar y
  // retroceder vuelvan al mismo estado; la pestaña de línea, con `useLineTab`.
  const [url, setUrl] = useUrlState({ from: firstOfMonth(), to: businessToday() });
  const { from, to } = url;
  const { tab, line, select } = useLineTab(LINE_TABS);
  // D-392: Servicios no tiene costo registrado; su pestaña muestra solo la venta.
  const noCost = line !== undefined && NO_COST_REPORT_LINES.includes(line);
  const validRange = DATE.test(from) && DATE.test(to) && from <= to;
  const qs = `from=${from}&to=${to}${line === undefined ? '' : `&businessLine=${line}`}`;

  const report = useQuery({
    queryKey: ['report', 'sales-margin', from, to, line ?? 'todas'],
    queryFn: () => api<SalesMarginDto>(`/reports/sales-margin?${qs}`),
    enabled: validRange,
  });

  const cols: Columns = { cost: !noCost, opMaterial: line === undefined };
  // D-412: en Servicios, la venta suma aunque el pedido tenga un costo no comparable o no
  // rastreable por otra línea (`inTotals`); esas secciones son solo de lo que quedó fuera.
  const excluded =
    report.data?.orders.filter((o) => !o.inTotals && o.costStatus === 'NO_COMPARABLE') ?? [];
  // D-285: despachados sin salida de kardex; su costo no se puede rastrear.
  const untraceable =
    report.data?.orders.filter((o) => !o.inTotals && o.costStatus === 'NO_RASTREABLE') ?? [];
  const included = report.data?.orders.filter((o) => o.inTotals) ?? [];

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Ventas y margen</h1>
          <p className="text-xs text-muted-foreground">
            Comprobantes emitidos en el rango, sin IGV. Costo de venta desde el kardex.
          </p>
          {/* C06: el aviso de los dos reportes, en palabras del dueño. */}
          <p className="text-xs text-muted-foreground" data-testid="aviso-costeo">
            {PROFIT_SOURCES_NOTICE}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="margen-desde">Desde</Label>
            <Input
              id="margen-desde"
              type="date"
              max={to}
              value={from}
              onChange={(e) => {
                if (e.target.value) setUrl({ from: e.target.value });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="margen-hasta">Hasta</Label>
            <Input
              id="margen-hasta"
              type="date"
              min={from}
              value={to}
              onChange={(e) => {
                if (e.target.value) setUrl({ to: e.target.value });
              }}
            />
          </div>
          {/* Descarga directa contra el API (patrón D-149), con el mismo rango que se ve.
              D-396: sin exportación por línea; el Excel es el de «Todas» y solo se ofrece ahí. */}
          {line === undefined && (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/sales-margin/xlsx?from=${from}&to=${to}`,
                },
              ]}
            />
          )}
        </div>
      </div>

      <LineTabs
        lines={LINE_TABS.lines}
        includeAll={LINE_TABS.includeAll}
        value={tab}
        onChange={select}
      />

      {!validRange && (
        <p role="alert" className="text-sm text-destructive">
          El rango de fechas no es válido.
        </p>
      )}

      {report.data && noCost && (
        <StatStrip className="sm:grid-cols-2 lg:grid-cols-2">
          <Stat label="Venta sin IGV">{formatMoney(report.data.totals.salesPen)}</Stat>
          <Stat label="Costo y margen">{NO_COST_LABEL}</Stat>
        </StatStrip>
      )}
      {report.data && !noCost && (
        <StatStrip
          className={
            line === undefined ? 'sm:grid-cols-2 lg:grid-cols-5' : 'sm:grid-cols-2 lg:grid-cols-4'
          }
        >
          <Stat label="Venta sin IGV">{formatMoney(report.data.totals.salesPen)}</Stat>
          {/* D-409/D-419: en «Todas», la venta sin costo registrado (Servicios y líneas sin producto)
              suma a la venta y queda fuera del margen. */}
          {line === undefined && (
            <Stat label="Sin costo registrado (Servicios y líneas sin producto)">
              {formatMoney(report.data.totals.noCostSalesPen)}
            </Stat>
          )}
          <Stat label="Costo de venta">{formatMoney(report.data.totals.costPen)}</Stat>
          <Stat
            label={line === undefined ? 'Margen (sin Servicios ni líneas sin producto)' : 'Margen'}
          >
            {formatMoney(report.data.totals.marginPen)}
          </Stat>
          <Stat
            label={
              line === undefined ? 'Margen % (sin Servicios ni líneas sin producto)' : 'Margen %'
            }
          >
            {report.data.totals.marginPct === null ? '—' : `${report.data.totals.marginPct} %`}
          </Stat>
        </StatStrip>
      )}

      {report.data && !noCost && report.data.totals.partialOrderCount > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {report.data.totals.partialOrderCount === 1
            ? '1 pedido tiene costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.'
            : `${report.data.totals.partialOrderCount} pedidos tienen costo parcial: hay líneas facturadas que todavía no salieron del almacén, así que el margen de arriba es un techo.`}
        </p>
      )}

      {report.isPending && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {report.data && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">Por pedido</h2>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>Pedido</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="hidden lg:table-cell">Vendedor</TableHead>
                    <TableHead className="text-right">Venta</TableHead>
                    {cols.cost && (
                      <>
                        <TableHead className="text-right">Costo</TableHead>
                        <TableHead className="text-right">Margen</TableHead>
                        <TableHead className="text-right">%</TableHead>
                      </>
                    )}
                    {cols.opMaterial && (
                      <TableHead className="hidden text-right xl:table-cell">
                        Material de OPs
                      </TableHead>
                    )}
                    {cols.cost && <TableHead>Costo</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {included.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={columnCount(cols)} className="text-muted-foreground">
                        {line === undefined
                          ? 'No hay comprobantes emitidos en ese rango.'
                          : 'No hay ventas de esta línea en ese rango.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {included.map((order) => (
                    <OrderRow
                      key={order.salesOrderId ?? order.documents[0]?.id}
                      order={order}
                      cols={cols}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {excluded.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Facturación parcial en el rango</h2>
              <p className="text-xs text-muted-foreground">
                Estos pedidos tienen comprobantes dentro y fuera del rango, y los del rango no
                declaran su despacho. Su costo cubre más venta que la que se ve aquí, así que se
                muestra la venta y se deja el costo vacío: quedan fuera de los totales de arriba
                (venta excluida: {formatMoney(report.data.totals.excludedSalesPen)}).
                {line === undefined && SERVICES_STILL_COUNT}
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pedido</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Venta en el rango</TableHead>
                      {cols.opMaterial && (
                        <TableHead className="hidden text-right xl:table-cell">
                          Material de OPs
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {excluded.map((order) => (
                      <TableRow key={order.salesOrderId ?? order.documents[0]?.id}>
                        <TableCell className="font-mono">{order.orderCode ?? '—'}</TableCell>
                        <TableCell>{order.customerName}</TableCell>
                        <TableCell className="text-right">{formatMoney(order.salesPen)}</TableCell>
                        {cols.opMaterial && (
                          <TableCell className="hidden text-right xl:table-cell">
                            {formatMoney(order.opMaterialCostPen)}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {untraceable.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Costo no rastreable</h2>
              <p className="text-xs text-muted-foreground">
                Estos pedidos se despacharon sin su salida de inventario, así que no se sabe su
                costo. Quedan fuera de los totales de arriba (venta excluida:{' '}
                {formatMoney(report.data.totals.untraceableSalesPen)}).
                {line === undefined && SERVICES_STILL_COUNT}
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pedido</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Venta en el rango</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {untraceable.map((order) => (
                      <TableRow key={order.salesOrderId ?? order.documents[0]?.id}>
                        <TableCell className="font-mono">{order.orderCode ?? '—'}</TableCell>
                        <TableCell>{order.customerName}</TableCell>
                        <TableCell className="text-right">{formatMoney(order.salesPen)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          {/* En la pestaña de una línea, la tabla repetiría la franja de arriba: solo en «Todas». */}
          {line === undefined && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Totales por línea de negocio</h2>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Línea</TableHead>
                      <TableHead className="text-right">Venta</TableHead>
                      <TableHead className="text-right">Costo</TableHead>
                      <TableHead className="text-right">Margen</TableHead>
                      <TableHead className="text-right">%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.totalsByLine.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground">
                          Sin ventas en el rango.
                        </TableCell>
                      </TableRow>
                    )}
                    {report.data.totalsByLine.map((t) => (
                      <TableRow key={t.businessLine ?? 'sin-linea'}>
                        <TableCell>
                          {t.businessLine === null
                            ? 'Sin línea (servicios y ajustes)'
                            : BUSINESS_LINE_LABELS[t.businessLine]}
                        </TableCell>
                        <TableCell className="text-right">{formatMoney(t.salesPen)}</TableCell>
                        {t.businessLine === null ||
                        NO_COST_REPORT_LINES.includes(t.businessLine) ? (
                          // D-392/D-419: Servicios y «Sin línea» suman igual; su costo no está registrado.
                          <TableCell colSpan={3} className="text-right text-muted-foreground">
                            {NO_COST_LABEL}
                          </TableCell>
                        ) : (
                          <>
                            <TableCell className="text-right">{formatMoney(t.costPen)}</TableCell>
                            <TableCell className="text-right">{formatMoney(t.marginPen)}</TableCell>
                            <TableCell className="text-right">
                              {t.marginPct === null ? '—' : `${t.marginPct} %`}
                            </TableCell>
                          </>
                        )}
                      </TableRow>
                    ))}
                    {/* cc28 (D-461): lo que separa sumar comprobantes de sumar sus líneas. */}
                    {!toDecimal(report.data.totals.roundingPen).isZero() && (
                      <TableRow>
                        <TableCell>Redondeo al céntimo de los comprobantes</TableCell>
                        <TableCell className="text-right">
                          {formatMoney(report.data.totals.roundingPen, 'PEN', 4)}
                        </TableCell>
                        <TableCell colSpan={3} className="text-right text-muted-foreground">
                          Comprobantes con líneas de más de dos decimales (precio con IGV)
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}
        </>
      )}
    </RoleGate>
  );
}

/** Qué columnas lleva la tabla: sin costo en Servicios (D-392), sin material de OPs por línea. */
interface Columns {
  cost: boolean;
  opMaterial: boolean;
}

/** Pedido, cliente, vendedor y venta, más las columnas que la pestaña lleve. */
function columnCount(cols: Columns): number {
  return 4 + (cols.cost ? 4 : 0) + (cols.opMaterial ? 1 : 0);
}

/** Una fila de pedido con sus comprobantes debajo. */
function OrderRow({ order, cols }: { order: SalesMarginOrderDto; cols: Columns }) {
  return (
    <>
      <TableRow data-testid="fila-pedido">
        <TableCell className="font-mono">{order.orderCode ?? '—'}</TableCell>
        <TableCell>{order.customerName}</TableCell>
        <TableCell className="hidden lg:table-cell">{order.sellerName ?? '—'}</TableCell>
        <TableCell className="text-right">{formatMoney(order.salesPen)}</TableCell>
        {cols.cost && (
          <>
            <TableCell className="text-right">
              {order.costPen === null ? '—' : formatMoney(order.costPen)}
            </TableCell>
            <TableCell className="text-right">
              {order.marginPen === null ? '—' : formatMoney(order.marginPen)}
            </TableCell>
            <TableCell className="text-right">
              {order.marginPct === null ? '—' : `${order.marginPct} %`}
            </TableCell>
          </>
        )}
        {cols.opMaterial && (
          <TableCell className="hidden text-right xl:table-cell text-muted-foreground">
            {formatMoney(order.opMaterialCostPen)}
          </TableCell>
        )}
        {cols.cost && (
          <TableCell>
            <CostStatusBadge status={order.costStatus} />
          </TableCell>
        )}
      </TableRow>
      {order.documents.map((d) => (
        <TableRow key={d.id} className="bg-muted/40 text-xs">
          <TableCell className="pl-8 font-mono">{d.number ?? '—'}</TableCell>
          <TableCell>{FISCAL_DOC_TYPE_LABELS[d.docType]}</TableCell>
          <TableCell className="hidden lg:table-cell">{formatDate(d.issueDate)}</TableCell>
          <TableCell className="text-right">{formatMoney(d.salesPen)}</TableCell>
          {cols.cost && (
            <>
              <TableCell className="text-right">
                {d.costPen === null ? (
                  <span title="El despacho de este comprobante no está declarado">—</span>
                ) : (
                  formatMoney(d.costPen)
                )}
              </TableCell>
              <TableCell className="text-right">
                {d.marginPen === null ? '—' : formatMoney(d.marginPen)}
              </TableCell>
              <TableCell className="text-right">
                {d.marginPct === null ? '—' : `${d.marginPct} %`}
              </TableCell>
            </>
          )}
          {cols.opMaterial && <TableCell className="hidden xl:table-cell" />}
          {cols.cost && <TableCell />}
        </TableRow>
      ))}
    </>
  );
}

const COST_STATUS_LABELS: Record<MarginCostStatus, string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
  NO_RASTREABLE: 'Costo no rastreable',
};

function CostStatusBadge({ status }: { status: MarginCostStatus }) {
  if (status === 'COMPLETO') {
    return <Badge variant="secondary">{COST_STATUS_LABELS[status]}</Badge>;
  }
  return <Badge variant="destructive">{COST_STATUS_LABELS[status]}</Badge>;
}

/** cc23 (D-391, D-393): todas las líneas, con «Todas» primera y por defecto; el rango sobrevive. */
const LINE_TABS: LineTabsConfig = {
  lines: SALES_MARGIN_LINES,
  includeAll: true,
  keep: ['from', 'to'],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** D-392: lo que se declara en lugar del costo y el margen de Servicios. */
const NO_COST_LABEL = 'Sin costo registrado';

/** D-412: por qué la venta de la fila puede ser mayor que la venta excluida. */
const SERVICES_STILL_COUNT =
  ' Si alguno de estos pedidos tiene venta de Servicios, esa venta no depende del costo y sí suma arriba.';

/** Primer día del mes de negocio en curso, que es el rango por defecto más útil. */
function firstOfMonth(): string {
  return `${businessToday().slice(0, 7)}-01`;
}
