'use client';

import type { MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { errorMessage, toast } from '@/lib/notify';

import { downloadFile } from '@/lib/download';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * F8-S3b/M3 — el patrón único de acciones de cabecera: **un** botón principal y un menú («Más
 * opciones» desde cc31) con
 * las secundarias.
 *
 * Una vista de detalle llegaba a tener seis u ocho botones del mismo peso en fila (cotización,
 * pedido, comprobante, bobina): la acción que el flujo usa todos los días quedaba al lado de
 * «Anular» y había que leerlos todos para encontrarla. Acá la vista declara sus acciones —con
 * `show` para las que dependen del estado o del rol— y en `primary` la lista de candidatas a
 * principal, en orden: la principal es la **primera visible**, porque la acción dominante
 * cambia con el estado (una cotización emitida se confirma; una ya confirmada, no).
 *
 * Sin ninguna candidata visible no se inventa una principal: queda solo el menú. Las
 * destructivas van al final del menú, separadas y en rojo, siempre como secundarias.
 *
 * **Una sola excepción, `companion`**: D-153 pide que los dos terminales de un borrador de
 * comprobante —emitir por el PSE o registrar manual— estén **los dos siempre a la vista**,
 * porque esconder uno detrás de un menú deja pasar inadvertido el descuido de usar el otro.
 * La compañera se dibuja como botón secundario al lado de la principal; nada más la usa.
 */

export interface HeaderAction {
  key: string;
  label: string;
  /** La acción existe en este estado y para este rol. Por defecto, sí. */
  show?: boolean;
  /** Navegación dentro de la app. */
  href?: string;
  /**
   * Descarga directa contra el API (`/api/...`, D-068): un `<a>` y no un `Link`, porque el
   * destino es un binario y no una ruta de Next.
   */
  download?: string;
  onSelect?: () => void;
  disabled?: boolean;
  pending?: boolean;
  pendingText?: string;
  destructive?: boolean;
  /** Aviso nativo (`title`) para cuando `disabled` viene de una razón que conviene explicar. */
  title?: string;
  /**
   * Nombre accesible cuando el texto visible no alcanza: en una tabla, «Precio» no dice de qué
   * línea (`RowActions`, D-327).
   */
  ariaLabel?: string;
}

export function HeaderActions({
  actions,
  primary,
  primaryFooter,
  companion,
}: {
  actions: readonly HeaderAction[];
  /** Claves candidatas a principal, en orden de preferencia. */
  primary: readonly string[];
  /** Algo que acompaña a la principal debajo, p. ej. su fecha de operación (D-124). */
  primaryFooter?: ReactNode;
  /** Solo D-153: una clave que se muestra como botón al lado de la principal. */
  companion?: string;
}) {
  const visible = actions.filter((a) => a.show !== false);
  const primaryKey = primary.find((k) => visible.some((a) => a.key === k && !a.destructive));
  const main = visible.find((a) => a.key === primaryKey) ?? null;
  const beside = main === null ? null : (visible.find((a) => a.key === companion) ?? null);
  const rest = visible.filter((a) => a !== main && a !== beside);
  const regular = rest.filter((a) => !a.destructive);
  const destructive = rest.filter((a) => a.destructive);
  const pendingSecondary = rest.find((a) => a.pending);

  if (visible.length === 0) return null;

  return (
    // cc31: siempre en este orden —«Más opciones», la compañera (D-153) y el botón principal al
    // final—, para que la acción del día quede en el mismo lugar en toda pantalla.
    <div data-slot="header-actions" className="flex flex-wrap items-start gap-2">
      {pendingSecondary && (
        <span role="status" className="self-center text-sm text-muted-foreground">
          {pendingSecondary.pendingText ?? `${pendingSecondary.label}…`}
        </span>
      )}
      {rest.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Más opciones
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-48">
            {regular.map((a) => (
              <MenuAction key={a.key} action={a} />
            ))}
            {regular.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
            {destructive.map((a) => (
              <MenuAction key={a.key} action={a} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {beside && <PrimaryButton action={beside} variant="outline" />}
      {main && (
        <div className="grid justify-items-end gap-1">
          <PrimaryButton action={main} />
          {primaryFooter}
        </div>
      )}
    </div>
  );
}

/**
 * cc28 (D-446): el clic normal en una descarga va por `fetch` (`downloadFile`), así un rechazo
 * del API —el 400 del tope del Excel, un 403— sale en un aviso con su mensaje en vez de abrirse
 * como JSON. El enlace sigue siendo un enlace: con una tecla o el botón del medio, el navegador
 * hace lo suyo.
 */
function onDownloadClick(e: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  downloadFile(href).catch((err: unknown) => {
    toast.error(errorMessage(err, 'No se pudo descargar el archivo'));
  });
}

function PrimaryButton({
  action: a,
  variant = 'default',
}: {
  action: HeaderAction;
  variant?: 'default' | 'outline';
}) {
  if (a.href !== undefined || a.download !== undefined) {
    return (
      <Button variant={variant} asChild>
        {a.href !== undefined ? (
          <Link href={a.href}>{a.label}</Link>
        ) : (
          <a
            href={a.download}
            onClick={(e) => {
              if (a.download !== undefined) onDownloadClick(e, a.download);
            }}
          >
            {a.label}
          </a>
        )}
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      disabled={a.disabled}
      pending={a.pending}
      pendingText={a.pendingText}
      title={a.title}
      onClick={() => {
        a.onSelect?.();
      }}
    >
      {a.label}
    </Button>
  );
}

function MenuAction({ action: a }: { action: HeaderAction }) {
  const variant = a.destructive ? 'destructive' : 'default';
  if (a.href !== undefined) {
    return (
      <DropdownMenuItem variant={variant} disabled={a.disabled} asChild>
        <Link href={a.href}>{a.label}</Link>
      </DropdownMenuItem>
    );
  }
  if (a.download !== undefined) {
    return (
      <DropdownMenuItem variant={variant} disabled={a.disabled} asChild>
        <a
          href={a.download}
          onClick={(e) => {
            if (a.download !== undefined) onDownloadClick(e, a.download);
          }}
        >
          {a.label}
        </a>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      variant={variant}
      disabled={a.disabled === true || a.pending === true}
      title={a.title}
      onSelect={() => {
        a.onSelect?.();
      }}
    >
      {a.label}
    </DropdownMenuItem>
  );
}
