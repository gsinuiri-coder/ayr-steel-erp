# cc57-d — Autorrevisión del commit `24790f54`

> **Autorrevisión — no vale como pase cruzado.** Subagente nuevo, sin leer el handoff de la
> implementación ni otros informes de `docs/revision/` de esta sesión. Es una lista de riesgos, no
> una aprobación. Solo lectura: no se corrieron tests, servidores ni bases.

Alcance: `git show 24790f54` (E-06 prefiltro SQL en `loadCollectibleDocuments`, E-12 tope del
kardex de un ítem en `findMovements`, E-13 filtro por pedidos en `pendingDispatchByOrder`).

Nota de estado: al revisar, el worktree tiene un cambio **sin commitear** en
`apps/api/src/reports/sales-margin.service.ts` (subconsultas `disp` y `nomov` filtran por el pedido
de la línea `sales_order_items.sales_order_id` en vez de `dispatches.sales_order_id`). Se revisan
las dos versiones; el riesgo R1 aplica al commit y queda resuelto por ese cambio si se commitea.

## Consumidores

- `loadCollectibleDocuments` (`apps/api/src/invoicing/collectible-documents.ts:65`):
  `ReceivablesService.loadCustomerSummaries` (`receivables.service.ts:301`, que alimenta la lista
  de cobranzas, `totals()` y el Excel) y `ReceivablesAgingService.report`
  (`reports/receivables-aging.service.ts:20`), que a su vez lee el Panel del administrador
  (`admin-dashboard`). Ningún llamador le pasa un `tx`; el tipo `Reader` ahora exige `$queryRaw`.
- `findMovements` (`inventory.service.ts:1717`): `InventoryController` (`GET /inventory/movements`,
  pantalla `/kardex` y detalle de bobina), `CoilsService.pdf` (`coils.service.ts:571`) y
  `KardexSheetService.sheet` (Excel del kardex, `kardex-sheet.service.ts:31`).
- `pendingDispatchByOrder` (`sales-margin.service.ts:~419`): solo `salesMargin`, que lee «Ventas y
  margen», su Excel y el Panel del administrador (estado del costo `PARCIAL` / `NO_RASTREABLE`,
  `sales-margin.service.ts:1002-1011`).

## Riesgos

### R1 — P2 (resuelto en el worktree, sin commitear): en el commit, `disp`/`nomov` filtran por `dispatches.sales_order_id`

`24790f54`, `sales-margin.service.ts` subconsultas `disp` y `nomov`: `AND d."sales_order_id" =
ANY(${orderIds})`. El agregado se agrupa por `di.sales_order_item_id`, pero el filtro mira el pedido
del **despacho**. No hay restricción en la base que obligue a que la línea despachada pertenezca al
pedido del despacho (`DispatchItem.salesOrderItemId` y `Dispatch.salesOrderId` son FKs
independientes, `schema.prisma:2294/2376`). Escenario: una fila de `dispatch_items` cuya línea es del
pedido A dentro de un despacho del pedido B (dato anómalo, importación, corrección manual): antes
sumaba como salida de A; con el commit se descarta y A pasa a `PARCIAL` (o pierde su
`NO_RASTREABLE`). Es un cambio de resultado de negocio, no solo de rendimiento. El cambio sin
commitear (filtrar por `dsoi`/`nsoi.sales_order_id`) devuelve exactamente lo de antes para
cualquier dato. **Acción:** commitear ese cambio antes del PR; si no, P1 por ser un cambio de
resultado no buscado.

### R2 — P2: la equivalencia del prefiltro E-06 depende de duplicar a mano la regla del saldo

`collectible-documents.ts:72-89` reescribe en SQL lo que `balanceParts` + `documentBalance`
(`packages/shared/src/schemas/invoicing.ts:130`) y `COLLECTIBLE_INCLUDE` deciden en TS. Hoy cuadra
(revisado): mismos estados vivos (`LIVE_DOCUMENT_STATUSES`: ISSUED, SEND_ERROR, ACCEPTED,
VOID_PENDING) para el documento y para la NC, mismo `archived_at IS NULL` en la NC, pagos con
`reversed_at IS NULL`, la relación `creditNotes` es `affected_document_id` sin filtro de tipo igual
que el SQL, y `> 0` es superconjunto del céntimo de D-377. Pero es la segunda copia de la regla que
D-421 quiso tener en un solo lugar: si mañana `COLLECTIBLE_INCLUDE.creditNotes` filtra por tipo o
motivo (p. ej. solo las NC que acreditan, como D-663 hizo con cantidades), o `documentBalance` deja
de restar algo, el SQL puede **excluir un comprobante que sí debe** y cobranzas/CxC/Panel lo pierden
sin error. No hay test que ate las dos copias. **Acción sugerida:** un comentario de enlace
cruzado en `COLLECTIBLE_INCLUDE` y en `documentBalance`, o un db-spec de paridad (ver R4).

### R3 — P2: el 400 del tope del kardex llega a la pantalla como «No se pudo cargar el kardex»

`inventory.service.ts:1758-1762` lanza `BadRequestException` con la guía «elige un rango más
corto», pero `kardex-sheet-table.tsx:114-118` muestra un texto fijo sin el mensaje del servidor. El
usuario que llegue al tope ve un error genérico y no sabe que la salida es acotar «Desde/Hasta».
También aplica al Excel (`KardexSheetService`) y al PDF de bobina (`CoilsService.pdf`, que no pasa
rango y no tiene cómo acotarlo, aunque una bobina difícilmente llegue a 10 000). Cambio de
comportamiento: antes se mostraban los primeros 10 000 (saldo corrido correcto hasta ahí, pero
faltando los últimos); ahora no se muestra nada. Con datos reales desde el 2026-09-07 es improbable
hoy, pero un producto de alto movimiento con recosteos (D-649 escribe filas `ADJUST` que cuentan para
el tope aunque se plieguen y no se vean) llega antes de lo que sugiere la pantalla. **Acción
sugerida:** mostrar el mensaje del 400 en la tabla, o anotarlo como deuda.

### R4 — P3: el db-spec nuevo de E-06 no prueba el prefiltro

`credit-note-reasons.db-spec.ts:670-692` («la lectura de cobranzas filtra en SQL lo ya cobrado»):
lo cobrado entero y lo acreditado entero ya los descartaba antes el filtro en memoria
(`hasCollectibleBalance`, `collectible-documents.ts:107`), así que el test pasa igual **sin** el
prefiltro. Prueba que el resultado no cambió (útil como regresión) pero no lo que dice el título.
Tampoco cubre los casos en que el SQL podría divergir: pago revertido, NC archivada, NC en
borrador/anulada, comprobante archivado, resto de céntimo (0,0001: pasa el SQL y lo saca D-377).
Para que pruebe el prefiltro haría falta mirar la consulta (`$queryRaw` espiado o el `findMany` con
`id in`) o comparar contra la lectura sin prefiltro sobre los mismos casos.

### R5 — P3: los unitarios de CxC con `$queryRaw` mockeado no ejercitan el SQL

`receivables-export.spec.ts:62-64`, `:122-124` y `receivables-aging.service.spec.ts:98-100`
devuelven todos los ids desde el mock: el SQL nuevo solo se ejecuta en el db-spec de R4. El test
«la lectura excluye los archivados…» (`receivables-aging.service.spec.ts:228`) sigue mirando solo el
`where` del `findMany`, no el del prefiltro (el `archived_at IS NULL` del SQL no tiene test). El
presupuesto del aging pasa de 2 a 3 consultas (`:205-219`), correcto.

### R6 — P3: el número de consultas ahora depende de los datos

Con `pending.length === 0` se hace 1 consulta en vez de 1 + 6 (`findMany` con 5 relaciones). En
`dashboards.db-spec.ts:130-154` el Panel se compara contra los reportes medidos sobre los mismos
datos, así que la igualdad sigue valiendo; `ADMIN_CEILING = 60` absorbe la consulta extra. Riesgo
solo si otro spec corre en paralelo y cambia entre «hay» y «no hay» saldo entre las dos mediciones
(ya documentado como frágil en cc34). La sentencia `findMany` lleva ahora `IN ($1..$n)` con n
variable: el multiconjunto sigue igual mientras los datos no cambien entre mediciones.

### R7 — P3: dos lecturas sin la misma foto

El prefiltro y el `findMany` no van en una transacción. Un cobro revertido o una NC anulada entre
las dos deja fuera, en esa respuesta, un comprobante que vuelve a tener saldo. Lo contrario (un cobro
nuevo) lo corrige el filtro en memoria. Transitorio, se arregla al recargar.

### R8 — P3: `id: { in: [...] }` sin tope

`collectible-documents.ts:93` manda todos los ids con saldo como parámetros. Postgres admite ~32 767
parámetros por sentencia; con la escala actual no se acerca, pero no hay comentario ni tope.

### R9 — P3: el test del tope del kardex no cubre el borde

`inventory.service.spec.ts:648-654` prueba 10 001 filas → rechazo (y que `take` es 10 001), pero no
que exactamente 10 000 filas sigan pasando, ni el tipo de excepción (`BadRequestException`, solo el
texto). El mock devuelve las filas sin mirar `take`, así que el test no depende del `take` real.

### E-13, subconsulta `inv` — sin riesgo encontrado

Cambiar `fdi.sales_order_item_id IS NOT NULL` por `JOIN sales_order_items fsoi` + filtro por
`fsoi.sales_order_id` es equivalente (FK) y el agregado por línea no cambia. No hay db-spec que
cubra `PARCIAL`/`NO_RASTREABLE` (solo E2E: `reportes-costeo-rf-s4a`, `fase2a`, `servicios-d167`,
`reportes-plantilla-cc32`); el unitario de `sales-margin.service.spec.ts` despacha el mock por
texto (`BOOL_OR`) y no prueba el filtro. El presupuesto de 7 consultas no cambia.

## Resumen

Ningún P0/P1 si se commitea el cambio pendiente de `sales-margin.service.ts` (R1); sin él, el commit
cambia el estado del costo de un pedido cuando una línea despachada no es del pedido del despacho.
El prefiltro de CxC hoy es equivalente a la regla en memoria, pero es una segunda copia de la regla
del saldo sin test que las ate (R2), y el db-spec nuevo pasaría también sin el prefiltro (R4). El
tope del kardex cambia «muestra truncado» por «error genérico» en la UI (R3). El resto es P3.

---

## Respuesta del autor (cc57)

- **R1:** el cambio pendiente entró al commit de las correcciones.
- **R2:** queda como límite anotado. El prefiltro es un superconjunto de `documentBalance` y el db-spec cubre cobro entero, cobro parcial, cobro revertido y acreditado entero. Si la regla del saldo cambia, el db-spec avisa.
- **R3:** el kardex muestra el mensaje del API (el tope pide acotar el rango) en vez de «No se pudo cargar». El PDF de bobina no llega a 10 000 movimientos.
- **R4:** el db-spec suma el cobro revertido. No es una prueba de rendimiento, es una red para que el prefiltro no se coma una deuda.
- **R9:** se agregó el borde de 10 000 filas.
- **R5..R8:** anotados.
