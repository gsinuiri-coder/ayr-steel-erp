'use client';

import Link from 'next/link';
import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { HeaderAction } from '@/components/header-actions';

/**
 * D-327 (correcciones 04): las acciones de **una fila** de una tabla. Una acción sola queda como
 * botón, igual que antes; con dos o más, una principal visible —la más frecuente de esa tabla— y
 * «⋯» con el resto. Las destructivas van al final del menú, separadas y en rojo (D-180), y siguen
 * pidiendo su diálogo de confirmación: este componente solo decide dónde vive cada botón.
 *
 * Es el hermano de `HeaderActions` (F8-S3b) para filas, y usa el mismo tipo de acción. El menú
 * lleva `aria-label` «Más acciones de <fila>» para que un lector de pantalla —y el E2E— distinga
 * el de una fila del de otra.
 */
export function RowActions({
  label,
  actions,
  primary,
}: {
  /** Cómo se llama la fila (su código o nombre), para el `aria-label` del menú. */
  label: string;
  actions: readonly HeaderAction[];
  /** Clave de la acción principal. Por defecto, la primera visible que no sea destructiva. */
  primary?: string;
}) {
  const visible = actions.filter((a) => a.show !== false);
  if (visible.length === 0) return null;
  const main =
    visible.find((a) => a.key === primary && !a.destructive) ??
    visible.find((a) => !a.destructive) ??
    null;
  const rest = visible.filter((a) => a !== main);
  const regular = rest.filter((a) => !a.destructive);
  const destructive = rest.filter((a) => a.destructive);
  // Una acción del menú en vuelo no tiene botón donde mostrar su «pendiente»: se dice al lado.
  const pendingSecondary = rest.find((a) => a.pending);

  return (
    <div data-slot="row-actions" className="flex items-center justify-end gap-1">
      {pendingSecondary && (
        <span role="status" className="text-xs text-muted-foreground">
          {pendingSecondary.pendingText ?? `${pendingSecondary.label}…`}
        </span>
      )}
      {main && <RowButton action={main} />}
      {rest.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Más acciones de ${label}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            {regular.map((a) => (
              <RowMenuItem key={a.key} action={a} />
            ))}
            {regular.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
            {destructive.map((a) => (
              <RowMenuItem key={a.key} action={a} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function RowButton({ action: a }: { action: HeaderAction }) {
  const variant = a.destructive ? 'destructive' : 'ghost';
  if (a.href !== undefined) {
    return (
      <Button variant={variant} size="sm" asChild>
        <Link href={a.href} aria-label={a.ariaLabel}>
          {a.label}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={a.disabled}
      pending={a.pending}
      pendingText={a.pendingText}
      title={a.title}
      aria-label={a.ariaLabel}
      onClick={() => {
        a.onSelect?.();
      }}
    >
      {a.label}
    </Button>
  );
}

function RowMenuItem({ action: a }: { action: HeaderAction }) {
  const variant = a.destructive ? 'destructive' : 'default';
  if (a.href !== undefined) {
    return (
      <DropdownMenuItem variant={variant} disabled={a.disabled} asChild>
        <Link href={a.href}>{a.label}</Link>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      variant={variant}
      disabled={a.disabled === true || a.pending === true}
      title={a.title}
      aria-label={a.ariaLabel}
      onSelect={() => {
        a.onSelect?.();
      }}
    >
      {a.label}
    </DropdownMenuItem>
  );
}
