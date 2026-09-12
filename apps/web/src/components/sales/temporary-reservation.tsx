'use client';

import type { TemporaryReservationLineDto } from '@ayr/shared';
import { formatQty, unitSymbol } from '@/lib/format';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * D-185: cuánto le queda a una reserva temporal, en palabras. Por hora cuando queda menos de
 * un día —es cuando importa—, por días de calendario el resto del tiempo.
 */
export function remainingLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return 'Vencida';
  if (ms < HOUR) return 'Menos de una hora';
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return `${String(hours)} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  const days = Math.floor(ms / DAY);
  return `${String(days)} ${days === 1 ? 'día' : 'días'}`;
}

/** Fecha y hora de vencimiento, en Lima. */
export function formatExpiry(expiresAt: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(expiresAt));
}

/** El material apartado, una línea por renglón: «L1 · Bobina 0.45 mm ROJO · 89.606 kg». */
export function TemporaryReservationLines({ lines }: { lines: TemporaryReservationLineDto[] }) {
  return (
    <ul className="grid gap-0.5 text-sm">
      {lines.map((l) => (
        <li key={l.id} className="tabular-nums">
          <span className="text-muted-foreground">L{l.lineNumber} · </span>
          {l.itemLabel} · {formatQty(l.qty, unitSymbol(l.unit))}
        </li>
      ))}
    </ul>
  );
}
