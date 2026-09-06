import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * El envoltorio de siempre para una tabla (`rounded-lg border`), con el scroll **adentro**
 * en vez de en la página entera (Fase 7d).
 *
 * En una laptop de 13" (~768px de alto) una tabla de cincuenta filas empujaba el pie de
 * página fuera de la pantalla y obligaba a scrollear la vista completa para llegar al
 * siguiente filtro o al botón de "Nuevo". Con el scroll contenido acá, el encabezado queda
 * fijo (`sticky` en el propio `<TableHeader>` de cada vista) y el resto del layout — título,
 * filtros, paginación — se ve siempre sin moverse.
 *
 * Una tabla más corta que el alto máximo no se ve distinta a como se veía antes: el límite
 * solo actúa cuando hace falta.
 */
export function TableScrollArea({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('max-h-[55vh] overflow-y-auto rounded-lg border', className)}>
      {children}
    </div>
  );
}
