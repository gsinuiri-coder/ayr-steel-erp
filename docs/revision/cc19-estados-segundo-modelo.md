# Revisión de segundo modelo (Sonnet, contexto limpio)

Alcance: ajuste D-387 de cc19, diff `87dfa20..2c57ed2` (estados de la columna «Comprobante»). Es la
revisión de otro modelo, no una aprobación humana ni un pase independiente. No se corrió Playwright,
`next build` ni `dev`. Se corrieron `npx jest src/sales/imported-invoice-d387.spec.ts
src/common/list-orderings.spec.ts` (104 pasan) y `tsc --noEmit` en `apps/api` (limpio).

**Resultado: no hay P0 ni P1.** Los estados, la vigencia, la normalización, el alcance por vendedor
y la consulta agregada son correctos en lo que se pudo trazar. Quedan 2 P2 y 5 P3.

## Lo verificado sin hallazgo

- Vigencia: `liveInvoiceDocuments` (`quotations.service.ts:96-107`) usa `LIVE_DOCUMENT_STATUSES`
  (lista blanca: ISSUED, SEND_ERROR, ACCEPTED, VOID_PENDING), `docType` FACTURA/BOLETA,
  `archivedAt: null` y `number` no nulo. Anuladas (ANNULLED/VOIDED), rechazadas, borradores y notas
  de crédito quedan fuera. El mismo objeto alimenta el include de la lista, el del detalle, el
  ordenamiento y el buscador, así que las tres lecturas no pueden divergir.
- Estados (`quotation-import.ts`, `quotationInvoiceState`): los cuatro casos son exhaustivos. La
  normalización compara serie en mayúsculas y correlativo sin ceros, lo mismo para los dos lados.
  `shownInvoiceNumber` y el primer documento de la UI salen del mismo orden
  (`issueDate asc, number asc`), de modo que lo ordenado es lo mostrado.
- Alcance por vendedor: `quotationSellerWhere` se esparce en el nivel raíz del `where`, no dentro del
  `OR` del buscador; `id in invoiceIds` queda dentro del `OR` y por eso se intersecta con el alcance.
  `idsByInvoiceNumber` no filtra por vendedor, pero solo devuelve ids que luego pasan por ese `where`;
  no hay fuga de la existencia de comprobantes ajenos.
- Rendimiento: no hay consultas por fila. La lista suma una relación anidada (Prisma la resuelve en
  una consulta por nivel para toda la página). El orden por `invoice` carga todas las filas del
  filtro, como ya hacía antes del ajuste.
- Otros usos de `quotationInclude` (`renderPdf`, `findOne`): solo reciben la relación extra, sin
  cambio de comportamiento. `tsc` limpio, no hay otro constructor de `QuotationDto`.
- UI: ámbar con `text-tone-warning-foreground` (existe en claro y oscuro, `globals.css:107,152`), sin
  rojo; gris `text-muted-foreground` para la referencia.

## P2

### P2-1. Las pruebas no demuestran la vigencia en la lista ni en el orden

`apps/api/src/sales/imported-invoice-d387.spec.ts`, bloque `findAll`. El mock de `findMany` ignora el
`where`/`include`: devuelve las filas armadas a mano con `salesOrders` ya filtrados. Por eso
«anulado no cuenta» y «NC no cuenta» solo se afirman en la ruta del buscador
(`docArgs[0].where` con `status`, `docType`, `archivedAt`). Escenario: alguien cambia
`liveInvoiceDocuments` o quita el `where` del `select` de `findPageByImportedInvoice` (líneas
~1478-1486, que repite el `salesOrders` a mano en vez de reutilizar el include) y ninguna prueba
unitaria falla; una anulada pasaría a «registrado» y a ordenar. Arreglo: afirmar en la prueba de la
lista y en la de `sort=invoice` que `findMany` recibió
`include.salesOrders.select.fiscalDocuments === liveInvoiceDocuments` (exportándolo o comparando por
`toMatchObject`), o un e2e con una factura ANNULLED y una NC (la spec e2e nueva debería confirmar que
las cubre; no se ejecutó).

### P2-2. Comprobante vigente colgado de un pedido anulado se ve como «solo referencia»

`quotations.service.ts:129-133` y `1478-1486`: `salesOrders` se filtra a `status != CANCELLED`, y los
comprobantes se leen solo desde ese pedido. Escenario: la cotización importada tiene el pedido anulado
pero una factura ACCEPTED/ISSUED sigue viva en él (si el sistema permite anular el pedido sin anular el
comprobante, cosa que no pude descartar leyendo solo este diff). La columna muestra el número del Excel
en gris con el tooltip «aún sin comprobante registrado», que es falso: hay un comprobante vigente.
Arreglo: confirmar si un pedido anulado puede conservar comprobante vigente. Si puede, leer los
comprobantes por `quotationId` del pedido sin filtrar el estado, o mostrar el estado «registrado» con
aviso. Si no puede (guardrail en la anulación), anotarlo en el comentario de `liveInvoiceDocuments`.

## P3

### P3-1. El buscador pierde fragmentos con guion que la comparación normalizada aceptaría

`quotations.service.ts` (`idsByInvoiceNumber`, líneas ~1423-1456). Si el texto no empieza con una serie
de cuatro caracteres más guion (`/^([A-Z][A-Z0-9]{3})-/`), Postgres filtra con `contains` sobre el
texto crudo. Escenario: buscar `A1-1419` o `-1419` no encuentra `FFA1-00001419` (el crudo no contiene
`A1-1419`), aunque `invoiceNumberContains` sí lo aceptaría. Con serie completa (`FFA1-1419`) funciona.
Arreglo: documentarlo como límite, o extraer el correlativo (`/-(\d+)$/`) y buscar por serie/correlativo
por separado.

### P3-2. Sobrecoincidencia al normalizar una búsqueda parcial con ceros

`quotation-import.ts` (`invoiceNumberContains`). Se normaliza también la aguja: `FFA1-001` pasa a
`FFA1-1` y encuentra `FFA1-1419`, `FFA1-1200`, etc., cuando quien tipea ceros espera el prefijo literal
(`FFA1-001…`). Solo ocurre con agujas incompletas; con número completo es correcto. Arreglo: normalizar
la aguja solo si tiene la forma completa de ocho dígitos o si el crudo no coincidió y la aguja es un
número completo; o aceptarlo y fijarlo con un caso en el spec.

### P3-3. Prefijo de la marca rígido en el prefiltro de Postgres

`startsWith: "Factura externa: <serie>-"` exige exactamente un espacio tras los dos puntos, mientras que
`externalInvoiceOf` hace `slice` + `trim` y admite más espacios. Una marca con doble espacio se muestra
en la columna pero el buscador por serie no la encuentra. Poco probable (la escribe el importador).
Arreglo: prefijo común más `contains` de la serie, y que decida la lectura en memoria.

### P3-4. El estado «registrado» puede mostrar un número distinto del Excel sin avisar

`quotationInvoiceState` + `QuotationInvoice`: con varios comprobantes, si el segundo coincide con el
Excel y el primero no, el estado es REGISTRADO y se muestra el primero (el del Excel solo aparece en el
tooltip de «+N»). Es el comportamiento especificado y está probado, pero conviene que el tooltip de
«+N» marque cuál coincide. Arreglo cosmético.

### P3-5. «No coincide» se distingue solo por color, sin icono

`apps/web/src/components/sales/quotation-invoice.tsx`: el registrado lleva check y el que no coincide no
lleva nada distinto al ámbar. Para quien no distingue el tono, la diferencia es solo el tooltip (que
además no se ve con teclado). Arreglo: icono de alerta ámbar (`TriangleAlert`) con `aria-label`, y que
el tooltip no sea la única vía a los dos números.

## Notas menores sin hallazgo

- No hay prueba unitaria del componente `QuotationInvoice`; los estados visuales dependen del e2e (no
  ejecutado en esta revisión).
- Los candidatos de notas se traen enteros para cualquier texto (p. ej. «fa» coincide con «Factura
  externa» en todas las importadas). Ya era así antes del ajuste; solo ahora se suma una segunda
  consulta de comprobantes por pulsación.
