'use client';

import { useId, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * cc47 (D-615): la línea estándar encima de toda tabla del sitio, siempre en el mismo orden:
 *
 * 1. a la izquierda, primero, el buscar (`search`);
 * 2. después, el botón «Filtros» (`filters`, un `FiltersDialog`), que abre un modal con todos los
 *    filtros de la tabla, incluido el periodo; sin filtros, no hay botón;
 * 3. lo que informa sin ser filtro (`status`: el periodo elegido, «Actualizando…»);
 * 4. a la derecha, lo que no es filtro (`aside`): «Ver por». Las descargas van a «Más opciones» de
 *    la cabecera (cc47b, D-623).
 *
 * Los filtros y el buscar siguen en la URL como antes (D-289): este componente solo los ordena.
 */
export function TableToolbar({
  search,
  filters,
  status,
  aside,
  className,
  testId = 'linea-tabla',
}: {
  search?: ReactNode;
  filters?: ReactNode;
  status?: ReactNode;
  aside?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}
      data-testid={testId}
    >
      {search}
      {filters}
      {status}
      {aside && <div className="ml-auto flex flex-wrap items-center gap-2">{aside}</div>}
    </div>
  );
}

/** cc47 (D-615): el buscar de la línea estándar, igual en todas las tablas. */
export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** El nombre accesible («Buscar en el reporte», «Buscar comprobantes»). */
  label: string;
  className?: string;
}) {
  return (
    <Input
      type="search"
      aria-label={label}
      placeholder={placeholder}
      className={cn('h-8 w-72 max-w-full', className)}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    />
  );
}

/**
 * cc47 (D-615): el botón «Filtros» y su modal, con **todos** los filtros de una tabla.
 *
 * Lo que se elige en el modal es un borrador: la tabla no cambia hasta «Aplicar», que escribe todo
 * de una vez en la URL (`onApply`). «Limpiar» vuelve a los valores sin filtro (`empty`), lo aplica y
 * cierra. Cerrar sin aplicar (Esc, la ✕ o un clic afuera) descarta el borrador. El botón dice
 * cuántos filtros están activos.
 *
 * `validate` devuelve el mensaje que impide aplicar (p. ej. un periodo con la fecha de inicio
 * posterior a la de fin), o `null`.
 */
export function FiltersDialog<D>({
  value,
  empty,
  activeCount,
  onApply,
  validate,
  description = 'Elige los filtros y pulsa «Aplicar». «Limpiar» los quita todos.',
  children,
}: {
  value: D;
  empty: D;
  activeCount: number;
  onApply: (next: D) => void;
  validate?: (draft: D) => string | null;
  description?: string;
  children: (draft: D, update: (patch: Partial<D>) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [tried, setTried] = useState(false);
  const errorId = useId();
  const error = validate?.(draft) ?? null;

  const label =
    activeCount === 0
      ? 'Filtros'
      : `Filtros, ${String(activeCount)} ${activeCount === 1 ? 'activo' : 'activos'}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Cada apertura parte de lo aplicado: un borrador cerrado sin aplicar se descarta.
        if (next) {
          setDraft(value);
          setTried(false);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={label}
          data-testid="boton-filtros"
        >
          <SlidersHorizontal aria-hidden />
          Filtros
          {activeCount > 0 && (
            <span
              aria-hidden
              className="ml-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums"
            >
              {activeCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" data-testid="modal-filtros">
        <form
          className="grid gap-4"
          aria-describedby={tried && error ? errorId : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (error !== null) return;
            if (!sameValues(draft, value)) onApply(draft);
            setOpen(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Filtros</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {children(draft, (patch) => {
              setDraft((current) => ({ ...current, ...patch }));
            })}
          </div>
          {tried && error !== null && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!sameValues(empty, value)) onApply(empty);
                setOpen(false);
              }}
            >
              Limpiar
            </Button>
            <Button type="submit">Aplicar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dos juegos de filtros iguales, campo por campo (los filtros son valores simples o planos). Aplicar
 * lo mismo que ya está no escribe la URL: cualquier escritura vuelve a la página 1.
 */
function sameValues<D>(a: D, b: D): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** cc47 (D-615): un campo del modal de filtros, con su rótulo arriba. */
export function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  /** El id del control, si es uno solo; sin él, el rótulo nombra al grupo. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const groupId = useId();
  if (htmlFor !== undefined) {
    return (
      <div className="grid gap-1.5">
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {children}
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby={groupId} className="grid gap-1.5">
      <span id={groupId} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
