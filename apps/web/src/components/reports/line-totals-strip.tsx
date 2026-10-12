'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { listRoomPx, shouldCollapseLineTotals } from '@/lib/line-totals';
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

  useEffect(() => {
    if (manual) return;
    let frame = 0;
    const decide = () => {
      const el = ref.current;
      if (!el) return;
      const h = el.getBoundingClientRect().height;
      setCollapsed((current) => {
        if (current) heights.current.closed = h;
        else heights.current.open = h;
        const extra = heights.current.open - heights.current.closed;
        return shouldCollapseLineTotals(listRoomPx(document), current, extra);
      });
    };
    // Dos cuadros: el alto de la lista lo fija `useFillViewport` en el siguiente.
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(decide);
      });
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [manual]);

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
