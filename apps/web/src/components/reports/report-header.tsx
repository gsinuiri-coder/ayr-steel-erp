'use client';

import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LINK_CLASSNAME, cn } from '@/lib/utils';

/**
 * cc32: la cabecera de un reporte — título, un subtítulo de una línea con «Cómo se calcula» y,
 * a la derecha, las acciones (`HeaderActions`, con «Descargar Excel» como principal donde el API
 * entrega el archivo). La ruta «Reportes / nombre» la pone la barra superior (`crumbsFor`).
 */
export function ReportHeader({
  title,
  subtitle,
  howItWorks,
  actions,
}: {
  title: string;
  subtitle: string;
  /** La explicación larga: cómo se calcula, cuadres y salvedades. Ningún texto se pierde. */
  howItWorks?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {subtitle}
          {howItWorks && (
            <>
              {' '}
              <HowItWorks>{howItWorks}</HowItWorks>
            </>
          )}
        </p>
      </div>
      {actions}
    </div>
  );
}

/** «Cómo se calcula»: un enlace que abre la explicación en un panel flotante. */
export function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          LINK_CLASSNAME,
          'rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
        )}
      >
        Cómo se calcula
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[70svh] w-[min(36rem,calc(100vw-2rem))] space-y-2 overflow-y-auto text-[13px] leading-relaxed"
        data-testid="como-se-calcula"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
