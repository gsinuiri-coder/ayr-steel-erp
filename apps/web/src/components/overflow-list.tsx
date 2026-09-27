'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, LINK_CLASSNAME } from '@/lib/utils';

/** Un elemento de la lista: con `href` es un enlace; `detail` va a la derecha, en gris. */
export interface OverflowItem {
  key: string;
  label: ReactNode;
  href: string | null;
  detail?: ReactNode;
}

/**
 * D-324: el resto de una lista que no cabe en la fila, en un popover «+N». Una lista larga hacía
 * crecer la fila y, con ella, el ancho de toda la página (scroll horizontal): el resto vive en
 * el popover y la fila queda del mismo tamaño con dos elementos o con cincuenta.
 *
 * Nació para las bobinas del historial de producción; Correcciones 05 lo reusa para los
 * comprobantes de un pedido y los despachos de un comprobante.
 */
export function OverflowPopover({
  items,
  triggerLabel,
  listTestId,
}: {
  items: readonly OverflowItem[];
  /** Nombre accesible del botón «+N» (p. ej. «Ver las 3 bobinas restantes»). */
  triggerLabel: string;
  listTestId?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={triggerLabel}
        className="ml-1 rounded-sm border px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        +{items.length}
      </PopoverTrigger>
      <PopoverContent className="max-h-72 w-auto min-w-48 overflow-y-auto">
        <ul className="grid gap-1 text-sm" data-testid={listTestId}>
          {items.map((item) => (
            <li key={item.key} className="flex items-baseline justify-between gap-4">
              {item.href ? (
                <Link href={item.href} className={LINK_CLASSNAME}>
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
              {item.detail !== undefined && item.detail !== null && (
                <span className="tabular-nums text-muted-foreground">{item.detail}</span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Los primeros `max` elementos como enlaces separados por coma y el resto en {@link OverflowPopover}.
 * Sin elementos, `empty` (por defecto «—» en gris).
 */
export function OverflowLinks({
  items,
  max = 1,
  triggerLabel,
  className,
  linkClassName = LINK_CLASSNAME,
  testId,
  empty,
}: {
  items: readonly OverflowItem[];
  max?: number;
  /** Nombre accesible del «+N», con la cantidad del resto. */
  triggerLabel: (rest: number) => string;
  className?: string;
  /** Clase de los enlaces visibles; por defecto la de todo enlace (`LINK_CLASSNAME`). */
  linkClassName?: string;
  testId?: string;
  empty?: ReactNode;
}) {
  if (items.length === 0) {
    return <>{empty ?? <span className="text-muted-foreground">—</span>}</>;
  }
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  return (
    <span className={cn('whitespace-nowrap', className)} data-testid={testId}>
      {shown.map((item, i) => (
        <span key={item.key}>
          {i > 0 && ', '}
          {item.href ? (
            <Link href={item.href} className={linkClassName}>
              {item.label}
            </Link>
          ) : (
            item.label
          )}
        </span>
      ))}
      {rest.length > 0 && <OverflowPopover items={rest} triggerLabel={triggerLabel(rest.length)} />}
    </span>
  );
}
