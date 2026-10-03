# Diseño: llevar un comprobante manual anulado a otro pedido (D-381, propuesta) — 2026-10-03

**Solo diseño.** Esta sesión no escribe código de producto ni datos. Se apoya en el código de
`origin/main` = `56e068e` y en una foto de producción tomada en una transacción `READ ONLY`
(§1), corrida con el OK del dueño (D-251).

**Revisión.** Un segundo modelo (Sonnet, contexto limpio) revisó el diseño:
`docs/revision/d381-diseno-segundo-modelo.md`. No encontró P0. Su P1 y sus P2 están incorporados
en §3.4 y §3.6, y la P3 de la referencia de línea está corregida. Falta la revisión del dueño.

**Caso del dueño.** Anuló el comprobante manual `FFA1-00001389` y también su pedido, porque el
pedido tenía datos erróneos. Creó el pedido `PED-000056` con los datos correctos. El comprobante
anulado sigue atado al pedido anulado y no hay forma de registrarlo en el nuevo: el número
duplicado se rechaza, y las dos reactivaciones (D-373 y D-378) bloquean porque el pedido está
anulado.

## 1. La foto de producción

Foto `READ ONLY` de producción del **2026-10-03**. El JSON completo está en
`local-data/d381/foto-production-2026-10-03.json`, fuera de git porque trae datos reales. Acá no se
transcriben el cliente ni los importes. El script de un solo uso se borró al terminar.

### 1.1 El comprobante `FFA1-00001389`

- **FACTURA**, `origin = MANUAL`, **`ANNULLED`**.
- Fecha de emisión **2026-08-20**, a **crédito**, con vencimiento el 2026-10-20.
- Se registró el 2026-09-28 a las 19:53 UTC sobre **PED-000044**. Se anuló el 2026-09-29 a las
  04:52 UTC, con el motivo «mal ingreso».
- Su estado antes de anularse era `ACCEPTED`, según la auditoría `invoicing.import.annul`. Eso es
  lo que exige `lockAnnulledForReactivation`.
- **Seis líneas**, todas con `sales_order_item_id` hacia PED-000044:

  | #   | Producto        | Cantidad |
  | --- | --------------- | -------- |
  | 1   | `ALVEOLAR11800` | 3 NIU    |
  | 2   | `SIKA11FC`      | 12 NIU   |
  | 3   | `AUTOPER14X5`   | 400 NIU  |
  | 4   | `SIKBOOM`       | 12 NIU   |
  | 5   | `PERFILH`       | 4 NIU    |
  | 6   | `PERFILU`       | 7 NIU    |

- Sin detracción, sin despacho declarado y sin traza de PSE.
- **Cobros: 0. Notas de crédito: 0.** No hay cambios de fecha registrados. Ningún despacho lo
  referencia por `invoice_id`.

### 1.2 El pedido anulado `PED-000044`

- **`CANCELLED`** desde el 2026-09-29 a las 04:52 UTC: 17 s antes de anular el comprobante, con el
  mismo motivo.
- Viene de `COT-000083`, que hoy también está anulada.
- Fecha **2026-09-28**. Nota: «Factura externa: FFA1-1389».
- **Mismo cliente** que el comprobante.
- Las **mismas seis líneas** del comprobante, con la misma cantidad y el mismo precio unitario.
- Total del pedido = total grabado del comprobante.
- **Reservas:** las seis quedaron `RELEASED` con cantidad 0, liberadas por la anulación.
- **Despachos: 0. OPs: 0.**

### 1.3 El pedido nuevo `PED-000056`

- **`CONFIRMED`**, fecha **2026-10-01**, creado el 2026-10-02 a las 01:40 UTC.
- Viene de `COT-000085`, que está `CONFIRMED`. Misma nota: «Factura externa: FFA1-1389».
- **Mismo cliente.**
- **Siete líneas**:
  - la línea 1 es nueva: `UPVC6MT` «TC5 UPVC ROJO 1.5 MM X 1.075 X 6.00 MT», 42 NIU;
  - las líneas 2 a 7 son, en el mismo orden, las seis de PED-000044, con la misma cantidad y el
    mismo precio unitario.
- **Reservas:** las siete están `ACTIVE`, sin faltante.
- **Despachos: 0. OPs: 0. Cobros: no aplica.**
- **Tiene un borrador de FACTURA** (`DRAFT`, `ISSUED_HERE`, sin número). Se creó 41 s después del
  pedido y su total es el del pedido. Por la hora, es el intento de reingresar 1389: el registro
  manual chocó con el número y el borrador quedó. **Bloquea la acción nueva y hay que eliminarlo
  antes** (§3.3).

### 1.4 Qué datos eran los erróneos

**Al pedido anulado le faltaba la línea `UPVC6MT` × 42.** Nada más cambió:

- el cliente, los productos, las cantidades y los precios unitarios de las otras seis líneas son
  los mismos;
- el total nuevo es el viejo más el importe de esa línea.

Hay dos diferencias que no son de contenido:

- **El vendedor (`seller_id`) es otro.** En PED-000044 era un usuario y en PED-000056 es el que
  creó los dos pedidos. **El dueño confirma cuál es el correcto**: los reportes por vendedor leen
  el del pedido, y al llevar el comprobante al pedido nuevo la venta pasa a ese vendedor.
- La fecha del pedido: 2026-09-28 contra 2026-10-01. Las dos son posteriores a la del papel, el
  2026-08-20.

**Observación.** Es exactamente el caso de uso de **D-378**: «el papel está bien y al pedido le
faltaron ítems». Si no se hubiera anulado el pedido, el camino ya existía:

1. Agregar la línea a PED-000044 con el comprobante anulado.
2. «Reactivar con las líneas del pedido».

Lo que lo cerró fue anular el pedido. Un pedido anulado no se reabre (§2).

**A confirmar con el papel.** El total grabado de 1389 es el de seis líneas. **¿El papel vigente
en Nubefact es por las siete líneas, el total de PED-000056?** Si el papel es por seis, el pedido
nuevo no coincide con él y la acción rechazará el total tipeado. Ahí lo que corresponde es corregir
el papel o el pedido, no forzar.

## 2. Hoy no hay ningún camino por la interfaz

Verificado en el código:

| Camino                                                             | Qué pasa                                                                                                                                                                                                                                                                                              | Dónde                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Reingresar el número en PED-000056 (borrador → «Registrar manual») | 409 «Ya hay un comprobante registrado con el número…». La comprobación busca por `number` y `archivedAt: null`, **sin filtrar estado**: un anulado sigue ocupando su número. El índice único parcial `fiscal_documents_number_active_key` (`WHERE archived_at IS NULL`) lo impide también en la base. | `invoicing.service.ts:1219-1227`; migración `20260905170100_fase7c…:22-24` |
| Liberar el número archivando 1389                                  | `fiscal_documents_archive_ck` solo admite `archived_at` en `IMPORTED`. Un `MANUAL` no se archiva.                                                                                                                                                                                                     | migración `fase7c…:35-38`                                                  |
| Reactivar (D-373)                                                  | 409 «El pedido PED-000044 está anulado: no se reactiva un comprobante de un pedido anulado». Además, restauraría las líneas de PED-000044.                                                                                                                                                            | `fiscal-import.service.ts:332-336`                                         |
| Reactivar con las líneas del pedido (D-378)                        | El mismo 409. Además, solo relee las líneas del **mismo** pedido.                                                                                                                                                                                                                                     | `fiscal-import.service.ts:636-640`                                         |
| Reabrir PED-000044                                                 | No existe: no hay endpoint que saque un pedido de `CANCELLED`.                                                                                                                                                                                                                                        | `sales-orders.service.ts` (`cancel`, 2197-2350)                            |
| Mover el comprobante de pedido                                     | Nadie escribe `fiscal_documents.sales_order_id` ni `customer_id` después de `createInTx`. Ninguna escritura mueve `fiscal_document_items.sales_order_item_id` a ítems de otro pedido.                                                                                                                 | `invoicing.service.ts:639-680`; todos los `fiscalDocument(Item).update*`   |
| Corregir la fecha del anulado                                      | «Un comprobante anulado ya no se corrige».                                                                                                                                                                                                                                                            | `invoicing.service.ts:1405`                                                |

Hoy la única salida sería escribir en la base, y eso está prohibido (regla dura 3).

## 3. Diseño de la acción

### 3.1 Qué hace

«**Traer comprobante anulado**» se lanza desde el detalle del pedido **destino** (PED-000056), solo
para el administrador. Sobre un comprobante manual anulado cuyo pedido de origen está anulado, hace
lo siguiente en **una sola transacción**:

1. **Conserva** número, serie, correlativo, tipo, fecha de emisión, condición de pago y
   vencimiento. Son los del papel.
2. **Lo pasa al pedido destino** (`sales_order_id`).
3. **Toma las líneas del pedido destino**, cada una por su cantidad completa: el comprobante pasa a
   facturar el pedido entero, igual que D-378. La cabecera se calcula con D-377.
4. Lo vuelve a `ACCEPTED` y limpia los campos `annul*`, igual que las dos reactivaciones.
5. Escribe la auditoría con el antes y el después, el pedido de origen y el de destino.

El pedido de origen queda `CANCELLED` y sin comprobantes. No se le toca nada más.

### 3.2 Controles (los de D-378)

- **Solo administrador** (`assertCanReactivate`) y **motivo obligatorio**.
- **El total del papel al céntimo.** El administrador tipea el total. Solo se ejecuta si el total
  nuevo coincide; si no, rechaza mostrando los dos (`paperTotalDifference`).
- **La casilla:** «Confirmo que el comprobante, con estas líneas y en este pedido, coincide con el
  papel vigente en Nubefact».
- **El antes y el después en el modal:**
  - pedido de origen → pedido de destino;
  - las líneas;
  - gravada, IGV y total.
  - Si el cliente o el vendedor del pedido cambian, se dicen explícitamente (§4.1).
- **Auditoría** `invoicing.document.move-to-order`:
  - `before`: `salesOrderId` de origen, estado, `annul*`, líneas, `rows` y la cabecera grabada;
  - `after`: `salesOrderId` de destino, líneas, `rows`, la cabecera nueva y `paperTotalPen`;
  - `reason`.

  Las dos auditorías de pedido (`entity = sales_orders`) se discuten en §3.6.

### 3.3 Bloqueos

| Bloqueo                                                                                              | De dónde sale                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Origen distinto de `MANUAL`, o tipo distinto de FACTURA/BOLETA                                       | D-378 y `lockAnnulledForReactivation`                                                                                                                                                                              |
| No está `ANNULLED`, está archivado, tiene traza de PSE, o la última anulación no venía de `ACCEPTED` | `lockAnnulledForReactivation`                                                                                                                                                                                      |
| **Cobros** sin revertir, o creados después de anularlo                                               | `lockAnnulledForReactivation`                                                                                                                                                                                      |
| **Notas de crédito** vivas, o creadas después de anularlo                                            | `lockAnnulledForReactivation`                                                                                                                                                                                      |
| Con detracción                                                                                       | D-378                                                                                                                                                                                                              |
| Comprobante sin pedido, o líneas sin `sales_order_item_id`                                           | D-378. Sin pedido de origen no hay de dónde traerlo; ese caso, si aparece, es otra acción.                                                                                                                         |
| **El pedido de origen no está anulado**                                                              | Decisión 2 (§4.2)                                                                                                                                                                                                  |
| El destino es el mismo pedido de origen                                                              | Nuevo: ahí corresponde D-373 o D-378                                                                                                                                                                               |
| El pedido destino está `CANCELLED`                                                                   | Como `resolveLines` (`invoicing.service.ts:815`)                                                                                                                                                                   |
| **Despachos vivos enlazados al comprobante**: un `dispatches.invoice_id` hacia él en estado `ISSUED` | Nuevo. Un despacho `REVERSED` enlazado también bloquea, por prudencia: quedaría un despacho de un pedido apuntando a un comprobante de otro. Hoy no aplica (0 enlaces) y se puede relajar cuando aparezca un caso. |
| Despachos vivos (`ISSUED`) del pedido de origen                                                      | Nuevo. La anulación del pedido no los revierte, y la mercadería salió por ese pedido.                                                                                                                              |
| **Otra factura o boleta viva en el pedido destino**                                                  | D-378 (`SHARED_LIVE_DOCUMENT_STATUSES`, pedido entero)                                                                                                                                                             |
| **Borrador en el pedido destino**                                                                    | D-378. **Aplica hoy:** PED-000056 tiene el borrador del intento de reingreso, que se elimina primero.                                                                                                              |
| Cliente del pedido destino distinto del cliente del comprobante                                      | Decisión 1 (§4.1)                                                                                                                                                                                                  |
| Boleta a «público en general» que con las líneas nuevas cruzaría el tope de D-077                    | D-378 (`fiscal-import.service.ts:733-746`)                                                                                                                                                                         |
| Más líneas en el comprobante que en el pedido destino                                                | Nuevo (§3.4): no se borra ninguna fila                                                                                                                                                                             |

**No bloquea**, igual que en D-378: el pedido destino `FULFILLED` o con despachos propios. Sus
despachos no se enlazan al comprobante (`invoice_id` sigue nulo). Las líneas despachadas conservan
su despacho y las demás quedan pendientes.

### 3.4 Las líneas: emparejar y después reutilizar D-378

`planOrderLines` (`reactivate-order-lines.ts:128`) empareja las filas del comprobante con las
líneas del pedido **por `sales_order_item_id`**. Al cambiar de pedido no hay ningún id en común, así
que se agrega un paso puro previo, `pairRowsToOrder(documentLines, targetOrderLines)`:

1. Cada fila del comprobante, en orden de línea, se empareja con la primera línea libre del destino
   que tenga **el mismo producto, la misma cantidad y el mismo precio unitario**. Así dos líneas del
   mismo producto con importes distintos no se cruzan, y el control del total no lo vería
   (revisión del segundo modelo, P2).
2. Las que no encontraron pareja exacta se emparejan con la primera línea libre del **mismo
   producto**, en orden de línea.
3. Las filas que sobran se emparejan, en orden, con las líneas del destino que quedaron libres. Es
   un cambio de producto: `planOrderLines` ya toma producto, descripción y unidad del pedido en ese
   caso. **El modal resalta esas filas** («cambia de producto: X → Y») para que no pase en silencio.
4. Las líneas del destino que quedan libres se agregan al final, como las líneas nuevas de D-378.
5. Si quedan filas del comprobante sin pareja (el destino tiene menos líneas), **bloquea**. D-378
   nunca borra una fila, y aquí tampoco.

El resultado es la misma lista de filas con el `sales_order_item_id` del destino. Esa lista entra a
`planOrderLines`, y de ahí salen `fullLineAmounts`, la cabecera D-377 y el antes y el después.

**Dos cambios obligatorios sobre lo de D-378** (revisión del segundo modelo):

- **P1. `updates` tiene que escribir `salesOrderItemId`.** Hoy el plan de D-378 no lo lleva en
  `updates`, solo en `creates` (`reactivate-order-lines.ts:67`), y la escritura no lo toca
  (`fiscal-import.service.ts:508-521`). En D-378 no hacía falta porque el pedido no cambiaba. Si se
  reutilizara tal cual, las seis filas pasarían a PED-000056 pero seguirían apuntando a las líneas
  de PED-000044. Eso rompería `invoicedByOrderItem`, el despacho por comprobante, los reportes y el
  bloqueo de otra factura viva. Se agrega `salesOrderItemId` a `updates` y a su escritura, con un
  unitario que lo demuestre. En D-378 el valor no cambia.
- **P2. El «antes» conserva la línea de origen.** El `before.lines` y el `before.rows` de la
  auditoría se arman con el `sales_order_item_id` y el número de línea **originales**, de
  PED-000044. Se leen antes del remapeo.

**En 1389:**

- las seis filas se emparejan por producto con las líneas 2 a 7 de PED-000056, conservan id,
  número de línea, descripción y unidad;
- `UPVC6MT` entra como línea 7 del comprobante.

El orden de las líneas en el comprobante no será el del pedido. Es el mismo comportamiento de D-378:
el papel manda su numeración. El modal muestra los dos números, el del comprobante y el del pedido.

**Efectos sobre el pedido destino:**

- **Queda congelado.** Con un comprobante vivo, `lockEditable` (D-187) deja de permitir editarlo.
  Es lo mismo que pasa al registrar un comprobante, pero el modal lo avisa: «Después de traerlo,
  PED-000056 ya no se edita».
- **El vendedor.** El comprobante pasa a verse con el vendedor del destino. Eso no solo cambia los
  reportes: también cambia el alcance por vendedor de comprobantes y de cuentas por cobrar
  (`receivables.service`). El modal muestra «Vendedor: origen → destino» cuando difieren.

**Diferencia con D-378.** El bloqueo «el pedido describe exactamente lo que el comprobante ya
tenía» (`!plan.changed`) **no aplica**: lo que cambia es el pedido, aunque las líneas sean iguales.

### 3.5 Locks y escritura

- **Locks** en el orden de D-378:
  1. comprobante (`lockAnnulledForReactivation`);
  2. los dos pedidos `FOR UPDATE`, **ordenados por id** para que dos acciones cruzadas no se
     bloqueen entre sí;
  3. los borradores del destino.
- **Escritura**, como D-378 (`fiscal-import.service.ts:491-527`):
  - un `updateMany` condicionado a `status = ANNULLED` **y** `sales_order_id = <origen>`, que cambia
    estado, `sales_order_id`, `annul*` y cabecera;
  - un `update` por fila y un `createMany` para las nuevas.
  - Timeout de 30 s.
- **Sin efectos de inventario.**
  - No se toca kardex ni reservas.
  - Las reservas del destino ya están `ACTIVE`.
  - Las del origen quedaron liberadas por la anulación del pedido.
  - El comprobante no despacha.

### 3.6 Endpoints e interfaz

**API** (todo administrador), junto a los de D-378 en `invoicing.controller.ts`:

- `GET /invoicing/orders/:id/movable-annulled-documents`
  - Candidatos para el pedido destino: manuales anulados del mismo cliente (decisión 1) cuyo pedido
    está anulado (decisión 2).
  - De solo lectura y **sin locks**: las mismas comprobaciones con `lock = false`, como
    `annulledOfOrder`.
  - Devuelve, por candidato, el motivo si no se puede.
  - **Con tope y presupuesto de consultas verificado por test** (§3.4 de `AGENTS.md`). Cada
    candidato corre las comprobaciones completas, unas 17 consultas. El listado se limita a los
    últimos 20 anulados del cliente, y el test fija cuántas consultas cuesta.
  - El botón del pedido no puede usar `annulledDocumentCount`, que cuenta solo los anulados del
    propio pedido. Se pide este listado al abrir el diálogo, no al pintar el detalle.
- `GET /invoicing/documents/:id/move-to-order/:targetOrderId/preview`
  - Mismos bloqueos y locks que la ejecución, no escribe.
  - Devuelve el antes y el después, y las advertencias de §4.3.
- `POST /invoicing/documents/:id/move-to-order` con
  `{ targetSalesOrderId, reason, confirmMatchesPaper, paperTotalPen }`. El esquema Zod extiende
  `reactivateWithOrderLinesSchema`.

**Auditoría de pedidos.** Además de la fila del comprobante, se escribe una fila por pedido:

- `sales.order.document-moved-out` en el origen;
- `sales.order.document-moved-in` en el destino.

Así el historial de cada pedido cuenta qué pasó sin buscarlo en el comprobante. Si el dueño prefiere
una sola fila, se quitan; no cambia nada más.

**Web:**

- **Detalle del pedido destino.** En la sección de comprobantes, un botón «Traer comprobante anulado»
  visible para el administrador. Se deshabilita con su motivo si el pedido tiene un comprobante vivo
  o un borrador; el motivo dice cuál eliminar.
- **El diálogo** reutiliza `reactivate-with-order-lines-dialog.tsx`. Paso 1: elegir el candidato (si
  hay uno solo, ya viene elegido). Paso 2: la vista previa con el antes y el después, el total
  tipeado, la casilla y el motivo.
- **Detalle del comprobante anulado** (`comprobante-detalle-view.tsx`). Cuando su pedido está
  anulado, en vez de las dos reactivaciones deshabilitadas, un aviso: «Su pedido está anulado: para
  llevarlo a otro pedido, abre el pedido correcto y usa “Traer comprobante anulado”». No se agrega
  un buscador de pedidos ahí, porque la acción nace del pedido correcto.

## 4. Decisiones del dueño

### 4.1 ¿Se permite que cambie el cliente?

**Recomendación: no.** El destino tiene que ser del mismo cliente que el comprobante; si no, bloquea.

- El cliente de una factura es el RUC del papel y no se corrige: una factura a otro RUC se anula en
  SUNAT y se emite otra.
- Si el ERP moviera el comprobante a otro cliente, mostraría una cuenta por cobrar que el papel no
  respalda.
- D-378 ya bloquea el caso parecido («el pedido cambió de cliente»), con el mismo razonamiento.
- En 1389 los dos pedidos son del mismo cliente: el bloqueo no molesta.

La alternativa sería permitirlo solo en una boleta a «público en general» que pase a un cliente con
documento. No se recomienda hasta que aparezca un caso.

### 4.2 ¿Se permite cuando el pedido de origen NO está anulado?

**Recomendación: no, en esta versión.**

- **Si el origen está vivo y el problema es su contenido**, el camino es D-378: corregir el pedido y
  reactivar con sus líneas. Es más simple y no deja un pedido vivo sin facturar.
- **Si de verdad hay dos pedidos vivos y el comprobante cayó en el equivocado**, mover el
  comprobante deja el origen vivo, con reservas activas y sin comprobante. Habría que decidir qué
  pasa con él: ¿se anula?, ¿se factura con otro papel? Eso es política nueva sin un caso real
  delante.

Lo que se pide es que el dueño anule primero el pedido de origen. La anulación del pedido ya libera
reservas y cancela OPs en borrador, con sus propios bloqueos.

### 4.3 ¿Qué pasa con la fecha si el pedido nuevo es posterior al comprobante?

**Recomendación: se permite, se conserva la fecha del papel, y el modal lo avisa.**

- **No es una situación nueva.** Hoy ninguna regla compara la fecha del comprobante con la del
  pedido. PED-000044 (2026-09-28) ya era posterior a 1389 (2026-08-20), porque los manuales de
  agosto se registraron en septiembre.
- **La fecha del papel no se puede cambiar.** El comprobante anulado no admite corrección de fecha
  (`invoicing.service.ts:1405`), y la fecha que vale es la del papel.
- **Tampoco se cambia la fecha del pedido**: es la fecha comercial de la venta en el ERP.
- **El aviso del modal**: «El comprobante (20/08/2026) es anterior al pedido (01/10/2026)». No
  bloquea. Queda en la auditoría (`after.issueDate` y `after.orderIssueDate`).
- **Consecuencia a vigilar, que no bloquea.** «Despachar a la fecha del comprobante» (D-364/D-278)
  despacharía PED-000056 con fecha **2026-08-20**. Si a esa fecha el kardex no tenía stock de algún
  producto, aparece el negativo de D-374 (`docs/analisis/despacho-pre-inventario-2026-10-01.md`).
  Esa comprobación ya vive en el despacho y no se duplica aquí.

## 5. Estimación y migración

**Sin migración.** Todo se escribe sobre columnas que ya existen:

- `fiscal_documents.sales_order_id`;
- `fiscal_document_items.sales_order_item_id` y las de importe;
- `audit_log`.

Ningún CHECK cambia:

- `annulled_trace_ck` se cumple al limpiar `annulled_at` junto con el estado, como D-373;
- el número no se toca, así que el índice único parcial tampoco.

**Estimación: una sesión de implementación del tamaño de cc13, más su ventana.**

| Pieza                                                                                                                     | Esfuerzo              |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `pairRowsToOrder` (puro) y unitarios: emparejado por producto, cambio de producto, sobrantes, bloqueo por falta de líneas | ~0,25 sesión          |
| Servicio: plan, vista previa, ejecución, candidatos, locks con dos pedidos y auditoría; unitarios de cada bloqueo de §3.3 | ~0,5 sesión           |
| Web: botón en el pedido, diálogo con paso de elección (reutiliza D-378) y aviso en el detalle del comprobante             | ~0,25 sesión          |
| E2E (un spec, en el molde de `reactivar-con-lineas-d378.spec.ts`), autorrevisión, segundo modelo, UAT en demo             | el resto de la sesión |

**El uso en 1389, después del deploy, en este orden:**

1. Confirmar que el papel de Nubefact es por las siete líneas (§1.4).
2. Confirmar el vendedor.
3. Eliminar el borrador de PED-000056.
4. Tomar el respaldo Neon.
5. Ejecutar «Traer comprobante anulado» por la interfaz y sacar la foto posterior.

## 6. Resumen de lo que se pide al dueño

1. **Cliente:** ¿bloquear si el destino es de otro cliente? (Recomendado: sí.)
2. **Origen vivo:** ¿exigir que el pedido de origen esté anulado? (Recomendado: sí.)
3. **Fecha:** ¿conservar la fecha del papel, con aviso y sin bloqueo? (Recomendado: sí.)
4. **Datos de 1389:**
   - ¿el papel vigente en Nubefact es por las siete líneas de PED-000056?
   - ¿qué vendedor es el correcto?
5. **Número D-381:** confirmarlo.
