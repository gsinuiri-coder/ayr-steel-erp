# Corregir un comprobante manual mal emitido

> Manual del **administrador**. Vale para comprobantes **manuales**: los que se emiten en Nubefact
> desde la otra app y se cargan en el ERP con «Registrar manual». Para el ERP ese comprobante ya
> existe ante SUNAT, y el ERP nunca habla con SUNAT por él.
>
> Verificado contra el código de `main` en `cdcd4cc` (2026-10-01), solo leyendo código: no se
> ejecutó nada. Lo que es una deducción y no está comprobado en el código va marcado **(inferido)**.
> El hueco H1 se confirmó además buscando la ruta en el API: no existe.

## 1. Propósito

Este manual explica cómo dejar el ERP en orden cuando un comprobante manual quedó mal. Hay tres
situaciones:

| Caso | Qué pasó                                                                                   | Qué se hace en el ERP                                                                        |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1    | El papel estuvo mal (serie, número, fecha, tipo, cliente), pero **la venta es la misma**    | Se **anula internamente** y se registra el comprobante correcto sobre el **mismo pedido**    |
| 2    | **Cambió la venta**: precio, cantidad o producto                                           | Se anula, se **edita el pedido** y se factura de nuevo                                       |
| 3    | El error fue **anular** un comprobante que sí era válido                                   | Se **reactiva** (D-373)                                                                      |

Tres cosas que conviene saber desde el principio:

- **El comprobante no mueve inventario: lo mueve el despacho.** Anular o reactivar un comprobante no
  toca el kardex, las reservas ni los despachos.
- **Anular internamente no comunica nada a SUNAT.** La baja o la nota de crédito del papel se hacen
  en Nubefact. En el ERP solo se refleja lo que ya pasó allá.
- **Un número anulado sigue ocupado.** El comprobante correcto tiene que llevar otra serie o
  correlativo. Si se intenta registrar con el mismo número, el ERP lo rechaza, y está bien que lo
  haga.

## 2. Antes de empezar: qué revisar

Abra el comprobante en **Comprobantes → (el comprobante)** y revise:

1. **Cobros.** Con algún cobro vigente, la anulación se rechaza.
   - Primero hay que **revertir cada cobro**: menú del cobro → «Revertir», con motivo.
   - Un cobro **no se traslada** a otro comprobante: no existe esa acción. Después de registrar el
     comprobante correcto, se vuelve a cargar el cobro ahí. Como administrador puede ponerle la fecha
     original.
   - Con cobros vigentes, la opción «Anular internamente» **desaparece del menú sin dar
     explicación** (hueco H6).
2. **Notas de crédito.** Si tiene una nota de crédito manual viva, primero se anula esa nota
   internamente. Una nota de crédito **no se reactiva** después.
3. **Despachos.** Mire el enlace de despacho del comprobante y el pedido:
   - ¿La mercadería ya salió? Es decir, ¿hay un despacho `DES-…` vigente?
   - ¿El despacho aparece como **propio** del comprobante («DES-…») o solo como
     **«Del pedido: DES-…»**?

   Esto define qué hacer con el despacho (§6).
4. **Otros comprobantes y borradores del pedido.**
   - Para **editar el pedido** (caso 2) no puede quedar **ningún** comprobante ni borrador de factura
     o boleta en pie en ese pedido.
   - Para **reactivar** (caso 3) no puede haber borradores sobre las mismas líneas.

> **Alternativa a la anulación.** Si en Nubefact el papel se corrigió con una **nota de crédito**, en
> el ERP lo correcto es registrar esa nota manual («Nota de crédito» → borrador → «Registrar
> manual»), no anular. Lo que la nota acredita vuelve a quedar pendiente de facturar.

## 3. Caso 1: el papel estuvo mal y la venta es la misma

### Pasos

1. **En Nubefact**, haga primero la corrección del papel (baja o reemplazo).
2. Si hay cobros, **reviértalos** (§2.1). Si hay notas de crédito manuales vivas, **anúlelas
   internamente**.
3. En el comprobante equivocado, menú **«⋯» → «Anular internamente»**. Escriba el motivo y confirme.
   - El comprobante queda **Anulado**, con saldo cero, y sale de cuentas por cobrar y de los reportes
     de ventas.
   - Las líneas del pedido vuelven a quedar «por facturar».
4. Si existe un despacho, decida qué hacer con él (§6). **Lo recomendado es no tocarlo.**
5. Desde el pedido, **«Emitir comprobante»**, o **Comprobantes → Nuevo** eligiendo el pedido. La
   pantalla propone facturar todo lo pendiente.
   - El campo **«Despacho que factura»** debería permitir elegir el despacho del comprobante
     anterior, pero **hoy no aparece** (hueco H1).
6. En el borrador, **«Registrar manual»** con la **serie y el correlativo del papel correcto**.

### Qué pasa con cada cosa

- **Reservas:** no cambian. Si la mercadería ya salió, la reserva ya está consumida y sigue así.
- **Cobros:** se cargan de nuevo sobre el comprobante nuevo.
- **Despacho:** si no lo toca, el kardex queda bien y **no se descuenta dos veces**. El comprobante
  nuevo ve sus líneas como despachadas y no ofrece despacharlas. Pero el despacho **sigue enlazado al
  comprobante anulado** (§6 y hueco H2).

## 4. Caso 2: la venta cambió (precio, cantidad o producto)

### Qué se puede editar en un pedido confirmado (D-187)

| Edición                       | Dónde                      | Quién                          | Bloqueos propios                                                                                                                                                                                                  |
| ----------------------------- | -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Precio** de una línea       | Pedido → línea → «Precio»  | Solo administrador             | Pasa por el piso de precio (salvo pedido importado). **Se puede aunque la línea ya esté despachada.**                                                                                                            |
| **Cantidad** de una línea     | Pedido → línea → «Cantidad» | Administrador o vendedor dueño | **No se puede con un despacho vigente en la línea.** Tampoco con OP cerrada o con reportes, material fabricado reservado, faltante o material consumido. Una bobina entera no cambia de cantidad.                 |
| **Bobina** (venta de bobina)  | Pedido → línea → «Bobina»  | Administrador o vendedor dueño | No se puede con un despacho vigente en la línea.                                                                                                                                                                 |
| **Agregar ítems**             | Pedido → «Agregar ítems»   | Administrador o vendedor dueño | —                                                                                                                                                                                                                 |
| **Cliente**                   | Pedido → «Cambiar cliente» | Solo administrador             | —                                                                                                                                                                                                                 |

Todas exigen además que el pedido **no tenga ninguna factura ni boleta en pie**, ni borrador ni
viva. Una anulada ya no cuenta.

> **No hay edición para cambiar el producto** de una línea común (salvo atar una venta de bobina a
> otra bobina) **ni para quitar una línea**. Si cambió el producto, consulte con el dueño antes de
> seguir (hueco H7).

### Pasos

1. Revierta los cobros y anule las notas de crédito manuales vivas.
2. **Anule internamente** el comprobante equivocado. Si el pedido tiene otros comprobantes o
   borradores de factura o boleta, anúlelos o descártelos: con uno solo que quede, la edición se
   rechaza.
3. **Solo si cambia la cantidad (o la bobina) de una línea ya despachada:** vaya al despacho →
   «⋯» → **«Revertir despacho»**, con motivo y fecha de operación.
   - La reversa devuelve el material al kardex y **restaura la reserva** del pedido.
   - Lea §6 antes de elegir la fecha.
   - Si solo cambia el **precio**, no revierta el despacho.
4. Edite el pedido. Al cambiar la cantidad, el sistema **libera la reserva vigente y reserva la
   cantidad nueva**. Si no alcanza el stock, no cambia nada.
5. **«Emitir comprobante»** → **«Registrar manual»** con el número del papel nuevo.
6. Si revirtió el despacho, en el detalle del comprobante nuevo aparece **«Este comprobante tiene
   líneas facturadas sin despacho registrado»**. Elija la fecha y use **«Despachar en la fecha
   seleccionada»**. El despacho queda **enlazado al comprobante nuevo** y consume la reserva.
7. Cargue de nuevo los cobros sobre el comprobante nuevo.

## 5. Caso 3: la anulación fue el error (reactivar)

### Requisitos

- Es una **factura o boleta**, manual o importada.
- Está **anulada** y no archivada.
- La reactiva un **administrador**.

### Pasos

1. Si después de anular se creó un borrador de reingreso sobre las mismas líneas, **elimínelo
   primero**: detalle del borrador → «Descartar borrador».
2. En **Comprobantes**, active el chip **Anulados** y en la fila del anulado use el menú **«⋯» →
   «Reactivar»**.
3. Escriba el motivo y marque **«Confirmo que este comprobante sigue vigente en Nubefact/SUNAT (no se
   comunicó su baja)»**.
4. Confirme. El comprobante vuelve a **Aceptado**, con su deuda y sus líneas facturadas.

### La reactivación se rechaza si, mientras estuvo anulado

- se registraron cobros sobre él, o tiene cobros vigentes;
- tiene notas de crédito vivas o creadas después de anularlo;
- otro comprobante vivo ya volvió a facturar esas líneas (el mensaje lo nombra);
- hay borradores sobre las mismas líneas;
- el pedido se anuló o se cambiaron **precio, importes del papel, bobina o cantidad** de una línea
  que el comprobante cubre;
- tiene rastro de envío al PSE o de baja.

### Qué pasa con cada cosa

- **Reservas, kardex y cobros:** no se tocan. Reactivar solo restaura el estado.
- **Despacho que siguió vigente** mientras estuvo anulado: sigue enlazado y no hay nada pendiente.
  El aviso «queda pendiente de despacho» aparece igual, aunque no sea cierto (hueco H5).
- **Despacho que se revirtió** mientras estuvo anulado: las líneas quedan pendientes y el aviso
  ofrece despacharlas. Lea §6: hay riesgo de **contar dos veces la salida** entre esa fecha y la de
  la reversa.

## 6. Qué pasa con el despacho en cada caso

Cómo funciona por dentro (verificado):

- **El enlace despacho → comprobante** se escribe en tres momentos:
  - al crear el comprobante declarando el «Despacho que factura»;
  - en el mostrador;
  - con «Despachar a la fecha del comprobante».
- **Anular internamente no suelta ese enlace. Revertir el despacho sí lo suelta.**
- **Lo «pendiente de despacho»** de un comprobante se calcula con **todo lo despachado vigente de la
  línea del pedido, esté enlazado a quien esté**. **Por eso el comprobante nuevo nunca vuelve a pedir
  el despacho de lo que ya salió**, y por esta vía no hay doble descuento.
- **Un despacho no se puede revertir** mientras un comprobante vivo del pedido facture sus líneas.
  El orden es: anular primero, revertir después y registrar el nuevo al final.
- **La reversa restaura la reserva** y recalcula el estado del pedido.

| Situación                                                    | Kardex                    | Enlace del despacho                                     | Aviso «sin despacho registrado» en el nuevo |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Caso 1, despacho intacto (recomendado)                       | Correcto: una sola salida | Queda en el **anulado**; el nuevo muestra «Del pedido: DES-…» | No aparece                                   |
| Caso 1 declarando «Despacho que factura» (cuando se arregle H1) | Correcto                  | Pasa al **nuevo**                                       | No aparece                                   |
| Caso 1 o 2, despacho revertido y rehecho                     | Ver el riesgo de fecha    | El despacho nuevo queda enlazado al comprobante nuevo   | Aparece hasta despachar                      |
| Caso 2, cambia solo el precio                                | Igual que el caso 1 intacto | En el anulado                                         | No aparece                                   |
| Caso 3, despacho intacto                                     | Correcto                  | Sigue en el reactivado                                  | No aparece                                   |
| Caso 3, despacho revertido mientras estuvo anulado           | Ver el riesgo de fecha    | Ninguno hasta despachar                                 | Aparece, con la fecha del comprobante sugerida |

### Riesgo de fecha al revertir y rehacer un despacho

- La reversa sale con la fecha de **hoy** por defecto. Para darle una fecha pasada, el ítem no puede
  tener movimientos posteriores.
- Si después se despacha otra vez **a la fecha del comprobante**, que es anterior, entre esa fecha y
  la de la reversa el kardex muestra **dos salidas por una sola mercadería**.
  - Si eso deja algún día negativo, la línea queda «No se despacha».
  - Si **no** deja negativo, **pasa sin aviso** y el stock de los meses intermedios queda
    subestimado (hueco H3).

> **Recomendación mientras tanto.** Si la mercadería no volvió físicamente, **no revierta el
> despacho**. Si tiene que revertirlo y rehacerlo porque cambia la cantidad, elija como **fecha del
> nuevo despacho la misma fecha de la reversa**, no la del comprobante.

## 7. Mensajes que verá

| Mensaje                                                                                     | Qué hacer                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| «El comprobante tiene cobros vigentes: revierte los cobros antes de anularlo»               | Revierta los cobros (§2.1).                                                                                |
| «El comprobante tiene notas de crédito vivas (…): anúlalas primero»                         | Anule internamente las notas manuales.                                                                     |
| «Ya hay un comprobante registrado con el número …»                                          | El número está ocupado, también por un anulado. Use el del papel nuevo, o **reactive** si es el mismo papel. |
| «Otro comprobante ya facturó la línea N del pedido: quedan …»                               | Otro comprobante ya tomó esas líneas.                                                                      |
| «El pedido ya tiene comprobante (…): no se puede … Corrige con una nota de crédito.»        | Queda una factura o boleta, o un borrador, en pie en el pedido. Anúlela internamente o descarte el borrador. |
| «Línea N: ya tiene despachos, así que su cantidad no se cambia…»                            | Revierta el despacho primero, o agregue un ítem con la diferencia.                                         |
| «El comprobante … todavía factura líneas de este despacho: dalo de baja…» (al revertir el despacho) | Para un manual, **anúlelo internamente** primero (hueco H6).                                       |
| «La fecha … queda ANTES de N movimiento(s) …» (al revertir con fecha pasada)                | Use la fecha de hoy (§6).                                                                                  |
| «Hay N borrador(es) de comprobante sobre las mismas líneas…»                                | Descarte el borrador del reingreso.                                                                        |
| «La línea N del pedido ya se volvió a facturar en …»                                        | Ya hay un reemplazo. Decida cuál queda.                                                                    |
| «El pedido …: la línea N se modificó … después de anular …»                                 | El pedido cambió: facture de nuevo (caso 2), no reactive.                                                  |
| «Confirma que el comprobante sigue vigente en Nubefact/SUNAT …»                             | Falta marcar la casilla.                                                                                   |
| No aparece «Anular internamente» en un manual                                               | Tiene cobros o notas de crédito vivas (hueco H6).                                                          |

## 8. Huecos conocidos y propuestas (sin implementar)

| Hueco | Qué pasa                                                                                                                                                                                                                                                                                                                                                       | Propuesta (número D-nnn a definir por el dueño)                                                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** | El selector «Despacho que factura» del comprobante nuevo pide `GET /invoicing/dispatches`, que **no existe** en el API (los despachos están en `/dispatches`). La lista queda vacía y el campo no aparece. La declaración de D-213 solo funciona por API.                                                                                                      | Corregir la ruta a `/dispatches?salesOrderId=…` y agregar un E2E por pantalla.                                                                                                                                                                                                                                   |
| **H2** | `annulExternal` no suelta el enlace del despacho y no hay forma de declararlo en un comprobante ya registrado. El PEPS imprime el comprobante **anulado** como documento de la salida, el nuevo sale **sin costo** en «Ventas y margen» y en la rentabilidad, y la inspección D-363 lo cuenta como «sin despacho declarado». El kardex está bien: no hay doble descuento. | Acción **«Declarar despacho»** en el detalle de un comprobante vivo (administrador, con motivo y auditoría): mismo pedido, despacho vigente sin enlace o enlazado a un comprobante no vivo. La anulación sigue sin soltar el enlace, para que una reactivación lo encuentre intacto.                              |
| **H3** | Revertir con la fecha de hoy y volver a despachar a la fecha del comprobante deja dos salidas en el período intermedio. Solo se bloquea si el saldo queda negativo.                                                                                                                                                                                         | **«Rehacer despacho»** con la reversa a la fecha del movimiento que anula (el modo de D-288) y el despacho nuevo en la misma transacción. Como mínimo, que el despacho rápido no sugiera una fecha anterior a la última reversa de esa línea, o que avise.                                                     |
| **H4** | D-373 no bloquea si cambió el **cliente** del pedido mientras estuvo anulado (`sales.order.customer` no está en la lista).                                                                                                                                                                                                                                  | Agregar `sales.order.customer` a los bloqueos de D-373.                                                                                                                                                                                                                                                          |
| **H5** | Tras reactivar, el aviso «pendiente de despacho» sale aunque el despacho siga vigente.                                                                                                                                                                                                                                                                     | Mostrarlo solo si el plan de despacho trae líneas.                                                                                                                                                                                                                                                              |
| **H6** | Para un manual, «Anular internamente» se oculta sin aviso cuando hay cobros o notas de crédito; el diálogo habla de «planilla»; el bloqueo de la reversa de despacho dice «dalo de baja».                                                                                                                                                                   | Ajustar los textos al origen MANUAL.                                                                                                                                                                                                                                                                            |
| **H7** | No hay edición para cambiar el producto de una línea común ni para quitarla del pedido.                                                                                                                                                                                                                                                                    | Decisión de alcance del dueño (regla 16).                                                                                                                                                                                                                                                                        |

## 9. Para soporte (referencias de código, `main` en `cdcd4cc`)

- **Anular:** `apps/api/src/invoicing/fiscal-import.service.ts`, `annulExternal`. Bloquea con cobros
  vigentes y notas de crédito vivas. Solo cambia el estado y la constancia, y no toca despachos,
  reservas ni kardex.
- **Reactivar:** `fiscal-import.service.ts`, `reactivateExternal` (D-373). La lista de ediciones que
  bloquean es `ORDER_LINE_EDIT_ACTIONS` y no incluye `sales.order.customer`.
- **Crear y registrar:** `apps/api/src/invoicing/invoicing.service.ts`.
  - `createInTx` hace el lock del pedido y maneja el despacho declarado: lo enlaza si el comprobante
    al que estaba enlazado no está vivo.
  - `registerManual`: el número es único aunque haya anulados.
  - `assertStillAvailable`.
- **Enlace despacho ↔ comprobante:** `apps/api/src/inventory/inventory.service.ts`,
  `linkInvoiceToDispatch` y el unlink. El kardex enlaza por `dispatch.invoiceId`.
- **Reversa de despacho:** `apps/api/src/invoicing/dispatches.service.ts`, `reverseInTx`.
  - Se bloquea si un comprobante vivo factura las líneas.
  - Restaura la reserva y suelta `invoiceId`.
  - `reverse` no pasa `confirmBackdate`.
- **Despacho rápido (D-364):** `apps/api/src/invoicing/invoice-dispatch.service.ts`.
  - `buildPlan` cuenta todo lo despachado de la línea, sin mirar el enlace (`allocateUndispatched`).
  - `executeInTx` enlaza el despacho nuevo.
  - `firstNegativeDate`, en `invoice-dispatch-plan.ts`.
- **Ediciones del pedido (D-187):** `apps/api/src/sales/sales-order-edits.service.ts` (`lockEditable`
  y los bloqueos por despacho) y `apps/api/src/sales/sales.controller.ts` (no hay endpoint de producto
  ni de borrar línea).
- **Cobros:** `apps/api/src/invoicing/receivables.service.ts`. Un anulado no se cobra; la reversa de
  cobro no traslada.
- **Reportes:** `apps/api/src/reports/kardex-peps.service.ts` (el número sale de
  `dispatch.invoiceId`), `document-profitability.service.ts` y `sales-margin.service.ts`.
- **Web:**
  - `apps/web/src/app/(app)/comprobantes/nuevo/nuevo-comprobante-view.tsx:127` llama a la ruta
    inexistente `/invoicing/dispatches` (H1).
  - `comprobantes/[id]/comprobante-detalle-view.tsx`: menú y textos de anular (H6).
  - `components/invoicing/reactivate-document-dialog.tsx` (H5).
  - `despachos/[id]/despacho-detalle-view.tsx`: diálogo de reversa.
