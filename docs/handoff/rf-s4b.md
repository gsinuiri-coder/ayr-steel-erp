# Handoff — RF-S4b: SKU canónico de bobina, pool de venta y el importe que manda (2026-09-23)

Agente: Claude Code. Rama `rf-s4b` desde `origin/main` `f60ab6c`. **Con migración aditiva.**
Nada tocó producción: la normalización, el barrido y las lecturas de prod quedan para la ventana,
con OK del dueño comando por comando (D-251).

## Qué quedó

|                 |                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Decisiones      | D-252..D-257; después de la revisión, la aclaración de D-256 (por rol) y D-258..D-260            |
| Migración       | `20260923180000_rf_s4b_products_merged_into` — columna nullable, índice, FK RESTRICT y un CHECK  |
| Herramientas    | `pnpm normalize:coil-skus`, `pnpm sweep:imported --file …` (dry-run por defecto las dos)         |
| Rutas nuevas    | `PATCH /sales/orders/:id/items/:itemId/coil`, `GET /sales/coil-pool`                             |
| Rutas cambiadas | `PATCH …/items/:itemId/price` acepta precio con IGV o importe de línea; el alta y la edición de  |
|                 | cotizaciones y pedidos aceptan `unitPriceWithIgvPen` y `netAmountPen` (ya no solo el importador) |
| Web             | importador con selector de bobina e importe editable; formulario manda precio con IGV o importe; |
|                 | diálogos de pedido con modo de precio y «Cambiar bobina»                                         |
| Guion UAT       | `docs/uat/rf-s4b.md`                                                                             |
| Autorrevisión   | `docs/revision/rf-s4b-autorrevision.md` — **no** vale como pase cruzado                          |

## Estado y calendario (actualizado 2026-09-24)

- **PR:** [#14](https://github.com/gsinuiri-coder/ayr-steel-erp/pull/14), abierto hacia `main`,
  **sin mergear**. **SHA de runtime a desplegar: `e247f40`.** Lo que venga después es solo
  documentación.
- **Revisiones:**
  - Pase cruzado: `docs/revision/rf-s4b-cruzada.md`. Tenía 4 P1; los cuatro están corregidos,
    con tests que fallan contra el código anterior.
  - Repaso del delta: `docs/revision/rf-s4b-repaso.md`. P1-A (cobertura: el gate pasa) y P1-B
    (`ask` y `--confirm-production`, D-261) corregidos.
  - Todas las sesiones fueron de Claude Code: sigue **PENDIENTE DE REVISIÓN INDEPENDIENTE** en
    `PROGRESO.md`.
- **Ensayo en demo:** completo. Resultados y defectos encontrados en `PROGRESO.md`; listas en
  `local-data/rf-s4b/ensayo-demo/`.
- **Ventana: esta noche (jueves 2026-09-24), en una sesión nueva.** Condiciones:
  1. CI verde job por job sobre `e247f40`, incluidos el E2E, el smoke de Neon `ci` y el gate de
     Sonar (ver «CI del PR #14»).
  2. OK del dueño a cada comando de producción (D-251). Los comandos de las CLI de dominio están
     en el `ask` de `.claude/settings.json`.

### Decidido: el IGV del papel con más decimales que el total (D-255, opción A)

El export trae, para FFA1-1350: valor 12 439.831, IGV 2 239.16958 y precio de venta 14 679.000.
Si valor + IGV − total está a S/ 0.01 o menos, se guardan el total del papel, el valor
redondeado a dos decimales y el IGV como la resta, siempre que ese IGV quede a S/ 0.01 o menos
del 18 %. FFA1-1350 → **12 439.83 / 2 239.17 / 14 679.00**.

## CI del PR #14

Sobre `e247f40` (run 35955313518), **todo verde**:

| Job                                      | Resultado | Duración | Detalle                              |
| ---------------------------------------- | --------- | -------- | ------------------------------------ |
| Lint, typecheck y unit                   | pass      | 1m48s    |                                      |
| E2E Playwright (Postgres del runner)     | pass      | 15m01s   | 390 passed, 3 skipped, 0 flaky       |
| Smoke E2E y migraciones (Neon `ci`)      | pass      | 25m25s   | aplica la migración de RF-S4b        |
| Análisis estático (SonarCloud o Semgrep) | pass      | 1m20s    |                                      |
| SonarCloud Code Analysis (quality gate)  | pass      | —        | gate de cobertura en código nuevo ok |
| Vercel / Vercel Preview Comments         | pass      | —        |                                      |

- Historia: `dd5ebd4` todo verde con el gate al 80.6 %; `6f82c31` y `73510e3` con el gate en
  79.3 % (repaso P1-A).
- `9b723cd`: gate de Sonar en **verde**, pero un rojo de producto en el E2E (el spec de D-153
  tipeaba la marca que D-256.3 prohíbe, corregido en `e247f40`) y un flaky de `ECONNRESET`.
- Código nuevo del PR en API + shared: **96.1 %** de líneas, medido en local.

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
   importado), no el formulario, y desde la aclaración de D-256 **solo** para el ADMINISTRADOR o
   para la línea que sigue intacta (`paperLines`).
4. **Las CLI de dominio** corren con cola, PSE, R2 y Nubefact apagados y un `JWT_SECRET` al azar
   (D-259). Imprimen el destino y las banderas; si falla el arranque, ahora lo dicen.
5. **Transición de SKU.** Hasta que corra la normalización en producción, la resolución acepta
   el canónico y el viejo. Después del execute, el viejo ya no existe en productos activos y la
   rama de respaldo solo sirve para lo heredado raro.
6. **El choque de base** solo se mira entre **prepintados** del mismo color comercial, por
   densidad. La línea de negocio no cuenta a propósito (`finishForCoil`).
7. **E2E y CLI.** Los specs de normalización y barrido corren la CLI real contra `local-e2e`;
   después de la CLI se abre un contexto HTTP nuevo, porque el viejo quedó ocioso ~2 min y su
   socket keep-alive moría con ECONNRESET (tres corridas seguidas, diagnóstico en el spec).

## Plan de la ventana (jueves 2026-09-24 por la noche)

Cada paso con comando a la vista y OK del dueño (D-251). Orden de AGENTS.md §3 regla 11.

0. **[Agente] Antes del primer comando: `.env.setup` en el worktree** desde el que se corre la
   ventana, **sin mostrar su contenido**: `git check-ignore -q .env.setup && test -f .env.setup
&& echo presente`. Las CLI toman de ahí `ADMIN_EMAIL` y la conexión de Neon; un worktree
   nuevo no lo trae (el ensayo en demo se cortó por eso). Si falta, lo copia el dueño.
1. **[Dueño] Respaldo Neon** de `production`: rama `respaldo-pre-rf-s4b-AAAAMMDD` (patrón de
   `docs/ENTORNOS.md`, vía `scripts/lib.mjs#run` con `quiet: true` y `--output json`).
2. **[Agente] PR + CI verde** (PR #14; CI verde job por job sobre el SHA a desplegar).
3. **[Agente, con OK] Migración** (en demo, con el seed, tardó 48 s): `node scripts/migrations-status.mjs --branch production`
   (tiene que listar solo `20260923180000_rf_s4b_products_merged_into`), `migrate diff` contra
   el drift conocido, y `pnpm db:prod` (desde D-262, solo `migrate deploy`; el seed exige
   `--with-seed` y en esta ventana no se corre).
4. **[Agente, con OK] Deploy API** desde el worktree en el SHA a desplegar:
   `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   desde el SHA `e247f40`
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
   - **Todas** las corridas contra production llevan `--confirm-production`, también los dry-runs
     (D-261): sin la bandera, el wrapper y la CLI se niegan.
   - `pnpm normalize:coil-skus --branch production --confirm-production` → el dueño ve renombres, uniones, no
     interpretables, documentos abiertos, kilos antes/después y paradas (incluida «producto a
     unir con saldo propio», que ahora se ve acá y no recién en el execute).
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production
--confirm-production` →
     listas (a), (b) y (c). Cada hallazgo muestra `SKU actual → SKU nuevo (papel: …)` (D-258):
     **revisar que el SKU del papel sea el de la línea** en cada (a) y (b). **Parar si falla
     cualquiera de estas dos verificaciones:** que cada (b) de un documento abierto difiera
     solo en céntimos (lo que no, o lo que tiene una edición de precio registrada, ya va solo a
     (c)), y que ningún comprobante aparezca en dos documentos abiertos (repaso P2-2).
     **Tamaño esperado con el trío de D-255 normalizado (opción A del dueño):** en demo, copia
     de production del 2026-09-24, (b) tiene 108 documentos, porque casi todo el export trae el
     valor con 3 decimales. El execute corrige solo los **36 abiertos** (27 cotizaciones y 9
     pedidos, 92 líneas); la diferencia máxima es S/ 0.005 en el valor y S/ 0.003 en el total.
     **Criterio exacto:** el dry-run de production tiene que dar lo mismo que demo: **36
     documentos abiertos en (b) (27 cotizaciones y 9 pedidos, 92 líneas), ninguna diferencia
     mayor a S/ 0.01 y ningún comprobante en dos documentos**. Cualquier diferencia con esos
     números se explica documento por documento antes del execute; si no se puede explicar,
     **se para**. En demo, con la copia de producción del
     2026-09-24: (a) 3, (b) 2 (las dos anuladas), (c) 0, sobre 113 documentos importados.
   - **Anotar los totales** de Inventario valorizado y Ventas y margen (agosto) antes del execute.
7. **[Agente, con OK explícito por cada uno] Execute — PUNTO CRÍTICO:**
   - `pnpm normalize:coil-skus --branch production --execute --confirm-production` (más
     `--ack-open-documents` solo si el dueño aprobó la lista de abiertos). **Desde acá, volver la
     API al SHA anterior no es seguro sin deshacer antes la normalización**: la API vieja busca
     el SKU viejo, y toda venta de bobina rebotaría.
   - Comprobar los totales de los dos reportes contra lo anotado. **Plan B** si no cuadran o algo
     falla: `pnpm normalize:coil-skus --branch production --revert` (dry-run: lista los pasos en
     orden inverso y las paradas), y con OK `… --revert --execute --confirm-production` (D-260).
     **Solo dentro de la ventana, antes de reabrir el sistema (D-261).** Después, la corrección
     es hacia adelante. En demo tardó 44 s y dejó el catálogo `BOB…` idéntico a la línea base.
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production
--execute --confirm-production`. Dry-run y execute uno detrás del otro, sin nadie usando
     el sistema: el execute recalcula el plan (P2-4 de la revisión, no corregido).
   - Comprobar que los totales de los dos reportes siguen siendo los anotados.
   - Tiempos en demo, como referencia: normalize execute 54 s y sweep execute 71 s. Contra
     production se espera algo parecido: el volumen es el mismo, porque demo es su copia.
8. **[Dueño] Merge a `main`** (D-232, `AYR_OWNER_PUSH=1`) → Vercel publica el web.
9. **[Agente] `pnpm smoke:prod`** desde un worktree en el SHA desplegado.
10. **[Dueño] COT-000002**: confirmarla; tiene que reservar SALDO-ALZ-AZUL-5002-0.38-4194-7 y
    cuadrar 14 679.00. **Depende de la decisión sobre el trío del papel** (ver «Pendiente de
    decisión»): sin ella, reserva la bobina correcta pero queda en 14 679.0006. En demo se
    confirmó (PED-000042) y reservó la bobina. COT-000011 (FFA1-1355) se ata sola a
    SALDO-ALZ-ROJO-3020-0.38-3840-12.

**Rollback.**

- **Registro de la ventana (2026-09-24), ya vencido:** la API anterior era
  `ayr-steel-erp-api-00042-tdb` (`git-sha=0e1124b`). Antes del execute de normalize, el rollback
  exacto era `cmd /c gcloud run services update-traffic ayr-steel-erp-api --project
ayr-steel-erp --region us-central1 --to-revisions ayr-steel-erp-api-00042-tdb=100`. El
  execute terminó a las 00:37 Lima; desde ahí ese comando solo vale después de `--revert`, y
  después de reabrir el sistema ya no vale (D-261). Resultado de la ventana en
  `docs/handoff/ventana-rf-s4b.md`.

- Antes del execute de la normalización: la migración es aditiva, así que alcanza con volver la
  API al SHA anterior; no hace falta revertir la migración.
- Después del execute y **antes de reabrir el sistema**: primero `normalize:coil-skus --revert`
  (D-260), y recién entonces se vuelve la API al SHA anterior. Después de reabrir, la corrección
  es hacia adelante (D-261). La rama de respaldo queda como último recurso, porque restaurarla
  pierde todo lo cargado después.
- Lo que corrigió el barrido no se revierte con una herramienta: son ediciones de documentos
  abiertos, auditadas con su motivo, y se deshacen desde la pantalla, documento por documento.

## Verificación

**Correcciones del 2026-09-24:** API 976/976, web 11/11, scripts 8/8, y lint, typecheck y
formato en verde. Código nuevo del PR (API + shared) al 94.4 %. E2E de los caminos tocados: 20
pasaron y 1 se omitió (PSE, infraestructura); aparte, D-256 3/3 y la normalización con ida y vuelta
1/1. Ensayo completo en demo (ver PROGRESO).

**Primera entrega (2026-09-23):**

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

- **Revisión por un revisor que no sea Claude Code** (AGENTS.md §2.2): registrada en
  `PROGRESO.md`, junto con los commits posteriores al repaso, que ningún pase miró.
- Repaso P2-4 (pool por documento, no por línea) y P2-7 (`import:initial-inventory` sin el
  apagado de salidas): anotados, no corregidos.
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

Correcciones del 2026-09-24: `2455291` informe cruzado → `f111e3b` permisos de lectura →
`d2e2fde` WIP → `a719f8e` D-256 por rol, pool en el servidor y barrido sin posición → `5f5b320`
CLI sin salidas externas → `c09984a` `--revert` → `59ef1d5` P2 baratos → `242bc34` docs →
`6f82c31`/`73510e3` reset de demo con guard → `c8648f6` CLI contra Neon → `3d15ad8` lo cerrado no
compite → timeout de la edición de cotizaciones → `0aba633` quita el script de un solo uso →
cherry-pick del repaso → `eeac84b` hallazgos del repaso → docs.
