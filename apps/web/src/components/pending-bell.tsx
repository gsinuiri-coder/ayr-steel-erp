'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import {
  businessToday,
  Role,
  type OrderWithShortfallDto,
  type PaginatedResult,
  type PriceListFloorSummaryDto,
  type ProductionQueueEntryDto,
  type QuotationListItemDto,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { LIVE_PENDING_QUERY_KEYS, pendingRows, type PendingSources } from '@/lib/pending';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** La campana se recalcula cada minuto (ESPEC §8). */
const REFRESH_MS = 60_000;

/**
 * Lo caro se recalcula cada 10 minutos: el piso de precios recorre el catálogo entero y las
 * cotizaciones emitidas traen hasta 200 filas. El límite de peticiones del API se comparte entre
 * todos los usuarios (una sola IP detrás del proxy), así que la campana no puede gastarlo.
 */
const SLOW_REFRESH_MS = 600_000;

/**
 * cc31: lo que alimenta la campana y los contadores del menú. Cada consulta usa la misma clave
 * que la pantalla que ya la pedía (Panel, comprobantes, reservas…), así que no se piden dos veces.
 * Para el vendedor solo se usan endpoints que el API ya filtra por vendedor.
 */
export function usePendingSources(): PendingSources & {
  own: boolean;
  status: 'loading' | 'error' | 'ok';
  /** cc32: qué fuente falló, para que el Panel diga «No se pudo calcular» en vez de «…». */
  failed: Partial<Record<keyof PendingSources, boolean>>;
  /** Vuelve a pedir las fuentes que fallaron. */
  retry: () => void;
} {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const isSeller = user.role === Role.VENDEDOR;
  const sells = isAdmin || isSeller;
  const plants = isAdmin || user.role === Role.SUPERVISOR_PLANTA;
  const live = { refetchInterval: REFRESH_MS, staleTime: 30_000 } as const;
  const slow = { refetchInterval: SLOW_REFRESH_MS, staleTime: SLOW_REFRESH_MS / 2 } as const;

  // El administrador usa el contador global; el vendedor, la lista filtrada por él.
  const alerts = useQuery({
    queryKey: LIVE_PENDING_QUERY_KEYS[0],
    queryFn: () => api<{ pending: number; stalled: number }>('/invoicing/alerts'),
    enabled: isAdmin,
    ...live,
  });
  const ownDocuments = useQuery({
    queryKey: LIVE_PENDING_QUERY_KEYS[1],
    queryFn: () =>
      api<PaginatedResult<unknown>>('/invoicing/documents?status=ISSUED,SEND_ERROR&pageSize=1'),
    enabled: isSeller,
    ...live,
  });
  const shortfall = useQuery({
    queryKey: LIVE_PENDING_QUERY_KEYS[2],
    queryFn: () => api<OrderWithShortfallDto[]>('/sales/orders/with-shortfall'),
    enabled: isAdmin,
    ...live,
  });
  const floor = useQuery({
    queryKey: ['price-list-floor-summary'],
    queryFn: () => api<PriceListFloorSummaryDto>('/catalog/price-list/floor-summary'),
    enabled: isAdmin,
    ...slow,
  });
  const ready = useQuery({
    queryKey: LIVE_PENDING_QUERY_KEYS[3],
    queryFn: () =>
      api<PaginatedResult<SalesOrderListItemDto>>('/sales/orders?stage=READY&pageSize=1'),
    enabled: sells,
    ...live,
  });
  // D-488: las reservas temporales no entran a la campana: su listado barre (escribe) las
  // vencidas en cada lectura, y pedirlo cada minuto desde toda pantalla multiplicaba esa escritura.
  const quotations = useQuery({
    queryKey: ['pending', 'emitted-quotations'],
    queryFn: () =>
      // Las más antiguas primero: son las que vencen antes, y con más de 200 no se pierden.
      api<PaginatedResult<QuotationListItemDto>>(
        '/sales/quotations?status=EMITTED&pageSize=200&sort=issueDate&dir=asc',
      ),
    enabled: sells,
    ...slow,
  });
  const queue = useQuery({
    queryKey: LIVE_PENDING_QUERY_KEYS[4],
    queryFn: () => api<ProductionQueueEntryDto[]>('/production/roofing/queue'),
    enabled: plants,
    ...live,
  });

  const enabled = [alerts, ownDocuments, shortfall, floor, ready, quotations, queue].filter(
    (q) => !(q.fetchStatus === 'idle' && q.status === 'pending'),
  );
  return {
    own: isSeller,
    // Sin esto, mientras carga o si algo falla, la campana decía «No hay nada pendiente».
    status: enabled.some((q) => q.isError)
      ? 'error'
      : enabled.some((q) => q.isPending)
        ? 'loading'
        : 'ok',
    unacceptedDocuments: isAdmin
      ? (alerts.data?.pending ?? null)
      : isSeller
        ? (ownDocuments.data?.total ?? null)
        : null,
    shortfallOrders: shortfall.data ?? null,
    belowFloorPrices: floor.data?.belowFloor.length ?? null,
    readyOrders: ready.data?.total ?? null,
    temporaryReservations: null,
    emittedQuotations: quotations.data?.items ?? null,
    productionQueue: queue.data?.length ?? null,
    // Solo cuando no hay cifra: un sondeo de fondo que falla no tapa la última cifra buena.
    failed: {
      shortfallOrders: shortfall.isError && shortfall.data === undefined,
      belowFloorPrices: floor.isError && floor.data === undefined,
      readyOrders: ready.isError && ready.data === undefined,
      emittedQuotations: quotations.isError && quotations.data === undefined,
    },
    retry: () => {
      for (const q of enabled) if (q.isError) void q.refetch();
    },
  };
}

/**
 * cc31: la campana de la barra superior. Lista lo pendiente del rol y lleva a cada lista ya
 * filtrada. No guarda «leído»: lo resuelto desaparece solo en el próximo recálculo.
 */
export function PendingBell() {
  const sources = usePendingSources();
  const [open, setOpen] = useState(false);
  const rows = pendingRows(sources, businessToday(), sources.own);
  const count = rows.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={count > 0 ? `Pendientes: ${String(count)}` : 'Pendientes: ninguno'}
        >
          <Bell />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-xs leading-none font-semibold text-white tabular-nums">
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-baseline justify-between border-b px-3 py-2">
          <span className="font-semibold">Pendientes</span>
          <span className="text-xs text-muted-foreground">se actualiza cada minuto</span>
        </div>
        {sources.status === 'error' && (
          <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
            No se pudo calcular todo: puede faltar algún pendiente.{' '}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={sources.retry}>
              Reintentar
            </Button>
          </p>
        )}
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted-foreground">
            {sources.status === 'loading' ? 'Calculando los pendientes…' : 'No hay nada pendiente.'}
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.key}>
                <Link
                  href={row.href}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{row.title}</span>
                    {row.detail && (
                      <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
                    )}
                  </span>
                  <span className="text-xs font-medium text-primary">Ver</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Cada fila lleva a su lista ya filtrada. Desaparece cuando se resuelve.
        </p>
      </PopoverContent>
    </Popover>
  );
}
