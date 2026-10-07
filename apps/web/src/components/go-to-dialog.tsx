'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { filterGoTo, goToEntries, type GoToEntry } from '@/lib/go-to';
import { useSession } from '@/lib/session';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Lo provee el marco de la app (`AppFrame`): abre «Ir a». */
export const GoToContext = createContext<() => void>(() => undefined);

/** Abre «Ir a» (el botón del menú lateral lo usa). */
export function useOpenGoTo(): () => void {
  return useContext(GoToContext);
}

/** Ctrl K (o ⌘K) abre y cierra «Ir a» desde cualquier pantalla. */
export function useGoToShortcut(toggle: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [toggle]);
}

const SECTIONS: { kind: GoToEntry['kind']; title: string }[] = [
  { kind: 'screen', title: 'Pantallas' },
  { kind: 'create', title: 'Crear' },
];

/**
 * cc31: «Ir a» — pantallas y acciones de crear, filtradas por el rol. Se escribe, se mueve con
 * las flechas y Enter abre. No busca documentos por código: eso pediría un endpoint que hoy no
 * existe (ESPEC §2).
 */
export function GoToDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useSession();
  const entries = useMemo(() => goToEntries(user.role), [user.role]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const found = filterGoTo(entries, query);
    // Pantallas primero y después crear, como se dibujan.
    return SECTIONS.flatMap((s) => found.filter((e) => e.kind === s.kind));
  }, [entries, query]);

  function close() {
    onOpenChange(false);
    setQuery('');
    setActive(0);
  }

  /** Enter: el clic del enlace activo, para que pase por lo mismo que un clic con el mouse. */
  function goActive() {
    listRef.current?.querySelector<HTMLAnchorElement>(`[data-index="${String(active)}"]`)?.click();
  }

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Ir a</DialogTitle>
        <DialogDescription className="sr-only">
          Escribe el nombre de una pantalla o de lo que quieres crear.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="go-to-list"
            aria-activedescendant={results[active] ? `go-to-${String(active)}` : undefined}
            aria-label="Buscar pantalla o acción"
            placeholder="Ir a…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                goActive();
              }
            }}
          />
        </div>
        <div
          ref={listRef}
          id="go-to-list"
          role="listbox"
          aria-label="Resultados"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-muted-foreground">
              Nada coincide con «{query.trim()}».
            </p>
          )}
          {SECTIONS.map((section) => {
            const items = results
              .map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => entry.kind === section.kind);
            if (items.length === 0) return null;
            return (
              <div key={section.kind} role="group" aria-label={section.title}>
                <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {section.title}
                </p>
                {items.map(({ entry, index }) => (
                  // Un enlace de verdad y no un `router.push`: así el aviso de cambios sin guardar
                  // (D-455), que intercepta los clics en enlaces, también cubre «Ir a».
                  <Link
                    key={entry.href}
                    href={entry.href}
                    id={`go-to-${String(index)}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    tabIndex={-1}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5',
                      index === active && 'bg-accent text-accent-foreground',
                    )}
                    onMouseMove={() => {
                      setActive(index);
                    }}
                    onClick={close}
                  >
                    <entry.icon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{entry.title}</span>
                    {entry.group && (
                      <span className="text-xs text-muted-foreground">{entry.group}</span>
                    )}
                    {index === active && (
                      <kbd className="rounded border px-1 text-xs text-muted-foreground">Enter</kbd>
                    )}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            <kbd className="rounded border px-1">↑</kbd>{' '}
            <kbd className="rounded border px-1">↓</kbd> moverse
          </span>
          <span>
            <kbd className="rounded border px-1">Enter</kbd> abrir
          </span>
          <span>
            <kbd className="rounded border px-1">Esc</kbd> cerrar
          </span>
          <span className="ml-auto">Solo muestra lo que tu rol puede abrir</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
