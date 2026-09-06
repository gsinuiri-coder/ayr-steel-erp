'use client';

import { useCallback, useState } from 'react';
import { DEFAULT_PAGE_SIZE } from '@ayr/shared';

/**
 * Estado de paginación de una tabla server-side (Fase 7d, D-113): página 1-based y tamaño.
 *
 * `resetPage` vuelve a la página 1, y la vista la llama desde un `useEffect` que depende de
 * sus filtros (no del propio `resetPage`, que es estable gracias a `useCallback`): sin
 * volver a la página 1 al cambiar un filtro, una búsqueda nueva podía dejar la pantalla en
 * blanco si la página en la que estaba el usuario no existe en el resultado nuevo.
 */
export function usePagination(initialPageSize: number = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const resetPage = useCallback(() => {
    setPage(1);
  }, []);

  const changePageSize = useCallback((size: number) => {
    setPageSize(size);
    setPage(1);
  }, []);

  return { page, pageSize, setPage, setPageSize: changePageSize, resetPage };
}
