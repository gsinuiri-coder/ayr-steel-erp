'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * cc27 (UX26-10/33, D-456): una tabla más ancha que su contenedor scrollea **dentro** de él (la
 * página no, D-179), pero a 1366 px las columnas que quedaban fuera no se anunciaban: sin barra
 * a la vista, parecía que no había más. Con desborde, el contenedor muestra una sombra en el
 * borde que esconde columnas (`globals.css`) y entra en el orden del teclado como región con
 * nombre, para poder desplazarlo con las flechas (axe `scrollable-region-focusable`).
 */
function useHorizontalOverflow(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [overflow, setOverflow] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setOverflow(el.scrollWidth - el.clientWidth > 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return overflow;
}

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const overflow = useHorizontalOverflow(containerRef);
  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      data-overflow={overflow ? 'true' : undefined}
      className="relative w-full overflow-x-auto"
      // Un grupo y no una región: una región es un punto de referencia y varias con el mismo
      // nombre se repiten en la lista de landmarks (axe `landmark-unique`, segundo modelo SM-3).
      // Nombre fijo: la tabla ya anuncia el suyo.
      {...(overflow
        ? {
            tabIndex: 0,
            role: 'group',
            'aria-label': 'Desplazamiento horizontal: hay más columnas',
          }
        : {})}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom text-[13px] tabular-nums', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // Encabezado chico y atenuado: en una lista de captura el dato manda y el rótulo
        // de columna es andamiaje (S11, B1).
        'h-7 px-2.5 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'px-2.5 py-1 align-middle leading-snug whitespace-nowrap [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
