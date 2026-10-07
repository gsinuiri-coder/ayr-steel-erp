import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SummaryItem {
  label: string;
  value: ReactNode;
  /** Una línea chica debajo del valor (el documento del cliente, el origen de una fecha…). */
  detail?: ReactNode;
}

/**
 * cc31: la franja de resumen de una página de detalle — una banda gris con cuatro o cinco datos
 * (con quién, fecha, uno o dos propios) y el total a la derecha. Reemplaza en los detalles de la
 * pieza a la tira de tarjetas (`StatStrip`), que sigue en compra, corte y producción.
 */
export function DetailSummary({ items, total }: { items: SummaryItem[]; total?: SummaryItem }) {
  return (
    <dl
      data-slot="detail-summary"
      className="flex flex-wrap items-start gap-x-8 gap-y-2 rounded-lg bg-muted px-4 py-2.5"
    >
      {items.map((item) => (
        <SummaryCell key={item.label} item={item} />
      ))}
      {total && <SummaryCell item={total} className="ml-auto text-right" strong />}
    </dl>
  );
}

function SummaryCell({
  item,
  className,
  strong = false,
}: {
  item: SummaryItem;
  className?: string;
  strong?: boolean;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{item.label}</dt>
      <dd className={cn('font-medium tabular-nums', strong && 'text-lg font-semibold')}>
        {item.value}
      </dd>
      {item.detail && <dd className="text-xs text-muted-foreground">{item.detail}</dd>}
    </div>
  );
}

/**
 * cc31: las etapas de un documento con recorrido (cotización, pedido). Las hechas llevan ✓, la
 * actual se marca y las siguientes quedan en gris. `current === null`: el documento salió del
 * recorrido (anulado) y ninguna etapa está en curso.
 */
export function Stages({ steps, current }: { steps: string[]; current: number | null }) {
  return (
    <ol aria-label="Etapas" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {steps.map((step, i) => {
        const done = current !== null && i < current;
        const active = current === i;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className="flex items-center gap-1"
          >
            {i > 0 && <span aria-hidden className="mx-1 h-px w-6 bg-border" />}
            <span
              aria-hidden
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-xs font-semibold',
                done && 'bg-tone-done text-tone-done-foreground',
                active && 'bg-primary text-primary-foreground',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                'text-xs',
                active ? 'font-semibold' : done ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {step}
              {done && <span className="sr-only"> (hecha)</span>}
              {active && <span className="sr-only"> (actual)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
