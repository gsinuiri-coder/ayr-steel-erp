'use client';

import { useEffect, useRef } from 'react';

/** El texto del aviso: dice qué se pierde y qué hace cada botón del navegador. */
export const UNSAVED_CHANGES_MESSAGE =
  'Tienes cambios sin guardar en este formulario. Si sales ahora, se pierden. ¿Salir igual?';

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
 *   a apilar.
 *
 * No avisa al navegar por código (`router.push` tras guardar bien): esa salida no pasa por un
 * clic en un enlace ni por «atrás». Tampoco aplica a filtros ni a diálogos cortos: lo decide
 * quien lo usa, con `dirty`.
 */
export function useUnsavedChanges(dirty: boolean): void {
  /** Ya se apiló la entrada centinela de «atrás» (una sola por montaje). */
  const sentinel = useRef(false);
  /** El usuario ya aceptó salir: no se vuelve a preguntar en la misma salida. */
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    leaving.current = false;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      // El texto lo pone el navegador; `preventDefault` basta para que pregunte.
      e.preventDefault();
    };

    const onClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0) return;
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
        leaving.current = true;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPopState = () => {
      if (leaving.current) return;
      if (window.confirm(UNSAVED_CHANGES_MESSAGE)) {
        leaving.current = true;
        sentinel.current = false;
        window.history.back();
        return;
      }
      window.history.pushState(window.history.state, '', window.location.href);
    };

    if (!sentinel.current) {
      // El estado de Next viaja con la centinela: sin él, su manejador de `popstate` recarga la
      // página en vez de quedarse en la misma pantalla.
      window.history.pushState(window.history.state, '', window.location.href);
      sentinel.current = true;
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [dirty]);
}
