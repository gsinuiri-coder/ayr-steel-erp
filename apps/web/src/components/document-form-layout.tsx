import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/format';
import { FormGrid } from '@/components/form';

/**
 * D-284: el esqueleto común de los formularios de documento (cotización, pedido directo,
 * agregar ítems, comprobante). Todos con la misma forma, en este orden:
 *
 * 1. encabezado (`DocumentFormHeader`): título y una línea de ayuda;
 * 2. datos del documento (`DocumentSection`): grilla de **cuatro columnas** en escritorio, con
 *    el campo principal (cliente) en dos, y observaciones a lo ancho al final;
 * 3. líneas, con «Agregar línea» a la izquierda y los importes a la derecha (`DocumentTotals`);
 * 4. el pie (`DocumentActions`): Cancelar y la acción principal, siempre abajo a la derecha.
 *
 * Solo presentación: ningún componente de acá guarda estado ni decide nada del documento.
 */

export function DocumentFormHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h1 className="text-lg font-semibold">{title}</h1>
      {children && <p className="text-xs text-muted-foreground">{children}</p>}
    </div>
  );
}

/** La sección de datos: una región con nombre y la grilla de cuatro columnas. */
export function DocumentSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-lg border p-3">
      <h2 id={headingId} className="mb-3 text-sm font-medium">
        {title}
      </h2>
      {/* D-293: la grilla de 12 columnas del modelo de formularios (`components/form`). */}
      <FormGrid className={cn('gap-y-3', className)}>{children}</FormGrid>
    </section>
  );
}

/**
 * Las cuatro «columnas» de los formularios de documento, en la grilla de 12: 1 → 3, 2 → 6, 3 → 9,
 * 4 → 12. Las proporciones son las de siempre (D-284); lo que cambia es la base de 12, que es la
 * misma de todos los formularios (D-293).
 */
const SPAN = { 1: 'col-span-3', 2: 'col-span-6', 3: 'col-span-9', 4: 'col-span-12' } as const;

/**
 * Un campo de la grilla: rótulo arriba, control, y a lo sumo un renglón de ayuda debajo.
 *
 * D-293: el rótulo mide siempre 16 px y la celda reserva la altura de rótulo + control + un
 * renglón de ayuda (`min-h-[4.5rem]`), así que un texto debajo de un campo —o su ausencia— no
 * cambia dónde empieza el control del vecino. Todo va alineado arriba (`items-start`).
 */
export function FormField({
  span = 1,
  children,
  className,
}: {
  span?: keyof typeof SPAN;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="form-cell"
      className={cn(
        'flex min-h-[4.5rem] min-w-0 flex-col items-start gap-1',
        '[&>[data-slot=label]]:h-4 [&>[data-slot=label]]:leading-4',
        '[&>:not([data-slot=label])]:w-full',
        SPAN[span],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Los importes del documento, con el vocabulario de D-162, en una columna derecha. */
export function DocumentTotals({
  subtotal,
  igv,
  total,
  igvLabel = 'IGV (18%)',
}: {
  subtotal: string;
  igv: string;
  total: string;
  igvLabel?: string;
}) {
  return (
    <div className="ml-auto grid min-w-64 grid-cols-[1fr_auto] gap-x-8 gap-y-1 text-sm">
      <span className="text-muted-foreground">Valor de venta</span>
      <span className="text-right tabular-nums">{formatMoney(subtotal)}</span>
      <span className="text-muted-foreground">{igvLabel}</span>
      <span className="text-right tabular-nums">{formatMoney(igv)}</span>
      <span className="border-t pt-1 font-medium">Precio de venta</span>
      <span className="border-t pt-1 text-right text-base font-semibold tabular-nums">
        {formatMoney(total)}
      </span>
    </div>
  );
}

/** Debajo de las líneas: «Agregar línea» (u otra acción de líneas) a la izquierda, importes a la derecha. */
export function DocumentLinesFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-4">{children}</div>;
}

/** El pie del formulario: Cancelar y la acción principal, abajo a la derecha. */
export function DocumentActions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t pt-3">{children}</div>;
}
