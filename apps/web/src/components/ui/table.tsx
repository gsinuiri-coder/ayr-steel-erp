'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

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

/** Alto mínimo de las filas de una lista: con una ventana muy baja, la página vuelve a desplazarse. */
const LIST_MIN_HEIGHT_PX = 240;
const LIST_TABLE_SELECTOR = "[data-slot='table'][data-density='list']";

/**
 * cc35 (ESPEC §5): **una lista tiene una sola barra.** El alto de la tabla es el que deja libre la
 * ventana: lo de arriba (título, filtros) y lo de abajo (paginación, márgenes) quedan fijos y la
 * página no se desplaza; solo las filas. El alto máximo fijo de cc31 (`100svh − 13rem`) no sabía
 * cuánto ocupaban los filtros de cada lista, y con filtros en dos renglones la página también
 * scrolleaba: dos barras.
 *
 * Se mide sin tope (alto natural) y se fija lo que entra, en el mismo cuadro: no hay parpadeo, y
 * la posición del desplazamiento se conserva (quitar el tope la ponía en cero). Se vuelve a medir
 * cuando cambia el tamaño de la ventana, de la tabla o de la página.
 *
 * D-547: con **dos o más listas** en la misma pantalla (inventario valorizado, por ejemplo) no se
 * reparte la ventana: las tablas crecen y se desplaza la página, como en un detalle.
 */
function useFillViewport(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean): void {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let frame = 0;
    const fit = () => {
      if (document.querySelectorAll(LIST_TABLE_SELECTOR).length > 1) {
        el.style.maxHeight = 'none';
        return;
      }
      const scrollTop = el.scrollTop;
      el.style.maxHeight = 'none';
      const doc = document.scrollingElement ?? document.documentElement;
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      // Lo que la página tiene debajo de la tabla (paginación, el margen del marco).
      const below = doc.scrollHeight - (rect.bottom + window.scrollY);
      const room = Math.floor(doc.clientHeight - top - Math.max(below, 0));
      el.style.maxHeight = `${String(Math.max(room, LIST_MIN_HEIGHT_PX))}px`;
      el.scrollTop = scrollTop;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fit();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      el.style.maxHeight = '';
    };
  }, [ref, enabled]);
}

function Table({
  className,
  list = false,
  ...props
}: React.ComponentProps<'table'> & {
  /**
   * cc31: tabla de una pantalla de lista. Filas de 38 px y la cabecera fija de verdad: el
   * contenedor que hace scroll horizontal (cc27) también era el contenedor del `sticky`, y como no
   * scrolleaba en vertical la cabecera se iba con la página. Con su propio alto, la tabla scrollea
   * adentro y la cabecera y el pie quedan a la vista. cc35: ese alto es el que deja la ventana
   * (`useFillViewport`), así que la página no se desplaza.
   */
  list?: boolean;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const overflow = useHorizontalOverflow(containerRef);
  useFillViewport(containerRef, list);
  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      data-overflow={overflow ? 'true' : undefined}
      className={cn(
        'relative w-full overflow-x-auto',
        // Antes de medir (primer pintado del servidor), el alto de cc31.
        list && 'max-h-[calc(100svh-13rem)] overflow-y-auto',
      )}
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
        data-density={list ? 'list' : undefined}
        className={cn('w-full caption-bottom text-[13px] tabular-nums', className)}
        {...props}
      />
      {!list && overflow && <StickyHorizontalScroll target={containerRef} />}
    </div>
  );
}

/**
 * cc35 (ESPEC §5): en una tabla más ancha que la pantalla dentro de un detalle (la página crece y
 * se desplaza), la barra horizontal propia queda al pie de la tabla, fuera de la vista mientras se
 * lee el principio. Esta barra la repite **fija al pie de la ventana**, con el ancho y la posición
 * de la tabla y sincronizada con ella, y solo mientras el pie de la tabla queda por debajo de la
 * ventana. Es `fixed`: no ocupa lugar en el flujo de la página. En una lista no hace falta: la
 * tabla ya cabe en la ventana y su barra se ve.
 */
function StickyHorizontalScroll({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<Box | null>(null);
  React.useEffect(() => {
    const el = target.current;
    // Dentro de un diálogo o una hoja lateral la ventana no es la referencia: no se repite.
    if (!el || el.closest('[role="dialog"]')) return;
    let frame = 0;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Una barra de acciones fija al pie (formularios, cc31) queda debajo de esta.
      const actions = document.querySelector('[data-slot="sticky-action-bar"]');
      const bottom = actions
        ? Math.max(window.innerHeight - actions.getBoundingClientRect().top, 0)
        : 0;
      const edge = window.innerHeight - bottom;
      const next =
        rect.top < edge - 24 && rect.bottom > edge
          ? { left: rect.left, width: rect.width, inner: el.scrollWidth, bottom }
          : null;
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const fromTable = () => {
      const bar = barRef.current;
      if (bar && bar.scrollLeft !== el.scrollLeft) bar.scrollLeft = el.scrollLeft;
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    el.addEventListener('scroll', fromTable, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      el.removeEventListener('scroll', fromTable);
    };
  }, [target]);
  React.useLayoutEffect(() => {
    const el = target.current;
    const bar = barRef.current;
    if (box !== null && el && bar) bar.scrollLeft = el.scrollLeft;
  }, [box, target]);
  if (box === null) return null;
  return createPortal(
    <div
      ref={barRef}
      data-slot="table-sticky-scroll"
      aria-hidden="true"
      tabIndex={-1}
      className="fixed z-20 overflow-x-auto bg-background/90"
      style={{ left: box.left, width: box.width, bottom: box.bottom }}
      onScroll={(e) => {
        const el = target.current;
        if (el && el.scrollLeft !== e.currentTarget.scrollLeft) {
          el.scrollLeft = e.currentTarget.scrollLeft;
        }
      }}
    >
      <div style={{ width: box.inner, height: 1 }} />
    </div>,
    document.body,
  );
}

interface Box {
  left: number;
  width: number;
  inner: number;
  bottom: number;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.width === b.width && a.inner === b.inner && a.bottom === b.bottom;
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
        'px-2.5 py-1 align-middle leading-snug tabular-nums whitespace-nowrap [&:has([role=checkbox])]:pr-0',
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
