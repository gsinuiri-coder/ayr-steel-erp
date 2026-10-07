'use client';

import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * cc31 (ESPEC §6): un dato que le falta al formulario para poder guardarse. `target` es el `id`
 * del campo (o de su sección): el enlace lleva hasta él.
 */
export interface MissingField {
  label: string;
  target: string;
}

/** Lleva el foco al campo que falta (o al primero enfocable de su sección) y lo muestra. */
export function focusField(target: string): void {
  const el = document.getElementById(target);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const focusable = el.matches('input, select, textarea, button, [tabindex]')
    ? el
    : el.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  (focusable ?? el).focus({ preventScroll: true });
}

/** «Faltan 2 datos: ubigeo de llegada · placa», cada uno un enlace a su campo. */
export function MissingFieldsHint({
  missing,
  heading,
}: {
  missing: readonly MissingField[];
  /** cc31 (corte 6): otro encabezado que «Faltan N datos:», p. ej. «2 líneas por corregir:». */
  heading?: string;
}) {
  if (missing.length === 0) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-1.5 text-sm">
      <CircleAlert className="size-4 shrink-0 text-tone-warning-foreground" aria-hidden />
      <span className="font-medium text-foreground">
        {heading ??
          (missing.length === 1 ? 'Falta 1 dato:' : `Faltan ${String(missing.length)} datos:`)}
      </span>
      {missing.map((m, i) => (
        <span key={m.target + m.label}>
          <a
            href={`#${m.target}`}
            className="text-primary underline-offset-2 hover:underline"
            onClick={(e) => {
              e.preventDefault();
              focusField(m.target);
            }}
          >
            {m.label}
          </a>
          {i < missing.length - 1 && <span className="text-muted-foreground"> ·</span>}
        </span>
      ))}
    </p>
  );
}

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
 *
 * cc31: con `missing`, la izquierda dice qué falta con enlaces a cada campo (el botón principal ya
 * no se apaga por un dato faltante: al pulsarlo con faltantes, el formulario marca los campos).
 */
export function StickyActionBar({
  children,
  hint,
  missing,
  missingHeading,
  className,
}: {
  children: ReactNode;
  hint?: ReactNode;
  missing?: readonly MissingField[];
  /** cc31 (corte 6): ver `MissingFieldsHint.heading`. */
  missingHeading?: string;
  className?: string;
}) {
  const left =
    missing && missing.length > 0 ? (
      <MissingFieldsHint missing={missing} heading={missingHeading} />
    ) : (
      hint
    );
  return (
    <div
      data-slot="sticky-action-bar"
      className={cn(
        'sticky bottom-0 z-20 -mx-4 flex items-center justify-end gap-2 border-t bg-background px-4 py-3',
        className,
      )}
    >
      {left !== undefined && left !== null && (
        <div className="mr-auto min-w-0 text-sm text-muted-foreground">{left}</div>
      )}
      {children}
    </div>
  );
}
