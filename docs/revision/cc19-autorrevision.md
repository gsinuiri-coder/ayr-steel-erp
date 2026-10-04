# cc19 — Autorrevisión (D-387)

> **Autorrevisión — no vale como pase cruzado.** La hizo un subagente nuevo que no leyó el
> handoff ni `docs/PROGRESO.md` de la sesión. Es una lista de riesgos, no una aprobación.

- Diff revisado: `9d88277..HEAD` (rama `cc19/comprobante-en-cotizaciones`, commits `57dddcd`,
  `051616b`).
- Corrido por el revisor: `npx jest src/sales/imported-invoice-d387.spec.ts
src/common/search-seq.spec.ts src/common/list-orderings.spec.ts` → 3 suites, 89 tests en verde;
  `tsc --noEmit` en `apps/api` y `apps/web` sin errores. No se corrió Playwright, `next build` ni
  `dev` (por indicación).

## Resumen

| Sev | #   | Hallazgo                                                                                                                                                              |
| --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | 0   | —                                                                                                                                                                     |
| P1  | 0   | —                                                                                                                                                                     |
| P2  | 2   | Buscar un comprobante también trae la cotización cuyo `seq` son sus dígitos · forma del número sin medir contra datos reales                                          |
| P3  | 6   | Costo de `sort=invoice` y del buscador · tests sin alcance por vendedor · M1 sin debounce · test E2E de M1 no tipea · enlace D-379 del plan viejo · tie-break y nulos |

No se encontraron fugas de alcance por vendedor ni regresiones en D-373/D-379.

---

## P2

### P2-1. Buscar un número de comprobante trae además una cotización ajena por su correlativo

- `apps/api/src/sales/quotations.service.ts:1332` y `:1353`; `apps/api/src/common/search-seq.ts:14`.
- `searchSeqOf` junta **todos** los dígitos del texto. Buscar `BBV1-347` da `1347` y el `OR` incluye
  `{ seq: 1347 }`: la lista muestra la importada `BBV1-347` **y** `COT-001347`, que no tiene nada que
  ver. Con correlativos cortos pasa casi siempre (`FFA1-12` → `COT-000112`, `F001-99` →
  `COT-000199`). Ahora que el placeholder invita a buscar por comprobante, es el uso nuevo más
  probable del buscador y devuelve una fila espuria.
- El E2E lo sabe y lo esquiva en vez de probarlo:
  `e2e/tests/comprobante-en-cotizaciones-d387.spec.ts:136-139` («se miran solo las filas con
  comprobante») y `:192` (`filter({ hasText: series })`).
- Arreglo sugerido: si el texto tiene forma de comprobante (la misma regex de
  `importedInvoiceNumber`, o en general letras que no sean el prefijo `COT-`), no comparar contra
  `seq`. P. ej. `searchSeqOf` solo acepta `^(COT-?)?0*\d+$` (y su gemelo `PED-` en pedidos). Agregar
  el caso al unitario de `findAll` y quitar el esquive del E2E. Es cambio de comportamiento del
  buscador: confirmar con el dueño (regla 16).

### P2-2. La forma `SERIE-NÚMERO` no se midió contra las marcas reales

- `packages/shared/src/schemas/quotation-import.ts:606` (`/^([A-Z][A-Z0-9]{3})-(\d{1,8})$/i`).
- La clave del importador es texto libre de hasta 60 caracteres (`quotation-import.ts:342`) y su
  columna del Excel se llama literalmente `SERIE - NÚMERO` (`:53`, con espacios). Cualquier marca
  real con espacios (`FFA1 - 1419`), serie numérica de factura física (`0001-123`) u otro formato
  queda con la celda vacía, **no se encuentra por el buscador** y se ordena al final, sin aviso.
  Es la decisión de diseño («nunca se adivina»), pero el riesgo es que el número de filas afectadas
  sea grande y nadie lo note.
- Arreglo sugerido: medir antes del deploy, en `demo` (copia de producción) y por servicio de
  dominio, cuántas cotizaciones tienen `externalInvoiceOf(notes) !== null` y cuántas de ellas
  `importedInvoiceNumber(notes) === null`, listando las claves que no calzan. Si hay variantes
  legítimas (p. ej. espacios alrededor del guion), decidir con el dueño si se normalizan.

---

## P3

### P3-1. `sort=invoice` lee todas las filas del filtro en cada pantallazo, y en serie

- `apps/api/src/sales/quotations.service.ts:1428-1441`.
- Sin búsqueda, la consulta de claves trae `id, seq, notes` de **todas** las cotizaciones no
  anuladas, las ordena en memoria y después pide la página: dos consultas **secuenciales** (el
  camino normal hace `count` y página en paralelo), o sea un RTT Cloud Run → Neon más, y lectura
  lineal en el total de cotizaciones (las `notes` completas, no solo la primera línea). Con el
  volumen actual seguramente es poco, pero no está medido.
- Sugerido: medir filas y tiempo en `demo` y anotarlo; si crece, leer solo la primera línea
  (`split_part`) vía consulta agregada o cubrirlo con un presupuesto de consultas en el test.

### P3-2. El buscador agrega una consulta secuencial y sin cota en cada búsqueda

- `apps/api/src/sales/quotations.service.ts:1333` y `:1399-1413`.
- `idsByImportedInvoice` corre **antes** de la consulta principal en toda búsqueda (incluidas las de
  nombre o RUC), con `startsWith` + `ILIKE` sin índice y sin `take`. Búsquedas como `1`, `-`, `f` o
  `externa` traen las observaciones de todas las importadas (incluidas anuladas y de otros
  vendedores; no hay fuga porque el `where` final las cruza con `sellerId` y estado) y pueden
  devolver cientos de ids para un `IN`. Pasa de 3 a 4 consultas por pantallazo con búsqueda, y de
  2 a 3 RTT en serie.
- Sugerido: lanzarla en paralelo no es posible (el `where` depende de ella), pero se puede aplicar
  ya el alcance del vendedor y el estado a la consulta de candidatos, o saltarla cuando el texto no
  puede ser parte de un comprobante (p. ej. < 2 caracteres o sin dígito ni guion). Medir.

### P3-3. Los tests nuevos no prueban el alcance por vendedor de los caminos nuevos

- `apps/api/src/sales/imported-invoice-d387.spec.ts:136-150`.
- El mock de `findMany` ignora el `where`. El código hoy es correcto (la consulta de claves reusa
  el `where` con `quotationSellerWhere`, y los ids del buscador se cruzan por AND con `sellerId`),
  pero ningún test fallaría si un refactor pasara a `findPageByImportedInvoice` un `where` sin
  alcance, o si la página por id dejara de venir de claves ya filtradas.
- Sugerido: un caso con actor `VENDEDOR` que afirme que `findMany.mock.calls[0][0].where` (claves)
  y el `where` de la lista con búsqueda contienen `sellerId: actor.id`.

### P3-4. M1: cada dígito del año dispara una consulta y un error visible

- `apps/web/src/app/(app)/comprobantes/[id]/dispatch-at-issue-date.tsx:58-68`, `:126-128`.
- El campo `type="date"` emite `onChange` con años intermedios (`0002`, `0020`, `0202`, `2026`):
  cada uno abre una consulta, los intermedios responden 4xx (sin reintento, bien) y el mensaje de
  error parpadea mientras se tipea. Ya no desmonta el campo, que era el defecto, pero es ruido y
  carga innecesaria.
- Sugerido: debounce corto de la fecha que entra a la `queryKey` (el campo sigue controlado con el
  valor inmediato), o no consultar con años < 2000.

### P3-5. M1: el E2E no reproduce el tipeo dígito a dígito

- `e2e/tests/despacho-fecha-comprobante-d278.spec.ts` (test D-387).
- `fill()` pone la fecha completa de una vez; el comentario del componente describe el corte al
  tipear el año. La prueba de «mismo nodo» con la respuesta retenida sí cubre el desmontaje, así
  que es solo una nota: con `pressSequentially` sobre el segmento del año quedaría probado el
  síntoma que reportó el usuario.

### P3-6. Detalles menores de comportamiento (para confirmar, no necesariamente defectos)

- `dispatch-at-issue-date.tsx:160-176`: mientras se ve el plan anterior como placeholder
  (atenuado), el enlace D-379 «restaurar reserva» del plan viejo sigue clicable. Inocuo (la acción
  vive en el pedido), pero podría ocultarse con `planReady` como las demás acciones.
- `apps/api/src/common/list-orderings.ts:50-66`: en `desc` las no importadas siguen al final y el
  empate entre comprobantes iguales (`FFA1-1419` y `FFA1-00001419`) desempata por número de
  cotización descendente en ambos sentidos. Está documentado y probado; solo confirmar que es lo
  que el dueño espera al invertir la columna.

---

## Revisado sin hallazgos

- **Alcance por vendedor:** `where` arma `sellerId` en el nivel superior y el `OR` del buscador
  queda en AND; la página por `id IN` solo recibe ids de claves ya filtradas. `quotationSellerWhere`
  no usa `OR`, así que el spread no lo pisa.
- **Paginación y total en memoria:** `slice(skip, skip + take)` con `toSkipTake`; `total =
keys.length` coincide con el filtro; el orden de la página se reconstruye por `pageIds` y tolera
  filas borradas entre las dos consultas.
- **`quotationOrderBy` con `invoice`:** cae al orden de siempre; ningún otro consumidor de
  `QUOTATION_SORT_KEYS` / `quotationOrderBy` (solo `findAll`).
- **DTO:** `externalInvoice` se agrega solo en `QuotationsService.toDto` (única construcción de
  `QuotationDto`); `tsc` de api y web limpio, y el duplicado de una importada (D-256) nace sin marca
  → `null`.
- **INT4:** `searchSeqOf` cubre los dos únicos sitios que extraían dígitos (cotizaciones y pedidos).
- **M1, claves y estados:** clave propia `'on'` evita el 400 por refresco con la `queryFn` cruzada;
  todos los hooks van antes del `return null`; `invalidateInvoicing` invalida el prefijo
  `['fiscal-document', id]`; el botón queda `disabled` (el `Button` combina `disabled || pending`)
  mientras el plan es placeholder o error; con `suggestedDate` (D-373) se siguen pidiendo los
  mismos dos planes que antes.
- **Reglas de AGENTS.md:** sin dinero/kg/mm nuevos (Decimal no aplica); UI, comentarios y mensajes
  en español; sin estado derivado almacenado (el número se lee de `notes` al leer, sin migración).
