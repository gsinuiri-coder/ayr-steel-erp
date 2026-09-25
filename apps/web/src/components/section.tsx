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
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** La línea que la separa de lo de arriba. `false` para secciones lado a lado (una grilla). */
  separated?: boolean;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="section"
      className={cn('grid content-start gap-1', className)}
    >
      {separated && <Separator className="mb-1" />}
      <div className="flex min-h-7 items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1">
        <h2 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
