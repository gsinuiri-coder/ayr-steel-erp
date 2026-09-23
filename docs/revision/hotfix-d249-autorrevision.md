# Autorrevisión — hotfix D-249/D-250 (tolerancia simétrica y filtro de línea)

> **AUTORREVISIÓN — no constituye pase cruzado de AGENTS.md §2.2.**

Esta revisión es una extensión de **D-248** (`docs/ARQUITECTURA.md` §0.2), la excepción de
autorrevisión registrada durante RF-S4a. El motivo es el mismo entonces y ahora: no hay un
segundo agente disponible para un pase cruzado independiente. No se numera un `D-nnn` nuevo —
D-248 ya cubre esta situación como precedente— y este documento no reemplaza la deuda: el
hotfix D-249/D-250 **sigue pendiente de revisión por un agente distinto** del que lo implementó.

Fecha: 2026-09-23. Alcance: `git diff da8b624..HEAD` sobre `hotfix-d249`. Restricción respetada:
no se leyó `docs/handoff/hotfix-d249.md`; sí se leyó `docs/revision/rf-s4a-d246.md` (el hallazgo
P1-1/D-245 que motivó el hotfix, sin su implementación) y `docs/ARQUITECTURA.md` §0.2
(D-246/D-248/D-249/D-250).

---

## Ningún P0

Nada de lo revisado escribe kardex fuera de transacción ni corrompe datos ya almacenados. Los
dos cambios de producto son de solo cálculo/lectura (ver M2 abajo).

---

## M0 — la tolerancia de `mountedKgForReport` es simétrica de verdad

`packages/shared/src/schemas/production.ts:478-509`. El cambio mueve el corte de tolerancia
**antes** de mirar `declaredKg`: ahora `excess.gt(tolerance)` se evalúa primero y rechaza sin
importar si hay declaración; solo si el exceso cabe en la tolerancia se llega a la rama de
declaración, que conserva su única función propia (exigir `declared ≤ available`).

Verificado con cálculo propio, no con los comentarios del código:

| caso          | teórico  | montado  | declarado                   | exceso   | tolerancia (1 % del teórico) | veredicto esperado              | veredicto real                  |
| ------------- | -------- | -------- | --------------------------- | -------- | ---------------------------- | ------------------------------- | ------------------------------- |
| ventana D-246 | 4043.952 | 4010.000 | 4010.000 / _(sin declarar)_ | 33.952   | 40.43952                     | acepta (33.952 ≤ 40.43952)      | **acepta**, `kg=4010.000`       |
| exceso 2 %    | 4043.952 | 3960.000 | 3960.000 / _(sin declarar)_ | 83.952   | 40.43952                     | rechaza (83.952 > 40.43952)     | **rechaza**, con y sin declarar |
| absurdo P1-1  | 4043.952 | 1.000    | 0.500                       | 4042.952 | 40.43952                     | rechaza (4042.952 ≫ 40.43952)   | **rechaza**                     |
| borde exacto  | 1000.000 | 990.000  | 990.000                     | 10.000   | 10.000                       | acepta (10.000 ≤ 10.000, `lte`) | **acepta**                      |
| borde + 1 g   | 1000.000 | 989.999  | 989.999                     | 10.001   | 10.000                       | rechaza (10.001 > 10.000)       | **rechaza**                     |

Los cinco casos son cálculo manual con la aritmética de la función (`excess = theoretical -
available`, `tolerance = theoretical × 0.01`, comparación con `.gt`/`.lte`), no una lectura de
comentarios, y coinciden con lo que reportó la corrida de tests (abajo).

**Corrida real, no asumida:**

```
apps/api > pnpm exec jest mounted-kg.spec.ts
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
```

incluye las 5 pruebas nuevas de `describe('mountedKgForReport — tolerancia simétrica (D-249)')`
y las 8 de `describe('mountedKgForReport (D-246)')` sin regresión (una de estas últimas tuvo su
regex de mensaje actualizada porque el texto de rechazo cambió de "declara los kg consumidos" a
"del 1 % del teórico", coherente con que el mensaje unificado ya no sugiere declarar como salida
cuando declarar dejó de tener ese efecto).

También se corrió el resto de specs de `production`/`reports` para descartar regresión lateral:

```
apps/api > pnpm exec jest production reports
Test Suites: 9 passed, 9 total
Tests:       120 passed, 120 total
```

**Veredicto M0: correcto.** El caso real de D-246 (0,84 % de exceso) sigue pasando; el absurdo
de la tabla de `rf-s4a-d246.md` (4043,952 kg teóricos / 1 kg montado / 0,5 kg declarado) ahora se
rechaza. La asimetría del hallazgo P1-1 está cerrada: la declaración habilita el tope, no lo
desactiva.

**Nota lateral (no bloqueante).** `THEORETICAL_KG_TOLERANCE_RATIO` en el caso de la ventana da
`tolerance = 40.43952`, y el `.toFixed(0)` del mensaje sigue mostrando "1 %" — coherente con
`docs/ARQUITECTURA.md` D-249 en cuanto a que la regla es ahora más estricta que antes: un caso
legítimo por encima del 1 % que antes se colaba declarando ahora se bloquea sin excepción, y la
única salida documentada es subir la constante con evidencia, no volver a la asimetría.

---

## M1 — el test nuevo sí es un centinela

Procedimiento: edité `packages/shared/src/schemas/production.ts` devolviendo la rama de
`declaredKg` a su forma anterior a D-249 (evaluada **antes** del corte de tolerancia, sin techo,
solo `declared.lte(available)`), reconstruí el paquete (`pnpm --filter @ayr/shared run build`,
necesario porque `apps/api` resuelve `@ayr/shared` contra `dist/`, no contra `src/` — un jest
corrido sin reconstruir habría seguido leyendo el `dist` ya compilado con el fix y dado un falso
verde) y corrí `mounted-kg.spec.ts` de nuevo.

**Resultado con el fix revertido:** 4 tests en rojo, 17 en verde.

Los tres que importan para M1 —los que targetean directamente el fix de D-249— fallan como se
espera:

- `un exceso del 2 % rechaza, se declare o no: antes declarar lo salteaba` → `expect(r.ok).toBe(false)` recibe `true` (con `declaredKg: '3960.000'`, la rama vieja acepta porque `3960 ≤ 3960`).
- `el absurdo del hallazgo P1-1 ahora rechaza...` → recibe `true` (con `declaredKg: '0.500' ≤ availableKg: '1.000'`, la rama vieja acepta sin mirar el exceso de 4042.952 kg). Este es exactamente el caso de la tabla del hallazgo original.
- `el borde exacto de la tolerancia pasa declarando, y un gramo más no` → el segundo `expect(pasado.ok).toBe(false)` recibe `true`.

(El cuarto rojo, `sin declarar, el borde exacto de la tolerancia pasa y un gramo más bloquea`,
es un test preexistente de D-246 cuya única diferencia es el texto del mensaje de rechazo — no
es uno de los centinelas nuevos de M1, y su fallo es de wording, no de lógica: sin declaración
ambas versiones rechazan igual, solo cambia el string.)

Después de confirmar el rojo, restauré el archivo (`git checkout -- packages/shared/src/schemas/production.ts`), confirmé `git diff --stat` vacío contra `HEAD` para ese archivo, y reconstruí el paquete otra vez (`pnpm --filter @ayr/shared run build`). Corrida final:

```
apps/api > pnpm exec jest mounted-kg.spec.ts
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
```

El repo quedó en el mismo estado que al empezar (`git status --porcelain` vacío; el único
artefacto tocado, `packages/shared/dist/`, está en `.gitignore` y ya había quedado desactualizado
respecto del build previo al abrir esta sesión — reconstruirlo con el código de `HEAD` lo dejó
correcto, no lo alteró frente a git).

**Veredicto M1: correcto.** Los tres tests nuevos que targetean el fix de D-249 fallan sin él y
pasan con él; son centinelas reales, no decorativos.

**Hallazgo de proceso (P2, no de producto):** `apps/api` resuelve `@ayr/shared` contra el `dist/`
publicado en `package.json#main`, no contra `src/` vía `ts-jest`/paths. Cualquier revisión futura
que edite `packages/shared/src` y corra `pnpm exec jest` en `apps/api` **sin reconstruir el
paquete primero** obtiene el comportamiento del build viejo, no del código que acaba de tocar —
un falso verde (o falso rojo) silencioso. No es specific de este hotfix, pero vale la pena
dejarlo registrado porque esta misma sesión lo pisó en el primer intento (los 21 tests "pasaron"
con el fix revertido en `src`, antes de reconstruir `dist`).

---

## M2 — nada del hotfix toca kardex fuera de transacción

**`packages/shared/src/schemas/production.ts` (M0).** `mountedKgForReport` es una función pura:
recibe `theoreticalKg`/`availableKg`/`declaredKg` como `DecimalInput`, opera con `Decimal` y
devuelve un objeto. El archivo entero no importa Prisma ni nada de `@prisma/client`; no hay
`tx`, `$transaction`, `$queryRaw` ni `inventoryMovement` en su código. El diff de este archivo
(`git diff da8b624..HEAD -- packages/shared/src/schemas/production.ts`) es exclusivamente la
función de cálculo: no toca imports, no agrega dependencias nuevas.

Los tres llamadores de `mountedKgForReport` —`apps/api/src/production/production.service.ts:597`,
`apps/api/src/production/roofing-production.service.ts:982` y
`apps/api/src/production/roofing-drafts.ts:131`— **no cambiaron en este diff** (no aparecen en
`git diff --stat da8b624..HEAD`). El resultado de la función sigue usándose exactamente igual que
antes de D-249: como tope de `outKg` que después pasa a `allocateStripKg` y de ahí al kardex
dentro de la misma transacción Prisma que ya existía (por ejemplo,
`roofing-production.service.ts` alrededor de la línea 982 vive dentro del bloque que también
hace `tx.reservation.findUniqueOrThrow` y `tx.$queryRaw` unas líneas más abajo, es decir dentro
de un `tx` de transacción). D-249 cambia **cuánto** puede topar la función, no **quién** ni
**cuándo** se usa ese tope.

**`apps/api/src/reports/reports.service.ts` (M2/D-250).** El único método tocado por el diff usa
`this.prisma.$queryRaw` (línea 60) para un `SELECT` agregado; no hay ningún `$executeRaw`,
`update`, `create`, `delete` ni referencia a `inventoryMovement` en todo el archivo (`grep -n
"this.prisma\.\|\$queryRaw\|\$executeRaw" apps/api/src/reports/reports.service.ts` solo matchea
esa única línea). El cambio de D-250 es swap de una función de traducción
(`toPrismaLineCode`/`toSharedLineCode` → `fromDbLineCode`) sobre datos ya leídos; no agrega ni
quita ninguna consulta de escritura.

**Veredicto M2: correcto, sin hallazgo.** Ambos cambios son de cálculo puro / lectura. No hay
candidato a P0 por escritura de kardex fuera de transacción.

---

## Qué no se ejecutó en esta revisión

- El E2E de `e2e/tests/fase7-consolidada.spec.ts` (bloque `D-249 — el filtro por línea del
reporte mensual de bobinas`) se leyó línea por línea pero **no se corrió**: exige levantar el
  stack local (Postgres + API) y el encargo pedía confirmar M0 con los tests unitarios, no correr
  la suite completa. La lógica del test coincide con la reproducción documentada en
  `docs/PROGRESO.md` (11 filas sin filtro → 7 + 4 con filtro, suma exacta) y con el fix leído en
  `reports.service.ts`, pero queda sin ejecución real en esta sesión.
- No se tocó Neon ni ninguna base real, como pedía el encargo.

---

## Resumen de hallazgos

| id             | sev | dónde                                 | qué                                                                                                                                                                                                                                                                                                |
| -------------- | --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —              | —   | `production.ts:478-509`               | M0 verificado: tolerancia simétrica correcta en los 5 casos calculados a mano; sin hallazgo                                                                                                                                                                                                        |
| —              | —   | `mounted-kg.spec.ts` (bloque D-249)   | M1 verificado: los 3 tests nuevos fallan sin el fix y pasan con él; centinelas reales                                                                                                                                                                                                              |
| —              | —   | `reports.service.ts`, `production.ts` | M2 verificado: ambos cambios son cálculo puro / `SELECT`; ningún camino escribe kardex fuera de transacción                                                                                                                                                                                        |
| **P2-proceso** | P2  | `apps/api` + `packages/shared`        | `apps/api` resuelve `@ayr/shared` contra `dist/`, no `src/`; editar `src` sin `pnpm --filter @ayr/shared run build` produce falsos verdes/rojos en `jest` de `apps/api`. No es un defecto de este hotfix, pero conviene que el pase cruzado real lo tenga presente si repite el experimento de M1. |

Este hotfix **sigue pendiente de revisión por un agente distinto** del que lo implementó
(AGENTS.md §2.2). Esta autorrevisión reduce el riesgo de que M0/M1/M2 tengan un defecto grosero,
pero no sustituye ese pase.
