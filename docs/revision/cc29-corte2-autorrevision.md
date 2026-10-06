# cc29, corte 2 — autorrevisión

> **Autorrevisión.** La escribió un subagente nuevo que no escribió el cambio ni leyó el handoff de
> implementación de la sesión. Es una **lista de riesgos, no una aprobación**: no vale como pase
> cruzado (AGENTS.md §2, regla 2.1).

- Alcance: `git diff 8ce80ac8..HEAD -- apps packages e2e docs/manual` (commits `58d5524b`,
  `2965a2fa`, `7e9c80ca`) contra la intención de D-464, D-466, D-468 y D-469 de
  `docs/ARQUITECTURA.md` §0.2 (leído del disco, con cambios sin commitear).
- Corrido: `npx jest src/reports/production-summary src/coils/coil-mount-surplus
src/reports/reports.controller.spec.ts` → 3 suites, 28 tests, todos verdes. No se corrió E2E ni
  `lock-order.db-spec.ts`.

## Resumen

| Severidad | Hallazgos      |
| --------- | -------------- |
| P0        | 0              |
| P1        | 2 (A-1, A-2)   |
| P2        | 4 (A-3 … A-6)  |
| P3        | 6 (A-7 … A-12) |

Lo que se revisó y **no** dio hallazgo: el teórico se suma una vez por reporte (Set por OP) y no se
reparte entre bobinas; signo salida + / entrada − coherente; el despunte se separa de la merma
manual por `refId`; la merma manual queda fuera; agrupación por correlativo de pedido, línea y OP,
con las corridas sin pedido al final; costos en `null` para el supervisor tanto en el DTO como en
el Excel (las columnas de costo ni siquiera se emiten); consultas fijas (1 + 3, una sin
movimientos), sin N+1; el rol del sobrante se valida en el controlador (`@Roles` de clase) y otra
vez en el servicio; el bloqueo del montaje con sobrante entra por `lockInOrder` (bobina + saldo de
la que se reabre) antes del bucle, y el par concurrente está en `lock-order.db-spec.ts`; el doble
clic del montaje con sobrante rebota (la segunda llamada encuentra la bobina abierta y
`physicalKg` sin reapertura da 400); `reverseCloseAdjustment` y las opciones de D-193 distinguen
el ajuste de cierre (`refId = bobina`) del sobrante de montaje; `coil-waste` suma el sobrante como
entrada de ajuste (es material real de la bobina, tiene sentido en la merma por bobina); el kardex
solo se escribe por `record`/`reverse`.

## Hallazgos

### A-1 — P1 · Se puede «declarar peso físico» de una bobina vendida o partida en flejes

- **Dónde:** `apps/api/src/production/roofing-production.service.ts:2993-3063` (opciones:
  `empty = closedIds.filter((id) => !hasKilos(id))`) y `:704-727` (montaje: `physicalKg` acepta
  cualquier `CLOSED` que se reabre con saldo 0); `apps/api/src/coils/coil-operations.service.ts:640-659`
  (`reopenInTx` solo comprueba que no tenga flejes asignados).
- **Escenario:** una bobina de la misma spec se vendió entera (reventa de bobina: `closeEmptySoldCoils`
  de `dispatches.service.ts` la deja `CLOSED` con saldo 0) o se partió en flejes y la madre quedó
  `CLOSED` con 0 (`coil-operations.service.ts:222-248`, `motherClosed`). Antes de cc29 no se podía
  montar («no tiene kilos disponibles»). Ahora aparece en «Ver bobinas terminadas» con «kg al
  reabrir 0», el botón «Reabrir y montar» pide un peso físico y el API lo acepta (hasta su peso de
  ingreso): entra un `CLOSE_ADJUSTMENT IN` valorizado sobre material que está en el cliente o que
  ya vive en los flejes hijos (doble conteo). No hay nada en el camino que distinga «terminada
  porque se consumió en planta» de «terminada porque se fue».
- **Corrección sugerida:** limitar `needsPhysicalKg` (opciones **y** montaje, la misma función) a
  las terminadas cuyo último cierre no fue de un despacho (`closedByDispatch` en la auditoría, como
  ya hace `reopenRevertedCoils`) y que no tienen hijos de un partido vivo; o, más simple y
  conservador, exigir que la última salida viva del kardex sea `PRODUCTION`/`SCRAP` de una OP. Un
  test por cada origen (venta, partido) que hoy pasaría.

### A-2 — P1 · Bajar la bobina ahora mueve kardex sin `lockInOrder` ni par concurrente (regla dura 17)

- **Dónde:** `apps/api/src/production/roofing-production.service.ts:842-924` (`releaseCoil`) →
  `coil-operations.service.ts` `reverseMountSurplusInTx` → `InventoryService.reverse`.
- **Escenario:** `releaseCoil` toma la OP, luego `lockCoil` de la bobina, y recién al revertir el
  sobrante toma su saldo (`lockBalance`); como la reversa de un ingreso baja el saldo de una
  bobina, `reverse` corre `assertRawMaterialInvariant`, que bloquea con `FOR UPDATE` **las bobinas
  compatibles del agregado** (`sales/raw-material.ts:~724`) — bobinas después de un saldo, fuera del
  orden documentos → reservas → bobinas → saldos. Un montaje concurrente de otra bobina Y de la
  misma spec (que tomó Y y su saldo con `lockInOrder` y después corre el mismo agregado) se cruza
  con la bajada que tiene X y su saldo y espera Y: Postgres aborta una. La regla 17 dice que un
  camino nuevo que mueve inventario toma su conjunto al inicio con `lockInOrder` y suma su par en
  `lock-order.db-spec.ts`; el par agregado es solo «montar con sobrante», no «bajar con sobrante».
- **Corrección sugerida:** en `releaseCoil`, si existe sobrante vivo del consumo, tomar
  `lockInOrder({ coilIds: [coilId], items: [saldo de la bobina] })` antes de `lockCoil`, y agregar
  el par «bajar con sobrante» al bloque D-386 de `lock-order.db-spec.ts`.

### A-3 — P2 · Anular la OP no deshace el sobrante que bajar sí deshace

- **Dónde:** `apps/api/src/production/roofing-production.service.ts:2815-2880` (`cancel`), frente
  a `:888-898` (`releaseCoil`).
- **Escenario:** el supervisor monta una terminada en 0 declarando 300 kg; antes de rolar nada,
  el administrador anula la OP. `cancel` suelta los consumos con un `updateMany` y nunca llama a
  `reverseMountSurplusInTx`: el `CLOSE_ADJUSTMENT IN` de 300 kg queda vivo apuntando a un consumo
  liberado, y la bobina queda `OPEN` con 300 kg (la red de D-360 no la termina porque tiene saldo).
  El mismo hecho («la bobina vuelve sin usarse») tiene dos resultados de kardex según el botón.
  D-469 (3) solo nombra la bajada; la regla 15 pide la reversa en la misma pieza que la operación.
- **Corrección sugerida:** decidir (D-nnn) si la anulación conserva el sobrante (el peso fue físico)
  o lo deshace; si lo deshace, llamar `reverseMountSurplusInTx` por cada consumo vivo en `cancel`
  (con su bloqueo en orden, ver A-2). En cualquiera de los dos casos, un test que lo fije.

### A-4 — P2 · El peso físico queda pegado entre aperturas del selector

- **Dónde:** `apps/web/src/app/(app)/planta/coil-picker.tsx:92-101` (el `useEffect` de apertura
  limpia `reopenReason` pero no `physicalKg`) y `:223-230` (confirmar cierra sin limpiarlo).
- **Escenario:** el supervisor monta la bobina A declarando 412.5 kg; más tarde abre el selector en
  otra OP y elige otra terminada en 0: el campo ya trae 412.5, el botón está habilitado y basta con
  escribir el motivo para dar de alta 412.5 kg que nadie pesó.
- **Corrección sugerida:** `setPhysicalKg('')` en el `useEffect` de `open` (y al elegir otra
  bobina en «Reabrir y montar»).

### A-5 — P2 · Bajar la bobina puede quedar trabado si el sobrante ya no está entero

- **Dónde:** `coil-operations.service.ts` `reverseMountSurplusInTx` (revierte el ingreso completo).
- **Escenario:** montaje con `qtyKg` 100 sobre un físico de 300 (quedan 200 libres en una bobina
  `OPEN`); alguien registra una merma manual (RF-17) o el material se compromete en otra parte;
  después se intenta bajar la bobina sin usarla. La reversa saca 300 de un saldo de 200 (o rompe la
  invariante de reservas / materia prima) y la bajada entera falla con un mensaje de kardex, no de
  planta. La OP queda con una bobina montada que no se puede bajar sin pasar por otra corrección.
- **Corrección sugerida:** comprobar antes, con mensaje propio («el sobrante ya se usó en X: no se
  puede deshacer bajándola»), o bloquear mermas manuales sobre una bobina montada con sobrante
  vivo; al menos un test que fije el comportamiento.

### A-6 — P2 · El total «cuadra con el kardex» solo para movimientos vivos

- **Dónde:** `apps/api/src/reports/production-summary.service.ts:42-53`
  (`reversalOfId: null, reversals: { none: {} }`).
- **Escenario:** un reporte del 28/09 (salida en el rango septiembre) se anula el 03/10. El reporte
  de septiembre lo excluye por completo, pero el kardex de septiembre sigue mostrando la salida (y
  la reversa vive en octubre). Igual a la inversa. La suma «kg salido + `unattributedKg`» no cuadra
  con el kardex del rango en el sentido literal del brief, y un reporte de un mes cerrado cambia
  retroactivamente. Es la regla de D-291, pero D-468 promete «exactamente el kardex de producción
  del rango».
- **Corrección sugerida:** o precisar D-468 («el kardex vivo del rango, a la fecha de la consulta»)
  y decirlo en la pantalla, o contar el par por fechas (salida en su fecha, reversa en la suya) y
  declarar las reversas de otro rango aparte.

### A-7 — P3 · La lista de terminadas no marca «pide el peso físico»

- **Dónde:** `apps/web/src/app/(app)/planta/coil-picker.tsx:357-400`.
- **Escenario:** D-469 (4) dice «marcadas “pide el peso físico”»; la tabla solo muestra «kg al
  reabrir 0,000 kg». El aviso aparece recién dentro del paso de reapertura.
- **Corrección sugerida:** una etiqueta o columna con «pide el peso físico» cuando
  `needsPhysicalKg`.

### A-8 — P3 · Texto contradictorio en el paso de reapertura

- **Dónde:** `coil-picker.tsx:505-531`.
- **Escenario:** con `needsPhysicalKg` y sin ajuste de cierre, el aviso dice «reabrirla no mueve el
  kardex» y a continuación «esos kilos entran al kardex como sobrante».
- **Corrección sugerida:** con `needsPhysicalKg`, no mostrar la frase «no mueve el kardex».

### A-9 — P3 · El detalle de la bobina promete devolver kilos que la reapertura no devuelve

- **Dónde:** `apps/web/src/app/(app)/bobinas/[id]/bobina-detalle-view.tsx:174-177`.
- **Escenario:** montaje con sobrante → bajarla sin usar → la reversa (`refType` copiado,
  `CLOSE_ADJUSTMENT`, `refId` = consumo) queda como último movimiento y la red de D-360 la termina.
  En el detalle, `liveCloseAdjustment` mira solo `refType` y que no esté anulado: el diálogo de
  reabrir anuncia que vuelven N kg, y el API (que ahora exige `refId === coilId`) no revierte nada.
- **Corrección sugerida:** el mismo criterio que el API: `refId === coil.id` y que no sea una
  reversa (`reversalOfId` nulo).

### A-10 — P3 · El porcentaje del subtotal y del total incluye despunte de OPs sin teórico

- **Dónde:** `apps/api/src/reports/production-summary.ts` `figuresDto`/`add`.
- **Escenario:** una OP con solo despunte en el rango (D-468: teórico 0, sin porcentaje) suma su
  despunte al numerador del subtotal del pedido y del total, sobre el teórico de las otras OPs: el
  subtotal puede salir en rojo por un despunte de una OP cuyos reportes están en otro rango.
- **Corrección sugerida:** documentarlo en D-468 y en la ayuda de la pantalla, o calcular el % del
  subtotal solo con las OPs que tienen teórico.

### A-11 — P3 · «Vuelve al almacén» también aparece en drywall

- **Dónde:** `apps/web/src/components/production/close-preview-dialog.tsx:146-153`.
- **Escenario:** D-469 (6) dice que en drywall el fleje no vuelve al almacén, pero la línea
  «Vuelve al almacén: nada / X kg» se pinta siempre; solo la pregunta del 10 % depende de
  `mountedKg`.
- **Corrección sugerida:** mostrarla solo cuando se pasa `mountedKg` (coberturas), o confirmar que
  en drywall dice siempre «nada» y es deseado.

### A-12 — P3 · El costo del sobrante sin promedio es el del documento, sin costos de importación

- **Dónde:** `coil-operations.service.ts` `declareMountSurplusInTx` → `planCoilCloseAdjustment`
  (`documentUnitCostPen = unitCostPerKg × exchangeRate`).
- **Escenario:** con el saldo en 0 el promedio es 0, así que el sobrante entra al costo del
  documento de compra; en una bobina importada eso deja fuera el landed cost y la valoriza por
  debajo de lo que costó. Es la misma regla de D-164 (D-469 (1) lo dice), pero el caso «terminada
  en 0» es justo el que siempre cae en el respaldo.
- **Corrección sugerida:** confirmarlo con el dueño junto con D-469 (provisional); si el costo con
  importación está en la bobina o en su último ingreso, usar ese.
