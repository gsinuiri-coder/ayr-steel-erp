# Revisión de segundo modelo — Correcciones 02 (D-277..D-285)

**Fecha:** 2026-09-25
**Modelo revisor:** Sonnet (Claude Sonnet 5), como segundo modelo/autorrevisión independiente
**Alcance:** `git diff e27570a..main -- apps packages scripts` (114 archivos, +10543/−722),
leído contra `docs/ARQUITECTURA.md` §0.2 filas D-277..D-285 y `AGENTS.md` §3. Revisión de solo
lectura: sin ediciones, sin comandos contra bases de datos, sin ejecución de tests.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 1        |
| P2        | 4        |

No se encontraron hallazgos P0 (corrupción de datos reales, pérdida de dinero/inventario o
seguridad). El P1 es un error de cálculo en el plan de despacho a la fecha del comprobante
(D-278) que puede mandar a «revisión» una línea que en realidad sí tiene material fabricado y
reservado disponible. Los P2 son deuda o bordes de baja probabilidad, ninguno corrompe datos.

---

## P1-1 — El cupo de producción reservada (`heldUsed`) se gasta aunque la línea termine en REVIEW, y bloquea sin motivo a un comprobante posterior de la misma línea

**Archivo:** `apps/api/src/invoicing/invoice-dispatch.service.ts`, líneas 454–520 (el bucle que
arma `planInputs` y calcula `heldUsed`/`left`), en combinación con
`apps/api/src/invoicing/invoice-dispatch-plan.ts`, líneas 155–193 (`planInvoiceDispatches`, el
que decide `DISPATCH` vs `REVIEW` por `firstNegativeDate`/fecha de apertura).

**Qué pasa:** para una línea de pedido `fromProduction` (una cobertura o plancha fabricada
contra pedido), el cupo disponible es `t.held` (lo fabricado y reservado para esa línea,
`findLineReservation`). El código reparte ese cupo entre los comprobantes de la línea **en el
mismo bucle que resuelve el `target`** (líneas 496–509):

```ts
const used = heldUsed.get(orderItemId) ?? new Decimal(0);
const left = t.held === null ? null : Decimal.max(new Decimal(0), t.held.minus(used));
if (left !== null && reserveQty.gt(left)) {
  target = { ok: false, reason: `... falta producir` };
} else {
  if (left !== null) heldUsed.set(orderItemId, used.plus(reserveQty));
  target = { ok: true, itemKey: `${t.itemType}:${t.itemId}`, reserveQty };
}
```

`heldUsed` se actualiza en el momento en que el `target` resuelve `ok: true`, **antes** de que
`planInvoiceDispatches` (llamado después, con todos los `planInputs` ya armados) decida la
acción final de la línea. Esa función puede bajar una línea a `REVIEW` por un motivo que no
tiene nada que ver con el cupo de producción: `firstNegativeDate` encuentra que la salida
retroactiva deja el kardex negativo en alguna fecha intermedia (invoice-dispatch-plan.ts:182-191),
o la línea cae en la revisión de bobina-con-identidad (líneas 158-169). Una línea así **no
consume material real** (no se genera ningún `DISPATCH`), pero su `reserveQty` ya quedó anotada
en `heldUsed` como gastada, porque esa anotación ocurrió en el bucle de arriba, antes de saber
que iba a REVIEW.

**Escenario concreto:** línea L (cobertura, `fromProduction=true`), 70 m fabricados y
reservados (`t.held = 70`). Dos comprobantes de L, en orden de emisión: A por 60 m, B por 40 m.
En el bucle de `targets`, A resuelve `ok:true` (60 ≤ 70) y `heldUsed[L] = 60`; B resuelve
`left = 70 − 60 = 10`, `40 > 10` → `ok:false`, «falta producir». Ahora supóngase que A, además,
cae en `REVIEW` por `firstNegativeDate` (su fecha de salida retroactiva deja el kardex negativo
en una fecha intermedia, el caso que D-278/D-285 documentan como real: «coberturas y planchas
facturadas en agosto y producidas en septiembre»). A no se despacha —no sale nada del
almacén—, así que el cupo real que le queda a B es 70 m completos, y sus 40 m caben
holgadamente. Sin embargo el plan ya le dijo a B «falta producir», con el motivo equivocado, y
tanto el dry-run como el `--execute` (que usa el mismo `buildPlan`) van a mandar B a revisión
manual sin que haga falta.

**Por qué importa:** el propio D-278 documenta que las líneas de coberturas/planchas
facturadas antes de su producción son el caso frecuente que cae en revisión por
`firstNegativeDate`; una línea con dos comprobantes (facturación parcial) donde el primero cae
así y el segundo no, es un escenario de negocio normal, no un borde exótico. El efecto no
corrompe datos —la línea rechazada simplemente no se despacha—, pero el operador ve un motivo
falso («falta producir») y pierde tiempo investigando algo que no es cierto, y un
`--execute` real deja sin despachar un comprobante que sí tenía material. En el dry-run de
producción del 2026-09-25 citado en D-285 el resultado fue «0 a revisión», así que hoy no se
manifestó con los datos reales, pero el código queda con el defecto para la próxima vez que se
use el botón o el CLI (`InvoiceDispatchService` es la funcionalidad viva de D-278, no solo el
ajuste puntual de D-285).

**Cómo se confirmó:** el test `apps/api/src/invoicing/invoice-dispatch.service.spec.ts:273`
(«lo fabricado y reservado se reparte entre los comprobantes de la línea») cubre el reparto de
`heldUsed` cuando el primer comprobante sí termina en `DISPATCH`, pero no cubre el caso donde el
primero resuelve `ok:true` en el cupo y luego se baja a `REVIEW` por una razón de kardex —ese
camino queda sin test.

**Sugerencia (no aplicada, es solo lectura):** el descuento de `heldUsed` tendría que ocurrir
después de que `planInvoiceDispatches` decida la acción final (o recalcularse en una segunda
pasada), contando solo las líneas que de verdad terminan en `DISPATCH`/`BEFORE_OPENING`.

---

## P2-1 — La guarda de «una sola vez» de D-285 tiene una ventana de carrera bajo ejecución concurrente

**Archivo:** `apps/api/src/invoicing/opening-date-move.service.ts`, líneas 199–249 (`execute`).

El paso 1 se protege con `assertOpeningMoveNotApplied`, comprobado dos veces: una vez fuera de
la transacción de escritura (línea ~206-210) y otra vez dentro, al empezar la transacción
(líneas 222-227), antes de hacer los `UPDATE` con `SET LOCAL ayr.opening_date_move = 'on'`. Las
dos comprobaciones son un simple `SELECT ... WHERE action = OPENING_MOVE_ACTION`, sin
`FOR UPDATE` ni una restricción única en la base que impida la repetición. Con el nivel de
aislamiento por defecto de Prisma (READ COMMITTED), dos llamadas a `execute()` que arranquen
casi al mismo tiempo pueden pasar las dos la comprobación «no aplicado todavía» antes de que
cualquiera de las dos confirme, y la segunda queda bloqueada por el lock de fila del `UPDATE`
de la primera hasta que esta confirma; al reanudar, la segunda vuelve a escribir la misma fecha
(sin cambiar el resultado final del dato, porque el valor de destino es el mismo) pero **sí**
vuelve a escribir un segundo lote de filas de auditoría (`inventory.opening-date.move`)
duplicando la traza, algo que la guarda «la excepción no se repite» pretende impedir.

**Por qué es P2 y no P1/P0:** no hay corrupción de datos (el `UPDATE` repetido escribe el mismo
`operation_date`, y el trigger de la migración lo sigue aceptando porque no cambia nada más), y
el disparador es una CLI administrativa (`pnpm inventory:opening-date --execute`) pensada para
una corrida manual, única, con `--confirm-production` y OK del dueño — el riesgo real de dos
ejecuciones simultáneas es bajo. Queda igual como una brecha real en el código frente a la
promesa explícita «la excepción no se puede repetir».

---

## P2-2 — La fecha del trigger de D-285 está fija en SQL; `HISTORICAL_LOAD_START` es una variable de entorno pensada para cambiar por cliente

**Archivos:**
`apps/api/prisma/migrations/20260925010000_d285_mover_fecha_inventario_inicial/migration.sql`
(línea 15: `NEW."operation_date" = DATE '2026-08-01'`),
`apps/api/src/invoicing/opening-date-move.ts` (línea 15: `export const OPENING_MOVE_DATE =
'2026-08-01'`, nunca importado en ningún otro archivo del repo),
`apps/api/src/invoicing/opening-date-move.service.ts` (línea 84: `target =
this.operationDate.historicalLoadStart`, que lee `env.HISTORICAL_LOAD_START`).

`packages/shared/src/schemas/operation.ts:30-32` documenta expresamente que
`HISTORICAL_LOAD_START` «es configurable por entorno... porque el mes que se carga cambia con
el cliente». `OpeningDateMoveService.buildPlan` calcula su `target` a partir de esa variable de
entorno, pero la función del trigger que la migración instala solo admite el `UPDATE` cuando
`NEW.operation_date` es literalmente `2026-08-01`. Si `HISTORICAL_LOAD_START` alguna vez
difiere de ese valor en algún entorno (justo lo que el propio comentario del schema anticipa
para un cliente futuro, o incluso una reconfiguración de `production`), `execute()` construiría
un plan apuntando al nuevo `target`, pero el `UPDATE` real chocaría contra el trigger y
fallaría con un `inventory_movements es append-only: no se permite UPDATE` genérico —una falla
segura (no escribe nada raro), pero confusa, y sin ningún chequeo explícito en el código
(`OPENING_MOVE_DATE` existe pero no se usa para validar `plan.target` antes de intentar
escribir).

**Por qué es P2:** hoy no se manifiesta (todos los entornos usan el valor por defecto
`2026-08-01`, que es exactamente el que D-285 decidió para esta corrección puntual de
production), y el modo de falla es seguro (excepción, sin escritura). Es una inconsistencia de
diseño latente entre una constante de dominio pensada como global/por-cliente y una migración
de una sola vez que la hardcodea, sin una aserción que lo deje explícito.

---

## P2-3 — El preview de «Despachar a la fecha del comprobante» no está restringido a ADMINISTRADOR

**Archivo:** `apps/api/src/invoicing/dispatches.controller.ts`, líneas 58–64.

D-278 dice «Botón «Despachar a la fecha del comprobante» en el detalle del comprobante, solo
ADMINISTRADOR». El `POST /dispatches/at-issue-date/:invoiceId` (línea 71-78) sí lleva
`@Roles(Role.ADMINISTRADOR)`. El `GET /dispatches/at-issue-date/:invoiceId` (preview, líneas
58-64) no tiene su propio `@Roles` y hereda el de la clase
(`ADMINISTRADOR, VENDEDOR, SUPERVISOR_PLANTA`), así que un VENDEDOR o un SUPERVISOR_PLANTA
pueden pedir la vista previa del plan (con `assertSellerAccess` limitando al VENDEDOR a sus
propios pedidos). El DTO que devuelve (`InvoiceDispatchPlanDto`) no expone costos ni saldos, así
que el impacto es bajo, pero es una inconsistencia con lo que dice la decisión.

---

## P2-4 — Fallback de unidad semánticamente equivocado en `addMissingMovementInTx` (inalcanzable hoy, pero frágil)

**Archivo:** `apps/api/src/invoicing/dispatches.service.ts`, líneas 491, 524–536
(`kardexUnit`).

`addMissingMovementInTx` (D-285, paso 2) pide la unidad del kardex con
`this.kardexUnit(tx, item.itemType, item.itemId, item.unit)`, cuyo _fallback_ si no hay saldo
todavía es `item.unit` — pero `item.unit` en `dispatch_items` es la **unidad de venta**
(`orderItem.unit`, ver `dispatches.service.ts:405-407` en `createInTx`), no la unidad del
kardex (`target.unit`), que pueden diferir (p. ej. una cobertura se vende en `NIU`/`MTR` y su
kardex es `KGM`). En la práctica el fallback nunca se dispara para las líneas que D-285 toca,
porque solo llegan acá ítems con al menos un movimiento `IMPORT` previo (por eso tienen fecha de
apertura que mover) y ese movimiento ya creó el saldo — pero el nombre y la intención del
parámetro (`fallback`) inducen a error si el método se reutiliza en otro contexto donde el
saldo pueda no existir todavía.

---

## Revisado sin hallazgos

- **Trigger `inventory_movements_immutable` (D-285):** la excepción exige `TG_OP='UPDATE'`,
  la variable de sesión `ayr.opening_date_move = 'on'`, `OLD.ref_type = 'IMPORT'`, el destino
  exacto `2026-08-01` y que ningún otro campo cambie (`to_jsonb(NEW) - 'operation_date' =
to_jsonb(OLD) - 'operation_date'`). Cualquier otro `UPDATE`/`DELETE` sigue rechazado. Correcto
  y ajustado a lo que D-285 promete.
- **`planOpeningMoves`/`planMissingOuts` (opening-date-move.ts):** la condición «por ítem» (un
  movimiento anterior a `target` deja el ítem en `SKIP`), el orden de aplicación y el uso de
  `firstNegativeDate` para decidir qué salidas faltantes se pueden agregar sin dejar el kardex
  negativo, están bien construidos y consistentes con el resto del kardex simulado
  (`ADJUST` se trata como `signedQty: 0`, igual que en `InventoryService`).
- **`firstNegativeDate` (invoice-dispatch-plan.ts):** el orden de desempate (fecha, luego
  movimientos existentes antes que las salidas nuevas del plan, luego orden de inserción)
  coincide con el orden real en que se graban los movimientos (`operationDate`, `at`, `id`) en
  `findMovements`, porque las salidas nuevas siempre se graban con un `at` posterior a
  cualquier movimiento histórico. La simulación y la escritura real no divergen.
- **`allocateUndispatched`:** reparte lo ya despachado a los comprobantes más antiguos primero
  y nunca excede lo pendiente del pedido; las notas de crédito descuentan correctamente antes de
  prorratear (`nets` en `invoice-dispatch.service.ts:375-386`).
- **`DispatchesService.createInTx`/`addMissingMovementInTx`:** la reserva se consume antes de
  mover kardex (D-074), la excepción `deliveredBeforeOpening` libera la reserva sin tocar
  kardex, y el cierre de bobina vendida entera (D-170) sigue funcionando igual con despachos
  creados por D-278.
- **`valuePeps` (kardex-peps.ts, D-279):** las capas PEPS, el manejo de anulaciones de entrada y
  de salida (devolver las porciones exactas al frente de la cola), el reparto de `ADJUST` por
  kilos (matemáticamente equivalente a un incremento uniforme por unidad) y el tratamiento de
  faltantes (costo al valor registrado del kardex, con advertencia) están implementados según
  el diseño documentado. El descuadre conocido cuando hay faltantes (el valor de una entrada que
  cubre un déficit no se refleja en el saldo de capas aunque sí en `inTotal`) es exactamente el
  límite que el propio D-279 declara conocido (autorrevisión P2-8); no es un hallazgo nuevo.
- **`SalesMarginService`/`resolveCostStatus` (D-285, punto 4):** `NO_RASTREABLE` se decide antes
  que `NO_COMPARABLE`/`PARCIAL`, queda fuera de `inTotals` y de los totales generales, se cuenta
  y se suma aparte (`untraceableOrderCount`/`untraceableSalesPen`), y las filas de costo por
  documento y por línea de negocio usan el mismo subconjunto de filas que el total del pedido
  (evita la discrepancia que el propio comentario del código describe haber corregido antes).
- **CLIs (`opening-date-cli.ts`, `dispatch-at-issue-date-cli.ts`):** dry-run por defecto en
  transacción `READ ONLY`, `--execute` exige `--expect` (siempre en el de D-285; solo contra
  `production` en el de D-278, que es más laxo en `dev`/`demo` a propósito), verificación de
  ADMINISTRADOR activo contra la rama de destino, y comparación de huella antes de escribir.

---

## Seguimiento (2026-09-25, agregado por la sesión de cierre post-ventana)

| Hallazgo | Qué se hizo                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1     | Corregido en D-287 (PR #24): el cupo se reparte en `planInvoiceDispatches` y solo lo gasta la línea que se entrega. Test rojo antes del arreglo.         |
| P2-1     | En `docs/PROGRESO.md`. Cerrado por D-286 (PR #23): la herramienta se niega con su auditoría y el `--execute` toma un advisory lock.                      |
| P2-2     | En `docs/PROGRESO.md`. Sin efecto desde D-286: la función del trigger volvió a la forma estricta y ya no contiene ninguna fecha.                         |
| P2-3     | Corregido en D-287 (PR #24): la vista previa exige ADMINISTRADOR.                                                                                        |
| P2-4     | En `docs/PROGRESO.md`, abierto: el camino que lo alcanza es el de D-285, que quedó deshabilitado; se revisa si `addMissingMovementInTx` vuelve a usarse. |
