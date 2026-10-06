import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * cc27 (UX26-06/07, D-454): la barra de acciones de un formulario largo, **fija abajo**.
 *
 * A 1366×768 una cotización con dos líneas dejaba «Crear cotización» 158 px bajo el pliegue y un
 * despacho dejaba «Despachar» a 213 px: había que bajar para encontrar la acción principal y
 * para ver por qué estaba apagada. La barra se pega al borde inferior del área que scrollea
 * mientras el formulario siga a la vista; al final del formulario queda en su lugar de siempre.
 *
 * Se come el relleno lateral del contenedor de la página (`-mx-4 px-4`, el `p-4` del layout) para
 * que su fondo tape el contenido que pasa por debajo de borde a borde. `hint` va a la izquierda:
 * el motivo por el que la acción está apagada, o los totales.
 */
export function StickyActionBar({
  children,
  hint,
  className,
}: {
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="sticky-action-bar"
      className={cn(
        'sticky bottom-0 z-20 -mx-4 flex items-center justify-end gap-2 border-t bg-background px-4 py-3',
        className,
      )}
    >
      {hint !== undefined && (
        <div className="mr-auto min-w-0 text-sm text-muted-foreground">{hint}</div>
      )}
      {children}
    </div>
  );
}
