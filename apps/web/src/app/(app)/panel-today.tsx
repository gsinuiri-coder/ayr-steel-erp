'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  businessToday,
  BUSINESS_TIME_ZONE,
  ROLE_LABELS,
  Role,
  type PaginatedResult,
  type QuotationStockShortageDto,
  type SalesOrderListItemDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { expiringQuotationDates } from '@/lib/pending';
import { useSession } from '@/lib/session';
import { usePendingSources } from '@/components/pending-bell';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** «martes 6 de octubre», el día de negocio en Lima. */
function longToday(): string {
  const text = new Intl.DateTimeFormat('es-PE', {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  return text.charAt(0).toUpperCase() + text.slice(1).replace(',', '');
}

/**
 * cc31: la cabecera del Panel — el título, el día y quién está, y las acciones de todos los días
 * según el rol. Reemplaza al saludo de «Fase 0», que hablaba de módulos por activarse.
 */
export function PanelHeader() {
  const { user } = useSession();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">Panel</h1>
        <p className="text-muted-foreground">
          {longToday()} · {user.name}, {ROLE_LABELS[user.role].toLowerCase()}
        </p>
      </div>
      <div className="flex gap-2">
        {user.role === Role.ADMINISTRADOR && (
          <Button variant="outline" asChild>
            <Link href="/pedidos/nuevo">Nuevo pedido</Link>
          </Button>
        )}
        {(user.role === Role.ADMINISTRADOR || user.role === Role.VENDEDOR) && (
          <Button asChild>
            <Link href="/cotizaciones/nueva">Nueva cotización</Link>
          </Button>
        )}
        {user.role === Role.SUPERVISOR_PLANTA && (
          <Button asChild>
            <Link href="/planta">Ir a producción</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

interface Tile {
  key: string;
  count: number | null;
  label: string;
  detail?: string;
  href: string;
  /** El conteo pide mirarlo (ámbar) cuando no es cero. */
  attention?: boolean;
}

/** Lo que entrega `GET /sales/dashboard`, ya filtrado por el vendedor en el API. */
interface SellerDashboardDto {
  expiringQuotations: number;
  expiringReservations: number;
  productionOrders: number;
  readyOrders: number;
}

/**
 * cc31: «Para atender hoy» — una tarjeta por pendiente, cada una lleva a su lista ya filtrada (o a
 * su aviso, más abajo en el Panel). El vendedor ve lo suyo con el mismo endpoint de antes
 * (`/sales/dashboard`, que el API filtra por él); el administrador, la empresa entera con las
 * mismas consultas que la campana; planta, su cola.
 */
export function PanelToday() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const isSeller = user.role === Role.VENDEDOR;
  const pending = usePendingSources();

  const seller = useQuery({
    queryKey: ['seller-dashboard'],
    queryFn: () => api<SellerDashboardDto>('/sales/dashboard'),
    enabled: isSeller,
    refetchInterval: 60_000,
  });
  const inProduction = useQuery({
    queryKey: ['pending', 'in-production-orders'],
    queryFn: () =>
      api<PaginatedResult<SalesOrderListItemDto>>('/sales/orders?stage=IN_PRODUCTION&pageSize=1'),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const stockShortages = useQuery({
    queryKey: ['quotation-stock-shortages'],
    queryFn: () => api<QuotationStockShortageDto[]>('/sales/quotations/stock-shortages'),
    enabled: isAdmin,
  });

  let tiles: Tile[] = [];
  if (isAdmin) {
    tiles = [
      {
        key: 'quotations',
        count:
          pending.emittedQuotations === null
            ? null
            : expiringQuotationDates(pending.emittedQuotations, businessToday()).length,
        label: 'Cotizaciones por vencer',
        detail: 'esta semana',
        href: '/cotizaciones?status=EMITTED',
      },
      {
        key: 'ready',
        count: pending.readyOrders,
        label: 'Pedidos listos',
        detail: 'para despachar',
        href: '/pedidos?stage=READY',
      },
      {
        key: 'production',
        count: inProduction.data?.total ?? null,
        label: 'Pedidos en producción',
        href: '/pedidos?stage=IN_PRODUCTION',
      },
      {
        key: 'stock',
        count: stockShortages.data?.length ?? null,
        label: 'Cotizaciones sin stock',
        detail: 'evaluar compra',
        href: '#cotizaciones-sin-stock',
        attention: true,
      },
      {
        key: 'shortfall',
        count: pending.shortfallOrders?.length ?? null,
        label: 'Pedidos con faltante',
        detail: 'confirmados sin material',
        href: '#pedidos-con-faltante',
        attention: true,
      },
      {
        key: 'floor',
        count: pending.belowFloorPrices,
        label: 'Precios de lista bajo el piso',
        detail: 'revisar precio',
        href: '#precios-bajo-piso',
        attention: true,
      },
    ];
  } else if (isSeller) {
    tiles = [
      {
        key: 'quotations',
        count: seller.data?.expiringQuotations ?? null,
        label: 'Cotizaciones por vencer',
        detail: 'en los próximos 3 días hábiles',
        href: '/cotizaciones?status=DRAFT,EMITTED',
      },
      {
        key: 'reservations',
        count: seller.data?.expiringReservations ?? null,
        label: 'Reservas por expirar',
        detail: 'en los próximos 3 días',
        href: '/reservas-temporales',
      },
      {
        key: 'production',
        count: seller.data?.productionOrders ?? null,
        label: 'Pedidos en producción',
        href: '/pedidos?stage=IN_PRODUCTION',
      },
      {
        key: 'ready',
        count: seller.data?.readyOrders ?? null,
        label: 'Pedidos listos',
        detail: 'para despachar',
        href: '/pedidos?stage=READY',
      },
    ];
  } else {
    tiles = [
      {
        key: 'queue',
        count: pending.productionQueue,
        label: 'Órdenes en cola',
        detail: 'esperando producción',
        href: '/planta',
      },
    ];
  }

  return (
    <section aria-labelledby="panel-today" className="grid gap-2">
      <h2 id="panel-today" className="text-sm font-semibold">
        Para atender hoy
      </h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className="group grid gap-0.5 rounded-lg border bg-card px-3 py-2.5 hover:border-primary/40 hover:bg-accent"
          >
            <span
              className={cn(
                'text-xl font-semibold tabular-nums',
                t.attention && (t.count ?? 0) > 0 && 'text-tone-warning-foreground',
                t.count === 0 && 'text-muted-foreground',
              )}
            >
              {t.count ?? '…'}
            </span>
            <span className="text-[13px] leading-snug font-medium group-hover:underline">
              {t.label}
            </span>
            {t.detail && <span className="text-xs text-muted-foreground">{t.detail}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}
