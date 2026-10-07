'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';

/** cc31: el marco de «No encontramos esa página» y «Esta pantalla tuvo un problema». */
export function ScreenMessage({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-2.5 rounded-xl border bg-card px-6 py-10 text-center">
        <BrandMark className="size-9" />
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
        <div className="flex flex-wrap justify-center gap-2 pt-1.5">{actions}</div>
      </div>
    </div>
  );
}

/**
 * cc31: lo que se ve cuando una pantalla falla al dibujarse (antes, «Application error» en
 * inglés). La referencia es el `digest` que Next le pone al error del servidor, o una propia si
 * el error fue del navegador: con ella y la hora, el administrador lo encuentra en los registros.
 */
export function ErrorScreen({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Se fija al montar: un nuevo render no cambia la referencia que el usuario ya anotó.
  const [fallbackReference] = useState(() => Date.now().toString(36).slice(-8));
  const reference = error.digest ?? fallbackReference;
  const [at] = useState(() => formatDateTime(new Date().toISOString()));
  return (
    <ScreenMessage
      title="Esta pantalla tuvo un problema"
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link href="/">Ir al Panel</Link>
          </Button>
          <Button size="sm" onClick={reset}>
            Volver a cargar
          </Button>
        </>
      }
    >
      <p className="max-w-sm text-muted-foreground">
        Tus datos guardados están bien. Vuelve a cargar; si se repite, avisa al administrador con
        esta referencia.
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        Ref. {reference} · {at}
      </p>
    </ScreenMessage>
  );
}
