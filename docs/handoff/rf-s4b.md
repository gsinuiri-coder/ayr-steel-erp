# Handoff — RF-S4b: SKU canónico de bobina, pool de venta y el importe que manda (2026-09-23)

Agente: Claude Code. Rama `rf-s4b` desde `origin/main` `f60ab6c`. **Con migración aditiva.**
Nada tocó producción: la normalización, el barrido y las lecturas de prod quedan para la ventana,
con OK del dueño comando por comando (D-251).

## Qué quedó

|                 |                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Decisiones      | D-252 (SKU canónico), D-253 (unión), D-254 (R1, pool), D-255 (R2, importe), D-256 (D-163), D-257 |
| Migración       | `20260923180000_rf_s4b_products_merged_into` — columna nullable, índice, FK RESTRICT y un CHECK  |
| Herramientas    | `pnpm normalize:coil-skus`, `pnpm sweep:imported --file …` (dry-run por defecto las dos)         |
| Rutas nuevas    | `PATCH /sales/orders/:id/items/:itemId/coil`, `GET /sales/coil-pool`                             |
| Rutas cambiadas | `PATCH …/items/:itemId/price` acepta precio con IGV o importe de línea; el alta y la edición de  |
|                 | cotizaciones y pedidos aceptan `unitPriceWithIgvPen` y `netAmountPen` (ya no solo el importador) |
| Web             | importador con selector de bobina e importe editable; formulario manda precio con IGV o importe; |
|                 | diálogos de pedido con modo de precio y «Cambiar bobina»                                         |
| Guion UAT       | `docs/uat/rf-s4b.md`                                                                             |
| Autorrevisión   | `docs/revision/rf-s4b-autorrevision.md` — **no** vale como pase cruzado                          |

## Estado y calendario

- **PR:** [#14](https://github.com/gsinuiri-coder/ayr-steel-erp/pull/14), abierto hacia `main`,
  **sin mergear**.
- **CI:** verde, job por job y con el gate de Sonar (80.6 %); ver «CI del PR #14» más abajo.
- **Revisión independiente:** mañana (jueves 2026-09-24). Es el pase cruzado de AGENTS.md §2.2:
  lo que revisa el segundo revisor es esta rama entera, con foco en lo que ya señala
  `docs/revision/rf-s4b-autorrevision.md` (los P2 pendientes) y en la resolución bobina → producto
  y la derivación de importes. Sin ese pase la pieza sigue **PENDIENTE DE REVISIÓN INDEPENDIENTE**
  en `docs/PROGRESO.md`.
- **Ventana:** jueves 2026-09-24 por la noche, antes de la revisión del viernes. Necesita, en este
  orden: (1) CI verde incluido el gate de Sonar, (2) el pase cruzado sin P0/P1 abiertos, (3) tu OK
  a cada comando de producción (D-251).

## CI del PR #14

Última corrida, sobre `dd5ebd4` (todo verde):

| Job                                      | Resultado | Duración |
| ---------------------------------------- | --------- | -------- |
| Lint, typecheck y unit                   | pass      | 1m29s    |
| E2E Playwright (Postgres del runner)     | pass      | 15m22s   |
| Smoke E2E y migraciones (Neon `ci`)      | pass      | 25m53s   |
| Análisis estático (SonarCloud o Semgrep) | pass      | 1m14s    |
| SonarCloud Code Analysis (quality gate)  | pass      | 55s      |
| Vercel / Vercel Preview Comments         | pass      | —        |

- **Historia de la corrida.** La primera dio todo verde salvo el quality gate de Sonar (12.6 % de
  cobertura en código nuevo, exige ≥ 80 %), que **no era de infraestructura**. Se arregló en tres
  empujes: tests unitarios de los servicios sin cobertura (API 97.9 %), luego el mapeo de
  `@ayr/shared` a su fuente en jest, y por último la reescritura de rutas del lcov que el scanner
  no resolvía. Gate final: **80.6 %**. El E2E del runner pasó las tres veces.
- **Smoke con migración:** el job «Smoke E2E y migraciones (Neon `ci`)» aplica
  `20260923180000_rf_s4b_products_merged_into` sobre Neon `ci`. Es la primera prueba de la
  migración fuera de Docker local, y pasó.
- **Margen del gate: 0.6 puntos.** Cualquier cambio que agregue código sin cobertura antes de la
  ventana puede volver a ponerlo en rojo; conviene no tocar código de la rama salvo por hallazgos
  del pase cruzado, y correr `pnpm --filter @ayr/api test:cov` antes de cada empuje.

## Lo que el siguiente tiene que saber antes de tocar esto

1. **Una bobina no le pertenece a un producto.** El saldo vive en el kardex de la bobina y el
   `BOB…` de reventa se **deduce** de ella (espesor + color comercial o tipo). Todo lo que
   responde «qué producto vende esta bobina» pasa por `apps/api/src/sales/coil-sale-product.ts`.
   Si alguien vuelve a armar el SKU en otro lado, reabre D-168.
2. **Los cuatro decimales de `unit_price_pen` son de adorno.** El dato es el importe de la
   línea. Toda cuenta nueva que necesite el unitario usa `derivedUnitValue(qty, subtotal)`
   (diez decimales). Multiplicar el guardado por la cantidad es exactamente el defecto de
   FFA1-1355 (3.0508 × 3840 ≠ 11 715.254).
3. **Una línea del papel vende la cantidad del papel** sobre una bobina con saldo suficiente; el
   alta a mano sigue vendiendo el rollo entero (D-116). Lo decide `exactAmounts` (documento
   importado), no el formulario.
4. **Transición de SKU.** Hasta que corra la normalización en producción, la resolución acepta
   el canónico y el viejo. Después del execute, el viejo ya no existe en productos activos y la
   rama de respaldo solo sirve para lo heredado raro.
5. **El choque de base** solo se mira entre **prepintados** del mismo color comercial, por
   densidad. La línea de negocio no cuenta a propósito (`finishForCoil`).
6. **E2E y CLI.** Los specs de normalización y barrido corren la CLI real contra `local-e2e`;
   después de la CLI se abre un contexto HTTP nuevo, porque el viejo quedó ocioso ~2 min y su
   socket keep-alive moría con ECONNRESET (tres corridas seguidas, diagnóstico en el spec).

## Plan de la ventana (antes del viernes a la noche)

Cada paso con comando a la vista y OK del dueño (D-251). Orden de AGENTS.md §3 regla 11.

0. **[Agente] Antes del primer comando: `.env.setup` en el worktree** desde el que se corre la
   ventana, **sin mostrar su contenido**: `git check-ignore -q .env.setup && test -f .env.setup
&& echo presente`. Las CLI toman de ahí `ADMIN_EMAIL` y la conexión de Neon; un worktree
   nuevo no lo trae (el ensayo en demo se cortó por eso). Si falta, lo copia el dueño.
1. **[Dueño] Respaldo Neon** de `production`: rama `respaldo-pre-rf-s4b-AAAAMMDD` (patrón de
   `docs/ENTORNOS.md`, vía `scripts/lib.mjs#run` con `quiet: true` y `--output json`).
2. **[Agente] PR + CI verde** (PR #14; CI verde job por job sobre el SHA a desplegar).
3. **[Agente, con OK] Migración:** `node scripts/migrations-status.mjs --branch production`
   (tiene que listar solo `20260923180000_rf_s4b_products_merged_into`), `migrate diff` contra
   el drift conocido, y `pnpm db:prod`.
4. **[Agente, con OK] Deploy API** desde el worktree en el SHA a desplegar:
   `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   con `--update-labels git-sha=<sha>`; verificar `/health` y el label. La API nueva es
   compatible con el web viejo (el formulario viejo sigue mandando `unitPricePen`; una fila de
   bobina del importador viejo queda bloqueada en el preview, que es lo correcto).
5. **[Agente, con OK] Smoke de solo lectura de la API nueva, ANTES de cualquier execute**
   (revisión cruzada P1-4): `pnpm smoke:prod`, desde el worktree en el SHA desplegado. Pasa por
   el web viejo, que llama a la API nueva, y solo hace GET. Si falla, se vuelve la API al SHA
   anterior **ahora**: todavía no hay nada que deshacer.
6. **[Agente] Dry-runs contra production, solo lectura, con OK:**
   - Las dos CLI imprimen al arrancar `Salidas externas: cola … apagado · PSE … apagado · R2
apagado` (D-259). Si alguna dice ENCENDIDO, abortan solas.
   - `pnpm normalize:coil-skus --branch production` → el dueño ve renombres, uniones, no
     interpretables, documentos abiertos, kilos antes/después y paradas (incluida «producto a
     unir con saldo propio», que ahora se ve acá y no recién en el execute).
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production` →
     listas (a), (b) y (c). Cada hallazgo muestra `SKU actual → SKU nuevo (papel: …)` (D-258):
     **revisar que el SKU del papel sea el de la línea** en cada (a) y (b).
   - **Anotar los totales** de Inventario valorizado y Ventas y margen (agosto) antes del execute.
7. **[Agente, con OK explícito por cada uno] Execute — PUNTO CRÍTICO:**
   - `pnpm normalize:coil-skus --branch production --execute --confirm-production` (más
     `--ack-open-documents` solo si el dueño aprobó la lista de abiertos). **Desde acá, volver la
     API al SHA anterior no es seguro sin deshacer antes la normalización**: la API vieja busca
     el SKU viejo, y toda venta de bobina rebotaría.
   - Comprobar los totales de los dos reportes contra lo anotado. **Plan B** si no cuadran o algo
     falla: `pnpm normalize:coil-skus --branch production --revert` (dry-run: lista los pasos en
     orden inverso y las paradas), y con OK `… --revert --execute --confirm-production` (D-260).
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production
--execute --confirm-production`. Dry-run y execute uno detrás del otro, sin nadie usando
     el sistema: el execute recalcula el plan (P2-4 de la revisión, no corregido).
   - Comprobar que los totales de los dos reportes siguen siendo los anotados.
8. **[Dueño] Merge a `main`** (D-232, `AYR_OWNER_PUSH=1`) → Vercel publica el web.
9. **[Agente] `pnpm smoke:prod`** desde un worktree en el SHA desplegado.
10. **[Dueño] COT-000002**: confirmarla; tiene que reservar SALDO-ALZ-AZUL-5002-0.38-4194-7 y
    cuadrar 14 679.00. Y el pedido de FFA1-1355, si sigue abierto, facturable con el importe del
    papel.

**Rollback.**

- Antes del execute de la normalización: la migración es aditiva, así que alcanza con volver la
  API al SHA anterior; no hace falta revertir la migración.
- Después del execute: primero `normalize:coil-skus --revert` (D-260), y recién entonces se
  vuelve la API al SHA anterior. La rama de respaldo queda como último recurso, porque restaurarla
  pierde todo lo cargado después.
- Lo que corrigió el barrido no se revierte con una herramienta: son ediciones de documentos
  abiertos, auditadas con su motivo, y se deshacen desde la pantalla, documento por documento.

## Verificación

- Unitarios: API 929/929, web 11/11. `pnpm lint`, `pnpm typecheck`, `prettier --check` verdes.
- **SonarCloud:** el gate falló en el primer push (12.6 % de cobertura en código nuevo, exige
  ≥ 80 %). Se cubrió la API con unitarios (97.9 %), y luego se descubrió que Sonar no resolvía las
  rutas de `packages/shared` del lcov (ver PROGRESO). Con las dos correcciones el gate pasó con
  **80.6 %** — margen corto.
- E2E completo con builds de producción: 331/36/2/20 en la primera corrida; todo rojo
  clasificado (infraestructura del runner local salvo dos, corregidos). Re-corrida de los rojos y
  del tramo sin correr: 80/2/1, los dos explicados. Detalle en `docs/PROGRESO.md`.
- **CI del PR #14** (R2 y PSE reales incluidos): verde; ver «CI del PR #14».

## Lo que queda pendiente

- **Pase cruzado independiente** (AGENTS.md §2.2) — registrado en `PROGRESO.md`.
- Pendientes del dueño sin implementar: bobina 3020 en OP ROJO (D-252); pool real de kg con
  despacho multi-bobina (D-254).
- M3: el render de la vista de margen — **requiere decidir D-011** (el dueño pidió no agregar
  jsdom ni testing-library).
- Autorrevisión: pendientes P2 listados en `docs/revision/rf-s4b-autorrevision.md`.
- E2E nuevos para la UI del selector de bobina del importador, el importe editable, el modo de
  precio del pedido y «Cambiar bobina»: la cobertura de hoy es por API.
- Limpiar el worktree del subagente web (`.claude/worktrees/agent-…`) y su rama local al cerrar.

## Secuencia de commits

`0338d47` test M0 → `a4abe3c` feat R1/R2 base → `1411c11` feat unión, normalización y barrido →
`ab9eae7`/`987c0e2`/`e9cafe4` web → `cedcdff` test E2E → `f0f6d58` merge web → `1268c39` estilo
→ `5084f80` M3 → docs.
