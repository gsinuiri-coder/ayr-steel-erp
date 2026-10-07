'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { crumbsFor } from '@/lib/breadcrumb';

const CrumbContext = createContext<{
  label: string | null;
  setLabel: (label: string | null) => void;
} | null>(null);

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  return <CrumbContext.Provider value={{ label, setLabel }}>{children}</CrumbContext.Provider>;
}

/**
 * cc31: el detalle le dice a la barra superior su código (`COT-000152`). Mientras carga, la ruta
 * muestra «…»; al salir de la pantalla, se borra.
 */
export function useCrumbLabel(label: string | null | undefined) {
  const ctx = useContext(CrumbContext);
  const setLabel = ctx?.setLabel;
  useEffect(() => {
    if (!setLabel) return;
    setLabel(label ?? null);
    return () => {
      setLabel(null);
    };
  }, [label, setLabel]);
}

/**
 * La forma de usar `useCrumbLabel` desde el JSX del detalle, que ya tiene el documento cargado
 * (sus hooks corren antes de saber si cargó). No dibuja nada.
 */
export function CrumbLabel({ label }: { label: string }) {
  useCrumbLabel(label);
  return null;
}

/** La ruta grupo / lista / documento de la barra superior. */
export function Breadcrumb() {
  const pathname = usePathname();
  const label = useContext(CrumbContext)?.label ?? null;
  const crumbs = crumbsFor(pathname);
  const parts: ReactNode[] = [];
  if (crumbs.group)
    parts.push(
      <span key="g" className="text-muted-foreground">
        {crumbs.group}
      </span>,
    );
  if (crumbs.list) {
    parts.push(
      crumbs.list.href ? (
        <Link
          key="l"
          href={crumbs.list.href}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {crumbs.list.title}
        </Link>
      ) : (
        <span key="l" aria-current="page" className="font-medium">
          {crumbs.list.title}
        </span>
      ),
    );
  }
  if (crumbs.leaf) {
    const text = crumbs.leaf === 'document' ? (label ?? '…') : crumbs.leaf.title;
    parts.push(
      <span
        key="d"
        aria-current="page"
        className={crumbs.leaf === 'document' ? 'font-mono font-medium' : 'font-medium'}
      >
        {text}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <nav aria-label="Ruta" className="flex min-w-0 items-center gap-1.5 truncate text-sm">
      {parts.flatMap((part, i) =>
        i === 0
          ? [part]
          : [
              <span key={`s${String(i)}`} aria-hidden className="text-muted-foreground/60">
                /
              </span>,
              part,
            ],
      )}
    </nav>
  );
}
