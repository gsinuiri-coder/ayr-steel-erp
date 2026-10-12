'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { listContainer, shouldCollapseLineTotals } from '@/lib/line-totals';
import { cn } from '@/lib/utils';

export interface LineTotalsFigure {
  label: string;
  value: string;
}

export interface LineTotalsItem {
  key: string;
  label: string;
  figures: readonly LineTotalsFigure[];
  /** El rótulo largo de la cifra, para el que no la entiende al vuelo (aparece al pasar). */
  title?: string;
  /** La fila del total general: en negrita. */
  strong?: boolean;
}

/** Alto de la franja plegada antes de medirla: una línea de 13 px con su relleno. */
const COLLAPSED_GUESS_PX = 30;

/**
 * cc48 (D-629): los totales por línea de un reporte, en **una sola franja compacta** con las líneas
 * una al lado de otra (antes, una tabla de una fila por línea debajo de la principal: a 1366×768 le
 * quitaba alto a la tabla). Si con la franja abierta la tabla queda por debajo de unos 360 px, la
 * franja se pliega en «Totales por línea ▸» y se abre con un clic. Plegar no cambia ninguna cifra.
 *
 * Mientras nadie la toque, decide sola según el alto que deja la ventana (y vuelve a decidir al
 * cambiar el tamaño); un clic manda sobre eso.
 */
export function LineTotalsStrip({
  items,
  testId = 'totales-por-linea',
}: {
  items: readonly LineTotalsItem[];
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [manual, setManual] = useState(false);
  const heights = useRef({ open: 0, closed: COLLAPSED_GUESS_PX });
  // El estado que se ve, para medir fuera del render (la decisión corre en un cuadro aparte).
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);
  // Cifras nuevas (otro periodo, una línea más) pueden cambiar el alto de la franja abierta:
  // vuelve a decidir con ellas.
  const signature = items
    .map((i) => `${i.key}:${i.figures.map((f) => f.value).join(',')}`)
    .join('|');

  useEffect(() => {
    if (manual) return;
    let frame = 0;
    const decide = () => {
      const el = ref.current;
      if (!el) return;
      const strip = el.getBoundingClientRect();
      const current = collapsedRef.current;
      if (current) heights.current.closed = strip.height;
      else heights.current.open = strip.height;
      const table = listContainer(document)?.getBoundingClientRect() ?? null;
      // Plegada, abrirla sumaría lo que la franja abierta ocupa de más.
      const extra = current ? Math.max(heights.current.open - heights.current.closed, 0) : 0;
      setCollapsed(
        table !== null &&
          shouldCollapseLineTotals({
            viewportHeight: window.innerHeight,
            tableTop: table.top + window.scrollY,
            belowWhenOpen: strip.bottom - table.bottom + extra,
          }),
      );
    };
    // Dos cuadros: el alto de la lista lo fija `useFillViewport` en el siguiente.
    // La franja va siempre debajo de la tabla: lo que hay entre las dos (y la franja) es lo que
    // le quita alto.
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(decide);
      });
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [manual, signature]);

  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      ref={ref}
      aria-labelledby={titleId}
      data-testid={testId}
      data-collapsed={collapsed ? 'true' : 'false'}
      className="min-w-0 rounded-md bg-muted px-2.5 py-1.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <h2 className="text-[13px] font-semibold">
          <button
            type="button"
            id={titleId}
            aria-expanded={!collapsed}
            aria-controls={listId}
            className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => {
              setManual(true);
              setCollapsed((c) => !c);
            }}
          >
            Totales por línea
            <Chevron aria-hidden className="size-3.5" />
          </button>
        </h2>
        <ul
          id={listId}
          hidden={collapsed}
          className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-xs tabular-nums"
        >
          {items.map((item) => (
            <li
              key={item.key}
              title={item.title}
              data-testid="total-de-linea"
              className={cn(
                'flex items-baseline gap-1.5 whitespace-nowrap',
                item.strong && 'font-semibold',
              )}
            >
              <span className={item.strong ? undefined : 'font-medium'}>{item.label}</span>
              <span className={item.strong ? undefined : 'text-muted-foreground'}>
                {item.figures.map((f, i) => (
                  <span key={`${String(i)}-${f.label}`}>
                    {i > 0 && ' · '}
                    {f.label === '' ? null : `${f.label} `}
                    <span className="text-foreground">{f.value}</span>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
