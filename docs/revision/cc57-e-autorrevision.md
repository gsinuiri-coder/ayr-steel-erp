# cc57-e — Autorrevisión (higiene de audit-01)

> **Autorrevisión — no vale como pase cruzado.** Subagente nuevo, sin leer el handoff de
> implementación. Es una lista de riesgos, no una aprobación.

Alcance: `git log --no-merges -p cc57-d-rendimiento..HEAD -- apps packages` (commits `51a3ed26`,
`63dff6f0`; 27 archivos). Corrí los seis specs unitarios tocados (64/64 en verde, sin base). No
corrí E2E ni servidores.

## Hallazgos

### P1-1 — D-16 rechaza cargas de precios legítimas cuando la celda trae más de 4 decimales

- `packages/shared/src/schemas/price-list.ts:140` declara `priceWithIgvPen` con
  `decimalStringSchema('MONEY')`, que **transforma** el valor a 4 decimales
  (`packages/shared/src/decimal.ts:73`).
- El preview, en cambio, deriva `afterValuePen` del texto crudo de la celda
  (`apps/api/src/catalog/price-list-import.service.ts:158`), y un xlsx con celda numérica llega
  como `String(number)` con toda la precisión del float (`apps/api/src/imports/parse-spreadsheet.ts`,
  `rawToString`): p. ej. un precio que sale de una fórmula `=costo/(1-m)*1.18`.
- En el confirm (`price-list-import.service.ts:275-281`) se vuelve a derivar desde el precio **ya
  redondeado a 4** y se compara con el `afterValuePen` derivado del crudo. No siempre coinciden.
- Lo medí con `@ayr/shared` compilado: 2000 precios aleatorios con decimales completos dieron
  **442 diferencias (22 %)**, p. ej. `97.51275765904359` → preview `82.6379`, confirm `82.6380`.
  Con una planilla de cientos de filas así, **todo el lote se rechaza** con «vuelve a cargar el
  archivo», y volver a cargarlo da lo mismo: el ADMINISTRADOR queda sin poder importar ese
  archivo. Antes del cambio esa carga entraba.
- Los E2E (`e2e/tests/precios-lista-d217.spec.ts:115-200`) usan CSV con 2 decimales y el unitario
  nuevo (`price-list-import.spec.ts:246`) usa `'11.80'`: ninguno ve el caso.
- Salidas posibles: no transformar el campo (validarlo como texto decimal y derivar del texto
  tal cual), o comparar con el precio crudo del preview reenviado sin redondear, o redondear el
  precio a 4 en el preview también (eso cambia el valor que hoy se graba: requiere decisión).

### P2-1 — El centinela de kardex perdió el `/i` en TRUNCATE

`apps/api/src/inventory/kardex-writers.sentinel.spec.ts:41`: antes `/TRUNCATE\s+TABLE/i`, ahora
`/TRUNCATE\s+(TABLE\s+)?["\w$]/` **sin `i`**. Un `truncate table inventory_movements` en minúscula
(en un `.sql` o un `$executeRawUnsafe`) ya no lo detecta. Si quitar el `i` fue para no chocar con
prosa en inglés («truncate»), el costo es abrir el hueco en SQL en minúscula. Tampoco hay un test
positivo de los patrones nuevos (`createManyAndReturn`, `UPDATE ONLY`, `DELETE FROM ONLY`,
`MERGE INTO`, `TRUNCATE x`): el centinela solo prueba que el repo actual no ofende, no que cada
patrón muerda.

### P2-2 — D-16 es esquivable y el mensaje nombra un UUID

- `priceWithIgvPen` es opcional (compatibilidad con el navegador anterior): un POST que lo omita,
  o que mande un par precio/valor coherente pero inventado, pasa igual. La protección cubre un
  navegador desfasado, no un valor arbitrario. Conviene dejar registrado cuándo pasa a obligatorio.
- El error (`price-list-import.service.ts:279`) nombra `row.productId` (UUID), no el SKU ni la fila
  del archivo: el usuario no sabe qué fila corregir.

### P2-3 — B-08 a medias: otros dos llamadores siguen leyendo fuera de la transacción

`requireRoofingProduct(productId, db = this.prisma)` (`production.service.ts:2049`) solo recibe
`tx` en `mountCoil` (`roofing-production.service.ts:636`). Los llamadores de
`roofing-production.service.ts:352` (OP desde reserva) y `:446` (`createToStock`) están dentro de
un `tx` y siguen tomando otra conexión del pool. No es regresión; el hallazgo B-08 sigue abierto
en esos caminos. (`:218` y `:3072` están fuera de transacción: correcto.)

### P3-1 — El centinela de timeouts confía en el nombre `timeoutMs`

`transaction-options.sentinel.spec.ts:28` mapea cualquier `timeout: timeoutMs` a 60 s
(`CLOSE_PREVIEW_TIMEOUT_MS`). Un llamador futuro de `previewPlantClose` (o cualquier función con
un parámetro llamado `timeoutMs`) que pase 5 000 no se detectaría. Además
`KNOWN.COMMIT_PREVIEW_TIMEOUT_MS` sigue en `30_000` cuando la constante real vale `120_000`
(`close-preview.ts:43`); previo a este corte, pero el comentario nuevo cita 120 s.

### P3-2 — Más espera bajo contención en 14 caminos

`KARDEX_TX_OPTIONS` = `{ timeout: 30_000, maxWait: 10_000 }` en caminos que antes usaban los
defaults (5 s / 2 s): reasignar vendedor, cambiar fecha prometida, liberar reserva, prioridad de
OP, anular/borrar comprobantes, cancelar orden de corte, etc. Efecto visible: bajo pool saturado
el usuario espera hasta 10 s antes del error en vez de 2 s, y una transacción lenta retiene sus
bloqueos hasta 30 s. Es lo buscado (P2028 contra Neon), pero cambia la latencia del peor caso.

### P3-3 — Spinner en todos los botones «Montar el fleje»

`drywall-order-panel.tsx:484`: `pending={consume.isPending}` es una sola mutación para todas las
filas; al montar un fleje, **todos** los botones muestran el spinner (antes solo se
deshabilitaban todos). Sin `pendingText` el texto queda igual y el `aria-label` no cambia, así que
los selectores E2E no se rompen.

### P3-4 — Tests que prueban menos de lo que dicen

- B-08 (`hygiene-cc57.spec.ts:84`): prueba que `requireRoofingProduct` usa el `db` recibido, no
  que `mountCoil` se lo pase.
- B-09 (`hygiene-cc57.spec.ts:53`): el mock devuelve `[{seq:7}]` sin mirar el `where`; no prueba
  que el filtro `status: EMITTED` siga en la llamada.
- B-11 (`purchase-draft-edit.spec.ts:292`): verifica que se relea la cabecera, no que una
  cabecera distinta a la del `peek` (otro tipo, otra moneda, TC) sea la que se usa ni que
  `assertPenRateIsOne` dentro de la transacción rechace.
- C-06 (`hygiene-cc57.spec.ts:16`): fija la metadata; el comportamiento era el mismo antes
  (`@Roles()` vacío ya negaba al VENDEDOR en `roles.guard.ts`).

## Cambio visible por rol

| Rol               | Cambio                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMINISTRADOR     | Carga de precios: rechazo nuevo cuando valor y precio no cuadran — **y falsos rechazos con celdas de muchos decimales (P1-1)**. Spinner en Partir bobina, Recibir corte, Cerrar/Abrir caja, Cobrar, Guardar OP drywall y Montar fleje.                |
| SUPERVISOR_PLANTA | `GET /sales/dashboard` pasa a 403. La web solo lo pide si el rol es VENDEDOR (`panel-today.tsx:108`, `enabled: isSeller`) y ningún E2E lo llama como planta: sin efecto visible. `/cutting/strips` sin cambio real. Spinners de planta/corte/bobinas. |
| VENDEDOR          | `/cutting/strips` sigue en 403 (igual que antes). Spinner en POS (Abrir caja, Cobrar, Cerrar caja).                                                                                                                                                   |
| Todos             | El alta de cliente/usuario con `email` en el cuerpo pasa del bucket por correo al bucket por IP (120/min); en una oficina detrás de una sola IP pública ese bucket es compartido, pero ya lo era para el resto de las rutas.                          |

## E2E que podrían romperse

Ninguno por textos: los botones conservan su nombre accesible en reposo (`Recibir`,
`Cobrar S/ …`, `Guardar ${code}`, `Montar el fleje …`) y los textos de carga son los mismos que
antes (`Partiendo…`, `Recibiendo…`, `Registrando…`, `Cerrando…`, `Abriendo…`, `Cobrando…`), ahora
con un ícono delante. `precios-lista-d217.spec.ts` usa precios de 2 decimales: pasa, pero no cubre
P1-1. Ningún E2E pide `/sales/dashboard` como SUPERVISOR_PLANTA.

## Llamadores tocados

- `requireRoofingProduct`: 5 llamadores; solo `mountCoil` pasa `tx` (P2-3).
- `expireDue`: `quotation-expiry.job.ts:37` y `sales.controller.ts:365`; mismo contrato (número).
  `updateManyAndReturn` existe en Prisma 6.19.3 para Postgres.
- `PurchasesService.receive`: `applyLandedCost`/`applyCuttingOrderCost` ahora reciben la cabecera
  releída, con `status = RECEIVED`; ninguno lee `status` ni `items` de la compra: sin efecto.
- `AppThrottlerGuard.getTracker`: global; solo cambia la clave fuera del login.

## Resumen

Un P1: la validación D-16 del valor sin IGV redondea el precio a 4 decimales antes de volver a
derivarlo, y con celdas de xlsx de muchos decimales rechaza ~22 % de las filas (medido), o sea
lotes enteros que antes entraban. Dos P2 de cobertura del centinela (TRUNCATE sin `/i`, sin tests
positivos de los patrones nuevos) y D-16 esquivable/mensaje con UUID; B-08 queda abierto en dos
llamadores más. El resto (timeouts, botones, roles, throttle, auditoría del vencimiento,
relectura de la cabecera) no cambia nada visible fuera de los spinners y del 403 del panel para
planta, que la web no pide.

---

## Respuesta del autor (cc57)

- **P1-1:** confirmado y corregido, como el P2-2 del segundo modelo: sin redondeo, con el SKU en el mensaje y con un unitario de precisión completa.
- **P2 (TRUNCATE `/i`):** corregido.
- **P2 (B-08 a medias):** corregido. Las otras dos lecturas de `requireRoofingProduct` dentro de una transacción ahora usan `tx`.
- **P3:** anotados. El centinela de topes cuenta `timeoutMs` como el menor de los dos topes con que lo llaman (60 s).
