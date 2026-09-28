# Revisión Correcciones 06 — segundo modelo (contexto limpio)

**Alcance:** `git diff 1e420bc..HEAD` (worktree `ayr-c06`, rama `feat/correcciones-06`; 39
archivos, ~3.7k líneas). Commits: `c14771e` (D-360, bobina que se termina sola), `1286cd8`
(D-361, rentabilidad por comprobante + columnas por ML en Ventas por material), `40596eb`
(Ventas y margen usa `LIVE_DOCUMENT_STATUSES`), `8798d61` (docs, sin código).

**Modelo revisor:** Sonnet 5 (Claude Sonnet, vía Claude Code), contexto limpio: no leyó el
handoff de la sesión que escribió el cambio ni ningún informe previo de `docs/revision/` antes
de formar sus propios hallazgos.

> Esta es una revisión por **segundo modelo**, no por una persona. Es una lista de riesgos leída
> del código real (con `pnpm exec jest` donde hizo falta), no una aprobación ni un reemplazo de
> la revisión del dueño que cierra la entrega (AGENTS.md §1, estándar de revisión).

Verificación ejecutada: `pnpm exec jest src/coils src/cutting src/production src/invoicing
src/reports` en `apps/api` — **55 suites, 601 tests, todos en verde** (incluye los specs nuevos
de D-360/D-361 y los existentes que el refactor de `sales-by-material.ts`/`sales-margin.service.ts`
podía haber roto). No se corrió Playwright completo (fuera del alcance de esta pasada).

---

## P0

Ninguno encontrado. No hay dinero mal calculado, pérdida de datos ni fuga de seguridad
detectada en esta pasada.

---

## P1

### C06-P1-1 — La reversa de un partido y la de una recepción de corte no pasan por `reopenAutoTerminatedCoils`: reabren la bobina sin auditoría de reapertura

**Confianza:** confirmado (leído el código completo de ambos métodos; sin cobertura de test que
ejercite esta combinación).

**Archivos:**

- `apps/api/src/coils/coil-operations.service.ts:342-345` (`revertSplit`, RF-16) — el bloque sin
  tocar por este diff:
  ```ts
  if (coil.status === CoilStatus.CLOSED) {
    await tx.coil.update({ where: { id: coil.id }, data: { status: CoilStatus.OPEN } });
  }
  ```
- `apps/api/src/cutting/cutting.service.ts:507-511` (`reverse`, revertir una recepción de
  corte) — mismo patrón, pero al estado `IN_THIRD_PARTY`:
  ```ts
  await tx.coil.update({ where: { id: coilId }, data: { status: CoilStatus.IN_THIRD_PARTY } });
  ```

**Escenario:** se parte una bobina y la madre queda en exactamente 0 → D-360 la termina sola
(`autoTerminateEmptyCoils` en `coil-operations.service.ts:216-224`, causa `SPLIT`, con su
`coils.close` y `autoTerminated: { kind: 'SPLIT', refId: <splitId> }`). Se revierte ese partido
(RF-16): el código la reabre con un `update` directo, **sin pasar por `reopenAutoTerminatedCoils`
ni escribir ningún `coils.open`**. Mismo patrón para una recepción de corte tercerizado que deja
el fleje-madre en 0 (`CUTTING_RECEPTION`) y se revierte.

El estado final del campo `status` queda correcto (`OPEN` / `IN_THIRD_PARTY`, según toca), porque
en ambos casos el propio método ya exige que la bobina no esté en un estado que otra operación
pudiera haber tocado mientras estuvo `CLOSED` (nada puede escribir sobre una bobina `CLOSED`
salvo el propio partido/recepción que la generó), así que **no hay pérdida de dato ni saldo mal
calculado hoy**. Lo que se rompe es la promesa central de D-360, tal como la documenta el propio
código nuevo: _"la auditoría es lo que hace reversible la terminación"_ y _"nunca falla por
estado"_ (`coil-auto-terminate.ts`, comentario de cabecera). Con este agujero:

- Una bobina auto-terminada por `SPLIT` o `CUTTING_RECEPTION` y luego revertida queda con un
  `coils.close` **huérfano** en su auditoría (sin el `coils.open` que todos los demás caminos de
  D-360 sí escriben: `SCRAP`, `PRODUCTION_ORDER_CLOSE`, `PRODUCTION_ORDER_CANCEL`,
  `COIL_RELEASE`, `DISPATCH`, `DISPATCH_MISSING`, `BATCH` — los siete restantes usan
  `reopenAutoTerminatedCoils` en su reversa). Alguien que audite esa bobina ve un cierre sin
  reapertura, aunque el estado real ya cambió.
- No hay ningún test (unitario o e2e) que ejercite "se parte y queda en 0 → se revierte el
  partido" ni "se recibe del corte y queda en 0 → se revierte la recepción": el e2e nuevo
  (`e2e/tests/correcciones-06.spec.ts`) solo cubre `SCRAP` (merma) y `PRODUCTION_ORDER_CLOSE`; el
  e2e de D-164 ajustado solo cubre `SCRAP`. La rama que rompe la promesa de auditoría es
  exactamente la que nadie corrió.

**Propuesta:** en `revertSplit`, reemplazar el `if (status === CLOSED) update` por
`reopenAutoTerminatedCoils(tx, this.audit, { coilIds: [coil.id], cause: { kind: 'SPLIT', refId:
split.id }, label: ..., operationDate })`, igual que ya se hizo para `SCRAP` y para el cierre de
OP. En `cutting.service.ts`, como el destino no es `OPEN` sino `IN_THIRD_PARTY`, la opción más
simple es escribir explícitamente el `coils.open`-equivalente (o extender
`reopenAutoTerminatedCoils` para aceptar el estado destino) antes de fijar `IN_THIRD_PARTY`, para
que quede la misma auditoría pareada que en los otros siete caminos. Agregar el escenario a
`coil-auto-terminate.spec.ts` o al e2e de correcciones 06.

---

## P2

### C06-P2-1 — `dispatches.service.ts` usa `businessToday()` en vez de `this.operationDate.resolve(actor, undefined)` para la fecha del auto-cierre de D-285

**Archivo:** `apps/api/src/invoicing/dispatches.service.ts:529-540` (`addMissingMovementInTx`,
llamada a `closeEmptySoldCoils` con `businessToday()`).

`production.service.ts` y `roofing-production.service.ts` usan
`this.operationDate.resolve(actor, undefined)` para la misma situación ("fecha de hoy, sin
override de operationDate"); `dispatches.service.ts` llama a `businessToday()` directo. Se
verificó que `OperationDateService.resolve(actor, undefined)` es literalmente
`businessToday()` cuando no hay `requested` (`operation-date.service.ts:31`), así que **hoy no
hay diferencia de comportamiento** — es una inconsistencia de estilo entre los tres archivos que
toca la misma entrega, no un defecto. Vale la pena unificar para que un cambio futuro en
`OperationDateService.resolve` (p. ej. una validación adicional) no se salte por este atajo.

### C06-P2-2 — El "costo prom./unidad" del total y del neto no muestra la unidad, a diferencia de cada línea

**Archivo:** `apps/web/src/app/(app)/comprobantes/[id]/document-profitability.tsx:209-247`
(`FigureCells`, prop `unit` opcional).

En `ProfitTable`, la fila de cada línea pasa `unit={line.unit}` a `FigureCells` y el "Costo
prom./unidad" sale como `S/ 10.0000 /kg`; en el total, el acreditado y el neto se llama
`<FigureCells figures={total} />` sin `unit`, así que la misma columna sale como `S/ 10.0000` a
secas (o `—` si `costPerUnitPen` es `null`, que es el caso más común cuando el total mezcla
unidades). No es un dato incorrecto — es cosmético — pero la columna cambia de forma entre la
fila y el total sin que quede claro por qué. Si el total tiene una unidad conocida (todas las
líneas costeadas comparten unidad), vale la pena pasarla también ahí.

### C06-P2-3 — `dispatchLine` en `document-profitability.ts` no distingue una nota de crédito propia de Coberturas Aluzinc sin subtipo del resto de `NO_COST`

Observación menor, sin impacto verificado: en `assembleDocumentProfitability`
(`document-profitability.ts:310-322`), toda línea de una NC que no es `in_engine` recibe
`NO_COST` con la nota genérica "el costo de lo devuelto vuelve por la reversa del despacho". Si
alguna vez una NC devuelve una línea que en su momento fue `DISPATCH_SALE` con costo parcial
(D-285, `PARTIAL`), la nota no lo distingue del caso normal. No se encontró un caso real que lo
dispare con los datos y las reglas actuales; se deja anotado por si aparece en UAT.

---

## Lo que se revisó y no dio hallazgos

- **`autoTerminateEmptyCoils`/`planAutoTerminate`** (`coil-auto-terminate.ts`): la regla "0
  exacto, sin montaje, sin reserva viva, sin kardex" está bien acotada; `isNegative()` /
  `isZero()` sobre `Decimal` en vez de comparaciones con `number`; ninguna rama llama a
  `InventoryService.record`. El cambio de comportamiento (un saldo **negativo** ya no cierra
  automáticamente, cuando antes `dispatches.service.ts` y `coil-operations.service.ts` cerraban
  con `qty.lte(0)`) es la decisión explícita de D-360 (anomalía auditada + CLI), no un defecto.
- **`reopenAutoTerminatedCoils`/`planAutoReopen`**: exige que el **último** `coils.close`/
  `coils.open` de la bobina sea el cierre de esa causa exacta (`kind` + `refId`); nunca lanza por
  estado. Correcto para los siete caminos que sí lo usan (ver P1-1 para los dos que no).
  `coil-auto-terminate.spec.ts` cubre `MOUNTED`/`RESERVED`/`NEGATIVE`/`isAnomaly` con un `tx`
  simulado razonable.
- **`terminate-zero-coils.ts` + `terminate-zero-coils-cli.ts`**: dry-run por defecto en
  transacción `READ ONLY`, `--execute` exige lote + `assertExecuteAllowed`/`AYR_CLI_BRANCH`
  (mismo `cli-branch-gate.ts` que ya bloquea `production` sin `--confirm-production`, incluso en
  dry-run), `--undo` reabre solo lo de ese `batchId`. `coilsOfBatch` filtra por
  `autoTerminated.kind === 'BATCH'` además del `refId`, así que no confunde un lote con un
  `refId` que coincida por azar con otra causa.
- **`production.service.ts`/`roofing-production.service.ts`**: el cierre de OP llama
  `autoTerminateEmptyCoils` antes de marcar la orden `CLOSED`; la reapertura llama
  `reopenAutoTerminatedCoils` y usa `reopenedIds` para no bloquear la reapertura de un fleje que
  el propio cierre había terminado — el único de los seis archivos de la lista que necesitaba
  ese ajuste fino, y lo tiene en los dos servicios (drywall y coberturas), simétrico.
- **`dispatches.service.ts` (D-170/D-285)**: `closeEmptySoldCoils` migrado a la regla común;
  `reopenRevertedCoils` (la reversa de un despacho) **no** se migró a
  `reopenAutoTerminatedCoils` a propósito — su criterio (reabre si el **último** cierre del rollo
  lleva `closedByDispatch`, sin exigir que sea _este_ despacho) es más amplio que el genérico
  porque cubre el caso documentado de un rollo despachado en dos veces; no es un defecto, es una
  regla propia de D-170 que ya existía antes de D-360 y sigue siendo necesaria.
- **`LIVE_DOCUMENT_STATUSES` en `sales-margin.service.ts`**: confirmado que el conjunto local
  (`ISSUED`, `ACCEPTED`, `SEND_ERROR`, `VOID_PENDING`) es exactamente el de la constante
  compartida; el test nuevo lo fija comparando arrays ordenados y verificando que el SQL ya no
  trae el literal viejo.
- **`document-profitability.ts`/`.service.ts` (D-361)**: `traceLine`/`usageByOrderLine`/`per`/
  `addAcc`/`emptyAcc` extraídos de `sales-by-material.ts` sin cambiar su aritmética (se corrió
  `sales-by-material.service.spec.ts` existente, sigue en verde); el comprobante aporta a
  «Ventas por material» exactamente su `materialTotal` por construcción (misma función). El
  presupuesto de consultas declarado (documento + líneas, hasta 3 para el motor, 1 para
  despachos declarados) se corresponde con lo que hace el código: `Promise.all([engineFacts,
needsDispatch ? declaredSales : []])`. Endpoint `GET /reports/documents/:id/profitability`
  cerrado a `Role.ADMINISTRADOR`, con test de rol y de lógica separados. La reutilización del
  patrón `di."movement_id" = COALESCE(m."reversal_of_id", m."id")` en `declaredSales` es la misma
  que ya usan `sales-margin.service.ts` y `sales-by-material.service.ts`, no un patrón nuevo sin
  probar.
- **Columnas por ML y costo por unidad** (`sales-by-material.ts`, `sales-by-material-xlsx.ts`,
  `ventas-material-view.tsx`, `document-profitability.tsx`): conteo de columnas de cabecera vs.
  celdas verificado a mano en los tres lugares (Excel: 20 anchos para 20 encabezados; pantalla de
  Ventas por material: `colSpan={17}` para 17 encabezados; rentabilidad de comprobante:
  `colSpan` de 19 en total y en neto). `per()` devuelve `null` (→ «—») con divisor 0, nunca 0 ni
  `NaN`; `unit`/`qty`/`costPerUnitPen` se anulan con unidades mezcladas (`acc.unit === 'MIXED'`).
- **Regla dura 13 («por metro» son tres preguntas distintas)**: `metersOf` sigue decidiendo
  únicamente por `unit === 'MTR'` (o `NIU` + `lengthMm`), nunca por `roofingKind`; `dispatchLine`
  en `document-profitability.ts` pasa `kind: null` y deja que `metersOf` decida solo por la
  unidad, sin acoplarse al subtipo.

---

## Cierre

**Corregir 1 hallazgo P1 antes del deploy** (C06-P1-1: reversa de partido y de recepción de
corte sin `reopenAutoTerminatedCoils`). Los P2 son mejoras, no bloqueantes.

---

## Respuesta de la sesión (2026-09-28)

Corregido antes del deploy, con los P1 de la autorrevisión y del segundo modelo juntos:

- **Reversa de lo que dejó la bobina en 0, con otra causa de terminación (autorrevisión P1-1 y P1-2).**
  `reopenAutoTerminatedCoils` reconoce como propia una terminación **automática** cuyo `zeroedBy` es el
  movimiento que la reversa anula (`zeroedBy.movementId`) o su referencia (`zeroedBy.refId`): anular la
  merma pasa el movimiento; reabrir la OP pasa la OP y sus reportes; revertir el partido y la recepción de
  corte pasan el partido y la fila del envío. Cubre la bobina que terminó el lote de la CLI después de
  que esa misma operación la dejara en 0. Un cierre manual nunca se reabre por una reversa. Tests en
  `coil-auto-terminate.spec.ts`.
- **El neto de la nota de crédito en líneas fuera del motor (autorrevisión P1-3).** La línea acreditada que
  no es de Coberturas Aluzinc resta su venta con costo 0 (si hubo devolución, el costo ya volvió por la
  reversa del despacho; si fue descuento, no hay costo que devolver). Una nota de crédito vista por sí misma
  va igual y no consulta despachos. Tests en `document-profitability.spec.ts`.
- **`revertSplit` y la reversa de la recepción de corte sin auditoría (segundo modelo C06-P1-1).** Pasan por
  `reopenAutoTerminatedCoils` (la de corte con `targetStatus: IN_THIRD_PARTY`) y dejan su `coils.open`. Un
  partido anterior a D-360, sin esa auditoría, se reabre como siempre (RF-16).
- **P2 tomados:** el comando de reversa que imprime la CLI lleva `--confirm-production` en producción; los
  dry-run de la CLI con 120 s; los comentarios «la agotó otra orden» describían un caso imposible y ahora
  dicen que es una red de seguridad; etiquetas en la web para `coils.auto-terminate-skipped` y
  `coils.auto-reopen-skipped`; la rentabilidad de la propia nota de crédito ya no dice «sin despacho
  declarado».
- **P2 anotados, sin cambio:** el saldo se lee sin lock en la CLI (se corre en horario muerto, una sola
  transacción); una bobina sin fila de saldo cuenta como 0 (no existe hoy: las 82 vigentes la tienen); un
  despacho mixto con ítems con y sin salida de kardex se costea por lo que tiene salida; el motor de D-354
  resta costo por una nota de crédito de descuento (viene de antes); la unidad del costo por unidad en el
  total; el partido y la recepción de corte ya no terminan la madre en 0 con reserva viva (anomalía,
  auditada: va al guion UAT).

Verificación: unitarios de coils, reports, production, cutting e invoicing 605/605; E2E local de
`fase2b`, `fase3b`, `cierre-bobina-d164` y `correcciones-06` 33/33.
