/**
 * cc26 (D-provisional): la URL del Excel de un listado.
 *
 * Sale de **los mismos parámetros** que la consulta de la lista, sin `page` ni `pageSize`: el
 * archivo trae todas las filas que cumplen los filtros y el orden que se ven en pantalla, no solo
 * la página. Construirla a partir de la consulta, y no aparte, es lo que impide que un filtro
 * nuevo de la lista se olvide en el Excel.
 *
 * `path` es la ruta de la lista en el API (`/invoicing/documents`); el Excel vive en `<path>/xlsx`
 * y se descarga por `/api` (D-068), con un `<a>` y no con `api()`, porque es un binario.
 */
export function listXlsxHref(path: string, listParams: URLSearchParams): string {
  const params = new URLSearchParams(listParams);
  params.delete('page');
  params.delete('pageSize');
  const query = params.toString();
  return `/api${path}/xlsx${query ? `?${query}` : ''}`;
}
