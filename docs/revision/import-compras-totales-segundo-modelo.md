# Revisión de segundo modelo — fix/import-compras-totales (D-359)

**Quién firma esto:** un segundo modelo (Claude, contexto limpio), no una persona. Este documento
es el pase de "revisión de un segundo modelo" del estándar de `AGENTS.md` §2; no reemplaza la
autorrevisión ni la revisión del dueño al cierre, y por sí solo no cierra la ventana.

**Alcance revisado:** `git diff origin/main..HEAD` en el worktree
`ayr-steel-erp-fix-import-compras` (rama `fix/import-compras-totales`, commit `f6509ca`). Se leyó
el código de `apps/api/src/purchases/purchase-math.ts`, `purchases.service.ts`,
`apps/api/src/inventory/inventory.service.ts`, `apps/api/src/coils/coils.service.ts`,
`apps/api/src/imports/purchase-import-validate.ts`, `purchase-import.service.ts`,
`purchase-import-parse.ts`, `parse-spreadsheet.ts`, `packages/shared/src/schemas/purchase-import.ts`,
la vista web `importar-compras-view.tsx` y `apps/web/src/lib/purchase-import.ts`, el e2e
`e2e/tests/importar-compras-totales-d359.spec.ts`, `docs/ARQUITECTURA.md` (fila D-359) y
`docs/plantillas/README-importar-compras.md`. Se corrieron los unitarios de la API y del web
relacionados (ver «Pruebas ejecutadas»); no se corrió el resto de la suite ni lint/typecheck
completo (queda para QA/el resto del ciclo de revisión).

No se hicieron commits, `git add` ni cambios de código: solo este informe.

---

## Hallazgos

### P1 — Riesgo de datos: comprobantes ya importados con IGV silenciosamente mal calculado (sin este fix)

**Dónde mirar:** no es un archivo de este diff, sino el contraste entre el código viejo
(`origin/main:apps/api/src/imports/purchase-import-validate.ts:301-333`) y el nuevo
(`apps/api/src/imports/purchase-import-validate.ts:306-342`, `paperAmounts()` en
`apps/api/src/imports/purchase-import-validate.ts:625-661`).

**Escenario.** El código viejo leía la tasa de IGV con
`normalizeDecimal(doc.igvRate.replace('%', ''))` sin la detección de fracción que trae D-359
(`normalizeIgvRate`). Una columna TASA IGV con formato de porcentaje de Excel guarda `0.18` en la
celda; el código viejo la tomaba tal cual como **0,18 %** (un IGV ~100 veces menor al real). Si el
archivo **traía** TOTAL COMPROBANTE, el cruce de totales lo detectaba y bloqueaba la confirmación
(es el síntoma reportado: «85.00 no cuadra con 72.18»). Pero si el archivo **no traía** TOTAL
COMPROBANTE — la columna es opcional (`required: false`, el README la marca «no» obligatoria) —,
el código viejo (línea 325: `if (doc.documentTotal !== '') { … }`) **no comparaba nada**: el
comprobante se confirmaba con un IGV subestimado ~100x, sin error ni aviso.

Producción tiene datos reales desde 2026-09-07 y este importador ya corrió en prod (D-348..D-353,
según `docs/PROGRESO.md`/memoria de sesión). Si algún comprobante real se importó con la columna
TASA IGV en formato de porcentaje **y** sin TOTAL COMPROBANTE, ese comprobante puede estar hoy en
`purchases`/`purchase_items` con un IGV muy por debajo del real — y, si ya se recibió, con ese
mismo IGV mal calculado en el documento (el kardex no lleva IGV, así que el kardex en sí no se ve
afectado; sí el pasivo con SUNAT y el total que se le debe al proveedor si el total también se
calculó mal). Este hotfix corrige el cálculo para importaciones **futuras**, pero no auditá ni
corrige lo ya confirmado (documento e2e/README lo dicen expresamente: «sin migración… el ajuste no
se guarda: se deriva de lo guardado», D-169, pensado para la absorción de redondeo, no para este
caso).

**Sugerencia.** Antes de cerrar la ventana, pedir al dueño una auditoría de las compras vivas con
`importBatchId IS NOT NULL` (vía un servicio de dominio de solo lectura, nunca SQL directo contra
`production`, regla dura 3): recalcular `subtotal × 0.18` para cada una y comparar contra el `igv`
guardado; cualquier compra donde el guardado sea ostensiblemente menor (orden de magnitud, no
redondeo) es candidata a estar afectada. Las que sigan en `DRAFT` se pueden anular y reimportar con
esta rama; las que ya estén `RECEIVED` necesitan una decisión del dueño (no hay edición de líneas:
regla dura 16, ambigüedad → presentar y esperar decisión, no suponer).

---

### P1 — El costo del landed cost / corte tercerizado le borra al total del papel su exactitud recién ganada

**Dónde mirar:** `apps/api/src/purchases/purchases.service.ts:999-1028` (`bumpCoilDocumentCost`),
llamado desde `applyLandedCost` (línea 743) y `applyCuttingOrderCost` (línea 881).

**Escenario.** Antes de D-359, `coil.totalCost` **era**, por construcción,
`weightKg × unitCostPerKg` (así se creaba en `coils.service.ts`, sin otra fuente). Por eso
`bumpCoilDocumentCost` podía recalcular `totalCost = weightKg × newUnitCostPerKg` después de un
ajuste de costo (flete, aduana, seguro, corte tercerizado) sin perder nada: la igualdad se
mantenía siempre.

D-359 rompe esa igualdad a propósito para una bobina importada con `totalCost` del papel: ahora
`coil.totalCost` puede ser el importe exacto del papel (p. ej. `4430.1600`) mientras
`weightKg × unitCostPerKg` da un número distinto por el redondeo del unitario a 4 decimales (p.
ej. `4430.0520` con los números del propio e2e de esta rama — 4520 kg × 0.9801). Es exactamente la
diferencia que este hotfix existe para eliminar del kardex.

El problema: en cuanto esa bobina recibe **cualquier** landed cost o costo de corte tercerizado
(`bumpCoilDocumentCost`, líneas 1018-1026), el campo `coil.totalCost`/`totalCostPen` se **reescribe**
como `weightKg × newUnitCost` — no como `totalCost_anterior + delta` —, así que la bobina vuelve a
mostrar un total "recompuesto" que ya no es el del papel, silenciosamente. El kardex (la fuente de
verdad real, RF-51/D-028) no se ve afectado — sigue exacto, porque `adjustCost`/`record` trabajan
sobre el saldo del kardex, no sobre la fila de la bobina —, pero el documento de la bobina (lo que
ve el usuario en `/bobinas` y en su PDF) sí puede volver a mostrar el descuadre de céntimos que
D-359 se propuso resolver, apenas le llega un flete.

**Es un defecto preexistente** (la función no la escribió esta rama) que D-359 vuelve visible por
primera vez, porque es la primera vez que `coil.totalCost` puede no ser
`weightKg × unitCostPerKg`.

**Sugerencia.** Cambiar `bumpCoilDocumentCost` para que el nuevo `totalCost` sea
`coil.totalCost_actual + amountPen/exchangeRate` (el delta que el landed cost aporta, en la moneda
del documento) en vez de recomputar desde `weightKg × newUnitCost`. El `unitCostPerKg` seguiría
siendo el derivado para mostrar (como ya lo es desde D-359), pero el total del documento no
perdería la exactitud del papel por un flete posterior. Si se decide no tocarlo en este hotfix
(alcance acotado), como mínimo dejarlo anotado en `docs/PROGRESO.md` como deuda conocida, porque es
exactamente el tipo de "pieza que toca datos" que esa lista existe para registrar.

---

### P2 — `computeTotals` lanza `Error` genérico, no `BadRequestException`, si `paperAmounts` no calza en longitud

**Dónde mirar:** `apps/api/src/purchases/purchase-math.ts:69-71`.

```ts
if (paperAmounts !== undefined && paperAmounts.length !== input.items.length) {
  throw new Error('Los importes del papel no corresponden a las líneas de la compra');
}
```

**Escenario.** Con los llamadores actuales esto es inalcanzable (`amounts` siempre se construye con
un elemento por línea validada, ver `purchase-import-validate.ts:431-439`), así que hoy no hay
ningún archivo real que lo dispare. Pero si algún día cambia esa invariante (un refactor que filtre
líneas antes de armar `amounts`, por ejemplo), el `Error` plano **no** es una `HttpException`, y
`PurchaseImportService.confirm()` solo hace `ROLLBACK TO SAVEPOINT` para errores que sí lo son
(`apps/api/src/imports/purchase-import.service.ts:415-420`: `if (!(err instanceof HttpException)) throw err;`).
Un `Error` ahí aborta la transacción **entera** (todos los comprobantes del lote, no solo el que
falló), con un mensaje que no llega limpio al usuario.

**Sugerencia.** Cambiar `throw new Error(...)` por `throw new BadRequestException(...)` en
`purchase-math.ts`, para que si esta invariante alguna vez se rompe, falle **ese** comprobante (con
`ROLLBACK TO SAVEPOINT`) y no el lote completo. Costo mínimo, defensa correcta.

---

### P2 (informativo, no requiere acción en este hotfix) — `coil.totalCost` ya no implica `weightKg × unitCostPerKg`

Consecuencia directa y esperada del diseño de D-359 (no un bug): al recibir una bobina con importe
de papel, `coils.service.ts:156-160` fija `totalCost` al valor del papel y dejará de coincidir
exactamente con `weightKg × unitCostPerKg` (que sigue siendo el que se muestra como
`unitCostPerKg`, a 4 decimales, "solo para mostrar" por D-255). Cualquier futuro código que asuma
esa igualdad para una bobina (fuera de `bumpCoilDocumentCost`, ya cubierto arriba) debería leer
`coil.totalCost` directamente y no recomputarlo. No encontré otro lugar que la asuma hoy
(`coil-operations.service.ts`, `cutting.service.ts` e `initial-inventory-import.service.ts` no
pasan `totalCost` a `coils.create`, así que no heredan esta situación).

---

## Lo que se revisó y no dio hallazgos

- **Decimal y redondeos.** `money()`, `toFixedString(..., 'MONEY')` y las tolerancias
  (`importRoundingTolerance`, D-169; `UNIT_COST_ROUNDING = 0.00005`, media unidad de la 4ª
  decimal) se usan consistentemente; no hay ningún `number` operando dinero.
- **Promedio ponderado (`InventoryService.record`).** El cambio de `qty.times(unitCost)` a un
  `totalCost` explícito es correcto en las tres ramas (saldo previo ≤ 0, saldo previo > 0, salida);
  `assertTotalMatchesUnit` es una comprobación de autoconsistencia sólida y sin ventana de carrera
  (corre antes de cualquier escritura).
- **Reversas y anulaciones de compras recibidas.** `InventoryService.reverse` lee `totalCost` del
  movimiento original tal cual quedó guardado (nunca lo recalcula desde `qty × unitCost`), así que
  una entrada con `totalCost` del papel se revierte exacta sin cambios necesarios en esa función.
  `PurchasesService.cancel` no cambia con este diff.
- **Compras manuales en USD.** El mismo `receptionCost`/`totalCost` ahora se usa también para
  compras del formulario (no solo del importador): la recepción entra por `item.subtotal × TC`
  (calculado una sola vez, en la creación) en vez de recomputar `qty × unitPrice × TC` en la
  recepción — elimina el doble redondeo que motivó la decisión B (el caso de la bobina de 4 520 kg
  a 0.980123 USD, 16 590.66 vs 16 590.93). Correcto y sin regresión: el `subtotal` guardado en la
  compra no cambia (sigue siendo `money(qty×unitPrice)` para el formulario), solo cambia qué número
  usa la recepción para entrar al kardex.
- **Corte tercerizado (RF-41) y landed cost (D-043).** `applyLandedCost`/`applyCuttingOrderCost` no
  se tocan en este diff; el prorrateo sigue sobre el saldo del kardex (`inventoryBalance`), no sobre
  `weightKg`, así que no depende de la exactitud del papel. Ver el P1 sobre
  `bumpCoilDocumentCost` para la única interacción real.
- **Partido de bobinas.** `coil-operations.service.ts` no pasa `totalCost` a `coils.create`
  (confirmado por grep): las hijas de un partido siguen sin verse afectadas por este cambio.
- **Seguridad — `paperAmounts` no llega por HTTP.** `PurchasesService.createInTx` es la única
  función que acepta `options.paperAmounts`, y el controlador (`purchases.controller.ts:103-107`)
  solo llama a `create()` (que llama a `createInTx` con `options = {}`, sin `paperAmounts`).
  `createPurchaseSchema` (el DTO de `POST /purchases`) no tiene ningún campo `lineAmount` ni
  `paperAmounts`; el único llamador que los pasa es `PurchaseImportService.confirm()`
  (`purchase-import.service.ts:407-413`), y ahí `v.amounts` se recalcula en el servidor a partir de
  `validateAll()` sobre el `input.documents` recibido — nunca se reenvía tal cual algo que vino del
  navegador sin pasar de nuevo por `validateDocument`/`paperAmounts()`. Sin hallazgos.
- **Casos borde del parser.** `normalizeDecimal` (miles repetidos, una sola coma siempre decimal,
  ambigüedades que dan `null`) y `normalizeIgvRate` (`18`, `18%`, `18 %`, `0.18`, `0,18`, tasa 0)
  están bien cubiertos por `purchase-import-shared.spec.ts` y coinciden con lo que implementan.
  Verifiqué a mano el caso límite `'18 %'` (el `replace(/%$/, '')` deja un espacio residual, que
  `normalizeDecimal` limpia con su propio `replace(/\s/g, '')`) — correcto.
- **La web.** `lineAmount` viaja en `toDocumentInput` (`purchase-import.ts:46`) y en el DTO de línea
  (`packages/shared/.../purchase-import.ts`); `lineEditPatch` vacía `lineAmount` al editar `qty` o
  `unitPrice`, y está realmente enganchado en `importar-compras-view.tsx` (el `onEdit` compartido
  por todos los campos de texto de la fila, incluidos `qty` y `unitPrice` en sus dos variantes —
  bobina y no-bobina), no es código muerto.
- **Plantillas.** Verifiqué con un script de una sola vez (leído y no conservado) que
  `docs/plantillas/importar-compras.xlsx` y `-ejemplo.xlsx` tienen exactamente los encabezados
  `TOTAL COMPROBANTE CON IGV` e `IMPORTE SIN IGV` que `PURCHASE_IMPORT_COLUMNS` espera.
- **Los tests prueban lo que dicen.** Revisé a mano los números de los casos representativos
  (`inventory-total-cost.spec.ts`: la bobina de 4 520 kg a 0.980123 USD con TC 3.745 da
  `totalCost: '16590.9342'`, `unitCost: '3.6706'`, verificado por cálculo manual; el caso del dueño
  en `purchase-import-validate.spec.ts` reproduce 500 × 0.144068 = 72.034, IGV absorbido a 12.966,
  total 85.00 exacto) y coinciden con el código. El e2e (`importar-compras-totales-d359.spec.ts`)
  corre el camino completo contra la base real (preview → confirmar → corregir número → recibir →
  leer kardex/bobina), no solo unidades aisladas, y cubre el caso PEN, el caso USD con bobina, y el
  caso de diferencia no absorbible.

---

## Pruebas ejecutadas

```
cd apps/api && npx jest src/purchases src/coils src/inventory src/imports
# 30 suites, 405 tests — todos pasaron

cd apps/web && npx vitest run src/lib/purchase-import.spec.ts
# 1 archivo, 8 tests — todos pasaron
```

No corrí lint, typecheck ni build completos, ni la suite E2E completa (el propio spec de D-359 se
salta contra un `E2E_BASE_URL` real por D-126, y correr Playwright completo no es parte del pase de
este segundo modelo).

---

## Resumen

El cálculo en sí —tasa de IGV, importe de línea, absorción de redondeo en la última línea, y el
`totalCost` explícito que ahora recibe el kardex vía `InventoryService.record`— está bien resuelto,
con `Decimal` de punta a punta, sin ventanas de carrera nuevas, sin forma de mandar `paperAmounts`
por HTTP, y con un e2e que lo prueba contra la base real, no solo con mocks. Los dos P1 son:
(1) un riesgo real de que ya haya comprobantes en producción con IGV mal calculado por el bug viejo
y sin ningún aviso que lo haya delatado — vale la pena una auditoría antes de cerrar la ventana; y
(2) que aplicar un flete, aduana, seguro o corte tercerizado a una bobina importada con D-359 le
borra la exactitud del total del papel que este mismo hotfix le dio, porque
`bumpCoilDocumentCost` sigue recomputando `totalCost` desde `weightKg × unitCostPerKg` en vez de
sumarle el delta. Ninguno de los dos bloquea el deploy por sí mismo (el kardex real, que es la
fuente de verdad, queda correcto en los dos casos), pero los dos merecen una decisión del dueño
antes de dar la ventana por cerrada.

## Respuesta de la sesión

- **P1-1 (compras ya confirmadas con el código viejo y el IGV subestimado): se verifica en producción**
  en la verificación de solo lectura del deploy (todas las compras vivas: IGV guardado contra el 18 %
  del valor, o 0). El resultado va al handoff y a `docs/PROGRESO.md`; si hay alguna, el arreglo es
  decisión del dueño (anular y volver a importar), nunca SQL.
- **P1-2 (`bumpCoilDocumentCost` recalculaba el total desde el peso): corregido**: suma el delta de la
  imputación al total guardado (en la moneda del documento y en soles).
- **P2 (`computeTotals` con `Error` genérico): corregido** (`BadRequestException`).
