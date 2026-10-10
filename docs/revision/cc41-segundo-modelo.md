# cc41 — Revisión de segundo modelo (Sonnet, contexto limpio)

- Rama: `feat/cc41-borrador-accesorio` (PR #166)
- Alcance: `git diff origin/main...HEAD` completo (migración, API, shared, web, E2E, docs). Se ignoró `e2e/tests/zz-capturas-cc41.spec.ts` (local, fuera de git). No se leyó ningún handoff. Solo lectura de código; este archivo es lo único escrito.
- Pruebas corridas: `jest src/production/roofing-drafts` (2 suites, 15 pruebas, verdes) y `vitest run src/lib/accessory-drafts.spec.ts src/lib/block-drafts` (2 archivos, 22 pruebas, verdes). Los `*.db-spec` y el E2E no se corrieron (piden base y servidores).

## Resultado

**Sin P0 ni P1.** La migración es aditiva y segura, la validación pura del borrador reproduce lo que hace `reportInTx` para un accesorio, y el commit sigue siendo una sola transacción con el orden de bloqueos intacto. Hay dos P2 (ambos en bordes de la transición web y de datos viejos) y varios P3.

## Lo verificado como correcto

### Migración

- `ADD COLUMN meters DECIMAL(12,3)` y `pieces_count INTEGER`, ambas nulas: filas existentes y coberturas no cambian. Cabe `MAX_VALUE.KG` (999 999 999) en `(12,3)`, la misma escala que `consumed_kg`, y el schema Zod usa el mismo `decimalStringSchema('KG')` que el parte.
- CHECK `meters IS NULL OR meters > 0` y `pieces_count IS NULL OR (meters IS NOT NULL AND pieces_count >= 0)`: coinciden con `refineReportForm` (piezas solo con metros). La base admite 0 piezas y el schema exige `min(1)`: más laxa que la API, no al revés, correcto. El db-spec cubre los tres rechazos y los dos pasos.
- Nombre `20261010140000_...` posterior a la última migración (`20260927200000`). `schema.prisma` coincide con el SQL (`@map("pieces_count")`, `meters` sin map).

### Validación pura frente a `reportInTx`

- Forma de la fila: los textos de rechazo («es un accesorio: reporta los metros lineales…», «no es un accesorio: detalla los largos…») son los de `reportInTx` (`roofing-production.service.ts:1072-1079`). El schema solo garantiza «una de las dos formas»; el servicio decide por producto, igual que el parte.
- `mathPieces` replica el vehículo aritmético de D-343 (`meters × 1000` a 2 decimales, `qty 1`); kilo teórico, tope D-246 y acumulado por bobina (`usedKg`) siguen el mismo camino que las coberturas, y el spec lo prueba (la fila 2 sale marcada fuera de tolerancia).
- Tope de plan (D-573/D-574): `roofingPlanGap(ordenado, registrado + borrador + fila)` con el mismo `planExcessMessage` que el parte; sin pedido (`orderedMeters = null`) no hay tope, igual que `if (accessory && order.reservationId)`. `reportedMeters` de un accesorio suma `metersM`, la misma suma que el parte y que `batchOrders`. `salesOrderItem` es no nulo en `Reservation` (FK obligatoria), así que `line.salesOrderItem.qty` no puede reventar.
- Las coberturas no cambian de comportamiento: `accessory` es `null` salvo producto accesorio, `draftRowLike` solo añade `meters` si no es nulo, `rowData` escribe `meters/piecesCount` nulos, `toDraftDto` usa `mathPieces` que devuelve los largos tal cual. La consulta extra de `readState` (la línea del pedido) solo ocurre en un accesorio con pedido.
- `batchOrders` (`:1664-1681`): se reordenó para pasar `accessory` a `draftDtos`; el `draftMeters` del lote suma `d.meters` del DTO, que para un accesorio ya sale de los metros de bobina.

### Transacción, idempotencia y bloqueos

- El commit sigue por `commitInTx`: `loadState(... parent: true)` toma pedido → OP con `lockOrder` antes de leer nada, y la lectura de la reserva del accesorio va después del bloqueo (D-474). No hay `FOR UPDATE` nuevo ni bloqueo fuera de las puertas; la regla 17 no se toca. La reserva y la línea se leen sin bloquear, como ya hacía `reportInTx`, y el commit revalida todo adentro.
- Todo o nada: la fila k llama a `reportInTx` dentro de la misma transacción; un fallo de la fila 2 (validación previa o dentro del parte) deshace la fila 1. Los dos db-specs lo prueban con saldos de bobina y conteo de reportes antes y después.
- `claimIdempotencyKey` por orden en `add` y en `commit` no cambió; la clave del cuerpo web ahora incluye `meters`, `piecesCount` y `consumedKg` de cada fila, de modo que cambiar el contenido regenera la clave.
- `Decimal` en todos los cálculos (`toDecimal`, `toFixed(3)`); ningún `number` toca metros ni kilos. `piecesCount` es entero informativo y no entra a ningún cálculo.
- `previewCommit` usa el mismo `commitInTx`, así que la vista previa del accesorio sale del mismo código.

### Web

- `useBlockDrafts` generalizado con un adaptador: el de coberturas (`COVERING_DRAFTS`) conserva `blockPayload` + `editMeters`; los dos adaptadores son constantes de módulo, así que `useCallback([... adapter])` no se invalida por render.
- `flushOrder`: la subida/bajada ahora mide lo guardado de un accesorio por sus metros de bobina; sigue guardando primero lo que baja (necesario por el tope D-146/D-574 sobre todo el borrador).
- `saveDraftContent`: el mismo PUT/POST/DELETE con clave por huella; vaciar borra todas las filas de la bobina, y dos filas de una bobina colapsan en una al guardar (D-548).
- Transición: `uploadLegacyAccessoryEdits` es idempotente por bobina (la marca `_cc41EnCurso` más «gana el servidor» por bobina en la reanudación), no sube bloques `sent`, vacíos o de bobinas desmontadas, y trata como dudoso (`doubtful`, sin subir) un parte con clave y sin `sent` cuando la bobina ya tiene metros registrados. Esa es la decisión correcta contra el duplicado de kardex: ante la duda, no subir. La prueba de reintento escribe y luego reanuda y verifica que solo se suben las bobinas sin fila.
- D-575: la bobina llenada sola sigue sin entrar al borrador hasta confirmarla (`confirmAuto` la manda con `immediate`), y `registrable` excluye los `derived`.

## Hallazgos

### P2-1. La transición decide «gana el servidor» con `order.drafts` tal como llega en el primer render, que puede ser caché vieja

- Dónde: `apps/web/src/app/(app)/planta/produce-accessory.tsx:144-171` (efecto con `migrated` ref y `serverCoilIds: order.drafts.map(...)`), y `uploadLegacyAccessoryEdits` (`accessory-drafts.ts`, bloque `if (!resuming && input.serverCoilIds.length > 0)`).
- Escenario: el operario A dejó en este navegador una clave de D-559 y abre la orden con la lista `roofing-batch` en caché (no refrescada: el efecto no mira `refreshing`). Entre tanto el operario B escribió en otro equipo un borrador de la bobina 1 en el servidor. El efecto ve `order.drafts = []`, no hay clave de reanudación, y llama a `put(bobina 1)`, cuyo `existing` es `latest.current` (también vacío): hace POST de una fila nueva en lugar de PUT. La bobina 1 queda con dos filas en el servidor. La pantalla las suma (D-548) y muestra el doble; si se pulsa «Registrar» sin tocar ese bloque, el commit registra las dos filas por separado: metros duplicados en kardex. El tope de plan (D-574) lo frena solo si el pedido ya está cerca de completarse.
- Probabilidad baja (exige clave local de D-559 más borrador ajeno en la ventana de la caché), pero el efecto es duplicar kardex.
- Sugerencia: no migrar mientras `refreshing` sea verdadero, o relanzar un `GET .../drafts` justo antes de decidir y usar esa lista como `serverCoilIds` y como `existing` del primer guardado. Alternativa mínima: que `put` en la transición use `drafts.latestDrafts()` recién traído.

### P2-2. Una fila vieja de coberturas (largos) en una orden de accesorio deja el borrador bloqueado para agregar o editar cualquier otra fila

- Dónde: `roofing-drafts.ts` (`checkDraftRows`: `accessory !== null && (rowMeters === null || row.pieces.length > 0)` hace `fail(...)`), usado por `validate(state, [...existing.map(draftRowLike), candidate], 'new')` en `add`.
- Escenario: antes de cc41 el API aceptaba por `POST .../drafts` filas con largos en una orden de accesorio (la web de D-559 no lo hacía, pero un script o un cliente viejo sí; el commit las habría rechazado). Si existe alguna en producción, ahora `validate` falla sobre esa fila antes de mirar la nueva y el mensaje nombra la fila 1: el operario no puede agregar ni corregir otras filas hasta borrar la vieja. El borrado sí funciona (`remove` no valida). No se verificó si hay filas así: no hay SQL contra producción.
- Sugerencia: comprobarlo con la consulta de solo lectura que corresponda en la ventana (o por `db:prod` de lectura) antes del deploy; si hay filas, borrarlas por el API. Si no, anotar en D-591 que «no había filas así».

### P3-1. Dos pestañas del mismo navegador pueden subir la transición a la vez

- Dónde: `accessory-drafts.ts` (reanudación) y `use-block-drafts.tsx` (`keyFor` con `newDraftKey()` aleatorio por pestaña).
- Con la marca `_cc41EnCurso` ya escrita, dos pestañas que abran la misma orden a la vez ven la misma lista de bobinas sin fila y cada una hace su POST con su propia clave: dos filas por bobina. Se absorbe igual que P2-1 (la pantalla suma, un guardado posterior colapsa), pero un commit directo antes de tocar el bloque las registraría ambas. Es un borde muy estrecho (la clave local se borra al terminar la primera pestaña). Sugerencia: derivar la clave de idempotencia del POST de la transición de `orderId + coilId + huella` en lugar de aleatoria.

### P3-2. Un bloque de D-559 que el operario vació a propósito después de un fallo resucita en la siguiente apertura

- Dónde: `uploadLegacyAccessoryEdits`, reanudación (`!serverCoilIds.includes(coilId)` es la única condición para reintentar).
- Si el guardado de una bobina se rechazó, la clave sigue con ese bloque. Si el operario lo borra en pantalla (bloque vacío, sin fila en el servidor), en la próxima apertura el bloque viejo vuelve a subirse. Sugerencia: al vaciar un bloque en la pantalla, quitar su bobina de la clave local, o borrar la clave completa cuando el operario vacía el bloque tras un fallo.

### P3-3. Pruebas: huecos que no son defectos pero conviene saber

- `roofing-drafts-accessory.spec.ts` y el db-spec cubren bien la rama de accesorio y los todo-o-nada, pero no hay prueba de `readState`/`list` con un accesorio **sin pedido** (a stock): el unitario prueba `orderedMeters: null` en `checkDraftRows`, no que `readState` lo entregue así cuando `reservationId` es nulo.
- No hay prueba del efecto de React que conecta `uploadLegacyAccessoryEdits` con la pantalla (la unidad está bien probada con un `save` falso; el E2E de cc41 cubre el camino feliz). La rama `touched` (gana lo que el operario escribió durante la subida) no tiene prueba.
- No hay presupuesto de consultas para `list`/`readState` con accesorio (una lectura más de reserva). Es una consulta por lectura y solo con accesorio con pedido; basta con anotarlo.

### P3-4. `piecesCount` admite 0 en la base y exige ≥ 1 en el schema

- `migration.sql` (`pieces_count >= 0`) contra `reportRoofingBaseSchema.piecesCount.min(1)`. Inofensivo (la base es más laxa), pero un mismo umbral en los dos lados evita preguntas al leer el CHECK.

## Sin hallazgo

- Orden de bloqueos (regla 17) y puertas `lockDocuments`/`lockCoilRows`: no hay bloqueos nuevos.
- Regla 8 (kardex): el borrador no escribe `inventory_movements`; todo movimiento sigue en `reportInTx` → `InventoryService`.
- Regla 13 («por metro»): el accesorio se decide por `isAccessory(product)`, no por la unidad; no se define `detailsLengths` con una sola condición.
- Auditoría del commit: suma los metros con `mathPieces`, así que la cifra de un accesorio ya no sale en cero.

## Respuesta de la sesión

- **P2-1 (corregido).** Cuando el navegador tiene algo de D-559 para la orden, la transición pide
  `GET …/drafts` recién leído antes de decidir, lo pone en la caché y decide por bobina con esa
  lista. Sin clave local no se hace ninguna lectura de más.
- **P2-2 (verificado, sin cambio).** Lectura de producción del 10/10 con `inspect:cc38` (READ
  ONLY): **0 OP de coberturas o accesorio abiertas** (71 cerradas, 1 anulada). No puede haber
  filas viejas en una orden de accesorio en curso. Si alguna apareciera, la pantalla la muestra
  sumada en su bloque y al editarlo se reescribe con metros (el PUT reemplaza esa fila), así que
  se corrige sola. La salida queda en `local-data/cc41/diagnostico/` del checkout principal.
- **P3-1.** Sin cambio: la clave queda marcada como «transición empezada» antes de subir, y una
  segunda pestaña que abra después lee el borrador del servidor por bobina. Queda la ventana de
  dos pestañas abiertas en el mismo segundo; con 0 OP abiertas en producción, no hay qué subir.
- **P3-2.** Sin cambio: solo pasa con una transición que ya falló; queda anotado.
- **P3-3.** Sumados unitarios con mocks del camino de accesorio del servicio (`list`, `add` con y
  sin pedido, `update`, `commit`) en `roofing-drafts-accessory.spec.ts`. El efecto de React de la
  transición lo cubre el E2E (`accesorio-borrador-cc41.spec.ts`).
- **P3-4.** Sin cambio: el CHECK de la base es más laxo que el schema y eso es compatible (el
  brief pedía `pieces_count ≥ 0`).
