# cc34-c2 — revisión de segundo modelo

- Revisor: Sonnet 5.5 (contexto limpio, sin handoff de implementación). Es un modelo, no una persona; no cierra la revisión (AGENTS.md §2.2).
- Entrega: commit `d6111f0d` (padre `624ac9ab`), N6 (D-540) y N7 (D-541).
- Archivos: `document-profitability.ts`, `document-profitability.service.ts`, `sales-by-product.ts`, `sales-by-material.service.ts` y sus specs.
- Corrida: `pnpm --filter @ayr/api exec jest src/reports` da 23 suites y 230 tests en verde. No se corrió nada contra bases ni E2E, así que el SQL nuevo (`costed_qty`, `credit_reason`) solo se revisó leyéndolo.

## Resumen

El caso objetivo (10 und S/1000, 5 despachadas con costo 400, NC por 5 de S/500) da 500 / 400 / 100 en el cálculo de `dispatchLine`. N7 es coherente en las dos superficies y el cuadre filas + no trazable = venta se mantiene.

Hay un hallazgo P1. Cuando lo despachado vigente de la línea es 0, `dispatchLine` sale por una vía anterior a la lógica de N6 y la NC sigue restando venta sin que la línea cuente ninguna. Eso es justo el caso «la NC cubre todo lo no entregado», con el neto en negativo. Son el caso 2 y el caso 3 de la sección P1.

## P0

Ninguno.

## P1

### P1-1. Las salidas tempranas de `dispatchLine` ignoran la NC (`document-profitability.ts:249-261`)

Las ramas `NO_COST_YET` (sin despacho declarado, línea sin despacho o con `dispatchedQty <= 0`) y `NO_COST` (`withoutMovement && cost.isZero()`) devuelven `emptySum()` antes de mirar `creditedByItem`. La fila de la NC, en cambio, entra siempre al neto por `creditLine`, con su venta en negativo. Resultado concreto, con precio de S/100 por unidad y factura de 10 und S/1000:

1. Tres de los casos de abajo se calculan a mano con las reglas del código nuevo, sin correr nada.
2. Factura con todo despachado y despacho revertido, más NC por DEVOLUCION_TOTAL de 10 und / S/1000. El despacho revertido no es `ISSUED`, así que `dispatched = 0` y `hasDeclaredDispatch = false`. La línea sale `NO_COST_YET` con venta trazada 0 y `uncosted` 1000. El neto sale **−1000 / 0 / −1000**, cuando lo correcto es 0 / 0 / 0. Es el caso «NC de devolución con despacho ya revertido» y N6 no lo toca.
3. Factura de 10 und, nada despachado de esa línea, NC ANULACION_OPERACION por las 10. Mismo resultado: neto −1000. N6 dice que las 10 unidades acreditadas no hay que costearlas; aquí quedan sin costo y se restan igual.
4. Lo mismo, en pequeño, con NC parcial y nada despachado: la línea no registra ni la venta ni la reducción.
5. Caso `withoutMovement`: todo lo despachado sin kardex (costo 0) más una NC de anulación. La línea es `NO_COST`, la NC resta y el neto queda negativo.

El caso objetivo del brief sí funciona, porque ahí hay despacho con costo. Lo que falla es el extremo: la NC cubre todo lo facturado. Ese comportamiento ya era así antes del commit, pero N6 declara que las NC de anulación y devolución quitan unidades, y la línea nunca lo refleja cuando no hay nada despachado.

Propuesta: calcular `credited` antes de las salidas tempranas. Si `credited > 0`, la parte acreditada se traza con costo 0:

- `ratio_cr = min(1, credited / invoicedTotal)`;
- `sales = subtotal * ratio_cr`;
- costo 0.

Si `credited >= invoicedTotal`, el estado es `COMPLETE` con una nota del tipo «Acreditada por NC». Si no, es `PARTIAL`. Agregar tests para esos tres casos.

## P2

### P2-1. Falta de cobertura de los casos que más pueden fallar

`document-profitability.spec.ts` solo cubre el caso 5 + 5 de 10. No hay test para:

- dos líneas que comparten línea de pedido con NC (aritmética revisada a mano, ver abajo, pero sin red);
- NC que cubre todo (P1-1);
- sobre-despacho con NC (despachado 8, NC 5);
- NC mayor que lo no entregado (despachado 3, NC 5, que debe dar `ratio = 0.8`);
- NC sin `sales_order_item_id` (una NC sin vínculo al ítem original no reduce nada);
- NC con signo: el seed del test pasa `qty` positivo para la NC, pero el SQL entrega `-qty`. Se usa `.abs()`, así que funciona, pero el seed no reproduce la forma real.

### P2-2. SQL sin cobertura de forma

`costed_qty` en `declaredSales` y `credit_reason` en `documentLines` solo se prueban con filas simuladas. No hay `db-spec` con despachos mixtos (con y sin `movement_id`). Una columna mal nombrada o un NULL mal tratado no lo detecta ningún test. Revisado a mano: las consultas son coherentes, `COALESCE(SUM…, 0)` cubre los NULL y las reversas se compensan por la cadena de `reversal_of_id` como antes.

## P3

### P3-1. Nota confusa en N7 (`document-profitability.ts`, `progress`)

La nota dice «Despachado 10.000 de 10.000; 5.000 sin salida de kardex (D-278): sin costo» con estado PARTIAL. Es correcta, pero el lector ve 10 de 10 y PARTIAL. Convendría decir «Con salida de kardex 5.000 de 10.000» o dejar claro cuál es la cantidad costeada.

### P3-2. Inconsistencia de NOOP entre las dos superficies

En la pestaña de producto, un ítem sin movimiento de un producto con `inventory_strategy = NOOP` cuenta como costeado. En `declaredSales` de rentabilidad, un ítem NOOP que no sea servicio sin `movement_id` se trata como `withoutMovement` y la línea sale `NO_COST`. Ya era así antes del commit y la regla de N7 no lo cierra; conviene anotarlo.

### P3-3. Línea con costo cero y sin movimiento (`document-profitability.ts:261`)

`sale.withoutMovement && cost.isZero()` manda toda la línea a `NO_COST` aunque `costedQty > 0`, cuando el costo costeado es exactamente 0 (producto de costo 0, caso raro). Con N7 la condición debería ser `costed.isZero() && withoutMovement`, que además es el único caso donde `costed` es 0 con despachado mayor que 0.

### P3-4. Motivos escritos como cadenas

`QTY_REDUCING_CREDIT_REASONS` usa literales en vez de `CreditNoteReason` de `@ayr/shared`. Un motivo nuevo en el enum quedaría fuera sin aviso. Un test que recorra `Object.values(CreditNoteReason)` y exija que cada valor esté clasificado cerraría el hueco.

### P3-5. Las líneas del motor (Coberturas Aluzinc) no aplican N6

Se excluyen por `in_engine`. Es coherente con la especificación, que solo habla de la línea de pedido fuera del motor. Se deja como aclaración por si el dueño la quería en las dos vías.

## Verificado sin hallazgos

Aritmética, con ejemplos propios. Salvo el caso 2, todos usan precio S/100 por unidad.

1. Caso objetivo para los cuatro motivos de anulación y devolución: `ratio = min(1, (5 + 5) / 10) = 1`, venta 1000, costo `400 * 5 / 5 = 400`, neto 500 / 400 / 100, estado COMPLETE. Los cuatro motivos de solo venta dan PARTIAL con venta 500 y neto 0 / 400 / −400, como antes.
2. Sin NC (`credited = 0`): `ratio = min(1, costed / inv)`, igual que `dispatched / inv` cuando `costed = dispatched`. `tracedQty` y costo coinciden con la fórmula anterior, incluido el sobre-despacho: 12 despachadas de 10 facturadas da costo `cost * 10 / 12`.
3. Dos líneas que comparten línea de pedido (4 y 6 und, costeado 5, costo 400, sin NC): líneas 160 y 240, venta 200 y 300. Con NC de 5: `ratio = 1`, ventas 400 y 600, costo 160 y 240, suma 400. Cuadra.
4. Sobre-despacho con NC (despachado 8, factura 10, NC 5): `ratio = 1`, `tracedQty = 8`, costo de las 8, neto 500 / costo de 8 und. Es lo que se debe esperar: se despachó más de lo neto.
5. NC mayor que lo no entregado (despachado 3, NC 5): `ratio = 0.8`, venta trazada 800, `uncosted` 200, nota «Despachado 3.000 de 5.000», neto 300 de venta con el costo de 3 und. Coherente.
6. Pestaña de producto, cuadre filas + no trazable = venta:
   - 10 despachadas, 5 con kardex, venta 500: filas 250, no trazable 250.
   - 6 despachadas, 4 con kardex, factura 10, venta 500: filas 200, DESPACHO_PARCIAL 200, SIN_SALIDA_KARDEX 100. Suma 500, con el resto calculado como diferencia exacta.
   - 12 despachadas, 6 con kardex, factura 10: traza 6, SIN_SALIDA_KARDEX 4 y `costShare = 1`. Correcto.
   - `costed` queda acotado a `dispatched` y la rama `untraceable && costed <= 0` conserva el caso viejo (todo sin kardex).
7. Las NC en la pestaña de producto siguen como no trazables `NOTA_CREDITO` negativas. N6 no aplica allí (la especificación no lo pide) y el cuadre se mantiene.
8. SQL: `costed_qty` en `declaredSales` filtra `ISSUED` y `movement_id IS NOT NULL`; en `declaredDispatches` usa `FILTER` y vale NULL si no hay filas, pero la salida `COALESCE(q."costed_qty", 0)` lo cubre. `credit_reason` viene de `fd."credit_note_reason"`, que existe en el schema; es NULL para el comprobante propio. Las reversas siguen restando por `reversal_of_id`. `NC.qty` llega negativo (`-fdi.qty`) y el código usa `.abs()`.
9. Tests: 23 suites, 230 tests en verde (`pnpm --filter @ayr/api exec jest src/reports`).

## Qué se hizo con cada hallazgo

| Hallazgo                                   | Resolución                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1                                       | Corregido (mismo que la autorrevisión): la parte acreditada entra con costo 0 también cuando la línea sale por `NO_COST_YET` o `NO_COST`; COMPLETE si cubre todo. Tests y mutación. |
| P2 cobertura                               | Agregados: NC que cubre todo, dos líneas con NC en una, NC parcial sin despacho, despacho de más con parte sin kardex.                                                              |
| P2 db-spec de `costed_qty`/`credit_reason` | Sin db-spec nuevo: las dos columnas son agregados simples sobre consultas que ya cubren los E2E de Ventas por material y de C06 (corridos en local, verdes); queda anotado.         |
| P3 nota «10 de 10»                         | Corregida en parte: la nota dice cuánto salió sin kardex.                                                                                                                           |
| P3 NOOP                                    | Sin cambio: es la regla previa de cada pantalla (D-285 en la pestaña de producto).                                                                                                  |
| P3 `cost.isZero()`                         | Corregido: usa `costed`.                                                                                                                                                            |
| P3 enum como cadenas                       | Sin cambio: la fila llega de SQL crudo como texto.                                                                                                                                  |
