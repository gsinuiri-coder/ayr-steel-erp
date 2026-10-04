# Revisión de segundo modelo (Sonnet, contexto limpio) — cc15b, P2-B: orden de bloqueos en la anulación de compras

Fecha: 2026-10-03. Commit revisado: `3ced8e4` (`fix(kardex): la anulación de compras bloquea bobinas antes que saldos`).
Alcance: solo lectura; los dos spec tocados corren en verde (46 tests en `inventory.service.spec.ts` y `purchases.service.create-in-tx.spec.ts`).

## Veredicto

El cambio es correcto y cumple lo que promete: la anulación ya no toma un saldo antes que una bobina, y su orden (fila de compra, bobinas, saldos por `itemType:itemId`) coincide con «Editar compra» y con confirmar un pedido. **No hay P0 ni P1 introducidos por el commit.** Quedan dos P2 y tres P3. Los dos P2 ya existían: están en otros llamadores (despacho) que no usan el orden de D-134 completo. Ahora son más visibles, porque la anulación sí lo cumple.

## Hallazgos

### P2-1. Despacho: toma solo las bobinas nombradas y después expande el agregado, saldos en el orden de las líneas

`apps/api/src/invoicing/dispatches.service.ts:340-374` (crear) y `:750-790` (revertir). Ya existía; no lo introduce el commit.

- `create` bloquea con `SELECT ... FOR UPDATE` solo las bobinas de las líneas, sin sus agregados. Después, por cada línea, `inventory.record` hace `OUT` de COIL y llama `lockRawMaterialCoils` (`inventory.service.ts:225`), que agrega al conjunto las demás bobinas del agregado con promesas vivas, **después** de tener las propias.
- Escenario de deadlock con la anulación. El agregado es {C3, C5} y hay promesas vivas. El despacho de reventa de bobina tiene C5 y pide C3. La anulación de la compra de C3 y C5 toma {C3, C5} en una sola sentencia ordenada: tiene C3 y espera C5. Ciclo; Postgres aborta a una de las dos con 40P01 (500 para el usuario). Es el mismo cruce que confirmar un pedido, que también toma el conjunto ordenado en una sentencia.
- Escenario con saldos. En un despacho mixto, si una línea de PRODUCT va antes que una de COIL, el despacho tiene el saldo de P y recién después pide las bobinas del agregado. Compra mixta (bobina y accesorio P): la anulación tiene C y espera el saldo de P, mientras el despacho tiene P y espera C. Ciclo.
- Además los saldos se toman en el orden de `lines`/`dispatch.items` (sin ordenar). Dos despachos o un despacho y la anulación con productos [P2, P1] y [P1, P2] se cruzan.
- Arreglo: al inicio de `create` y de la reversa del despacho, llamar a una única función de bloqueo (el patrón de `lockItemsForReversal`, generalizado y renombrado, p. ej. `lockItemsInOrder(tx, refs)`) con los ítems de todas las líneas, antes de `consumeReservationQty` y de `record`. Esa función ya expande agregados y ordena saldos.

### P2-2. Otras reversas multi-ítem toman saldos en orden de iteración

`InventoryService.reverse` en sí toma un solo saldo y está bien. El problema es quien lo llama en bucle sin bloquear antes en orden: la reversa de despacho (`dispatches.service.ts:764`, `dispatch.items` sin ordenar) y, por la misma lógica, producción y anular venta. La anulación de compra ahora toma sus saldos ordenados y todos de una vez; un par de documentos con los mismos productos en otro orden hace ciclo.

- Escenario: la anulación de la compra {P1, P2} tiene P1 y espera P2; la reversa de un despacho [P2, P1] tiene P2 y espera P1. Hoy el guardrail rechazaría una de las dos, pero solo después de que Postgres resuelva la espera, así que el ciclo ocurre antes.
- Arreglo: el mismo de P2-1, aplicado a los demás llamadores que tocan más de un ítem. Prioridad por el riesgo de datos: despachos, anular venta y reporte de producción. El orden de `lockItemsForReversal` (`COIL` < `PRODUCT`, id ascendente) ya es el de `reserveLines`.

### P3-1. Bobinas hijas (flejes) de la compra no se bloquean; «Editar compra» sí

`purchases.service.ts:766-775` bloquea las bobinas de los **movimientos** de la compra. Más abajo, `tx.coil.updateMany({ where: { purchaseId: id ... } })` (`:~838`) y `assertStripsNotAssigned` actúan sobre **todas** las bobinas con `purchaseId`, incluidos los flejes que heredan ese `purchaseId` (D-060) y no tienen movimiento propio de la compra. Esas filas se bloquean tarde, después de los saldos, y no pasaron por el orden de D-134. «Editar compra» sí junta las bobinas por `purchaseId` (`purchase-received-edit.service.ts:116-127`).

- Escenario: montar un fleje en una OP (o `setStatus`, que toma `lockCoil`) tiene el fleje y pide una bobina del agregado que la anulación ya tiene; la anulación pide el fleje en el `updateMany`. Ventana estrecha, pero es el mismo tipo de cruce.
- Arreglo: antes de `lockItemsForReversal`, leer `tx.coil.findMany({ where: { purchaseId: id }, select: { id: true } })` y pasar esos ids también (agregarlos como refs COIL de lectura, o un parámetro `extraCoilIds`). Ojo: no crear saldos para ellos; solo bloquear la fila. Hoy `lockItemsForReversal` toma saldo de cada ref COIL, así que conviene el parámetro aparte.

### P3-2. `lockRawMaterialCoils` dentro de `reverse` puede ampliar el conjunto

`reverse` (`inventory.service.ts:478-480`) vuelve a llamar `lockRawMaterialCoils` para cada ingreso COIL. En lo normal es reentrante: las filas ya están tomadas por la misma transacción y no hay espera, y el agregado de una bobina está contenido en la unión que ya se tomó. Si entre las dos llamadas otra transacción confirmó una promesa nueva sobre una spec que antes no tenía ninguna (`findSpecsAffectedByAttributes` solo considera specs con promesas vivas) o una bobina nueva compatible, la segunda llamada toma esas filas **ya con saldos en mano**. La ventana es mínima y no hay ciclo posible con bobinas ya tomadas, pero sí con otra transacción que tenga la bobina nueva y espere un saldo nuestro. No requiere arreglo ahora; documentar en el comentario de `lockItemsForReversal` que cubre el conjunto visible en ese instante.

### P3-3. Pruebas

`inventory.service.spec.ts` (nuevo `describe`) prueba el orden con una transacción falsa, y es suficiente para el orden relativo. Faltan dos casos: (a) ADJUST de un landed cost sobre una bobina de otra compra (la anulación de un flete solo trae refs COIL ajenas); (b) una prueba de que bobinas duplicadas y COIL+PRODUCT del mismo uuid no colapsan (la clave `itemType:itemId` lo evita, pero no hay test). El único test de `purchases.service` usa solo PRODUCT, así que no ejercita bobinas.

## Tabla de órdenes de lock por operación

Orden de adquisición, de arriba abajo.

| Operación                                                        | 1. Fila de documento    | 2. Filas de bobina                                                                                                             | 3. Saldos                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Anular compra (`purchases.service.ts:732-775`, commit)           | compra (`updateMany`)   | una sentencia ordenada por id: bobinas de los movimientos más agregados con promesas; `reverse` repite la llamada (reentrante) | `COIL:id` luego `PRODUCT:id`, ids ascendentes, uno por ítem, **antes** de leer posteriores                                 |
| Editar compra (`purchase-received-edit.service.ts:115-131`)      | compra (`FOR UPDATE`)   | una sentencia ordenada: todas las bobinas por `purchaseId` más agregados                                                       | `COIL:id` luego `PRODUCT:id` sorted (`:204-262`); luego `replaceEntry`/`reverse`/`record` que repiten bobinas (reentrante) |
| `replaceEntry` solo (`inventory.service.ts:632-635`)             | no                      | una bobina más su agregado, si el ítem es COIL                                                                                 | el saldo del ítem                                                                                                          |
| `reverse` de cualquier documento (`:478-481`)                    | lo que tome quien llama | solo si el movimiento es un ingreso COIL: la bobina más su agregado                                                            | el saldo del ítem                                                                                                          |
| Despacho, crear (`dispatches.service.ts:193`, `:340-374`)        | pedido de venta         | solo las bobinas de las líneas, ordenadas, sin agregado; `record OUT` COIL amplía el agregado después (P2-1)                   | por línea, en el orden de `lines`, sin ordenar                                                                             |
| Despacho, revertir (`:703-790`)                                  | despacho, luego pedido  | solo bobinas de las líneas, ordenadas                                                                                          | `reverse` por `dispatch.items`, sin ordenar                                                                                |
| Confirmar pedido / reserva (`sales-orders.service.ts:1478-1660`) | pedido                  | **una sola** sentencia con la unión de bobinas nombradas y las del agregado, ordenada                                          | `lockAvailability` en orden `type:id` ascendente (`COIL` < `PRODUCT`)                                                      |
| Restaurar reserva (`:2465-2530`)                                 | pedido, reserva         | no                                                                                                                             | un saldo de producto                                                                                                       |
| `record` OUT/ADJUST de COIL (`:225-227`)                         | no                      | la bobina más su agregado                                                                                                      | el saldo                                                                                                                   |

Pares pedidos:

1. Anular compra vs `replaceEntry` (Editar compra): ambos primero la fila de compra. En la misma compra se serializan ahí. En compras distintas, las bobinas se toman en una sentencia ordenada y los saldos con la misma clave `itemType:itemId`; no hay ciclo. Un flete no comparte fila de compra con la compra de sus bobinas.
2. Anular compra vs `reverse` de otro documento: no hay ciclo si quien llama tomó antes sus bobinas en orden y llama a `reverse` sobre un solo ítem. Sí lo hay si itera sin ordenar (P2-2).
3. Anular compra vs despacho: puede haber ciclo (P2-1).
4. Anular compra vs reserva nueva: sin ciclo. Ambos toman bobinas en una sola sentencia ordenada (`ORDER BY "id" FOR UPDATE`; el orden de uuid en Postgres es el de bytes y coincide con el hexadecimal en minúsculas del orden en JS) y después saldos ordenados con el mismo criterio. La reserva calcula sus bobinas **sin** exigir promesas vivas, y la anulación solo expande las specs con promesas; son conjuntos distintos, pero cada uno se toma en un solo paso ordenado, así que se serializan sin cruzarse.

## Respuestas a las preguntas puntuales

- **¿`lockRawMaterialCoils` dentro de `reverse` vuelve a tomar bobinas ya tomadas?** Sí, y es inocuo: el bloqueo de una fila que la misma transacción ya tiene no espera. Cada llamada es una sentencia ordenada. La única excepción es P3-2.
- **¿Ordenar saldos por `itemType:itemId` coincide con los demás?** Sí. «Editar compra» (`:250-252`) y `reserveLines` (`:1478`) usan la misma clave y `localeCompare`. En uuid hexadecimal minúsculo `localeCompare` y el orden por unidades de código dan lo mismo. El `.sort()` de `coilIds` en `lockItemsForReversal` es redundante, porque `lockRawMaterialCoils` ordena de nuevo.
- **¿Bloquear el saldo de una bobina ajena (landed cost) causa problema?** No. La anulación de un flete F toma la fila de F, después la bobina C de la compra B y su agregado en una sola sentencia, y el saldo de C. Esa es la misma ruta que seguiría el `record ADJUST` original. No toma la fila de B, así que no hay cruce con «Editar compra» de B ni con la anulación de B: ambas toman C en una sentencia ordenada. El `bumpCoilDocumentCost` posterior escribe una fila que ya está tomada. Es el comportamiento deseado: sin ese bloqueo un consumo de C se colaría entre el guardrail y la reversa.

## Lo que intenté romper y no pude

- Anulación vs «Editar compra» de la misma compra: la fila de compra va primero en ambos (`updateMany` y `FOR UPDATE`) y se serializan antes de tocar bobinas o saldos.
- Anulación de un flete vs anulación o edición de la compra de las bobinas: sin ciclo (ver arriba).
- Anulación vs confirmar un pedido que reserva materia prima genérica sobre las mismas bobinas: las dos toman un conjunto ordenado en una sola sentencia, y después saldos con el mismo criterio.
- Un `reverse` de ingreso COIL que tome filas de bobina distintas de las ya tomadas: el agregado de una bobina está contenido en la unión; solo cambia si aparece una promesa nueva entre las dos llamadas (P3-2).
- Duplicados en `items`: el `Map` por `itemType:itemId` los colapsa y el spec lo cubre (3 saldos de 4 refs).
- Anulación de compra con solo PRODUCT: no lee bobinas (`coilIds.length > 0`) y solo toma saldos, igual que antes de este commit pero en orden.
- Una ref COIL con saldo inexistente: `lockBalance` crea la fila con `ON CONFLICT DO NOTHING` y no falla; no altera la semántica anterior.
- Reentrada del orden «fila de compra antes de bobinas»: ningún camino toma bobinas y luego actualiza una fila de compra (`purchase.update` aparece solo en rutas que ya tienen la fila).
