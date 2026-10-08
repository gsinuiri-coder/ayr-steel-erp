# cc34 corte 2 — autorrevisión (N6, N7)

> **Autorrevisión**, no pase cruzado: la hizo un subagente nuevo que no leyó el handoff de la sesión
> autora. Es una lista de riesgos, no una aprobación.

- Commit revisado: `d6111f0d` (padre `624ac9ab`).
- Archivos: `apps/api/src/reports/document-profitability.ts`, `document-profitability.service.ts`,
  `sales-by-material.service.ts`, `sales-by-product.ts` y sus specs.
- Corrida: `pnpm --filter @ayr/api exec jest src/reports` → 23 suites, 230 tests, todos en verde
  (HEAD 26143680; `git diff d6111f0d HEAD -- apps/api/src/reports` vacío, así que es el mismo código).
  No se corrió nada contra bases de datos: las dos consultas SQL nuevas no tienen prueba que las
  ejecute (los specs del servicio las simulan).

## P0

Ninguno.

## P1

### P1-1. La regla de N6 no se aplica a las líneas que salen por `none()`: una NC de anulación sobre lo no despachado sigue dando neto negativo

`document-profitability.ts:246-262`. `creditedByItem` solo se lee después de los cortes tempranos.
Las líneas que salen por `none()` —sin despacho declarado en el comprobante (`!hasDeclaredDispatch`),
el despacho no incluye la línea (`dispatched ≤ 0`), o todo lo despachado salió sin kardex
(`withoutMovement && cost = 0`)— tienen suma vacía; la línea de la NC (`creditLine`) sí resta su
venta entera. Es el mismo defecto de N6 con otra forma:

- **Anulación total antes de despachar.** Factura 10 und S/1000, nada despachado, NC 01 por las 10
  (S/1000). Neto: venta −1000, costo 0, utilidad −1000. Debe ser 0 / 0 / 0.
- **Dos líneas, una sin despachar.** Línea A 5 und S/500 despachada con costo 400; línea B 5 und
  S/500 sin despacho; NC 07 por B (S/500). Neto: 0 / 400 / −400. Debe ser 500 / 400 / 100 (el caso
  del dueño, pero repartido en dos líneas en vez de una).
- **Despacho sin kardex.** 10 und S/1000, 5 despachadas sin salida de kardex (D-278), NC 01 por las
  5 restantes: la línea sale `NO_COST` con suma vacía y el neto da −500 / 0 / −500.

El primer caso (factura anulada entera por NC antes de despachar) es plausible en el uso real.
**Propuesta:** antes de `none()`, si `credited > 0`, devolver una suma con la venta de la parte
acreditada (`sales × min(1, credited / invoicedTotal)`), costo 0 y cantidad 0, para que la NC la
cancele; el resto sigue sin costo con el mismo estado. Sumar los tres casos a los specs.

## P2

### P2-1. El total bruto (antes de NC) ahora muestra la venta acreditada como venta costeada y la línea sale COMPLETE

`document-profitability.ts:273-275, 303`. En el caso del dueño la línea propia da venta 1000, costo
400, utilidad 600 (60 %), `uncostedSalesPen` 0 y estado `COMPLETE`, aunque solo se costearon 5 de 10
unidades. El neto cuadra (500 / 400 / 100) porque la NC resta 500, pero `total` y la fila de la línea
leídos solos dicen un margen del 60 % que no existió. Antes la línea decía 500 / 400 / PARTIAL.
El spec (`document-profitability.spec.ts`, «el neto da 500 / 400 / 100») fija ese COMPLETE como
correcto. **Propuesta:** confirmar con el dueño que el bloque bruto debe leerse así; si no, mantener
la venta trazada por `costed/invoiced` en la línea y llevar la venta acreditada a una partida que
solo entre al neto, o al menos una nota «5 und acreditadas por NC» en la línea.

### P2-2. `costPerUnitPen` del neto mezcla unidades trazadas con unidades acreditadas

`document-profitability.ts:331` (`creditLine` suma `qty` negativa) con `toFigures` (línea 117).
En el caso del dueño, cantidad neta = 5 trazadas − 5 acreditadas = 0 → `costPerUnitPen` del neto
`null`, cuando el costo real por unidad es 400 / 5 = 80. Con una NC de descuento (que también lleva
cantidad, `invoicing.service.ts` acredita por cantidad) pasa igual: 10 trazadas − 10 del descuento = 0. No es regresión (antes también restaba), pero N6 vuelve el neto la cifra que se lee.
**Propuesta:** que el neto no reste la cantidad de las NC que no quitan unidades, y que las que sí
las quitan no resten de lo trazado lo que nunca se trazó (o mostrar `null` a propósito y decirlo).

### P2-3. El mismo despacho sobrado se lee distinto en las dos pantallas

Factura 10 und, despachadas 14: 10 con kardex (costo 800) y 4 sin kardex.

- Rentabilidad (`document-profitability.ts:302-317`): `ratio` 1, costo 800, `uncostedSalesPen` 0,
  pero `withoutKardex` 4 > 0 → `PARTIAL` con nota «Despachado 14.000 de 10.000; 4.000 sin salida de
  kardex (D-278): sin costo», aunque no queda venta sin costo.
- Ventas por material (`sales-by-product.ts:155-167`): `fraction` 1, todo trazado, ninguna fila
  «No trazable».

**Propuesta:** en rentabilidad, marcar PARTIAL por kardex solo si `costed < invoicedTotal − credited`
(es decir, si queda venta sin costo), igual que la pestaña de producto.

### P2-4. Una devolución sin reversa del despacho deja el costo de lo devuelto

`document-profitability.ts:273-279`. La regla supone que las unidades acreditadas son las que no se
costearon. Si la NC 06/07 acredita unidades que sí salieron con kardex y el despacho no se revirtió
(10 despachadas costo 800, NC 07 por 3), `ratio` se topa en 1 y el costo queda 800 sobre una venta
neta de 700. No es regresión (antes igual) y la reversa de despacho es de despacho entero
(`dispatches.service.ts` `reverseInTx`), así que el camino «correcto» es revertir y redespachar;
conviene dejarlo escrito en la D-540 como límite conocido.

## P3

### P3-1. Nota con «de N» menor que lo despachado

`document-profitability.ts:304-305`. Con NC que quita unidades, `netInvoiced` puede quedar por debajo
de lo despachado (caso P2-3 o P2-4 con despacho parcial sin kardex): «Despachado 10.000 de 7.000».
Cosmético.

### P3-2. Todo sin kardex con parte sin despachar va entero a SIN_SALIDA_KARDEX

`sales-by-product.ts:145`. 10 facturadas, 5 despachadas sin kardex, 0 costeadas → las 10 a
`SIN_SALIDA_KARDEX`, cuando 5 son `DESPACHO_PARCIAL`. Igual que antes; el caso mezclado sí se
reparte bien. Coherente sería repartir también aquí.

### P3-3. `NO_COST` temprano con salida de kardex a costo 0

`document-profitability.ts:260`. Si hay despachos mezclados y la parte con kardex tiene costo 0
(promedio 0), la línea sale `NO_COST` «Entregado antes del inventario inicial» aunque parte sí tiene
salida. Previo al cambio; con `costedQty` disponible, la condición podría ser `costed = 0`.

### P3-4. Huecos de prueba

- Ningún spec cubre P1-1, dos líneas del comprobante que comparten línea de pedido con NC, sobre
  despacho con NC, NC mayor que lo facturado, ni el caso con `ratio < 1` **y** sin kardex a la vez
  (la nota elige la rama de kardex y omite «el resto, sin costo aún»; es aceptable, pero sin test).
- Las dos columnas SQL nuevas (`costed_qty` en `declaredSales` y en `declaredDispatches`) no se
  ejecutan en ningún test; los specs del servicio las inyectan.
- El helper `declared()` de `sales-by-product.spec.ts` pone `costedQty = qty` por omisión, así que
  los casos viejos siguen probando el camino «todo con kardex»; está bien, pero ningún test viejo
  ejercita `untraceable: true` con `costedQty` > 0 salvo los dos nuevos.

## Verificado sin hallazgos

- **Caso del dueño:** 10 und S/1000, 5 costeadas a 400, NC 01/02/06/07 por 5 → `ratio` = (5+5)/10 = 1,
  `tracedQty` 5, costo 400; NC −500 → neto 500 / 400 / 100. Con 03/04/05/13 → `ratio` 0,5, neto
  0 / 400 / −400, como antes. El mapeo de `QTY_REDUCING_CREDIT_REASONS` coincide con el enum
  `CreditNoteReason` (`schema.prisma:426`) y con lo pedido.
- **Signos:** `LINE_COLUMNS` niega `qty` y `subtotal_pen` de las NC; `creditedByItem` usa `.abs()`.
- **NC en borrador o anulada:** `documentLines` filtra `status IN LIVE_DOCUMENT_STATUSES` (ISSUED,
  SEND_ERROR, ACCEPTED, VOID_PENDING) y `archived_at IS NULL`; un borrador o una NC anulada no
  acreditan unidades.
- **Clave de la línea de pedido de la NC:** las líneas de NC se crean con `salesOrderItemId` y
  `affectedItemId` del original (`invoicing.service.ts` ~1150) y `LINE_JOINS` resuelve por
  `COALESCE(fdi, afi)`; la clave `own_order_item_id ?? sales_order_item_id` coincide con la de la
  factura.
- **NC mayor que lo facturado / NC total:** `ratio` se topa en 1; `netInvoiced` en 0. La creación de
  NC ya impide acreditar más que lo pendiente por línea.
- **Dos líneas del comprobante con la misma línea de pedido:** `ratio` común y `tracedQty`
  proporcional a `qty/invoicedTotal`; la suma de las partes da `min(costed, invoicedTotal)` y el costo
  `cost × min(costed, inv)/costed`. Cuadra.
- **Sobre despacho sin NC ni mezcla:** `tracedQty` = facturado, costo `cost × inv/dispatched`, igual
  que antes.
- **Sin NC y sin mezcla (regresión):** `costed = dispatched` → `ratio` y `tracedQty` iguales a los de
  `624ac9ab`; estado y nota iguales salvo el «de N», que sin NC sigue siendo lo facturado.
- **N7 en rentabilidad:** 10 und S/500, 5 con kardex a 160, 5 sin → venta 250, costo 160, sin costo
  250, PARTIAL con nota. Antes salía COMPLETE con 500 / 160.
- **SQL `declaredSales`:** `costed_qty` filtra `ISSUED` y `movement_id IS NOT NULL`; `SUM(CASE…ELSE 0)`
  con `COALESCE` no deja NULL. La reversa de despacho es de despacho entero (pasa a `REVERSED`) y su
  costo neto por el `LATERAL` es 0; no queda cantidad costeada sin costo.
- **SQL `declaredDispatches`:** `SUM … FILTER` devuelve NULL sin filas y el `SELECT` final lo cubre con
  `COALESCE(q."costed_qty", 0)`; los productos `NOOP` cuentan como costeados (costo 0), como antes.
- **Cuadre de Ventas por material:** filas + no trazable = venta de la línea en los dos repartos
  (`tracedSales` + `undispatchedSales` + `restSales − undispatchedSales`); `withoutKardex` nunca es
  negativo porque `costed ≤ dispatched`.
- `Decimal` en toda la aritmética nueva; ningún `number`.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1     | Corregido: antes de las salidas tempranas (sin despacho declarado, despacho que no incluye la línea, todo sin kardex) la parte acreditada entra con su venta y costo 0; COMPLETE si la NC cubre todo lo facturado. Tests: anulación total antes de despachar (neto 0/0/0), el caso del dueño en dos líneas (500/400/100) y NC parcial sin despacho. Mutación: con la versión anterior fallan. |
| P2-1     | Corregido en parte: la línea sigue COMPLETE respecto de lo facturado neto (es la regla del dueño: la NC quita unidades), pero la nota lo dice: «Neto de 5.000 acreditado por nota de crédito…».                                                                                                                                                                                               |
| P2-2     | Sin cambio (ya pasaba antes): el costo por unidad del neto resta la cantidad de la NC. Ajustarlo cambiaría el costo por unidad de la línea; queda en el registro.                                                                                                                                                                                                                             |
| P2-3     | Corregido: lo despachado sin kardex se mide contra lo facturado neto; un despacho de más no deja la línea PARTIAL. Test.                                                                                                                                                                                                                                                                      |
| P2-4     | Documentado en D-540: una devolución sin reversa del despacho conserva el costo de lo devuelto (el kardex no lo recibió).                                                                                                                                                                                                                                                                     |
| P3       | «Despachado 10 de 7» y el resto: sin cambio (informativos). La condición D-278 ahora usa lo costeado (`costed`).                                                                                                                                                                                                                                                                              |
