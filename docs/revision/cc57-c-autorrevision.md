# cc57-c — Autorrevisión del commit `d77ac264`

> **Autorrevisión: no vale como pase cruzado.** La hizo un subagente nuevo que no leyó el handoff
> de implementación ni `docs/revision/` de esta sesión. Es una lista de riesgos, no una aprobación.
> Solo lectura: no se corrieron tests, servidores ni bases.

Alcance: `git show d77ac264`, es decir E-03 (NC en «Ventas por material» UPVC/Reventa), E-15
(despunte en «Material de OPs»), E-16 (vendedor de Ventas y margen), E-08/E-09 (textos) y E-02
(prueba). Nota: al revisar, el worktree tenía cambios sin commitear en
`cost-basis-cc55.db-spec.ts` (se quitó el `console.warn` de E-02 y se sumaron aserciones) y en
`cobranzas-view.tsx` (el `hint` es otro). Se revisó el commit y se marca dónde el cambio sin
commitear ya cubre un punto.

## P1

### P1-1. Una NC que acredita más de lo trazado resta de la fila la venta que nunca entró en ella
`apps/api/src/reports/sales-by-product.ts:215-235`. La NC entra en la fila si la clave
(comprobante, producto) **se trazó**, aunque se haya trazado solo una parte (`fraction < 1`,
`DESPACHO_PARCIAL` o `SIN_SALIDA_KARDEX`). La NC resta su venta y su cantidad **enteras** de la fila,
y la parte no trazada sigue sumando en «No trazable».

Caso: factura de 10 u de UPVC a S/ 50, despachadas 4 (costo 4 × 20). La fila queda 4 u /
S/ 200 / S/ 80, y en No trazable hay `DESPACHO_PARCIAL` 6 u / S/ 300. NC con motivo 01
(`ANULACION_OPERACION`: acredita cantidad y devuelve solo lo despachado, `returnsStock`) por las
10 u: la fila pasa a **−6 u / −S/ 300 / costo 0** (utilidad −300), y No trazable sigue en +S/ 300.
El total de la pestaña cuadra (`lineSales` = filas + no trazable + bobinas), pero la fila del
producto muestra una venta negativa con margen negativo. En Ventas y margen el mismo pedido queda
en 0/0, así que el cuadre por fila entre los dos reportes se rompe. Lo mismo pasa con el motivo
02 (`ANULACION_ERROR_RUC`: acredita cantidad sin devolución): la fila queda con venta 0 y el costo
entero del despacho. Ver también P2-1.

Hay dos formas de arreglarlo: o la NC se aplica a la fila solo hasta lo trazado y el resto va a
No trazable, o la NC se manda a No trazable cuando la venta que acredita no se trazó entera. Los
tests no cubren este caso.

## P2

### P2-1. Motivo 02 (error de RUC): la fila carga el costo entero contra una venta neta en cero
Mismo sitio que P1-1, aunque la venta sí se haya trazado entera. La NC 02 resta toda la venta y no
tiene devolución (`return_cost` NULL → '0'), así que la fila conserva el costo del despacho. La
factura nueva al RUC correcto no la declara ningún despacho (el `invoice_id` del despacho apunta a
la vieja) y cae en `SIN_DESPACHO_DECLARADO`. El resultado es un margen fuertemente negativo en la
fila y la venta real en No trazable. Antes, la NC iba a No trazable y la fila conservaba su margen.
Hay que decidir si los motivos que acreditan cantidad sin devolver mercadería (02, y 01 sin
despacho) deben entrar en la fila.

### P2-2. El test de E-15 no prueba que hubo despunte
`apps/api/src/reports/cost-basis-cc55.db-spec.ts:263` y `:287`. Compara `opMaterialCostPen` con
`production_orders.material_cost_pen`. Si el cierre con `consumedKg = teórico + 5` no generara el
movimiento `SCRAP` (por redondeo, por cómo se calcula lo teórico con la merma del 1 %, o por
`releasedAt`), los dos lados serían el costo de los partes y el test pasaría también con el
código anterior. Falta afirmar `op.scrapKg = 5.000` (o que existe un `SCRAP` con `ref_id` = OP) y
que `opMaterialCostPen` es mayor que la suma de `production_reports.material_cost_pen`.

### P2-3. El test de E-02 en el commit podía pasar con null = null y dejaba un `console.warn`
`cost-basis-cc55.db-spec.ts:337-343` (versión del commit). `expect(doc?.costPen).toBe(profit.total.costPen)`
pasa si los dos son `null`. El cambio sin commitear ya fija `-181.8000` y quita el `console.warn`.
Hay que confirmar que entra en el commit.

### P2-4. Vendedor (E-16): la NC de una venta directa queda a nombre de quien la registró
`apps/api/src/reports/sales-margin.service.ts:175-177`. La NC copia el `salesOrderId` de la
factura (`invoicing.service.ts:1564/1609/1904`). En una venta sin pedido, ese id es nulo, así que
el vendedor de la NC es su `created_by_id` (a menudo un administrador o caja), mientras la factura
queda con quien la emitió. En la vista «por vendedor» (`apps/web/src/lib/sales-margin-groups.ts`,
`ventas-margen-view.tsx:842`), la venta va a un vendedor y su NC a otro. Antes las dos caían
juntas en «Sin vendedor». En CxC la NC no es cobrable y solo baja el saldo de la factura de su
dueño, de modo que tampoco «sigue la regla de CxC» para las NC. Habría que considerar heredar el
dueño del comprobante acreditado (`affected_document_id`) para la NC.

### P2-5. Vendedor: «el Panel del vendedor» no usa COALESCE sino OR
`apps/api/src/invoicing/fiscal-document-where.ts:24-29`. El Panel del vendedor cuenta para el
vendedor «lo que creé **o** lo de mis pedidos». Si un vendedor B registra una factura del pedido
del vendedor A, cuenta para los dos en el Panel, y en Ventas y margen solo para A. El comentario
de `sales-margin.service.ts:172-174` y el commit dicen que la regla es la misma, y no lo es
exactamente. Esto es anterior al commit, pero el comentario nuevo lo da por resuelto.

## P3

### P3-1. El cruce `fd.dispatch_id` del vendedor es código muerto
`sales-margin.service.ts:175-176`. `fiscal_documents.dispatch_id` solo lo lleva la GRE
(`invoicing.service.ts:805-811`, CHECK `fiscal_documents_shape_ck`), y la consulta excluye la GRE.
`dso.seller_id` es siempre NULL. Es coherente con `documentOwnerId` (allí también es muerto para
las facturas), pero el comentario promete «el del pedido de su despacho»: una factura sin pedido
que un despacho declara (`dispatches.invoice_id`) **no** toma al vendedor de ese pedido. El test
no cubre esa rama.

### P3-2. Bucket de pedido sin vendedor: gana el creador del primer comprobante
`sales-margin.service.ts:670`. El bucket es por `sales_order_id`. Si el pedido tiene
`seller_id` NULL, cada comprobante puede tener un creador distinto, y la fila toma
`first.seller_id`. Es un caso raro, pero la atribución depende del orden.

### P3-3. «Sin vendedor» deja de existir en la práctica, y la UI y los specs lo siguen suponiendo
`apps/web/src/lib/sales-margin-groups.spec.ts:86-91` y `apps/api/src/reports/report-rows.spec.ts:373`
siguen modelando el grupo «Sin vendedor» para las ventas directas. No se rompen (usan datos
armados), pero el texto y el grupo de la vista quedan para un caso que ahora casi no ocurre.
También hay que revisar el guion UAT y la ayuda de la vista si hablan de «Sin vendedor» = ventas
directas.

### P3-4. NC de un comprobante de otro periodo: sigue en No trazable, y Ventas y margen la cuenta
`sales-by-product.ts:218`. `tracedKeys` solo conoce los comprobantes del rango. Una NC del mes
cuya factura es del mes anterior sigue en No trazable sin restar el costo de su devolución, y
Ventas y margen (D-647) sí resta ese reingreso en el periodo de la NC. El costo de la pestaña
UPVC/Reventa y el de su línea en Ventas y margen siguen sin cuadrar entre periodos. Esto es
anterior al commit, pero el comentario «como en Ventas y margen» lo sugiere resuelto.

### P3-5. Costo de la devolución frente a un recosteo posterior del despacho
`sales-by-material.service.ts:449-458`. El costo devuelto es el de `sales_return_items` más los
recosteos del **movimiento de la devolución**. Si después se recostea la salida del despacho
(D-649) y la entrada de la devolución no se recostea igual, la fila resta un costo distinto del
que sumó la venta. Habría que confirmar con el motor de recosteo (`inventory-recost.ts`) que la
DEV- sigue a su salida. Si no la sigue, la diferencia es del dominio, no de este reporte.

### P3-6. Una fila con devolución total queda con cantidad 0
`sales-by-product.ts:249-262`. Una devolución total deja la fila en 0 u / 0 / 0, con
`costPerUnitPen` null y `lineCount` 2. Se lista igual. Es menor, y conviene decidir si se
muestra.

### P3-7. `businessLine: 'trading'` con `as never` en el db-spec de E-03
`credit-note-reasons.db-spec.ts:621+`. El cast esconde un desajuste de tipo con el schema de la
consulta. Si la clave de la línea cambia, el test compila igual.

## Consumidores revisados (sin riesgo nuevo)

- **Excel de Ventas por material** (`sales-by-material-xlsx.ts:253-325`): lee las mismas
  `products.rows`, `total` y `untraceable` del DTO. Cambia junto con la pantalla, y
  `report-xlsx-totals.db-spec.ts:166-194` lo compara contra la pantalla, así que sigue verde por
  construcción. No siembra NC, de modo que no prueba E-03.
- **Excel de Ventas y margen** (`reports-xlsx.ts:251-267`): «Material de OPs» y vendedor salen del
  DTO. Sube el número con el despunte y la columna vendedor se llena en las ventas directas.
- **Panel admin** (`admin-dashboard.service.ts:36-37`) usa `salesMargin` para los totales y no lee
  `opMaterialCostPen` ni el vendedor. No cambia. `undispatched-at-close.service.ts:28` tampoco lee
  esos campos. `recost-historic.ts` compara el antes y el después del margen. Si
  `opMaterialCostPen` entra en esa comparación, una corrida histórica mostrará diferencias que no
  vienen del recosteo, y conviene revisarlo.
- **E2E**: `reportes-costeo-rf-s4a.spec.ts:210` espera `opMaterialCostPen = 0` en su caso, que no
  tiene OP, así que no le afecta. `correcciones-06.spec.ts:298` busca el prefijo del aviso de
  costeo, que no cambió.
- **E-15**: la UNION toma el `SCRAP` de cierre de cobertura (`roofing-production.service.ts:2389`)
  y el de drywall (`production.service.ts:1181`), que también es `ref_id = OP` sobre COIL, y deja
  fuera el despunte suelto de bobina (`coil-operations.service.ts:485`, `ref_id` = bobina). Las
  reversas (reabrir) y los recosteos con su `ref` se netean con el `CASE`. Coincide con
  `material_cost_pen` = partes + despunte (`roofingCost`), con la salvedad de que la tabla es una
  foto al cierre y el reporte se calcula en vivo.
- **Índices**: `sales_return_items(credit_note_item_id)` e `inventory_movements(recost_of_id)`
  existen, así que la subconsulta por línea de NC no es un barrido.
- **Textos**: `Stat` acepta `hint` (`stat-strip.tsx:50`). El aviso E-09 sale en Ventas y margen, en
  Ventas por material (solo fuera de la vista por producto) y en la rentabilidad del comprobante.

## Qué no cubren los tests

- Una NC sobre una venta trazada en parte (P1-1), y las NC 01 y 02 en la fila (P2-1).
- Una NC sobre un comprobante de otro periodo en Ventas por material (P3-4).
- El costo de la devolución con un recosteo (rama `recost_of_id` de la subconsulta).
- Que el despunte exista de verdad en el test de E-15 (P2-2).
- El vendedor de la NC de una venta directa (P2-4) y la rama del despacho (P3-1).
- La unidad de E-03 (`sales-by-product.spec.ts`) prueba la lógica con `affectedDocumentId` y
  `returnCostPen` armados a mano. La subconsulta SQL solo la cubre el db-spec de E-03, con una
  sola devolución y sin recosteo.

## Resumen

El cambio de E-03 es correcto cuando la venta acreditada se trazó entera y la NC es de devolución
(06/07) o de rebaja. **P1-1**: con una venta trazada en parte (por ejemplo un despacho parcial y
una NC 01 total), la fila del producto queda con venta y cantidad negativas mientras No trazable
conserva la parte no despachada. P2-1 (motivo 02) es la misma familia. E-15 está bien
implementado, pero su test no demuestra que hubo despunte (P2-2). E-16 coincide con
`documentOwnerId`, pero manda la NC de una venta directa a quien la registró (P2-4), y el
comentario exagera la igualdad con el Panel del vendedor (P2-5). El cruce por despacho es código
muerto (P3-1). Los Excel y `report-xlsx-totals.db-spec.ts` siguen a la pantalla por construcción.

---

## Respuesta del autor (cc57)

- **P1-1:** corregido. Una NC solo resta en la fila si la venta que acredita se trazó **entera**; si se trazó en parte, va a «No trazable». Hay unitario.
- **P2-1:** corregido. El 02 sigue en «No trazable». Hay unitario.
- **P2-2:** el test de E-15 afirma que la OP cerró con despunte. Sin el arreglo daba 363,60 contra 388,60 (`local-data/cc57/e15-antes.log`).
- **P2-3:** el arreglo ya está en el commit.
- **P2-4:** corregido. Una NC sin pedido toma el dueño del comprobante que acredita (su pedido o quien lo registró).
- **P2-5 y P3-1:** el comentario ya no dice que coincide con el Panel, y se quitó el cruce por `fd.dispatch_id`, que no se usaba.
- **P3-2..P3-7:** anotados. P3-4, la NC de otro periodo, sigue como antes del corte: queda como límite en el informe.
