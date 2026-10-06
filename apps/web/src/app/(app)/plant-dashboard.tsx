'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  LOW_COIL_THRESHOLD_PCT,
  Role,
  sum,
  type PlantDashboardDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatDate, formatQty } from '@/lib/format';
import { Stat, StatStrip } from '@/components/stat-strip';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * cc26 (D-440, M5). El Panel del supervisor de planta: la cola de OPs, las bobinas montadas, lo
 * consumido hoy y en la semana y las bobinas por terminarse (`GET /reports/plant-dashboard`). Las
 * cifras son las de las lecturas de `/planta`, `/bobinas` y del kardex de producción, sin
 * recalcular. Ámbar solo para lo que hay que mirar (vencido, por terminarse); sin rojo.
 */
export function PlantDashboard() {
  const { user } = useSession();
  const isPlant = user.role === Role.SUPERVISOR_PLANTA;
  const q = useQuery({
    queryKey: ['report', 'plant-dashboard'],
    queryFn: () => api<PlantDashboardDto>('/reports/plant-dashboard'),
    enabled: isPlant,
    refetchInterval: 60_000,
  });

  if (!isPlant) return null;
  if (q.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Cargando el panel de planta">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-3 text-sm text-muted-foreground">
          No se pudo cargar el panel de planta. La cola sigue en Producción.
        </CardContent>
      </Card>
    );
  }
  return <PlantDashboardBody d={q.data} />;
}

function PlantDashboardBody({ d }: { d: PlantDashboardDto }) {
  const todayKg = sum(d.production.map((p) => p.todayKg)).toFixed(3);
  const weekKg = sum(d.production.map((p) => p.weekKg)).toFixed(3);
  const perLine = (key: 'todayKg' | 'weekKg') =>
    d.production
      .map((p) => `${BUSINESS_LINE_LABELS[p.businessLine]} ${formatQty(p[key], 'kg')}`)
      .join(' · ');

  return (
    <section className="grid gap-3" aria-labelledby="plant-dashboard-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="plant-dashboard-title" className="text-sm font-semibold">
          Planta hoy
        </h2>
        <p className="text-xs text-muted-foreground">
          Semana del {formatDate(d.week.from)} al {formatDate(d.week.to)}
        </p>
      </div>

      <StatStrip className="sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Cola de OPs">
          <Link className="block hover:underline" href="/planta">
            <span className="text-base font-semibold">{d.queue.count}</span>
            <span
              className={cn(
                'block text-xs font-normal',
                d.queue.overdueCount > 0 ? 'text-tone-warning-foreground' : 'text-muted-foreground',
              )}
            >
              {d.queue.overdueCount} vencidas · {d.queue.priorityCount} con prioridad
            </span>
          </Link>
        </Stat>
        <Stat label="Bobinas montadas">
          <Link className="block hover:underline" href="/planta">
            <span className="text-base font-semibold">{d.mounted.length}</span>
            <span className="block text-xs font-normal text-muted-foreground">
              En órdenes en borrador o en curso
            </span>
          </Link>
        </Stat>
        <Stat label="Consumido hoy">
          <span className="text-base font-semibold">{formatQty(todayKg, 'kg')}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {perLine('todayKg')}
          </span>
        </Stat>
        <Stat label="Consumido en la semana">
          <span className="text-base font-semibold">{formatQty(weekKg, 'kg')}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {perLine('weekKg')}
          </span>
        </Stat>
        <Stat label="Bobinas por terminarse">
          <Link className="block hover:underline" href="/bobinas">
            <span
              className={cn(
                'text-base font-semibold',
                d.lowCoils.length > 0 && 'text-tone-warning-foreground',
              )}
            >
              {d.lowCoils.length}
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              Abiertas con {LOW_COIL_THRESHOLD_PCT} % o menos de su peso
            </span>
          </Link>
        </Stat>
      </StatStrip>

      <div className="grid gap-3 xl:grid-cols-3">
        <Card size="sm" className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">
              <Link className="hover:underline" href="/planta">
                Próximas en la cola
              </Link>
            </CardTitle>
            <CardDescription className="text-xs">
              En el orden de la cola de Producción (fecha prometida y prioridad, D-189).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {d.queue.next.length === 0 ? (
              <p className="text-sm text-muted-foreground">No hay órdenes esperando.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">OP</th>
                    <th className="py-1 pr-2 font-medium">Cliente</th>
                    <th className="py-1 pr-2 font-medium">Producto</th>
                    <th className="py-1 pr-2 text-right font-medium">ML</th>
                    <th className="py-1 font-medium">Entrega</th>
                  </tr>
                </thead>
                <tbody>
                  {d.queue.next.map((o) => (
                    <tr key={o.orderId} className="border-t">
                      <td className="py-1 pr-2 font-medium whitespace-nowrap">
                        <Link className="hover:underline" href={`/produccion/${o.orderId}`}>
                          {o.code}
                        </Link>
                        {o.priority && (
                          <Badge variant="outline" className="ml-1">
                            Prioridad
                          </Badge>
                        )}
                      </td>
                      <td className="max-w-48 truncate py-1 pr-2" title={o.customerName ?? ''}>
                        {o.customerName ?? '—'}
                      </td>
                      <td className="max-w-64 truncate py-1 pr-2" title={o.productName}>
                        {o.productName}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{o.planMeters}</td>
                      <td
                        className={cn(
                          'py-1 whitespace-nowrap',
                          o.overdue && 'text-tone-warning-foreground',
                        )}
                      >
                        {o.promisedDeliveryDate ? formatDate(o.promisedDeliveryDate) : 'Sin fecha'}
                        {o.overdue && ' · vencida'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Bobinas por terminarse</CardTitle>
            <CardDescription className="text-xs">
              Saldo del kardex sobre el peso de la bobina. Cada una abre su ficha.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {d.lowCoils.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Ninguna bajo el {LOW_COIL_THRESHOLD_PCT} %.
              </p>
            ) : (
              <ul className="grid gap-2">
                {d.lowCoils.map((c) => (
                  <li key={c.id}>
                    <Link href={`/bobinas/${c.id}`} className="group grid gap-1 text-sm">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium group-hover:underline">
                          {c.code}
                          {c.mounted && (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              montada
                            </span>
                          )}
                        </span>
                        <span className="text-xs whitespace-nowrap tabular-nums text-muted-foreground">
                          {formatQty(c.availableKg, 'kg')} · {c.remainingPct} %
                        </span>
                      </span>
                      <span className="block h-1.5 rounded-full bg-muted" aria-hidden>
                        <span
                          className="block h-full rounded-full bg-tone-warning-foreground"
                          style={{ width: `${Math.min(100, Number(c.remainingPct) * 10)}%` }}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {d.mounted.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Bobinas montadas</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {d.mounted.map((m) => (
                <li key={m.coilCode} className="whitespace-nowrap">
                  <span className="font-medium">{m.coilCode}</span>
                  <span className="text-muted-foreground"> en </span>
                  {m.orders.map((o, i) => (
                    <span key={o.orderId}>
                      {i > 0 && ', '}
                      <Link className="hover:underline" href={`/produccion/${o.orderId}`}>
                        {o.code}
                      </Link>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
