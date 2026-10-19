# Revisión de segundo modelo — cc58 corte C (D-686, flete que llega tarde por recosteo)

Alcance: `git diff cc58-b..cc58-c`. Revisión estática; no se corrieron db-specs. Un modelo, no una persona.

Veredicto: **2 P1 y 3 P2** a corregir antes del deploy. La aritmética del reparto y la cascada están bien; lo frágil es cómo se _encuentra_ lo que el servicio sumó (la nota) y qué pasa con entradas que cambiaron después.

## P1

### P1-1 La nota «<Tipo> <serie>-<número> (D-686)» no es identificador único: la anulación puede restar de más

`apps/api/src/purchases/landed-cost-recost.ts:35-41` (`landedCostNote`) y `:63-66` (`landedCostShares` filtra por `notes: note`).

Dos escenarios reales:

1. **Misma serie-número, distinto proveedor, misma compra de bobinas.** `assertNoLiveDocumentClash` (`purchase-document-clash.ts`) compara por `supplierId`. Dos fletes `F001-1` (mismo tipo) de dos transportistas sobre la misma compra de bobinas tienen la misma nota. Al anular uno, `landedCostShares` suma los `ADJUST` de los dos y resta el total de ambos.
2. **Número reutilizado tras anular.** El choque excluye las compras `CANCELLED`, así que el mismo proveedor puede registrar de nuevo `F001-1`. Los `ADJUST` de la anulación llevan otra nota (`Anulación: …`, `purchases.service.ts:1014`), por lo que los positivos del servicio viejo siguen contando como «vivos» con la nota original. Al anular el segundo servicio se resta X+Y en lugar de Y. La ficha de la bobina (`bumpCoilDocumentCost`) y el kardex quedan por debajo del costo real, en silencio.

Fix: meter el `id` de la compra de servicio en la nota (p. ej. `… (D-686 #<purchase.id>)`) y filtrar con ella. Una alternativa es sumar también las filas `Anulación: <nota>` para obtener el neto, pero eso no separa el caso 1. Hace falta un test con dos servicios de la misma serie-número, y otro con anular y volver a registrar.

### P1-2 Anular una compra de servicio cuya bobina se anuló o se reemplazó queda bloqueado para siempre

`landed-cost-recost.ts:84-96` lanza `BadRequestException` si la entrada tiene `reversalOfId` o `reversals`.

Caso: se aplica el flete y después se anula la bobina por RF-21. La reversa de un ingreso toma el costo _efectivo_ (`effectiveCost`, `inventory.service.ts:894`), así que el flete ya salió con la entrada y no hay nada que restar. Sin embargo la anulación del servicio se rechaza, y no hay forma de anular el comprobante ni su CxP.

Fix: en `landedCostShares`, **omitir** (no lanzar) las entradas ya revertidas, y no tocar la ficha de esa bobina. `replaceEntry` ya rechaza reemplazar un ingreso con recosteo propio (`inventory.service.ts:1086`), de modo que «reemplazada» no debería darse mientras haya flete vivo.

## P2

### P2-1 El tope de 500 filas bloquea la recepción de un servicio (CxP)

`purchases.service.ts:1190-1194`. Antes, `applyLandedCost` nunca impedía recibir (la deuda con el proveedor tiene que llegar a CxP, D-030). Ahora un flete sobre una bobina con muchas salidas posteriores, o con muchos hijos, devuelve 400 y el comprobante no puede registrarse. El mensaje manda a «avisar al administrador», pero `recosteo:historico` escribe con otra nota (`historic.label`) y la anulación no lo encontraría después.

Fix: aceptar `pending` en la recepción (la auditoría `inventory.recost-pending` ya queda escrita), no tocar la ficha, devolver `imputed:false` con aviso y dejar el comprobante recibido; o bien dejar constancia de que el dueño acepta que el tope bloquee. En cualquier caso, un conteo previo evita el error tardío.

### P2-2 `fix:costo-bobina` / «Editar bobina» (D-672) pisa el flete sin que la anulación lo sepa

`apps/api/src/coils/coil-entry-cost.ts:80-105`. El costo efectivo ya incluye el flete, y el objetivo es `peso × costo/kg × TC`. Corregir el costo de una bobina con flete recosteado resta el flete del efectivo (`add` negativo) y lo escribe con la nota del arreglo. Después, anular el servicio resta el mismo monto otra vez (las filas con su nota siguen en la entrada), y la entrada queda por debajo del costo.

El guard `ownAdjusts` cuenta solo `ADJUST` con `recostOfId: null`; un flete de D-686 tiene `recostOfId`, así que ya no lo detecta.

Fix: rechazar en `coil-entry-cost.ts` cuando la entrada tiene recosteos de servicio D-686 (hoy solo se distinguen por la nota; mejor un marcador estructurado). Test: bobina con flete + corrección de costo.

### P2-3 La vista previa de «Editar compra recibida» ya no avisa del landed cost

`purchase-received-edit.service.ts:404` y `:455`. Los movimientos se leen con `recostOfId: null`, así que `landedCost: live.some(ADJUST && refId !== purchase.id)` es falso para un flete de D-686. El plan muestra «se puede» y falla al ejecutar con el mensaje genérico de `replaceEntry` (el recosteo del propio ingreso bloquea). Es seguro, pero engañoso.

Fix: poner `landedCost: true` si existe un `ADJUST` con `recostOfId = ownIn.id`.

## P3

- **P3-1 Montos menores a 0,01.** `recost-engine.ts:159` descarta deltas con `abs < RECOST_MIN_DELTA`. Con un flete chico repartido en muchas bobinas, la parte de una bobina puede quedar bajo 0,01: `applyLandedCost` igual llama a `bumpCoilDocumentCost` (`purchases.service.ts:~1203`), pero `landedCostShares` no encuentra fila. Ficha y kardex divergen en céntimos y la anulación no revierte la ficha. Fix: saltar `bump` y la auditoría de las partes con `abs < 0.01`.
- **P3-2 Lectura antes de bloqueo en la anulación.** `reverseLandedCost` lee `landedCostShares` (`purchases.service.ts:1008`) antes de `assertStripsNotAssigned`, que toma las filas de bobina. Una anulación concurrente de la bobina entre ambas dejaría un `movementId` revertido, y `recostEntries` no comprueba reversa. Carrera estrecha (D-474). Fix: bloquear las filas de bobina antes de leer.
- **P3-3 Hijas y flejes.** La cascada por `recostForward` es correcta (sus `IN` no son `PURCHASE`, así que no entran a `landedCostEntries` y no se restan dos veces), pero la ficha de las hijas no se actualiza, igual que antes. Anotarlo como conocido.
- **P3-4 Estabilidad de la nota.** La nota depende de `SERVICE_KIND_LABELS`; si la etiqueta cambia, las filas viejas dejan de encontrarse. Guardar el id (P1-1) lo evita.
- **P3-5 Compatibilidad D-043.** Sin hallazgos: las filas viejas (`ADJUST` con `refId = servicio`) siguen entrando por el bucle original de `cancel`; `reverseLandedCost` no las ve, y la guarda de `assertNoLiveLandedCost` solo mira las nuevas (las viejas las frena `assertNothingMovedAfter`, como antes).

## Revisado y correcto

- Reparto: `prorateByWeight` sobre los kilos recibidos conserva la suma exacta; el `IN` lleva un override (`efectivo + add`), así que su delta es exactamente `add`, y el filtro de ruido solo afecta a filas descendientes (promedio).
- USD: `bumpCoilDocumentCost` divide por el TC y usa el peso de la ficha; ida y vuelta simétricos.
- Bloqueos: documento (compra) → filas de bobina (`assertStripsNotAssigned`) → `recostForward` con NOWAIT; sin cambio de orden. Centinela de `RECOST_TX_OPTIONS` actualizado para `receive`; `cancel` ya tenía 120 s.
- `applyCuttingOrderCost` no se tocó.
- Auditoría: la recepción conserva la entrada por bobina y la de documento; `recostEntries` audita cada fila recosteada.
- E2E `fase2b.spec.ts`: las cifras (`4.4000`, `22000.0000`, `recosted:true`, una sola fila) concuerdan con el plegado del kardex; el `finally` de producción anula primero el flete.

## Respuesta del autor (cc58)

- **P1-1 (la nota no es llave): corregido.** La nota lleva `compra <id>` y la anulación busca por esa
  llave (`landedCostKey`), con el neto de alta y anulación: dos fletes con el mismo número de dos
  proveedores, o uno anulado y vuelto a registrar, ya no se mezclan. Pruebas en
  `landed-cost-recost.spec.ts`.
- **P1-2 (entrada anulada después del flete): corregido.** Si la reversa de la entrada se llevó su
  costo efectivo (anular la bobina o la compra), el flete ya salió: la anulación del servicio lo
  salta. Solo un reemplazo («Editar compra recibida», que revierte al costo grabado) se rechaza, con
  la bobina. Prueba de base: «anular la bobina se lleva el flete…».
- **P2-1 (tope de 500 filas en la recepción): aceptado como riesgo y avisado al dueño.** El tope es
  D-650; rechazar evita perder el flete en silencio. Queda en el handoff para decidir.
- **P2-2 (corrección del costo de la bobina): corregido.** `coil-entry-cost.ts` rechaza una bobina
  con flete neto sumado por recosteo (`hasLandedRecost`).
- **P2-3 («Editar compra recibida» sin aviso): corregido.** El hecho `landedCost` también mira el
  flete por recosteo.
- **P3:** montos por bobina menores a 0,0001 siguen el redondeo del reparto (como D-043); leer las
  partes antes de bloquear en la anulación es lectura de la compra ya tomada; la ficha de las hijas
  sigue como antes.
