# cc29 corte 2 — revisión de segundo modelo (contexto limpio)

Alcance: `git diff 8ce80ac8..HEAD` (M2 reporte de producción, M3 sobrante de bobina terminada) más las filas D-464, D-466, D-468 y D-469 de `docs/ARQUITECTURA.md`. Solo lectura: no se corrió nada contra producción ni contra base alguna; no se ejecutaron tests nuevos. Es un modelo, no una persona; no cierra la revisión (AGENTS.md §2.2).

Qué se verificó y está bien: el filtro de `reverseCloseAdjustment` (`refId === coilId`) es compatible con los ajustes de cierre ya grabados (`coil-operations.service.ts:923` escribe `refId: coil.id`). La reversa de un sobrante copia el `refId` del original (`inventory.service.ts:587`), así que el movimiento inverso tampoco se confunde con un ajuste de cierre en la siguiente reapertura. El supervisor no recibe costos: el DTO y el Excel salen del mismo objeto con los campos en `null`. Los tres roles del sistema (solo ADMINISTRADOR y SUPERVISOR_PLANTA llegan a `/production/roofing`) hacen redundante el chequeo de rol, pero es inocuo.

## Hallazgos

### SM-1 — P1 — Se puede fabricar inventario de una bobina vendida o partida

`apps/api/src/production/roofing-production.service.ts:3030-3060` y `:3118-3130` (picker, `needsPhysical`); `apps/api/src/production/roofing-production.service.ts:707-731` (mount); `apps/api/src/coils/coil-operations.service.ts:694-735` (`declareMountSurplusInTx`).

El picker ofrece **toda** bobina `CLOSED` de la spec con kardex en 0 («pide el peso físico»), y el API acepta `physicalKg` sobre cualquiera. Nada comprueba por qué quedó en 0. Una bobina con kardex 0 puede estar así porque:

- se vendió entera como reventa (la venta cierra la bobina; `dispatches.service.ts:989` la cierra y AGENTS §7 lo dice),
- es la madre ya partida en flejes/hijas (RF-16),
- se mermó entera por RF-17.

Escenario: bobina FFA-x vendida y despachada al cliente, `CLOSED`, kardex 0. Planta la ve en «Terminadas», declara 480 kg (la cota es solo `weightKg` de entrada), y entran 480 kg de sobrante valorizados a costo de compra, sobre un rollo que ya no está en la planta. Es stock inventado con auditoría, de la clase que la regla 8 y D-150 quieren evitar; con la madre partida, además, duplica el peso ya repartido en las hijas (la cota «no más de lo que entró» no descuenta lo que salió por venta o partido).

Corrección: restringir el ofrecimiento y el API a bobinas cuyo kardex llegó a 0 por consumo de producción (último movimiento vivo `PRODUCTION`/`SCRAP`/autoterminación D-360), sin movimiento `SALE`, sin hijas (`parentCoilId`/`SPLIT`), y rechazar en `declareMountSurplusInTx` con el mismo criterio (la regla en el API, no solo en el picker). Subsidiariamente, descontar de la cota lo que ya salió por venta/partido. Agregar test por cada causa de cero.

### SM-2 — P2 — Merma por bobina: el sobrante de montaje se imputa como «ajuste de cierre» al período equivocado

`apps/api/src/reports/coil-waste.ts:111-117` y `:66`.

El sobrante de montaje es un `CLOSE_ADJUSTMENT` de entrada y `coil-waste` suma por tipo sin mirar `refId`. Dos efectos reales: (a) en un rango que contiene solo el período del montaje, la bobina trae `closeAdjustment = −X` frente a un consumo de solo la parte reusada, y su `wasteKg` sale negativo (p. ej. consumo 100 kg contra teórico 99 y sobrante −120 da −119 kg): una fila que parece «ganancia» y arrastra los totales; (b) una bobina que solo tiene el sobrante en el rango (montada y bajada en distinto día; o montada sin reportar aún) entra al alcance (`inScopeCoilIds`) con teórico `null`/0. El brief pide que sea visible en el reporte de merma; lo está, pero mezclado con la liquidación del cierre sin poder distinguirse.

Corrección: en `coil-waste` separar los `CLOSE_ADJUSTMENT` por `refId === itemId` (cierre) frente a los que apuntan a un montaje, mostrando el segundo como columna/nota «sobrante al montar» y decidiendo explícitamente (con decisión D-nnn) si entra en `wasteKg`. Test con ambos tipos en la misma bobina.

### SM-3 — P2 — El Excel puede pasar del tope de 5000 filas y el reporte no tiene tope de rango

`apps/api/src/reports/production-summary-xlsx.ts:20-25`; `apps/api/src/reports/production-summary.service.ts:44-56`.

`assertExportable` mide `max(orderRows, coilRows)`, pero la hoja «Por OP» además escribe una fila de subtotal por pedido y la de total: puede salir con `orderRows + grupos + 1` filas, sobre el tope de D-446 (que dice «nunca un archivo recortado», y aquí es lo contrario: un archivo por encima del tope). Además, `findMany` de movimientos no tiene límite ni se acota el rango (`productionSummaryQuerySchema` solo exige `from <= to`): un rango de varios años carga todos los movimientos en memoria antes de que el tope se evalúe, y la pantalla (JSON) no tiene tope alguno.

Corrección: contar filas reales de la hoja (OPs + subtotales + 1) y, preferible, acotar el rango máximo en el esquema (p. ej. 366 días) o evaluar el tope sobre el conteo de OPs antes de armar el DTO.

### SM-4 — P2 — El test del M3 no ejercita el camino real que garantiza la reversa

`apps/api/src/coils/coil-mount-surplus.spec.ts` (todo el archivo); `e2e/tests/sobrante-bobina-cc29.spec.ts`.

Los unitarios usan mocks de `tx`: «la reapertura no revierte el sobrante» solo prueba el `if` de `refId`, no el orden real mount → reopenInTx → declare, ni que el sobrante sobreviva a la reapertura de una segunda ocasión. La cobertura que sí cubre el flujo es E2E y un par de `db-spec` (que no se corrieron aquí). El test de `reverseMountSurplusInTx` verifica el `where` de `findFirst`, no que `reversals: { none: {} }` evite revertir dos veces. No es un defecto de producto, pero la pieza toca kardex y su prueba unitaria no prueba el comportamiento; conviene un test de servicio sobre `releaseCoil` (reversa → autoterminación → «terminada en 0» → vuelve a ofrecer «pide peso físico») y otro de bajar la bobina cuando el saldo ya no alcanza.

### SM-5 — P3 — Bajar la bobina puede fallar de forma críptica si el saldo ya no cubre el sobrante

`apps/api/src/production/roofing-production.service.ts:891-898`.

`releaseCoil` exige `consumedKg = 0`, pero una merma RF-17 o una reserva/partido posterior sobre esa bobina (si el flujo lo permite con la bobina montada) deja el saldo por debajo del sobrante; `inventory.reverse` rechazará con el mensaje genérico de reversa y el usuario no entenderá que es el sobrante del montaje. Corrección: capturar y traducir el error («para bajarla hay que deshacer primero el sobrante declarado; el saldo ya no lo cubre»). No verificado contra la base: si la merma sobre una bobina montada ya está prohibida, el caso no existe.

### SM-6 — P3 — «Vuelve al almacén» se muestra siempre, también en drywall

`apps/web/src/components/production/close-preview-dialog.tsx` (nuevo `<li>Vuelve al almacén`), frente a D-469(6), que dice que en drywall el fleje no vuelve al almacén.

La línea se pinta sin importar si el padre pasó `mountedKg`. En drywall casi siempre dirá «nada» (correcto), pero si un fleje queda con `balanceAfterKg > 0` por cualquier causa mostraría una promesa falsa. Corrección: mostrarla solo cuando se pasa `mountedKg` (coberturas) o ajustar el texto según la línea.

### SM-7 — P3 — El reporte descarta en silencio el despunte que no apunta a una OP conocida, y el cuadre solo cubre `PRODUCTION`

`apps/api/src/reports/production-summary.ts:121-123`; `unattributedKg` (`:142-145`).

Un `SCRAP` cuyo `refId` no sea una OP del mapa (OP de otra línea, uuid ajeno) se `continue` sin sumarse a nada, mientras que una salida `PRODUCTION` sin reporte sí se declara en `unattributedKg`. La promesa «los kg cuadran con el kardex de producción del rango» deja de valer para el despunte sin avisar. La merma manual (refId = bobina) es legítima de dejar fuera; el resto debería sumar a un total «despunte sin OP». Menor, porque hoy el único escritor de `SCRAP` con refId distinto de la bobina es el cierre de OP.

### SM-8 — P3 — Observaciones de forma

- `declareMountSurplusInTx` usa `reopenReason` como motivo del sobrante (`roofing-production.service.ts:756`) y la UI lo rotula «Motivo de la reapertura»: el kardex guarda como nota del sobrante un texto pensado para otra cosa. Conviene un campo o un rótulo «motivo de la reapertura y del sobrante».
- El test de «solo movimientos vivos» del servicio verifica el argumento `where` de un mock, no una base: si alguien reescribe el filtro (`reversals: { none: {} }`) el test no distingue semántica; el db-spec del reporte lo cubriría mejor.
- Las comprobaciones de rol dentro del servicio quedan correctas pero hoy son inalcanzables desde HTTP (el controlador ya limita); dejarlo, sirve de red.

## Veredicto

No listo para el deploy hasta cerrar SM-1 (P1). El resto (P2/P3) es corregible en la misma entrega o con decisión explícita del dueño (SM-2 necesita una decisión D-nnn sobre cómo cuenta el sobrante de montaje en la merma). M2 (reporte) es sólido: cuentas, roles y costos correctos; solo el tope de Excel y el rango. M3 tiene un diseño de kardex correcto (tipo, costo, refId al montaje, reversa en la misma pieza, par concurrente), pero deja una puerta abierta a stock inventado sobre rollos que se fueron por otra vía.

Conteo: P0 0, P1 1, P2 3, P3 4.
