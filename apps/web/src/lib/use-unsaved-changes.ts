'use client';

import { useEffect } from 'react';

/** El texto del aviso: dice qué se pierde y qué hace cada botón del navegador. */
export const UNSAVED_CHANGES_MESSAGE =
  'Tienes cambios sin guardar en este formulario. Si sales ahora, se pierden. ¿Salir igual?';

/** La marca de la entrada centinela en `history.state`, junto al estado de Next. */
const SENTINEL_KEY = '__ayrUnsavedSentinel';

/**
 * La URL de una centinela que ya no protege nada (el formulario quedó limpio, se guardó o se
 * desmontó). Una entrada del historial no se puede borrar; lo que se hace es saltarla: el
 * «atrás» que cae en la entrada de debajo de ella, con la misma URL, sigue de largo una vez más.
 * Sin esto, después de editar un SKU o de guardar una cotización el primer «atrás» no hacía nada
 * visible (autorrevisión A-1, segundo modelo SM-2).
 */
let inertSentinelHref: string | null = null;
let skipperInstalled = false;

function isSentinel(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[SENTINEL_KEY] === true
  );
}

function pushSentinel(): void {
  const state: unknown = window.history.state;
  // El estado de Next viaja con la centinela: sin él, su manejador de `popstate` recarga la
  // página en vez de quedarse en la misma pantalla.
  window.history.pushState(
    { ...(typeof state === 'object' && state !== null ? state : {}), [SENTINEL_KEY]: true },
    '',
    window.location.href,
  );
}

function installSkipper(): void {
  if (skipperInstalled) return;
  skipperInstalled = true;
  window.addEventListener('popstate', () => {
    if (inertSentinelHref === null) return;
    if (!isSentinel(window.history.state) && window.location.href === inertSentinelHref) {
      inertSentinelHref = null;
      window.history.back();
    }
  });
}

/**
 * cc27 (UX26-13, D-455): avisar antes de salir de un formulario largo con cambios sin guardar.
 *
 * Mientras `dirty` es `true` cubre las tres salidas:
 *
 * - **cerrar o refrescar la pestaña** (o ir a otra URL): `beforeunload`, el aviso del navegador;
 * - **un enlace interno** (el menú, un vínculo de la página): se intercepta el clic en fase de
 *   captura, antes de que el `Link` de Next navegue, y se pregunta con `window.confirm`;
 * - **atrás** del navegador (o un «Cancelar» que hace `router.back()`): el App Router no tiene
 *   cómo bloquear una navegación, así que al ensuciarse el formulario se apila una entrada
 *   centinela con la misma URL y el mismo estado de Next. «Atrás» consume la centinela —la
 *   pantalla no cambia— y ahí se pregunta: si se sale, se retrocede de verdad; si no, se vuelve
 *   a apilar. Cuando el formulario queda limpio, la centinela pasa a inerte y se salta sola.
 *
 * No avisa al navegar por código (`router.push` tras guardar bien): esa salida no pasa por un
 * clic en un enlace ni por «atrás». Tampoco aplica a filtros ni a diálogos cortos: lo decide
 * quien lo usa, con `dirty`.
 */
export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    installSkipper();
    let leaving = false;

    // La centinela de esta pantalla: se reusa si seguimos parados en ella (el formulario se
    // volvió a ensuciar sin salir); si no, se apila una nueva.
    if (isSentinel(window.history.state) && inertSentinelHref === window.location.href) {
      inertSentinelHref = null;
    } else {
      inertSentinelHref = null;
      pushSentinel();
    }
    const href = window.location.href;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving) return;
      // El texto lo pone el navegador; `preventDefault` basta para que pregunte.
      e.preventDefault();
    };

    const onClick = (e: MouseEvent) => {
      if (leaving || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      // Otro sitio: lo cubre `beforeunload`. Una descarga del API no sale de la página.
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      if (window.confirm(UNSAVED_CHANGES_MESSAGE)) {
        leaving = true;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPopState = () => {
      if (leaving) return;
      if (window.confirm(UNSAVED_CHANGES_MESSAGE)) {
        leaving = true;
        window.history.back();
        return;
      }
      pushSentinel();
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      // Sin salida en curso, la centinela deja de proteger y se salta en el próximo «atrás».
      if (!leaving) inertSentinelHref = href;
    };
  }, [dirty]);
}
