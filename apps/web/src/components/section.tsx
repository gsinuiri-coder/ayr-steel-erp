'use client';

import { useId, type ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/**
 * D-294: la sección de una pantalla de detalle. Antes cada bloque era una caja con borde (una
 * `Card`, o un `<section>` con la tabla dentro de otra caja con borde) y una pantalla de detalle
 * terminaba con seis marcos uno junto al otro, todos con el mismo peso: nada mandaba sobre nada.
 *
 * Ahora es una **cabecera** —título de 13 px en negrita y, a la derecha, una acción opcional— sobre
 * un fondo suave (`bg-muted/40`), y el **cuerpo sin borde** debajo. Lo que separa una sección de
 * la anterior es una línea (`Separator`); el marco queda para lo que de verdad es un elemento
 * independiente (una `Card`: un aviso de negocio, una tarjeta de dato propia).
 */
export function Section({
  title,
  action,
  children,
  className,
  bodyClassName,
  separated = true,
  count,
  summary,
  empty,
}: {
  title: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** La línea que la separa de lo de arriba. `false` para secciones lado a lado (una grilla). */
  separated?: boolean;
  /** cc31: cuántas filas tiene la sección; se muestra al lado del título (también el 0). */
  count?: number;
  /** cc31: un resumen corto de la sección («2 en curso · 1,241.69 kg»). */
  summary?: ReactNode;
  /**
   * cc31: la línea que dice qué falta cuando la sección está vacía (`count === 0`). Con ella la
   * sección se muestra igual, con su contador en 0, en vez de desaparecer.
   */
  empty?: ReactNode;
}) {
  const headingId = useId();
  const isEmpty = count === 0 && empty !== undefined;
  return (
    <section
      aria-labelledby={headingId}
      data-slot="section"
      // cc31: las secciones con contador son las de la plantilla de detalle; solo ellas llevan
      // filas de 34 px (globals.css), no las de pantallas fuera de la pieza.
      data-counted={count !== undefined ? '' : undefined}
      className={cn('grid content-start gap-1', className)}
    >
      {separated && <Separator className="mb-1" />}
      {/* cc31: banda gris sólida con título, contador, resumen y la acción de la sección. */}
      <div className="flex min-h-8 items-center gap-2 rounded-md bg-muted px-2.5 py-1">
        <h2 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold">
          {title}
        </h2>
        {count !== undefined && (
          <span className="rounded-full bg-background px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            {count}
            <span className="sr-only"> {count === 1 ? 'fila' : 'filas'}</span>
          </span>
        )}
        {summary && <span className="truncate text-xs text-muted-foreground">{summary}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {isEmpty ? (
        <p className="px-2.5 py-2 text-muted-foreground">{empty}</p>
      ) : (
        <div className={bodyClassName}>{children}</div>
      )}
    </section>
  );
}
