import { BUSINESS_TIME_ZONE } from '@ayr/shared';
import { formatDate } from '@/lib/format';

/**
 * cc31: la campana de pendientes (ESPEC §8). Se calcula al momento con los endpoints que ya
 * existen: sin «leído», sin historial y sin tabla nueva. Cada fila lleva a su lista filtrada y
 * desaparece sola cuando el pendiente se resuelve.
 *
 * Esta parte es pura: recibe lo que trajeron las consultas (`null` si el rol no la pide o
 * todavía no llegó) y arma las filas, para poder probarla sin navegador.
 */
export interface PendingSources {
  /** Comprobantes con número que SUNAT todavía no aceptó (emitidos o con error de envío). */
  unacceptedDocuments: number | null;
  /** Pedidos confirmados con faltante de material. */
  shortfallOrders: readonly { orderCode: string }[] | null;
  /** Precios de lista bajo el piso. */
  belowFloorPrices: number | null;
  /** Pedidos listos para despachar. */
  readyOrders: number | null;
  /** Reservas temporales vigentes. */
  temporaryReservations: readonly { quotationCode: string; expiresAt: string }[] | null;
  /** Cotizaciones emitidas con su fecha de vencimiento. */
  emittedQuotations: readonly { validUntil: string | null }[] | null;
  /** Órdenes esperando producción. */
  productionQueue: number | null;
}

export interface PendingRow {
  key: string;
  title: string;
  detail?: string;
  href: string;
}

/** Cuántos días adelante cuenta «por vencer» para una cotización. */
export const QUOTATION_EXPIRY_WINDOW_DAYS = 7;

/**
 * cc32 (P3 de cc31): las consultas de la campana que se piden cada minuto. Toda operación que
 * termina bien las vuelve a pedir (`Providers`), así despachar o emitir se refleja al momento y
 * no al siguiente ciclo. Las lentas (piso de precios, cotizaciones por vencer) no entran: son
 * caras y no las mueve un despacho ni una emisión.
 */
export const LIVE_PENDING_QUERY_KEYS = [
  ['invoicing-alerts'],
  ['pending', 'own-unaccepted-documents'],
  ['orders-with-shortfall'],
  ['pending', 'ready-orders'],
  ['production-queue'],
] as const;

export function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function limaDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function limaTime(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  // Mediodía UTC cae en el mismo día de calendario en Lima: se formatea en Lima.
  return limaDay(d.toISOString());
}

/**
 * Las fechas de vencimiento de las cotizaciones emitidas que vencen entre hoy y los próximos
 * `QUOTATION_EXPIRY_WINDOW_DAYS` días, de la más próxima a la más lejana. La usan la campana y el
 * contador de «Cotizaciones» del menú.
 */
export function expiringQuotationDates(
  quotations: readonly { validUntil: string | null }[],
  today: string,
): string[] {
  const limit = addDays(today, QUOTATION_EXPIRY_WINDOW_DAYS);
  return quotations
    .map((q) => q.validUntil)
    .filter((d): d is string => d !== null && d >= today && d <= limit)
    .sort((a, b) => a.localeCompare(b));
}

function listCodes(codes: string[]): string {
  if (codes.length <= 2) return codes.join(' y ');
  return `${codes.slice(0, 2).join(', ')} y ${String(codes.length - 2)} más`;
}

/**
 * Las filas de la campana, en el orden del tablero: primero lo que bloquea a un cliente
 * (comprobantes, faltantes), después lo que se puede despachar o vence.
 *
 * `today` es el día de negocio de Lima (`YYYY-MM-DD`); `own` dice si las cifras son solo del
 * usuario (vendedor), para decir «tuyas».
 */
export function pendingRows(src: PendingSources, today: string, own: boolean): PendingRow[] {
  const rows: PendingRow[] = [];

  if (src.unacceptedDocuments) {
    rows.push({
      key: 'unaccepted',
      title: `${plural(src.unacceptedDocuments, 'comprobante', 'comprobantes')} sin aceptar por SUNAT`,
      href: '/comprobantes?status=ISSUED,SEND_ERROR',
    });
  }
  if (src.shortfallOrders && src.shortfallOrders.length > 0) {
    rows.push({
      key: 'shortfall',
      title: `${plural(src.shortfallOrders.length, 'pedido confirmado', 'pedidos confirmados')} con faltante de material`,
      detail: listCodes(src.shortfallOrders.map((o) => o.orderCode)),
      href: '/',
    });
  }
  if (src.belowFloorPrices) {
    rows.push({
      key: 'below-floor',
      title: `${plural(src.belowFloorPrices, 'precio', 'precios')} de lista bajo el piso`,
      detail: 'No bloquean, pero una cotización nueva sí lo exige',
      href: '/',
    });
  }
  if (src.readyOrders) {
    rows.push({
      key: 'ready',
      title:
        src.readyOrders === 1
          ? `1 pedido${own ? ' tuyo' : ''} listo para despachar`
          : `${String(src.readyOrders)} pedidos${own ? ' tuyos' : ''} listos para despachar`,
      href: '/pedidos?stage=READY',
    });
  }
  const reservationsToday = (src.temporaryReservations ?? [])
    .filter((r) => limaDay(r.expiresAt) === today)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const firstReservation = reservationsToday[0];
  if (firstReservation) {
    rows.push({
      key: 'reservations',
      title: `${plural(reservationsToday.length, 'reserva temporal vence', 'reservas temporales vencen')} hoy`,
      detail: `${firstReservation.quotationCode} · a las ${limaTime(firstReservation.expiresAt)}`,
      href: '/reservas-temporales',
    });
  }
  const expiring = expiringQuotationDates(src.emittedQuotations ?? [], today);
  const firstExpiry = expiring[0];
  if (firstExpiry) {
    const when =
      firstExpiry === today
        ? 'hoy'
        : firstExpiry === addDays(today, 1)
          ? 'mañana'
          : `el ${formatDate(firstExpiry).slice(0, 5)}`;
    rows.push({
      key: 'quotations',
      title: `${plural(expiring.length, own ? 'cotización tuya vence' : 'cotización vence', own ? 'cotizaciones tuyas vencen' : 'cotizaciones vencen')} esta semana`,
      detail: `La primera vence ${when}`,
      href: '/cotizaciones?status=EMITTED',
    });
  }
  if (src.productionQueue) {
    rows.push({
      key: 'queue',
      title: `${plural(src.productionQueue, 'orden espera', 'órdenes esperan')} producción`,
      href: '/planta',
    });
  }
  return rows;
}
