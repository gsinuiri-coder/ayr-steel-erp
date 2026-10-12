# Ventana cc46 — Mantenimiento: hooks de React, borde del partido con costo y objetos de base

2026-10-11, sesión atendida en modo continuo. Ventana suspendida (D-533). Sin migraciones, sin SQL
contra producción. D-606 a D-611 nuevas, provisionales hasta que el dueño las ratifique.
D-603 a D-605 (cc45) ratificadas por el dueño el 2026-10-11.

## En producción

| Corte | Qué                                                               | Resultado                                                                                                      |
| ----- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A     | merge de PR #178 (`49e85067`), solo web                           | Vercel en verde; `smoke:prod` verde en los dos dominios                                                        |
| B     | `pnpm deploy:api` desde `6cb372ce`; merge de PR #179 (`be5bb78f`) | API `00117-7pm` (`git-sha=6cb372ce`), 100 %; `smoke:prod` verde antes y después del merge, en los dos dominios |
| C     | merge de PR #180 (`87abfc3a`), solo un script                     | sin deploy (no cambia el runtime)                                                                              |

- Vuelta atrás de la API: tráfico a `00116-hfd` (y revertir el merge de #179).
- `git diff --quiet 6cb372ce origin/main -- apps packages Dockerfile …` → exit 0 tras el merge de B.
  Después de C, `main` solo suma `scripts/` y `package.json` (un script nuevo): el label queda
  detrás por tooling, como en cc43.

## Qué entró

| Pieza                                  | Decisión     | Dónde                                                                                                                                                                    |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hooks de React como error en el lint   | D-606        | `packages/eslint-config/next.mjs`                                                                                                                                        |
| 14 hallazgos de `exhaustive-deps`      | D-607        | planta (`planta-view`, `produce-accessory`, `use-block-drafts`, `plan-adjust-dialog`), despacho, comprobante, compras e importar cotizaciones, reportes, `use-url-state` |
| Kerf y borde del partido en las hijas  | D-608        | `coil-split-math.ts` (`splitChildrenCosts`), `coil-operations.service.ts` (`split`, recosteo en `update`), `coils.service.ts`                                            |
| Diagnóstico de partidos                | D-609        | `pnpm inspect:cc46` (`apps/api/prisma/inspect-cc46-cli.ts`)                                                                                                              |
| Objetos de base contra las migraciones | D-610, D-611 | `pnpm check:drift:objetos` (`scripts/check-drift-objetos.mjs`), `docs/analisis/drift-objetos.md`                                                                         |
| Escenario                              | —            | `seed:escenarios`: S1 (partido con borde); se revierte antes de los cortes y las compras                                                                                 |

**Ejemplo (datos inventados):** bobina de 2 000 kg y 1 220 mm a S/ 4,1234, partida en 600 + 560 mm
con 20 mm de kerf: salen S/ 8 246,80; antes las hijas valían S/ 7 841,22 y se perdían S/ 405,58,
ahora suman S/ 8 246,80 (≈ S/ 4,3367 el kg). Detalle en `docs/DECISIONES.md` (cc46).

## Paso 0 (solo lectura)

- **Partidos en producción:** `pnpm inspect:cc46 --branch production --confirm-production` →
  **ninguno**, en ningún estado. Nada que reparar ni reportar (D-609).
- **Lint en modo informe:** `rules-of-hooks` 0, `exhaustive-deps` 14 (todos corregidos, sin
  `eslint-disable`); reglas del React Compiler 67 (fuera, D-606).
- **Observación del hotfix de cc38** (teclas en Producir con la página recién compilada): el lint
  no señaló nada en el camino de coberturas (`produce-blocks.tsx`); no la explica y sigue abierta.

## Pruebas

- **Corte A:** lint, typecheck y 314 unitarios de la web; recorrido en el navegador (web del corte
  en 3011 contra `ayr_local`): Producir de coberturas y de accesorio, «Ajustar el plan» y Nuevo
  despacho, con la pestaña de red. Una tanda de peticiones por carga, ninguna en reposo, un `POST`
  del borrador por edición; el diálogo no pisa lo escrito.
- **Corte B:** db-spec `coil-split-kerf-cost.db-spec.ts` (con borde, sin borde, redondeo con
  empate, USD, reversa, valorizado, recosteo) y `cutting-kerf-cost` (11/11); `test:db` completo
  (9 suites, 107); unitarios `coil-split-cost.spec.ts` (base falsa) y `splitChildrenCosts`; 3 068
  unitarios del API con el centinela del kardex; `seed:escenarios:test` dos corridas con S1; E2E
  `fase2b` adaptado a D-608 (4,2069 y 6 206,8973 + 5 793,1027).
- **Corte C:** 10 unitarios en `test:scripts`; dos corridas contra producción (la segunda,
  estricta): sin diferencias.
- **Suite E2E local completa** con builds de producción (`CI=true`, base `ayr_local_e2e_cc46`,
  sobre `6cb372ce`): **590 passed, 19 failed, 2 flaky, 2 skipped** (1,1 h). 17 rojos son de
  entorno, los mismos de cc44/cc45: emisión sin PSE («Emisión electrónica no habilitada»), PDF y
  XML sin R2, y los CLI que buscan `local-e2e` (inventario inicial, normalización, barrido,
  purga). Los otros 2 (`venta-bobina-modal-d282`, `refechar-despacho-d288`) pasan solos (4/4) y en
  la CI: efecto del orden en la corrida larga. La CI pasó la suite entera en los tres PR.
- Una primera corrida local se cayó a mitad (la API dejó de responder) porque un `test:db` corrió
  contra la misma base; se repitió sola y `test:db` pasó a una base propia
  (`ayr_local_e2e_cc46db`).

## Revisión

Autorrevisión (subagente sin el handoff) y segundo modelo Sonnet por corte
(`docs/revision/cc46-a-segundo-modelo.md`, `cc46-b-…`, `cc46-c-…`): sin P0.

- **A:** P2 (el `range` heredado volvía a traducirse con un `replace` intermedio) y P3 corregidos.
- **B:** P2 (recosteo sin cambio de costo perdía céntimos del reparto; valorizado dependiente de la
  base entera) y P3 (cero silencioso, campo muerto, medida del diagnóstico, orden de anulación en
  `seed:escenarios`) corregidos. La CI pidió además cobertura y menos duplicación (Sonar): el costo
  de las hijas salió a una función pura con unitarios.
- **C:** P1 (la normalización en minúsculas ocultaba `'ACTIVE'` contra `'Active'`; un trigger
  deshabilitado no se veía) y P2 (`classid`, arranque del contenedor, `maxWait`) corregidos.

## Fuera de alcance / para la próxima sesión

- D-606 a D-611 pendientes de ratificación.
- Riesgo aceptado (UAT §2.5): bajar a mano el costo de una hija a la cifra de la factura quita el
  valor del kerf y el borde (D-045).
- `check:drift:objetos` no cubre vistas materializadas, reglas, RLS, triggers de evento, enums,
  defaults, permisos ni dueños.
- Las 67 reglas del React Compiler, si alguna vez se quieren, son otra pieza.
- `seed:escenarios` corrido en el `ayr_local` del dueño (S1 listo para el UAT); `dev:preview` del
  dueño sigue en 4000/4001 sin tocar.
- Neon: sin ramas nuevas (siguen 7 de 10).
