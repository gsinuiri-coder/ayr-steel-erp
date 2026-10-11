# Revisión de segundo modelo: cc45 («Cambiar cantidad» con producción; D-603, D-604, D-605)

- **Fecha:** 2026-10-11
- **Revisor:** segundo modelo, Sonnet, contexto limpio (no es una persona; AGENTS.md §2, punto 2.2).
- **Alcance:** `git diff c4f3f83d..HEAD` (29 archivos: `sales-order-edits.service.ts`, `qty-change.ts`,
  `sales-orders.service.ts#reserveExtra`, `accessory-plan.ts` y sus usos en producción, esquemas
  compartidos, diálogo web, specs, `order-qty-change.db-spec.ts`, E2E y `seed-escenarios*`).
- **Método:** solo lectura. No corrí jest, db-spec ni Playwright; todo sale de leer el código y de
  cuentas a mano. Los `seed-escenarios*.mjs` solo los hojeé.

Resumen: **0 P0, 1 P1, 4 P2, 4 P3.** La transacción está bien armada (orden de bloqueos, un solo
camino para la acción y la vista previa, pisos en el servicio y no solo en la pantalla). El P1 es un
error de sintaxis en un E2E que rompe typecheck y esa suite. Los P2 son una regla sin cubrir
(AGENTS §3.17, pares concurrentes), un caso real con datos de producción (OP cerrada «corta») que
convierte una _baja_ en una OP nueva más una reserva nueva, y la reserva que se recalcula contra el
consumo teórico cuando el consumo real es otro.

---

## Hallazgos

### P1-1. Regex inválida en `huecos-cobertura-f8s2b.spec.ts`: el archivo no compila

- **Archivo:** `e2e/tests/huecos-cobertura-f8s2b.spec.ts:287, 288, 294`
  (`dialog.getByLabel(/^Nuevo (/)`).
- **Escenario:** `/^Nuevo (/` tiene un grupo sin cerrar. Es un `SyntaxError` al cargar el módulo (y
  TypeScript lo marca en `typecheck` con regex literales). No cae una aserción: cae **el archivo
  entero**, incluidos los dos tests que ya existían y no tocan «Cambiar cantidad». El `aria-label`
  real es `Nuevo (${unit})` (`change-line-qty-dialog.tsx:392`).
- **Corrección sugerida:** `/^Nuevo \(/` en las tres líneas (o el nombre exacto `Nuevo (und)` con
  `exact: true`). Correr `pnpm typecheck` y ese spec solo, con `pnpm exec playwright test
e2e/tests/huecos-cobertura-f8s2b.spec.ts`.

### P2-1. Bajar la cantidad con todas las OP cerradas «cortas» crea una OP nueva y reserva material

- **Archivo:** `apps/api/src/sales/sales-order-edits.service.ts:1544-1545` (`followPlan`) y 1316-1360
  (reserva).
- **Escenario:** la línea es de 100 m; su OP se cerró con 90 m registrados (posible con las 71 OP
  cerradas que hay en producción, anteriores a D-573, y con un plan ajustado por planta, D-084: el
  cierre exige registrado = plan de la OP, no = línea). El administrador **baja** la línea a 95 m.
  95 > 90 = `registeredQty`, así que `followPlan` no sale por la guarda
  `nextQty.lte(facts.registeredQty)` y crea una OP por 5 m. Antes, en 1316-1360, `pending = 5` hace
  `target > promised` (el cierre de la OP había liberado la reserva), así que `reserveExtra`
  reserva 5 m de material y, si no hay, pide confirmar un faltante. Una _baja_ termina reservando
  material y creando trabajo. Y subir de 100 a 101 crea una OP de 11 m, no de 1 m: coherente con la
  letra de D-604 («lo nuevo menos lo registrado»), pero el dueño debería saberlo.
- **Corrección sugerida:** decidir con el dueño (D-nnn) si la OP nueva nace solo cuando
  `nextQty > item.qty` (subida real) y, en una baja, no se crea ni se reserva nada; o si el
  «corto» se considera cerrado por decisión de planta. Mínimo: la guarda de `followPlan` y el
  cálculo de `target` deberían comparar también contra la cantidad anterior de la línea. Agregar al
  db-spec una OP cerrada con registrado < línea.

### P2-2. La reserva se recalcula contra el consumo teórico, pero la producción la consume con el real

- **Archivo:** `sales-order-edits.service.ts:1298-1360`; consumo en
  `roofing-production.service.ts:1341` (`consumeReservationQty(…, outKg)`) y `:2357` (despunte,
  `scrapKg`).
- **Escenario:** `target = reserveQty × (nuevo − registrado) / nuevo` es teórico (kg/m con merma).
  Pero cada reporte descuenta de la reserva los kilos **reales** que salieron de la bobina, y el
  cierre además descuenta el despunte. Si en 50 m se consumieron 330 kg y el teórico era 303, la
  reserva queda 27 kg por debajo de lo teórico pendiente. Al subir la línea 1 m, `target − promised`
  pide reservar esos 27 kg más los 6 kg del metro, y con poco stock el administrador ve un
  «faltante» que no corresponde a ese metro (o, con consumo menor al teórico, una baja libera más de
  lo que baja la línea). El texto de «Qué va a pasar» lo presenta como efecto del cambio.
  El db-spec no lo cubre: sus reportes consumen justo el teórico (6,06 kg/m), así que `target`
  y `promised` coinciden.
- **Corrección sugerida:** o bien mover la reserva por el **delta teórico** del cambio
  (`reserveQty_nuevo − reserveQty_anterior` proporcional a lo pendiente) en lugar de rebasarla
  contra el teórico total, o bien dejar documentado en D-604 que el cambio re-ancla la reserva y
  decir en el efecto cuánto de la diferencia es «ajuste por consumo real». Sumar un caso de
  db-spec con un reporte que consuma distinto del teórico y una OP cerrada con despunte.

### P2-3. Sin par concurrente en `lock-order.db-spec.ts` y sin pruebas de despachos en el db-spec

- **Archivos:** `apps/api/src/inventory/lock-order.db-spec.ts` (no está en el diff);
  `apps/api/src/sales/order-qty-change.db-spec.ts`.
- **Escenario:** AGENTS §3.17 dice que «un camino nuevo que tome documentos o inventario suma su par
  ahí». `changeItemQtyInTx` toma pedido → OP → reserva → bobinas → saldos (y `reserveExtra` entra por
  `reserveLines`), y no hay prueba de: (a) dos cambios simultáneos de la misma línea, (b) cambio +
  reporte de producción simultáneo, (c) cambio + despacho simultáneo. Por lectura del código el
  orden es correcto (el despacho y el reporte toman el pedido primero, `dispatches.service.ts:194` y
  `production.service.ts:699`, así que se serializan con el cambio), pero eso es lo que el par debe
  fijar. Tampoco hay ninguna prueba con **despachos**: el piso por despachado, el recálculo de
  `FULFILLED`/`PARTIALLY_FULFILLED` (`refreshFulfillment`) y la reserva proporcional de una línea de
  stock (`done = dispatchedQty`) solo están cubiertos por el unitario de `qtyFloorViolation`. Es la
  mitad de D-603 y la que toca el estado del pedido.
- **Corrección sugerida:** un par en `lock-order.db-spec.ts` (cambio ↔ reporte de coberturas y
  cambio ↔ despacho) y tres casos en el db-spec: despacho parcial de una línea de stock (subir y
  bajar al piso, reserva en lo pendiente), despacho que completa la línea (pedido pasa a
  `FULFILLED` al bajar hasta lo despachado y vuelve a `PARTIALLY_FULFILLED` al subir), y dos
  `updateItemQty` concurrentes con el segundo viendo el estado del primero.

### P2-4. «Producción registrada» se detecta solo por metros o planchas

- **Archivo:** `sales-order-edits.service.ts:964-1018` (`hasProduction`).
- **Escenario:** el código viejo rechazaba si la OP tenía **cualquier** reporte vigente. El nuevo
  mira `registeredQty > 0 || closedOrders.length > 0`, y `registeredQty` sale de `metersM` o de
  `piecesDetail`. Un reporte sin ninguno de los dos (los de drywall con reserva de pedido,
  `production.service.ts:298-708`) no cuenta: con una OP viva y un reporte así, la línea cae por el
  camino «sin producción» y se reescribe entera. Lo salva, por ahora, que ese reporte marca la
  reserva `CONSUMED` (`markReservationConsumed`) y el camino sin producción rechaza `CONSUMED`
  (líneas 1058-1062); es una defensa indirecta.
- **Corrección sugerida:** mantener la comprobación explícita del código viejo
  (`productionReport.count` ACTIVE de las OP de la línea > 0 ⇒ «con producción»), y que
  `qtyKindOf`/pisos traten el caso sin metros como piso cero pero con motivo y solo ADMINISTRADOR.

### P3-1. La vista previa toma bloqueos reales por cada pulsación

- **Archivo:** `sales-order-edits.service.ts:765-815`; `change-line-qty-dialog.tsx` (debounce 300 ms).
- **Escenario:** cada vista previa (y la consulta de contexto al abrir) corre `lockDocuments` con
  pedido, OP y reservas, más bobinas y saldos vía `reserveLines`, y los suelta al deshacer. Mientras
  tanto un reporte de planta o un despacho de ese pedido espera. Con 300 ms de debounce y varias
  filas, son varias transacciones pesadas seguidas. No es un defecto de correctitud (el rollback es
  correcto: `QtyPreviewRollback` sale de la transacción interactiva y Prisma revierte), pero conviene
  medirlo y, de ser necesario, subir el debounce o cancelar la consulta anterior.

### P3-2. La pantalla oculta «Cambiar cantidad» en líneas con todas las OP anuladas

- **Archivo:** `apps/web/src/app/(app)/pedidos/[id]/pedido-detalle-view.tsx` (`onlyCancelledOrders`).
- **Escenario:** una línea cuya OP se anuló para volver a la cola (D-186, `returnToProductionQueue`)
  no tiene OP viva y el API sí deja cambiarle la cantidad (camino sin producción: las anuladas no
  cuentan en `readQtyFacts`). Para el administrador el botón desaparece; antes estaba. Puede ser
  deliberado; no lo dice ningún comentario ni decisión.

### P3-3. Un accesorio cerrado «corto» cambia su plan visible

- **Archivo:** `apps/api/src/production/accessory-plan.ts:65` (`closed` ⇒ `min(plan, own)`).
- **Escenario:** para una OP de accesorio cerrada antes de D-573 con menos metros que su línea, el
  plan que muestran el listado y el detalle pasa de la línea entera (p. ej. 5 m) a lo que fabricó
  (4 m). Es consistente con D-605, pero cambia una cifra histórica visible sin tocar datos; vale una
  línea en D-605.

### P3-4. Inconsistencia entre los dos caminos con faltante

- **Archivo:** `sales-order-edits.service.ts:1049-1057` vs `1307-1309`.
- **Escenario:** sin producción, una línea con faltante sigue rechazándose («completá la reserva o
  anulá antes»), incluso para el administrador que sí puede confirmar con faltante en el camino con
  producción. La asimetría es defendible (conserva D-187/D-341), pero conviene decirla en D-603 para
  que nadie la lea como un olvido.

---

## Lo que revisé y no encontré problema

- **Orden de bloqueos (D-471/D-474):** `lockEditable` (pedido) → `readQtyFacts` (ids sin bloqueo,
  `lockDocuments` de OP y reservas, relectura bajo el bloqueo) → `reserveExtra`/`reserveLines`
  (bobinas y saldos). `createFromReservationInTx` vuelve a llamar a `lockDocuments` con pedido y
  reserva, pero ya los tiene (o la reserva es nueva y propia). El despacho (pedido primero) y el
  reporte (pedido → OP) se serializan con el cambio; el cambio no toma despacho ni comprobante, así
  que no hay ciclo.
- **Regla 8 (kardex):** nada del diff escribe `inventory_movements` ni `inventory_balances`; la
  reserva no es kardex y entra por la puerta de confirmar. **Regla 9 (Decimal):** todo cálculo usa
  `Decimal`; los `number` son conteos de planchas.
- **Pisos:** por largo (a medida), total registrado y total despachado se validan en el servicio
  (`qtyFloorViolation`) con las cifras releídas bajo el bloqueo; el piso suma todas las OP no
  anuladas (vivas y cerradas). El rechazo sin motivo, el 403 al vendedor y el bloqueo con comprobante
  están probados.
- **Sin regresión en D-187:** el camino sin producción conserva las guardas de reserva de otro tipo,
  faltante y `CONSUMED`, y reasigna la OP viva como antes; los E2E ajustados siguen probando lo
  mismo con el diálogo nuevo.
- **Plan de la OP viva y OP nueva por la diferencia:** `piecesMinus` por largo sin negativos;
  `createFromReservationInTx` con `plan: []` (accesorio) es válido porque `[]` es truthy.
- **D-605:** `accessoryPlans` es una sola consulta por lote y ninguna sin accesorios; los lectores
  que cambiaron (lista, detalle, lote de planta, cola, reporte, cierre, borradores) usan la misma
  función. El lote de planta solo lista OP abiertas, así que no necesita `closed`.
- **Vista previa:** corre el mismo `changeItemQtyInTx`, no deja nada fuera de la transacción (la
  auditoría y la OP nueva están dentro) y traduce rechazos 4xx en `outcome.message`; los 5xx se
  propagan.
- **Web:** `draftFromRows`/`draftFromSingle` reflejan los pisos del API; `Button` con
  `pending`/`pendingText`; `confirmShortfall` solo se manda si la vista previa lo pide.

Pendiente de mirar con más detalle (no revisado a fondo): `scripts/seed-escenarios.it.mjs` y la
aritmética de redondeo de `toFixedString(…, 'KG')` frente a `consumeReservationQty` en 3 decimales.

## Atención de los hallazgos (sesión cc45)

La autorrevisión (subagente sin el handoff) no encontró P0. Su P1 y los P1/P2 de este informe se
corrigieron antes del deploy:

- **P1-1 (regex del E2E):** `huecos-cobertura-f8s2b.spec.ts` usa la etiqueta literal
  `'Nuevo (und)'`.
- **P2-1 (bajar con la OP cerrada corta):** con todas las OP de la línea cerradas, solo **subir**
  pide material y abre una OP por la diferencia; bajar no reserva nada ni crea órdenes. Queda en
  D-604.
- **P2-2 (consumo teórico frente al real):** es a propósito y queda en D-604: la reserva queda en
  lo que falta fabricar, calculado con el teórico. Cuando eso libera kilos al subir, «Qué va a
  pasar» lo dice («se ajusta a lo que falta fabricar… lo consumido fue menos que lo teórico»).
- **P2-3 (concurrencia y despachos):** el par (c) de `lock-order.db-spec.ts` ahora manda motivo y
  faltante confirmado (cruza los dos caminos) y hay un par nuevo (e) «cambiar la cantidad con
  producción × revertir el reporte». El E2E de cc45 suma un caso con despachos: piso por lo
  despachado (400), bajar a lo despachado deja el pedido atendido y la reserva en cero, y subir
  lo devuelve a parcialmente atendido con la reserva de lo que falta.
- **P2-4 (producción detectada solo por metros):** cualquier parte vigente cuenta como producción.
- **P1 de la autorrevisión (línea con OP de perfiles anterior a D-599):** el camino con
  producción la rechaza con el código de la orden; `reserveExtra` revive una fila CONSUMIDA desde
  cero (su `qty` es la cifra que su reversa necesita) y bajar no toca `qty` de una fila que no
  está activa.
- **P2 de la autorrevisión:** la vista previa ya no crea la OP nueva (el correlativo no volvía con
  el rollback): dice «Nace una orden nueva por la diferencia». El diálogo se monta por línea y
  solo abierto (no reabre con datos viejos), muestra el error de la vista previa y espera 500 ms
  entre teclas (P3-1 de este informe).
- **Se quedan como están:** P3-2 (la ESPEC pide no ofrecer el botón con la OP anulada), P3-3 (un
  accesorio cerrado se mide contra lo que fabricó, D-605) y P3-4 (sin producción sigue D-187 tal
  cual, con su rechazo por faltante).
