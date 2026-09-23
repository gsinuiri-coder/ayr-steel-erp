# Revisión cruzada — D-246 y RF-S4a, y diagnóstico de D-245

Fecha: 2026-09-22. Alcance: `d66de6b` (hotfix D-246) y `da8b624` (merge de RF-S4a). Sin cambios
de código: este documento es el único artefacto.

---

## Ningún P0 sobre datos de producción

Nada de lo encontrado corrompe ni corrompió datos ya almacenados, y no hay motivo para detener
la operación. El hallazgo más grave (**P1-1**) es un **guardrail ausente sobre entradas nuevas**:
puede admitir un reporte de planta físicamente imposible si un operario declara una cifra
errada, pero no altera por sí solo nada de lo que ya está escrito. El kardex sigue cuadrado y
append-only en todos los caminos revisados.

---

## Sobre el PASO 2 (RF-S4a)

> **AUTORREVISIÓN — no constituye pase cruzado de AGENTS.md §2.2. RF-S4a sigue pendiente de
> revisión por un agente distinto al que lo implementó. Este apartado es una lista de riesgos
> para ese revisor, no una aprobación.**

Lo escribí yo, en la sesión inmediatamente anterior. La restricción del PASO 0 —revisar desde
el diff y las decisiones, sin leer los handoffs de implementación— se respetó, pero no puede
darme independencia: el razonamiento del autor está en mi contexto porque es el mío. Vale como
mapa de dónde mirar; no vale como pase. Registrado como **D-248**.

Los PASOS 1, 3 y 4 **sí** son independientes: D-246 lo escribió otra sesión y no leí su
handoff; `/reports/coils` es código preexistente de otro autor; el PASO 4 es una medición.

---

## PASO 1 — D-246 (tope del reporte en lo montado)

Revisado desde el diff `7a2c1c3..d66de6b`: `roofing-math.ts`, `production.ts` (shared),
`production.service.ts`, `roofing-production.service.ts`, `roofing-drafts*`, los dos paneles de
planta y `mounted-kg.spec.ts`.

### P1-1 — La rama «con declaración» de `mountedKgForReport` no tiene techo

`packages/shared/src/schemas/production.ts:478-494`

Las dos ramas de la función tratan el exceso del teórico sobre lo montado de forma
**asimétrica**:

- **sin declaración**: el exceso se acota a `THEORETICAL_KG_TOLERANCE_RATIO` (1 % del teórico).
  Fuera de eso, rechaza.
- **con declaración**: el único requisito es `declaredKg ≤ availableKg` y `availableKg > 0`.
  **No hay tolerancia.** Cualquier declaración, por chica que sea, desactiva el techo.

**Escenario que lo dispara.** Un operario reporta el conteo de piezas equivocado —o las piezas
correctas contra la bobina equivocada— y declara una cifra baja de consumo:

| teórico      | montado      | declarado        | veredicto                      | sale del kardex |
| ------------ | ------------ | ---------------- | ------------------------------ | --------------- |
| 4 043.952 kg | 3 960.000 kg | _(sin declarar)_ | **rechaza** (exceso 2 % > 1 %) | —               |
| 4 043.952 kg | 3 960.000 kg | 3 960.000 kg     | acepta                         | 3 960 kg        |
| 4 043.952 kg | **1.000 kg** | **0.500 kg**     | **acepta**                     | **1 kg**        |

La última fila es el problema: se admite un reporte cuyas planchas equivalen a 4 043 kg de
acero sacando **1 kg** de la bobina. Verificado ejecutando `mountedKgForReport` con esos
valores; los tres casos se comportan como dice la tabla.

**El único freno es un aviso, no un rechazo.** `roofingConsumptionDeviation`
(`production.ts:390`) genera la nota «99,99 % por debajo. Revisa que no falte un dígito», pero
el servicio la hace `deviation.push(note)` y sigue (`roofing-production.service.ts:964-971`).

**Consecuencia.** El kardex no se desbalancea —sale lo mismo que entra— pero el producto
terminado entra valorizado por 1 kg de material en vez de 4 043. Eso propaga:

1. subvalúa el inventario de producto terminado (`inventory_balances.avg_cost`);
2. y por lo tanto **infla el margen** del reporte de RF-S4a, cuyo costo de venta sale de ese
   mismo valorizado (D-242). Un error de tipeo en planta termina como margen inventado en la
   pantalla que el dueño le muestra al cliente.

**Arreglo mínimo propuesto** (no implementado): aplicar la misma tolerancia en las dos ramas.
La declaración debería seguir siendo la condición para _permitir_ el tope, no un pase que
elimina el techo:

```ts
// tras validar declared <= available
if (excess.lte(theoretical.times(toDecimal(THEORETICAL_KG_TOLERANCE_RATIO)))) {
  return { ok: true, kg: available, capped: true, note };
}
return { ok: false, message: /* exceso fuera de tolerancia, aun declarando */ };
```

Con eso el caso real de la ventana (exceso 0,84 %) sigue pasando y el absurdo se bloquea.

### P3-1 — `declaredKg` se usa como reja, nunca como valor

`packages/shared/src/schemas/production.ts:480`

Cuando la declaración cabe en lo montado, la función devuelve `kg: available`, **no**
`kg: declared`. Declarar 3 990 kg con 4 010 montados descuenta 4 010. El spec lo fija
explícitamente («con lo declarado por debajo de lo montado también pasa, topado en lo
montado»), y es defendible —si el teórico pasa lo montado, el acero salió entero—, pero el
nombre del parámetro sugiere lo contrario y quien lea la firma va a asumir que se consume lo
declarado. La nota al usuario sí dice los kilos reales que se descuentan. **Sugerencia
documental**, no de código: decirlo en el texto de D-246.

### Puntos del brief verificados, sin hallazgo

- **Varias bobinas montadas en la misma OP.** Coberturas topa contra la fila de consumo del
  rollo del reporte (`rowRemainingKg`, un rollo por reporte); drywall suma el remanente de
  todas las filas antes de topar (`production.service.ts:596-605`). Ninguno mezcla bobinas.
- **Bobina reabierta / D-193.** `RoofingBatchOrderDto.reportedKg` pasó a sumar `consumedKg` de
  los consumos **no liberados** (`roofing-production.service.ts:1325`), y eso es correcto
  porque `releaseCoil` **rechaza** bajar una bobina con `consumedKg > 0`
  (`roofing-production.service.ts:749-753`): una fila liberada aporta cero por construcción.
  Además `batchOrders` solo devuelve órdenes `DRAFT`/`IN_PROGRESS` (`:1224-1229`), así que la
  premisa «con la orden abierta» del comentario se cumple de verdad.
- **Piso del cierre.** `closeInTx` dejó de sumar teóricos y ahora lee las salidas reales de
  kardex de cada reporte (`reportsOutKg`), filtradas por `liveMovements` para excluir las
  anuladas. Un reporte anterior a D-246 tiene salida igual a su teórico, así que su cierre no
  cambia — y el spec lo fija.
- **Append-only y transaccional.** Las lecturas nuevas usan `tx.inventoryMovement.findMany`
  dentro de la transacción del cierre; no se agregó ningún `UPDATE` ni `DELETE` sobre kardex.
- **Drywall fuera de tolerancia.** `mounted.ok ? mounted.kg : neededKg` cae de vuelta en
  `allocateStripKg`, que rechaza igual porque `neededKg > Σ remainingKg` siempre que
  `mounted.ok` sea falso. El rechazo no se pierde; solo cambia el mensaje, que es lo buscado.

### No cubierto por esta revisión

El staging todo-o-nada de D-191 (`roofing-drafts.ts`) se leyó por encima: el spec cubre el caso
«una fila topada deja la bobina en cero para la siguiente», pero **no** revisé el camino de
varias filas del borrador topando contra la misma bobina en una sola confirmación. Queda como
punto abierto para el revisor de D-246.

---

## PASO 2 — RF-S4a (autorrevisión, ver banner arriba)

> **AUTORREVISIÓN — no constituye pase cruzado de AGENTS.md §2.2. RF-S4a sigue pendiente de
> revisión por un agente distinto al que lo implementó. Este apartado es una lista de riesgos
> para ese revisor, no una aprobación.**

### Verificado desde el diff

- **Alcance.** Las cuatro rutas nuevas llevan `@Roles(Role.ADMINISTRADOR)`
  (`reports.controller.ts:53,60,73,81`). El `RolesGuard` es global y devuelve **403**, no 404:
  el 404 de D-238 oculta entidades ajenas a un VENDEDOR, no rutas enteras, y acá se niega la
  ruta completa. Ningún otro endpoint expone los DTO nuevos. El E2E cubre admin/vendedor/
  supervisor sobre las dos rutas de datos.
- **Costo desde movimientos `SALE`.** Despacho revertido: `InventoryService.reverse` emite un
  `IN` con el mismo `refType`/`refId`, así que netea sin caso especial; y
  `pendingDispatchByOrder` filtra `d.status = 'ISSUED'`, que es coherente con eso.
  Notas de crédito: restan por `signedSubtotal`. Venta de bobina entera: es el escenario del
  E2E.
- **Nada se interpola.** `costPen` va `null` —no cero, no estimado— cuando falta el enlace
  `Dispatch.invoiceId`, y `NO_COMPARABLE` queda fuera de los totales. No hay prorrateo en
  ninguna rama.
- **Fechas.** El rango compara `DATE` contra `DATE` en SQL, sin zona horaria de por medio.
  `asOf` usa `businessToday()` (Lima) y el E2E lo fija.
- **Líneas de negocio.** Las vistas usan `BUSINESS_LINE_LABELS` (D-174).

### Riesgos que el revisor real debería mirar con ojos frescos

1. **`fromDbLineCode` lanza ante un código desconocido.** Si alguien agrega un valor al enum de
   la base sin tocar `@ayr/shared`, los dos reportes pasan de «una línea mal rotulada» a **500**.
   Fue deliberado (fallar donde se lee, no mostrar `undefined`), pero es un cambio de modo de
   falla que conviene que alguien más juzgue.
2. **El grupo «sin línea» usa un literal de UI**, no el mapa de D-174, porque no es una línea.
   Verificar que sea la lectura correcta y no un hueco.
3. **Línea de servicios (D-167).** Una venta sin inventario no genera movimiento `SALE`, así que
   su línea aparece con venta y costo cero, o sea 100 % de margen. Es correcto —no hay costo de
   material— pero se lee igual que el defecto que D-247 arregló. Confirmar que no confunda.
4. **Presupuesto de consultas.** Es fijo por construcción (2 en M1, 6 en M2) y hay tests que lo
   fijan contra N creciente, pero **nunca se midió contra el volumen real de producción**: los
   tests usan mocks y el E2E, una base recién creada.
5. **`ELSE -m."total_cost"` para `ADJUST`** en `costsByOrder`: hoy no existe un `ADJUST` bajo
   `refType='SALE'`, así que esa rama nunca corre y **nadie la probó**.
6. **D-247 es de hoy y su guardrail es indirecto**: el E2E exige que la tabla por línea sume los
   totales y que ninguna línea tenga costo sin venta, pero no fija la atribución de una fila
   concreta.

---

## PASO 3 — D-245: `/reports/coils` devuelve la línea vacía y su filtro no matchea nunca

### Reproducción

Contra el stack local (`ayr_rf_s4a`, 11 bobinas en `drywall` y `metallic-roofing`):

```
SIN filtro .................. 11 fila(s)
businessLine de la 1a fila .. undefined
la clave existe en el JSON .. false
CON filtro drywall .......... 0 fila(s)
CON filtro metallic-roofing . 0 fila(s)
```

### Causa raíz

`apps/api/src/reports/reports.service.ts:86,107`

El mismo dato tiene **tres formas** y dos se confunden a simple vista:

| forma                            | valor       | dónde vive                                         |
| -------------------------------- | ----------- | -------------------------------------------------- |
| nombre del enum de Prisma        | `'DRYWALL'` | `BusinessLineCode.DRYWALL`, cliente generado       |
| identificador de `@ayr/shared`   | `'drywall'` | `BusinessLine.DRYWALL`                             |
| **etiqueta que guarda Postgres** | `'drywall'` | valor de `@map`, lo que devuelve `bl."code"::text` |

La consulta cruda devuelve la **tercera**, que coincide con la segunda y **no** con la primera.
De ahí los dos síntomas:

1. `toSharedLineCode(r.business_line_code)` indexa `TO_SHARED` por nombre de Prisma, así que
   `TO_SHARED['drywall']` es `undefined` y la clave desaparece del JSON (`reports.service.ts:107`).
2. el filtro compara `bl."code"::text = ${toPrismaLineCode(...)}`, o sea `'drywall' = 'DRYWALL'`,
   que es falso siempre (`reports.service.ts:86`).

Sobrevivió porque el único E2E que toca la ruta (`e2e/tests/fase7-consolidada.spec.ts:112`) la
llama **sin filtro** y no mira esa columna.

### Arreglo mínimo propuesto (no implementado)

Dos líneas, usando el helper que RF-S4a ya agregó para esto:

```ts
// reports.service.ts:86 — comparar contra la etiqueta de Postgres, no el nombre de Prisma
const lineCode = query.businessLine ?? null;   // ya es 'drywall' | 'metallic-roofing' | ...
// ...:107 — traducir desde la etiqueta de la base
businessLine: fromDbLineCode(r.business_line_code),
```

`fromDbLineCode` vive en `apps/api/src/common/business-line-code.ts` y **valida**: una línea
nueva en la base que nadie mapeó revienta donde se lee en vez de aparecer vacía.

**El arreglo necesita un test que hoy no existe**: el E2E de la ruta debe llamarla con
`?businessLine=` y afirmar que devuelve filas y que `businessLine` viene poblado. Sin eso, el
mismo defecto vuelve sin que nadie lo note.

---

## PASO 4 — Sonar: qué falta cubrir, ordenado por lo que aportaría

El gate del PR #9 falla por **una sola condición**, y por primera vez se pudo enumerar:

```
Quality Gate failed — 74.8% Coverage on New Code (required ≥ 80%)
```

**`Reliability D` no aparece.** El que arrastraba el PR #7 no se repite en este.

`apps/web` mide cobertura con `vitest run --coverage --coverage.reporter=lcov`, y su
`lcov.info` contiene **solo dos archivos** (`src/lib/audit-labels.ts`, `src/lib/search-status.ts`):
todo lo demás del web entra a Sonar como no cubierto.

| #   | Archivo                                                             |    Líneas de código sin cubrir | Por qué                                  |
| --- | ------------------------------------------------------------------- | -----------------------------: | ---------------------------------------- |
| 1   | `apps/web/.../ventas-margen/ventas-margen-view.tsx`                 |                           ~290 | sin ningún test                          |
| 2   | `apps/web/.../inventario-valorizado/inventario-valorizado-view.tsx` |                           ~256 | sin ningún test                          |
| 3   | `apps/api/src/reports/reports.controller.ts`                        |        ~68 nuevas (0 % medido) | ningún spec instancia el controlador     |
| 4   | `apps/web/src/lib/nav.ts`                                           |                      16 nuevas | archivo sin test                         |
| 5   | `apps/web/.../{inventario-valorizado,ventas-margen}/page.tsx`       |                             14 | dos envoltorios                          |
| 6   | `apps/api/src/reports/reports-xlsx.ts`                              | ramas, no líneas (73 % branch) | faltan las ramas de `null` en las celdas |

**Cuánto hace falta.** Con ~650 líneas nuevas sin cubrir representando el 25,2 % restante, el
total de líneas nuevas medibles ronda las 2 580, y cerrar 5,2 puntos exige cubrir **~134 líneas
nuevas más**. Es una estimación por regla de tres sobre el porcentaje que informa el gate: los
números exactos están en el dashboard, que esta sesión no puede leer.

**El camino más barato para pasar el gate**, en orden de rendimiento por esfuerzo:

1. **`reports.controller.ts`** (~68 líneas): un spec con `Test.createTestingModule` que llame
   los cuatro métodos con servicios mockeados. Es la mitad del hueco necesario, sin infraestructura
   nueva, y de paso cubre que las rutas xlsx fijan `Content-Type` y `Content-Disposition`.
2. **Un render de `ventas-margen-view.tsx`** con datos de las tres clases de fila. Cubre el
   camino ancho de la vista más grande y de paso fija en un test el estado vacío, los tres
   badges y la sección de facturación parcial.
3. **Las ramas de `null` de `reports-xlsx.ts`** (líneas 181-221): baratas, suben `branch` y no
   `line`, así que ayudan al gate solo si Sonar mide condiciones además de líneas.

Cubrir 1 y 2 sobra para los 5,2 puntos. Lo que **no** conviene es perseguir el porcentaje con
tests de humo sobre los envoltorios `page.tsx`: son 14 líneas y no prueban nada.

---

## Resumen de hallazgos

| id        | sev | dónde                       | qué                                                                                                                    |
| --------- | --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **P1-1**  | P1  | `production.ts:478-494`     | la rama con declaración de `mountedKgForReport` no acota el exceso; admite un reporte imposible y subvalúa el producto |
| **P3-1**  | P3  | `production.ts:480`         | `declaredKg` es reja y no valor: se descuenta lo montado, no lo declarado                                              |
| **D-245** | P2  | `reports.service.ts:86,107` | la línea sale `undefined` y el filtro no matchea nunca; reproducido                                                    |
| —         | —   | `roofing-drafts.ts`         | no revisado: varias filas del borrador topando contra la misma bobina                                                  |

RF-S4a no tiene hallazgos propios en este documento **porque no fue revisado por un tercero**.
Los seis riesgos del PASO 2 son puntos a mirar, no conclusiones.
