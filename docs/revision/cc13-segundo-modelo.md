# Revisión de segundo modelo — cc13 (D-378, reactivar con las líneas del pedido)

## Alcance

Rama `cc13/reactivar-con-lineas`, diff `origin/main...HEAD` (11 archivos): `fiscal-import.service.ts` (`reactivateWithOrderLines`, `previewReactivationWithOrderLines`, `planReactivationWithOrderLines`, extracción de `lockAnnulledForReactivation`), `reactivate-order-lines.ts`, controlador, schemas compartidos, diálogo web y su montaje en el listado, etiqueta de auditoría, y los specs (dos unitarios y un E2E). Se leyó también el orden de locks de `invoicing.service.ts` (`createInTx`, `registerManual`, `assignInTx`), los CHECK e índices de `fiscal_documents` y `fiscal_document_items`, y los consumidores de líneas de comprobante en `invoice-dispatch.service.ts`. `jest` de `src/invoicing/reactivate*` y `fiscal-import*`: 60 tests en verde. `tsc --noEmit` en apps/api: **2 errores** (hallazgo 1). No se corrió E2E.

## Veredicto

**Un P1 (rompe `typecheck`, bloquea CI), tres P2 y varios P3. 0 P0.** La lógica de dominio es correcta: el orden de locks (comprobante, pedido, borradores en orden de id) es el mismo que el de D-373 y ningún camino toma pedido y luego comprobante; el `updateMany` condicionado a `ANNULLED` va antes de tocar líneas; no hay CHECK de base que el cálculo viole (`qty > 0`, importes ≥ 0, `annul_shape`/`annulled_trace` se satisfacen al vaciar los tres campos de anulación); `reactivateExternal` conserva su comportamiento al extraer `lockAnnulledForReactivation` (mismas comprobaciones y mismo orden; solo amplía el `select`). Los consumidores del despacho D-364 leen las líneas del comprobante por `salesOrderItemId` y `qty`, y el id del comprobante no cambia, así que lo despachado de las líneas originales se conserva y lo agregado queda pendiente.

## Hallazgos

### 1. P1 — El spec nuevo no pasa `tsc` (CI: typecheck en rojo)

`apps/api/src/invoicing/fiscal-import-reactivate-lines.spec.ts:282`.
`documentBalance({ status, totalPen, paidPen: 0, creditedPen: 0 })` recibe `number` donde la firma pide `DecimalInput` (`string | Decimal`). `pnpm --filter @ayr/api exec tsc --noEmit -p tsconfig.json` falla con dos TS2322 (columnas 71 y 83). Jest lo deja pasar (no hace typecheck), pero `turbo typecheck` y la CI fallan.
Sugerencia: `paidPen: '0', creditedPen: '0'`. Es además el único `number` donde va dinero en la entrega; el código de producción usa `Decimal`/strings correctamente.

### 2. P2 — Una transacción interactiva con un `update` por línea, sin `timeout`, contra Neon

`fiscal-import.service.ts` (`reactivateWithOrderLines`, bucle `for (const u of plan.updates) await tx.fiscalDocumentItem.update`; `$transaction` sin opciones, tanto aquí como en la vista previa).
La transacción hace ~15 consultas de bloqueo y lectura, más un `update` secuencial por línea del comprobante. El timeout por defecto de Prisma es de 5 s y ya hubo un caso medido contra Neon real (RF-S4b). Un pedido de ~30 líneas puede acercarse al límite y el fallo sería un error genérico de transacción vencida (se revierte todo, no hay daño, pero el administrador no entiende por qué).
Sugerencia: pasar `{ timeout: 20_000 }` a ambos `$transaction`, o agrupar los updates con `Promise.all` (la transacción serializa de todos modos) o con un `UPDATE … FROM (VALUES …)`.

### 3. P2 — La vista previa toma `FOR UPDATE` del comprobante, del pedido y de los borradores desde un GET

`invoicing.controller.ts` (`previewReactivateWithOrderLines`) y `planReactivationWithOrderLines`.
Es correcto para que el plan sea el mismo que el de reactivar, pero cada apertura del modal bloquea el pedido (ediciones D-187, facturación de borradores) durante el tiempo que dure la transacción, y el diálogo la repite cada vez que se abre (`staleTime: 0`, `gcTime: 0`). Si hay un problema de latencia, un administrador mirando el modal estorba a un vendedor editando el pedido unos segundos. No hay riesgo de interbloqueo (mismo orden de locks), solo contención.
Sugerencia: para la vista previa basta leer sin `FOR UPDATE` (la reactivación vuelve a validar todo bajo lock). Si se prefiere la simetría exacta, dejarlo y documentarlo.

### 4. P2 — `planOrderLines` devuelve `changed` y nada lo usa; el caso «el pedido no cambió» queda sin tratamiento

`reactivate-order-lines.ts` (`OrderLinesPlan.changed`) y `fiscal-import.service.ts`.
El test «sin cambios en el pedido el plan no cambia nada y lo dice» prueba un campo que ningún llamador lee: el servicio ni lo expone en la vista previa ni lo audita. Si el pedido no cambió, la reactivación con líneas escribe las mismas filas y la auditoría dice `reactivate-with-order-lines` con antes = después, cuando la acción correcta era la simple (D-373, que además exige que el pedido no haya cambiado).
Sugerencia: usar `changed` (por ejemplo, un campo `changed` en `ReactivationPreviewDto` y un aviso en el modal «el pedido no cambió: usa Reactivar»), o quitarlo. Un test que prueba un parámetro que nadie consume es el patrón de «Planta II».

### 5. P3 — La acción solo está en el listado, no en el detalle del comprobante

`comprobantes-view.tsx` agrega la acción; `[id]/comprobante-detalle-view.tsx` ya contiene el flujo D-373 («Reactivar») y no el de D-378. Quien llega al comprobante anulado desde el pedido (el caso de uso: «agregué ítems al pedido») no ve la opción. No es un bug; conviene confirmar con el dueño si el listado es suficiente.

### 6. P3 — `typedTotal` descarta las comas sin avisar

`reactivate-with-order-lines-dialog.tsx`, `typedTotal`: `v.replace(/,/g, '')`. Tipear `153,44` (coma decimal) se convierte en `15344.00` y el aviso de diferencia muestra `S/ 15,344.00`. No hay riesgo (la comparación al céntimo rechaza), pero el mensaje confunde. Sugerencia: rechazar la coma con «usa punto decimal», o aceptar la coma solo si es el último separador con 1–2 dígitos.

### 7. P3 — `data-testid` con tilde

`Side` arma `data-testid={`${title.toLowerCase()}-total`}`: produce `antes-total` y `después-total`. Funciona, pero es frágil para selectores; mejor un `testId` explícito.

### 8. P3 — Mensaje del bloqueo por «línea que ya no está en el pedido»

`planReactivationWithOrderLines`: el `Conflict` dice «factura líneas que ya no están en el pedido». Hoy una línea de pedido no se puede quitar (H7), así que el mensaje es de un caso hipotético; está bien, pero conviene que el handoff diga que es una guarda defensiva y no un flujo.

## Sobre los tests

Los unitarios están bien armados: cada bloqueo parte del caso feliz (`happy`), así que un rojo identifica su propio bloqueo. Cubren, además, que no se escriben kardex, reservas, despachos ni cobros, y que si el `updateMany` no afecta ninguna fila no se toca ninguna línea. Límites a tener presentes: son mocks de Prisma, de modo que no ejercen el SQL real de los `FOR UPDATE`, el `CHECK` de la base ni la restricción única `(document_id, line_number)` del insert; eso lo cubre solo el E2E (`reactivar-con-lineas-d378.spec.ts`, no corrido en esta revisión). Falta un caso de borde: línea original con cantidad parcial en el comprobante y total en el pedido (el plan la lleva a total, y está bien, pero ningún test lo fija). El único cambio de `reactivar-comprobante-d373.spec.ts` (`exact: true` en «Reactivar») es necesario y correcto, porque el nuevo ítem de menú comparte el prefijo.

## Resumen P0/P1

P0: ninguno. P1: uno (hallazgo 1, error de `tsc` en el spec nuevo). P2: tres (timeout/updates secuenciales, locks desde un GET, campo `changed` sin uso). P3: cuatro.

## Resolución (autor, 2026-10-02)

| #     | Qué se hizo                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **P1 corregido antes del deploy.** `'0'` en vez de `0`; `tsc --noEmit` de `apps/api` limpio.                                                                                                        |
| 2     | **Corregido.** `timeout` de 30 s en las dos transacciones.                                                                                                                                          |
| 3     | **Aceptado, documentado en el código.** La vista previa comparte camino y locks con la reactivación a propósito: es corta y sin escrituras, y no puede dejar de mostrar un bloqueo real.            |
| 4     | **Corregido.** Pedido sin cambios → se rechaza y se indica «Reactivar» (D-373).                                                                                                                     |
| 5     | **Pendiente del dueño.** La acción queda en el listado, donde también vive «Reactivar» de D-373; el detalle no tiene hoy el menú de anulados. Se pregunta en el cierre si hace falta en el detalle. |
| 6     | **Corregido.** La coma solo como separador de miles bien puesto.                                                                                                                                    |
| 7     | **Corregido.** `testId` explícito (`before`/`after`).                                                                                                                                               |
| 8     | **Sin cambio.** Es una guarda defensiva (hoy una línea de pedido no se quita, H7); queda dicho en el handoff.                                                                                       |
| Tests | Se agregó el caso de la línea facturada en parte que pasa a la línea entera del pedido.                                                                                                             |
