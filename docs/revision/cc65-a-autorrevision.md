# cc65-a — Autorrevisión (D-697: el mostrador vende la cobertura terminada en stock)

> **Autorrevisión.** La hizo un subagente nuevo que no leyó el handoff de implementación. Es
> **una lista de riesgos, no una aprobación**, y no cuenta como pase cruzado (AGENTS.md §2.2).

- Rama: `cc65-accesorio-higiene`, commit `345bb280` (`git diff origin/main...HEAD`, 10 archivos).
- Alcance revisado: `pos.service.ts`, `sales-lines.ts`, `sales-orders.service.ts` (createDirectInTx,
  productStock), `sales-order-edits.service.ts` (lockEditable), `pos-view.tsx`, `stockPanelQuerySchema`,
  las pruebas nuevas, y los caminos que vienen después: despacho y su reversa, `voidSale`, anular el
  pedido, restaurar la reserva (D-379), NC con devolución, revertir el reporte y cerrar la OP de
  coberturas, la cola o las líneas sin OP, «Ventas y margen», «Rentabilidad» y «Ventas por material».
- No se corrió ninguna prueba: la revisión es de lectura.

## Resumen

| Id   | Sev | Tema                                                                                                                                             |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-01 | P2  | «Rentabilidad» deja sin costo la línea de cobertura del mostrador, y «Ventas y margen» sí la costea                                              |
| A-02 | P2  | Una venta de mostrador del mismo SKU bloquea la reversa de reportes de OP anteriores                                                             |
| A-03 | P2  | Textos que ahora mienten: «ni el mostrador toma lo fabricado suelto»                                                                             |
| A-04 | P3  | La clave de React Query del panel del POS no incluye `counter`                                                                                   |
| A-05 | P3  | Pruebas: la de «no se edita» no aísla el candado nuevo; la de «reservado» no usa una reserva de OP; la del accesorio no se puede volver a correr |
| A-06 | P3  | JSDoc de `findProducts` desactualizado                                                                                                           |

**No encontré nada P0 ni P1.** No hay escritores nuevos del kardex (regla 8): la salida va por
`dispatches.createInTx` → `record()`, y la vuelta por `dispatches.reverse`. Las tres preguntas de la
regla 13 siguen separadas: la respuesta nueva vale para la línea (`byLength`/`madeToOrder` con
`!fromStock`) y no cambia `detailsLengths`, `isMadeToOrder` ni `sellsByLength`. El orden de bloqueos
(regla 17) no cambia: la línea reserva `PRODUCT` por `reserveLines` → `lockAvailability`, la misma
puerta que ya usaban los perfiles y el trading.

## Lo que se comprobó y está bien

- **`counterSale` lo usa un solo llamador**: `pos.service.ts:270`. `fromFinishedStock` solo se
  activa en `sales-orders.service.ts:1433`. Cotizaciones, pedidos directos, confirmación y OP no lo
  reciben, y siguen con `RAW_MATERIAL` (`finished-stock-line.spec.ts` lo cubre para el accesorio y el
  a medida).
- **El cinturón de `createDirectInTx`** (`:1464-1475`) sigue en pie y ahora pasa por el motivo
  correcto: la línea trae `PRODUCT`, el propio producto y `pieces: []`.
- **Lo reservado a una OP no se vende, ni con carreras.** El reporte de producción hace el `IN`
  (`record`, que bloquea el saldo) y el `upsertItemReservation` en la misma transacción
  (`roofing-production.service.ts:1449-1502`). El mostrador bloquea el saldo y **después** lee las
  reservas (`inventory.service.ts:1466-1467`). En READ COMMITTED, el que espera el candado ve lo que
  el otro ya confirmó. El sobrante por encima de lo prometido (`toReserve = min(output, promised −
held)`) queda libre a propósito, y es justo lo que D-697 quiere vender.
- **Despacho**: `resolveDispatchTarget` toma la línea como `backedByProduct` y no entra en la rama
  «se fabrica contra el pedido» (`reservation-transfer.ts:196-238`). `reserveQty` se prorratea 1:1.
- **Reversa del despacho / `voidSale`**: devuelve el stock al costo de la salida y restaura la
  reserva `PRODUCT`. Después `salesOrders.cancel` la libera. `fabricatedLooseLines` solo mira los
  reportes de OP, así que no hay casilla. El db-spec lo cubre con el a medida.
- **Restaurar la reserva (D-379)**: `isFabricatedLineReservation` deja fuera la línea respaldada por
  su producto. La línea del mostrador se trata como una plancha de stock, y `restoreReservation`
  vuelve a comprobar el disponible con candado (`sales-orders.service.ts:2948-2961`).
- **Líneas sin OP / cola**: `findLinesWithoutOrder` filtra `itemType: RAW_MATERIAL`
  (`sales-orders.service.ts:3247`), así que el pedido del mostrador no aparece como «por fabricar».
- **Ventas por material**: la línea entra al motor, sin OP y con despacho, y sale como
  `DESDE_STOCK` (`sales-by-material.ts:266-268`). Queda marcada y no se cuenta dos veces. El
  sobrante de una OP vendido por mostrador no duplica costo con el pedido original, porque su línea
  se prorratea por `facturado ÷ producido` (`:358-361`).
- **Filtro Prisma de `findProducts`** (`pos.service.ts:148`): `AND: [{ OR: [roofingKind ≠ null,
unit ≠ MTR] }]`, junto al `OR` de la búsqueda, da «(cobertura o no-MTR) y (sku o nombre)». Es
  correcto: sin el `AND`, la búsqueda habría pisado el `OR`. D-098 se mantiene para un producto en
  MTR que no es cobertura, y el E2E `fase7b-bordes` lo sigue sembrando y comprobando.
- **Costos y vendedor**: el panel con `counter=1` devuelve lo mismo que antes para cualquier rol:
  `atCostPricePen` solo para ADMINISTRADOR (`:4087-4095`) y el piso `minValuePen` como en D-643.
  `findProducts` no expone costo. La venta usa `showCost: actor.role === ADMINISTRADOR`. No hay fuga
  nueva.
- **Pedido del mostrador no editable**: `lockEditable` corta antes de volver a resolver líneas
  (`sales-order-edits.service.ts:1807`). Cubre precio, bobina, cliente, agregar ítems y cantidades,
  incluido el estado intermedio de un `voidSale` a medias (comprobante dado de baja y pedido todavía
  CONFIRMED), que antes de cc65 sí se podía editar y habría convertido la línea en una que se fabrica.

## Hallazgos

### A-01 (P2) — «Rentabilidad» no costea la línea de cobertura del mostrador

- **Dónde**: `apps/api/src/reports/document-profitability.ts:181-226` (`engineLine`), con
  `sales-by-material.ts:266-268` (`DESDE_STOCK`). No cambió en el diff: cambió lo que le llega.
- **Escenario**: un VENDEDOR vende por caja 1 m de accesorio sobrante, que sale del kardex a
  S/ 7.94. En «Ventas y margen» el pedido muestra costo 7.94: `withEngineCosts` solo reemplaza las
  filas que el motor costeó y deja la del despacho (lo asegura el db-spec). En «Rentabilidad» del
  mismo comprobante, la línea entra al motor porque es Metallic Roofing, no tiene OP y sale
  `UNTRACEABLE` («desde stock»), con `uncostedSalesPen` igual a la venta y costo cero. Los dos
  reportes dan cifras distintas para la misma línea, que es lo que cc55 (D-667) buscaba evitar.
  Hasta cc65, `DESDE_STOCK` era un borde (stock heredado). Con D-697 pasa en cada venta de cobertura
  por caja.
- **Recomendación**: en `engineLine`, si la línea sale `DESDE_STOCK` (sin OP y despachada), caer a
  `dispatchLine`, que es el costo del kardex que ya usa «Ventas y margen». Si no, que el dueño decida
  si se acepta como está (D-nnn), y sumar al db-spec una aserción sobre `DocumentProfitability`.

### A-02 (P2) — Una venta de caja bloquea la reversa de reportes anteriores del mismo SKU

- **Dónde**: `apps/api/src/production/roofing-production.service.ts:2620-2635`. La reversa del
  reporte se rechaza si existe **cualquier** salida viva del producto con `id` posterior al ingreso
  del reporte.
- **Escenario**: la OP-A reporta 10 m del accesorio canónico `ACC…040GRIS`, que es un SKU
  compartido por todos los pedidos de ese espesor y color. Después, la caja vende 1 m de un sobrante
  viejo del mismo SKU. Planta quiere revertir el reporte de OP-A (lo hace a menudo, por un largo mal
  cargado) y recibe «Las planchas de este reporte ya se movieron (OUT SALE): anula ese movimiento
  antes de revertir el reporte». La única salida es anular una venta de caja ajena, que además solo
  se puede dentro del turno abierto. Antes de cc65, las salidas de cobertura eran despachos del
  propio pedido o mermas. Ahora hay una clase nueva y frecuente de bloqueo.
- **Recomendación**: que el dueño decida (regla 16). Hay dos opciones: aceptarlo y avisarlo en
  el guion UAT, o afinar el bloqueo para que solo mire las salidas que consumen más de lo que había
  libre antes del reporte. La segunda es más trabajo y toca la regla 8. No hay que arreglarlo en
  esta pieza sin decisión.

### A-03 (P2) — Textos que ahora mienten sobre lo fabricado suelto

- **Dónde**:
  - `apps/api/src/sales/order-cancel-checks.ts:376`: «Lo fabricado contra pedido no lo toma ningún
    otro pedido **ni el mostrador** hasta revertir la producción.»
  - `apps/web/src/components/sales/cancel-order-dialog.tsx:136`: el mismo aviso en el diálogo de
    anular.
  - `packages/shared/src/schemas/sales.ts:1208` y `apps/api/src/invoicing/sales-returns.service.ts:49`
    (comentarios: «hoy ningún otro pedido ni el mostrador toma ese stock»).
- **Escenario**: un ADMINISTRADOR anula un pedido con 20 m fabricados sin despachar, marca la casilla
  porque el texto le promete que ese stock queda quieto hasta revertir la OP, y en la tarde la caja lo
  vende. Revertir la producción (para devolver los kilos a la bobina) ya no se puede (A-02), y el
  aviso que firmó era falso. Pasa lo mismo con lo que vuelve por una NC con devolución: ahora se
  puede revender por caja, y anular esa NC sale con 409.
- **Recomendación**: corregir los cuatro textos, del estilo «queda como stock libre: lo puede vender
  el mostrador; si quieres revertir la producción, hazlo antes». Si el dueño prefiere que lo
  fabricado para un pedido anulado no se venda por caja, eso es otra regla y pide decisión.

### A-04 (P3) — La clave del panel del POS no distingue `counter`

- **Dónde**: `apps/web/src/app/(app)/pos/pos-view.tsx:236`, `['stock-panel', '', ids]`. El
  formulario de cotización usa `['stock-panel', panelBusinessLine, ids]`
  (`sales-document-form.tsx:810`).
- **Escenario**: si alguna vez el formulario pide el panel con `panelBusinessLine === ''` y los
  mismos ids, las dos pantallas comparten caché. El POS mostraría el piso por metro y el agregado de
  bobina, o la cotización el piso por unidad. Hoy es poco probable, porque una línea con producto
  trae línea de negocio, pero es frágil.
- **Recomendación**: `queryKey: ['stock-panel', 'counter', ids]`. Las invalidaciones por prefijo
  `['stock-panel']` siguen funcionando.

### A-05 (P3) — Lo que las pruebas aseguran y lo que no

- `pos-finished-stock.db-spec.ts:293-305` («no se edita»): la expresión `/mostrador|comprobante/`
  también la satisface la regla de antes (el pedido tiene comprobante vivo), así que la prueba pasa
  sin el candado nuevo. Para probarlo de verdad hay que llevar el pedido al estado en que solo el
  candado lo frena (comprobante `VOIDED` por fixture y pedido CONFIRMED) y esperar exactamente «nació
  en el mostrador».
- `:272-291` («lo reservado no se vende»): la reserva la crea otro `createDirectInTx` con
  `counterSale`, una reserva `PRODUCT` de línea respaldada por su producto. No cubre el caso que
  pide la tarea: producto fabricado por una OP y reservado a otro pedido (`reserveItemType =
RAW_MATERIAL` en la línea y reserva `PRODUCT` aparte). El mecanismo (`reservedQty` por `itemId`) es
  el mismo, así que el riesgo es bajo, pero vale un caso con `upsertItemReservation` sobre una línea
  `RAW_MATERIAL`.
- `:130-160` (`leftover`): los accesorios usan el SKU canónico y lo reutilizan si ya existe
  (`existing?.id`). Sobre una base que no se resetea, la prueba de `:263` (espesor 0.37, nunca se
  vende) suma otro 1.000 en cada corrida y la aserción `qty: '1.000'` falla en la segunda. Además
  puede chocar con un accesorio sembrado (seed:escenarios) del mismo espesor y color. Conviene usar
  un color propio de la prueba o leer el saldo antes y comparar diferencias.
- `stock-panel-batch.spec.ts:151-158`: solo comprueba los `null`. No asegura que con `counter` el
  piso salga por unidad y del costo del producto (`basis: UNIT`, `cost.kind: PRODUCT`), que es lo
  que el cajero ve.
- Falta una aserción sobre «Rentabilidad» (A-01).

### A-06 (P3) — JSDoc de `findProducts`

- **Dónde**: `apps/api/src/pos/pos.service.ts:112-118`. Todavía dice «Se excluye la unidad `MTR`
  porque es la marca de una cobertura a medida (D-083)». Desde D-697 la cobertura en MTR sí se
  ofrece. Hay que ponerlo al día con el comentario de `:141-148`.

## Fuera de alcance, para que conste

- **Un despunte de OP que se cierra después de una venta de caja** reparte su `ADJUST` sobre el saldo
  que quedó. Ya pasaba antes con los despachos del pedido; con más salidas del mismo SKU, el
  promedio de lo que queda se mueve más. No es un defecto de cc65.
- **Venta fraccionaria de una plancha (NIU)**: el esquema del POS admite cantidades con tres
  decimales y nada obliga a que la plancha sea entera. Ya pasaba con los perfiles de drywall en NIU.
  Se anota por si el dueño quiere una regla para la plancha.

## Respuesta del autor

- **A-01 (corregido):** «Rentabilidad» costea por la salida de su despacho la línea del motor que se sirvió solo desde stock
  (`stockOnlyEngineRows`), como «Ventas y margen»; el servicio carga los despachos también en ese caso, sin consulta extra
  en los demás. Prueba unitaria y aserción en `pos-finished-stock.db-spec.ts`.
- **A-02 (sin cambio, queda anotado para el dueño):** revertir un reporte de OP se rechaza si hay una salida posterior
  del mismo SKU. No es nuevo de D-697 (cualquier despacho posterior del mismo SKU ya lo bloquea), pero la venta de caja de
  un sobrante es un caso más. La salida es anular esa venta de caja antes de revertir.
- **A-03 (corregido):** el aviso de anular pedido (API y diálogo) y los dos comentarios dicen que lo fabricado suelto se
  puede vender en el mostrador.
- **A-04 (corregido):** la clave de caché del panel de la caja lleva `counter`.
- **A-05 (parcial):** el caso de la reserva de producto terminado que abre una OP no tiene prueba propia; queda anotado
  como riesgo en el handoff. El bloqueo de edición sigue probado por su mensaje.
- **A-06 (corregido):** el comentario de `findProducts`.
