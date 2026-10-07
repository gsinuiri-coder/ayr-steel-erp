'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  AGING_BUCKETS,
  AGING_BUCKET_LABELS,
  BUSINESS_LINE_LABELS,
  Role,
  toDecimal,
  toFixedString,
  type AdminDashboardDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatMoney } from '@/lib/format';
import {
  axisMoney,
  billedPen,
  coilWasteHref,
  fillDays,
  salesMarginHref,
  variationPct,
} from '@/lib/admin-dashboard';
import { Stat, StatStrip } from '@/components/stat-strip';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * cc26 (D-440, M4). El Panel del administrador: cifras del mes y tres gráficos, cada uno leído
 * de su reporte para el mismo rango (`GET /reports/admin-dashboard`) y enlazado a ese reporte.
 * No calcula: lo único que se hace aquí es rellenar con cero los días sin facturación y comparar
 * dos totales del mismo reporte (`lib/admin-dashboard.ts`).
 *
 * Colores con su significado fijo (globals.css): el acento para lo vivo (la venta, lo por
 * vencer) y el ámbar solo para «hace falta mirarlo» (lo vencido, lo fuera de tolerancia). El
 * rojo no aparece: nada de esto es un error.
 */

const money0 = (v: string) => formatMoney(v, 'PEN', 0);

const salesConfig = {
  salesPen: { label: 'Facturado sin IGV', color: 'var(--primary)' },
} satisfies ChartConfig;

const agingConfig = {
  current: { label: 'Por vencer', color: 'var(--primary)' },
  overdue: { label: 'Vencido', color: 'var(--destructive)' },
} satisfies ChartConfig;

/** Lo que el gráfico guarda de cada fila: el importe tal cual viene del reporte. */
const payloadPen = (payload: unknown, key: 'salesPen' | 'balancePen' | 'date'): string =>
  (payload as Partial<Record<typeof key, string>> | undefined)?.[key] ?? '';

export function AdminDashboard() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const q = useQuery({
    queryKey: ['report', 'admin-dashboard'],
    queryFn: () => api<AdminDashboardDto>('/reports/admin-dashboard'),
    enabled: isAdmin,
    // Es el mismo costo que abrir cuatro reportes: no se refresca solo cada minuto como los avisos.
    staleTime: 5 * 60_000,
  });

  if (!isAdmin) return null;
  if (q.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Cargando el panel">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-3 text-sm text-muted-foreground">
          No se pudieron cargar las cifras del mes. Los reportes siguen disponibles en el menú.
        </CardContent>
      </Card>
    );
  }
  return <AdminDashboardBody d={q.data} />;
}

function AdminDashboardBody({ d }: { d: AdminDashboardDto }) {
  const router = useRouter();
  const variation = variationPct(d.sales.salesPen, d.previousSalesPen);
  const outside = [
    d.sales.excludedOrderCount > 0 && `${d.sales.excludedOrderCount} no comparables`,
    d.sales.untraceableOrderCount > 0 && `${d.sales.untraceableOrderCount} sin costo rastreable`,
  ].filter(Boolean);
  const tolerance = d.outOfTolerance.reduce((acc, l) => acc + l.productionCount, 0);
  const toleranceLine = d.outOfTolerance.find((l) => l.productionCount > 0) ?? d.outOfTolerance[0];
  const days = fillDays(d.current, d.salesByDay).map((x) => ({
    ...x,
    value: Number(x.salesPen),
    day: x.date.slice(8),
  }));
  const aging = AGING_BUCKETS.map((b) => ({
    bucket: b,
    label: AGING_BUCKET_LABELS[b],
    balancePen: d.receivables.buckets[b],
    // Dos series para dos colores fijos: lo por vencer (acento) y lo vencido (ámbar).
    current: b === 'CURRENT' ? Number(d.receivables.buckets[b]) : 0,
    overdue: b === 'CURRENT' ? 0 : Number(d.receivables.buckets[b]),
  }));
  const maxLine = Math.max(1, ...d.salesByLine.map((l) => Number(l.salesPen)));
  const rangeLabel = `${formatDate(d.current.from)} – ${formatDate(d.current.to)}`;
  const billed = billedPen(d.sales);

  return (
    <section className="grid gap-3" aria-labelledby="admin-dashboard-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="admin-dashboard-title" className="text-sm font-semibold">
          El mes en cifras
        </h2>
        <p className="text-xs text-muted-foreground">
          {rangeLabel} · cada cifra abre su reporte con este rango
        </p>
      </div>

      <StatStrip className="sm:grid-cols-3 lg:grid-cols-5">
        <LinkStat href={salesMarginHref(d.current)} label="Ventas del mes sin IGV">
          <span className="text-base font-semibold">{money0(d.sales.salesPen)}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {variation === null ? 'Sin ventas en el mismo tramo' : `${variation} %`} vs.{' '}
            {money0(d.previousSalesPen)} del 1 al {Number(d.previous.to.slice(8))} del mes anterior
          </span>
          {/* cc28 (D-444): el gráfico suma lo facturado; aquí se dice cuánto es y por qué difiere. */}
          <span
            className="block text-xs font-normal text-muted-foreground"
            data-testid="billed-month"
          >
            Facturado del mes {money0(billed)}
            {billed !== toFixedString(toDecimal(d.sales.salesPen), 'MONEY') &&
              ' (incluye ventas sin costo comparable)'}
          </span>
        </LinkStat>
        <LinkStat href={salesMarginHref(d.current)} label="Margen del mes">
          <span className="text-base font-semibold">{money0(d.sales.marginPen)}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {d.sales.marginPct === null ? '—' : `${d.sales.marginPct} %`} · sin Servicios ni líneas
            sin producto
            {outside.length > 0 && ` · fuera del margen: ${outside.join(', ')}`}
          </span>
        </LinkStat>
        <LinkStat href="/reportes/cuentas-por-cobrar" label="Cuentas por cobrar">
          <span className="text-base font-semibold">{money0(d.receivables.balancePen)}</span>
          <span
            className={cn(
              'block text-xs font-normal',
              Number(d.receivables.overduePen) > 0
                ? 'text-tone-warning-foreground'
                : 'text-muted-foreground',
            )}
          >
            Vencido {money0(d.receivables.overduePen)} · {d.receivables.customerCount}{' '}
            {d.receivables.customerCount === 1 ? 'cliente' : 'clientes'}
          </span>
        </LinkStat>
        <LinkStat href="/reportes/inventario-valorizado" label="Inventario valorizado">
          <span className="text-base font-semibold">{money0(d.inventory.totalValuePen)}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Bobinas {money0(d.inventory.coilValuePen)} · productos{' '}
            {money0(d.inventory.productValuePen)}
          </span>
        </LinkStat>
        <LinkStat
          href={
            toleranceLine ? coilWasteHref(d.current, toleranceLine.businessLine) : '/reportes/merma'
          }
          label="Fuera de tolerancia (mes)"
        >
          <span
            className={cn(
              'text-base font-semibold',
              tolerance > 0 && 'text-tone-warning-foreground',
            )}
          >
            {tolerance}
          </span>
          <span className="block text-xs font-normal text-muted-foreground">
            {d.outOfTolerance
              .map((l) => `${BUSINESS_LINE_LABELS[l.businessLine]} ${l.productionCount}`)
              .join(' · ')}
          </span>
        </LinkStat>
      </StatStrip>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">
              <Link className="hover:underline" href={salesMarginHref(d.current)}>
                Facturado por día (sin IGV)
                {billed !== toFixedString(toDecimal(d.sales.salesPen), 'MONEY') &&
                  ', incluye ventas sin costo comparable'}
              </Link>
            </CardTitle>
            <CardDescription className="text-xs">
              Por fecha de emisión; las notas de crédito restan. Suma también los pedidos que el
              margen deja fuera por su costo. Un clic en la barra abre ese día.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={salesConfig} className="aspect-auto h-56 w-full">
              <BarChart data={days} margin={{ left: 4, right: 4, top: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} interval={0} fontSize={11} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  fontSize={11}
                  tickFormatter={axisMoney}
                />
                <ChartTooltip
                  cursor={{ fill: 'var(--muted)' }}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        formatDate(payloadPen(payload?.[0]?.payload, 'date'))
                      }
                      formatter={(_, __, item) => (
                        <span className="font-medium tabular-nums">
                          {formatMoney(payloadPen(item.payload, 'salesPen'))}
                        </span>
                      )}
                    />
                  }
                />
                <Bar
                  dataKey="value"
                  name="salesPen"
                  fill="var(--color-salesPen)"
                  radius={[2, 2, 0, 0]}
                  className="cursor-pointer"
                  onClick={(entry: { payload?: { date?: string } }) => {
                    const date = entry.payload?.date;
                    if (date) router.push(salesMarginHref({ from: date, to: date }));
                  }}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Ventas por línea</CardTitle>
            <CardDescription className="text-xs">
              Venta sin IGV y margen de cada línea en el mes. Cada fila abre su pestaña.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {d.salesByLine.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin ventas en el mes.</p>
            ) : (
              <ul className="grid gap-2">
                {d.salesByLine.map((l) => {
                  const name =
                    l.businessLine === null ? 'Sin línea' : BUSINESS_LINE_LABELS[l.businessLine];
                  const width = Math.max(0, (Number(l.salesPen) / maxLine) * 100);
                  return (
                    <li key={l.businessLine ?? 'sin-linea'}>
                      <Link
                        href={salesMarginHref(d.current, l.businessLine)}
                        className="group grid gap-1 rounded-sm text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate group-hover:underline">{name}</span>
                          <span className="tabular-nums">
                            {money0(l.salesPen)}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {l.businessLine === 'services' || l.businessLine === null
                                ? 'sin costo'
                                : l.marginPct === null
                                  ? '—'
                                  : `${l.marginPct} %`}
                            </span>
                          </span>
                        </span>
                        <span className="block h-1.5 rounded-full bg-muted" aria-hidden>
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${width}%` }}
                          />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">
            <Link className="hover:underline" href="/reportes/cuentas-por-cobrar">
              Antigüedad de cuentas por cobrar
            </Link>
          </CardTitle>
          <CardDescription className="text-xs">
            Saldo a hoy por días de vencido; el contado vence al emitir.{' '}
            {d.receivables.documentCount} comprobantes con saldo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={agingConfig} className="aspect-auto h-40 w-full">
            <BarChart data={aging} layout="vertical" margin={{ left: 4, right: 16 }}>
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={axisMoney}
              />
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={124}
                fontSize={12}
              />
              <ChartTooltip
                cursor={{ fill: 'var(--muted)' }}
                content={
                  <ChartTooltipContent
                    hideIndicator
                    // Cada fila tiene una sola serie con importe; la otra es cero y no se lista.
                    formatter={(value, __, item) =>
                      Number(value) === 0 ? null : (
                        <span className="font-medium tabular-nums">
                          {formatMoney(payloadPen(item.payload, 'balancePen'))}
                        </span>
                      )
                    }
                  />
                }
              />
              <Bar dataKey="current" stackId="aging" fill="var(--color-current)" radius={2} />
              <Bar dataKey="overdue" stackId="aging" fill="var(--color-overdue)" radius={2} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </section>
  );
}

/** Una celda de la tira que abre su reporte. La cifra manda; el rótulo la acompaña. */
function LinkStat({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stat label={label}>
      <Link
        href={href}
        className="block rounded-sm decoration-muted-foreground/50 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </Link>
    </Stat>
  );
}
