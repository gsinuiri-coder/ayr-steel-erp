# Revisión de segundo modelo — D-383 (PR #90, rama `d383/proteger-anular-pedido`)

Revisor: segundo modelo (Sonnet, contexto limpio). Alcance: `git diff origin/main...HEAD` completo (18 archivos). No es una aprobación: la revisión que cierra es la del dueño.

Corrido: `jest` sobre `src/sales`, `src/pos` e `invoicing-net.spec.ts` (47 suites, 612 tests, verde); `tsc --noEmit` de api y web (limpio); `eslint` de los 7 archivos de producto/spec tocados de api y web (limpio). No se corrió E2E ni se levantó ningún servidor.

## Veredicto

Sin P0 ni P1. La lógica de bloqueo, la casilla, los locks y las unidades del cálculo de lo fabricado son correctas según lo leído. Quedan 2 P2 y 5 P3, todos de robustez o de lo que no pude verificar sin E2E.

## Lo que se verificó y está bien

- **Unidades de lo fabricado** (`order-cancel-checks.ts:~170-230`): `inventoryMovement.qty` (IN de producción) y `dispatchItem.reserveQty` están ambos en la unidad del ítem de kardex (el schema documenta `reserveQty` así), y se filtra por `itemId === item.productId` en ambos lados, igual que `fabricatedAliveQty` (D-379). No hay mezcla de metros con piezas ni de kg. `qty` va con `toFixed(3)`; la UI lo muestra con `toDecimal().toString()` (24.600 pasa a 24.6, y el E2E espera «24.6 MTR», coherente).
- **Presupuesto de consultas**: el test de `cancelPreview` fija 7 consultas sin fabricado y 10 con fabricado; coincide con el conteo del código (pedido 1 + OP 1 + comerciales 3 + fabricado 1 o 4 + anulados 1). `fabricatedLooseLines` es de 4 consultas fijas, sin N+1.
- **`assertStillAvailable`**: el control nuevo vive solo en la rama de comprobantes de venta (el `return` de guía de remisión y el de nota de crédito están antes), así que las NC, las guías y la reversa del mostrador por NC no se ven afectadas. El POS crea y emite su comprobante con el pedido `CONFIRMED`; `PosService.void` por NC pasa por la rama NC. `send` y `registerManual` son los únicos llamadores y ambos ya corren bajo el lock de la fila del borrador. Sin efectos colaterales encontrados.
- **Concurrencia**: `cancel` toma pedido, reservas y luego los borradores del pedido `ORDER BY id FOR UPDATE`. `registerManual`/`assignInTx` bloquean el documento y no toman después el lock del pedido ni de reservas (solo leen), así que no hay ciclo. `createInvoice` y la creación de despachos toman el lock del pedido, que ya es de `cancel`. Si el registro gana, `cancel` ve el comprobante ya vivo (READ COMMITTED, sentencia nueva tras el lock) y bloquea; si `cancel` gana, el registro ve el pedido `CANCELLED`. Correcto.
- **Llamadores de `cancel`**: solo el controlador y `PosService.void`; ambos actualizados a `{ reason }` y typecheck limpio. El anulado completo por NC viva del mostrador sigue pasando (filtro de «acreditado por completo»).
- **E2E existentes**: los helpers `purgeInvoicingTrail`, `purgeSalesTrail` y `purgeRoofingTrail` ya mandan `acknowledgeFabricated: true`; `purgeInvoicingTrail` anula los comprobantes (paso 3) y revierte despachos (paso 4) antes de anular pedidos (paso 5). Los specs que anulan pedidos a mano (`fase7`, `fase7e` 216, `fase5a`, `correcciones-03`) no tienen comprobante, despacho ni fabricado vivo en ese momento. `traer-comprobante-d381` se reordenó bien.
- **Web**: `consumedByLiveOrder` es consistente con `toReservationDto` (`productionOrderId` solo sale de OP en DRAFT o IN_PROGRESS); `isEditable` usa `STANDING_DOCUMENT_STATUSES`, así que el texto «vivo o en borrador» del título es exacto. Selectores del E2E nuevo (`dialog name 'Anular <código>'`, `getByLabel('Motivo')`, checkbox por label, `data-testid`) coinciden con el DOM del diálogo; `huecos-cobertura-f8s3b` solo exige el rol dialog y el nombre `Anular <código>`, que se conservan. Mínimo de motivo (3) y máximo (240) coinciden con `reasonSchema`.

## Hallazgos

### P2-1 — Las limpiezas de E2E ahora fallan en silencio si el pedido queda con comprobante vivo o despacho vigente

`e2e/helpers/sales.ts:862-867`, `e2e/helpers/roofing.ts:721-725`, `e2e/helpers/invoicing.ts:1021-1026`, todos con `.catch(() => undefined)`.
Antes, `cancel` aceptaba un pedido con despacho emitido o comprobante vivo, así que el `finally` dejaba el pedido anulado y las reservas libres. Ahora esos dos casos devuelven 400 y el `catch` lo traga: el pedido sigue `CONFIRMED`, con reserva y bobina retenidas, y contamina los casos siguientes de la corrida (el mismo síntoma que D-186 ya documentó). Escenarios concretos: (a) `purgeInvoicingTrail` paso 3 deja un comprobante `ISSUED_HERE` en `VOID_PENDING` o `SEND_ERROR` sin NC total viva (la baja y la NC fallan); (b) un spec que despacha y limpia solo con `purgeRoofingTrail` / `purgeSalesTrail` sin pasar antes por `purgeInvoicingTrail` ni por la reversa del despacho. Revisé `fase6-bordes`, `fase7e`, `fase7-consolidada`, `plancha-contra-pedido-d171` y `restaurar-reserva-d379` y todos pasan por `purgeInvoicingTrail` o reviertan el despacho antes; `servicios-d167` (lineas 119 y 158, solo `purgeSalesTrail`) no pude confirmarlo sin correr E2E.
Sugerencia: que el paso 5 de los helpers registre (`console.warn`) el cuerpo de un 400/409 en lugar de tragarlo, o que la suite completa se corra una vez antes del cierre para ver si queda residuo (lo que ya exige el cierre de AGENTS.md §5).

### P2-2 — Un fallo de `cancel` en `PosService.void` deja la venta en `VOIDING` con la baja o NC ya hechas

`apps/api/src/pos/pos.service.ts:556-560`.
`void` revierte el cobro, da de baja o acredita el comprobante y revierte el despacho antes de llamar a `cancel`. Con D-383, `cancel` puede rechazar donde antes no lo hacía. Caso alcanzable: ruta `CREDIT_NOTE` donde la NC total viva suma menos que el comprobante (comparación estricta `credited.lt(totalPen)` en `order-cancel-checks.ts:~78`), por ejemplo por un centavo de redondeo entre el total de la NC y el del comprobante. Entonces el comprobante cuenta como vivo y el mostrador no puede cerrar la venta. El estado es reintentable (es el diseño de `VOIDING`), pero el cajero ve un error sobre «comprobante vigente» cuando acaba de acreditarlo. No pude demostrar la diferencia de centavos con los datos del test; el test unitario solo cubre 100 contra 100. Sugerencia: un test con NC y comprobante de importes con 4 decimales no triviales, o comparar con tolerancia de un céntimo (D-359 ya trabajó con céntimos en importes de papel).

### P3-1 — El lock de borradores solo cubre los que tienen `sales_order_id` en la cabecera

`sales-orders.service.ts` (nuevo bloque «D-383 (1)»): `WHERE "sales_order_id" = ... AND "status" = 'DRAFT'`, mientras `commercialCancelBlocks` también mira comprobantes que enlazan líneas del pedido sin cabecera. Un borrador sin cabecera pero con líneas del pedido no queda bloqueado y podría registrarse a la vez que se anula. `createInvoice` parece fijar siempre la cabecera cuando hay líneas de pedido, así que lo dejo como riesgo bajo; conviene una línea de comentario o un `OR` con las líneas.

### P3-2 — JSDoc de `cancel` desactualizado

`sales-orders.service.ts:~2195`: «Con la OP cerrada no hay nada que impedir... acto puramente comercial». Ya no es del todo cierto (casilla por lo fabricado y bloqueos comerciales). Actualizar para que el próximo lector no se guíe por el comentario.

### P3-3 — Mensaje redundante en el diálogo

`cancel-order-dialog.tsx`: bajo el encabezado «No se puede anular todavía:» el bloqueo de OP (`productionCancelBlock`) arranca con «No se puede anular: ...». Cosmético.

### P3-4 — `scripts/prod-e2e-purge.mjs:359` no manda `acknowledgeFabricated`

Hoy no importa porque el script revierte los reportes de las OP antes (paso -1.6) y no queda fabricado vivo, y los comprobantes y despachos E2E se limpian primero (-1.75). Si algún día el orden cambia, el 409 sale en el log como «NO se pudo anular». Dejar anotado; no se tocó por ser script de emergencia de producción.

### P3-5 — El diálogo no ofrece reintentar si la vista previa falla

`cancel-order-dialog.tsx` (`retry: false`, sin botón): ante un error de red solo se puede cerrar y reabrir. Aceptable por ser un caso raro y de admin.

## Calidad de tests

- `order-cancel-d383.spec.ts`: cubre bloqueos, acreditado parcial y total, despachos, casilla con y sin, un bloqueo gana sobre la casilla, vista previa sin `FOR UPDATE` ni escrituras, presupuesto de consultas y lógica pura de lo fabricado. Bien.
- Falta un test unitario de que el `$queryRaw` de borradores corra **antes** de `commercialCancelBlocks` con el `ORDER BY id` (el nombre del test lo dice, el título «toma el lock... antes de mirar» lo cubre a nivel de orden de llamadas; no verifica el SQL). Aceptable.
- Falta cobertura del escenario P2-2 (centavos entre NC y comprobante).
