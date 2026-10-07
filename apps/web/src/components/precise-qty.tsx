import { formatKgPrecise, formatQty } from '@/lib/format';

/**
 * cc31: kilos con sus 3 decimales y la parte decimal en gris, para el kardex y el detalle de
 * bobina, donde el gramo es dato. El gris deja leer primero los kilos enteros sin esconder el
 * resto. Cualquier otra unidad se muestra como en el resto de la app.
 */
export function PreciseQty({ value, unit = 'kg' }: { value: string; unit?: string }) {
  if (unit !== 'kg') return <>{formatQty(value, unit)}</>;
  const text = formatKgPrecise(value, null);
  const dot = text.indexOf('.');
  return (
    <span className="tabular-nums">
      {text.slice(0, dot)}
      <span className="text-muted-foreground">{text.slice(dot)}</span> kg
    </span>
  );
}
