> **AUTORREVISIÓN — pendiente de revisión independiente.** Hecha por un subagente nuevo del mismo modelo que escribió el cambio; no vale como pase cruzado (AGENTS.md §2.2).

# Autorrevisión — hallazgos de la guía (D-310, D-311, D-312)

## Alcance revisado

- `3bfe9a6` (M1, D-310): `findCoilTies` / `coilTieReasons` en `apps/api/src/sales/coil-sale-product.ts`, `assertCoilsNotTied` en `apps/api/src/sales/sales-lines.ts`, llamadores en `quotations.service.ts` (alta, edición, duplicado) y `sales-orders.service.ts` (pedido directo, `sellable-coils`, `sellable-coils/unavailable`), `coil-sale-unavailable.ts`.
- `33e8f21` (M2 + M3, D-311/D-312): `apps/api/src/sales/reservation-dispatches.ts`, `ReservationDto` en `packages/shared/src/schemas/sales.ts`, `toReservationDto`/`toDto`/`findOne`/`findReservations`/`release` en `sales-orders.service.ts`, `apps/web/src/app/(app)/pedidos/[id]/pedido-detalle-view.tsx`.
- Pruebas leídas: `sales-lines-coil.spec.ts`, `coil-sale-unavailable.spec.ts`, `reservation-dispatches.spec.ts`, `bobina-atada-d310.spec.ts`, `despacho-fecha-comprobante-d278.spec.ts`.
- Verificado con jest (no E2E, no build): `src/sales`, `src/imports`, `src/pos` — 40 suites / 435 pruebas en verde. Se leyeron además los llamadores de `resolveSalesLines` (los 6 de `apps/api/src`), el importador de cotizaciones, `consumeReservationQty`/`resolveDispatchTarget`, `cancel` del pedido, `orderProgress`, los roles de `invoicing.controller`/`dispatches.controller` y el `QueryClient` del web.

Resultado: 0 P0, 0 P1, 7 P2 (H1-H7) y una lista de brechas de cobertura (§6). Ninguno es un bloqueante; varios son decisiones de alcance que conviene que el dueño confirme.

---

## 1. Regresiones (caminos que antes guardaban y ahora rebotan)

**Sin hallazgos de regresión en los caminos pedidos.** Verificado:

- Confirmar cotización → pedido: `confirm` no llama a `resolveSalesLines` (los únicos llamadores son alta/edición/duplicado de cotización, `createDirectInTx` y tres puntos de `sales-order-edits.service.ts`), así que la propia cotización no se bloquea al confirmarse.
- Importador de históricos: `quotation-import.service.ts:~715` siempre pasa `exactAmounts`, y `quotations.service.ts:165` solo añade `coilTies` cuando `exactAmounts` no viene. Correcto.
- Edición de la propia cotización: `quotations.service.ts:280` pasa `exceptQuotationIds: [id]`; el E2E paso 3 lo cubre.
- Reserva temporal propia (D-185): `findCoilTies` y `reservedByItem` excluyen la misma cotización con el mismo `excludeQuotationId`; no hay doble conteo entre reserva temporal y atadura de la misma cotización (en `unavailable` la bobina es una sola fila, y la razón sale por precedencia mounted > firm > temporary > tied).
- `findCoilTies` casa con `reserveItemType = COIL`; tras D-134 (`reserveFromCoilId` desapareció de `sales-lines.ts`) eso equivale a venta de bobina entera para documentos nuevos, así que el texto «la vende entera» es correcto salvo datos previos a D-134 (no reproducible desde código nuevo).

### H1 (P2) — Datos previos con dos cotizaciones abiertas sobre la misma bobina bloquean editar cualquiera de las dos

`apps/api/src/sales/quotations.service.ts:280` + `apps/api/src/sales/sales-lines.ts:860-886`.
Escenario: en producción ya existen COT-A y COT-B (ambas `EMITTED`) con la misma bobina X en una línea `saleCoilId` (posible antes de D-310, porque nada lo impedía al guardar). Un vendedor edita solo las observaciones o el precio de COT-A: `except = [A]` no excluye a B, `findCoilTies` devuelve el tie de B, y el PUT rebota con «no se puede vender: atada a COT-B» aunque A no tocó la bobina. Para un VENDEDOR, si B es de otro, dice «no disponible» sobre una bobina que es suya en A.
Recomendación: en la edición, no rechazar una bobina que la cotización ya tenía guardada (mismo criterio que `preexistingCoilIds` del papel) — solo las que se agregan o cambian; o medir en dry-run (consulta de solo lectura vía servicio) cuántos pares así hay antes de desplegar.

## 2. Alcance de vendedor (D-267/D-275)

**Sin hallazgos que filtren número o vendedor.** Verificado: `coilTieReasons` y `unavailableCoilReason` devuelven «no disponible» sin número para un VENDEDOR frente a una cotización ajena y nombran la propia si existe; `ReservationDto.dispatchId/dispatchCode` solo se llena desde el detalle del pedido (protegido con `assertSellerAccess`), `findReservations` (filtrado con `sellerWhere(actor)`) y `release`; los tres roles pueden leer `orders/:id/progress` y `dispatches/:id` (`invoicing.controller.ts:158`, `dispatches.controller.ts:38`), y `progress` repite `assertSellerAccess`.

### H2 (P2, matiz) — El texto de rechazo confirma que existe otra cotización abierta aunque el motivo sea «no disponible»

`apps/api/src/sales/sales-lines.ts:883`.
Escenario: VENDEDOR v-2 intenta vender la bobina X atada a la cotización de v-1. Recibe `Línea 1: la bobina SALDO-… no se puede vender: no disponible (otra cotización abierta la vende entera)`. El sufijo entre paréntesis revela que la causa es una cotización abierta (no una OP ni un pedido), cosa que el pool y el selector evitan diciendo solo «no disponible». No revela número ni vendedor, así que el impacto es bajo; pero el spec (`sales-lines-coil.spec.ts`, «a un VENDEDOR no se le nombra…») solo verifica `/no disponible/` y no ampara el sufijo.
Recomendación: omitir el paréntesis cuando `reason === 'no disponible'`, o decidir explícitamente que ese nivel de detalle es aceptable (D-nnn).

## 3. Carreras y doble conteo

### H3 (P2) — La comprobación de atadura no está serializada: dos altas simultáneas pueden atar la misma bobina

`apps/api/src/sales/sales-lines.ts:860-886` (sin lock sobre `coils`; los únicos `FOR UPDATE` de bobinas están en confirmar/despachar).
Escenario: v-1 y v-2 guardan a la vez una cotización con la bobina X; ambas transacciones leen `findCoilTies` = vacío antes de que la otra confirme, y ambas guardan. Queda el estado que D-310 quiere evitar; lo atrapa el confirmar (la segunda reserva falla), es decir el mismo comportamiento previo al cambio, no peor.
Recomendación: aceptar y documentar como límite conocido (el confirmar sigue siendo la barrera dura), o tomar `SELECT … FOR UPDATE` sobre las bobinas de las líneas antes de `findCoilTies`, con el orden de locks ya usado (`ORDER BY id`).

### H4 (P2) — Una cotización `EMITTED` vencida pero aún sin barrer sigue atando la bobina

`apps/api/src/sales/coil-sale-product.ts:397-401` (`status IN (DRAFT, EMITTED)`).
Escenario: COT-A `EMITTED` con `validUntil` de ayer; el barrido `expireDue` no ha corrido (en demo `JOBS_ENABLED` está apagado por default). `effectiveStatus` en `quotations.service.ts` ya la trata como vencida al leer, pero `findCoilTies` no, así que la bobina sigue «atada a COT-A» y el guardado de otra cotización rebota. La misma condición existía en el pool; D-310 la extiende al selector y al guardado, donde antes no bloqueaba.
Recomendación: excluir en `findCoilTies` las `EMITTED` con `validUntil < hoy` (misma función `isQuotationExpired`), o registrarlo como límite conocido.

**Sin hallazgos** en: reserva con varias entregas (se muestra la última entrega vigente; ver H6 para el matiz de texto), despachos `REVERSED` (el filtro `dispatch.status = ISSUED` los excluye y la reversa devuelve la reserva a `ACTIVE`, que no entra en `consumed`), y una reserva `CONSUMED` por OP con la terna igual a una línea de despacho (los ítems de OP son `RAW_MATERIAL`, los del despacho `PRODUCT`/`COIL`; no colisionan).

## 4. Presupuesto de consultas

Consultas nuevas por petición (medidas por lectura de código, no ejecutadas):

| Petición                                             | Consultas nuevas                                                                                                               | Dónde                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `GET /sales/sellable-coils`                          | +1 (`quotationItem.findMany`), **secuencial** tras el `Promise.all`                                                            | `sales-orders.service.ts:3236`         |
| `GET /sales/sellable-coils/unavailable`              | +1, **secuencial** antes del `Promise.all`                                                                                     | `sales-orders.service.ts:3316`         |
| Alta/edición/duplicado de cotización, pedido directo | +1 solo si alguna línea trae `saleCoilId` no papel; 0 en el resto                                                              | `sales-lines.ts:860`                   |
| `GET /sales/orders/:id` (`findOne`)                  | +1 (`dispatchItem.findMany`) solo si hay reservas `CONSUMED`; entra en el `Promise.all` existente                              | `sales-orders.service.ts:2714`         |
| `GET /sales/reservations`, `release`                 | +1 condicional a que haya `CONSUMED`                                                                                           | `sales-orders.service.ts:3431`, `2331` |
| Web, detalle del pedido                              | +1 petición HTTP (`orders/:id/progress`), ~5-6 consultas en el API (pedido+items, 2 `groupBy`, 1-3 de etiquetas) en cada carga | `pedido-detalle-view.tsx:99`           |

No hay prueba de presupuesto de consultas para ninguna de estas rutas (no existe test análogo a `stock-panel-batch.spec.ts` para `sellable-coils`).

### H5 (P2) — Las dos consultas nuevas de bobinas van en serie y no dentro del `Promise.all`

`apps/api/src/sales/sales-orders.service.ts:3236` y `:3316`.
Escenario: con el RTT runner→Neon que ya mide D-201, cada consulta serial suma una ida y vuelta completa por petición del selector (que el web dispara al abrir el modal). `findCoilTies` solo depende de `ids`, igual que `balances`/`reserved`/`assigned`, así que puede correr en paralelo.
Recomendación: incluirla en el `Promise.all` existente de cada método.

## 5. UI (`pedido-detalle-view.tsx`)

**Verificado sin hallazgo:** el `useQuery` de `progress` está declarado en la línea 99, antes de `plantSheetActions` y de los retornos tempranos (reglas de hooks bien); en carga o error (`progress.data === undefined`) el botón se ofrece (por diseño, el API sigue cortando); los tres roles con acceso al detalle tienen permiso en `orders/:id/progress`; `FULFILLED`/`CANCELLED` ocultan «Despachar» sin esperar la consulta.

### H6 (P2) — `progress` no se invalida con las ediciones del pedido: «Despachar» puede quedar oculto (o visible) con la cifra vieja

`apps/web/src/lib/sales-queries.ts` (`invalidateSales` no toca `['order-progress']`) + `pedido-detalle-view.tsx:99,212`; `providers.tsx` sin `staleTime` (0, se refresca solo al montar).
Escenario: en el detalle abierto de un pedido cuyas líneas ya salieron completas pero el estado no es `FULFILLED`, o al revés, el usuario aplica un cambio desde los diálogos de `order-edit-dialogs.tsx` (cantidad, ítem, precio). Invalidan `['sales-order', id]` pero no `['order-progress', id]`, así que `hasPendingDispatch` conserva la lectura anterior hasta recargar la pantalla. Caso concreto: subir la cantidad de una línea ya despachada en un pedido `PARTIALLY_FULFILLED` con todo despachado → el botón sigue oculto.
Recomendación: invalidar `['order-progress', orderId]` dentro de `invalidateSales` cuando llegue `orderId` (el resto de pantallas de progreso ya lo comparten). Efecto secundario menor relacionado: mientras carga, el botón aparece y puede desaparecer al llegar la cifra (salto de layout); si molesta, ocultarlo hasta que `progress.isSuccess`.

### H7 (P2, texto) — Con varias entregas por reserva el aviso lista solo la última

`apps/api/src/sales/reservation-dispatches.ts:45-54` y `pedido-detalle-view.tsx:193-196`.
Escenario: una línea de 700 kg despachada en dos guías (DES-10 con 200 kg, DES-12 con 500 kg): la reserva pasa a `CONSUMED` con la segunda, y el aviso dice «Entregada en DES-000012» sin mencionar DES-000010. No es incorrecto pero sí incompleto respecto a «dónde se entregó». Además `deliveryCodes` desestructura `[id, code]`, sombreando el `id` de la prop del componente (sin efecto hoy).
Recomendación: aceptable como está si el dueño quiere solo «la última»; si no, devolver la lista de despachos vigentes por reserva.

## 6. Pruebas: caminos nuevos sin cobertura

- **Edición de líneas de un pedido (`sales-order-edits.service.ts:521`, agregar ítems):** no pasa `coilTies`. Con `saleCoilId` de una bobina atada a una cotización abierta, `POST /sales/orders/:id/items` la acepta (el selector web ya no la ofrece, pero el API sí la deja). El spec «sin la opción, la línea a mano no mira las cotizaciones (importador, ediciones de pedido)» lo fija como diseño. Es una brecha frente a la redacción del alcance de D-310; conviene que el dueño la confirme o la cierre (P2, decisión de alcance).
- **Pedido directo (`sales-orders.service.ts:1121`) y mostrador (`pos.service.ts` vía `createDirectInTx`, `counterSale`):** ningún unit ni E2E ejerce el rechazo por atadura. Hoy el mostrador también rebota una bobina atada; no hay prueba de que ese sea el comportamiento deseado.
- **VENDEDOR real en E2E:** el único E2E de D-310 corre como administrador. Los textos «no disponible» solo tienen unit sobre la función (`coil-sale-unavailable.spec.ts`, `sales-lines-coil.spec.ts`); falta la ruta HTTP de `sellable-coils` y `unavailable` con un VENDEDOR distinto del dueño de la cotización (existe `coil-pool-alcance-vendedor-sm-p1-1.spec.ts` como plantilla).
- **Duplicado:** el E2E cubre la original abierta (400); no cubre que duplicar una cotización cuya bobina ya está libre sí pasa.
- **D-312 caso positivo:** el E2E solo comprueba que «Despachar» desaparece con el pedido atendido. Falta que siga apareciendo con un despacho parcial (pendiente > 0) y que no aparezca con líneas completas en un pedido no `FULFILLED`.
- **D-311 varias entregas y reversa:** `reservation-dispatches.spec.ts` cubre «gana la última» y el filtro `ISSUED`, pero ningún E2E cubre reserva con dos despachos ni despacho revertido en el detalle.
- **`toReservationDto` con `dispatches` omitido:** el parámetro por defecto es `new Map()` y hoy todos los llamadores relevantes lo pasan; una respuesta futura que arme `SalesOrderDto` sin él mostraría `dispatchId: null` para una reserva ya entregada (no hay prueba que lo detecte).

---

## Resumen

- P0: 0
- P1: 0
- P2: 7 (H1 datos previos bloquean edición, H2 sufijo del rechazo a VENDEDOR, H3 carrera sin lock, H4 `EMITTED` vencida ata, H5 consultas seriales, H6 `progress` sin invalidar, H7 solo la última entrega), más las brechas de cobertura de §6 (incluida la de agregar ítems a un pedido, que es decisión de alcance).

---

## Resolución (la sesión que escribió el cambio, después de la autorrevisión)

Los tres primeros se corrigieron en la rama; el resto queda anotado para quien revise después.

- **H1 corregido:** la edición de una cotización no rechaza una bobina que ya vendía (`keepCoilIds`
  ← `storedCoilIds`); solo lo que se agrega o cambia. Prueba unitaria nueva en `sales-lines-coil.spec.ts`.
- **H2 corregido:** al VENDEDOR frente a la cotización de otro el rechazo termina en «no disponible»,
  sin el paréntesis que confirmaba que otra cotización la tiene.
- **H6 corregido:** `invalidateSales` invalida `['order-progress']`.
- **H3, H4, H5, H7 sin cambio:** H3 (carrera sin lock) sigue teniendo como barrera el confirmar, como
  antes; H4 (`EMITTED` vencida sin barrer) depende del barrido de vencimientos; H5 (dos consultas en
  serie) es de rendimiento sin impacto medido; H7 (solo la última entrega) es de presentación.
- **Brecha de alcance para el dueño:** agregar ítems a un pedido confirmado
  (`sales-order-edits.service.ts`) no pasa `coilTies`; el brief nombró alta, edición y duplicado de
  cotización, y un spec fija ese comportamiento como diseño.
