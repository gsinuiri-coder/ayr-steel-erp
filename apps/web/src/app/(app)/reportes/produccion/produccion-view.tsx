'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  COIL_REPORT_LINES,
  Role,
  businessToday,
  type ProductionSummaryDto,
  type ProductionSummaryGroupDto,
  type ProductionSummaryLine,
  type ProductionSummaryOrderDto,
} from '@ayr/shared';
import { HeaderActions } from '@/components/header-actions';
import { LineTabs } from '@/components/line-tabs';
import { RoleGate } from '@/components/role-gate';
import { Stat, StatStrip } from '@/components/stat-strip';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { formatMoneyOrDash, formatQty } from '@/lib/format';
import { useLineTab, type LineTabsConfig } from '@/lib/line-tabs';
import { useUrlState } from '@/lib/use-url-state';
import { LINK_CLASSNAME } from '@/lib/utils';

/**
 * cc29 (M2, D-420, D-464, D-468). Reporte de producción: una fila por OP (un producto y una línea
 * del pedido), con lo que cada bobina dio según el kardex y un subtotal por pedido. Administrador y
 * supervisor de planta; los costos los trae el API solo para el administrador. Solo lectura.
 */
export function ProduccionView() {
  const { tab, select } = useLineTab(LINE_TABS);
  const line = tab as ProductionSummaryLine;
  const [url, setUrl] = useUrlState({ from: firstOfMonth(), to: businessToday() });
  const { from, to } = url;
  const validRange = DATE.test(from) && DATE.test(to) && from <= to;

  const report = useQuery({
    queryKey: ['report', 'production-summary', from, to, line],
    queryFn: () =>
      api<ProductionSummaryDto>(
        `/reports/production-summary?from=${from}&to=${to}&businessLine=${line}`,
      ),
    enabled: validRange,
  });
  const data = report.data;
  const withCosts = data?.withCosts === true;
  // En Drywall, lo que sale al cerrar la OP es la merma de proceso (D-057), no un despunte.
  const trimLabel = line === BusinessLine.DRYWALL ? 'Merma de proceso' : 'Despunte';
  const columns = withCosts ? 12 : 10;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Reporte de producción</h1>
          <p className="text-xs text-muted-foreground">
            {BUSINESS_LINE_LABELS[line]}. Una fila por orden de producción, agrupadas por pedido,
            con los movimientos de kardex del rango por la fecha del reporte de planta. El{' '}
            {trimLabel.toLowerCase()} es de la orden; por bobina va como lo registró el kardex,
            repartido en orden de montaje. El ajuste de cierre de una bobina no es de ninguna orden:
            está en «Merma por bobina».
          </p>
          <p className="text-xs text-muted-foreground" data-testid="aviso-estandar">
            El teórico ya incluye el 1 % de merma estándar; el porcentaje es lo que lo pasa. Hasta
            el {data?.standardPct ?? '1.00'} % es normal; más que eso se marca en rojo.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="produccion-desde">Desde</Label>
            <Input
              id="produccion-desde"
              type="date"
              max={to}
              value={from}
              onChange={(e) => {
                if (e.target.value) setUrl({ from: e.target.value });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="produccion-hasta">Hasta</Label>
            <Input
              id="produccion-hasta"
              type="date"
              min={from}
              value={to}
              onChange={(e) => {
                if (e.target.value) setUrl({ to: e.target.value });
              }}
            />
          </div>
          {validRange && (
            <HeaderActions
              primary={['xlsx']}
              actions={[
                {
                  key: 'xlsx',
                  label: 'Descargar Excel',
                  download: `/api/reports/production-summary/xlsx?from=${from}&to=${to}&businessLine=${line}`,
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

      {data && (
        <StatStrip className="sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Órdenes">{data.totals.orderCount}</Stat>
          <Stat label="Kg teórico">{formatQty(data.totals.theoreticalKg, 'kg')}</Stat>
          <Stat label="Kg salido">{formatQty(data.totals.consumedKg, 'kg')}</Stat>
          <Stat label={trimLabel}>{formatQty(data.totals.trimKg, 'kg')}</Stat>
          <Stat label="% sobre el estándar">
            <Pct value={data.totals.wastePct} over={data.totals.overStandard} />
          </Stat>
        </StatStrip>
      )}

      {data && data.totals.unattributedKg !== '0.000' && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="aviso-sin-reporte">
          {formatQty(data.totals.unattributedKg, 'kg')} salieron como producción en el rango sin
          apuntar a un reporte de planta: no son de ninguna orden y no están en las filas.
        </p>
      )}

      {report.isPending && validRange && <Skeleton className="h-64 w-full" />}
      {report.isError && (
        <p role="alert" className="text-sm text-destructive">
          No se pudo cargar el reporte.
        </p>
      )}

      {data && (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>OP</TableHead>
                <TableHead>Pedido y línea</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Metros o piezas</TableHead>
                <TableHead className="text-right">Kg teórico</TableHead>
                <TableHead className="text-right">Kg salido</TableHead>
                <TableHead className="text-right">{trimLabel}</TableHead>
                <TableHead className="text-right">% s/ estándar</TableHead>
                {withCosts && <TableHead className="text-right">Costo salido</TableHead>}
                {withCosts && (
                  <TableHead className="text-right">Costo {trimLabel.toLowerCase()}</TableHead>
                )}
                <TableHead colSpan={2}>Bobinas (kg salido · {trimLabel.toLowerCase()})</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.groups.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns} className="text-muted-foreground">
                    No hay producción de esta línea en ese rango.
                  </TableCell>
                </TableRow>
              )}
              {data.groups.map((g) => (
                <GroupRows
                  key={g.salesOrderId ?? 'sin-pedido'}
                  group={g}
                  withCosts={withCosts}
                  trimLabel={trimLabel}
                />
              ))}
            </TableBody>
            {data.groups.length > 0 && (
              <TableFooter>
                <TableRow data-testid="produccion-total">
                  <TableCell colSpan={4}>
                    Total de {BUSINESS_LINE_LABELS[line]} ({data.totals.orderCount} órdenes)
                  </TableCell>
                  <FigureCells f={data.totals} withCosts={withCosts} />
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
    </RoleGate>
  );
}

function GroupRows({
  group,
  withCosts,
  trimLabel,
}: {
  group: ProductionSummaryGroupDto;
  withCosts: boolean;
  trimLabel: string;
}) {
  return (
    <>
      {group.orders.map((o) => (
        <OrderRow key={o.productionOrderId} order={o} withCosts={withCosts} trimLabel={trimLabel} />
      ))}
      <TableRow
        className="bg-muted/40 font-medium hover:bg-muted/40"
        data-testid="produccion-subtotal"
      >
        <TableCell colSpan={4}>
          Subtotal{' '}
          {group.salesOrderId !== null && group.salesOrderCode !== null ? (
            <Link className={`${LINK_CLASSNAME} font-mono`} href={`/pedidos/${group.salesOrderId}`}>
              {group.salesOrderCode}
            </Link>
          ) : (
            'sin pedido (a stock)'
          )}
        </TableCell>
        <FigureCells f={group.subtotal} withCosts={withCosts} />
        <TableCell colSpan={2} />
      </TableRow>
    </>
  );
}

function OrderRow({
  order: o,
  withCosts,
  trimLabel,
}: {
  order: ProductionSummaryOrderDto;
  withCosts: boolean;
  trimLabel: string;
}) {
  return (
    <TableRow data-testid="produccion-op">
      <TableCell>
        <Link className={`${LINK_CLASSNAME} font-mono`} href={`/produccion/${o.productionOrderId}`}>
          {o.code}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {o.salesOrderCode === null ? 'A stock' : `${o.salesOrderCode} · L${String(o.lineNumber)}`}
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs">{o.productSku}</span>
        <span className="block text-xs text-muted-foreground">{o.productName}</span>
      </TableCell>
      <TableCell className="text-right">
        {o.quantityUnit === 'm' ? formatQty(o.quantity, 'm') : `${o.quantity} pzs`}
      </TableCell>
      <FigureCells f={o} withCosts={withCosts} />
      <TableCell colSpan={2} className="text-xs">
        <ul className="grid gap-0.5">
          {o.coils.map((c) => (
            <li key={c.coilId}>
              <Link className={`${LINK_CLASSNAME} font-mono`} href={`/bobinas/${c.coilId}`}>
                {c.code}
              </Link>{' '}
              {formatQty(c.consumedKg, 'kg')}
              {c.trimKg !== '0.000' && (
                <span
                  className="text-muted-foreground"
                  title={`${trimLabel} de la orden, repartido en orden de montaje`}
                >
                  {' '}
                  · {trimLabel.toLowerCase()} {formatQty(c.trimKg, 'kg')} (repartido en orden de
                  montaje)
                </span>
              )}
            </li>
          ))}
        </ul>
      </TableCell>
    </TableRow>
  );
}

function FigureCells({
  f,
  withCosts,
}: {
  f: {
    theoreticalKg: string;
    consumedKg: string;
    trimKg: string;
    wastePct: string | null;
    overStandard: boolean;
    materialCostPen: string | null;
    trimCostPen: string | null;
  };
  withCosts: boolean;
}) {
  return (
    <>
      <TableCell className="text-right">{formatQty(f.theoreticalKg, 'kg')}</TableCell>
      <TableCell className="text-right">{formatQty(f.consumedKg, 'kg')}</TableCell>
      <TableCell className="text-right">{formatQty(f.trimKg, 'kg')}</TableCell>
      <TableCell className="text-right">
        <Pct value={f.wastePct} over={f.overStandard} />
      </TableCell>
      {withCosts && (
        <TableCell className="text-right">{formatMoneyOrDash(f.materialCostPen)}</TableCell>
      )}
      {withCosts && (
        <TableCell className="text-right">{formatMoneyOrDash(f.trimCostPen)}</TableCell>
      )}
    </>
  );
}

/** D-434: el porcentaje, en rojo solo si pasa la tolerancia del 1 % sobre el estándar. */
function Pct({ value, over }: { value: string | null; over: boolean }) {
  if (value === null) return <>—</>;
  return over ? <Badge variant="destructive">{value} %</Badge> : <span>{value} %</span>;
}

/** Coberturas Aluzinc y Drywall, sin «Todas» (como la merma, D-424); el rango sobrevive. */
const LINE_TABS: LineTabsConfig = {
  lines: COIL_REPORT_LINES,
  includeAll: false,
  keep: ['from', 'to'],
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Primer día del mes de negocio en curso, el rango por defecto. */
function firstOfMonth(): string {
  return `${businessToday().slice(0, 7)}-01`;
}
