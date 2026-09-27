# Importador de compras (D-348..D-353): autorrevisión

> **Autorrevisión: no vale como pase cruzado.** La escribió un subagente nuevo que no leyó el handoff de
> implementación (AGENTS §2.2.1). Es una lista de riesgos, no una aprobación.

- Rama: `feat/importador-compras`. Diff revisado: `git diff origin/main...HEAD`, 9 commits, 62 archivos.
- Revisión solo de lectura. Se corrieron los unitarios relacionados, en modo bloqueante:
  `npx jest src/imports/purchase-import src/catalog src/sales/duplicate-shape src/sales/quotation-purge src/purchases/purchases.service.create-in-tx`.
  Resultado: 22 suites y 279 tests en verde. No se corrió E2E.

## Resumen

| Severidad | #   | Hallazgos                                                                                                                                                                                                                                                                                    |
| --------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0        | 0   | —                                                                                                                                                                                                                                                                                            |
| P1        | 5   | P1-1 idempotencia rota al reintentar · P1-2 redondeo que deja cantidad, precio, medida o TC en cero · P1-3 un SUPERVISOR_PLANTA da de alta proveedores · P1-4 deshacer lote puede anular una compra ya recibida · P1-5 el conflicto KG/CANTIDAD y de cabecera es solo un aviso que se pierde |
| P2        | 9   | ver abajo                                                                                                                                                                                                                                                                                    |

---

## P1

### P1-1: la idempotencia (D-182) no sobrevive a un reintento real

`apps/api/src/imports/purchase-import.service.ts:366-385`

`confirm()` valida el lote entero **antes** de reclamar la clave. Si el primer envío entró y el cliente
no recibió la respuesta (timeout, 5xx del proxy o corte de red), `useIdempotencyKey.settle(err)`
conserva la clave y el reintento manda el mismo payload con esa misma clave. Ahí `loadContext` ya ve
las compras recién creadas en `livePurchases`, y `validateDocument` marca cada comprobante con «Ya
registrada…» (`purchase-import-validate.ts:211-221`). El resultado es un 400 `notImported`: nunca se
llega a `claimIdempotencyKey` y el usuario no recibe el `batchId`. Sin `batchId`, la pantalla no
ofrece «Deshacer lote».

La idempotencia solo funciona con dos envíos **simultáneos**, porque el segundo espera en el
`INSERT … ON CONFLICT`. El test `idempotencia (D-182)` de `purchase-import.service.spec.ts:200` pasa
porque el mock deja `livePurchases` vacío, un estado que en la base real no puede darse.

No hay riesgo de duplicado: el D-132 lo sigue impidiendo. Lo que se rompe es la promesa de D-182 y la
salida del usuario, y la transacción de hasta 300 s hace probable un timeout del cliente.

**Sugerencia:** antes de validar, buscar la clave fuera de la transacción (`idempotencyKey.findUnique`
con el scope `purchase-import:confirm`). Si existe, devolver `batchResult(prisma, resourceId, [])`. Se
mantiene el reclamo dentro de la transacción para la carrera. Test: un reintento con
`livePurchases` poblado devuelve el mismo lote.

### P1-2: un valor positivo que el redondeo convierte en cero entra igual

`apps/api/src/imports/purchase-import-validate.ts:249-254, 410-421, 437-440, 475-486`

El importador arma `CreatePurchaseInput` a mano y **no** pasa por `createPurchaseSchema`. El
`decimalStringSchema` del alta normal redondea primero a la escala y **después** exige que el valor
sea mayor que cero (`packages/shared/src/decimal.ts:67-68`). El importador hace lo contrario: primero
compara el texto crudo con `lte(0)` y después redondea con `toFixed`. Casos concretos:

- `KG = 0,0004` pasa el control y se guarda `qty = 0.000`. La recepción crea una bobina de 0 kg.
- `PRECIO = 0,00004` se guarda `0.0000`: una bobina o producto con costo 0 en el kardex.
- `ANCHO = 0,004` o `ESPESOR = 0,004` se guarda `0.00`.
- `TC = 0,00001` se guarda un TC `0.0000` y `totalPen = 0`.

Tampoco hay cota superior. Con `qty` o `unitPrice` de 20 dígitos, o `ANCHO > 999999`, se produce un
`numeric field overflow`: un 500 que además aborta la transacción.

**Sugerencia:** al final de `validateDocument`, pasar el `input` armado por
`createPurchaseSchema.safeParse` (la función es pura y el costo es mínimo) y traducir cada issue a un
error de campo. Así se heredan de verdad los mismos mínimos y topes del alta (D-351 condición 1:
«hereda sus validaciones, no las copia»). Como alternativa, validar sobre el valor ya redondeado y con
`MAX_VALUE`.

### P1-3: el SUPERVISOR_PLANTA crea proveedores por el importador

`apps/api/src/imports/purchase-import.controller.ts:47` y `purchase-import.service.ts:388, 449-489`

`POST /suppliers` es solo de ADMINISTRADOR (`suppliers.controller.ts:79-80`). El importador acepta
ADMINISTRADOR y SUPERVISOR_PLANTA y, con ese rol, `createSuppliers` llama a `SuppliersService.createInTx`
con `creditDays: 0` y el código que eligió la pantalla. Según D-351, ese código «es el primer segmento
del código de bobina RF-13 y no se cambia después». El test de `purchase-import.service.spec.ts:211-222`
fija justamente ese comportamiento: `confirm(SUPERVISOR, …)` crea el proveedor.

D-351 habla de «los roles de crear una compra», pero no dice nada sobre la alta de proveedor. Es una
ampliación de permisos sin decisión registrada.

**Sugerencia (regla 16: detenerse y preguntar):** presentar dos opciones al dueño.
(a) Si el actor no es ADMINISTRADOR y el lote trae proveedores nuevos, marcar un error por
comprobante: «Un administrador tiene que dar de alta a RUC …».
(b) Registrar como `D-nnn` que el supervisor sí puede darlos de alta desde el padrón.
Se recomienda (a), que es coherente con el maestro de proveedores.

### P1-4: «Deshacer lote» puede anular una compra recibida y revertir su kardex

`apps/api/src/imports/purchase-import.service.ts:525-558`

`undo()` lee el estado de cada compra una sola vez, al inicio, y después llama a
`PurchasesService.cancel()` una por una. `cancel()` vuelve a leer el estado y se condiciona **al estado
que acaba de leer**, no a DRAFT (`purchases.service.ts:521-537`). El escenario es este:

1. El administrador pulsa «Deshacer lote».
2. Mientras tanto, otro usuario usa «Recibir seleccionadas» (D-353) sobre el mismo lote.
3. Una compra pasa a RECEIVED entre la lectura de `undo` y la de `cancel`.
4. `cancel` ve RECEIVED y anula esa compra con reversa de kardex y de bobinas.

El brief dice «anula las que **sigan en BORRADOR**». La anulación es válida para un administrador, así
que no hay corrupción, pero es un efecto de kardex que nadie pidió. El resultado además la informa
como «anulada» sin decir que estaba recibida. La ventana crece con el tamaño del lote, porque el bucle
va en serie.

**Sugerencia:** agregar a `cancel` un parámetro `expectedStatus` (o crear un `cancelDraft`) que use
`updateMany where status = DRAFT` y, si la fila ya no está en DRAFT, devuelva «ya se recibió». Test:
la compra pasa a RECEIVED entre la lectura y el `cancel`.

### P1-5: el conflicto KG/CANTIDAD y de cabecera es solo un aviso, y desaparece al editar

`apps/api/src/imports/purchase-import.service.ts:105-109` y `purchase-import-parse.ts:40-42, 111-125, 181-186`

El comentario del parser dice «Son errores del preview» y «no se elige una en silencio». Sin embargo,
`validateAll` los convierte en `severity: 'warning'` y les agrega «(se tomó la primera fila)». Ese texto
además es falso para el conflicto KG/CANTIDAD, donde gana KG y no la primera fila. Encima, `fileIssues`
solo llega a `preview`: `/validate` y `confirm` no lo reciben. En cuanto el usuario edita cualquier
campo, la revalidación borra el aviso y el comprobante queda limpio.

El caso más grave es una bobina con KG 5000 y CANTIDAD 500: se importan 5000 kg con un aviso que se
pierde. Lo mismo pasa si la fila 2 trae otra MONEDA o FECHA: queda la de la fila 1.

**Sugerencia:** decidir si son errores o avisos; el README (`docs/plantillas/README-importar-compras.md:14`)
dice aviso para la cabecera. Como mínimo:

- el KG/CANTIDAD de una bobina debería ser error, porque es la cantidad del kardex;
- el conflicto tiene que viajar con el comprobante, por ejemplo como un campo `fileIssues` en
  `purchaseImportDocumentInputSchema` o como una marca por línea, para que la revalidación y la
  confirmación lo vean;
- hay que corregir el texto del sufijo.

---

## P2

1. **Números con ceros a la izquierda burlan el duplicado vivo.** `purchase-import-validate.ts:211-221`
   y `livePurchaseKey`. `F001-00012` y `F001-12` son strings distintos, así que no se detectan como el
   mismo papel, ni en el preview ni en el índice D-132. El formulario manual tiene el mismo
   comportamiento, pero el importador ya usa `comparableDocument` para D-352. Sugerencia: avisar si la
   forma comparable coincide con una compra viva del mismo proveedor, y también entre comprobantes del
   mismo archivo.
2. **El preview no calcula el subtotal con los mismos valores que se guardan.** `purchase-import-validate.ts:460-461`
   usa `qty × unitPrice` crudos; `createInTx` recalcula con `qty.toFixed(3)` y `unitPrice.toFixed(4)`.
   Con más decimales de los que admite la escala, el total del preview no es el que se guarda.
   Sugerencia: calcular con los valores ya redondeados; esto se resuelve junto con P1-2.
3. **Cada revalidación vuelve a llamar al padrón y a SUNAT.** `loadContext` corre en cada `/validate`,
   que se dispara 600 ms después de cada edición y tiene un throttle de 30/min. Con varios RUC nuevos,
   eso suma muchas llamadas externas y puede terminar en 429 mientras el usuario edita. Sugerencia:
   un caché corto por RUC y por fecha, o que el navegador devuelva lo que ya resolvió el preview (el
   nombre se sigue resolviendo en el servidor al confirmar).
4. **«Deshacer lote» solo existe en la pantalla del resultado.** `importar-compras-view.tsx:334-348`.
   Si se recarga la página o se navega a otra, no hay forma de deshacer desde la UI: habría que anular
   compra por compra. Sugerencia: un enlace o filtro por `importBatchId` en /compras, o dejarlo anotado
   como deuda.
5. **«Recibir seleccionadas» mantiene la selección cuando cambian los filtros.** `compras-view.tsx:98-115`.
   `selected` sobrevive a un cambio de filtro o de búsqueda, así que se pueden recibir compras que ya no
   se ven. Tampoco hay diálogo de confirmación antes de mover el kardex de N compras. Sugerencia:
   limpiar la selección al cambiar filtros, o recibir solo las seleccionadas que están visibles, y
   agregar un diálogo que diga cuántas compras se van a recibir.
6. **El lock de D-348 no alcanza a las tablas polimórficas.** `catalog.service.ts:501-512`.
   `FOR UPDATE` sobre `products` bloquea las altas con FK (líneas de cotización, pedido y compra), pero
   no `inventory_movements`, `reservations` ni `quotation_reservations` (`itemId` sin FK). En la
   práctica nacen junto con una fila con FK, así que el riesgo es bajo. Aun así, conviene dejarlo
   escrito en el comentario, que hoy afirma una cobertura total.
7. **`externalCode` no se valida contra bobinas existentes ni dentro del archivo**, y `PurchaseItemDto`
   no lo expone. El detalle de la compra no muestra el código antes de recibir, y dos bobinas pueden
   quedar con el mismo código externo. Sugerencia: avisar si se repite y exponerlo en el DTO.
8. **Cambio de orden en `PurchasesService.create`.** El TC de SUNAT ahora se resuelve **antes** de las
   validaciones de proveedor y producto. Si SUNAT falla, el alta manual responde con un error de TC
   aunque el formulario tuviera otro error más útil. Es aceptable (el motivo está documentado), pero es
   un cambio de comportamiento para el caller existente.
9. **Cobertura de tests faltante:**
   - el reintento idempotente con compras ya creadas (P1-1);
   - el redondeo a cero (P1-2);
   - el rol del alta de proveedor (P1-3);
   - la carrera de `undo` (P1-4);
   - que `/validate` conserve los conflictos del archivo (P1-5);
   - un E2E de D-348 que pruebe el rechazo 409 bajo lock cuando aparece uso entre la lectura y el
     guardado. Hoy solo está cubierto con mocks.

---

## Revisado sin hallazgos

- **Migración `d351`:** es aditiva; el cambio en `CoilFilmEvent` es solo de alineación.
- **`createInTx`:** todas las validaciones leen de `tx`.
- **P2002 dentro del SAVEPOINT:** se traduce a `ConflictException` y se vuelve con `ROLLBACK TO SAVEPOINT`.
- **Errores que no son de dominio:** cortan la transacción.
- **`SuppliersService.create`:** su comportamiento no cambia.
- **Datos que llegan del navegador:** los ids de proveedor, producto y acabado se vuelven a resolver
  contra el maestro, con su estado activo y su línea.
- **Nombre del proveedor nuevo:** lo pone el padrón, nunca el navegador.
- **Idempotencia simultánea:** la resuelve el `ON CONFLICT`.
- **Decimal:** los importes se calculan con `Decimal` (D-003); no se encontró `number` en dinero ni en
  kg. Los días de crédito son enteros.
- **D-348 (servidor):**
  - el SKU cambia solo junto con la estructura;
  - el patrón ACCES devuelve un error de campo `sku`;
  - la revalidación se hace bajo `FOR UPDATE`;
  - un P2002 se traduce a 409 con el campo `sku`;
  - `roofingKind` queda en la auditoría.
- **D-348 (duplicar):** la unidad de la línea es la del producto (`sales-lines.ts:666`), así que
  `duplicateShapeChange` no rompe D-161.
- **D-349:** sin `active`, `GET /catalog` sigue devolviendo todos, así que los selectores no cambian.
- **D-350:** una sola transacción; revalida bajo lock en orden por `seq` y aborta si el plan cambió.
  Borra `sales_price_changes` (RESTRICT) antes de la cotización; las líneas y piezas se van en cascada.
  No toca R2 y queda la auditoría `quotations.purge`.
- **D-353:** recibe en serie, cada compra por su `receive()` con su propio claim DRAFT→RECEIVED.

---

## Respuesta de la sesión (2026-09-27)

| Hallazgo                                      | Estado                    | Qué se hizo                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 idempotencia al reintentar               | **Corregido**             | `confirm()` busca la clave **antes** de validar y devuelve ese lote (`IDEMPOTENCY_SCOPE`); test que afirma que el reintento no valida ni abre transacción.                                                 |
| P1-2 valores que el redondeo anula / sin tope | **Corregido**             | El alta armada pasa por `createPurchaseSchema.safeParse` (errores al campo que los trajo) y topes `MAX_VALUE` en cantidad, importe, espesor, ancho y TC; tests de 0,0004 kg y de un precio fuera de rango. |
| P1-3 SUPERVISOR da de alta proveedores        | **Decidido por el dueño** | Se preguntó (D-230) con la recomendación de exigir ADMINISTRADOR; el dueño eligió que **ambos roles** creen. Registrado en D-351.                                                                          |
| P1-4 deshacer lote anula una recibida         | **Corregido**             | `PurchasesService.cancel(…, { onlyDraft: true })`: 409 si la compra ya no está en borrador; la anulación condicionada usa ese mismo estado. Test.                                                          |
| P1-5 conflictos de filas como avisos          | **Corregido el texto**    | Siguen siendo avisos (lo que se importa es lo que se ve en pantalla), pero ahora dicen qué se tomó («se tomó KG», «se tomó el de la primera fila») y el comentario del parser ya no dice «errores».        |
| P2-1 ceros a la izquierda                     | **Corregido**             | `livePurchaseKey` compara el número sin ceros a la izquierda; la consulta de compras vivas ya no filtra por el texto del número. Test.                                                                     |
| P2-2 subtotal sin redondear                   | **Corregido**             | El subtotal del preview usa kg a 3 y precio a 4, como se guarda.                                                                                                                                           |
| P2-3, P2-4, P2-5, P2-7, P2-8                  | Anotados                  | No bloquean; quedan en el handoff.                                                                                                                                                                         |
| P2-6 lock sin tablas polimórficas             | **Documentado**           | Mismo riesgo residual de D-347, escrito en el comentario del lock.                                                                                                                                         |
| P2-9 tests                                    | Parcial                   | Tests de cada P1 corregido; el E2E del 409 bajo lock no se agregó.                                                                                                                                         |
