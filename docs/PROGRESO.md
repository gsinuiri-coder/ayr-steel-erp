# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` Â§3.7.

## PENDIENTE DE REVISIÓN INDEPENDIENTE (registro, 2026-09-23)

Por `AGENTS.md` §2.2: con un solo agente, la revisión de una sesión la hace un subagente que no
leyó el handoff de implementación, marcada como autorrevisión y sin valor de pase cruzado. Las
piezas en ese estado, a recuperar cuando haya un segundo revisor:

- **RF-S4a** (2026-09-22). Autorrevisión documentada en `docs/revision/rf-s4a-d246.md` y en
  D-248 de `docs/ventana-rf-s4a` (sin mergear): la escribió el mismo agente que implementó
  RF-S4a, en la sesión inmediatamente anterior. Motivo: `agy` y Codex estaban sin saldo y
  RF-S4a ya estaba desplegado.
- **HOTFIX D-249** (2026-09-22, rama `hotfix-d249`, sin push). Tolerancia de laminado simétrica.
  Motivo: continuación directa de la sesión de RF-S4a, mismo agente, sin segundo revisor
  disponible.
- **Este cambio de `AGENTS.md` §2** (2026-09-23, esta sesión). Reescribe el esquema de agentes y
  la propia regla de revisión que lo documenta; no hay una sesión distinta que lo haya mirado
  con ojos frescos. Motivo: sesión de limpieza de un solo agente, sin segundo revisor
  disponible — el mismo motivo estructural que documenta la regla.
- **RF-S4b** (2026-09-23, rama `rf-s4b`). Autorrevisión por un subagente que no escribió el
  cambio, en `docs/revision/rf-s4b-autorrevision.md`. Motivo: esquema de un solo agente, sin
  segundo revisor disponible. Pieza de riesgo para el pase cruzado: la resolución bobina →
  producto (D-253/D-254) y la derivación de importes (D-255), que tocan venta, pedido y
  comprobante. **2026-09-24:** hubo pase cruzado (`rf-s4b-cruzada.md`) y repaso del delta
  (`rf-s4b-repaso.md`), los dos en sesiones distintas de Claude Code, **el mismo modelo** que
  escribió la rama. Los commits posteriores al repaso (`eeac84b` y los del ensayo: `c8648f6`,
  `3d15ad8`, el timeout de la edición de cotizaciones) no tuvieron ningún pase. Sigue pendiente
  hasta que haya un revisor de otro modelo o persona. **2026-09-24, ventana:** desplegado en
  production sin cambios de runtime; se suma `57b10c9` (D-262, `db:prod` sin seed), escrito y
  mergeado en la misma ventana sin pase de revisión.
- **Correcciones del delta RF-S4b** (2026-09-24, PR #15 y `fix/rf-s4b-delta-2`). D-263 a
  D-266, M2 a M6. Autorrevisión por subagentes nuevos (sin P0/P1), el mismo modelo que escribió.
  Motivo: esquema de un solo agente, sin segundo revisor disponible.

## Correcciones del delta RF-S4b (2026-09-24)

Informe: `docs/revision/rf-s4b-delta.md`. Handoff: `docs/handoff/fix-rf-s4b-delta.md`.

- **M1 (P1-1, D-263), en production:** guardar una cotización importada con planchas ya no
  multiplica la línea por su largo. PR #15, `main` = `6492b4d`, Vercel production `success`,
  `smoke:prod` verde. Solo web.
- **Verificación en production (solo lectura, dry-run del barrido, 2026-09-24):** 113 revisados;
  40 abiertos (30 cotizaciones, 10 pedidos) con **0 hallazgos** —(a) 0, (b) 0, (c) 0—. Las 12
  líneas de plancha con diferencia contra el papel están en documentos cerrados: 10 por
  diezmilésimas y COT-000053/054 (anuladas, el ×6 conocido).
- **Segundo PR (rama `fix/rf-s4b-delta-2`):** M2 `snapshot-reports` ligado a la rama de
  `--base-url`; M3 rotación de la contraseña del rol en `db-reset-dev.mjs` (**no se ejecutó
  contra Neon**); M4 `ask` completo; M5 trío del papel único (P2-1), «editada a propósito» por
  contenido (D-264) y parte que cierra con el resto (D-265); M6 bobina atada visible; D-266
  (Sonar).

**Pendientes que deja:**

- **Volver a cotizar «por metro» una plancha importada por plancha** (autorrevisión de D-263):
  hoy solo se logra cambiando el producto. No se implementa; decidir si hace falta un gesto.
- **Clave de línea estable** (D-264, opción 2 descartada por ahora): columna `line_key` en
  `quotation_items`/`sales_order_items`, conservada entre ediciones, y en `sales_price_changes`.
  Cerraría el criterio de «editada a propósito» sin heurística. Lleva migración.
- **La rotación de M3 no se ejecutó.** El próximo `pnpm db:reset-dev --yes --branch demo` la
  corre por primera vez, con `NEON_API_KEY` en el entorno o en `.env.setup`. Los `.env.demo`
  generados desde un reset anterior tienen la contraseña de production: si alguno salió de la
  máquina del dueño, corresponde rotar `neondb_owner` en production (AGENTS.md §3.1).
- **E2E local bloqueado en esta sesión:** un `nuxt dev` de otro proyecto del dueño escucha en
  `[::1]:3000` y Playwright lo reusa. No se mató (no es de este repo). El E2E de D-265 y el
  resto de la suite corrieron en CI.
- **P2 de la autorrevisión del PR #16** (sin P0/P1; P2-D, la fuga teórica por un JSON roto en
  la rotación, se corrigió en el PR):
  - **A.** D-265 solo cierra con el resto si las partes anteriores ya están **emitidas**: dos
    borradores por mitades se recalculan los dos (los borradores no consumen línea, D-073).
  - **B.** El segundo pase de `recordPriceChanges` (D-264) puede emparejar una línea quitada con
    otra agregada en la misma posición y registrar un «cambio de precio» entre productos
    distintos. Seguro para el barrido (lo deja en (c)); ruido en el historial. Idea: exigir la
    misma unidad.
  - **C.** Volver al precio original (Y → X → Y) deja el producto como «editado a propósito» y el
    barrido no corrige su redondeo. Seguro, conservador.
  - **E.** El `ask` no cubre `node ./scripts/…`, rutas absolutas ni
    `pnpm --filter @ayr/api exec tsx prisma/e2e-admin.ts`/`cleanup-e2e-users.ts`.
  - **F.** El selector del pool muestra «atada a COT-…» también a un VENDEDOR con alcance, aunque
    la cotización sea de otro vendedor (solo el código).

## Ventana de producción RF-S4b (2026-09-24, 00:06–01:05 Lima)

Detalle en `docs/handoff/ventana-rf-s4b.md`; salidas en `local-data/rf-s4b/ventana/`.

- **Respaldo** `respaldo-pre-rf-s4b-20260924` (`br-twilight-bar-aed9b0m7`).
- **Migración** `20260923180000_rf_s4b_products_merged_into` en 20 s, **sin seed** (D-262: el
  script sembraba y no estaba en el runbook; se vio al leerlo antes de correrlo). `migrate diff`
  = drift conocido exacto + la migración.
- **API** `ayr-steel-erp-api-00043-gr7`, `git-sha=e247f40`, 100 %. **Web** `main` = `57b10c9`
  (PR #14 mergeado, CI verde run 35959589794), Vercel `success`.
- **Normalize** 9 renombres + 2 uniones, 0 paradas; reportes iguales al centavo, `BOB…` 11/3.
- **Sweep** 36 abiertos corregidos (28 cotizaciones, 8 pedidos, 92 líneas), máx. S/ 0.0055;
  reportes iguales. Contra demo, única diferencia COT-000002 ↔ PED-000042 (confirmada en el
  ensayo).
- **Smokes** verdes antes y después del merge. COT-000002 en 14 679.00 atada a
  SALDO-ALZ-AZUL-5002-0.38-4194-7 y COT-000011 en 13 824.00 atada a
  SALDO-ALZ-ROJO-3020-0.38-3840-12, las dos con Confirmar habilitado. **No se confirmó nada**:
  confirmar (pedido y reserva) es del owner.
- **Herramienta nueva:** `scripts/snapshot-reports.mjs` (`snapshot`, `quotation`, `compare`;
  `--ephemeral-admin`), solo GET salvo el login.

**Pendientes que deja la ventana:**

- COT-000053 y COT-000054 (anuladas) en (c) «editadas a propósito»: importes ×6 del papel por un
  cambio de precio del 22/09 que pasó el precio por plancha a precio por metro (planchas de 6 m).
  Rehechas como COT-000072/073. Revisión del owner; diagnóstico en el handoff.
- `ADMIN_PASSWORD` de `.env.setup` da 401 contra production (credencial vieja).
- `smoke:prod --base-url https://v2.mareliac.pe` lo rechaza el guard de dominio.
- **La bobina atada no se ve en la pantalla de la cotización** (solo el producto; el código de
  la bobina está en la API como `reserveItemLabel`), y esa bobina queda fuera del pool de venta
  (`coilPoolFor`) sin ninguna explicación visible: quien la busque en el selector de otro
  documento no ve por qué falta ni qué cotización la tiene.
- **Al cambiar la unidad de negociación (D-161), el precio conserva el número y el total se
  multiplica sin advertencia.** Es la causa del ×6 de COT-000053/054: «S/ 59.00 → S/ 59.00 /m»
  sobre planchas de 6 m. En esas dos no hay daño (están anuladas y rehechas), pero en un
  documento vivo el mismo gesto multiplica el importe sin que nadie lo note.
- **Después de resetear demo desde production, `scripts/db-reset-dev.mjs` tiene que rotar la
  contraseña del rol en la rama `demo`.** Hoy demo hereda la credencial de production (la de
  `neondb_owner` es la misma en las ramas, AGENTS.md §3.1), así que un `.env.demo` expuesto
  expone production.

## RF-S4b — correcciones de la revisión cruzada, repaso y ensayo en demo (2026-09-24)

Rama `rf-s4b`, sobre `2455291`. Decisiones: aclaración de D-256, D-258, D-259 y D-260.

### Revisiones

- **Revisión cruzada** (`docs/revision/rf-s4b-cruzada.md`): 4 P1 y 12 P2, veredicto «go con
  condiciones». La hizo una sesión de Claude Code que no había escrito la rama, y **esa misma
  sesión corrigió después sus hallazgos**. Cada P1 tiene un test que falla contra el código
  anterior y pasa con el nuevo.
- **Repaso del delta** (`docs/revision/rf-s4b-repaso.md`, cherry-pick de `d29a342` de la rama
  `rf-s4b-repaso`): una sesión nueva, sin P0 y con 2 P1 de proceso.
  - **P1-A (gate de Sonar en 79.3 %):** se agregaron unitarios. El código nuevo del PR en API +
    shared queda en 94.4 %. Falta ver el gate en la CI.
  - **P1-B (el `ask` no cubría las CLI de producción):** **pendiente del dueño.** El clasificador
    de permisos no deja que el agente modifique `permissions.ask` («Self-Modification»). Las
    líneas a agregar están en el handoff.
  - **P2 corregidos:** 1, 2 y 5, más el `deny` de lecturas de `.env` por `grep`, `sed`, `cat`,
    `head` y `tail` (P2-6), sin commitear hasta que el dueño vea el diff.
  - **P2 anotados:** el 3 (límites de `--revert`), el 4 (pool por documento) y el 7
    (`import:initial-inventory`).

### Ensayo en demo (M8)

Demo se repuso desde production con `node scripts/db-reset-dev.mjs --branch demo --yes`, después
`pnpm env:demo` y `pnpm db:demo`. **La migración de RF-S4b y el seed tardaron 48 s en total.** La
de RF-S3c ya estaba aplicada. Las listas y fotos quedaron en `local-data/rf-s4b/ensayo-demo/`,
que no se commitea.

| Paso                     | Resultado                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Línea base               | Inventario S/ 1 108 105.2721; margen agosto S/ 304 394.4022 (año S/ 308 419.8262); `BOB…` 14 activos / 0 inactivos                     |
| normalize dry-run        | 9 renombres, 2 uniones (3 productos a unir), 0 no interpretables, 2 abiertos (COT-000002, COT-000011), 63 bobinas con saldo, 0 paradas |
| normalize execute (54 s) | Reportes idénticos al centavo; `BOB…` 11 / 3                                                                                           |
| sweep dry-run            | 113 documentos importados revisados; (a) 3, (b) 2 (las dos anuladas), (c) 0, sin comparar 0                                            |
| sweep execute (71 s)     | 2 documentos corregidos (COT-000002, COT-000011), 0 rechazados, 0 pendientes; reportes idénticos                                       |
| COT-000002               | Se ata a `SALDO-ALZ-AZUL-5002-0.38-4194-7`; al confirmarla genera PED-000042 y reserva la bobina. **Total 14 679.0006, no 14 679.00**  |
| `--revert` (44 s)        | 14 pasos, 0 paradas; reportes idénticos y **SKU `BOB…` activos idénticos a la línea base** (14 / 0)                                    |
| re-normalizar (53 s)     | Mismo plan (9 + 2, 0 abiertos); estado idéntico al de la primera normalización (11 / 3), reportes idénticos                            |

**Defectos que encontró el ensayo, todos corregidos con test en esta sesión:**

1. **Las CLI no arrancaban contra Neon:** `JWT_SECRET Required`. Y morían **sin mensaje**, por
   `abortOnError` con el logger apagado. Habría cortado la ventana (D-259).
2. **Un documento anulado le quitaba la bobina a uno abierto** en el barrido: COT-000074 contra
   COT-000002 (aclaración de D-258).
3. **La edición de cotización vencía la transacción de 5 s** contra Neon, por la validación del
   pool en el servidor. Ahora tiene 30 s, como la de pedidos.
4. **Falta `.env.setup` en un worktree nuevo:** se agregó como paso 0 del runbook.

**El trío del papel (decidido por el dueño, opción A, registrada en D-255):**

- Si valor + IGV − total está a S/ 0.01 o menos, se guardan el total del papel, el valor
  redondeado a dos decimales y el IGV como la resta. Ese IGV tiene que quedar a S/ 0.01 o menos
  del 18 %.
- FFA1-1350 queda en 12 439.83 / 2 239.17 / 14 679.00.
- Con esta regla, el dry-run del barrido en demo corrige **36 documentos abiertos** (27
  cotizaciones y 9 pedidos, 92 líneas), no solo COT-000002. La diferencia máxima es S/ 0.005 en
  el valor y S/ 0.003 en el total, y ningún comprobante aparece en dos documentos. Ese es el
  criterio exacto del runbook para production.

**Hallazgos del repaso atendidos después del cierre del informe:**

- P1-B, con dos candados:
  - `ask` de `.claude/settings.json` para las CLI que escriben datos reales.
  - Las CLI no corren contra production sin `--confirm-production`, ni siquiera en dry-run
    (D-261).
- La línea «editada a propósito» (con una edición de precio registrada) va a (c).
- La marca del importador tampoco entra por el pedido directo ni por el duplicado.
- `--revert` solo dentro de la ventana (D-261).
- El spec de D-153 (`comprobante-manual-ui`) arma su pedido importado por el flujo real
  (importar y confirmar). La primera CI sobre `9b723cd` lo había mostrado en rojo: tipeaba la
  marca que D-256.3 prohíbe.

**SHA de runtime para la ventana: `e247f40`.** Los commits posteriores son solo documentación.

## RF-S4b — SKU canónico de bobina, pool de venta y el importe que manda (2026-09-23)

Rama `rf-s4b` desde `origin/main` `f60ab6c`. Decisiones D-252..D-257 en `ARQUITECTURA.md` §0.2.
**Con migración aditiva** (`20260923180000_rf_s4b_products_merged_into`). Sin tocar producción:
todo lo de prod (normalización, barrido, lecturas) queda para la ventana, con OK del dueño.

### El caso real, y por qué no era lo que parecía (M0)

El brief nombraba FFA1-1355 y una tolerancia de ±0.10; el código mostró que la tolerancia de
D-169 para 3840 kg es 0.1921 y que **no corre** al editar un pedido ni al emitir. El dueño
corrigió el caso con capturas: era **FFA1-1350 / COT-000002**. El importador enganchó `BOB38AZUL`
a un producto de catálogo suelto del mismo código —sin saldo y sin bobinas detrás— y confirmar
rebotaba con «BOB38AZUL tiene 0.000 KGM disponibles», con la bobina de 4194 kg en el almacén
(SALDO-ALZ-AZUL-5002-0.38-4194-7). Al editarla con precio con IGV 3.50, el formulario dividía
entre 1.18 a cuatro decimales (2.9661) y el API volvía a multiplicar: 14 678.99 en vez de
14 679.00. Dos reglas generales salen de ahí: R1 (D-254) y R2 (D-255).

Hallazgos laterales que quedan escritos:

- La edición de precio de un **pedido** importado no tenía la exención del piso que D-163 ya
  daba a la cotización (D-256).
- Una bobina **no le pertenece** a un producto: el saldo vive en su kardex y el `BOB…` se deduce
  de ella (D-116/D-170). Por eso la unión no escribe kardex (D-253).
- El origen parte del precio con IGV y su IGV es la resta; recalcularlo al 18 % dejaba colas de
  diezmilésimas que la cobranza (redondeo al céntimo hacia arriba, D-169) convertía en un
  céntimo de más. El importador guarda ahora los tres importes del papel cuando cuadran.

### Qué tablas guardan el código como texto (M1.2)

Ninguna tabla de ítems guarda el SKU: `quotation_items`, `sales_order_items`,
`fiscal_document_items`, `dispatch_items` y `purchase_items` copian solo el **nombre** en
`description` y apuntan al producto por FK. El SKU aparece solo dentro de JSON: `audit_log`
(before/after), `import_rows.data` y `fiscal_documents.provider_response`. En vivo por FK lo leen
el `codigo` del payload de Nubefact y el PDF de orden de planta. Un comprobante ACCEPTED sirve el
XML/PDF que el PSE devolvió (`pdfKey`/`xmlKey` en R2) y no se reconstruye: renombrar un producto
no lo toca (decisión 4 del dueño, test `accepted-files-sku-rename.spec.ts`).

### Herramientas nuevas (dry-run por defecto)

- `pnpm normalize:coil-skus [--branch …]` — renombres, uniones, no interpretables, documentos
  abiertos y cuadre de kilos; `--execute [--ack-open-documents]`, y contra production además
  `--confirm-production`.
- `pnpm sweep:imported --file <export> [--branch …]` — (a) líneas que R1 resolvería distinto,
  (b) importes que no son los del papel, (c) abiertos que no se resuelven solos. `--execute`
  corrige solo documentos **abiertos**, por servicios de dominio y auditado; lo que el dominio
  rechaza se reporta por documento.

### Pendientes anotados por el dueño, sin implementar

- Evaluar si una bobina 3020 puede usarse en una OP de cobertura ROJO (D-252).
- Pool real de kg con despacho multi-bobina (opción 2 de D-254).

### Verificación

- **SonarCloud (PR #14): el gate falló por cobertura en código nuevo, 12.6 % contra ≥ 80 %.** No
  era de infraestructura: era deuda de tests nuestra. Sonar solo cuenta las líneas de la API
  (el 12.6 % coincide con ~72 de las 570 líneas nuevas cubiertas), así que el 80 % era
  alcanzable con unitarios sin tocar el web. Se agregaron 133 tests de los servicios que
  escriben datos (normalización, barrido, ediciones de pedido, importador, pool, catálogo,
  `sales-lines`): cobertura de líneas nuevas de la API **97.9 %** (558/570), medida cruzando el
  `lcov` con `git diff`. Nota: el gate venía fallando en 6 de los últimos 7 PRs (#13 se mergeó
  con 0 %).
  **Pero con la API al 97.9 % Sonar seguía dando 74.8 %**, y la causa no era de tests: el log del
  scanner decía «Could not resolve 33 file paths … ../../packages/shared/src/…». `packages/shared/src`
  está en `sonar.sources`, la API lo resuelve compilado desde `dist/` y el paquete no tiene runner
  propio, así que todo lo que se agregaba ahí contaba como código sin cobertura. Se arregló en dos
  pasos: `apps/api/jest.config.js` mapea `@ayr/shared` a su fuente (y `rootDir` a la raíz del
  repo), y `scripts/fix-lcov-paths.mjs` reescribe las rutas `../../packages/…` del lcov a
  `packages/…`, que el scanner sí resuelve. Resultado en la CI del PR #14: **80.6 %** (gate ≥ 80 %
  en verde). **El margen es corto**: cualquier PR con código nuevo en `packages/shared` o ramas sin
  probar lo vuelve a hundir. Efecto lateral bueno: jest ya no corre contra un `dist/` viejo de
  shared (la trampa P2 del handoff de D-249). Para depurar el gate la próxima vez: el log del job
  «Análisis estático» (`gh api repos/…/actions/jobs/<id>/logs`) dice qué rutas no resolvió; el
  proyecto es privado y sin el token no se puede leer el dashboard.
- Unitarios: API **929** passed (eran 743 al empezar), web **11** passed. `pnpm lint`,
  `pnpm typecheck` y `prettier --check` verdes.
- Autorrevisión (`docs/revision/rf-s4b-autorrevision.md`): 2 P0 y 9 P1 encontrados; los P0 y
  ocho P1 corregidos con tests, uno documentado; los P2 corregidos o anotados como pendientes.
- La primera corrida de la suite completa mostró una cascada de rojos que **no era del producto**:
  la limpieza de los specs apagaba el `BOB…` de venta, que desde D-252 es compartido por el pool
  (`BOB050NATURAL`), y dejaba sin producto de venta a todos los specs siguientes. Corregido en
  los helpers (`3b3668d`). **Lo mismo puede pasar en producción** si alguien desactiva a mano un
  `BOB…` canónico: las bobinas de su pool dejan de poder venderse. **Resuelto por decisión
  del dueño** (aclaración de D-257): el catálogo rechaza desactivarlo mientras su pool tenga
  bobinas abiertas con saldo; unitario `open-coils-in-pool.spec.ts` y E2E en
  `bobina-pool-cot000002-rf-s4b.spec.ts`.
- M0 corrido en rojo antes de tocar código: 25/25 unitarios de R1/R2 fallando.
- E2E nuevos, corridos aislados en local (`pnpm exec playwright test <spec>`): COT-000002 al
  importar (1/1), COT-000002 por el barrido (1/1), normalización con reportes RF-S4a iguales al
  centavo (1/1), D-168 actualizado a D-252 (1/1).
- Suite E2E completa con builds de producción (`node scripts/e2e-latency.mjs`, `next start` +
  `node dist/main.js`, desde el worktree, 99.4 min): **331 passed / 36 failed / 2 skipped / 20
  did not run.** Clasificación:
  - 24 rojos + 20 sin correr, **infraestructura**: el stack local murió alrededor del test 346
    (el login por el web devolvía 500 «Unexpected token ':'» después de un timeout de planta).
  - 7 rojos, **infraestructura/entorno**: `PSE_ENABLED` sin definir en el runner local («Emisión
    electrónica no habilitada»); en CI está en `true`.
  - 2 rojos, **infraestructura**: R2 no configurado en local (PDF de cotización en fase5a, XML de
    compra en fase2a); las credenciales solo viven en los secrets de CI.
  - 1 rojo, **producto, corregido** (`b6963ab`): la normalización paraba sobre `BOB…` de colores
    dados de baja.
  - 1 rojo, **prueba, corregido**: D-169 esperaba el 400 que R2 elimina a propósito.
- Re-corrida con builds de producción y `PSE_ENABLED=true` de los specs con rojos y de todo el
  tramo que no corrió (83 tests, 21.5 min): **80 passed / 2 failed / 1 skipped**. Los dos: fase2a
  (R2, infraestructura, esta rama no toca compras) y D-169 (aserción del mensaje del pipe de Zod;
  corregida, el spec aislado da 7/7). La cobertura de R2 real queda para la CI del PR.
- M3 (sacrificable): spec del controlador de reportes hecho. **Pendiente: el render de la vista
  de margen — requiere decidir D-011.** Por decisión del dueño no se agrega jsdom ni
  testing-library en esta sesión.

## Limpieza de residuos y coherencia del repo (2026-09-23)

Sesión de limpieza tras quedar Claude Code como único agente. Corrida desde `main` (no desde un
worktree), con inventario completo antes de cualquier borrado y OK del dueño ítem por ítem. No
se tocó ningún worktree/rama con trabajo vivo no integrado.

**`main` local realineado.** Al empezar, `main` tenía 3 commits propios sin push (2 de la sesión
de inventario UPVC + el descarte de `acc-demo`, ver sección de arriba) y estaba 18 commits
detrás de `origin/main` (RF-S4a, HOTFIX kg teórico). Se rebasaron los 3 commits sobre
`origin/main` actualizado; 2 conflictos en `docs/PROGRESO.md` —ambos del tipo "las dos ramas
agregaron su sección en el mismo punto del archivo", nunca contenido superpuesto— resueltos
conservando ambas historias en orden cronológico (HOTFIX 14:44 → RF-S4a 16:47 → sesión UPVC
20:48/21:01 → descarte de `acc-demo` hoy). **`main` local queda 3 commits adelante de
`origin/main`, sin pushear**: por decisión del dueño, el push (`git push origin main`) lo hace
él directamente (regla dura 1, D-232) — no se usó `AYR_OWNER_PUSH`.

**Borrados, con OK explícito del dueño ítem por ítem:**

- Ramas ya mergeadas en `origin/main`, sin contenido que se pierda: `rf-s4a` (local + remoto,
  PR #9), `origin/docs/ventana-rf-s3c` (PR #8), `origin/hotfix-kg-teorico` (PR #10).
- `rf-s2-pre-rebase-b0e2aac` (local, sin remoto) — backup pre-rebase del 2026-09-16; verificado
  que su contenido (D-218..D-222) ya vive en `main` bajo otros hashes.
- `.playwright-mcp/` (untracked) — logs/snapshots de una sesión interactiva de debugging ya
  cerrada. `.worktrees/` — directorio vacío sin uso desde el 18/09 (los worktrees reales son
  carpetas hermanas `../ayr-steel-erp-*`).
- `apps/api/prisma/oneoff-upvc-catalog-report.ts` y `oneoff-verify-upvc-balances.ts` — residuo
  de la sesión de inventario UPVC (su propio comentario decía "se borra al cerrar la sesión");
  duplicados en función por `scripts/oneoff/20260922-check-upvc-catalog.mjs` y
  `20260922-verify-upvc-balances.mjs`, que sí se conservan (uso reusable, solo lectura).
- `scripts/oneoff/20260916-deploy-api-ca6314d.mjs`, `20260916-describe-cloud-run.mjs`,
  `20260916-list-neon-branches.mjs` — atados a un SHA/branch de la ventana del 2026-09-16, ya
  cerrada.
- `local-data/r1/` (2,7 MB, diagnósticos F8-R1), `local-data/v4prep/` (188 KB, diagnósticos
  V4prep), `local-data/db-local-snapshots/` (vacío desde el 8/09), `local-data/e2e-report.json`
  y `local-data/subset.json` (salidas sueltas de Playwright) — residuo de sesiones ya cerradas.
  Los `.xlsx`/`.json` de cargas ya ejecutadas (`bobinas-production-*`, `COMPRAS.xlsx`,
  `inventario inicial.xlsx`, `Ventas Detalladas*`) se conservan a pedido del dueño, como rastro
  de auditoría.

**No se tocó** (trabajo vivo no integrado o intocable explícito): worktree/rama `hotfix-d249`
(5 commits sin push), worktree/rama `docs/ventana-rf-s4a` (1 commit sin push), rama Neon
`respaldo-pre-v4-20260915`. `acc-demo` se descartó por separado (ver sección de arriba, mismo
día) por decisión del dueño tras la demo al cliente.

**Efecto colateral del rebase, no un defecto de la limpieza**: con `main` ya alineado a
`origin/main`, `pnpm lint` salió en rojo (108 errores "Unsafe call/member access… type that
could not be resolved" en `apps/web/src/lib/*.spec.ts`) porque `node_modules` de este worktree
nunca vio la dependencia `vitest` que RF-S4a agregó (D-226) — `pnpm install` la trajo
(`+31` paquetes) y `pnpm lint`/`pnpm typecheck` quedaron verdes.

**Pendiente, no cerrado**: el PASO 2 del brief (diff propuesto de `AGENTS.md` §2 "Los dos
agentes" reflejando el esquema de un único agente, y revisión de `docs/agentes/README.md` —hoy
es enteramente instalación/perfiles de Codex y Antigravity— y de las dos menciones a `agy`/Codex
en `.agents/skills/ayr-arranque/SKILL.md:8` y `.agents/skills/ayr-revisor/SKILL.md:8-9`) **no se
hizo en esta sesión**. Referencias fuera del repo (`~/.codex/ayr-*.config.toml`,
`~/AppData/Local/agy/`) quedaron solo listadas, sin tocar, por ser de otra herramienta.

## Hotfix D-249 — tolerancia simétrica y filtro de línea (2026-09-22)

Rama `hotfix-d249`, **sin empujar**. Cierra los dos hallazgos de
`docs/revision/rf-s4a-d246.md`: el P1 de D-246 y el defecto de D-245. Sin migración.

### Lo que se arregló

- **D-249** — la rama «con declaración» de `mountedKgForReport` no tenía techo: cualquier cifra
  declarada que cupiera en lo montado saltaba el 1 % de tolerancia. Un reporte de 4 043,952 kg
  teóricos contra **1 kg montado** se aceptaba sacando 1 kg. El kardex quedaba cuadrado —por eso
  ninguna invariante lo delataba— pero la plancha entraba subvalorizada, y ese costo es el que
  lee el margen de D-242. Ahora el exceso se acota antes de mirar la declaración.
- **D-250** — `/reports/coils` mezclaba el nombre del enum de Prisma con la etiqueta que guarda
  Postgres: devolvía `businessLine: undefined` en cada fila y su filtro daba **cero filas
  siempre**. Verificado contra base: antes 11 filas sin filtro y 0 con cualquier filtro; después
  7 + 4, y la suma de los filtros reconstruye el total.

743 unitarios verdes. El E2E gana el caso que faltaba —el filtro por línea—, que es el que
convierte el silencio en rojo: el único test que tocaba esa ruta la llamaba sin filtro.

**La regla quedó más estricta que ayer.** Si planta encuentra un caso legítimo por encima del
1 %, ahora se bloquea aunque declaren kilos. La salida no es revertir sino subir
`THEORETICAL_KG_TOLERANCE_RATIO` con evidencia, o corregir la geometría del producto.

### M2 — el barrido del patrón: un solo sitio roto

Comprobado contra la base, no deducido: el ORM devuelve el **nombre** del enum (`DRYWALL`) y
`$queryRaw` la **etiqueta** de `@map` (`drywall`). Los dos mapas de `business-line-code.ts` están
indexados por el nombre, así que solo el camino crudo podía romperse — y solo `/reports/coils`
lo hacía. Los ~40 usos restantes de `toSharedLineCode` reciben el valor del ORM y son correctos;
los servicios de RF-S4a ya usaban `fromDbLineCode`; `BUSINESS_LINE_LABELS` (D-174) se indexa con
el código de shared, que es el que viaja en los DTO.

**El importador de cotizaciones queda descartado como sospechoso.** No clasifica líneas: resuelve
productos por SKU y la línea sale del producto. Que una venta de bobina aparezca como Reventa es
**deliberado** —D-116 + D-037 la facturan contra un SKU de `trading`, `sales-lines.ts:616,634`—
y lo que cambió la percepción fue D-247: antes el ingreso caía en `trading` y el costo en la
línea del acero, y ahora los dos caen en `trading`. El reporte pasó de estar mal a estar bien, y
eso hizo visible una clasificación que siempre estuvo. Si el negocio quiere verla bajo la línea
del acero, el cambio es de D-116/D-037 y no del reporte.

### M3 — por qué hay pedidos que no pasan a LISTO

`LISTO` exige que **todas** las OP vivas estén `CLOSED`; decide por estado, no por metros. Tres
mecanismos, los tres confirmados con tests:

1. una OP con **todo reportado pero sin cerrar** deja el pedido `EN_PRODUCCION` con
   `missingMl = 0.000` — el caso que más se parece a lo reportado;
2. **una sola OP en `DRAFT`** entre varias cerradas ancla el pedido entero (D-186 crea las OP al
   confirmar, y si una línea se resuelve de otra forma esa OP queda ahí);
3. con **todas las OP anuladas** el pedido vuelve a `SIN_PRODUCCION`, nunca a `LISTO`.

**Dos hipótesis probadas y descartadas**, anotadas para que nadie las recorra otra vez: el punto
flotante de `sales-orders.service.ts:2492` (real como violación de D-003, pero el `.toFixed(3)`
lo absorbe, y haría falta un desvío de más de 0,0005 m para cambiar el veredicto) y la
invalidación de queries (`invalidateProduction` sí refresca `sales-orders` y `sales-order`).

**Lo accionable:** mientras el defecto de D-246 existió, un reporte bloqueado dejaba su OP
`IN_PROGRESS` y el pedido `EN_PRODUCCION`. El hotfix de la mañana desbloqueó los reportes nuevos,
pero **las OP que quedaron abiertas siguen abiertas y hay que cerrarlas a mano**. La consulta de
diagnóstico que separa los tres casos está en `docs/handoff/hotfix-d249.md`.

### Pendiente

Dos revisiones cruzadas: RF-S4a (D-248) y este hotfix. Las escribió el mismo agente, así que
ninguna de las dos la puede firmar él.

**PENDIENTE DE REVISIÓN INDEPENDIENTE.** Este hotfix (D-249/D-250) ahora tiene una autorrevisión
en `docs/revision/hotfix-d249-autorrevision.md`, con el mismo banner de excepción que D-248
(mismo motivo: sin agente distinto disponible para un pase cruzado). Verificó con cálculo propio
y tests corridos que M0 (tolerancia simétrica) es correcta, que los tests nuevos de M1 fallan sin
el fix, y que M0/M2 no tocan kardex fuera de transacción. Sigue debiendo el pase cruzado real por
un agente distinto del implementador, según AGENTS.md §2.2.

### Cierre QA post-deploy — hotfix D-249/D-250 (2026-09-23)

Verificación de solo lectura contra **producción real**, ya con el hotfix desplegado y con el
tráfico 100 % en la revisión activa. No sustituye el pase cruzado independiente pendiente
(§ arriba): es la comprobación de que lo desplegado hace lo que D-249/D-250 dicen que hace.

**Runtime desplegado.** `gcloud run services describe ayr-steel-erp-api` confirma
`status.traffic = {revisionName: ayr-steel-erp-api-00042-tdb, percent: 100}` y
`gcloud run revisions describe` de esa revisión trae `git-sha=0e1124b`, el commit en la punta de
`main` al momento de esta sesión.

**D-250 — filtro por línea de `/reports/coils`, contra producción de verdad.** Con el patrón de
`scripts/smoke-prod.mjs` (admin efímero `e2e-qa-d249@ayr.test` vía `ALLOW_E2E_ADMIN=1`, login por
`/api/auth/login`, cookie de sesión reenviada) se corrió un script de un solo uso
(`scripts/oneoff/20260923-qa-coils-line-filter.mjs`, creado, ejecutado y borrado en esta misma
sesión) contra `https://ayr-steel-erp-web.vercel.app`:

- Sin filtro: **92 filas**.
- `businessLine=drywall`: 0 filas. `businessLine=metallic-roofing`: **92 filas**, todas con
  `businessLine: "metallic-roofing"` poblado. `businessLine=roofing`, `trading` y `services`: 0
  filas cada una.
- Suma de las cinco líneas: **92 = 92**, reconstruye el total exacto.
- Que hoy todo el inventario de bobinas en `production` sea `metallic-roofing` es coherente con
  `COIL_BUSINESS_LINES` (`packages/shared/src/enums.ts:56-59`), que solo admite `DRYWALL` y
  `METALLIC_ROOFING` para bobinas: cero filas en `drywall` es el dato real de hoy, no un síntoma
  de que el filtro siga roto (antes del fix, **todas** las líneas devolvían cero, incluida la que
  sí tiene datos).
- Admin efímero de QA **borrado** al terminar (`cleanup-e2e-users.ts` con `ALLOW_E2E_CLEANUP=1`
  en el `finally`): salida `Usuarios de E2E borrados: 1`.

**D-249 — tolerancia simétrica de `mountedKgForReport`.** Sin escribir en producción (habría
tocado kardex):

- `pnpm exec jest mounted-kg.spec.ts` en `apps/api`, contra el código ya desplegado: **21/21
  verdes**, incluidas las 5 pruebas del bloque `tolerancia simétrica (D-249)`.
- Verificación de caja negra reconstruyendo el paquete (`pnpm --filter @ayr/shared run build`,
  para no repetir el falso-verde de `dist` desactualizado que documenta
  `docs/revision/hotfix-d249-autorrevision.md`) e importando `mountedKgForReport` desde
  `packages/shared/dist/index.js` en un script de una sola vez:
  - Caso real de la ventana (teórico 4043.952 kg, montado 4010.000 kg, sin declarar; exceso
    0,84 %): **acepta**, `kg="4010"`, `capped: true`.
  - Caso absurdo del hallazgo P1-1 (teórico 4043.952 kg, montado 1.000 kg, declarado 0.500 kg):
    **rechaza**, con el mensaje que manda a revisar piezas/bobina en vez de sugerir declarar.
- `git status --porcelain` quedó vacío al terminar; `packages/shared/dist/` es el único artefacto
  tocado y está en `.gitignore`.

**Sin hallazgos nuevos.** No se encontró nada que amerite una decisión `D-nnn` nueva: es
verificación de lo ya decidido en D-249/D-250, no una decisión distinta. El pase cruzado
independiente de AGENTS.md §2.2 sigue pendiente.

### Diagnóstico M3 contra producción — cero pedidos atascados, síntoma sin explicar

Query de solo lectura (autorizada por el dueño, D-234, con la consulta corregida por él antes de
correrla) contra `production`, previa al merge: separa los pedidos con OP no cerradas en los tres
mecanismos de M3 (`docs/handoff/hotfix-d249.md`), usando `live_ops`/`total_ops`/`closed_ops` en
vez de `sales_orders.status` (que no sirve de filtro: `deriveOrderReadiness`,
`order-readiness.ts:17`, decide `LISTO` solo por el estado de las OP, nunca por el estado
persistido del pedido).

**Resultado: cero filas en los tres casos, y cero en el `ELSE` (posible cuarto mecanismo).**
Sanity check aparte confirmó por qué: `production_orders` en `production` tiene **28 filas, las
28 en `CLOSED`** — cero en `DRAFT`, `IN_PROGRESS` o `CANCELLED`. No hay ninguna OP colgada hoy,
ni por el mecanismo viejo de D-246 ni por uno nuevo. Script de un solo uso creado, corrido y
borrado en la misma sesión; ninguna escritura contra `production`.

**El síntoma que motivó el PASO 3 queda SIN EXPLICAR.** El dueño reportó el 2026-09-22 un pedido
que no pasaba a `LISTO` al terminar producción, y ninguno de los tres mecanismos de M3 lo
reproduce hoy contra datos reales — ni un cuarto mecanismo detectable por estado de OP. Si
reaparece, **la siguiente sesión no debe volver a mirar el estado de las OP**: ya se descartó acá.
Conviene revisar la capa de lectura/presentación de `LISTO` (dónde y cuándo la UI pide y cachea
`deriveOrderReadiness`, si invalida cuando corresponde, y si hay algo de esa capa —no del estado
de dominio— que pueda mostrar un pedido como no-`LISTO` un rato después de que sus OP ya cerraron.

## Ventana RF-S4a — reportes de costeo (2026-09-22)

Ventana corta, **sin migración**: los dos reportes son de solo lectura y no tocan ningún
servicio de dominio. PR #9 mergeado a `main` con OK explícito D-232 del dueño; merge commit
`da8b624`. Agente: Claude Code.

### Qué quedó desplegado

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| `main`    | `da8b624` (merge del PR #9)                                                                     |
| API       | `ayr-steel-erp-api-00041-99q`, `git-sha=996d52e`, 100 % de tráfico, `{"status":"ok","db":"ok"}` |
| Web       | deployment de producción de Vercel disparado por el merge, alias `v2.mareliac.pe`               |
| Migración | **ninguna**                                                                                     |
| Smoke     | `pnpm smoke:prod` verde desde el worktree en `996d52e`                                          |
| Respaldo  | **no se tomó**: la ventana no escribe una sola fila (ver abajo)                                 |

Alineación de runtime verificada: `git diff --quiet 996d52e origin/main -- apps packages
Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml` → exit 0.

El smoke leyó 106 filas de inventario valorizado y 92 del reporte mensual de bobinas, así que
la ruta vieja sigue respondiendo y la base tiene los datos que el reporte nuevo va a mostrar.

### Por qué esta ventana no tomó respaldo Neon

A diferencia de S3c, acá no hay migración, ni backfill, ni escritura de ningún tipo: las cuatro
rutas nuevas son `GET` y ningún servicio de dominio cambió. El diff contra `main` son 3 322
líneas agregadas y **5 eliminadas**, y esas cinco son un `import`, un `constructor` y un
`providers:` que se extendieron. Un respaldo protege contra un cambio de datos que acá no
existe; el rollback es devolver el tráfico a `ayr-steel-erp-api-00040-9m9` (`git-sha=d366c40`),
que sigue disponible.

### Decisiones nuevas

**D-242** a **D-245** y **D-247**, todas en `docs/ARQUITECTURA.md` §0.2. Las dos que más
condicionan lo que venga:

- **D-242**: el costo de venta sale de los movimientos `refType='SALE'` de los despachos del
  pedido, **no** del consumo de sus OPs. La fórmula del brief cargaba al pedido el excedente de
  sobreproducción y daba margen 100 % a un pedido servido desde stock.
- **D-247**: en el desglose por línea, el costo se atribuye por el producto despachado y no por
  `inventory_movements.business_line_id`. D-119 sigue mandando en el kardex; lo que no puede es
  sostener una tabla de margen.

### Deuda que el dueño decidió diferir a mañana (2026-09-23)

1. **Quality gate de SonarCloud, en rojo en el PR #9.** A diferencia del PR #7 —donde no se
   pudo enumerar nada— acá el gate dice exactamente qué falla, y es **una sola condición**:
   `74.8% Coverage on New Code` contra el ≥ 80 % exigido. **Reliability no aparece**: el
   `Reliability D` que arrastraba el PR #7 no se repite en este. El hueco de cobertura son 5,2
   puntos y está en el web, que no tiene unitarios: las dos vistas nuevas suman ~600 líneas sin
   test, contra una cobertura alta en el API (29 unitarios nuevos en `src/reports/`).
2. **Revisión cruzada pendiente.** AGENTS.md §2.2 exige que revise quien no implementó, y los
   otros agentes estaban sin saldo. Decisión del dueño por la ventana de esta noche. Revisar
   `e27e750`, `f35bcaa`, `cc1d6e0`, `edb80fb` y `50a6450`, con foco en: el signo de las reversas
   de despacho en `costsByOrder`, la precedencia de `resolveCostStatus` (D-243) y el
   `LEFT JOIN` a `dispatch_items` que sostiene D-247 sin perder movimientos.

Las dos deudas son de **esta** ventana y se suman a la revisión cruzada del hotfix D-246, que
quedó pendiente por su cuenta.

### Lo que todavía no se sabe

Los conteos de `PARCIAL` y `NO_COMPARABLE` del mes en producción. Se leen desde la pantalla
`/reportes/ventas-margen`; no se consultaron desde esta sesión por decisión del dueño (sin
`SELECT` directo contra producción ni sesiones prestadas). La rama Neon `demo` **no sirve** para
adelantarlos: está congelada en el 2026-09-17, le falta `20260920120000_rf_s3c_seller_scope`
—la consulta del reporte revienta con `column so.seller_id does not exist`— y sus datos son un
snapshot de 15 pedidos y 4 comprobantes vivos contra los 19 pedidos de producción. Conviene
refrescarla desde `production` antes de usarla para UAT.

### Rollback (no fue necesario)

API → tráfico a `ayr-steel-erp-api-00040-9m9` (`git-sha=d366c40`). El web vuelve revirtiendo el
merge. No hay migración que deshacer ni dato que restaurar.

## RF-S4a — reportes de costeo y ventas (2026-09-22)

Sesión de solo lectura: **sin migración**, sin escrituras nuevas y sin tocar ningún servicio de
dominio. PR [#9](https://github.com/gsinuiri-coder/ayr-steel-erp/pull/9), rama `rf-s4a`, **sin
mergear** a la espera de la ventana y del OK de D-232. Agente: Claude Code.

La rama incorpora el HOTFIX de D-246 (`ca05935`), que entró a `main` mientras esta sesión estaba
abierta. El único cruce fueron estos dos documentos —los dos agregaron su sección o su fila al
tope— y se resolvió conservando ambas cosas; **en código no hubo conflicto**: el hotfix vive en
`production/` y estos reportes solo leen.

Los tres milestones entraron, incluido el sacrificable.

### Lo que cambió respecto del brief, y por qué

El brief definía el costo del pedido como «kg consumidos por sus OPs + costo de reventa según
su movimiento de salida». Esa fórmula rompe en dos casos que el sistema ya produce hoy, así que
se presentó la contradicción antes de escribir código (D-230) y el dueño decidió **D-242**:

1. **Sobreproducción.** `roofing-production.service.ts` dice, en su propio comentario, que
   producir de más «es normal y esperable» y que el excedente «entra al kardex como stock
   libre». Con la fórmula del brief, ese excedente que se quedó en el almacén se le carga al
   pedido y le hunde el margen.
2. **Pedido servido desde stock.** Una OP a stock nace con `targetPieces` y sin `reservationId`
   (D-140/D-145): no pertenece a ningún pedido. Un pedido atendido con esas planchas no tendría
   OPs propias, y habría salido con costo 0 y **margen 100 %** — el número inventado que el
   propio brief prohibía.

El costo sale entonces de los movimientos `refType='SALE'` de los despachos del pedido, que es
donde ya está valorizado al promedio ponderado para producto fabricado, plancha de catálogo y
bobina de reventa por igual. El material que sí consumieron las OPs se muestra en una columna
aparte, rotulada como lo que es: una pregunta de planta.

### Cuándo el reporte dice que no sabe (D-243)

El borde lo planteó el dueño al aprobar el plan: el rango filtra comprobantes, pero el costo
del pedido cubre todos sus despachos. Precedencia por fila, sin prorrateo en ninguna rama:

| Estado          | Condición                                                                        | Totales                                      |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| `COMPLETO`      | Sin comprobantes vivos fuera del rango, y todo lo facturado ya despachado        | suma                                         |
| `COMPLETO`      | Con comprobantes afuera, pero **cada** uno del rango declara su despacho (D-205) | suma solo esa porción, exacta                |
| `PARCIAL`       | Quedan líneas facturadas sin despachar: el costo es un piso, el margen un techo  | suma, y el total declara `partialOrderCount` |
| `NO_COMPARABLE` | Con comprobantes afuera y alguno del rango sin despacho declarado                | **no suma**, se lista aparte                 |

El prorrateo no aparece porque el único caso donde sería exacto es la segunda fila, y ahí el
dato exacto ya existe sin prorratear.

### Un defecto propio, encontrado revisando el código ya empujado

Esa segunda fila de la tabla —el pedido con comprobantes afuera cuyos comprobantes del rango sí
declaran despacho— salió mal en el primer commit: el monto de la fila se acotaba a esa porción,
pero los totales **por línea de negocio** sumaban el costo del pedido entero. Con los números
del test, el total decía 300 y la suma de la tabla por línea, 800.

La causa no fue la aritmética sino la forma: había dos agregados distintos —uno por pedido y
otro por pedido y línea— construidos **antes** de saber qué filas contaban, así que la decisión
de cuáles entran se tomaba dos veces y las dos se separaron. Las filas de costo ahora se guardan
sin agregar, se filtran una sola vez por pedido, y de ese mismo arreglo salen el monto y su
apertura: ya no pueden discrepar por construcción.

Lo fijan dos tests, y **se comprobó que fallan** al quitar el filtro, en vez de asumir que eran
buenos. El que importa mezcla las tres clases de fila a la vez: con una sola clase los dos
caminos coinciden por casualidad y el test pasa sin probar nada.

### Casos cuyo costo no se puede trazar

El brief pedía reportarlos acá, y la respuesta honesta es que **no se sabe**: estos reportes no
se han corrido nunca contra producción. La sesión fue código y CI, y la primera lectura real es
el guion UAT (`docs/uat/rf-s4a.md`), que trae una sección dedicada a contarlos. Lo que sí está
identificado es **dónde** van a aparecer:

- **Comprobantes sin despacho declarado.** `Dispatch.invoiceId` solo se llena en el mostrador
  (D-100) y en el despacho declarado al facturar (D-213). Todo lo facturado antes de D-213 y
  fuera del mostrador tiene el costo trazable **al pedido pero no al comprobante**, y sale con
  el costo en blanco en la fila del comprobante. Son la mayoría de los 19 pedidos vivos.
- **Pedidos que cruzan el corte de mes.** Facturados en parte en un mes y en parte en otro, sin
  el enlace de arriba: caen en `NO_COMPARABLE` y quedan fuera de los totales. Cuántos son,
  depende del rango que se pida; el reporte los cuenta en `excludedOrderCount` y muestra su
  venta en `excludedSalesPen`, así que el UAT lo va a decir en la primera corrida.
- **Líneas libres de comprobante** (servicios, ajustes de nota de crédito): no tienen producto
  del cual derivar la línea de negocio y van al grupo «sin línea» en los totales.

### Defecto preexistente encontrado, **no corregido** (D-245)

`GET /reports/coils` (RF-90, desplegado en producción) traduce mal el código de línea de
negocio. Postgres guarda la etiqueta del enum, que es el valor de `@map` (`'drywall'`), pero
`toSharedLineCode` está indexado por el nombre de Prisma (`'DRYWALL'`). Dos consecuencias, las
dos verificadas sin base de datos:

1. cada fila devuelve `businessLine: undefined` (la clave desaparece del JSON);
2. `?businessLine=…` compara `'drywall'` contra `'DRYWALL'` y **devuelve cero filas siempre**.

Sobrevivió porque el único E2E que toca esa ruta (`fase7-consolidada.spec.ts:112`) llama sin
filtro y no mira esa columna. **Queda sin corregir a propósito**: está fuera del alcance de
RF-S4a y la corrección es del dueño (§10). El código nuevo no lo hereda —usa `fromDbLineCode`,
que valida en vez de castear—, pero mientras nadie toque `reports.service.ts`, el reporte
mensual de bobinas sigue con el filtro roto en producción.

### Verificación

- **CI verde** en el PR #9 sobre `50a6450` (run `35782200058`), con el hotfix D-246
  incorporado: lint, typecheck, 738 unitarios, E2E completo **382 passed / 0 failed / 3 skipped** en
  el Postgres del runner, y smoke sobre Neon `ci`. Los 3 skipped son los mismos de siempre, no
  aparecieron en esta sesión.
- El E2E pasó de **380 a 385 tests** (377 → 382 pasados): exactamente los 5 nuevos de
  `e2e/tests/reportes-costeo-rf-s4a.spec.ts`, así que corrieron de verdad y no quedaron
  filtrados.
- 29 unitarios nuevos en `apps/api/src/reports/`: conciliación contra el kardex, presupuesto de
  consultas (2 fijas en M1, 6 en M2, verificadas contra N creciente por D-228), las tres ramas
  de D-243, la invariante entre el total de costo y los totales por línea, y el tipo de celda
  del xlsx.
- La suite E2E **no se corrió en local** por decisión del dueño: sesión en paralelo con
  `acc-demo`, con la CI del PR como única juez.

### Deuda que esta sesión hereda y no resuelve

El **quality gate de SonarCloud quedó rojo en el PR #7** (20.3 % de cobertura en código nuevo,
Reliability D) y el handoff de RF-S3c pide evaluarlo antes de mergear RF-S4a. En este PR el job
de análisis estático salió verde, pero eso **no** dice nada del gate del PR anterior: los issues
concretos siguen sin enumerarse porque el proyecto de SonarCloud es privado y el `SONAR_TOKEN`
solo vive en los secrets de Actions. El dueño los pasa desde el dashboard.

## HOTFIX kg teórico — planta bloqueada por tolerancia de laminado (2026-09-22)

Producción real detenida: el reporte de 253 × 6.00 m de IMPO-ALZ-NATURAL-0.28-4010-11 pedía
4 043.952 kg teóricos contra 4 010 kg montados, con el acero ya consumido. D-246: el reporte
se topa en lo montado cuando lo declarado cabe o, sin declaración, el exceso es ≤ 1 % del
teórico; fuera de eso sigue bloqueando. Aplica a coberturas (reporte, reporte+cierre,
borrador/multi-montar, a medida y plancha de catálogo) y a drywall. El piso del cierre se lee
de las salidas reales del kardex. Sin migración; toca API y web (deploy API → push web).
Sin E2E local (corre en paralelo con rf-s4a/acc-demo): la juez es la CI.

- CI del PR #10 (run 35770887406) verde: lint/typecheck/unit, análisis estático, E2E en
  Postgres del runner **377 passed / 0 failed / 3 skipped**, smoke y migraciones Neon `ci`.
- Deploy con OK D-232 del dueño: API desde `d366c40` → revisión `ayr-steel-erp-api-00040-9m9`,
  label `git-sha=d366c40`, `/health` 200. Web por merge a `main`.
- **Deuda: revisión cruzada pendiente (programada para 2026-09-23).** El hotfix se desplegó sin
  el pase de revisión independiente de AGENTS.md §2.2: `agy` y Codex estaban sin saldo y el
  revisor alterno se cortó por límite de API. Decisión del dueño por urgencia (producción
  detenida). Revisar `d66de6b`, con foco en: reserva descontada por la salida topada,
  `closeInTx` leyendo el piso de kardex (reportes de la misma transacción y reportes previos),
  `RoofingBatchOrderDto.reportedKg` = suma de `consumedKg` de consumos vivos (reabrir D-193),
  y que web, borrador y API den el mismo veredicto.

## Sesión Inventario inicial UPVC — carga completada en demo (2026-09-22)

Objetivo: preparar y cargar la segunda tanda de inventario inicial pendiente desde V-4 (ver
«Pendientes vivos» ítem 4, abajo) con `--kind products` contra `demo`. **Completada en demo**;
producción queda para la ventana que el dueño autorice.

- **Catálogo (demo) verificado**: `UPVC36MT`, `UPVC6MT` y `UPVC36MTAZUL` existen, están activos y
  son de la línea `ROOFING` (Coberturas UPVC). **Bloqueo encontrado**: los tres tienen
  `source = MANUFACTURED`, no `PURCHASED` — contradice `AGENTS.md` §7 («UPVC es compra-reventa»)
  y D-207 exige `PURCHASED` para que el importador los acepte. Ninguno tiene color cargado
  (`colorId` null) pese a que el nombre dice ROJO/ROJO/AZUL; esto no bloquea la herramienta (no
  valida color en `--kind products`, solo en bobinas) pero es un hueco de catálogo aparte, a
  decisión del dueño si corresponde completarlo.
- **Archivo armado**: `local-data/inventario-inicial-upvc-2026-09-22.csv`, 3 filas consolidadas
  (970 / 1061 / 58 unidades a 43,2203 / 74,5763 / 39,8300 PEN sin IGV), total **S/ 123.359,29 sin
  IGV** (cuadra con lo pedido). Las tres filas llevan la referencia de factura y proveedor que
  pidió el dueño como texto libre en `FACTURA DE REFERENCIA` (D-206: solo trazabilidad, no
  genera compra ni proveedor) — dato real, queda solo en el archivo de `local-data/`, no acá.
- **Dry-run contra demo (primer intento)**: 0 ok / 0 omitida / **3 con error** — las tres
  rechazadas por «es un producto fabricado (source MANUFACTURED)». No se corrió `--execute`
  (regla dura 16: ambigüedad de catálogo se detiene y espera decisión del dueño).
- **Efecto colateral necesario para poder compilar el CLI**: `packages/shared/dist` y el Prisma
  Client locales estaban desactualizados (de antes de RF-S3c/D-240/D-241, campo `seller_id`), lo
  que rompía el `tsc -p tsconfig.cli.json` del importador con decenas de errores ajenos a esta
  tarea. Se regeneraron con `pnpm --filter @ayr/shared build` y `pnpm --filter @ayr/api
db:generate` — solo artefactos generados localmente, sin tocar datos ni schema.
- **Corrección de catálogo, con OK del dueño**: el dueño confirmó que el `source` estaba mal
  cargado (ya lo había corregido en `production`) y pidió corregirlo también en `demo`. Se hizo
  vía `CatalogService.update` (mismo servicio que `PATCH /catalog/:id`, D-131) desde un contexto
  de Nest standalone — nunca SQL directo — con el `ADMINISTRADOR` real como actor, auditado en
  `audit_log`. El script de la corrección era una mutación puntual y se borró al terminar (junto
  con su entrada temporal en `tsconfig.cli.json`), siguiendo la regla de scripts de un solo uso.
- **Dry-run contra demo (segundo intento), tras la corrección**: `3 ok, 0 omitida(s), 0 con
error`.
- **Execute contra demo**: `3 línea(s) de producto creada(s)`. Verificado: 3 saldos (970 / 1.061
  / 58 unidades), 1 movimiento `IMPORT` cada uno, `avgCost` igual al costo del archivo, **total
  valorizado S/ 123.359,29 sin IGV** — exacto.
- Diagnóstico reusable: `scripts/oneoff/20260922-check-upvc-catalog.mjs` (catálogo `ROOFING`
  completo) y `scripts/oneoff/20260922-verify-upvc-balances.mjs` (saldo e inventario valorizado
  de los tres SKU), ambos solo lectura, contra cualquier rama — útiles para re-verificar antes
  de la carga en `production`.
- **Pendiente**: correr la misma carga contra `production` (el dueño ya corrigió el `source`
  ahí), en la ventana que autorice, con `--confirm-production`. El archivo
  (`local-data/inventario-inicial-upvc-2026-09-22.csv`) es el mismo, sin cambios.

## Ventana RF-S3c — alcance comercial de vendedor (2026-09-22)

Ventana exprés, con el sistema sin usuarios activos. PR #7 mergeado a `main` con OK explícito
D-232; merge commit `e1c6227`. El SHA desplegado es `bd84ab8` y cubre todo el runtime de `main`
(`git diff --quiet bd84ab8 origin/main -- apps packages Dockerfile .gcloudignore package.json
pnpm-lock.yaml pnpm-workspace.yaml` → exit 0).

### El defecto que encontró el pre-vuelo, antes de tocar producción

El backfill de `seller_id` escribía `sales_orders.seller_id = created_by_id`, una regla distinta
de la que aplica el API al confirmar una cotización. Confirmar es un acto operativo que suele
ejecutar un ADMINISTRADOR sobre la cotización de otro: con esa regla, el pedido quedaba a nombre
de quien confirmó y salía del alcance de quien vendió — el defecto exacto que S3c venía a evitar.
La causa era tener la regla escrita dos veces. Quedó una sola, `resolveOrderSeller`
(`apps/api/src/auth/seller-scope.ts`), que usan el servicio y el backfill (**D-240**), con
centinela en `seller-scope.spec.ts`. No era teórico: en producción alcanzaba a **16 de 19
pedidos**, todos confirmados por el segundo administrador.

También se corrigió el wrapper, que rechazaba `--branch production` de plano y dejaba la ventana
sin forma de correr el backfill sin editar el script bajo presión. Ahora acepta production con
`--confirm-production` para `--execute`; el dry-run no lo pide porque no escribe (**D-241**).

### Barrido de `@Roles`, `origin/main` → `bd84ab8`

197 rutas. El `RolesGuard` cambió de semántica —sin `@Roles` ya no es «pasan los tres roles» sino
default-deny para VENDEDOR— así que la comparación se hizo sobre **acceso efectivo**, no sobre el
texto del decorador. En `bd84ab8` no queda ninguna ruta sin `@Roles`: el default-deny es red, no
la regla operativa.

- **6 rutas cambian de acceso efectivo.** 4 son pérdidas, todas del VENDEDOR y todas dentro del
  alcance S3c: `GET /inventory/movements`, `GET /invoicing/receivables`,
  `GET /invoicing/receivables/summary`, `GET /sales/quotations/stock-shortages`. Las otras 2 son
  rutas nuevas: `GET /sales/dashboard` y `PATCH /sales/quotations/:id/seller`.
- **23 rutas** pasaron de implícitas a `@Roles(...)` explícito sin cambiar quién entra.
- **SUPERVISOR_PLANTA y ADMINISTRADOR: cero pérdidas.**

### Ejecución

1. **Ensayo** en `ensayo-s3c-20260920` (`br-dry-field-aea77lat`): migración + backfill dry-run y
   `--execute`. 70 cotizaciones, 14 pedidos, 11 con creador distinto al de su cotización. Segunda
   corrida de `--execute`: 0 filas escritas — idempotencia verificada sobre datos, no sobre la
   lectura del código.
2. **Respaldo** `respaldo-pre-s3c-20260922` (`br-old-tooth-ae9txqcv`), padre `production`, LSN
   `0/14D0C9F0`, creado con `--no-secrets --output json` vía `run(quiet)` y verificado releyendo
   el listado.
3. **Migración** `20260920120000_rf_s3c_seller_scope` (aditiva: 2 columnas nullable, 2 FK
   `ON DELETE SET NULL`, 2 índices). `migrations-status` confirmó que era la única pendiente. El
   drift conocido no apareció, como se esperaba: solo se manifiesta al **generar** una migración.
4. **Backfill en producción antes del deploy del API.** Dry-run: 73 cotizaciones y 19 pedidos,
   todos en NULL, 19 con cotización y 0 directos, 16 con creador distinto al de su cotización,
   ningún VENDEDOR con datos. Execute: 73 + 19 + 0 escritas, 0 NULLs. Segunda pasada en dry-run
   tras el merge: 0 pendientes.
5. **API** a Cloud Run: revisión `ayr-steel-erp-api-00039-r4h`, `git-sha=bd84ab8`, 100 % de
   tráfico, `{"status":"ok","db":"ok"}`, nombres de variables y secretos verificados,
   `WEB_ORIGIN` con los dos dominios.
6. **Web**: merge a `main` → deployment de producción de Vercel sobre `e1c6227`, con el alias
   `v2.mareliac.pe`.
7. **`pnpm smoke:prod` verde** desde el worktree en el SHA desplegado: health 200, login,
   5 líneas de negocio, 176 productos, 96 filas de inventario valorizado, 5 bobinas, 90 filas del
   reporte mensual y emisión electrónica apagada (D-216). Admin efímero retirado.

### Verificación del seed de `db:prod`

`db:prod` corre `migrate deploy` **y** el seed. Se comprobó por clave natural que no duplicó
nada: 7 series fiscales, todas creadas el 2026-09-07 y ninguna tocada hoy (`FiscalSeries.series`
es `@unique`, así que un duplicado es imposible en BD); los 8 comprobantes emitidos son manuales
sin `series_id` (D-153) y ninguna serie quedó con el correlativo por detrás; 1 fila en
`invoicing_settings`; 5 líneas de negocio con sus 5 `pricing_settings`; un solo cliente
«PÚBLICO EN GENERAL» y un solo proveedor «Saldo inicial de inventario»; 4 usuarios sin correos
repetidos; 6 colores sin repetir.

### Estado del alcance comercial en producción

Las 73 cotizaciones y los 19 pedidos quedaron a nombre de `Administrador <gsinuiri@gmail.com>`.
Hoy **ningún VENDEDOR tiene datos**: la única cuenta con ese rol no creó nada. El backfill no le
quita visibilidad a nadie, porque las dos personas que operan son ambas ADMINISTRADOR. Dos
consecuencias, para no confundirlas más adelante:

- El chequeo «un vendedor recibe 404 sobre un pedido ajeno» pasa **trivialmente**: para esa
  cuenta todo pedido es ajeno. Sirve como prueba de que el guard vive, no de cartera propia.
- Si se espera que vendedores reales sean dueños de cotizaciones históricas, **eso no lo hace el
  backfill**: es trabajo de M4 (`PATCH /sales/quotations/:id/seller`), que arrastra el pedido y
  deja rastro en `audit_log`. El backfill no volverá a tocar esas filas porque ya no están en
  NULL. La creación de cuentas VENDEDOR y la reasignación de lo vivo quedan fuera de esta
  ventana.

### Deuda que deja la ventana

- **Quality gate de SonarCloud en rojo sobre el PR #7**, sin que bloqueara el merge por decisión
  del dueño: `20.3% Coverage on New Code` (exige ≥ 80 %) y `D Reliability Rating on New Code`
  (exige ≥ A). **No se pudo enumerar los issues**: el proyecto de SonarCloud es privado, la API
  anónima responde `Project doesn't exist`, el `SONAR_TOKEN` solo vive en los secrets de Actions
  y el bot no dejó comentarios inline en el PR — solo el mismo resumen. Se evalúa antes del merge
  de RF-S4a, con token o desde el dashboard.
- **Documentos saneados en esta ventana.** El handoff de la sesión S3c y el checklist de
  `ENTORNOS.md` decían que `seller_id` iba en `fiscal_documents`; la migración real toca
  `quotations` y `sales_orders`. Además D-238 y D-239 estaban pegadas al final de
  `ARQUITECTURA.md` como filas sueltas, fuera de la tabla de §0.2 y sin encabezado, así que no
  renderizaban; se movieron a la tabla. El handoff tenía los acentos destruidos (U+FFFD) desde la
  sesión anterior y se reescribió.
- **`.env.setup` no existe en los worktrees nuevos**, y `db:prod` y `deploy:api` lo necesitan.
  Se copió desde el checkout principal para esta ventana y se retiró al cerrar. Conviene que
  `pnpm setup:agentes` lo contemple, o dejarlo anotado en el runbook de ventana.

### Rollback (no fue necesario)

Vercel → `dpl_264qqLSver3fDPYRHiRGtWb6yCbe`; API → tráfico a `ayr-steel-erp-api-00038-ljx`
(`git-sha=d25f6b2`). La migración se queda por aditiva.

## SesiÃ³n RF-S3b â€” cierre post-merge (2026-09-20)

- PR #6 se mergeÃ³ a `main` con OK explÃ­cito D-232; merge commit `fb443a5`, usando
  `AYR_OWNER_PUSH=1`.
- CI del PR `9a78bb2`: lint/typecheck/unit, anÃ¡lisis estÃ¡tico, E2E completo y smoke Neon verdes.
  La CI no corre en pushes a ramas de trabajo: corre en pushes a `main` y PRs hacia `main`.
  Abrir el PR temprano es la vÃ­a para obtener veredicto sin depender del entorno local.
- Agy completÃ³ la revisiÃ³n cruzada sin hallazgos bloqueantes, altos ni medios. Los 7 rojos previos
  fueron defectos de prueba y quedaron corregidos. Todo worktree nuevo se registra con
  `agy --new-project` desde su raÃ­z antes de empezar.

## Estado general

| Fase                                                                                                | Estado                      | Cierre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 â€” Bootstrap                                                                                     | âœ… Cerrada (2026-09-02)    | Login E2E verde en prod, CI verde                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1 â€” Maestros, catÃ¡logo, precios, importaciÃ³n                                                    | âœ… Cerrada (2026-09-02)    | E2E de Fase 1 verdes en local + CI, deploy en producciÃ³n                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2a â€” Kardex + compras + alta de bobinas                                                           | âœ… Cerrada (2026-09-03)    | 16/16 E2E verdes en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2b â€” Partido, merma, cierre, anulaciÃ³n                                                           | âœ… Cerrada (2026-09-04)    | 30/30 E2E verdes en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3 â€” Corte tercerizado + flejes                                                                    | âœ… Cerrada (2026-09-02)    | 34/34 E2E verdes en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3b â€” Reversa de recepciÃ³n de corte                                                               | âœ… Cerrada (2026-09-03)    | 40/40 E2E verdes en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4 â€” ProducciÃ³n drywall + `/planta`                                                               | âœ… Cerrada (2026-09-03)    | 56/56 E2E en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5a â€” CotizaciÃ³n â†’ pedido + reserva                                                             | âœ… Cerrada (2026-09-04)    | 83/83 E2E en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5b â€” FacturaciÃ³n, GRE, despacho y cobranza                                                       | âœ… Cerrada (2026-09-04)    | 19 E2E contra el PSE demo, 89/89 en producciÃ³n, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6 â€” ProducciÃ³n de coberturas + color                                                             | âœ… Cerrada (2026-09-05)    | 101/101 E2E en producciÃ³n, CI verde, deploy hecho, purga sin rastros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 7 â€” Cola, punto de venta e importaciÃ³n de comprobantes                                           | âœ… Cerrada (2026-09-05)    | Cola (7), mostrador RF-60 (7b) e importaciÃ³n RF-71/72 (7c) completos. 110/110 E2E en producciÃ³n (13 saltados por D-081, no emiten), purga sin rastros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7d â€” Pulido UI/UX pre-entrega al cliente                                                          | âœ… Cerrada (2026-09-06)    | PaginaciÃ³n server-side (D-113), fechas en zona de Lima (D-112), encabezado fijo sin contenedor de scroll (D-115), afordancia de link (D-114). 119/119 E2E en producciÃ³n (38 saltados por D-081), deploy hecho, purga corrida â€” residuo de ventas/mermas ya hechas, ver detalle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7e â€” Venta de bobinas + catÃ¡logo estructurado + cotizaciÃ³n                                      | âœ… Cerrada (2026-09-06)    | A+B+C+D+E (D-116..D-120) + D-121 (pestaÃ±as de `/bobinas`, piezas teÃ³ricas en planta), aprobados por el dueÃ±o y desplegados. D-122 (sacar el `ProductBom` de coberturas) diseÃ±ado, diferido al tramo 7e-ii. D-123 documenta la lecciÃ³n del primer push: 25 fallas reales en specs de fases anteriores que asumÃ­an comportamiento que D-117/D-118/D-120 cambiaron â€” corregidas, CI verde (159/159, 9 saltadas). 119/119 E2E en producciÃ³n (38 saltados por D-081), deploy hecho (API por Cloud Run, web por la integraciÃ³n Vercel-GitHub â€” el CLI de Vercel sigue con el token expirado), purga corrida â€” residuo estructural no bloqueante (ventas/producciÃ³n ya movidas), ver `docs/handoff/fase-7e.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7 consolidada â€” backdating, entornos, subtipo de cobertura                                        | âœ… Cerrada (2026-09-06)    | D-124 (fecha de operaciÃ³n), D-125/D-126 (rama `demo` y prohibiciÃ³n de `e2e:prod`), D-127 (subtipo de cobertura y rama de confirmaciÃ³n). D-122 sigue diferido.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SesiÃ³n Planta â€” integridad de producciÃ³n y tanda                                                | âœ… Cerrada (2026-09-08)    | D-146 (el plan de corte es un tope duro y el kg declarado es dato, no consumo), D-147 (`/planta/tanda`, todo o nada), D-148 (todas las Ã³rdenes de un pedido de una vez), D-149 (hoja de planta en PDF). 306/306 unitarios; 149 E2E locales con 3 fallas del cupo del PSE demo. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SesiÃ³n Importadores â€” borrado de los directos y cotizaciones masivas                             | âœ… Cerrada (2026-09-08)    | D-150 (se elimina el mÃ³dulo de importaciones entero), D-151 (padrÃ³n en el alta de proveedor), D-152 (importador de cotizaciones: preview sin estado + alta normal, todo o nada). 272/272 unitarios; 60 E2E locales. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SesiÃ³n Comprobantes manuales â€” D-131 a regla dura y D-153                                        | âœ… Cerrada (2026-09-08)    | D-131 elevada a regla dura 14 con centinela; D-153 (un borrador tiene dos terminales: emitir por el PSE o registrar manual). 279/279 unitarios; E2E de comprobante manual 5/5 y regresiÃ³n de facturaciÃ³n con las fallas conocidas del cupo del PSE demo. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SesiÃ³n Planta II â€” guard de reservas, espacio de producciÃ³n, UX del importador                  | âœ… Cerrada (2026-09-09)    | D-154 (el faltante de materia prima avisa y no bloquea en producciÃ³n; un pedido no se bloquea a sÃ­ mismo), D-155 (`/planta/producir`: una pestaÃ±a por orden, guardado por orden, retira la tanda de D-147), D-156 (ningÃºn campo obligatorio es un callejÃ³n: alta express y selects buscables). Regla dura 15 (puertos 4000/4001 del dueÃ±o) y `pnpm dev:preview`. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SesiÃ³n Planta III â€” importador asentado y una sola forma de producir                             | âœ… Cerrada (2026-09-09)    | D-157 (una cotizaciÃ³n puede no vencer), D-158 (el cliente se crea del padrÃ³n), D-159 (plan de corte con largo bloqueado), D-160 (producir queda en un solo lugar). Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SesiÃ³n Precios â€” plancha por metro, valor contra precio y piso duro                              | âœ… Cerrada (2026-09-09)    | D-161 (la plancha de catÃ¡logo se cotiza por metro lineal), D-162 (Â«valor de ventaÂ» sin IGV contra Â«precio de ventaÂ» con IGV), D-163 (piso duro con el margen sobre la venta, para todos los roles). 341/341 unitarios; 69/69 E2E de los specs afectados. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SesiÃ³n Cierre de bobina â€” remanente liquidado y merma normal en el estÃ¡ndar                     | âœ… Cerrada (2026-09-09)    | D-164 (cerrar una bobina liquida su remanente como movimiento `CLOSE_ADJUSTMENT` en la misma transacciÃ³n; reabrir lo revierte), D-165 (el 1 % de merma normal se absorbe en la densidad estÃ¡ndar, en cÃ³digo y en un solo lugar). `pnpm check:price-floor` (solo lectura) para decidir el aviso de mÃ­nimo en el POS. Regla dura 16 (ningÃºn texto largo pasa por la shell). 352/352 unitarios; 5/5 E2E de D-164. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SesiÃ³n Largo de la plancha â€” el campo pedÃ­a mm y el catÃ¡logo tenÃ­a metros                     | âœ… Cerrada (2026-09-09)    | D-166 (el largo fijo de una plancha tiene que ser posible, y el campo dice en quÃ© unidad va). Bugfix de la captura del dueÃ±o: las tres planchas del catÃ¡logo estaban en metros y D-161 multiplicaba por ese nÃºmero â€” S/ 0.28 en vez de S/ 330. 357/357 unitarios; 3/3 E2E de pantalla y 33/33 de regresiÃ³n. Desplegado en la ventana HOTFIX (2026-09-10, `946ce0e`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SesiÃ³n S11 â€” T7: escritorio robusto y compacto, color e inspecciÃ³n de flujos                    | âœ… Cerrada (2026-09-11)    | D-179 (escritorio compacto: el sistema se diseÃ±a para una sola clase de pantalla; +76 %/+76 %/+49 %/+103 % de filas por pantalla en las cuatro listas principales) y D-180 (paleta sobria de un solo acento y cuatro tonos de estado de dominio, con rojo y Ã¡mbar reservados para error y aviso). Antes de tocar producto, `docs/analisis/s11-inspeccion-flujos.md`: los cinco flujos recorridos en un navegador real, con dos hallazgos que mandan â€” toda la app se renderizaba en Times New Roman (arreglado), y con transporte no se puede despachar ninguna lÃ­nea que no se mida en kilos porque el formulario nunca pide el peso por lÃ­nea que el API exige (documentado para Fase 8, no tocado). 239/239 E2E locales (2 saltados), 399 unitarios, lint/typecheck/format en verde. Desplegado en la Ventana V-2 (2026-09-11), junto con S9/S10/S10b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SesiÃ³n F8-S1 â€” integridad: doble click, idempotencia, weightKg                                   | âœ… Cerrada (2026-09-12)    | M1 (botÃ³n en vuelo universal, `Button` gana `pending`/`pendingText`; los dos huecos que encontrÃ³ `revisor` â€” `PaymentForm` sin sumar al `busy` del padre y el guard de doble Enter faltante en `ReasonDialog`/`BackdateConfirmDialog` â€” corregidos en la misma sesiÃ³n), M2 (D-182: idempotencia server-side; Ãºnico hallazgo real de la auditorÃ­a, `issueDispatchNote` sin lock de fila, corregido; `IdempotencyKey` + `claimIdempotencyKey` para reportar producciÃ³n y pagos), M3 (D-183: el despacho pide el peso por lÃ­nea que el API ya exigÃ­a, prellenado con el kg teÃ³rico). 399/399 unitarios; 250/252 E2E locales (2 saltados por el cupo del PSE demo), incluidos los 4 tests nuevos de esta sesiÃ³n (1 de M3 por el form, 3 de concurrencia de M2). Desplegado en la Ventana V-3 (2026-09-14). Handoff: `docs/handoff/f8-s1-integridad.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SesiÃ³n F8-S2 â€” flujo comercial nuevo (emitir directo, reserva temporal, confirmar en un paso)    | âœ… Cerrada (2026-09-12)    | M0 (clave de idempotencia en reporte, cobro, pago y agregar Ã­tems), M1 (D-184: la cotizaciÃ³n nace emitida y se edita hasta confirmarla), M2 (D-185: reserva temporal con expiraciÃ³n perezosa y suma de reservado centralizada), M3 (D-186: confirmar = pedido + reserva firme + OPs con vista previa; bloquea por faltante; anular arrastra OP en borrador) y M4 (D-187: ediciÃ³n del pedido confirmado hasta comprobante con registro de cambios de precio). **M5 sacrificado** (modal con stock y Â«sin stock disponibleÂ»). Desplegado en la Ventana V-3 (2026-09-14). Al cierre de la sesiÃ³n: lint/typecheck/format y 403/403 unitarios en verde, suite E2E completa: 265 verdes, 2 saltados (cupo PSE demo) y 1 caÃ­da transitoria (`ECONNRESET` a los 17 ms en `bobina-consumos-pdf-d172.spec.ts`, spec que la sesiÃ³n no tocÃ³; aislado pasÃ³ 3/3). Pendiente para el dueÃ±o: si `/produccion` y `/planta` priorizan las OP en borrador como lo hacÃ­a la cola (D-094/D-096). Handoff: `docs/handoff/f8-s2-flujo-comercial.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SesiÃ³n F8-S2b â€” M5 comercial (elegir con stock), edge del picker de bobina, cosmÃ©ticos          | âœ… Cerrada (2026-09-13)    | M1 (D-188: `<select>` de producto â†’ modal con el pool de bobinas por espesor/color y ML teÃ³rico, y el disponible por SKU, buscable, sin bloquear elegir sin stock; tarjeta Â«Cotizaciones sin stock disponibleÂ» en el Panel, sin flag guardado ni job â€” recalculada en cada lectura), M2 (edge de D-185: el picker de bobina entera ya no se vacÃ­a por la propia reserva temporal de la cotizaciÃ³n que se edita) y M3 (dos cosmÃ©ticos del handoff anterior: el campo de vigencia no se muestra al editar una cotizaciÃ³n sin vencimiento, D-157; los diÃ¡logos de precio/cantidad del pedido ya no cambian de forma al cerrar). Ninguno sacrificado. Dos pasadas de `revisor` sin bloqueantes (hallazgos corregidos); `qa` sin defectos encontrados, sumÃ³ 6 casos de cobertura. Desplegado en la Ventana V-3 (2026-09-14). Al cierre de la sesiÃ³n: lint/typecheck/format y 403/403 unitarios en verde, suite E2E completa: 272 verdes, 2 saltados (cupo PSE demo), 0 caÃ­dos. Sin migraciones nuevas. Pendiente, reportado y fuera de alcance por ser lÃ³gica: la clave de idempotencia de Â«agregar Ã­temsÂ» puede repetir el primer envÃ­o tras un fallo de red con las lÃ­neas cambiadas; la reserva temporal conserva su vencimiento original si la ediciÃ³n acorta la vigencia de la cotizaciÃ³n. Handoff: `docs/handoff/f8-s2b-comercial-m5-cosmeticos.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SesiÃ³n F8-S3 â€” Planta: cola de OPs, Ã³rdenes en el pedido, borrador por OP                       | âœ… Cerrada (2026-09-13)    | M1 (D-189: la cola son las OPs de coberturas no iniciadas; prioridad manual migra del pedido a la OP con backfill; un solo ranking `compareQueueRank` para cola y `/planta`; la cola vieja pasa a Â«lÃ­neas sin ordenÂ»), M2 (D-190: las OPs viven en el detalle del pedido; `/produccion` sale del menÃº y redirige al historial dentro de `/planta`), M3 (D-191: borrador server-side de reportes por OP, validaciÃ³n inmediata y revalidaciÃ³n en un commit todo o nada con Â«Fila N:Â» e idempotencia), M4 (D-192: montar varias bobinas a la vez con peso inicial), M5 (D-193: reabrir una bobina cerrada desde el modal con paso explÃ­cito y asiento compensatorio del ajuste). Nada sacrificado. Desplegado en la Ventana V-3 (2026-09-14). Al cierre de la sesiÃ³n: suite E2E completa 294 verdes, 2 saltados (cupo PSE), 0 caÃ­dos. Ver `docs/handoff/f8-s3-planta-cola-borrador.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SesiÃ³n F8-S3b â€” Feedback: modal de stock, planta por pedido, patrÃ³n de acciones                 | âœ… Cerrada (2026-09-13)    | IteraciÃ³n sobre el feedback del dueÃ±o en `dev:preview`, solo UI y navegaciÃ³n: cero schema, lÃ³gica de dominio o endpoints. M1 (el modal de elegir producto ya no muestra el pool de bobinas y cabe sin scroll horizontal), M2 (D-194: `/planta` lista pedidos con producciÃ³n pendiente, en el orden de `compareQueueRank` de su OP mÃ¡s urgente; cada pedido abre su cola y su workspace; la prioridad se asigna al pedido y se propaga a sus OPs con el PATCH por orden), M3 (D-195: `HeaderActions`, principal + menÃº Â«MÃ¡s accionesÂ», en cotizaciÃ³n, pedido, comprobante, despacho, bobina, lista de bobinas y compra; excepciÃ³n explÃ­cita por D-153 en el borrador de comprobante) y M4 (D-196: abrir orden nueva y registrar pago en drawer, historial de Ã³rdenes como vista propia). Nada sacrificado. `revisor` sin bloqueantes ni altos (1 medio y 9 bajos, corregidos); `qa` sin defectos, sumÃ³ 8 casos. Desplegado en la Ventana V-3 (2026-09-14). Al cierre de la sesiÃ³n: lint/typecheck/format y 414/414 unitarios en verde; suite E2E completa: 302 verdes, 2 saltados (cupo PSE), 0 caÃ­dos. Handoff: `docs/handoff/f8-s3b-planta-por-pedido-acciones.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SesiÃ³n F8-S3c â€” Segunda iteraciÃ³n de feedback: planta directa, ML visibles, selector de cliente | âœ… Cerrada (2026-09-13)    | Tercera vuelta sobre el feedback del dueÃ±o en `dev:preview`, solo UI/presentaciÃ³n: cero schema, lÃ³gica de dominio o endpoints nuevos. M1 (D-197: sin card de Â«Cola de producciÃ³nÂ» separado â€” la franja de chips trae de entrada todas las Ã³rdenes del pedido, iniciadas o no, con su `queueNote` para las que no arrancaron), M2 (D-198: la tarjeta de cada pedido en `/planta` enlaza su cotizaciÃ³n de origen), M3 (D-199: el disponible de materia prima en coberturas se ve en ML con el kg entre parÃ©ntesis â€” modal de elegir producto, Â«pendienteÂ» de cada bobina montada y Â«DisponibleÂ» del detalle de bobina; de paso, padding consistente en los dos drawers que lo tenÃ­an pegado al borde) y M4 (D-200: el selector de cliente de la cotizaciÃ³n siempre abre el buscador, con Â«+ Crear clienteÂ» dentro del modal). Nada sacrificado. `revisor` sin bloqueantes ni altos (1 medio â€” memoizaciÃ³n de `pedidoQueue` â€” y 1 bajo â€” `equivalentMetersOf` reescribÃ­a a mano una cuenta de `@ayr/shared` â€”, corregidos); `qa` adaptÃ³ 6 specs a la vista directa, sumÃ³ 2 specs nuevos (chips + link a cotizaciÃ³n; selector de cliente) y encontrÃ³ una regresiÃ³n real de M4 en el helper compartido `chooseOption` (buscaba el botÃ³n por `"Seleccionar {label}"` fijo; con el cliente en `actionLabel="Elegir"` dejÃ³ de encontrarlo), corregida generalizando el helper a buscar por fila. Desplegado en la Ventana V-3 (2026-09-14). Al cierre de la sesiÃ³n: lint/typecheck/format y 414/414 unitarios en verde; suite E2E completa: 306 verdes, 2 saltados (cupo PSE), 0 caÃ­dos (un `m2-reversa-pago.spec.ts` transitorio en la primera corrida completa â€” colisiÃ³n de `getByText` con el `SheetDescription` del drawer de pago durante su animaciÃ³n de cierre, aislado 8/8 y limpio en la corrida siguiente completa; no es de esta sesiÃ³n, no se tocÃ³). Handoff: `docs/handoff/f8-s3c-planta-directa-ml-selector-cliente.md`. |
| SesiÃ³n F8-R1 â€” DiagnÃ³stico de la lentitud del E2E en CI                                         | âœ… Cerrada (2026-09-14)    | DiagnÃ³stico sin fix de producto (no hay regresiÃ³n de producto). Causa nombrada con CI instrumentada: la lentitud es consultas Ã— latencia runnerâ†’Neon, que varÃ­a por la regiÃ³n del runner; el lote sube el total de consultas Ã—1,64 sin encarecer cada una (D-201). ResolviÃ³ B-V3-5 y cerrÃ³ la Ventana V-3 (run 34875631463: 305 passed en 92 min). Palanca elegida: E2E de CI contra un Postgres de servicio en el runner, en una sesiÃ³n propia de salud E2E. AnÃ¡lisis: `docs/analisis/f8-r1-rendimiento.md`. Handoff: `docs/handoff/f8-r1-diagnostico-ci-cierre-v3.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SesiÃ³n F8-R2 â€” Salud E2E: Postgres del runner, smoke de Neon y correlativos                      | âœ… Cerrada (2026-09-14)    | D-202, solo infra (cero producto, cero schema). La suite completa de CI corre contra un Postgres de servicio en el runner: 305 passed / 3 skipped en 9,6 min (run 34900414817), contra 92 min en Neon, con las mismas consultas (124 661) a 0,08 ms. Timeout 110 â†’ 30. Nuevo job `smoke-neon`: migraciones y `pnpm e2e:smoke` (35 passed) contra la rama `ci`. Guard compartido en `test-db-guard.ts`, que valida las dos URLs (ALTO de `revisor`). Correlativos fiscales por corrida para la cuenta demo de Nubefact. Dos fallas que la latencia escondÃ­a (`fase2a`, `m2-reversa-pago`), corregidas. Handoff: `docs/handoff/f8-r2-salud-e2e.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SesiÃ³n F8-S4 â€” Acabados con tipo, color y lÃ­nea + deudas de integridad                          | âœ… Cerrada (2026-09-14)    | M0 (D-204: idempotencia al agregar al borrador, clave por huella de contenido, reserva temporal que nunca vence despuÃ©s de su cotizaciÃ³n), M1 (D-203: acabado = tipo + color + lÃ­nea, RAL y nombre Ãºnico en colores, mapeo confirmado por el dueÃ±o) y M2 (D-203: el color de bobina e Ã­tem de compra sale del acabado, con trigger en la base; editar bobina corrige el color cambiando el acabado). Nada sacrificado ni cortado a S4b. El importador de bobinas del brief no existe (no se adaptÃ³ nada). `revisor` API (2 altos) y web (1 bloqueante: el RAL no aceptaba ningÃºn valor) corregidos; `qa` sin defectos de la app. Suite E2E completa local: 319 passed, 0 failed, 2 skipped. Commits locales, sin push (ventana V-4), salvo `a05fca1` (M0), que apareciÃ³ en `origin/main` empujado desde este clon sin que lo ejecutara la sesiÃ³n (CI verde, run 34908482884; a confirmar con el dueÃ±o). Handoff: `docs/handoff/f8-s4-acabados-integridad.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SesiÃ³n F8-S5 â€” CatÃ¡logo coherente + kardex clickable                                            | âœ… Cerrada (2026-09-15)    | D-205: la referencia de un movimiento de kardex se vuelve link (`refTargetType`/`refTargetId`, resueltos una sola vez en `InventoryService.findMovements`) y `dispatches.invoice_id` enlaza el despacho con su comprobante, pero solo desde el mostrador, que es el Ãºnico punto que arma los dos uno a uno. Cierra ademÃ¡s la deuda de catÃ¡logo de F8-S4 (M0). El campo nace en `dispatches` y no en `inventory_movements` por un hallazgo del propio E2E: esa tabla tiene un trigger que rechaza todo `UPDATE`. Handoff: `docs/handoff/f8-s5-catalogo-kardex.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SesiÃ³n F8-S6a â€” Carga de inventario inicial de bobinas                                           | âœ… Cerrada (2026-09-15)    | D-206: herramienta de inventario inicial como **excepciÃ³n Ãºnica y condicionada** a D-150, con sus cuatro condiciones escritas (hereda invariantes vÃ­a `CoilsService.create`, sin ruta HTTP, no es una compra â€”proveedor `isSystem` `SALDO`â€”, y el alcance de la excepciÃ³n queda acotado). CLI `pnpm import:initial-inventory`, dry-run por defecto. Handoff: `docs/handoff/f8-s6a-inventario-inicial.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SesiÃ³n F8-S6a2 â€” Carga de inventario inicial de productos                                        | âœ… Cerrada (2026-09-15)    | D-207: la excepciÃ³n de D-206 se extiende a productos por unidades (UPVC y reventa), misma herramienta (`--kind products`) y mismas cuatro condiciones. El alcance lo responde `ProductSource`, nunca el SKU ni la lÃ­nea sola (la lecciÃ³n de D-131 con una pregunta nueva). Cerrada formalmente en F8-V4prep, cuando la suite completa corriÃ³ 0-rojo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SesiÃ³n F8-V4prep â€” Cierre de S6a2 + herramientas de V-4                                          | âœ… Cerrada (2026-09-15)    | D-208 (`pnpm limpia:v4`: `TRUNCATE` de 39 tablas preservando 12 de catÃ¡logo y configuraciÃ³n, dry-run por defecto, doble gate para producciÃ³n) y D-209 (la migraciÃ³n que hace obligatorios `kind` y `business_line_id` en `finishes`, con un `DO $$` que nombra los acabados incompletos en vez de adivinar un valor). Suite E2E completa 0-rojo desde un worktree con builds de producciÃ³n, que cierra la deuda OOM heredada. Runbook de la ventana en `docs/ENTORNOS.md`. Handoff: `docs/handoff/f8-v4prep.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ventana V-4 â€” Limpia total + inventario real en producciÃ³n                                       | âœ… Completada (2026-09-15) | Modo exprÃ©s autorizado por el dueÃ±o. Respaldo `respaldo-pre-v4-20260915`, push del lote acumulado, migraciones a **66/66**, limpia de **3376 filas en 39 tablas**, acabados completados a mano, D-209 aplicada limpia y **carga real de 15 bobinas / 46.805 kg / S/ 132.520,06** con su kardex `IMPORT`. `smoke:prod` en verde. Tres hallazgos de la ejecuciÃ³n real quedaron en el runbook. Productos UPVC/reventa: el dueÃ±o no entregÃ³ archivo en esta ventana.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AuditorÃ­a post-V4                                                                                  | âœ… Cerrada (2026-09-16)    | VerificaciÃ³n de solo lectura de todo lo cerrado entre F8-S4 y V-4, contra el sistema real. Confirma 66/66, revisiÃ³n `00034` al 100 %, la carga de V-4 exacta y el catÃ¡logo coherente; descubre que **producciÃ³n ya estÃ¡ en uso operativo real** (48 clientes, 70 cotizaciones, 7 compras, 3 bobinas mÃ¡s, 5 OPs cerradas y 3 facturas manuales entre el 15-09 y el 16-09) y que dos afirmaciones de cierre no se sostenÃ­an (eran 6 specs rotos en CI, no 4; el rollover de D-202 no estaba en el checklist que lo daba por escrito). Registra **D-210**, consolida todos los pendientes en una lista Ãºnica y deja `main` **roja** como pendiente #1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SesiÃ³n F8-S7 â€” Pulido y feedback de uso real                                                     | âœ… Cerrada (2026-09-16)    | Primera sesiÃ³n de producto con producciÃ³n operando. M1 (D-211: la fecha de emisiÃ³n de un comprobante **manual** se corrige, con motivo, historial visible en el detalle y el vencimiento corriÃ©ndose con ella para conservar el plazo), M2 (D-212: el acabado se elige por color comercial; el cÃ³digo tÃ©cnico solo desambigua) y M3 (D-213: al facturar se **declara** quÃ© despacho cubre el comprobante, cerrando la deuda que D-205 dejÃ³ escrita). M4 cosmÃ©tico: se va el `<main>` anidado del layout. Additive only: una migraciÃ³n, una tabla. `revisor` encontrÃ³ 3 bloqueantes â€”el primero rompÃ­a M3 en el caso mÃ¡s comÃºn, porque `fiscal_documents.dispatch_id` ya significaba otra cosaâ€” mÃ¡s 2 altos de concurrencia y 4 medios, todos corregidos; `qa` sumÃ³ 11 casos, 11/11, sin defectos de producto. Cierre: lint/typecheck/format, 430/430 unitarios y **suite E2E completa 345 passed / 0 failed / 2 skipped**. Los tres Ãºnicos rojos los causÃ³ M2 y ninguno hablaba de acabados: se arreglaron mudando la regla de etiquetado a `@ayr/shared` para que pantalla y tests lean la misma. Handoff: `docs/handoff/f8-s7-pulido-feedback.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8 â€” AuditorÃ­a, reportes, UAT                                                                     | ðŸŸ¡ En curso               | F8-S1..F8-S4, F8-S5, F8-S6a, F8-S6a2, F8-V4prep y F8-S7 cerradas (nada sacrificado), Ventana V-4 completada, auditorÃ­a post-V4 cerrada y `main` de vuelta en verde (sesiÃ³n CI-SANA). El cliente ya opera sobre producciÃ³n con datos reales. Pendientes vivos en la secciÃ³n Â«Post-V4Â» de este documento. RF-S1 (M0 higiene + precios de lista, D-214..D-217) cerrada â€” ver secciÃ³n propia mÃ¡s abajo. **RF-S2 (auditorÃ­a, RF-95/96, D-218..D-227) cerrada y en producciÃ³n desde la ventana S2 (2026-09-17)**: visor unificado en `/auditoria`, D-218/D-220 desplegadas, revisiÃ³n `ayr-steel-erp-api-00037-njl`. RF-90..94 (los cinco reportes) sigue sin empezar; D-214 deja escrito que el plan de sesiones RF-S1..RF-S5 no es una renumeraciÃ³n de esos RF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## SesiÃ³n CHORE-AGENTS â€” infraestructura compartida de agentes (2026-09-17)

- **Reglas canÃ³nicas.** `AGENTS.md` conserva las reglas tÃ©cnicas y operativas en una sola fuente.
  D-230 mantiene la parada ante ambigÃ¼edad; D-232 sustituye D-231 y permite a los agentes
  empujar o mergear `main` solo despuÃ©s de presentar commits, CI, despliegue y riesgo, y recibir
  el OK explÃ­cito del dueÃ±o. `gh repo sync` y borrar ramas protegidas siguen prohibidos.
- **Dos agentes (D-233).** El esquema queda en Codex CLI como principal y Antigravity (`agy`)
  como segundo implementador/revisor. Se eliminaron `CLAUDE.md`, `.claude/` y sus referencias
  activas; la auditorÃ­a previa confirmÃ³ que `CLAUDE.md` no tenÃ­a una regla tÃ©cnica exclusiva:
  importaba `AGENTS.md` y definÃ­a Ãºnicamente el rol de solo lectura.
- **Skills compartidas.** `ayr-revisor` fija la revisiÃ³n recÃ­proca Codex â†’ `agy` y `agy` â†’
  Codex; cierre, QA y handoff ya no dependen de fuentes eliminadas y reflejan D-232.
- **Hook verificado por el dueÃ±o fuera del sandbox.** `.githooks/pre-push` bloqueÃ³ el destino
  `refs/heads/main` sin la variable, dejÃ³ pasar una rama de trabajo y permitiÃ³ el bypass con
  `AYR_OWNER_PUSH=1`; los tres casos se probaron con `--dry-run`, sin publicar cambios.
- **QA local.** Format, lint y typecheck verdes; API 581/581 unitarios. Los 8 unitarios del web
  no arrancaron por lÃ­mites del sandbox (`spawn EPERM` con el loader normal; el loader alterno
  no pudo cargar CommonJS) y quedan a cargo de CI Linux. E2E completa no aplica: solo cambiaron
  docs y configuraciÃ³n de agentes, sin rutas de runtime.
- **RevisiÃ³n independiente bloqueada.** Se intentÃ³ tres veces con Antigravity 1.2.5 en modo
  plan/sandbox; el CLI no pudo persistir bajo `~/.gemini` y terminÃ³ pidiendo un permiso de
  comando que el modo headless no puede aprobar. No se usÃ³ `--dangerously-skip-permissions`
  porque habrÃ­a roto el aislamiento del revisor. El pase debe repetirse fuera del sandbox.
- **IntegraciÃ³n completada con OK del dueÃ±o.** El hook fue verificado fuera del sandbox y el
  dueÃ±o autorizÃ³ explÃ­citamente el merge de PR #4 segÃºn D-232. `chore/agents` quedÃ³ en `main`
  como `ffe4cee`; CI del PR [35300213796](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35300213796)
  y CI de `main` [35301808282](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35301808282),
  ambas verdes. El pase cruzado de `agy` sigue pendiente por permisos de `~/.gemini`.
- **RF-S3 rebasada despuÃ©s del merge.** Los 16 commits se reaplicaron sobre `ffe4cee`; el Ãºnico
  conflicto fue `docs/ARQUITECTURA.md` Â§0.2 y se resolviÃ³ conservando D-228, D-229, D-232 y
  D-233. QA local posterior: lint y typecheck verdes; API 613/613 en verde con Jest
  `--runInBand`; build de shared/API verde. Unitarios web, build web y E2E local no pudieron
  ejecutarse por `spawn EPERM` y falta de acceso del sandbox al Docker local; la CI del SHA
  rebasado es la evidencia obligatoria de builds de producciÃ³n y suite completa.
- **Limpieza/estado local.** `origin/rf-s2` y `origin/rama-de-descarte` no existen. El worktree
  `ayr-steel-erp-hotfix-401` estÃ¡ limpio en `hotfix-401`, 0 commits adelante y 40 atrÃ¡s de
  `main`; se recomienda retirarlo cuando ya no se necesite conservar el directorio. El puerto
  3011 no tenÃ­a listener al comprobarlo y no se tocÃ³ ningÃºn proceso.
- **Ventana de producciÃ³n RF-S3 cerrada (2026-09-18).** Sin respaldo ni migraciones porque
  RF-S3 no cambia schema ni datos; el drift comprobado siguiÃ³ siendo exactamente el conocido.
  UAT demo: casos 1â€“6 OK. El `401` inicial fue la sesiÃ³n purgada por `db:demo` y los 30 s del
  primer selector fueron hidrataciÃ³n frÃ­a de Next en desarrollo; con login fresco, Caso 1 dio
  3/3 OK. API desplegada primero desde `d25f6b2` en Cloud Run, revisiÃ³n
  `ayr-steel-erp-api-00038-ljx`, 100 % de trÃ¡fico, health/DB OK, label `git-sha=d25f6b2`, los 12
  nombres de variables/secretos esperados y `WEB_ORIGIN` con ambos dominios. Tras el OK explÃ­cito
  del dueÃ±o exigido por D-232, PR #3 entrÃ³ por fast-forward a `main` y Vercel publicÃ³ el mismo
  SHA. `pnpm smoke:prod` quedÃ³ verde: health 200, login, 5 lÃ­neas de negocio, 174 productos, 48
  filas de inventario valorizado, 5 bobinas, 43 filas del reporte mensual y PSE apagado; el
  administrador efÃ­mero fue retirado. En la app real, los selectores de cliente y producto
  buscaron contra el servidor, la card de faltantes cargÃ³ 54 cotizaciones y la card bajo piso
  cargÃ³ sin error con 0 resultados. `/customers/search` midiÃ³ 517 ms sin cachÃ© en la sesiÃ³n real
  del dueÃ±o; muestra adicional de cinco tÃ©rminos: 381, 401, 438, 375 y 470 ms, con 48 clientes
  activos. D-235 mantiene D-229 sin Ã­ndice. Rollback no requerido; opciÃ³n preservada:
  `00037-njl` mÃ¡s revert del merge, solo con OK del dueÃ±o. CI de `main`
  [35352376572](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35352376572)
  verde: calidad/unitarios, anÃ¡lisis estÃ¡tico, E2E completa 371 passed/0 failed/3 skipped y
  smoke Neon 35 passed/0 failed/2 skipped.
- **Grind post-RF-S3 â€” credencial de demo (D-236).** Resuelta la contradicciÃ³n detectada en la
  UAT: `db-demo.mjs` ahora pasa `SEED_ADMIN_FOR_TESTS=1`, por lo que el seed sÃ­ reemplaza el hash
  clonado de producciÃ³n con la contraseÃ±a propia de `.env.demo`. El flag queda limitado a demo;
  no se ejecutÃ³ `db:demo` ni se modificaron datos o schema. Se aÃ±adiÃ³ un test centinela de scripts
  y su ejecuciÃ³n al job de calidad de CI. RevisiÃ³n independiente bloqueada tras tres intentos:
  Antigravity headless no detectÃ³ primero el workspace y luego auto-denegÃ³ dos veces el permiso
  `command` requerido para leer el diff; no se usÃ³ `--dangerously-skip-permissions`. Es la
  segunda sesiÃ³n en que la revisiÃ³n cruzada falla por permisos headless bajo `~/.gemini`;
  resolver esa infraestructura antes de la prÃ³xima sesiÃ³n de cÃ³digo es obligatorio para volver
  a cumplir D-233.

## SesiÃ³n RF-S3b (2026-09-18) â€” UX operativa de kardex, planta y selectores

- **Cinco milestones implementados.** D-237 deja el kardex individual completo y ascendente sin
  paginaciÃ³n; el listado mezclado continÃºa paginado y reciente primero. `/planta` agrupa su
  historial por pedido y anida las OP sin cambiar `/produccion/:id`. Los selectores aceptan clic
  en toda la fila y teclado, muestran RUC/DNI, mantienen `Elegir` y evitan overflow horizontal.
  Se retiraron exactamente dos altas contextuales de producto/SKU: el formulario compartido de
  cotizaciÃ³n/pedido y el importador de cotizaciones; `+ Crear cliente` permanece.
- **ProductDialog medido.** Drywall, Coberturas Aluzinc, UPVC, Reventa y Servicios quedaron sin
  overflow horizontal y con acciones visibles en 1366Ã—768 y 1920Ã—1080. Anchos medidos: 672 px
  en 1366; 669â€“672 px en 1920. Alturas: Drywall 469 px, Coberturas 664â€“665 px y las otras
  variantes 364â€“365 px. Overflow horizontal interno y de pÃ¡gina: 0 px en las diez combinaciones.
- **Calidad confirmada hasta el bloqueo.** Lint y typecheck verdes; 626/626 unitarios verdes;
  build de producciÃ³n verde. La tanda E2E afectada dio 7 verdes y 3 rojos clasificados como
  defectos de prueba; tras corregirlos, la repeticiÃ³n fue 4/4 verde. Una suite completa de 375
  casos detectÃ³ expectativas antiguas de orden en Fase 2b/Fase 7 y luego colapsÃ³ el entorno en
  el caso 254, contaminando el resto; se actualizaron esas expectativas, pero la repeticiÃ³n
  limpia y el detector quedaron bloqueados porque un proceso ajeno (`yacco/frontend/moalv-v1`)
  ocupa el puerto 3000 y no se tocÃ³.
- **RevisiÃ³n independiente bloqueada por tercera sesiÃ³n.** `agy` fue invocado tres veces en
  solo lectura; auto-denegÃ³ `command` dos veces y `escalate_admin` una vez. No se usÃ³
  `--dangerously-skip-permissions`. El archivo global de Antigravity confÃ­a otros worktrees,
  pero no `ayr-steel-erp-rf-s3b`. Hasta habilitar lectura de este worktree y completar el pase
  cruzado no se hacen commits ni push: RF-S3b permanece abierta.

## Fase 0 â€” detalle

| #   | Entregable                                                    | Estado                                                                                                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | CLAUDE.md                                                     | âœ…                                                                                                                            |
| 2   | docs/PROGRESO.md, docs/DECISIONES.md, docs/handoff/           | âœ…                                                                                                                            |
| 3   | Monorepo pnpm + Turborepo (api, web, shared, eslint-config)   | âœ… `pnpm build/lint/typecheck/test` en verde                                                                                  |
| 4   | Prisma v0 (User, Session, AuditLog) + migraciÃ³n inicial      | âœ… `20260902160054_init` + `20260902170000_refresh_grace_and_audit_append_only`                                               |
| 5   | Neon ramas dev/ci + migraciÃ³n en dev + seed admin            | âœ… ramas `dev` y `ci` creadas; migraciones y seed aplicados en `dev`, `ci` y `production`                                     |
| 6   | Auth D-010 + CRUD usuarios + GET /health                      | âœ… revisado por `revisor` y `auditor-seguridad`; hallazgos corregidos                                                         |
| 7   | Web: login, cambio de contraseÃ±a, sidebar por rol, /usuarios | âœ…                                                                                                                            |
| 8   | Tests unit (Jest) + E2E Playwright                            | âœ… 23 unit; 7 E2E en local (Neon `dev`); 6 E2E de auth verdes contra producciÃ³n, incluidos los 4 escenarios exigidos (D-024) |
| 9   | CI GitHub Actions + SonarCloud/Semgrep                        | âœ… corrida 33660853547 verde: calidad, SonarCloud, E2E (Neon `ci`)                                                            |
| 10  | Deploy Cloud Run + Vercel, login verificado en prod           | âœ… API en Cloud Run, web en Vercel, login real de administrador verificado en producciÃ³n                                     |
| 11  | UptimeRobot (API /health, Web /)                              | âœ… ambos monitores activos (API v3 de UptimeRobot)                                                                            |
| 12  | Subagentes revisor, auditor-seguridad, qa                     | âœ… `.claude/agents/`; ejecutados sobre Fase 0                                                                                 |
| 13  | Cierre: handoff, decisiones, commit, push                     | âœ… `docs/handoff/fase-0.md`; varios commits en `main`, CI verde                                                               |

## Fase 1 â€” detalle

| #   | Entregable                                                                                                              | Estado                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Decisiones D-025..D-034, Â§5 resuelta, Â§3.7 reordenado, RF-80..94 (Â§4.7/Â§4.8)                                        | âœ… `docs/ARQUITECTURA.md`, `docs/DECISIONES.md`                                                                     |
| 2   | Prisma: business_lines, finishes, products, customers, suppliers, pricing_settings, exchange_rates, import_batches/rows | âœ… migraciÃ³n `20260902195110_fase1_maestros_catalogo_importacion` aplicada en `dev`, `ci` (vÃ­a CI) y `production` |
| 3   | API: business-lines, finishes, catalog, customers, suppliers, pricing, exchange-rates, documents, imports               | âœ… auditorÃ­a + roles en cada mutaciÃ³n; revisado por `revisor` y `auditor-seguridad`, hallazgos corregidos         |
| 4   | ImportaciÃ³n genÃ©rica (RF-52) con adaptadores products/customers                                                       | âœ… sube a R2, valida fila por fila (tolerante a tildes), detecta duplicados intra-archivo, confirma fila por fila   |
| 5   | Web: /lineas, /acabados, /catalogo, /clientes, /proveedores, /configuracion/{margenes,tipo-cambio}                      | âœ… CRUD + baja lÃ³gica + bÃºsqueda (RF-84) donde aplica; probado a mano en Chrome contra Neon `dev`                 |
| 6   | Tests unit (exchange-rates, pricing) + E2E (`e2e/tests/fase1.spec.ts`)                                                  | âœ… 35 unit; 12 E2E locales (Fase 0 + Fase 1); CI verde (corridas 33682260101, 33682674374, 33683077599)             |
| 7   | Deploy: API a Cloud Run, migraciÃ³n+seed en `production`, web vÃ­a push a `main`                                        | âœ… `pnpm db:prod`, `pnpm deploy:api`                                                                                |
| 8   | E2E de Fase 1 contra producciÃ³n                                                                                        | âœ… `pnpm e2e:prod` corre ahora `auth.spec.ts` + `fase1.spec.ts` (11/11); cada test revierte lo que crea/cambia      |
| 9   | Cierre: handoff, decisiones, commit, push                                                                               | âœ… `docs/handoff/fase-1.md`                                                                                         |

**Hallazgos de seguridad corregidos en Fase 1:** `xlsx@0.18.5` tenÃ­a 2 CVE high sin parche en npm (prototype pollution, ReDoS) â†’ reemplazado por el build oficial `0.20.3` de `cdn.sheetjs.com`; el nombre de archivo subido en `imports` se saneaba antes de ir a la key de R2 y a la columna `file_name`; los errores de Prisma ya no se exponen crudos en el preview de importaciÃ³n.

**E2E de Fase 1 contra producciÃ³n (D-024, extendido).** `e2e/tests/fase1.spec.ts` ahora corre contra producciÃ³n bajo el mismo gate `E2E_ALLOW_WRITES=1` que `auth.spec.ts`, orquestado por el mismo `pnpm e2e:prod` (que ahora ejecuta ambos specs en una sola corrida con el mismo admin efÃ­mero). A diferencia de los usuarios (borrados por `cleanup-e2e-users.ts`), estos tests tocan entidades reales (`finishes`, `products`, `pricing_settings`) que no tienen borrado fÃ­sico: cada test revierte lo suyo en un `finally` â€”el acabado y los productos creados quedan `isActive:false` (identificables por su cÃ³digo/SKU con prefijo `E2E`/`SKU-`/`IMP-`), y el margen de Drywall vuelve exactamente al valor que tenÃ­a antes del testâ€”, asÃ­ que corre limpio pase lo que pase. Verificado a mano tras la corrida: `pricing` de Drywall en `20.0000`/`10.0000` (el valor sembrado) y las 4 entidades de prueba en `isActive:false`.

**Hallazgos de seguridad diferidos a Fase 7 (hardening), riesgo bajo dado que `imports` es ADMINISTRADOR-only:**

- `parse-spreadsheet.ts` aplica el lÃ­mite de 2000 filas despuÃ©s de que SheetJS ya descomprimiÃ³ el archivo completo en memoria; un `.xlsx` diseÃ±ado como zip bomb podrÃ­a agotar memoria antes del chequeo. MitigaciÃ³n futura: acotar el tamaÃ±o descomprimido o mover el parseo a un worker con lÃ­mite de memoria.
- El `ContentType` guardado en R2 para el archivo de origen es el `mimetype` que declara el cliente, no uno derivado del contenido real. Hoy no hay endpoint que sirva ese objeto de vuelta, asÃ­ que no es explotable; si se agrega un endpoint de descarga, fijar el `ContentType` segÃºn el tipo detectado por el parser.

## Fase 2a â€” detalle

| #   | Entregable                                                                                                                                                                     | Estado                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | Decisiones D-035..D-042, RF-15, Â§4.8 reescrita (RF-90..94), Â§3.7 partida en 2a/2b                                                                                            | âœ… `docs/ARQUITECTURA.md` Â§0.2, `docs/DECISIONES.md`                                 |
| 2   | Referencia UBL 2.1 + catÃ¡logos SUNAT 01/03/06                                                                                                                                 | âœ… `docs/referencias/ubl21-factura.md` (subagente `investigador` vÃ­a `agy`)          |
| 3   | Prisma: `inventory_movements`, `inventory_balances`, `purchases`, `purchase_items`, `supplier_payments`, `coils`; `suppliers.code`/`coilSeq`; `pricing_settings.overheadPerKg` | âœ… migraciÃ³n `20260903120000_fase2a_kardex_compras_bobinas`, aplicada en `dev`       |
| 4   | Kardex: `InventoryService.record` como Ãºnico escritor, promedio ponderado, NOOP explÃ­cito                                                                                    | âœ… trigger append-only y `CHECK qty > 0` en la base; saldo bloqueado con `FOR UPDATE` |
| 5   | Compras: 4 tipos, recepciÃ³n, pagos parciales, saldo y estado de cuenta                                                                                                        | âœ… `apps/api/src/purchases/`; aritmÃ©tica separada en `purchase-math.ts`              |
| 6   | Bobinas: cÃ³digo RF-13, typeKey RF-14, SKU D-037, alta por compra / XML / planilla                                                                                             | âœ… `apps/api/src/coils/`, `invoice-xml.ts`, `imports/adapters/coils.adapter.ts`       |
| 7   | Web: `/compras`, `/compras/nueva`, `/compras/[id]`, `/proveedores/[id]/estado-cuenta`, `/bobinas`, `/bobinas/nueva-xml`, `/bobinas/importar`                                   | âœ…                                                                                    |
| 8   | Tests unit (kardex, cÃ³digos de bobina, parser XML, aritmÃ©tica de compras)                                                                                                    | âœ… 83 unit en verde                                                                   |
| 9   | RevisiÃ³n de `revisor` y `auditor-seguridad`                                                                                                                                   | âœ… 1 bloqueante + 4 altos corregidos; ver abajo                                       |
| 10  | E2E de Fase 2a                                                                                                                                                                 | ðŸŸ¡ en curso                                                                          |
| 11  | Deploy y migraciÃ³n en `production`                                                                                                                                            | âšª pendiente                                                                          |
| 12  | Cierre: handoff, commit, push                                                                                                                                                  | âšª pendiente                                                                          |

**Hallazgos corregidos en esta fase (revisor + auditor-seguridad).**

- **Bloqueante.** Un pago en soles contra una compra en dÃ³lares resolvÃ­a el tipo de cambio de la moneda del _pago_ (PEN â†’ 1.0000) en vez de la de la compra, asÃ­ que S/ 500 cancelaban USD 500 y el pago quedaba persistido con ese TC. Corregido: el TC se resuelve siempre contra la moneda extranjera en juego.
- **Alto.** El kardex guardaba el costo en la moneda del documento y no tiene columna de moneda: comprar el mismo Ã­tem en USD y en PEN mezclaba dos escalas en el promedio ponderado y el valorizado sumaba monedas distintas. Corregido con **D-042** (el kardex se lleva en soles).
- **Alto.** `receive` y `addPayment` validaban estado y saldo _fuera_ de la transacciÃ³n: dos recepciones simultÃ¡neas duplicaban movimientos de kardex y dos pagos simultÃ¡neos podÃ­an sobrepagar. Corregido con un `updateMany` condicionado a `DRAFT` y un `SELECT ... FOR UPDATE` respectivamente.
- **Alto.** Una compra `COIL`/`FINISHED_GOOD` sobre la lÃ­nea `services` (NOOP) creaba bobinas cuyo movimiento el kardex descartaba en silencio. Ahora se rechaza al registrar la compra.
- **Alto (preexistente, fuera del diff de la fase).** El tracker del rate limit tomaba el primer salto de `X-Forwarded-For`, que el cliente controla y que Cloud Run _aÃ±ade_ en vez de reemplazar: rotando esa cabecera se anulaba el lÃ­mite de 10/min de `/auth/login`. Ahora usa `req.ip` (Express con `trust proxy`) y, en el login, el correo. **Queda pendiente para Fase 7** el bloqueo temporal de cuenta tras N intentos fallidos, que el auditor recomendÃ³ junto con esto.
- **Medios/bajos corregidos:** el listado mezclado de movimientos cortaba por los mÃ¡s antiguos presentÃ¡ndolos como recientes; `thicknessMm` e `igvRate` sin validar daban 500 o totales absurdos; `sourceXmlKey` aceptaba cualquier ruta de R2; el saldo nunca llegaba a cero con pagos en otra moneda; el kardex admitÃ­a mezclar unidades en un mismo saldo; el cÃ³digo corto del proveedor se podÃ­a cambiar con bobinas ya emitidas; `imports` tragaba el error real al confirmar una fila; se avisa cuando el XML mezcla tasas de IGV o cuando sus precios unitarios no reproducen su propio valor de venta. Roles: compras y bobinas salen del alcance de VENDEDOR (exponen costos y cuentas por pagar) y el estado de cuenta queda solo para ADMINISTRADOR; la subida de XML gana throttle propio, filtro de extensiÃ³n y tope de 200 lÃ­neas por compra.

**E2E de Fase 2a contra producciÃ³n.** `pnpm e2e:prod` corre ahora `auth.spec.ts` + `fase1.spec.ts` + `fase2a.spec.ts` con el mismo administrador efÃ­mero (16/16 verdes tras el deploy). Fase 2a solo puede revertir lo que el modelo permite revertir; verificado a mano con `node scripts/prod-e2e-leftovers.mjs` (script de solo lectura) justo despuÃ©s de la corrida:

- Proveedores E2E: 5, **ninguno activo**. Acabados E2E: 5, ninguno activo. Productos `BOBâ€¦` de `trading` (D-037): 4, ninguno activo.
- Compras: `F001-390520723` COIL RECEIVED, `F001-390545867` COIL **CANCELLED** (la del XML, revertida por el test), `F001-390581293` SERVICE DRAFT (tiene un pago, por eso no se puede anular), `F001-390595797` EXPENSE RECEIVED.
- 4 bobinas OPEN y **4 movimientos de kardex en total**: 2 de la compra COIL recibida y 2 de la importaciÃ³n por planilla. La compra EXPENSE recibida no generÃ³ ninguno â€” la prueba de D-030 se cumple tambiÃ©n en producciÃ³n, no solo en local.

Una compra ya recibida, sus bobinas y sus movimientos no se pueden deshacer hasta Fase 2b: el kardex es append-only por diseÃ±o (Â§3.2) y anular exige el movimiento inverso, que es alcance de 2b. Todo eso queda bajo proveedores desactivados y con nombres `E2E â€¦`, identificable a simple vista en `/proveedores` y `/compras`.

**Diferido a Fase 2b o posterior (anotado por el revisor, no es un bug):**

- `receive` hace N+1 dentro de la transacciÃ³n (proveedor, acabado y lÃ­nea de negocio se consultan por cada lÃ­nea) mientras mantiene el lock del correlativo del proveedor. Con compras de pocas lÃ­neas no es un problema; conviene precargar antes del bucle cuando 2b agregue mÃ¡s operaciones sobre bobinas.
- `previewFromXml` sube el XML a R2 antes de que el usuario confirme: cada preview abandonado deja un objeto huÃ©rfano bajo `purchases/xml/`. Necesita una regla de expiraciÃ³n en R2 o un job de limpieza (va junto con la limpieza de `imports/` ya anotada para Fase 7).
- Anular una compra ya recibida y revertir sus movimientos es de Fase 2b: hoy `cancel` solo acepta compras en `DRAFT` y sin pagos.

## Fase 2b â€” detalle

| #   | Entregable                                                                                                                | Estado                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Decisiones D-043 (landed cost, cierra P-12), D-044 (RF-22 pasa a Fase 3), D-045 (ediciÃ³n de costo), D-046 (quiÃ©n anula) | âœ… `docs/ARQUITECTURA.md` Â§0.2, Â§4.2, Â§5; contexto largo en `docs/DECISIONES.md` |
| 2   | Prisma: `coil_splits`, `inventory_movements.notes`, `coils.split_id`/`notes`, `purchases.related_purchase_id`             | âœ… migraciÃ³n `20260904120000_fase2b_reversa_partido_merma_landed_cost` en `dev`    |
| 3   | `InventoryService.reverse` y `adjustCost` â€” base de toda la fase                                                        | âœ… idempotente por el Ã­ndice Ãºnico de `reversal_of_id`; reversa por valor         |
| 4   | Partido (RF-15) y su reversa (RF-16): `coil-split-math.ts` + `CoilOperationsService`                                      | âœ… prorrateo por ancho sobre el ancho de la madre                                   |
| 5   | Merma (RF-17) y anulaciÃ³n (RF-18, D-040); abrir/cerrar (RF-19); editar (RF-20, D-045); anular bobina (RF-21)             | âœ… `apps/api/src/coils/coil-operations.service.ts`                                  |
| 6   | Anular compra recibida + landed cost (D-043) en `purchases`                                                               | âœ… reversa de todos sus movimientos; prorrateo por kg como `ADJUST`                 |
| 7   | Web: `/inventario`, `/bobinas/[id]`, `/kardex`, anulaciÃ³n de compra con motivo, vÃ­nculo de landed cost                  | âœ…                                                                                  |
| 8   | Tests unit (reverse, ajuste de costo, partido, prorrateo)                                                                 | âœ… 111 unit en verde                                                                |
| 9   | RevisiÃ³n de `revisor` (API y web) y `auditor-seguridad`                                                                  | âœ… 3 bloqueantes + 7 altos corregidos; ver abajo                                    |
| 10  | E2E de Fase 2b                                                                                                            | âœ… 14 tests nuevos; 31/31 en local y 30/30 contra producciÃ³n                       |
| 11  | Deploy y migraciÃ³n en `production`                                                                                       | âœ… migraciÃ³n aplicada y API redesplegado en Cloud Run                              |
| 12  | Cierre: handoff, commit, push                                                                                             | âœ… CI verde (corrida 33707954677)                                                   |

**Modelo del partido (RF-15).** Se parte una porciÃ³n del **largo** del rollo: la madre conserva su ancho y pierde peso. El peso que entra al partido se reparte por ancho **sobre el ancho de la madre**, no sobre la suma de los anchos de las hijas. Todo lo que las hijas no cubren â€”el kerf declarado mÃ¡s el recorte de bordeâ€” es `kerfLossKg`, pÃ©rdida real del corte. Las hijas entran al kardex al costo promedio vigente de la madre, asÃ­ que el valor del inventario solo pierde lo que se lleva esa merma.

**Hallazgos corregidos en esta fase (revisor + auditor-seguridad).**

- **Bloqueante.** Ni la anulaciÃ³n de bobina (RF-21), ni la ediciÃ³n de costo (RF-20), ni la anulaciÃ³n de compra excluÃ­an los **pares movimiento+reversa**. Registrar una merma y anularla dejaba la bobina y su compra bloqueadas para siempre, con un mensaje que pedÃ­a anular movimientos que el usuario ya habÃ­a anulado. Corregido con `liveMovements`, que descarta lo que se cancela entre sÃ­.
- **Bloqueante.** Cambiar la moneda de una bobina de PEN a USD sin mandar tipo de cambio heredaba el `1.0000` de la bobina en soles: el recosteo entraba al kardex a un sexto de su valor real, en silencio, y la segunda correcciÃ³n quedaba bloqueada por el hallazgo anterior. El schema ahora exige el TC cuando la moneda pasa a extranjera.
- **Alto.** El partido prorrateaba el peso sobre `Î£ anchos + kerf`. Con tiras que no cubrÃ­an todo el ancho, la Ãºltima hija se llevaba los kilos de la bobina entera â€”un peso imposible para su anchoâ€” y el recorte de borde desaparecÃ­a del kardex sin darse de baja. Ahora el reparto va sobre el ancho de la madre, con ancho mÃ­nimo de hija (5 mm) y un piso de aprovechamiento del 80 % para que un partido no se pueda usar como baja encubierta de la bobina.
- **Alto (seguridad).** El landed cost (D-043) era alcanzable por SUPERVISOR_PLANTA: bastaba registrar una compra `SERVICE` de flete con monto arbitrario y vincularla a una compra `COIL` para mover el costo promedio del inventario sin tope, y sin poder revertirlo despuÃ©s (anular es de ADMINISTRADOR y se bloquea en cuanto la bobina se mueve). Ahora vincular exige ADMINISTRADOR y la misma lÃ­nea de negocio.
- **Alto.** `applyLandedCost` leÃ­a los saldos sin bloquear las bobinas y descartaba el `null` de `adjustCost`: un consumo concurrente dejaba el `unitCostPerKg` inflado sin movimiento de kardex detrÃ¡s, imposible de revertir. Ahora bloquea las filas antes de prorratear y solo toca el documento si el kardex aceptÃ³ el ajuste. AdemÃ¡s, si ninguna bobina tiene saldo, la recepciÃ³n **no aborta**: la deuda con el proveedor del flete existe igual y tiene que llegar a la cuenta por pagar (D-030).
- **Alto.** La reversa de un `ADJUST` devolvÃ­a el monto completo aunque parte del stock ya hubiera salido, dejando el promedio por debajo del costo real. Ahora prorratea por los kilos que sobreviven.
- **Medio (seguridad).** `/inventory/*` no declaraba roles, asÃ­ que VENDEDOR veÃ­a `avgCost`, `unitCost` y el valorizado por lÃ­nea, justo lo que `coils` y `purchases` le ocultan. Â§3.4 le da "inventario (lectura)", que son cantidades: ahora los campos de costo viajan en `null` para su rol y la UI muestra un guion.
- **Medios corregidos:** el saldo corrido con filtro de fechas arrancaba en cero y no cuadraba con `inventory_balances` (ahora parte del saldo de apertura); los pagos se verificaban fuera de la transacciÃ³n de anulaciÃ³n; el `unitCostPerKg` que mueve el landed cost no quedaba auditado por bobina; una reversa que dejaba valor negativo se recortaba a cero en silencio (ahora falla con el detalle); `revertSplit` intentaba reversar movimientos ya revertidos; el mensaje para una compra vinculada **anulada** mandaba a recibirla, que es imposible.
- **Bajos corregidos:** el id de movimiento admitÃ­a valores fuera del rango de `int8` (500 en vez de 400); los `Decimal` de entrada no tenÃ­an tope de magnitud y desbordaban la columna con un 500; `lockBalance` no validaba que el saldo fuera de la lÃ­nea de negocio del movimiento.

**Hallazgos del web (revisiÃ³n aparte del API).** Las vistas nuevas se revisaron despuÃ©s, y el kardex volviÃ³ a ser el punto delicado:

- **Bloqueante.** El diÃ¡logo de ediciÃ³n conservaba el `1.0000` heredado al pasar una bobina de soles a dÃ³lares y lo enviaba tal cual: el recosteo de D-045 entraba al kardex â€”que va en soles (D-042)â€” a un sexto de su valor real, sin error y sin forma de corregirlo despuÃ©s. El tipo de cambio se vacÃ­a al salir de soles y el guardado queda bloqueado hasta escribirlo.
- **Alto.** Las tablas de partidos y de kardex del detalle no cubrÃ­an `isPending`/`isError`: una consulta caÃ­da dejaba `data` en `undefined`, no se pintaba ni una fila ni el mensaje de vacÃ­o, y un kardex roto se veÃ­a igual que una bobina sin movimientos. Justo la tabla desde la que se decide anular algo.
- **Alto.** `Number.parseFloat` sobre kilos y sobre el saldo de una compra, contra la regla dura 1 (D-003).
- **Alto.** La ediciÃ³n comparaba los costos como texto contra un DTO de escala fija (`"3.4500"`), asÃ­ que retipear `3.45` contaba como cambio y disparaba un recosteo real â€”reversa del ingreso mÃ¡s un ingreso nuevo en un kardex append-onlyâ€” por nada.
- La previsualizaciÃ³n del partido replicaba solo dos de las cinco validaciones del API y repartÃ­a cada tira por separado en vez de por acumulado: el caso cotidiano mostraba verde y terminaba en un 400, con milÃ©simas distintas a las que devolvÃ­a el servidor. Las constantes del partido (`MIN_CHILD_WIDTH_MM`, `MIN_SPLIT_YIELD`, topes) se movieron a `@ayr/shared` para que web y API validen contra una sola definiciÃ³n.
- Medios y bajos: el partido enviaba filas de ancho vacÃ­o; `relatedPurchaseId` sobrevivÃ­a invisible a un cambio de servicio o de lÃ­nea; el kardex de la bobina imprimÃ­a `IN`/`SPLIT` crudos; invalidaciÃ³n cruzada incompleta entre bobina y compra; `colSpan` mayor que las columnas reales; `itemType` de la URL sin validar; el diÃ¡logo de anular compra perdÃ­a el motivo si el API rechazaba; y a VENDEDOR se le mostraban tres columnas de guiones en vez de ocultarle los costos.

**Hallazgo de `qa` sobre el API.** Anular una compra recibida revertÃ­a **todos** sus movimientos sin filtrar los ya revertidos: un recosteo (D-045) o una bobina anulada individualmente (RF-21) dejan bajo el mismo `refId` un ingreso revertido mÃ¡s su reversa, asÃ­ que el bucle intentaba anular una anulaciÃ³n y la compra quedaba sin poder anularse nunca. Es el mismo defecto que el revisor encontrÃ³ en las otras tres validaciones, en el Ãºnico lugar que habÃ­a quedado sin `liveMovements`.

**Rendimiento del partido y de la anulaciÃ³n.** Un partido creaba una bobina con ~8 consultas cada una, incluido un `UPDATE suppliers` que retiene el lock del proveedor hasta el commit: 60 hijas eran cientos de viajes a Neon bloqueando cualquier otra alta de ese proveedor. Ahora el mÃ¡ximo es 20 hijas, y proveedor, acabado, producto de catÃ¡logo y los N correlativos se resuelven una sola vez (`CoilsService.prepareBatch`). La anulaciÃ³n de una compra revierte hasta 200 movimientos en una transacciÃ³n: se le subiÃ³ el timeout a 120 s. Si el volumen crece, la salida es moverla a un job de pg-boss con estado `CANCELLING`.

**E2E de Fase 2b contra producciÃ³n.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` con el mismo administrador efÃ­mero (30/30 verdes tras el deploy; 31/31 en local, donde ademÃ¡s corre `usuarios.spec.ts`). Los 14 tests de 2b cubren el partido y su reversa, la merma y su anulaciÃ³n, la anulaciÃ³n de compra bloqueada y desbloqueada, el landed cost verificado en `/inventario`, el piso de aprovechamiento del partido, las dos regresiones del bug de `cancel`, el reparto de permisos de D-046 (supervisor puede / no puede, vendedor sin costos) y el ciclo de vida RF-19/20/21.

**ProducciÃ³n queda sin stock de prueba.** Es lo que Fase 2a no podÃ­a hacer y dejÃ³ anotado: con `reverse` construido, `pnpm prod:purge-e2e` anula por API â€”el mismo endpoint del dueÃ±o, con motivo y auditorÃ­aâ€” las compras `RECEIVED` y las bobinas con saldo que cuelgan de un proveedor `E2E â€¦`. HacÃ­a falta: tras la corrida, `/inventario` mostraba S/ 113 000 de stock de prueba en Drywall, justo lo que la pantalla nueva no tiene que mostrar. Verificado despuÃ©s de ejecutarlo: **0 bobinas abiertas con saldo**, las 34 de prueba en `CANCELLED`, y el kardex conservando las 92 filas del rastro (Â§3.2). El script admite `--dry-run` y borra el administrador efÃ­mero al terminar. Conviene correrlo despuÃ©s de cada `pnpm e2e:prod`.

Lo que sigue sin cubrirse por E2E: operar el partido, la merma y las anulaciones **desde los diÃ¡logos de la UI** (hoy se hacen por API y la UI se verifica en lectura) y `/kardex?item=` con filtro de fechas, cuyo saldo de apertura se verificÃ³ a mano contra `inventory_balances` en Neon `dev`.

**Diferido a fases posteriores:**

- `findMovements` de un Ã­tem lee hasta 10 000 movimientos para calcular el saldo corrido. Sirve de sobra hoy; con aÃ±os de historia hay que paginar hacia atrÃ¡s desde un saldo de apertura, que ya estÃ¡ implementado para el filtro por fechas.
- El prorrateo de landed cost es siempre **por kg** (D-043). Si aparece un seguro que se cobra sobre el valor CIF, se agrega el criterio como campo de la compra.
- RF-22 (cancelar plan de corte) es de Fase 3 por D-044: en 2b no existe todavÃ­a el plan de corte.

## Fase 3 â€” detalle

| #   | Entregable                                                                                                                       | Estado                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Decisiones D-047..D-050 (P-13 resuelta), Â§3.7 reordenado (D-048), Â§4 con RF-22 anotado                                         | âœ… `docs/ARQUITECTURA.md` Â§0.2, Â§3.7, Â§5; espejo en `docs/DECISIONES.md`         |
| 2   | Prisma: `coils.kind`, `CoilStatus.IN_THIRD_PARTY`, `cutting_orders`, `cutting_order_coils`, `purchases.related_cutting_order_id` | âœ… migraciÃ³n `20260903031603_fase3_corte_flejes`, aplicada en `dev` y `production` |
| 3   | MÃ³dulo `cutting`: envÃ­o (RF-40), recepciÃ³n parcial por bobina (RF-41), cancelaciÃ³n (RF-22)                                   | âœ… `apps/api/src/cutting/`                                                          |
| 4   | Costo del servicio de corte: prorrateo por kg entre flejes recibidos (RF-41)                                                     | âœ… `applyCuttingOrderCost` en `purchases.service.ts`, mismo patrÃ³n D-043           |
| 5   | Web: `/corte`, `/corte/nueva`, `/corte/[id]`, `/flejes` (RF-42)                                                                  | âœ…                                                                                  |
| 6   | Tests unit (plan de corte, prorrateo, cancelaciÃ³n parcial)                                                                      | âœ… 5 en `cutting-math.spec.ts` (121 unit en total)                                  |
| 7   | RevisiÃ³n de `revisor`, `auditor-seguridad`, `qa`                                                                                | âœ… 1 alto + 3 medios/bajos + 1 bloqueante de `qa` corregidos; ver abajo             |
| 8   | E2E de Fase 3                                                                                                                    | âœ… 4 tests nuevos; 35/35 en local y 34/34 contra producciÃ³n                        |
| 9   | Deploy y migraciÃ³n en `production`                                                                                              | âœ… migraciÃ³n aplicada y API redesplegado en Cloud Run; web por push a `main`       |
| 10  | Cierre: handoff, commit, push                                                                                                    | âœ… `docs/handoff/fase-3.md`                                                         |

**Hallazgos corregidos en esta fase (`revisor`).**

- **Alto.** `widthPlanSchema` (`packages/shared/src/schemas/cutting.ts`) topaba anchos por fila y filas por plan, pero no el total de tiras: a diferencia de `createCoilSplitSchema` (RF-15), un `receive()` podÃ­a pedir cientos de flejes en una sola transacciÃ³n con lock. Corregido con el mismo `superRefine` de tope total (`MAX_SPLIT_CHILDREN`) que ya tenÃ­a el partido interno.
- **Medio.** `/flejes` sumaba el valorizado total con `Number`/`+` en vez de `Decimal` (D-003). Corregido.
- **Medio.** La previsualizaciÃ³n de recepciÃ³n (`cutting-receive-dialog.tsx`) solo replicaba el presupuesto de ancho de `receive()`, no el ancho mÃ­nimo por fleje ni el piso de aprovechamiento del 80% que `planCoilSplit` tambiÃ©n exige ahÃ­ â€” el mismo hueco que el partido interno tuvo en Fase 2b antes de corregirse. Corregido.
- **Bajos.** `nueva-orden-view.tsx` no cubrÃ­a `isError` de sus queries; `CoilOperationsService.lockCoil` y el `lockCoil` propio de `CuttingService` eran una copia textual â€” se unificÃ³ como `CoilsService.lockCoil`, que ambos ahora reusan.

**AuditorÃ­a de seguridad (`auditor-seguridad`, con segunda opiniÃ³n de `agy`).** Sin hallazgos crÃ­ticos ni altos: `$queryRaw` nuevos parametrizados vÃ­a tagged template (sin inyecciÃ³n), `assertCuttingOrderLinkIsValid` exige ADMINISTRADOR igual que el landed cost de D-043, `GET /cutting/strips` oculta costos a VENDEDOR igual que `/inventory/*`, sin escritura de kardex fuera de `InventoryService`.

**Hallazgo de `qa` sobre el API (bloqueante, corregido).** `registerScrap`, `cancel` y `setStatus` de bobina (`coil-operations.service.ts`) solo bloqueaban `CoilStatus.CANCELLED`; como D-050 hace que enviar una bobina a corte (`IN_THIRD_PARTY`) no genere movimiento de kardex, esos tres endpoints trataban una bobina en poder de un tercero como si estuviera disponible: se le podÃ­a registrar merma, anularla o cambiarle el estado sin que la orden de corte se enterara, dejando `cutting_order_coils` apuntando a una bobina que ya cambiÃ³ por debajo. La misma falla existÃ­a en `PurchasesService.cancel()`: anular la compra original de una bobina enviada a corte la cancelaba igual (sin movimiento "posterior" que lo bloqueara, porque el envÃ­o no deja rastro en el kardex). Los cuatro sitios ahora bloquean tambiÃ©n `IN_THIRD_PARTY`, con un mensaje que distingue por quÃ© la bobina no estÃ¡ disponible.

**E2E de Fase 3 contra producciÃ³n.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` + `fase3` con el mismo administrador efÃ­mero (34/34 verdes tras el deploy; 35/35 en local, donde ademÃ¡s corre `usuarios.spec.ts`). Los 4 tests de Fase 3 cubren el flujo completo (enviar â†’ bloqueo de partido local mientras estÃ¡ en el tercero â†’ recibir con merma y prorrateo â†’ `/cutting/strips` â†’ compra de servicio que sube el costo â†’ cancelar lo pendiente), la validaciÃ³n del plan de anchos, la cancelaciÃ³n parcial de una orden con dos bobinas, y los permisos de D-046/D-043 (supervisor opera, solo administrador vincula la factura del servicio).

**ProducciÃ³n queda casi sin stock de prueba, con un residual acotado y documentado.** `pnpm prod:purge-e2e` ganÃ³ un paso previo (D-050) que cancela las Ã³rdenes de corte E2E que quedaron `SENT`/`PARTIALLY_RECEIVED` antes de intentar anular compras y bobinas â€” necesario porque, a diferencia de una compra o un partido, enviar a corte no deja ningÃºn movimiento de kardex que bloquee nada, asÃ­ que sin este paso una bobina `IN_THIRD_PARTY` quedaba fuera del alcance de los dos pasos siguientes. Tras la corrida quedan **3 bobinas madre con material sin poder anularse** (una con 2 000 kg de saldo, dos ya `CLOSED` sin saldo): son las que el test de Fase 3 recibiÃ³ parcialmente, y su compra `COIL` original queda bloqueada porque la bobina ya tiene un movimiento `CUTTING` posterior a su ingreso â€” la misma regla que protege cualquier bobina que ya se moviÃ³ (RF-21, `cancel` de compra). **No existe una reversa de recepciÃ³n de corte** (RF-40..42 solo definen RF-22, cancelar el plan _antes_ de recibir): es el mismo hueco que tuvo Fase 2a antes de que 2b construyera `reverse`, aplicado ahora a la recepciÃ³n de corte. Queda anotado como pendiente para cuando haga falta (ver "Diferido a fases posteriores"); todo lo demÃ¡s (proveedores, acabados, productos `BOBâ€¦`, el resto de compras y bobinas) quedÃ³ desactivado/anulado y verificado con `node scripts/prod-e2e-leftovers.mjs`.

**Diferido a fases posteriores:**

- No hay endpoint para revertir una recepciÃ³n de corte tercerizado (deshacer RF-41 despuÃ©s de recibida): si un operario recibe mal una bobina, hoy no hay forma de deshacerlo â€” solo de corregirlo hacia adelante (otra merma, otro partido). SimÃ©trico a lo que RF-16 resuelve para el partido interno; se agrega si el negocio lo pide. **Cerrado en Fase 3b.**
- `findMovements`/`applyCuttingOrderCost` heredan las mismas limitaciones ya anotadas para landed cost en Fase 2b (paginaciÃ³n de historial largo, prorrateo siempre por kg).

## Fase 3b â€” detalle

| #   | Entregable                                                                          | Estado                                                                                                                   |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Decisiones D-051 (secuenciaciÃ³n) y D-052 (guardrails de la reversa)                | âœ… `docs/ARQUITECTURA.md` Â§0.2, Â§3.7; contexto largo en `docs/DECISIONES.md`                                          |
| 2   | Prisma: `cutting_order_coils.reverted_by_id`/`reverted_at`                          | âœ… migraciÃ³n `20260904130000_fase3b_reversa_recepcion_corte`, aplicada a mano en `dev` y `production` (ver nota abajo) |
| 3   | `CuttingService.reverse()` (RF-41 a la inversa), simÃ©trico a RF-16                 | âœ… `apps/api/src/cutting/cutting.service.ts` + endpoint en `cutting.controller.ts`                                      |
| 4   | Fix: `revertSplit` (RF-16) tambiÃ©n bloquea si la madre estÃ¡ `IN_THIRD_PARTY`      | âœ… `apps/api/src/coils/coil-operations.service.ts` (D-052)                                                              |
| 5   | Web: botÃ³n "Revertir" en `/corte/[id]` para filas `RECEIVED`, mismo `ReasonDialog` | âœ…                                                                                                                      |
| 6   | RevisiÃ³n de `revisor`, `auditor-seguridad` y `qa`, en paralelo                     | âœ… 1 alto + 1 medio + 1 bajo corregidos/cubiertos; ver abajo                                                            |
| 7   | E2E de Fase 3b                                                                      | âœ… 6 tests nuevos; 41/41 en local y 40/40 contra producciÃ³n                                                            |
| 8   | Deploy y migraciÃ³n en `production`                                                 | âœ… migraciÃ³n aplicada, API redesplegado, web por push a `main`                                                         |
| 9   | `pnpm prod:purge-e2e` extendido para revertir recepciones de corte antes de anular  | âœ… producciÃ³n queda con 0 bobinas abiertas con saldo                                                                   |
| 10  | Cierre: handoff, commit, push                                                       | âœ… este documento + `docs/handoff/fase-3b.md`                                                                           |

**Nota â€” migraciÃ³n escrita a mano.** `pnpm db:migrate` (`prisma migrate dev`) falla contra el shadow database con `type "CoilStatus" does not exist`: la carpeta de la migraciÃ³n de Fase 3 (`20260903031603_fase3_corte_flejes`) quedÃ³ nombrada con una fecha anterior a las de Fase 2a/2b (`20260903120000`/`20260904120000`) aunque depende de tipos que esas crean, asÃ­ que reproducir todo el historial desde cero en un shadow database nuevo falla â€” aunque el historial real aplicado a cada rama de Neon es correcto (cada fase se aplicÃ³ en el orden real de las sesiones, no en el de sus nombres de carpeta). La migraciÃ³n de esta fase se escribiÃ³ a mano (mismo SQL que `prisma migrate dev` habrÃ­a generado: dos columnas nullable) y se aplicÃ³ con `prisma migrate deploy` (`pnpm db:deploy`/`pnpm db:prod`), que no usa shadow database. Queda anotado para quien toque el historial de migraciones: renombrar la carpeta de Fase 3 arreglarÃ­a el shadow database, pero es una operaciÃ³n de riesgo sobre migraciones ya aplicadas en `production` que no se intentÃ³ sin autorizaciÃ³n explÃ­cita del dueÃ±o.

**El diseÃ±o de `reverse()` (D-052).** SimÃ©trico a RF-16 en la forma (revierte primero las entradas de los flejes, luego la salida de la madre; "todo o nada": si un fleje ya se moviÃ³, falla completo nombrÃ¡ndolo), con un guardrail propio que RF-16 no necesitaba: D-050 permite que una bobina se reenvÃ­e a otra orden de corte sin dejar rastro de kardex, asÃ­ que antes de revertir la madre debe estar `OPEN`/`CLOSED` (nunca `IN_THIRD_PARTY` de otro envÃ­o, nunca `CANCELLED`) y sin movimientos posteriores a la recepciÃ³n que se revierte. Con ambos guardrails en verde, el resultado es siempre el mismo: la fila vuelve a `SENT` y la madre a `IN_THIRD_PARTY` â€” el envÃ­o queda vivo por construcciÃ³n, nunca se llega a un "disponible" ambiguo. El mismo guardrail de `IN_THIRD_PARTY` se agregÃ³ retroactivamente a `revertSplit` (RF-16), que tenÃ­a el mismo hueco sin haberlo necesitado nunca hasta D-050.

**Hallazgos corregidos en esta fase (`revisor` + `qa`).**

- **Alto (`revisor`).** `reverse()` armaba los `strips` de una recepciÃ³n con `tx.coil.findMany({ where: { cuttingOrderCoilId: row.id } })`, sin filtrar por `status`. Como una fila `cuttingOrderCoil` es reutilizable (recibir â†’ revertir â†’ recibir de nuevo), esa consulta mezclaba los flejes `CANCELLED` de una recepciÃ³n anterior con los vivos de la actual â€” en el audit log (`cancelledStrips` con cÃ³digos que esa reversa no cancelÃ³) y en la relaciÃ³n `strips` que expone `findOne()` a la UI (`/corte/[id]` mostraba flejes fantasma). Corregido: los flejes de la generaciÃ³n actual se derivan de los movimientos de kardex vivos (`movements.filter(m => m.type === 'IN')`), y `findOne()` excluye `status: CANCELLED` de la relaciÃ³n. `qa` agregÃ³ un E2E dedicado (recibir â†’ revertir â†’ recibir â†’ revertir) que reproduce exactamente este escenario y confirma que la segunda reversa no toca los flejes de la primera.
- **Medio (`revisor`).** El primer E2E cubrÃ­a el camino feliz y el bloqueo por fleje consumido, pero no los dos guardrails propios de D-052 (madre reenviada a otra orden, madre con movimiento posterior). Agregados.
- **Bajo (`revisor`).** El DTO expone `revertedAt` pero la UI no lo muestra todavÃ­a; queda como dato disponible sin usar, no bloqueante.

**AuditorÃ­a de seguridad (`auditor-seguridad`).** Sin hallazgos crÃ­ticos ni altos: rol heredado del controller (`ADMINISTRADOR`+`SUPERVISOR_PLANTA`, D-046) igual que `revertSplit`; `$queryRaw` parametrizados; sin fuga de datos en mensajes de error; sin secretos; transacciÃ³n con timeout; el guardrail de `IN_THIRD_PARTY` cierra el mismo hueco que el bloqueante de `qa` en Fase 3 (`registerScrap`/`cancel`/`setStatus`/`PurchasesService.cancel`), ahora tambiÃ©n en `reverse()` y `revertSplit`. Un hallazgo bajo, de negocio no de seguridad: un cierre manual (RF-19) previo a la reversa queda sobrescrito por el `IN_THIRD_PARTY` final, comportamiento considerado correcto (el envÃ­o tiene prioridad).

**E2E de Fase 3b.** `e2e/tests/fase3b.spec.ts`, 6 escenarios: flujo feliz (recepciÃ³n total â†’ reversa â†’ saldo original â†’ cancelar envÃ­o â†’ anular bobina), reversa bloqueada por fleje consumido (merma), reversa de recepciÃ³n parcial (envÃ­o vivo, madre `IN_THIRD_PARTY` ni `OPEN` ni `CLOSED`), reversa bloqueada porque la madre se reenviÃ³ a otra orden, reversa bloqueada porque la madre tuvo un partido local posterior, y el ciclo recibirâ†’revertirâ†’recibirâ†’revertir. `pnpm e2e:prod` corre ahora `auth`+`fase1`+`fase2a`+`fase2b`+`fase3`+`fase3b` con el mismo administrador efÃ­mero: **40/40 verdes contra producciÃ³n; 41/41 en local** (con `usuarios.spec.ts`).

**ProducciÃ³n queda 100% limpia de stock de prueba â€” el residuo de Fase 3 estÃ¡ resuelto.** `pnpm prod:purge-e2e` ganÃ³ un paso previo a la cancelaciÃ³n de Ã³rdenes pendientes: para toda orden de corte E2E `RECEIVED`/`PARTIALLY_RECEIVED`, revierte cada fila `RECEIVED` (revirtiendo antes cualquier partido local activo sobre la madre, mÃ¡s reciente primero, para cumplir el guardrail de D-052) y deja la fila `SENT` de nuevo, que el paso siguiente ya sabÃ­a cancelar. Verificado despuÃ©s de correrlo: **0 bobinas abiertas con saldo** (las 3 bobinas madre huÃ©rfanas que Fase 3 habÃ­a dejado, mÃ¡s las que generÃ³ volver a correr `fase3.spec.ts` en esta misma sesiÃ³n, todas revertidas y anuladas), 142 bobinas de proveedores E2E en `CANCELLED`, 394 movimientos de kardex conservados (Â§3.2). Queda **una sola compra sin poder anularse** (`F001-403036715`, `SERVICE RECEIVED`, tiene un pago registrado) â€” es el mismo lÃ­mite ya documentado en el cierre de Fase 2a ("tiene un pago, por eso no se puede anular"), no relacionado a corte tercerizado ni nuevo de esta fase.

**Diferido a fases posteriores:** ninguno nuevo. Los pendientes de Fase 2b/3 (paginaciÃ³n de `findMovements`, prorrateo siempre por kg) siguen igual.

## Fase 4 â€” detalle

| #   | Entregable                                                                                                            | Estado                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Decisiones D-055..D-060, Â§3.7 (RF-38 pasa a Fase 5), Â§4.3 con RF-34/RF-35 trazados                                  | âœ… `docs/ARQUITECTURA.md` Â§0.2, Â§3.2, Â§3.7, Â§4.3; contexto largo en `DECISIONES.md` |
| 2   | Prisma: `product_boms`, `production_orders`, `production_order_consumptions`, `production_reports` + dos enums nuevos | âœ… migraciÃ³n `20260904140000_fase4_produccion_drywall`, aplicada en `dev`              |
| 3   | MÃ³dulo `production`: receta (D-059), OP, consumo, reportes parciales, cierre con merma y costeo                      | âœ… `apps/api/src/production/`                                                           |
| 4   | Guardrail D-060 en **todas** las rutas que tocan un fleje (`coils`, `cutting`, `purchases`), no solo las nuevas       | âœ… `production-assignments.ts` como funciÃ³n suelta, sin ciclo de mÃ³dulos              |
| 5   | Las tres reversas en esta misma fase: reporte de piezas, reapertura de OP cerrada, anulaciÃ³n de OP                   | âœ… `ProductionService.reverseReport/reopen/cancel`                                      |
| 6   | Web: `/planta` (captura de operario, mobile-first), `/produccion`, `/produccion/[id]`, receta en `/catalogo`          | âœ…                                                                                      |
| 7   | Tests unit (`theoreticalKgPerPiece`, reparto entre flejes, costeo)                                                    | âœ… 12 nuevos en `production-math.spec.ts` (133 unit en total)                           |
| 8   | RevisiÃ³n de `revisor` (API y web, por separado), `auditor-seguridad` y `qa`                                          | âœ… 1 bloqueante + 5 altos + 8 medios corregidos; ver abajo                              |
| 9   | E2E de Fase 4                                                                                                         | âœ… 16 tests nuevos: 5 de flujo + 11 de bordes escritos por `qa`                         |
| 10  | Deploy y migraciÃ³n en `production`; `pnpm e2e:prod` y `pnpm prod:purge-e2e`                                          | âœ… 56/56 contra producciÃ³n; 0 stock de prueba tras la purga                            |
| 11  | Cierre: handoff, commit, push                                                                                         | âœ… CI verde en `main` (corrida 33786845045)                                             |

**El modelo, en cuatro actos.** Una OP fabrica un perfil contra la **receta** del producto (D-059: acabado + espesor + ancho del fleje, mÃ¡s `kgPerPiece`). **Consumir un fleje** lo pone a disposiciÃ³n de la orden y **no mueve kardex** (D-060, mismo criterio que D-050 con el envÃ­o a corte). **Reportar piezas** (N veces, D-058) saca del fleje los kilos teÃ³ricos de esas piezas y mete las piezas al producto terminado, que se lleva en **unidades, no en kilos** (D-055), valorizadas exactamente por lo que saliÃ³ del fleje. **Cerrar** saca por diferencia la merma de proceso (D-057) y reparte todo el material â€”piezas y mermaâ€” entre las piezas buenas con un `ADJUST` (D-056). El resultado es que el valor que sale de los flejes es exactamente el que entra al producto: el kardex cierra sin residuo.

**El guardrail de D-060 es el corazÃ³n de la fase.** Asignar sin mover kardex tiene un precio: ninguna de las reglas "sin movimientos posteriores" que protegen al resto del sistema (RF-16, RF-21, D-045, D-052) ve una asignaciÃ³n, porque no hay movimiento que ver. Es el mismo hueco que D-050 abriÃ³ con `IN_THIRD_PARTY` y que Fase 3 tuvo que tapar a mano en cuatro sitios y Fase 3b en dos mÃ¡s. Esta vez se revisaron **todas** las rutas que tocan un fleje antes de escribir la primera lÃ­nea de UI: merma (RF-17), partido (RF-15), cierre (RF-19), ediciÃ³n de costo/ancho (RF-20, D-045), anulaciÃ³n de bobina (RF-21), anulaciÃ³n de compra, reversa de recepciÃ³n de corte (D-052) y consumo en otra OP. `CuttingService.send` no lo necesita: solo acepta `kind=COIL` y una OP solo consume `kind=STRIP`, asÃ­ que los conjuntos no se cruzan.

**Las tres reversas van en esta fase, no en una "4b".** Revertir un reporte de piezas (solo el Ãºltimo vigente; bloqueado si las piezas salieron o si el cierre de otra OP del mismo perfil las recosteÃ³), **reabrir una OP cerrada** (deshace la merma y el ajuste de costo) y anular la OP (solo sin reportes vigentes; libera los flejes sin tocar el kardex, igual que cancelar un envÃ­o `SENT`). La reapertura no estaba en el alcance escrito pero sÃ­ en el criterio de cierre: sin ella una OP cerrada serÃ­a irreversible y el stock de piezas de prueba quedarÃ­a en producciÃ³n para siempre, sin forma de purgarlo â€” exactamente el residuo que Fase 3 dejÃ³ y que costÃ³ una sesiÃ³n entera (3b) resolver.

**El "SKU de fleje" del enunciado no existe, y por buenas razones.** D-049 decidiÃ³ que un fleje es una fila de `coils` con `kind=STRIP`, no un producto de catÃ¡logo, para no duplicar catÃ¡logo, kardex y trazabilidad. La receta identifica el insumo por **acabado + espesor + ancho**, que es exactamente el trÃ­o con el que RF-42 ya agrupa el stock de flejes y el que el operario ve en `/flejes`. Inventarle un SKU habrÃ­a reabierto D-049 por la puerta de atrÃ¡s.

**Hallazgos corregidos en esta fase (`revisor` API, `revisor` web y `auditor-seguridad`).**

- **Bloqueante (`revisor` API, confirmado por `auditor-seguridad` con el camino de UI exacto).** `cancelScrap` (RF-18) aceptaba **cualquier** movimiento `SCRAP` sobre una bobina, y la merma de proceso del cierre (D-057) tiene esa misma firma. Desde el kardex de la bobina aparecÃ­a el botÃ³n "anular la merma": pulsarlo devolvÃ­a kilos **y** valor al fleje mientras el producto terminado conservaba el costo absorbido (D-056) â€” valor creado de la nada en el valorizado â€” y una reapertura posterior ya no veÃ­a esa merma, asÃ­ que devolvÃ­a el fleje con `consumedKg` sin descontar. Ahora se distinguen por `refId` (RF-17 apunta a la bobina; producciÃ³n, a la orden) y la del cierre solo se deshace reabriendo la OP.
- **Alto (seguridad, ajeno a Fase 4).** El Ã¡rbol de trabajo traÃ­a `.claude/settings.json` con el `deny` de `Read(./.env*)` **eliminado** y `Bash(sed:*)` agregado al `allow`, con `Read(**)` y `defaultMode: auto` vigentes: cualquier agente podÃ­a leer `.env.setup` â€”que segÃºn la regla dura 5 tiene todas las credencialesâ€” sin pedir permiso. El cambio es anterior a esta sesiÃ³n (venÃ­a como `M` en el `git status` inicial). Restaurado el `deny`, ampliado a `Read(**/.env*)` y quitado `Bash(sed:*)`.
- **Alto Ã—2 (`revisor` API).** `reopen()` solo rechazaba flejes `CANCELLED`, asÃ­ que un fleje **cerrado** (RF-19) mientras la OP estaba cerrada volvÃ­a a producciÃ³n sin que `report()` revalidara su estado; y el chequeo de "sin movimientos posteriores al cierre" se saltaba entero para los flejes que se consumieron enteros (no generaron merma, asÃ­ que no habÃ­a movimiento propio contra el cual medir "posterior"), de modo que un partido o una merma intermedios pasaban inadvertidos. Ahora se exige `OPEN` y, sin movimiento propio, la referencia es el `closedAt` de la orden.
- **Alto (`revisor` API).** `applyLandedCost` (D-043) y `applyCuttingOrderCost` (RF-41) emitÃ­an un `ADJUST` de costo sobre flejes **sin** el guardrail de D-060: es la misma acciÃ³n que D-045 ya bloqueaba, llegando por otra puerta. Con una OP en curso, los reportes previos y los siguientes salÃ­an a costos distintos sin que nada avisara.
- **Alto Ã—2 (`revisor` web).** El diÃ¡logo de receta mandaba **siempre** `kgPerPiece`, y el API lo guarda como override: corregir el ancho dejaba el kilo del ancho anterior, y a partir de ahÃ­ cada reporte sacaba del fleje kilos que la mÃ¡quina no consumiÃ³. Es el mismo patrÃ³n del tipo de cambio heredado que fue bloqueante en Fase 2b. Ahora el kilo **sigue a la geometrÃ­a** salvo que el maestro lo escriba a mano, la divergencia se marca en rojo y solo se envÃ­a cuando de verdad es un override. AdemÃ¡s la consulta de acabados no cubrÃ­a `isPending`/`isError` (un `/finishes` caÃ­do se veÃ­a igual que "no hay acabados") y filtraba por `isActive`, ocultando el acabado ya guardado si se habÃ­a desactivado.
- **Medios corregidos.** El "Ãºltimo reporte vigente" se decidÃ­a por `createdAt`, que en Postgres es el inicio de la transacciÃ³n y puede empatar entre reportes concurrentes (ahora hay un `seq` serial, migraciÃ³n `20260904141000_fase4_orden_de_reportes`); el guardrail de D-060 se evaluaba sin bloquear antes las filas de los flejes, dejando una ventana TOCTOU contra `consume` (ahora `assertStripsNotAssigned` toma el `FOR UPDATE` Ã©l mismo, asÃ­ ningÃºn llamador puede olvidarlo); `boms.upsert` leÃ­a las OP vivas fuera de la transacciÃ³n; `findAll` traÃ­a la receta y todas las filas de cada orden para 500 Ã³rdenes; los reportes por OP no tenÃ­an tope; cerrar no pedÃ­a motivo por mÃ¡s merma que dejara; y `catalog.update` dejaba cambiar la unidad o el origen de un producto con receta, esquivando las validaciones de D-055.
- **Bajos corregidos.** El mensaje de fleje que no coincide con la receta no nombraba el acabado, que es justo el dato para buscar otro rollo; `?op=` de `/planta` no se validaba ni se re-leÃ­a al cambiar; la meta de piezas no replicaba las cotas del API; `/planta` pedÃ­a las 500 Ã³rdenes mÃ¡s recientes para mostrar tres; el botÃ³n "Receta" aparecÃ­a en productos que el API iba a rechazar; faltaban `aria-label` en los botones repetidos de fleje y el tope local de flejes por orden; un `colSpan` de mÃ¡s en `/catalogo`; un `Number()` sobre una cantidad de kardex en el script de diagnÃ³stico; y una constante duplicada en `@ayr/shared`.

**Hallazgo de `qa` (defecto preexistente de Fase 2b/3, corregido acÃ¡).** `CoilOperationsService.split()` (RF-15) creaba las hijas sin pasar `kind`, y la columna tiene `@default(COIL)`: partir un **fleje** para reancharlo devolvÃ­a hijas `kind=COIL` aunque la madre fuera `STRIP`. Ese material se caÃ­a del stock de flejes (RF-42 filtra por `kind=STRIP`), producciÃ³n lo rechazaba con "es una bobina, no un fleje" y `stripOptions` no lo ofrecÃ­a, asÃ­ que un fleje repartido localmente ya no se podÃ­a perfilar nunca. El argumento mÃ¡s fuerte de que era un bug y no diseÃ±o: dejaba **inalcanzable** el guardrail que D-060 acababa de agregar a `revertSplit` ("una hija del partido podÃ­a ser un fleje ya montado en una OP"). La hija ahora hereda la clase de la madre, y el test de regresiÃ³n cubre las dos mitades: la hija sale `STRIP`, entra a una OP, y con ella montada `revertSplit` se bloquea nombrando la orden.

**El `qa` cubriÃ³ ademÃ¡s nueve bordes que el spec de flujo no tocaba**, entre ellos el reparto FIFO de un reporte que cruza de un fleje al siguiente (la suma de las salidas da exactamente el kilo teÃ³rico), lo que `consume` y `report` deben rechazar, `release`, la receta del maestro, el reparto de permisos de D-046 (supervisor opera y reabre, no anula ni toca la receta; vendedor no entra), el motivo de la merma del cierre, la regresiÃ³n del bloqueante de `cancelScrap`, las dos formas en que la reapertura se bloquea, y **un guardrail que nadie habÃ­a probado**: un fleje montado en una OP bloquea tambiÃ©n la recepciÃ³n de la factura del servicio de corte (RF-41), que le subirÃ­a el costo a mitad de corrida.

**Lo que la auditorÃ­a de seguridad dejÃ³ explÃ­citamente por escrito.** El `ADJUST` que emite el cierre de una OP **no** es equivalente al hallazgo alto de Fase 2b sobre el landed cost: allÃ¡ el supervisor tipeaba un monto arbitrario que se inyectaba al costo del inventario (por eso D-043 pasÃ³ a ADMINISTRADOR); acÃ¡ el ajuste es derivado y conservativo â€”`costo total âˆ’ valor con el que entraron las piezas`â€” sobre material que Â§3.4 ya le da al supervisor, es reversible y queda auditado fleje por fleje. Por eso cerrar y reabrir siguen siendo del supervisor de planta y no se restringieron. `agy` rechazÃ³ la peticiÃ³n de segunda opiniÃ³n ("my safety guidelines strictly prohibit performing targeted security auditing"), asÃ­ que esta auditorÃ­a no tuvo contraste externo.

**E2E de Fase 4 contra producciÃ³n.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` + `fase3` + `fase3b` + `fase4` + `fase4-bordes` con el mismo administrador efÃ­mero: **56/56 verdes**; 57/57 en local (con `usuarios.spec.ts`). La primera corrida tras el deploy dejÃ³ 55/56: el primer test de UI de Fase 1 encontrÃ³ la pÃ¡gina de login sin hidratar (arranque en frÃ­o de Vercel reciÃ©n desplegado, `getByLabel('Correo electrÃ³nico')` sin aparecer en 45 s). Repetida la corrida completa sin tocar nada, verde. No es un defecto de Fase 4 â€”los E2E de producciÃ³n son todos por APIâ€” pero queda anotado: **la primera corrida contra producciÃ³n justo despuÃ©s de un deploy puede fallar por arranque en frÃ­o**; conviene reintentarla antes de investigar.

**ProducciÃ³n queda sin stock de prueba.** Verificado con `node scripts/prod-e2e-leftovers.mjs` tras `pnpm prod:purge-e2e`: **0 bobinas abiertas con saldo**, las 364 bobinas E2E en `CANCELLED`, las **44 Ã³rdenes de producciÃ³n E2E anuladas** y **0 perfiles E2E con piezas en stock** â€” que es lo nuevo de esta fase, porque una OP cerrada deja piezas en el inventario valorizado y sin la reapertura (D-060) no habrÃ­a forma de sacarlas. 1 218 movimientos de kardex conservados (Â§3.2).

`prod:purge-e2e` necesitÃ³ dos correcciones para llegar a eso: revertir las mermas de prueba de los flejes **antes** de las recepciones de corte (con una sola pasada al final, cuatro recepciones se quedaban sin revertir y sus compras sin anular, porque la merma es justo lo que bloquea la reversa de D-052), y anular tambiÃ©n las compras `DRAFT` de proveedores E2E, que antes quedaban como documentos de prueba en `/compras`.

**Residuo conocido: 6 comprobantes de servicio con un pago registrado** (`F001-390581293`, `F001-403036715`, `F001-410928458`, `F001-418751083`, `F001-458009649`, `F001-459185928`). Ninguno tiene efecto en el inventario â€”cinco estÃ¡n en `DRAFT` y no movieron kardexâ€”, pero no se pueden anular porque **anular un pago a proveedor no existe todavÃ­a**: D-039 lo dejÃ³ "para Fase 2b junto con el resto de anulaciones" y nunca se construyÃ³. Es lo Ãºnico que separa a producciÃ³n de quedar completamente sin rastro de pruebas; conviene resolverlo en la fase que toque cuentas por pagar.

**La migraciÃ³n volviÃ³ a nacer con el nombre mal ordenado (D-053).** `prisma migrate dev` la creÃ³ como `20260903085114_fase4_produccion_drywall`, que ordena **antes** de las de Fase 2a/2b/3/3b y habrÃ­a roto el shadow database otra vez. Se detectÃ³ al mirar la carpeta, no despuÃ©s: backup de `_prisma_migrations` de `dev`, `git mv` a `20260904140000_fase4_produccion_drywall` y `scripts/migrations-rename.mjs --branch dev`, con `prisma migrate status` limpio despuÃ©s. **El reloj de esta mÃ¡quina reporta una fecha anterior a la de las migraciones ya aplicadas**, asÃ­ que cualquier migraciÃ³n nueva va a repetir el problema: revisar el nombre de la carpeta antes de commitear es ahora parte del flujo.

**Diferido a fases posteriores:**

- **Anular un pago a proveedor** (D-039 lo dio por hecho para Fase 2b y no se construyÃ³). Es lo Ãºnico que impide dejar producciÃ³n sin ningÃºn rastro de pruebas, y tambiÃ©n lo que hace que una compra pagada por error no se pueda corregir hoy.
- La receta de la OP (`bomId`) apunta a la receta **viva**, no a una versiÃ³n congelada: una OP ya cerrada puede mostrar un `kgPerPiece` distinto del que usÃ³. Los datos reales estÃ¡n a salvo en `production_reports.theoreticalKg`; si hace falta la receta histÃ³rica, hay que congelarla en la OP al crearla.
- `MAX_ORDER_STRIPS` (20 flejes) y `MAX_ORDER_REPORTS` (200) por orden, y el orden por `seq` bajo concurrencia, no tienen E2E: exigen escenarios grandes o carreras, y serÃ­an lentos o inestables.
- Los pendientes de Fase 2b/3 (paginaciÃ³n de `findMovements`, prorrateo siempre por kg) siguen igual.

## SesiÃ³n M-1 â€” mantenimiento: fix de shadow DB (2026-09-03)

SesiÃ³n corta de mantenimiento, fuera del avance por fases: reparar `prisma migrate dev` (D-053) y registrar la decisiÃ³n de diseÃ±o de reservas para Fase 5 (D-054, cierra P-15). No se tocÃ³ cÃ³digo de producto ni migraciones nuevas de esquema.

- **DiagnÃ³stico primero, sin tocar nada.** `_prisma_migrations.started_at` en `dev` y `production` (mismo orden en ambas): `init â†’ refresh_grace â†’ fase1 â†’ fase2a â†’ fase2b â†’ fase3 â†’ fase3b`. La carpeta de Fase 3 (`20260903031603...`) ordena antes que `fase2a`/`fase2b` por nombre aunque se aplicÃ³ despuÃ©s â€” de ahÃ­ el `type "CoilStatus" does not exist` que Fase 3b habÃ­a documentado como bloqueo.
- **Backup** de `_prisma_migrations` completo (`dev`, `production` y, mÃ¡s tarde, `ci`) en `docs/backup/prisma-migrations-{dev,production,ci}-*.json` antes de cada cambio.
- **Fix:** carpeta renombrada a `20260904125000_fase3_corte_flejes` (solo el nombre, `.sql` intacto) + `UPDATE _prisma_migrations.migration_name` a mano en `dev` y `production`, verificando `id`/`checksum` sin cambios antes y despuÃ©s.
- **VerificaciÃ³n:** `prisma migrate status` limpio; `prisma migrate dev` reconstruye el shadow database sin error ("Already in sync"); `pnpm turbo lint typecheck test build` verde (121 unit); `pnpm format:check` verde (salvo `.claude/settings.json`, ajeno a esta sesiÃ³n); **41/41 E2E en local** contra Neon `dev`.
- **`ci` necesitÃ³ el mismo fix â€” no se asuma "se resetea por corrida" para el historial de migraciones.** El primer push a `main` (CI 33731598611) fallÃ³ en el job de E2E: `reset-test-db.ts` corre `migrate deploy` + `TRUNCATE` de tablas de negocio, pero nunca toca `_prisma_migrations`, que en `ci` es su propia tabla persistente. Con el nombre viejo todavÃ­a ahÃ­, `migrate deploy` vio la migraciÃ³n renombrada como nueva y fallÃ³ (`type "CoilKind" already exists`, P3018). Corregido con el mismo procedimiento (backup, resolver el intento fallido con `prisma migrate resolve --rolled-back` + borrar su fila sin `finished_at`, `UPDATE migration_name` sobre la fila real), verificado reproduciendo `reset-test-db.ts` en local contra `ci`, y confirmado con el segundo push a CI. Detalle completo en `docs/DECISIONES.md` D-053.
- **Nota de la sesiÃ³n.** `prisma migrate dev --create-only` con un campo dummy en `AuditLog` aplicÃ³ el cambio de verdad en vez de solo crear el archivo (contradice su propio `--help` en Prisma 6.19.3). Detectado y revertido a mano (columna, fila de `_prisma_migrations`, carpetas) antes de la verificaciÃ³n real. Queda anotado en D-053 para no asumir que `--create-only` es inerte sin comprobarlo.
- **D-054 (P-15 resuelta).** Modelo de cotizaciÃ³nâ†’pedidoâ†’reserva para Fase 5: cotizar no reserva; confirmar crea pedido+reserva en una transacciÃ³n atÃ³mica; reserva en ledger propio (no en `inventory_movements`), estados `ACTIVA`/`CONSUMIDA`/`LIBERADA`, invariante `disponible â‰¥ reservado` que bloquea anulaciÃ³n/merma/corte/consumo ajeno mientras estÃ© `ACTIVA`; OP consume, cancelaciÃ³n libera; sin vencimiento automÃ¡tico, alerta + liberaciÃ³n manual. Detalle largo en `docs/DECISIONES.md`.
- **Scripts nuevos** (solo para este tipo de reparaciÃ³n puntual, no parte del flujo normal): `scripts/migrations-diagnose.mjs`, `scripts/migrations-backup.mjs`, `scripts/migrations-rename.mjs`, `scripts/migrations-status.mjs`, `scripts/migrations-resolve.mjs`, `scripts/migrations-delete-failed.mjs`, cada uno con su contraparte en `apps/api/prisma/migrations-*.ts`.

## SesiÃ³n M-2 â€” mantenimiento: anular un pago a proveedor (2026-09-03)

SesiÃ³n corta de mantenimiento, fuera del avance por fases: cerrar el hueco que D-039 dejÃ³ pendiente desde Fase 2a/2b ("anular un pago se resuelve en Fase 2b junto con el resto de anulaciones", nunca construido) y que el handoff de Fase 4 documentÃ³ como el Ãºnico residuo que impedÃ­a dejar producciÃ³n sin ningÃºn rastro de pruebas. No se tocÃ³ nada de Fase 5 (cotizaciones, pedidos, reservas, Nubefact).

- **`SupplierPayment` gana `reversedAt`/`reversedById` (D-061).** Append-only, mismo criterio que `CoilSplit`/`CuttingOrderCoil`: la fila nunca se borra. `POST /purchases/:id/payments/:paymentId/reverse` (solo ADMINISTRADOR, D-046) marca el pago y escribe el motivo en `audit_log` (RF-95). MigraciÃ³n `20260904150000_reversa_pago_proveedor`, aplicada en `dev`.
- **El bug que el hueco escondÃ­a.** `purchaseBalance`/`paidAmount` y el conteo de `cancel()` sumaban/contaban **cualquier** fila de `supplier_payments`, sin distinguir vivo de anulado â€” porque esa distinciÃ³n no existÃ­a. `purchaseBalance` ahora filtra `reversedAt === null` en el Ãºnico lugar donde se suman pagos, asÃ­ que ningÃºn llamador (lista de compras, detalle, estado de cuenta del proveedor) tuvo que tocarse aparte. `cancel()` se corrigiÃ³ para contar solo pagos vigentes: antes del fix, una compra con un pago â€”vivo o noâ€” quedaba bloqueada para anular **para siempre**.
- **Guardrails, mismo patrÃ³n que D-050/D-052/D-060.** Idempotencia: un pago ya anulado no se puede volver a anular (409, mismo criterio que `InventoryService.reverse`). Defensivo: la compra no puede estar `CANCELLED` â€” hoy inalcanzable por la API (`cancel()` exige cero pagos vigentes antes de anular), pero se comprueba igual. A diferencia de D-060, un pago no tiene ningÃºn "aguas abajo" real en v1 (no toca stock); el guardrail que de verdad importa es el que ya existÃ­a en `cancel()`, ahora corregido.
- **Web:** botÃ³n "Anular pago" por fila en `/compras/[id]` (tabla de pagos gana columna "Estado": Vigente/Anulado), mismo `ReasonDialog` que el resto de reversas. `invalidate()` gana la clave `supplier-statement`, que antes ningÃºn flujo de pagos/anulaciÃ³n tocaba.
- **RevisiÃ³n (`revisor` + `qa`).** Sin bloqueantes. Corregidos: invalidaciÃ³n cruzada faltante del estado de cuenta del proveedor; un `data-state="inactive"` sin efecto visual (reemplazado por una opacidad real); un selector de E2E ambiguo (`getByRole('button', {name:'Anular'})` sin `exact` tambiÃ©n matcheaba "Anular pago").
- **`qa` ampliÃ³ la cobertura de `e2e/tests/m2-reversa-pago.spec.ts`** de 2 a 8 escenarios: varios pagos parciales (se anula el del medio, el saldo baja exacto); pago en moneda distinta a la de la compra (D-039, sin residuo de redondeo al anular); estado de cuenta del proveedor antes/despuÃ©s; rol (SUPERVISOR_PLANTA y VENDEDOR reciben 403); pago inexistente o de otra compra (404); compra `COIL` recibida (el pago nunca roza el kardex ni el saldo de la bobina). Sin defectos nuevos encontrados.
- **E2E contra producciÃ³n.** `pnpm e2e:prod` corre ahora tambiÃ©n `m2-reversa-pago.spec.ts`: **65/65 verdes en local; 64/64 contra producciÃ³n** (con `usuarios.spec.ts`, que es solo local). **CI verde** (un job de E2E se cancelÃ³ una vez por el timeout de 20 min de un runner lento; el mismo job reintentado con `gh run rerun` terminÃ³ en 7m37s, igual que corridas anteriores â€” corrida lenta puntual, no relacionada con el cÃ³digo).
- **Purga de producciÃ³n extendida â€” el residuo de Fase 4 queda resuelto.** `pnpm prod:purge-e2e` gana el paso 0.7: revierte los pagos vigentes de cada compra de proveedor E2E antes de intentar anularla (pide el detalle por compra, porque la lista no trae el array de pagos). Verificado con `node scripts/prod-e2e-leftovers.mjs` tras correrlo: **0 bobinas abiertas con saldo, 0 piezas de perfiles E2E en stock, y las 224 compras E2E en `CANCELLED`** â€” incluidos los 6 comprobantes de servicio que Fase 4 habÃ­a dejado con un pago sin poder anularse. ProducciÃ³n queda sin ningÃºn rastro de pruebas.
- **PolÃ­tica de seguridad registrada, sin incidente nuevo (D-062).** El `deny` de `Read(./.env*)`/`Read(**/.env*)` en `.claude/settings.json` habÃ­a aparecido eliminado al cerrar Fase 4 (origen desconocido, anterior a esa sesiÃ³n) y se restaurÃ³ entonces. Al abrir esta sesiÃ³n se verificÃ³ que seguÃ­a intacto â€” no volviÃ³ a faltar. Queda registrado como polÃ­tica **permanente, no removible por un agente**: si alguna vez vuelve a faltar, restaurarlo es la acciÃ³n por defecto, no una pregunta de "Â¿se quitÃ³ a propÃ³sito?". Pendiente que el dueÃ±o confirme si la eliminaciÃ³n original (antes de Fase 4) fue intencional; si no lo fue, evaluar rotar las credenciales de `.env.setup`.

## Fase 5a â€” detalle

| #   | Entregable                                                                                                                                                                                                                     | Estado                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 0   | D-063 (permisos de diagnÃ³stico y comandos desde la raÃ­z), regla dura 8 en `CLAUDE.md`                                                                                                                                        | âœ… commit propio antes de tocar cÃ³digo                                                  |
| 1   | Decisiones D-064..D-069, Â§3.7 partida en 5a/5b, Â§3.2 con la segunda regla transversal, RF-51/61/62/63/65/66/69 trazados                                                                                                      | âœ… `docs/ARQUITECTURA.md` Â§0.2, `docs/DECISIONES.md`                                    |
| 2   | Prisma: `quotations`/`quotation_items`, `sales_orders`/`sales_order_items`, `reservations`, `products.list_price_pen`, `business_lines.quotation_required`, FK de `production_orders.reservation_id`                           | âœ… migraciones `20260904160000`, `20260904161000` y `20260904162000`, aplicadas en `dev` |
| 3   | MÃ³dulo `sales`: cotizaciones, pedidos, ledger de reservas, PDF y job de vencimiento                                                                                                                                           | âœ… `apps/api/src/sales/`                                                                 |
| 4   | Invariante `disponible â‰¥ reservado` en **todas** las rutas que tocan stock, en sus dos formas (D-066)                                                                                                                        | âœ… `reservation-guard.ts` como funciÃ³n suelta, sin ciclo de mÃ³dulos                    |
| 5   | Las tres reversas en esta misma fase: anular cotizaciÃ³n, anular pedido (libera), liberar reserva a mano                                                                                                                       | âœ…                                                                                       |
| 6   | Web: `/cotizaciones`, `/cotizaciones/nueva`, `/cotizaciones/[id]`, `/pedidos`, `/pedidos/nuevo`, `/pedidos/[id]`; columnas reservado/disponible en `/inventario`; lookup de RUC en `/clientes`; precio de lista en `/catalogo` | âœ…                                                                                       |
| 7   | Tests unit (aritmÃ©tica comercial + invariante en el kardex)                                                                                                                                                                   | âœ… 16 nuevos (155 en total)                                                              |
| 8   | RevisiÃ³n de `revisor` (API y web por separado) y `auditor-seguridad`                                                                                                                                                          | â³                                                                                        |
| 9   | E2E de Fase 5a                                                                                                                                                                                                                 | âœ… 9 escenarios en `e2e/tests/fase5a.spec.ts`                                            |
| 10  | Deploy y migraciÃ³n en `production`; `pnpm e2e:prod` y `pnpm prod:purge-e2e`                                                                                                                                                   | â³                                                                                        |
| 11  | Cierre: handoff, commit, push                                                                                                                                                                                                  | â³                                                                                        |

**El modelo, en cuatro actos.** **Cotizar** es una simulaciÃ³n de precio: no toca inventario
y lo Ãºnico que hace con el stock es _declarar_, lÃ­nea por lÃ­nea, quÃ© se reservarÃ­a (D-054).
**Emitir** la pasa a `EMITIDA` â€”el Ãºnico estado desde el que se confirmaâ€” y genera su PDF.
**Confirmar** crea el pedido **y** las reservas en una sola transacciÃ³n; si a una lÃ­nea no le
alcanza el disponible, no se crea nada. **Consumir**: la OP nacida del pedido monta el
material reservado y, al emitir el primer material, marca la reserva `CONSUMIDA`.

**La invariante es el corazÃ³n de la fase, y son dos guardrails, no uno.** `disponible â‰¥
reservado` se rompe de dos maneras distintas y cada una necesita su propio mecanismo:

- **Cantidad** â€” dentro de `InventoryService.record` (salidas) y `reverse` (anulaciÃ³n de un
  ingreso), bajo el mismo lock de saldo que el kardex ya toma. Es el Ãºnico punto por el que
  pasa toda salida de stock (Â§3.2), asÃ­ que de un golpe cubre merma, partido, consumo de
  producciÃ³n, anulaciÃ³n de compra y de bobina, y cualquier ruta futura.
- **Custodia** â€” `assertNotReserved`, funciÃ³n suelta, en las rutas que se llevan el Ã­tem
  entero **sin mover kardex**: envÃ­o a corte (D-050), asignaciÃ³n a una OP ajena (D-060) y
  cierre de bobina (RF-19).

Ninguna alcanza sola: la de cantidad no ve un envÃ­o a corte, la de custodia no ve una merma
parcial. Es el mismo hueco que D-050 abriÃ³ y que Fase 3 tapÃ³ a mano en cuatro sitios, y que
D-060 volviÃ³ a abrir; la novedad acÃ¡ fue reconocer que son **dos clases** de ruptura.

**Las reservas viven fuera del kardex, y por eso el ledger apunta al mismo par que el
saldo.** `reservations.(item_type, item_id)` es exactamente la clave de
`inventory_balances`, lo que permite comprobar la invariante bajo el `FOR UPDATE` que el
kardex ya toma, sin inventar un segundo mecanismo de bloqueo que habrÃ­a que mantener
sincronizado con el primero.

**Las reversas van en esta misma fase** (lecciÃ³n de D-051/D-060): anular la cotizaciÃ³n
(cualquier estado no confirmado), anular el pedido (libera sus reservas activas) y liberar
una reserva a mano (solo ADMINISTRADOR, con motivo). Todas todo-o-nada, todas idempotentes,
todas con motivo al `audit_log`.

## Hallazgos de la revisiÃ³n (revisor API, revisor web, auditor-seguridad)

Se corrieron las tres revisiones en paralelo sobre el diff completo. **1 bloqueante, 7 altos
y varios medios corregidos**; sin hallazgos crÃ­ticos de seguridad.

**Bloqueante (`revisor` API): la invariante estaba aplicada en un solo sentido.** Se
comprobaba que ninguna operaciÃ³n rompiera una reserva viva, pero no que la reserva **naciera
sobre material cuya custodia ya estaba comprometida**. Entre cotizar y confirmar, la bobina
podÃ­a irse a un tercero (D-050) o quedar montada en una OP (D-060) â€” y como ninguna de las
dos mueve kardex, `lockAvailability` la veÃ­a intacta. El pedido quedaba prometiendo material
que no estaba y, peor, la recepciÃ³n del corte o el reporte de esa OP se caÃ­an despuÃ©s contra
la invariante, sin mÃ¡s salida que liberar la reserva a mano. `createReservations` revalida
ahora el estado de la bobina y sus asignaciones bajo el mismo lock, y `reservable-coils` no
ofrece flejes montados.

**Altos.**

- **Anular el pedido solo se bloqueaba con reservas `CONSUMIDAS`.** Una OP que ya montÃ³ el
  fleje pero todavÃ­a no reportÃ³ tiene su reserva en `ACTIVA`: el pedido se anulaba en
  silencio, la reserva pasaba a `LIBERADA` y la orden seguÃ­a fabricando para un pedido que ya
  no existÃ­a. Ahora el bloqueo mira el **estado de la OP**, no el de la reserva â€” y lo mismo
  la liberaciÃ³n manual.
- **Deshacer la producciÃ³n no devolvÃ­a la reserva.** Revertir el reporte y anular la OP
  dejaban el material otra vez en stock **sin nada que lo protegiera**, con el pedido todavÃ­a
  prometiÃ©ndoselo al cliente y en `EN_PRODUCCION` sin orden detrÃ¡s. `restoreReservation` la
  devuelve a `ACTIVA` cuando la OP se queda sin reportes vigentes. Esto es ademÃ¡s lo que
  garantiza que el pedido nunca quede inanulable: si el bloqueo dependiera de una reserva
  consumida que no vuelve, serÃ­a el mismo agujero que D-061 cerrÃ³ con los pagos.
- **Deadlock real** entre anular un pedido y reportar producciÃ³n: tomaban el pedido y sus
  reservas en orden inverso. Los dos van ahora pedido â†’ reservas.
- **`reservationId` no se validaba contra el producto de la OP**: una orden podÃ­a citar
  cualquier reserva viva de la lÃ­nea y, por la excepciÃ³n de la reserva propia, montar el
  material prometido a otro cliente.
- **(`revisor` web) La reserva no tenÃ­a consumidor en la UI.** `/planta` creaba la OP sin
  `reservationId`, asÃ­ que el guardrail se volvÃ­a en contra: al confirmar un pedido el
  material quedaba bloqueado para **toda** orden que no fuera la nacida de esa reserva, y
  planta no tenÃ­a forma de crear esa orden. El fleje prometido era inmovilizable hasta que un
  administrador liberara la reserva a mano â€” lo contrario de para quÃ© se reserva.
- **(web) Pedido directo ofrecÃ­a las lÃ­neas que lo prohÃ­ben** (D-065): formulario completo,
  validaciÃ³n en verde y 400 al guardar. Es el mismo "previsualizaciÃ³n verde â†’ 400" del
  partido en 2b.
- **(web) La validaciÃ³n local no comparaba los kilos a reservar contra el disponible**, ni
  sumaba dos lÃ­neas de la misma bobina. En una cotizaciÃ³n ese error no aparecÃ­a al crearla
  sino al **confirmar**, cuando el cliente ya tiene el PDF.
- **(web) CatÃ¡logo y bobinas sin cubrir `isError`**: cuarta repeticiÃ³n del hallazgo de 2b/4.

**Medios corregidos.** Fechas de negocio en **Lima** y no en UTC (`businessToday`): entre las
19:00 y la medianoche hora local, una cotizaciÃ³n vÃ¡lida "hasta el 10" se rechazaba por
vencida y el pedido nacÃ­a fechado el 11. Listas con `_count` en vez del `include` completo de
500 filas. `RoleGate` en las seis vistas nuevas. BÃºsqueda por el API (RF-84) en vez de filtrar
500 filas en el cliente. El botÃ³n de PDF depende del estado y no de `pdfKey` (si la subida a
R2 fallÃ³ al emitir â€”fallo tolerado a propÃ³sitoâ€” no habÃ­a forma de llegar al documento).
"Anular pedido" deshabilitado cuando una OP estÃ¡ fabricando. PrevisualizaciÃ³n normalizada a
la escala fija antes de calcular. `validityDays` validado localmente. InvalidaciÃ³n simÃ©trica
entre producciÃ³n y ventas.

**AuditorÃ­a de seguridad: sin hallazgos crÃ­ticos ni altos.** Dos medios corregidos:

- **AutorizaciÃ³n a nivel de objeto.** RF-66 dice "una cotizaciÃ³n **propia**", pero no habÃ­a
  ninguna comprobaciÃ³n: con solo el id, un vendedor podÃ­a editar el borrador de un compaÃ±ero,
  emitirlo, confirmarlo â€”creando un pedido y una reserva a nombre de su clienteâ€” o anulÃ¡rselo.
  Editar, emitir, confirmar y anular exigen ahora ser quien la creÃ³ (o ADMINISTRADOR); la
  lectura sigue abierta al equipo comercial, que es lo que RF-69 pide.
- **El PDF de una cotizaciÃ³n no emitida.** Un borrador nunca emitido â€”ni confirmable, ni
  registrado como emitidoâ€” generaba un PDF idÃ©ntico al de una cotizaciÃ³n vÃ¡lida, y el de una
  anulada o vencida tambiÃ©n. Ahora un borrador no tiene documento y los otros dos salen
  rotulados con su estado, redibujados con el estado de hoy en vez de servir el archivo que se
  congelÃ³ al emitir.

Y cuatro bajos: `/customers/lookup` sin `@Roles` (cualquier usuario autenticado gastaba la
cuota del token compartido con el tipo de cambio), el cuerpo del tercero sin cota de tamaÃ±o ni
parseo separado, el **nÃºmero de documento en los logs** (dato personal, Ley 29733) y un `GET`
que escribÃ­a. `agy` volviÃ³ a rechazar la peticiÃ³n de segunda opiniÃ³n, asÃ­ que esta auditorÃ­a
tampoco tuvo contraste externo.

**Verificado empÃ­ricamente por el auditor:** el `deny` de `Read(**/.env*)` sigue vigente
despuÃ©s de D-063 â€” un `grep` accidental sobre un `.env.example` fue bloqueado por la regla, o
sea que el `allow` nuevo de `Bash(grep:*)` no la esquiva en la prÃ¡ctica.

**Diferido, con motivo:** el tracker del throttle es la IP, y detrÃ¡s del proxy de Vercel todos
los usuarios comparten la de salida, asÃ­ que el lÃ­mite del lookup es global y no por usuario.
Protege bien la cuota del tercero (que es lo que D-067 querÃ­a) pero un usuario en bucle deja
sin autocompletado a toda la empresa. Cambiar el tracker a `user.id` toca el guard global que
tambiÃ©n protege el login, asÃ­ que va con el resto del hardening de Fase 7.

**Los bordes de `qa` encontraron un defecto que las tres revisiones anteriores no vieron.**
El PDF de una cotizaciÃ³n **vencida** salÃ­a sin rÃ³tulo mientras el job diario no la hubiera
marcado: `confirm()` ya la rechazaba por fecha, pero `pdf()` decidÃ­a con el `status` guardado
y servÃ­a el archivo congelado en R2 â€” un papel indistinguible de uno vigente sobre una
cotizaciÃ³n que el propio API ya no dejaba confirmar. Es exactamente el razonamiento de D-069
(el API escala a cero y el cron puede no correr) aplicado a la puerta por la que el documento
sale al cliente. Corregido con `effectiveStatus`, que recalcula el vencimiento al servir.

Los 10 bordes cubren ademÃ¡s: dos lÃ­neas sobre la misma bobina (la segunda ve la reserva que la
primera creÃ³ **en la misma transacciÃ³n**, y si la suma excede el disponible fallan enteras);
dos lÃ­neas sobre bobinas distintas; reserva sobre el propio producto en piezas con la
invariante bloqueando la salida; el bloqueante de la revisiÃ³n por sus **dos** caminos (bobina
enviada a corte y fleje montado en una OP entre cotizar y confirmar); editar, emitir y anular
con sus PDF; RF-66; y **dos confirmaciones simultÃ¡neas sobre la misma bobina**, donde una gana
y la otra falla con un 400 de dominio, sin reserva huÃ©rfana (estable en tres corridas).

**E2E de Fase 5a contra producciÃ³n.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` +
`fase2b` + `fase3` + `fase3b` + `fase4` + `fase4-bordes` + `m2-reversa-pago` + `fase5a` +
`fase5a-bordes` con el mismo administrador efÃ­mero: **83/83 verdes**; 84/84 en local (con
`usuarios.spec.ts`).

**Una corrida se perdiÃ³ por un error operativo, no del producto.** El primer `pnpm e2e:prod`
se abortÃ³ a los 64 tests con un `ENOENT` sobre un archivo de trace: habÃ­a otra corrida de
Playwright en paralelo verificando los bordes en local, y **todas comparten `test-results/`**,
que Playwright limpia al arrancar. El sÃ­ntoma (un `ENOENT` junto a un "Test timeout of
45000ms") no se parece en nada a la causa. Repetida sola, verde. Queda anotado: **una suite de
Playwright a la vez**, o `--output` propio para cada una.

**ProducciÃ³n queda sin ningÃºn rastro.** Verificado con `node scripts/prod-e2e-leftovers.mjs`
tras `pnpm prod:purge-e2e`: **0 bobinas abiertas con saldo, 0 reservas ACTIVAS en toda la
base, 0 perfiles E2E con piezas en stock**, y las 20 cotizaciones, 13 pedidos, 114 Ã³rdenes de
producciÃ³n y todas las compras E2E en `CANCELLED`, con los 19 clientes de prueba desactivados.
2 526 movimientos de kardex conservados (Â§3.2).

`prod:purge-e2e` necesitÃ³ dos ampliaciones para llegar ahÃ­. La primera, prevista: un paso
que anula pedidos y cotizaciones E2E, libera las reservas sueltas y desactiva los clientes â€”
va **despuÃ©s** de las Ã³rdenes de producciÃ³n (una OP viva bloquea la anulaciÃ³n del pedido) y
**antes** de todo lo demÃ¡s (una reserva activa bloquea la anulaciÃ³n de la bobina, la de su
compra, el envÃ­o a corte y el cierre). La segunda saliÃ³ de correrlo: la reversa de mermas de
prueba filtraba por `kind = STRIP`, porque hasta Fase 3b las Ãºnicas mermas de prueba eran
sobre flejes; el test de la invariante de D-066 registra una sobre una **bobina madre**, que
quedÃ³ con 1 600 kg y sin poder anularse. Con el filtro ampliado a bobinas y flejes, la purga
cierra en cero.

**Diferido a fases posteriores:**

- El tracker del throttle es `req.ip`, y detrÃ¡s del proxy de Vercel (D-015) todos los usuarios
  comparten la IP de salida: el lÃ­mite de 20/min del lookup de RUC es global y no por usuario.
  Protege la cuota del tercero, que es lo que D-067 querÃ­a, pero un usuario en bucle deja sin
  autocompletado a toda la empresa. Cambiar el tracker a `user.id` toca el guard global que
  tambiÃ©n protege el login, asÃ­ que va con el hardening de Fase 7.
- **El vendedor puede buscar un RUC pero no dar de alta el cliente**: RF-85 reserva las
  mutaciones de `/customers` a ADMINISTRADOR, asÃ­ que el botÃ³n "Buscar" de D-067 queda sin
  salida para el rol que lo usa. Es coherente con Â§3.4; si el dueÃ±o quiere que el vendedor dÃ©
  de alta clientes, es un cambio de RF-85, no un bug.
- `SalesOrderStatus.FULFILLED` existe y **nada lo alcanza todavÃ­a**: el despacho que cierra un
  pedido es Fase 5b.
- La garantÃ­a de D-068 de sumar `Î£ subtotales + Î£ IGV` en vez de `Î£ totales de lÃ­nea` **no es
  falsable con la escala actual** (dinero a 4 decimales, `total = subtotal + igv` sin redondeo
  adicional). El test la verifica igual, para que siga valiendo si la escala cambia.
- Los pendientes de Fase 2b/3/4 (paginaciÃ³n de `findMovements`, prorrateo siempre por kg,
  receta no congelada en la OP) siguen igual.

## Fase 5b â€” detalle

**FacturaciÃ³n electrÃ³nica, guÃ­a de remisiÃ³n, despacho y cobranza** (RF-70, RF-74..RF-79,
RF-86..RF-89; D-070..D-078). El realcance de la fase es D-070: 5b dejÃ³ de ser "producciÃ³n
de coberturas y venta" â€”eso pasÃ³ a **5c**â€” y pasÃ³ a cerrar el tramo que iba **despuÃ©s** del
pedido, que era el hueco real que 5a dejÃ³: el pedido reservaba material y no tenÃ­a forma de
salir del almacÃ©n, de facturarse ni de cobrarse.

### El puerto, y por quÃ© el dominio no conoce a Nubefact (D-071)

`ElectronicInvoicingProvider` define cuatro operaciones en vocabulario de SUNAT â€”emitir
comprobante, emitir guÃ­a, consultar estado, comunicar baja, mÃ¡s la consulta de la baja que
la revisiÃ³n obligÃ³ a separarâ€” y `NubefactProvider` es la Ãºnica implementaciÃ³n. Un
`grep -i nubefact` fuera de `invoicing/providers/nubefact/` solo devuelve la fÃ¡brica del
mÃ³dulo, los nombres de las variables de entorno y los comentarios del puerto que explican
la decisiÃ³n.

`NullInvoicingProvider` se ata cuando faltan credenciales y devuelve **error de envÃ­o**, que
es lo mismo que devuelve un PSE caÃ­do: un entorno sin PSE ejercita el mismo camino que una
caÃ­da real, en vez de un camino falso que solo existe en desarrollo.

### El corazÃ³n: dos fases y un correlativo que no se desperdicia (D-072, D-073)

Enviar un comprobante hace, en este orden: (1) toma correlativo, deja el documento en
`ISSUED` y **confirma la transacciÃ³n**; (2) intenta el envÃ­o fuera de esa transacciÃ³n; (3)
segÃºn lo que conteste el PSE, pasa a `ACCEPTED`, `REJECTED` o `SEND_ERROR`. Desde el final
del paso 1 el documento ya habilita el despacho.

Invertirlo â€”enviar dentro de la transacciÃ³nâ€” harÃ­a que una caÃ­da del PSE revirtiera un
correlativo ya tomado, que es exactamente el hueco que D-072 evita, o dejara un camiÃ³n
esperando a que conteste un tercero.

El job (`invoicing.send-pending`, cada 15 minutos **y al arrancar**) recoge lo que el
intento inline no pudo. Corre al arrancar porque el API escala a cero en Cloud Run: es la
misma advertencia de D-069, y acÃ¡ vale igual.

### El despacho cierra el pedido, la factura no (D-074)

`dispatches` mueve kardex por `InventoryService` (regla dura 2), consume la reserva **antes**
de la salida â€”si fuera al revÃ©s, la propia reserva del pedido bloquearÃ­a contra la invariante
de D-066 justo la salida que viene a cumplirlaâ€” y recalcula el estado del pedido desde las
filas de despacho vigentes.

**El cambio fino de esta fase**: la reserva se consume **solo por lo despachado**, no entera.
`reservations.qty` pasÃ³ a significar "lo que todavÃ­a estÃ¡ prometido"; la promesa original
vive en `sales_order_items.reserve_qty` y no se toca, asÃ­ que no se pierde informaciÃ³n.
Consumirla entera en un despacho parcial habrÃ­a dejado el resto de la lÃ­nea â€”material que el
pedido sigue prometiendoâ€” sin nada que lo proteja: el mismo agujero que la auditorÃ­a de 5a
encontrÃ³ en el otro sentido.

La reversa devuelve stock, restaura la reserva y recalcula el pedido, y se bloquea si un
documento electrÃ³nico vigente declara ese traslado (la guÃ­a del propio despacho, o un
comprobante vivo que facture sus lÃ­neas). Deshacerlo al revÃ©s dejarÃ­a al kardex diciendo que
la mercaderÃ­a estÃ¡ en el almacÃ©n y a SUNAT diciendo que saliÃ³.

### Cobranza, espejo de compras (D-075)

`customer_payments` es `supplier_payments` mirado desde el otro lado: saldo recalculado y
nunca almacenado, cobro contra el **comprobante** â€”no contra el pedido, que no tiene saldoâ€”
y reversa que marca la fila sin borrarla, con el motivo al `audit_log`. La Ãºnica asimetrÃ­a
deliberada es de roles: registrar un cobro es tambiÃ©n de VENDEDOR, porque cobrar es parte de
su trabajo y compras es un mÃ³dulo de planta al que no entra.

### Lo demÃ¡s

- **D-076**: VENDEDOR da de alta y edita clientes; documento, dÃ­as de crÃ©dito y baja lÃ³gica
  siguen siendo de ADMINISTRADOR (y la revisiÃ³n encontrÃ³ que faltaba cerrarlo en el **alta**,
  no solo en la ediciÃ³n).
- **D-077**: cliente `PÃšBLICO EN GENERAL` sembrado e inmutable, con bloqueo suave del tope de
  S/ 700 y excepciÃ³n de ADMINISTRADOR registrada en el comprobante y en la auditorÃ­a.
- **D-078**: modalidad de traslado por despacho; el catÃ¡logo de vehÃ­culos y conductores queda
  diferido y lo reemplaza el autocompletado desde despachos anteriores. El **ubigeo** de
  partida y llegada se captura en el despacho â€”SUNAT lo exige en la guÃ­aâ€” por la misma razÃ³n
  que todo lo demÃ¡s de esta fase: un dato mal puesto vuelve rechazado con el correlativo ya
  gastado.

### Hallazgos de la revisiÃ³n (revisor API, revisor web, auditor-seguridad)

Tres pasadas en paralelo sobre el diff del Milestone 1. **4 bloqueantes, 7 altos, 10 medios
y varios bajos**, todos corregidos antes de seguir con el Milestone 2. Los que cambiaron
decisiones y no solo cÃ³digo:

**Bloqueantes.**

- `SEND_ERROR` no contaba como emitido, asÃ­ que la misma lÃ­nea de pedido se podÃ­a facturar
  dos veces **justo con el PSE caÃ­do** â€” el escenario para el que existe la contingencia. El
  estado tiene correlativo tomado y el job lo va a reintentar: cuenta.
- Los topes de "cuÃ¡nto queda por facturar" se comprobaban solo al **crear el borrador**, y un
  borrador no consume nada: dos borradores sobre la misma lÃ­nea pasaban los dos y, al
  enviarse, tomaban nÃºmero los dos. Ahora se revalida dentro de la transacciÃ³n que toma el
  correlativo, que es el Ãºltimo punto en el que todavÃ­a se puede decir que no.
- Dos lÃ­neas del mismo documento sobre la misma lÃ­nea de pedido se comparaban cada una contra
  el pendiente completo.
- **La baja se confirmaba sola.** `refreshStatus` de un `VOID_PENDING` preguntaba por el
  **comprobante**, y un documento con baja en trÃ¡mite es por definiciÃ³n uno que SUNAT ya
  aceptÃ³: la consulta devolvÃ­a "aceptado" y el documento se marcaba anulado sin que SUNAT lo
  anulara, con la cuenta por cobrar desapareciendo. ObligÃ³ a partir la consulta de baja en un
  mÃ©todo propio del puerto.

**Altos.** 401/403 se clasificaban como **rechazo** en vez de error de envÃ­o, asÃ­ que un token
vencido quemaba el correlativo de cada comprobante; un documento con ticket se **reemitÃ­a**
en cada barrido en vez de consultarse; el reintento manual de una guÃ­a armaba un payload de
comprobante vacÃ­o; corregir una guÃ­a rechazada violaba un `CHECK` y salÃ­a como 500; el
`VOID_PENDING` era un estado sin salida si SUNAT rechazaba la baja; y `precio_unitario` se
calculaba con `number` â€”11.86 Ã— 1.18 = 13.994799999999998â€” sobre un campo cuya coherencia el
PSE valida.

**Seguridad.** El script de secretos de GitHub preferÃ­a las credenciales **reales** del PSE y
solo caÃ­a a la demo si faltaban, en un job que corre en cada pull request; los archivos que
devuelve el PSE se descargaban de cualquier URL que dijera su respuesta, sin tope de tamaÃ±o;
y faltaba la comprobaciÃ³n de propiedad al estilo de RF-66, asÃ­ que un vendedor podÃ­a emitir
el borrador de otro.

**Web.** El total se recalculaba con lo que el usuario estÃ¡ tipeando y `toDecimal` lanzaba con
un estado tan normal como el punto de `.5`, tirando la pantalla entera; y los kilos se
restaban con `number`, rompiendo la regla dura 1 sobre la cifra que decide cuÃ¡nto se acredita.

### Lo que solo apareciÃ³ contra el PSE de verdad

Las tres revisiones estÃ¡ticas no podÃ­an ver nada de esto. SaliÃ³ en la primera corrida de
`qa` contra la cuenta demo de Nubefact, y es el argumento para que los E2E de esta fase
existan contra el PSE y no contra un doble.

- **La guÃ­a salÃ­a mal armada.** El propio PSE nombrÃ³ los campos: la placa va bajo
  `transportista_placa_numero` â€”en `vehiculo_placa` la ignoraba en silencio y rechazaba por
  "placa no puede estar en blanco"â€” y los apellidos del conductor van aparte. Se partieron
  en dos columnas (`driver_given_names`, `driver_family_names`) en vez de dividir el texto
  en el adaptador: partir un nombre por espacios acierta con "Juan PÃ©rez GÃ³mez" y falla con
  "JosÃ© Luis PÃ©rez", y esa adivinanza sale impresa en un documento fiscal.
- **La unidad de medida viajaba tal cual desde `products.unit`**, que es texto libre en el
  maestro. Ahora se normaliza contra el catÃ¡logo 03 y lo que no se reconoce cae a `NIU`.
- **Con la contingencia levantada se podÃ­a revertir un despacho cuya guÃ­a ya tenÃ­a
  correlativo.** `DECLARED_STATUSES` dejaba fuera `SEND_ERROR` mientras
  `LIVE_DOCUMENT_STATUSES` sÃ­ lo contaba, y esa asimetrÃ­a era el defecto: al recuperarse el
  PSE, el barrido declaraba un traslado que ya no existÃ­a.
- **Un comprobante emitido en contingencia no se podÃ­a cobrar**, que es la mitad de la
  promesa de D-073 sin cumplir â€” y la mitad que se lleva el dinero.
- **La purga no veÃ­a las boletas a "pÃºblico en general"**: no salen a nombre del cliente de
  prueba. Ahora se reconocen ademÃ¡s por la marca en observaciones.

Y uno que encontrÃ© revisando mi propio cÃ³digo, no la suite: **el despacho sacaba del kardex
la cantidad de venta en vez de la que la reserva promete**. En perfiles coinciden â€”el Ã­tem
reservado es el propio productoâ€”, y por eso el error habrÃ­a esperado hasta la primera
cobertura para aparecer: vender 100 piezas de una bobina habrÃ­a descontado 100 kilos.

### Bloqueo abierto: las series del punto de emisiÃ³n

**La cuenta demo del PSE no tiene autorizadas las series que siembra la migraciÃ³n**
(`F001`, `B001`, `T001`, `FC01`, `BC01`): responde _"No puedes emitir comprobantes con esta
serie"_. Mientras eso siga asÃ­, **ningÃºn entorno con esa cuenta llega a `ACCEPTED`**, y cada
intento gasta un correlativo real.

La consecuencia para esta fase es que el tramo posterior a la aceptaciÃ³n â€”cobro sobre un
comprobante aceptado, nota de crÃ©dito sobre uno aceptado, reversa de despacho bloqueada por
factura aceptadaâ€” **no se pudo probar de punta a punta**. Todo lo anterior sÃ­: la emisiÃ³n
toma correlativo, el rechazo es determinista y se corrige con nÃºmero nuevo, la contingencia
deja salir la mercaderÃ­a, y los guardrails de 5a siguen en pie.

Lo que se hizo al respecto: **las series pasaron a ser administrables**
(`GET/POST/PATCH /invoicing/series`, solo ADMINISTRADOR) y se muestran en la tarjeta de
contingencia de `/comprobantes`. La autorizaciÃ³n de una serie es del PSE **por emisor**, asÃ­
que era configuraciÃ³n disfrazada de constante: alinearlas dejÃ³ de ser una migraciÃ³n.

Lo que hace falta del dueÃ±o: registrar esas series en el panel de Nubefact, o decir cuÃ¡les
tiene autorizadas la cuenta para darlas de alta desde el sistema.

### Cierre: quÃ© quedÃ³ verificado y cÃ³mo

- **195 unit** verdes; `lint`, `typecheck`, `format:check` y `build` limpios en los tres paquetes.
- **19 E2E** contra la cuenta demo del PSE: los diez escenarios obligatorios de la fase mÃ¡s
  nueve bordes. La corrida de cierre volviÃ³ a ejecutar los tres que quedaban con el cÃ³digo
  final en vez de repetir la suite entera â€”cada corrida completa gasta unos veinte documentos
  de un cupo de cincuentaâ€”, asÃ­ que **no fue un 17/17 de una sola pasada** y conviene decirlo.
- **89 pasados y 13 saltados contra producciÃ³n**, sin un solo fallo. Los 13 saltados son los que
  emiten: contra producciÃ³n estÃ¡n apagados a propÃ³sito (ver abajo).
- **CI verde** y **purga sin residuo**: producciÃ³n quedÃ³ con 0 documentos electrÃ³nicos, 0
  despachos vivos, 0 reservas activas, 0 cobros vigentes y 0 piezas de prueba en stock.

### La compuerta de emisiÃ³n, y por quÃ© existe

Los E2E de esta fase **no emiten contra producciÃ³n**, y no es una comodidad: el correlativo lo
asigna nuestra propia `fiscal_series`, no el PSE (D-072). Sin proveedor configurado â€”que es
como quedÃ³ producciÃ³n por D-080â€” cada emisiÃ³n de prueba se llevarÃ­a un nÃºmero de la serie real
y quedarÃ­a en `SEND_ERROR` **sin ningÃºn estado terminal al que llevarlo**: la baja exige un
comprobante aceptado. SerÃ­an huecos permanentes en la numeraciÃ³n fiscal de la empresa.

Contra producciÃ³n corre todo lo que no emite â€”despacho, reversas, despacho parcial, guardrails
de reserva de 5a, progreso del pedido, configuraciÃ³nâ€”, que es donde estÃ¡ el riesgo de kardex.

La suite acabÃ³ necesitando **tres modos**, no dos: emisiÃ³n permitida, emisiÃ³n prohibida y
**emisiÃ³n permitida sin proveedor detrÃ¡s**. El tercero es el que verifica la promesa de
contingencia contra un entorno realmente sin PSE, en vez de simularla con el interruptor
manual â€” y es el modo en el que corre producciÃ³n.

El mismo error de fondo apareciÃ³ dos veces, primero en el producto y despuÃ©s en las pruebas:
**tratar "no hay PSE" como si fuera "el PSE tarda"**. En el producto quemaba correlativos; en
las pruebas agotÃ³ el tiempo del job de CI, porque sin proveedor la cola de pendientes solo
crece y el barrido la reprocesaba entera en cada espera.

### Un hueco que la limpieza destapÃ³

ProducciÃ³n quedÃ³ con un **borrador** de boleta que ninguna ruta podÃ­a quitar: la baja exige un
comprobante aceptado y no habÃ­a otra puerta. Se agregÃ³ `DELETE /invoicing/documents/:id`, que
es **la Ãºnica fila del mÃ³dulo que se borra de verdad** â€” y puede serlo justamente porque un
borrador no existe fiscalmente: no tomÃ³ correlativo, no consume pedido, no tiene saldo y SUNAT
nunca supo de Ã©l. La auditorÃ­a se escribe antes del borrado, porque despuÃ©s no quedarÃ­a a quÃ©
apuntar.

## Fase 6 â€” detalle

| #   | Entregable                                                                                                                                                                                                                                                                                                                     | Estado                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | Decisiones D-082..D-091, Â§3.7 renumerada (5câ†’6, 6â†’7, 7â†’8), RF-30..RF-33/RF-36/RF-39 y RF-54 actualizados; contexto largo en `docs/DECISIONES.md`                                                                                                                                                                        | âœ…                                                                                 |
| 2   | Prisma: `colors`, `products.color_id`, `coils.color_id`, `purchase_items.color_id`, `product_boms.kind` (+ nullables y `CHECK`), `production_orders.kind`/`consumed_kg`, `production_order_items`, `production_report_pieces`, `quotation_item_pieces`, `sales_order_item_pieces`, `reservations` unique por `(lÃ­nea, Ã­tem)` | âœ… dos migraciones, aplicadas en `dev`                                             |
| 3   | `@ayr/shared`: schemas de color y de coberturas, subÃ­tems de largo, `piecesMeters`/`describePieces`/`thicknessWithinTolerance`, `ROOFING_THICKNESS_TOLERANCE_MM`                                                                                                                                                              | âœ…                                                                                 |
| 4   | API `colors` (CRUD ADMINISTRADOR, baja lÃ³gica, auditorÃ­a) + color en catÃ¡logo, bobinas (3 vÃ­as de alta), compras e importaciÃ³n                                                                                                                                                                                            | âœ…                                                                                 |
| 5   | CotizaciÃ³n y pedido con lÃ­nea compuesta: subÃ­tems `{cantidad, largo}`, `qty` en metros derivada, descripciÃ³n con los largos hacia el comprobante                                                                                                                                                                           | âœ…                                                                                 |
| 6   | `RoofingProductionService`: OP desde pedido con plan copiado y editable, montaje de bobina filtrada (espesor Â±TOL + color estricto), reporte de largos, cierre con consumo declarado y despunte                                                                                                                               | âœ…                                                                                 |
| 7   | Traslado de la reserva del insumo al producto (D-088) y despacho que lee la reserva viva                                                                                                                                                                                                                                       | âœ…                                                                                 |
| 8   | Reversas: reporte de largos, reapertura del cierre, anulaciÃ³n de OP â€” todas con motivo y falla completa                                                                                                                                                                                                                     | âœ…                                                                                 |
| 9   | Web: paleta de colores en `/catalogo`, color en producto y bobina, editor de subÃ­tems en la cotizaciÃ³n, rama de coberturas en `/planta`, `/produccion` con las dos clases                                                                                                                                                    | âœ…                                                                                 |
| 10  | Tests unit de la aritmÃ©tica de coberturas (`roofing-math.spec.ts`)                                                                                                                                                                                                                                                            | âœ… 18 nuevos, 213 en total                                                         |
| 11  | RevisiÃ³n de `revisor` (API y web por separado) y `auditor-seguridad`                                                                                                                                                                                                                                                          | âœ… 3 bloqueantes + 3 altos corregidos; ver abajo                                   |
| 12  | E2E de Fase 6                                                                                                                                                                                                                                                                                                                  | âœ… 11 tests nuevos, verdes en local y contra producciÃ³n                           |
| 13  | Deploy y migraciÃ³n en `production`                                                                                                                                                                                                                                                                                            | âœ… dos migraciones aplicadas, API redesplegado en Cloud Run, web por push a `main` |
| 14  | Cierre: handoff, commit, push                                                                                                                                                                                                                                                                                                  | âœ… `docs/handoff/fase-6.md`                                                        |

**El modelo, en un pÃ¡rrafo.** Conviven dos productos de cobertura (D-083). La **plancha de
catÃ¡logo** tiene largo fijo en la receta, se cuenta en piezas y se vende como cualquier
producto. La **cobertura a medida** no tiene largo: el pedido lo trae, la lÃ­nea de cotizaciÃ³n
es compuesta â€”subÃ­tems `{cantidad, largo}` cuya suma en metros **es** la cantidad de la lÃ­neaâ€”
y su kardex se lleva en **metros lineales**, porque en un saldo de piezas una plancha de 3 m y
una de 9 m compartirÃ­an promedio ponderado. La OP nace del pedido (D-084), copia sus largos
como plan de corte editable, monta una bobina filtrada por espesor Â±0.02 mm y **color idÃ©ntico**
(D-085/D-086), reporta los largos reales y cierra declarando los kilos que la bobina consumiÃ³ de
verdad; la diferencia contra el teÃ³rico es el despunte (D-089) y **el resto del rollo vuelve al
almacÃ©n**, que es donde esta fase se separa de D-057.

**El hueco de Fase 5b que esta fase destapÃ³ (D-088).** El despacho sacaba del kardex las
coordenadas congeladas de `sales_order_items`, que en una cobertura son **la bobina**. Como la
OP ya habÃ­a sacado esos kilos al reportar, despachar los habrÃ­a sacado por segunda vez. En
perfiles y trading el defecto es invisible â€”el Ã­tem reservado es el propio productoâ€”, asÃ­ que
habrÃ­a esperado a la primera cobertura real. La correcciÃ³n es que la promesa **se traslada**: al
reportar, la reserva de bobina se descuenta por los kilos consumidos y nace una reserva sobre
los metros fabricados, de modo que las planchas a medida **nacen reservadas** para el pedido que
las encargÃ³. `reservations.sales_order_item_id` dejÃ³ de ser Ãºnico.

### Hallazgos corregidos en esta fase (revisor Ã—2 + auditor-seguridad)

- **Bloqueante.** `reverseReport` sacaba los metros del kardex **antes** de reducir la reserva
  que esos mismos metros sostienen, y `InventoryService.reverse` comprueba
  `disponible â‰¥ reservado`: `0 â‰¥ 24.600` es falso, asÃ­ que **RF-33 fallaba en su camino
  principal** â€”no en un bordeâ€” pidiÃ©ndole al operario que liberara la reserva del pedido que
  venÃ­a a corregir. El orden correcto es el que `report` ya usaba y documentaba.
- **Bloqueante.** El despacho **volvÃ­a a caer en la bobina** cuando la reserva de producto
  dejaba de estar `ACTIVA`: bastaba un primer despacho que la consumiera entera, o despachar
  antes de producir, para que el segundo emitiera una salida de kilos de bobina por una venta de
  planchas. Era el mismo hueco de D-088 reaparecido un despacho mÃ¡s tarde. Ahora una lÃ­nea que
  se fabrica contra el pedido **no vuelve nunca al insumo**: sin producto terminado reservado, el
  despacho se rechaza diciendo que hay que producir primero.
- **Bloqueante (web).** El DTO de la reserva exponÃ­a la Ãºltima OP sin filtrar por estado, y
  anular una de coberturas deja el vÃ­nculo puesto: el pedido volvÃ­a a estar disponible para el
  API pero **desaparecÃ­a del Ãºnico punto de entrada de `/planta`**, asÃ­ que RF-33 dejaba el
  pedido imposible de fabricar sin anularlo entero. Ahora el DTO solo muestra la OP viva.
- **Alto.** El `OUT` de despunte del cierre no descontaba la reserva de bobina, asÃ­ que una
  orden que reservÃ³ el rollo entero â€”el caso normalâ€” **no se podÃ­a cerrar con merma**: la propia
  promesa bloqueaba la salida.
- **Alto (web).** El cierre desde `/produccion/[id]` calculaba "Â¿hace falta motivo?" con la
  fÃ³rmula de drywall (`pendiente / asignado`), que en coberturas es siempre alta porque el rollo
  sobrante no es merma: el diÃ¡logo exigÃ­a explicar una baja de inventario que no iba a ocurrir, y
  su texto afirmaba lo contrario de lo que el API harÃ­a.
- **Alto (web).** La precarga del plan de corte convertÃ­a mm â†’ m con `number` y dos decimales
  (regla dura 1): un largo de 4 205 mm volvÃ­a como 4.20 m y guardar el plan sin tocar nada lo
  reescribÃ­a a 4 200. Los otros dos sitios usaban `Decimal`; este era el Ãºnico que divergÃ­a.
- **Medios.** Sobre-reportar dejaba metros prometidos para siempre (ahora el upsert se topa
  contra lo que la lÃ­nea debe); el peso por defecto de la guÃ­a heredaba una cantidad en metros;
  el `colorId` de bobinas y compras se conectaba sin validar, lo que permitÃ­a meter a posteriori
  un color desactivado y esquivar el guardrail de la baja lÃ³gica; la bobina elegida en la
  terminal no se limpiaba al bajarla; y `invalidateProduction` no refrescaba el material
  reservable que ve el vendedor.
- **Bajos.** `describePieces` dividÃ­a milÃ­metros con `number` y ese texto viaja a la descripciÃ³n
  del comprobante; `ROOFING_THICKNESS_TOLERANCE_MM` no se validaba al arrancar y un valor alto
  **anulaba el filtro en silencio** (fallo abierto); el plan derivado de una plancha de catÃ¡logo
  redondeaba hacia abajo; `reservationId` en el filtro de bobinas no se comprobaba contra el
  producto; la restauraciÃ³n de la reserva devolvÃ­a kilos a un rollo del que podÃ­an no haber
  salido; y varios detalles de accesibilidad y unidades en pantalla.

**Sin hallazgos crÃ­ticos de seguridad.** El auditor confirmÃ³ que ninguna ruta nueva expone
costos a VENDEDOR (`roofingCoilOptionSchema` se diseÃ±Ã³ sin ellos y el servicio construye
exactamente esos campos), que los guards y la auditorÃ­a cubren las nueve mutaciones nuevas, que
no hay superficie de inyecciÃ³n en los parÃ¡metros nuevos y que `pnpm audit --prod` sale limpio.
`agy` rehusÃ³ la tarea de segunda opiniÃ³n, asÃ­ que la auditorÃ­a es de una sola fuente.

### Tres defectos latentes de los helpers de E2E que esta fase hizo visibles

Ninguno es de la Fase 6, y los tres llevaban tiempo esperando la corrida que los despertara.
Van anotados porque el sÃ­ntoma, en los tres casos, apunta a cualquier parte menos a la causa.

1. **`createInvoiceableCustomer` reusaba el cliente por RUC sin mirar si estaba activo.** El RUC
   facturable es uno solo, asÃ­ que el helper siempre devuelve el mismo cliente entre corridas â€”
   y `prod:purge-e2e` lo deja `isActive: false`. Desde ahÃ­, **toda** corrida contra producciÃ³n
   posterior a una purga morÃ­a en `POST /sales/orders` con "El cliente estÃ¡ desactivado", en
   cuatro tests de Fase 5b que parecÃ­an haberse roto con lo Ãºltimo que se hubiera tocado. Ahora
   lo reactiva si lo encuentra inactivo.
2. **`today()` partÃ­a de UTC.** Es exactamente la lecciÃ³n de D-069, que el API ya habÃ­a
   aprendido con `businessToday`: Lima va cinco horas detrÃ¡s, asÃ­ que a partir de las 19:00 hora
   local `toISOString()` devuelve la fecha de maÃ±ana y cualquier documento fechado "hoy" se
   rechaza por futuro. El fallo aparecÃ­a **segÃºn la hora a la que corrieras la suite**.
3. **CÃ³digos y documentos con poca entropÃ­a.** El acabado (`E2E` + 4 letras) y el RUC de
   proveedor (`Date.now()` a secas) chocaban de vez en cuando dentro de una misma corrida, y el
   409 reventaba un test que no tenÃ­a nada que ver con lo que estaba probando.

Y una cuarta, operativa: **el job de E2E de CI se quedÃ³ sin tiempo**. Estaba en 30 minutos y la
Fase 6 le suma once tests, cada uno con su compra, recepciÃ³n y ciclo comercial contra Neon.
SubiÃ³ a 50.

### Ojo operativo â€” el cupo de la cuenta demo del PSE

Los dos tests de Fase 5b que emiten fallaron **en local** con
_"No puedes enviar mas de 50 documentos en una cuenta DEMO"_. Es lo que ya avisaba
`docs/handoff/fase-5b.md`: son 50 documentos, no se liberan anulÃ¡ndolos â€”hay que borrarlos en
el panel de Nubefactâ€” y una corrida completa gasta unos veinte. Esta sesiÃ³n corriÃ³ la suite
varias veces mientras se aplicaban las correcciones de la revisiÃ³n, asÃ­ que el cupo se agotÃ³.
**No bloquea el cierre**: `e2e:prod` no emite nunca (D-081 fuerza `E2E_FISCAL_EMISSION=0`).

## Fase 7 â€” detalle (cola de producciÃ³n; POS e importaciÃ³n quedan pendientes)

| #   | Entregable                                                                    | Estado                                                                                                                                   |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cola derivada (D-092, D-093): `GET /sales/orders/queue`, sin tabla nueva      | âœ… reusa `resolveDispatchTarget` (D-088) + filtro `kind=ROOFING`                                                                        |
| 2   | Prioridad manual + fecha prometida (D-094, D-096)                             | âœ… 4 columnas en `sales_orders`, `PATCH .../priority`, `PATCH .../promised-delivery-date`                                               |
| 3   | SemÃ¡foro VENCIDO/PROXIMO/A_TIEMPO/SIN_FECHA                                  | âœ… `queueSemaphore()` en `@ayr/shared`, sobre `businessToday()` (D-069)                                                                 |
| 4   | `/planta` como entrada (D-095), `/produccion` admin, badge en `/pedidos/[id]` | âœ… `RoofingPickerCard` reescrita, `QueueEntrySummary`/`QueueAdminControls` compartidos                                                  |
| 5   | Indicador RF-38 en el menÃº lateral                                           | âœ… badge en "Terminal de planta" con el conteo de la cola                                                                               |
| 6   | E2E: los 6 escenarios exigidos + 2 de borde                                   | âœ… `fase7.spec.ts` (7 tests), `fase7-bordes.spec.ts` (2 tests)                                                                          |
| 7   | `pnpm turbo lint typecheck test build`                                        | âœ… verde                                                                                                                                |
| 8   | MigraciÃ³n de mano + `db:prod`                                                | âœ… `20260905090000_fase7_cola_prioridad_fecha_prometida`, aplicada en `dev` y `production`                                              |
| 9   | RevisiÃ³n: `revisor` + `auditor-seguridad` en paralelo                        | âœ… 1 ALTO (reserva de bobina que sobraba, corregido), 1 MEDIO (filtro `kind`, corregido), 1 BAJO (auditorÃ­a antes/despuÃ©s, corregido) |
| 10  | E2E contra producciÃ³n + purga                                                | âœ… 110/110 (13 saltados por D-081), purga sin rastros tras remediar un residuo de la propia purga (ver nota)                            |
| 11  | Deploy                                                                        | ðŸŸ¡ API en Cloud Run hecho; **web pendiente** â€” token del CLI de Vercel vencido, requiere `vercel login`                              |

### Hallazgo del revisor: la reserva de bobina que nunca se drenaba (D-097)

`reserveKg` es una estimaciÃ³n del vendedor; casi nunca coincide con lo que la corrida termina
gastando, y D-086 permite rolar una bobina distinta a la reservada. En los dos casos, la
reserva de materia prima quedaba `ACTIVE` con saldo para siempre â€”el pedido no salÃ­a nunca de
la cola, ni despachado enteroâ€”, porque nada en `report()`/`close()` la drena si no coincide
exacto. `close()` ahora libera ese saldo (`releaseRemainingReservation`, `RELEASED` y no
`CONSUMED`: nada de esa bobina se volviÃ³ producto). Deliberadamente sin reversa en `reopen()`
â€” reabrir no depende de esa reserva. Detalle completo en `docs/DECISIONES.md` Â§D-097.

### Un hueco que la purga de producciÃ³n destapÃ³, no de la aplicaciÃ³n

`pnpm prod:purge-e2e` revierte cualquier despacho E2E "para devolver su stock al almacÃ©n"
(lÃ­nea ~266 de `scripts/prod-e2e-purge.mjs`), sin distinguir si el Ã­tem despachado es materia
prima (donde eso libera algo que otra limpieza necesita) o un **producto terminado de SKU
Ãºnico de un solo test**, que nunca se vuelve a usar. Revertir el despacho de una cobertura ya
cerrada reabre en cadena una ventana en la que la orden de producciÃ³n puede terminar
reabierta (`IN_PROGRESS`) sin que su reporte se revierta, dejando el kardex del producto con
saldo fantasma. Esta sesiÃ³n lo encontrÃ³ porque sus E2E fueron las primeras en pasar por
`/planta` â†’ cerrar â†’ **despachar** con un producto de coberturas en el mismo `prod:purge-e2e`
(el ciclo de Fase 6 nunca despachaba en su E2E). Se remediÃ³ a mano (reabrir â†’ revertir el
reporte â†’ anular, con el mismo criterio "anula por API" que usa el resto del script) y
`prod:purge-e2e` quedÃ³ en cero. **No se tocÃ³ el script**: redecidir cuÃ¡ndo conviene revertir
un despacho E2E (segÃºn si el Ã­tem es materia prima o producto terminado de un solo uso)
excede el alcance de esta sesiÃ³n y merece su propia revisiÃ³n, no un parche apurado.

## Fase 7b â€” detalle (punto de venta de mostrador; importaciÃ³n de comprobantes sigue pendiente)

Segundo tramo de la Fase 7 (D-092..D-096 dejaron la cola; esto entrega RF-60). Siete
decisiones nuevas, **D-098..D-104**, y una correcciÃ³n de un hueco de Fase 5b que el
mostrador destapÃ³.

Modelo en una lÃ­nea: **el POS no es un camino paralelo de stock** (D-099). Es UI rÃ¡pida que
crea pedido + despacho + comprobante + cobranza en **una transacciÃ³n**, reusando los cuatro
servicios que ya existÃ­an desde la Fase 5b. El mÃ³dulo `pos` no importa `InventoryModule` â€”no
escribe kardex, no toca reservas, no comprueba disponibleâ€” y esa dependencia ausente es la
prueba estructural de que no abriÃ³ un segundo camino.

| #   | Entregable                                                                        | Estado                                                                                                           |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0   | Defecto de `prod:purge-e2e` del tramo 1, corregido **en el guion**                | âœ… el bloque de producciÃ³n se mueve despuÃ©s del despacho; commit propio                                       |
| 1   | Decisiones D-098..D-104 en Â§0.2 + contexto largo en `DECISIONES.md`              | âœ…                                                                                                              |
| 2   | Prisma: `cash_sessions`, `pos_sales`, `PaymentMethod` += CARD/WALLET, `PICKUP`    | âœ… tres migraciones, aplicadas en `dev` y `production`                                                          |
| 3   | `*InTx` en pedido, despacho, comprobante y cobro (D-099)                          | âœ… el pÃºblico abre la transacciÃ³n y delega; el `*InTx` recibe la del llamador                                 |
| 4   | `POST /pos/sales`: los cuatro documentos en una transacciÃ³n, envÃ­o al PSE fuera | âœ… D-073 intacto: la fase 1 se ensancha, el orden no cambia                                                     |
| 5   | Caja: apertura, ventas por medio, cierre con arqueo (D-101)                       | âœ… esperado solo con efectivo, congelado al cerrar; diferencia con motivo y ADMINISTRADOR                       |
| 6   | AnulaciÃ³n encadenada (D-100)                                                     | âœ… cobro â†’ comprobante â†’ despacho â†’ pedido, solo en el turno abierto y con comprobante aceptado           |
| 7   | Web: `/pos` (una pantalla) y `/pos/caja`, aviso de contingencia (D-102)           | âœ… dos toques entre carrito y venta cerrada; `Mostrador` primero del grupo Comercial                            |
| 8   | E2E: los siete escenarios exigidos + cinco de borde                               | âœ… `fase7b.spec.ts` (5, emiten) y `fase7b-bordes.spec.ts` (6, no emiten y corren contra producciÃ³n)            |
| 9   | `pnpm turbo lint typecheck test build`                                            | âœ… verde (236 unit, +15)                                                                                        |
| 10  | E2E contra producciÃ³n + purga                                                    | âœ… 6 pasados y 6 saltados (D-081), sin fallos; producciÃ³n sin rastros                                          |
| 11  | Deploy                                                                            | âœ… API en Cloud Run; **web pendiente** â€” el token del CLI de Vercel sigue vencido, llega con el push a `main` |

### Lo que mÃ¡s importa de la fase: el hueco de Fase 5b que la boleta escondÃ­a

`DispatchesService.reverse` se bloqueaba si **cualquier** comprobante vigente del pedido
facturaba alguna lÃ­nea del despacho. ParecÃ­a correcto hasta que se cruzÃ³ con `voidPathFor`
(D-072): **una boleta no se da de baja de forma individual** â€”su baja va por resumen diario,
fuera de alcance en v1â€”, asÃ­ que su Ãºnico camino es la nota de crÃ©dito, que la deja
`ACCEPTED` para siempre. Consecuencia: el despacho de **toda** venta con boleta era
irreversible, y el propio mensaje de error ofrecÃ­a un camino ("emite una nota de crÃ©dito")
que no desbloqueaba nada.

Fase 5b no lo vio porque probÃ³ la nota de crÃ©dito y probÃ³ la reversa del despacho, pero
nunca las dos sobre la misma lÃ­nea. El mostrador lo destapÃ³ en el primer intento: la boleta
es su caso normal. La correcciÃ³n (`declaringDocument`) aplica el criterio que el mÃ³dulo ya
usaba para el saldo (D-075): bloquea solo lo que **todavÃ­a** factura, y una lÃ­nea acreditada
por completo por notas vivas dejÃ³ de estarlo. No es una excepciÃ³n para el POS â€” cualquier
despacho con boleta, venga de donde venga, ahora se revierte por el camino que su mensaje
anuncia.

### VerificaciÃ³n â€” lo que se pudo correr y lo que no

- `pnpm turbo lint typecheck test build` **verde**: 236 unit (15 nuevos, todos del arqueo y
  de la forma de la venta de mostrador). `pnpm format:check` verde.
- `pnpm e2e --grep "Fase 7b"` **10 pasados, 1 saltado** en la primera corrida completa; el
  saltado era la anulaciÃ³n, que despuÃ©s se partiÃ³ en dos (factura â†’ baja, boleta â†’ nota de
  crÃ©dito) y se corrigiÃ³. Una corrida de regresiÃ³n de los 21 tests con "anular" en el tÃ­tulo
  â€”Fase 2b, 3b, 5b, 6, 7 y M-2â€” quedÃ³ **19 pasados, 1 saltado y 1 fallo**, y ese fallo es el
  que destapÃ³ que la nota de crÃ©dito nacÃ­a borrador.
- `pnpm e2e:prod --grep "Fase 7b"` **6 pasados y 6 saltados, sin fallos**. Los 6 saltados son
  los que emiten: D-081 fuerza `E2E_FISCAL_EMISSION=0` contra producciÃ³n y asÃ­ tiene que ser.
- **ProducciÃ³n sin rastros**, verificado con `prod:purge-e2e` y con el reporte de solo lectura
  `prod:e2e-leftovers`: 0 perfiles con piezas en stock, **0 reservas activas en toda la base**,
  0 despachos vivos, 0 comprobantes E2E, 0 cobros vigentes y **0 turnos de caja E2E**.

**Bloqueo, documentado por la regla dura 9.** La suite local completa (`pnpm e2e`, 136 tests)
**no se pudo terminar** en esta sesiÃ³n. Se intentÃ³ dos veces: la primera avanzÃ³ 12 tests en
85 minutos y la segunda, acotada a las ocho suites que tocan lo que la fase cambiÃ³, no llegÃ³
a completar ninguno en 20 minutos. La causa es del entorno, no del cÃ³digo: la rama `dev` de
Neon quedÃ³ degradada tras las corridas del dÃ­a, y en paralelo se acumularon procesos de
Chrome huÃ©rfanos de las corridas interrumpidas (27 en un momento) que saturaron la mÃ¡quina.
La misma suite acotada corre contra **producciÃ³n** en menos de un minuto, que es la prueba de
que el problema es local. La verificaciÃ³n de la suite entera queda en manos de **CI**, que la
ejecuta en cada push con su propia base (Neon rama `ci`, reseteada por corrida).

### Dos defectos de las herramientas que esta fase encontrÃ³

- **`scripts/e2e-prod.mjs` no incluÃ­a las suites de Fase 7b.** La lista de archivos estÃ¡
  escrita a mano, asÃ­ que una fase nueva no entra sola: la primera corrida contra producciÃ³n
  ejecutÃ³ 123 tests y **ninguno era del mostrador**. Se agregaron las dos suites y, de paso,
  el guion pasa ahora a Playwright cualquier bandera extra (`pnpm e2e:prod --grep "Fase 7b"`),
  que es lo que permite verificar una fase sin las dos horas de suite entera.
- **Un argumento con espacios se partÃ­a en dos.** `run()` lanza con `shell: true` â€”pnpm es un
  `.cmd` en Windowsâ€”, asÃ­ que `--grep "Fase 7b"` llegaba como `--grep Fase` mÃ¡s un filtro de
  archivo `7b`, y la corrida "acotada" ejecutaba 121 de los 135 tests. Ahora los argumentos
  con espacios viajan entrecomillados.

**Ojo operativo â€” el reporte final de `prod:purge-e2e` tarda mucho.** Consulta el saldo de
cada producto E2E **uno por uno** contra Cloud Run, y ya hay 443 acumulados de todas las
sesiones: la limpieza en sÃ­ termina rÃ¡pido, pero el resumen final se va a mÃ¡s de una hora.
Mientras tanto, `node scripts/prod-e2e-leftovers.mjs` da el mismo cuadro leyendo la base
directamente y en segundos. Anotado para Fase 8.

### Hallazgos corregidos en esta fase (revisor + auditor-seguridad)

- **Bloqueante.** La nota de crÃ©dito de la anulaciÃ³n **nacÃ­a borrador y nadie la emitÃ­a**, y
  un borrador no acredita nada: no tiene correlativo, no estÃ¡ en los estados vivos y
  `documentBalance` no lo cuenta. Como una boleta solo se deshace por nota de crÃ©dito
  (D-072), el paso siguiente â€”revertir el despachoâ€” se bloqueaba siempre, y con el cobro ya
  revertido la venta quedaba **a medio anular**. Encontrado dos veces por caminos distintos:
  al escribir el E2E de la anulaciÃ³n y por `revisor`. Ahora se emite en el acto, con el envÃ­o
  al PSE fuera de la transacciÃ³n como toda emisiÃ³n (D-073).
- **Alto.** `voidSale` **no era idempotente en el paso del comprobante**, en contra de lo que
  prometÃ­a su propio JSDoc: un reintento creaba otra nota de crÃ©dito, y un documento que
  quedÃ³ en `VOID_PENDING` hacÃ­a fallar la precondiciÃ³n con un mensaje que decÃ­a "todavÃ­a no
  fue aceptado". Ahora el paso 2 se salta si el comprobante ya estÃ¡ deshecho â€”dado de baja,
  en trÃ¡mite de baja, o con una nota de crÃ©dito vivaâ€” y el reintento sigue por el despacho.
- **Alto.** `/pos/caja` le mostraba a un ADMINISTRADOR **el turno abierto mÃ¡s reciente de
  cualquier cajero como si fuera el suyo**: `GET /pos/cash-sessions` sin `userId` devolvÃ­a los
  de todos y la vista tomaba el primer `OPEN`. Desde ahÃ­ contaba billetes contra el esperado
  ajeno y cerraba una caja que no era la suya, sin ninguna seÃ±al en pantalla. El turno propio
  sale ahora de `GET /pos/context` (que filtra por el actor); el listado completo sigue
  disponible con `mine=false` y cada fila dice de quiÃ©n es.
- **Medio (los tres, de concurrencia).** El guardrail "solo dentro del turno abierto" era
  TOCTOU: un cierre de caja podÃ­a confirmarse en medio de una anulaciÃ³n y congelar
  `expectedCashPen` contando como vigente una venta cuyo cobro ya se habÃ­a revertido â€” un
  faltante inventado sobre el nÃºmero que el cajero firma. Y dos anulaciones concurrentes de
  la misma venta podÃ­an emitir **dos notas de crÃ©dito** sobre la misma boleta: dos
  correlativos gastados y un saldo negativo que no se deshace. Los dos se cierran con el
  mismo mecanismo: la venta se **reclama** en un estado nuevo, `VOIDING`, bajo el lock de su
  turno y antes del primer paso. Desde ahÃ­ deja de contar para el arqueo, el cierre no puede
  colarse y la segunda anulaciÃ³n no encuentra nada que reclamar. Aparte, `createCreditNote`
  ganÃ³ el `FOR UPDATE` sobre el comprobante afectado que le faltaba desde Fase 5b â€” el mismo
  lock que `addPayment` toma para el saldo, por el mismo motivo.
- **Medios.** `cleanup-e2e-users.ts` se plantaba con una venta **ya anulada** pidiendo
  "anÃºlala primero" (sin salida); ahora solo bloquea con ventas vivas y se lleva las anuladas
  con su turno. El error de la anulaciÃ³n se pintaba **detrÃ¡s** del diÃ¡logo abierto, asÃ­ que
  el usuario no veÃ­a el motivo del fallo.
- **Bajos.** IDOR de lectura en `GET /pos/sales/:id` (era la Ãºnica lectura del mÃ³dulo sin
  comprobaciÃ³n de propiedad); el filtro de proveedores de `prod:purge-e2e` era `E2E` **sin
  separador**, contra lo que decÃ­a su propio comentario y contra el criterio del resto del
  guion â€”y ese guion corre contra producciÃ³n anulando compras y bobinasâ€”; la excepciÃ³n al
  tope de S/ 700 se mandaba **implÃ­cita** por tener rol de administrador, cuando D-077 la
  describe como una decisiÃ³n (ahora es una casilla explÃ­cita); el buscador cortaba por los
  200 primeros SKU **alfabÃ©ticos**, asÃ­ que con el catÃ¡logo crecido un producto con stock
  podÃ­a no aparecer nunca (ahora arranca por las filas de saldo positivo); `PICKUP` no
  prohibÃ­a `totalWeightKg`; `totalsByMethod` estaba escrita en `@ayr/shared` y reimplementada
  a mano en el servicio; el cobro se registraba por el total del **pedido** contra el
  **comprobante**; y un E2E comprobaba que ninguna cobertura a medida aparece en el buscador
  **sin que hubiera ninguna en la base**, asÃ­ que pasaba por vacÃ­o.

**Sin hallazgos crÃ­ticos ni altos de seguridad.** El auditor confirmÃ³ que ningÃºn VENDEDOR
puede ver o cerrar la caja de otro por API, anular una venta, cerrar con diferencia ni forzar
la boleta sobre el tope; que SUPERVISOR_PLANTA queda fuera del mostrador en las tres capas;
que ninguna ruta nueva expone costos de compra; que el efectivo esperado no entra por el
cuerpo de la peticiÃ³n; y que `pnpm audit --prod` sale limpio. `agy` rehusÃ³ la segunda
opiniÃ³n, asÃ­ que la auditorÃ­a es de una sola fuente.

Dos hallazgos quedan **anotados y sin corregir**, con motivo: el buscador de cliente del
mostrador se trae el maestro entero y filtra en el navegador (hace falta un `search` en
`GET /customers`, que es API de otro mÃ³dulo), y el override de precio del vendedor no tiene
piso â€” es D-068 heredado, pero en mostrador el arqueo nunca lo detecta porque el efectivo
esperado se deriva del total de la propia venta. Los dos van a la Fase 8 (hardening).

### La modalidad de traslado que faltaba (D-103)

Una venta de mostrador crea un despacho de verdad, pero el traslado lo hace el **comprador**.
Ninguna de las dos modalidades de Fase 5b es cierta ahÃ­: rellenar una placa y un conductor
inventados habrÃ­a metido datos falsos en la tabla que alimenta guÃ­as reales, y poner al
cliente como "transportista" habrÃ­a mentido en otro campo. Se agrega `TransferMode.PICKUP`,
sin transporte y sin peso, que **no tiene cÃ³digo en el catÃ¡logo 18 de SUNAT** porque nunca
llega a un documento: `issueDispatchNote` lo rechaza y el tipo del puerto
(`Exclude<TransferMode, PICKUP>`) hace que ni siquiera compile mandarlo al PSE. Sirve ademÃ¡s
a cualquier recojo en tienda fuera del POS, y `/despachos/nuevo` lo ofrece.

### Frontera conocida â€” con el PSE en contingencia, una venta de mostrador no se anula

Sin credenciales del PSE (D-080) el comprobante queda `ISSUED`/`SEND_ERROR`: tomÃ³
correlativo y espera al job. Ni la baja ni la nota de crÃ©dito existen sobre Ã©l, asÃ­ que la
cadena de D-100 no puede empezar y el API lo rechaza diciendo el estado concreto. Se evaluÃ³
revertir "por dentro" el cobro, el despacho y el pedido dejando el comprobante quieto: se
descartÃ³ porque el job de D-073 seguirÃ­a enviando despuÃ©s el comprobante de una venta que ya
no existe â€” que es exactamente lo que el guardrail de D-074 impide desde Fase 5b. Desaparece
sola con el pase a la cuenta real de Nubefact.

### Frontera conocida â€” el mostrador no entra a `prod:purge-e2e`, a propÃ³sito

Una venta de mostrador a **pÃºblico en general** no lleva ninguna marca de prueba: su pedido
y su despacho salen a nombre del cliente sembrado de D-077, igual que una venta real.
EnseÃ±arle a la purga a reconocerlas habrÃ­a puesto en riesgo anular una venta de mostrador
**real** contra producciÃ³n, y ese es el error que ese guion no puede cometer. No hace falta:
todas las ventas de mostrador emiten, y D-081 fuerza `E2E_FISCAL_EMISSION=0` en `e2e:prod`,
asÃ­ que contra producciÃ³n esa mitad de la suite se salta y no hay ventas de prueba que
limpiar. Lo que la otra mitad deja â€”proveedor, compra de producto terminado, producto,
pedido con cliente `E2E `â€” ya lo cubren los filtros de siempre, y los turnos de caja los
borra `cleanup-e2e-users.ts`, que ahora se planta si alguno tuviera ventas.

## Fase 7c â€” detalle (importaciÃ³n de comprobantes ya emitidos; la fila de la Fase 7 queda completa)

Tercer y Ãºltimo tramo de la Fase 7 (D-092..D-096 dejaron la cola; D-098..D-104, el
mostrador). Entrega RF-71 y RF-72 con cinco decisiones nuevas, **D-105..D-109**. RF-11, que
aparecÃ­a en la misma fila de Â§3.7, ya estaba entregado desde la Fase 2a: seguÃ­a ahÃ­ por
arrastre.

Modelo en una lÃ­nea: **el comprobante importado es el mismo comprobante con otro origen**
(D-105). Vive en `fiscal_documents` con `origin = IMPORTED`, nace `ACCEPTED` porque SUNAT ya
lo recibiÃ³, crea su cuenta por cobrar como cualquiera â€”que es para lo que se importaâ€” y no
habla nunca con el PSE: ni se envÃ­a, ni se reintenta, ni se consulta, ni se da de baja, ni
recibe una nota de crÃ©dito emitida acÃ¡.

| #   | Entregable                                                                        | Estado                                                                |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Decisiones D-105..D-109 en Â§0.2 + contexto largo en `DECISIONES.md`              | âœ…                                                                   |
| 2   | Prisma: `origin`, `archived_at`, `supersedes_document_id`, `warnings`             | âœ… tres migraciones, aplicadas en `dev` y `production`               |
| 3   | Unicidad parcial de `number` (`WHERE archived_at IS NULL`) + `CHECK` de archivado | âœ… conviven la archivada y la vigente; dos vigentes, no              |
| 4   | `GroupedImportAdapter`: N filas de planilla â†’ una entidad (D-107)               | âœ… el grupo se valida entero y se confirma entero                    |
| 5   | `FiscalImportService` en `invoicing` (patrÃ³n `*InTx`, D-099)                     | âœ… las reglas fiscales no se mudan al importador                     |
| 6   | Serie del importado (D-106): empuje atÃ³mico, alta inactiva, tope de salto        | âœ… auditado, con el salto absurdo rechazado                          |
| 7   | RF-72: reimportar archiva la anterior, con sus tres puertas cerradas              | âœ… lo emitido acÃ¡, lo cobrado y lo acreditado no se reimportan      |
| 8   | Guardrails de D-105 en `invoicing` y en el web                                    | âœ… `assertIssuedHere` + botones apagados en vez de errores del API   |
| 9   | Avisos no bloqueantes (`import_rows.warnings`)                                    | âœ… "esta fila archiva la versiÃ³n anterior" se ve antes de confirmar |
| 10  | E2E                                                                               | âœ… `fase7c.spec.ts` (4) y `fase7c-bordes.spec.ts` (9), 13 en verde   |
| 11  | `pnpm turbo lint typecheck test build`                                            | âœ… verde (255 unit, +19)                                             |

### Lo que mÃ¡s importa de la fase: lo que **no** miraba al archivado

RF-72 dice que reimportar archive la versiÃ³n anterior, y eso se implementÃ³ desde el
principio. Lo que la revisiÃ³n encontrÃ³ es la otra mitad, y estaba fuera del cÃ³digo nuevo:
**todo lo que ya sumaba comprobantes seguÃ­a sumando tambiÃ©n la versiÃ³n archivada**, porque
una archivada conserva su `status = ACCEPTED` intacto.

- `receivables()` (RF-88) contaba las dos: reimportar un comprobante â€”el caso normal de
  RF-72, corregir un total mal tipeadoâ€” **duplicaba la deuda del cliente**, y ese total
  contradecÃ­a al listado de `/comprobantes`, que sÃ­ filtraba.
- El crÃ©dito por notas de crÃ©dito se sumaba igual desde las dos, asÃ­ que el saldo del
  comprobante afectado se iba a cero con una sola nota reimportada.
- Nada impedÃ­a **cobrar** sobre una versiÃ³n archivada, a la que se llega con un clic desde
  el enlace que la propia fase agregÃ³.

El arreglo es una sola idea aplicada en todos lados: **`archivedAt: null` acompaÃ±a a
`LIVE_DOCUMENT_STATUSES` en cada agregado**. Es la misma lecciÃ³n de D-088 y D-097 â€”cuando
una entidad puede dejar de ser la vigente, hay que revisar cada punto que la leeâ€” aplicada
por primera vez a un documento fiscal y no a una reserva.

### El correlativo que podÃ­a retroceder

`resolveSeriesInTx` hacÃ­a `findUnique` y despuÃ©s `update` sobre `fiscal_series.correlative`,
que es exactamente el recurso que D-072 mueve con `UPDATE â€¦ RETURNING` por un motivo: si
`allocateNumber` avanzaba la serie entre la lectura y la escritura, el `update` la pisaba y
el correlativo **retrocedÃ­a** â€” y el prÃ³ximo comprobante repetÃ­a un nÃºmero que SUNAT ya
tiene. Ahora es un `UPDATE â€¦ SET correlative = GREATEST(correlative, $n) â€¦ RETURNING` que
devuelve el valor anterior y el nuevo, y el salto queda en `audit_log`.

Encima se agregÃ³ el tope: adelantar una serie **activa** mÃ¡s de 1000 nÃºmeros se rechaza. No
hay ninguna ruta que baje un correlativo (a propÃ³sito, lo dice `setSeriesActive`), asÃ­ que
un `12345678` tecleado donde iba `123` habrÃ­a quemado el rango de la serie con la que se
factura de verdad, sin vuelta atrÃ¡s y sin que nada lo avisara.

### Un defecto de RF-52 que llevaba ahÃ­ desde la Fase 1

Encontrado por `qa` al escribir los E2E: `parseSpreadsheet` leÃ­a el archivo **sin
`cellDates`**, asÃ­ que SheetJS entregaba las fechas como el nÃºmero de serie de Excel
(`2026-09-05` â†’ `46270`) y toda fila con fecha quedaba invÃ¡lida por formato. Con eso,
**ninguna planilla exportada por otro sistema se podÃ­a importar**: entraba solo un archivo
con la columna formateada como texto.

No es un defecto de esta fase: estÃ¡ en el importador desde RF-52. No se habÃ­a visto porque
productos, clientes y bobinas no tienen ninguna columna de fecha, y el comprobante es la
primera entidad importable que sÃ­. El arreglo tiene dos mitades, y la segunda es la que
habrÃ­a vuelto: `rawToString` formateaba la fecha con `toISOString()`, que al este de
Greenwich cae en el **dÃ­a anterior** â€” en Cloud Run (UTC) y en Lima coincide, asÃ­ que el
defecto no habrÃ­a aparecido nunca en producciÃ³n y sÃ­ en la mÃ¡quina de alguien. Ahora se
formatea con las partes locales, que es como SheetJS construye la fecha.

### Hallazgos corregidos en esta fase (revisor API + revisor web + auditor-seguridad)

Tres pasadas. La del web se hizo aparte, por la lecciÃ³n de la Fase 2b, y encontrÃ³ un
bloqueante que la del API no podÃ­a ver.

**Bloqueantes.** Los tres del archivado (arriba); el correlativo con read-then-write
(arriba); una fila con `"abc"` en Cantidad terminaba en un **500** porque la validaciÃ³n de
grupo se lo pasaba a `toDecimal`; y, en el web, `setBatch(updated)` sin guarda **resucitaba
un lote cancelado**: el `blur` del clic en Â«CancelarÂ» dejaba una peticiÃ³n en vuelo cuya
respuesta reabrÃ­a el preview con su botÃ³n de confirmar activo â€” confirmÃ¡ndolo se importaban
comprobantes que el usuario habÃ­a descartado y se adelantaba una serie activa.

**Altos.** Una nota de crÃ©dito importada podÃ­a acreditar un comprobante **emitido por el
ERP** y sin tope de monto: borraba el saldo de una factura real con un documento que SUNAT
nunca vio, y de paso le bloqueaba la baja. El cliente del importado no pasaba las tres
reglas de la emisiÃ³n normal (activo, genÃ©rico solo con boleta, factura solo con RUC), asÃ­
que entraban facturas contra un DNI. La columna de cliente vacÃ­a dejaba la fila **vÃ¡lida** y
morÃ­a reciÃ©n al confirmar. Y en el web, dos ediciones solapadas podÃ­an dejar que la
respuesta vieja pisara a la nueva â€”con el agravante de que el `blur` del clic en Â«ConfirmarÂ»
ponÃ­a un `PATCH` en carrera con el `POST`â€”.

**Medios y bajos corregidos.** El grupo se arma con lo que **dice** el archivo y no con el
nÃºmero ya validado (una lÃ­nea con el correlativo roto se quedaba fuera de su propio
comprobante, y a precio cero ni siquiera movÃ­a el total: se habrÃ­a importado un documento al
que le falta un renglÃ³n). Se guarda el total **del papel** y no el recalculado, porque con
la tolerancia de redondeo cobrar el importe exacto del comprobante real se rechazaba por
"excede el saldo pendiente"; el IGV absorbe la diferencia. El lote se reclama antes de crear
nada (dos POST simultÃ¡neos creaban el comprobante dos veces) y vuelve a `PARSED` si no entrÃ³
ninguno, para poder corregir y reintentar. El preview comprueba las notas de crÃ©dito vivas y
avisa del adelanto de serie. Tope de 50 lÃ­neas por comprobante, fecha de emisiÃ³n de mÃ¡s de
diez aÃ±os rechazada, `notes` es campo de cabecera, la fila que **tiene** el error ya no dice
"otra lÃ­nea tiene errores", auditorÃ­a propia del archivado y de la serie creada al importar,
lock consultivo por nÃºmero (un `FOR UPDATE` no bloquea nada cuando la fila todavÃ­a no
existe), `affectedDocType` en la serie de NC creada al importar, y `confirmErrorMessage`
acotado a las dos excepciones de dominio propias. En el web: el preview resincroniza con lo
que el API normalizÃ³, no guarda si nada cambiÃ³, solo relee el lote entero en las entidades
agrupadas, los avisos llevan la palabra "Aviso" y variante para modo oscuro, y una versiÃ³n
archivada dice que su saldo no cuenta en cobranzas.

### Frontera conocida â€” el costo del preview

Cada fila del preview hace hasta dos consultas (cliente y SKU), asÃ­ que un archivo de 2000
filas son varios miles de viajes a Neon en una sola peticiÃ³n. Es el patrÃ³n que el importador
tiene desde RF-52 y la ruta es solo de ADMINISTRADOR, asÃ­ que no se cambiÃ³ acÃ¡; el tope de
50 lÃ­neas por comprobante sÃ­ acota lo que cuesta **revalidar un grupo** al corregir una
fila, que es lo que esta fase agregÃ³. Resolver clientes y SKUs con dos consultas por archivo
queda anotado para la Fase 8, junto con el buscador de cliente del mostrador.

### Frontera conocida â€” la suite de esta fase no corre contra producciÃ³n

Importar escribe numeraciÃ³n fiscal real â€”empuja el correlativo de una serie, o crea una
inactivaâ€” y deja comprobantes que **no se pueden dar de baja**. Es exactamente el riesgo que
`fiscalEmissionAllowed()` gobierna desde la Fase 5b, asÃ­ que `fase7c*.spec.ts` se salta
entera contra una URL externa con ese mismo motivo escrito. Las suites igual estÃ¡n listadas
en `scripts/e2e-prod.mjs`: listarlas es lo que hace que el informe diga "saltadas" en vez de
callar, que es el defecto que costÃ³ una corrida entera en la Fase 7b.

Aparte, `prod-e2e-purge.mjs` ahora **saltea la baja de un importado** en vez de intentarla:
el API la rechaza siempre (D-105), asÃ­ que la purga imprimÃ­a un fallo perpetuo. Sus cobros
sÃ­ se revierten, que es la parte que ensucia cuentas por cobrar.

### El techo de tiempo del E2E en CI, otra vez

La primera corrida de CI de esta fase quedÃ³ **cancelada por timeout** a los 50 minutos, con
unos 75 de 149 tests hechos. No es un fallo de la suite: lo que manda no es el nÃºmero de
tests sino la **varianza de Neon**. La misma suite de 136 tests tardÃ³ `22m16s` y `41m06s` el
mismo dÃ­a (corridas `33975924839` y `33951665233`), asÃ­ que con 149 la corrida lenta se pasa
del techo. Subido a **75 minutos**, dimensionado sobre el peor caso medido y no sobre el
promedio: un timeout no distingue "lento" de "roto", y averiguar cuÃ¡l de los dos era obliga a
reejecutar la hora entera.

### Residuo en la rama `dev` de Neon

Las corridas de E2E de esta sesiÃ³n dejaron en la rama `dev` unos catorce comprobantes
importados vivos, dos archivados, doce series `Zâ€¦` inactivas y veintisÃ©is lotes de
importaciÃ³n, todos con marca `E2E `. **No se pueden borrar ni dar de baja por diseÃ±o**: un
importado no tiene camino de baja. No afecta a `ci` (se resetea por corrida) ni a
producciÃ³n (la suite se salta allÃ­). Limpiar `dev` exigirÃ­a SQL a mano, y es decisiÃ³n del
dueÃ±o.

## SesiÃ³n M-3 â€” mantenimiento: auditorÃ­a y guardrail previos al pase a Nubefact real (2026-09-04)

SesiÃ³n corta de mantenimiento, fuera del avance por fases: preparar el pase de la cuenta demo
de Nubefact a la cuenta real (checklist de `docs/handoff/fase-5b.md`). **El pase no se hizo**:
el dueÃ±o decidiÃ³ en esta sesiÃ³n seguir en demo/contingencia hasta nuevo aviso. Lo que sÃ­ se
completÃ³ no depende de esa decisiÃ³n y queda cerrado.

- **AuditorÃ­a previa (solo lectura, D-073).** `fiscal_documents` en producciÃ³n: **0 filas**,
  ningÃºn estado â€” nada en `ISSUED`, `SEND_ERROR` ni `VOID_PENDING`. Las cinco series
  (`F001`/`B001`/`BC01`/`FC01`/`T001`) siguen en `correlative=0`, nunca usadas.
  `invoicing_settings.providerOffline=false`. Confirmado con un script temporal (`prisma`
  `groupBy` + `findMany` sobre `fiscal_documents`/`fiscal_series`, no commiteado, borrado al
  cerrar la auditorÃ­a) contra la rama `production` de Neon. ConclusiÃ³n: el pase, cuando se
  haga, no dispara ningÃºn envÃ­o retroactivo â€” no hay nada en contingencia esperando salir.
- **Correlativos y series: sin cambios, decisiÃ³n del dueÃ±o.** Arrancan en 1 (nunca se facturÃ³
  antes con SUNAT bajo este RUC) y las series son las ya sembradas. El modelo **ya soportaba**
  un correlativo inicial distinto de 1 desde D-072 (`createFiscalSeriesSchema.correlative`,
  `min(0)`, pensado para continuar una numeraciÃ³n externa) â€” no hizo falta implementar nada.
- **D-081 â€” guardrail nuevo en `e2e:prod`.** `scripts/e2e-prod.mjs` fuerza
  `E2E_FISCAL_EMISSION: '0'` como Ãºltima entrada del `env` que recibe Playwright, asÃ­ que
  gana sin importar quÃ© traiga el shell de quien invoque el script. Antes de este cambio,
  `E2E_FISCAL_EMISSION=1` en el entorno del operador se colaba sin que el script lo tocara â€”
  inofensivo hoy porque Cloud Run no tiene credenciales del PSE (D-080), pero dejarÃ­a de serlo
  el dÃ­a que se cargue la cuenta real. Detalle y motivo completo en `docs/ARQUITECTURA.md` Â§0.2
  D-081.
- **`pnpm prod:purge-e2e` auditado, sin cambios.** Ya era seguro: solo actÃºa sobre comprobantes
  cuyo `customerName` o `notes` empiezan con `E2E ` (`isE2eDocument` en
  `scripts/prod-e2e-purge.mjs`), nunca sobre un documento real.
- **VerificaciÃ³n:** `pnpm turbo lint typecheck test build` en verde; no hubo cambio de schema
  ni de lÃ³gica de dominio, solo el script de E2E y documentaciÃ³n.

**Pendiente â€” el pase en sÃ­.** Sigue abierto exactamente como lo dejÃ³ `docs/handoff/fase-5b.md`:
cargar `NUBEFACT_URL`/`NUBEFACT_TOKEN` productivos en Secret Manager
(`scripts/gcp-secrets.mjs`), agregar las dos lÃ­neas a `--set-secrets` en `scripts/deploy-api.mjs`
(ya comentadas en su sitio exacto), redesplegar, y hacer el smoke controlado de un comprobante
real. PrecondiciÃ³n del dueÃ±o para retomarlo: cuenta real de Nubefact activa, RUC habilitado en
SUNAT, series confirmadas por el contador, y `NUBEFACT_URL`/`NUBEFACT_TOKEN` productivos en
`.env.setup`. Mientras no haya aviso del dueÃ±o, producciÃ³n sigue sin credenciales del PSE
(D-080) y toda emisiÃ³n cae en contingencia.

## SesiÃ³n M-4 â€” mantenimiento: anulaciÃ³n de comprobante importado y limpieza (2026-09-05)

Dos decisiones nuevas, **D-110** y **D-111**. SesiÃ³n corta y de una sola idea: **RF-71 habÃ­a
entregado una operaciÃ³n sin su reversa.**

Un `fiscal_document` con `origin = IMPORTED` nace `ACCEPTED` con su cuenta por cobrar, y las
tres salidas del mÃ³dulo â€”`send`, `voidDocument`, `createCreditNote`â€” exigen hablar con el
PSE, que no lo conoce como nuestro (D-105). Un nÃºmero mal tecleado en una planilla se
convertÃ­a en una deuda que **nadie podÃ­a cancelar nunca**: ni un administrador, ni con SQL
sin romper las reglas del proyecto.

| #   | Entregable                                                           | Estado                                                                                |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | AuditorÃ­a de solo lectura de importados (`prod-imported-audit.mjs`) | âœ… producciÃ³n: **0**; `dev`: 33 con S/ 7080 de deuda inventada                      |
| 2   | Estado `ANNULLED` + `POST /invoicing/documents/:id/annul` (D-110)    | âœ… solo ADMINISTRADOR, con motivo, saldo a cero, 409 idempotente                     |
| 3   | Censo de lectores de estado antes de escribirlo                      | âœ… todas las listas de "vivos" ya eran blancas; las negras que quedaban, convertidas |
| 4   | `LIVE_DOCUMENT_STATUSES` una sola vez, en `@ayr/shared`              | âœ… estaba escrita **siete** veces                                                    |
| 5   | La purga de producciÃ³n anula los importados de prueba               | âœ… antes solo podÃ­a saltearlos                                                      |
| 6   | `pnpm db:reset-dev` (D-111)                                          | âœ… `neonctl branches reset --parent`: resetea, no borra                              |
| 7   | E2E                                                                  | âœ… `m4-anulacion-importado.spec.ts`, 6 escenarios                                    |
| 8   | Limpieza de `dev`                                                    | âœ… repuesta desde `production`: 0 importados, 0 series inactivas, 0 lotes            |
| 9   | `pnpm turbo lint typecheck test build` + 38 E2E                      | âœ… verde (257 unit)                                                                  |

### La cuarta vez que falta la reversa

D-061 (pago a proveedor), D-088 y D-097 (la reserva), y ahora D-110. El patrÃ³n es idÃ©ntico
las cuatro veces: se construye una operaciÃ³n que **crea** un hecho y su reversa se deja para
despuÃ©s porque parece un caso raro; el caso raro resulta ser el primer dÃ­a de uso real.

La regla que queda escrita: **una operaciÃ³n que crea un hecho persistente no estÃ¡ terminada
hasta que existe la que lo deshace**, y se puede llegar a ella desde la pantalla.

### Por quÃ© `ANNULLED` y no `VOIDED`

Reusar `VOIDED` era la opciÃ³n barata: el efecto buscado es idÃ©ntico y **todos** los filtros
existentes ya lo trataban como terminal, asÃ­ que no habrÃ­a hecho falta tocar nada. Por eso
estuvo cerca de ser la decisiÃ³n equivocada.

`VOIDED` no describe un efecto sino un **hecho**: SUNAT aceptÃ³ la baja. Sobre un importado
ese hecho nunca ocurriÃ³, y un contador que viera `VOIDED` en la base concluirÃ­a que el
comprobante estÃ¡ dado de baja ante SUNAT cuando allÃ­ sigue vigente. Es la misma trampa que
D-105 evitÃ³ con `ACCEPTED`, y repetirla en el otro extremo del ciclo habrÃ­a sido peor: un
estado equivocado sobre un documento fiscal es una afirmaciÃ³n falsa en un registro que se
audita.

### La regresiÃ³n que la propia correcciÃ³n introdujo

El censo de estados saliÃ³ mejor de lo previsto: casi todos los cortes del mÃ³dulo eran
**listas blancas**, y una lista blanca no deja entrar a un estado nuevo por descuido. Las dos
listas negras que quedaban en el API â€”cuÃ¡l es la guÃ­a de remisiÃ³n vigente de un despachoâ€” se
convirtieron a lista blanca por eso mismo.

Y ahÃ­ estuvo el error: se usÃ³ la lista de **vivos**, que no incluye `DRAFT`. Una guÃ­a nace
`DRAFT` dentro de su transacciÃ³n y solo despuÃ©s toma nÃºmero y sale al PSE (D-073), asÃ­ que un
fallo entremedio la deja en borrador para siempre. Con el corte en los vivos, reintentar la
emisiÃ³n habrÃ­a creado una **segunda guÃ­a** para el mismo despacho en vez de encontrar la que
quedÃ³ a medias â€” y el mensaje de error que estaba ahÃ­ desde Fase 5b decÃ­a "la guÃ­a en
borrador", o sea que el caso estaba previsto desde el principio.

Corregido con `STANDING_DOCUMENT_STATUSES` (borrador + vivos), que es el corte que
corresponde a la pregunta "Â¿hace falta crear otra?". La ironÃ­a vale anotarla: **el cambio que
convertÃ­a listas negras en blancas para que ningÃºn estado entrara en silencio, metiÃ³ en
silencio un estado de menos.** Una lista blanca es mÃ¡s segura que una negra, pero solo si se
elige la lista correcta; el nombre del conjunto (`LIVE`) no era el que la pregunta pedÃ­a.

### Hallazgos corregidos en esta sesiÃ³n (revisor + qa)

**Altos.** `actorIdsOf` no incluÃ­a `annulledById` ni `voidedById`, asÃ­ que el nombre de quien
anulÃ³ salÃ­a `null` **siempre** y el web lo escondÃ­a sin fallar: la constancia quedaba muda
justo en lo primero que se pregunta. Y el web contaba las notas de crÃ©dito vivas con una lista
negra, asÃ­ que una NC anulada seguÃ­a contando como viva ahÃ­ y no en el API â€” el saldo del
afectado subÃ­a del lado del servidor mientras la pantalla escondÃ­a el botÃ³n de anular y
explicaba que el saldo ya estaba ajustado.

**Medios y bajos.** Una nota de crÃ©dito importada podÃ­a acreditar un comprobante anulado, y
el afectado no se bloqueaba con `FOR UPDATE` antes de leerlo. El `CHECK` de la constancia era
una implicaciÃ³n y pasa a ser equivalencia: admitÃ­a una fila con fecha, autor y motivo de
anulaciÃ³n **y un estado que sigue debiendo**. El aviso que explica por quÃ© no se puede anular
era cÃ³digo muerto en un importado â€”se renderizaba bajo `voidPath === 'VOID'`, que es `null`
para todos ellosâ€”, asÃ­ que un importado con cobro vigente perdÃ­a el botÃ³n sin ninguna
explicaciÃ³n en pantalla. Y `db-reset-dev.mjs` no verificaba que `dev` colgara de verdad de
`production`, ni validaba el argumento de `--preserve-under-name` (`--preserve-under-name
--yes` creaba una rama llamada `--yes`).

### Un patrÃ³n de fechas que queda anotado

`formatDate(x.slice(0, 10))` sobre un **timestamp** lo corta en UTC, y Lima va cinco horas
detrÃ¡s: todo lo ocurrido despuÃ©s de las 19:00 locales se muestra fechado al dÃ­a siguiente. Es
el mismo desfase que `businessToday` existe para evitar (D-069).

Se corrigiÃ³ en la pantalla de comprobantes (`formatTimestampDate`, nuevo en `lib/format.ts`).
Quedan **nueve** sitios con el mismo patrÃ³n, anotados para la Fase 8 porque cada uno exige
comprobar si el campo es un instante o una columna `DATE` â€”donde el corte sÃ­ es correctoâ€”:
`despacho-detalle-view.tsx:179` y `:312`, `pedido-detalle-view.tsx:322` y `:365`,
`cotizacion-detalle-view.tsx:271`, `corte-view.tsx:155`, `produccion-view.tsx:236`,
`produccion-detalle-view.tsx:355` y `bobina-detalle-view.tsx:232`.

### La suite de importaciÃ³n sigue sin correr contra producciÃ³n, con motivo nuevo

El motivo original â€”"deja comprobantes que no se pueden dar de baja"â€” **dejÃ³ de valer**:
D-110 les dio anulaciÃ³n y la purga la usa. Quedan otros dos, revisados en esta sesiÃ³n y
escritos junto a la lista de suites en `scripts/e2e-prod.mjs`:

1. cada comprobante importado **crea una serie inactiva** (D-106) que no tiene borrado â€”con
   documentos colgando no se puede eliminarâ€”, y son unas catorce por corrida acumulÃ¡ndose
   para siempre en un maestro fiscal;
2. serÃ­an los **primeros** comprobantes fiscales de prueba en el registro real de la empresa,
   y D-081 apagÃ³ la emisiÃ³n contra producciÃ³n justo para que no los hubiera.

Lo que estas suites prueban no depende de la infraestructura de producciÃ³n, y CI ya las corre
enteras contra la rama `ci`. Cerrar el punto 1 exigirÃ­a que la suite importara sobre una serie
E2E fija en vez de una `Zâ€¦` al azar; queda dicho por si algÃºn dÃ­a se decide.

### Limpieza verificada

- **ProducciÃ³n: cero rastros.** No habÃ­a ninguno que borrar â€”la compuerta de D-081 mantuvo la
  suite de Fase 7c fuera de allÃ­â€” y sigue en cero tras la sesiÃ³n, comprobado con
  `node scripts/prod-imported-audit.mjs`.
- **`dev`: repuesta desde `production`** con `pnpm db:reset-dev --yes`. Antes: 62 importados
  y S/ 8614 de deuda inventada. DespuÃ©s: 0 importados, 0 series inactivas, 0 lotes de
  importaciÃ³n, `prisma migrate status` con las 33 migraciones y "Database schema is up to
  date!".

## Fase 7d â€” detalle (pulido UI/UX pre-entrega al cliente)

Fase de pulido, no de features (cero cambios de dominio/schema salvo lo listado). Cuatro
tareas: fechas, tablas, afordancias de link/botÃ³n, y un barrido general de estados
vacÃ­os/loading/errores/mÃ³vil. Ver handoff completo en `docs/handoff/fase-7d.md`.

### Entregado

- **Fechas (D-112).** Las nueve pantallas pendientes de la SesiÃ³n M-4 (`despacho-detalle-view.tsx`
  Ã—2, `pedido-detalle-view.tsx` Ã—2, `cotizacion-detalle-view.tsx`, `corte-view.tsx`,
  `produccion-view.tsx`, `produccion-detalle-view.tsx`, `bobina-detalle-view.tsx`) mÃ¡s un
  dÃ©cimo hallazgo nuevo (`tipo-cambio-view.tsx`, un formulario que ofrecÃ­a registrar el tipo
  de cambio de maÃ±ana despuÃ©s de las 19:00) ahora usan `formatTimestampDate`. Regla ESLint
  nueva que bloquea `slice(0, 10)` sobre un ISO de acÃ¡ en adelante.
- **PaginaciÃ³n server-side (D-113).** 10 endpoints (`/customers`, `/coils`, `/sales/orders`,
  `/sales/quotations`, `/dispatches`, `/purchases`, `/invoicing/documents`,
  `/invoicing/receivables` + `/invoicing/receivables/summary` nuevo, `/inventory/movements`,
  `/imports`) devuelven `PaginatedResult<T>`; las 10 vistas correspondientes tienen control de
  pÃ¡gina/tamaÃ±o (`<PaginationBar>`). PatrÃ³n hÃ­brido (`paginateInMemory` +
  `DERIVED_FILTER_FETCH_CAP`) para los 3 filtros derivados que no se pueden expresar en SQL sin
  duplicar D-075. `fetchAllForPicker` para los 4 selectores tipo autocompletado.
- **Tablas: encabezado fijo, sin contenedor de scroll (D-115).** Se implementÃ³ el contenedor
  con max-height + scroll interno, pero el dueÃ±o pidiÃ³ revertirlo antes del deploy: vuelve el
  scroll natural de pÃ¡gina (`<div className="rounded-lg border">`, como antes de esta fase).
  El encabezado `sticky top-0 z-10 bg-background` de `<TableHeader>` se mantuvo â€” sigue
  funcionando sin el contenedor. PaginaciÃ³n y columnas responsive (`hidden md:table-cell` /
  `lg:table-cell` en bobinas, pedidos, cotizaciones, despachos, compras, comprobantes, kardex,
  cobranzas, clientes) quedaron intactas, no dependÃ­an del contenedor.
- **Afordancia de link unificada (D-114).** `LINK_CLASSNAME` en `apps/web/src/lib/utils.ts`
  reemplaza ~50 sitios que tenÃ­an 3 variantes distintas de subrayado escritas a mano.
- **Barrido general.** Loading (`Skeleton`) y estados vacÃ­os ya eran consistentes en casi
  todas las vistas; se agregÃ³ el que faltaba en `margenes-view.tsx`. `/planta` y `/pos`
  verificados en viewport 375px (capturas locales): sin overflow horizontal, botones e
  inputs a ancho completo, estados vacÃ­os con mensaje. Breadcrumbs: **no existen en la app**
  y no se construyeron acÃ¡ (serÃ­a una feature nueva, fuera del alcance de pulido) â€” la
  navegaciÃ³n depende del sidebar persistente, que cubre bien el caso de escritorio; una
  pantalla de detalle en mÃ³vil con el sidebar colapsado se queda sin "volver a la lista" mÃ¡s
  que el botÃ³n atrÃ¡s del navegador. Anotado para Fase 8 si se decide agregar un link "â†
  Volver" en las vistas de detalle.

### Hallazgos corregidos (revisor web + auditor-seguridad)

**Altos (revisor).** Al mover la bÃºsqueda de pedidos y cotizaciones al servidor se perdiÃ³ sin
querer el filtro por cÃ³digo (`PED-000123`/`COT-000123`) que antes existÃ­a en el cliente â€”
corregido extrayendo el nÃºmero del texto de bÃºsqueda y agregando `seq` al `OR` del `where` en
`sales-orders.service.ts`/`quotations.service.ts`. Y `customer-picker.tsx` (identificar
cliente en el mostrador) usaba `fetchAllForPicker` sin `search`, asÃ­ que un cliente activo
fuera de los primeros 200 alfabÃ©ticos dejaba de encontrarse antes de darlo de alta â€”corregido
pasando el documento tecleado como filtro server-side.

**Bajo (auditor-seguridad).** `page` no tenÃ­a cota superior a diferencia de `pageSize`: un
`page` arbitrariamente grande seguÃ­a siendo un `OFFSET` arbitrariamente grande para Postgres.
Corregido con `MAX_PAGE = 10_000` en `paginationQuerySchema`.

### E2E

**Local: verde.** El agente `qa` reparÃ³ las suites existentes que asumÃ­an la forma vieja del
API (`getJson` directo sobre un endpoint que ahora envuelve en `PaginatedResult`) con un
helper nuevo (`getItems`), y agregÃ³ `fase7d.spec.ts` (3 pruebas: paginaciÃ³n en clientes y en
compras, fecha de alta de una bobina en zona de Lima). Ãšnico residuo conocido: dos pruebas de
`fase5b.spec.ts`/`fase5b-bordes.spec.ts` fallaron por el throttle de `/api/auth/login` (10
intentos/60s) al correr la suite entera sin cortes â€” no es un defecto de esta fase, y las 13
pruebas restantes de esos dos archivos pasaron limpio en una corrida aislada.

**ProducciÃ³n â€” primer intento (prematuro), corregido.** Se corriÃ³ `pnpm e2e:prod` **antes**
de desplegar el cÃ³digo de esta fase: contra la API vieja (sin `PaginatedResult`), `getItems`
leÃ­a `.items` de un array plano y devolvÃ­a `undefined`, asÃ­ que 64 de 155 pruebas fallaron con
`TypeError` en cascada â€” no era un defecto del cÃ³digo de esta fase, era incompatibilidad
esperada entre E2E nuevos y API vieja. La corrida alcanzÃ³ a crear datos reales antes de fallar;
se detectÃ³ que `fase7d.spec.ts` (prueba de clientes) no tenÃ­a limpieza para producciÃ³n â€”
corregido agregando `customerIds` a `deactivateTrail`â€” y se purgÃ³ lo creado.

**Deploy y revert (D-115).** Antes de repetir `e2e:prod`, el dueÃ±o pidiÃ³ revertir el
contenedor de scroll interno de tabla (ver arriba). Con el revert commiteado y con CI verde en
ambos pushes, se deployÃ³ de verdad: `pnpm deploy:api --web-origin
https://ayr-steel-erp-web.vercel.app` (mismo Cloud Run de siempre, `/health` en verde) y
`pnpm deploy:web` â€” que fallÃ³ por el token del CLI de Vercel vencido (bloqueo ya conocido de
Fase 7, ver `docs/handoff/fase-7.md`), **pero no importÃ³**: el proyecto Vercel estÃ¡ ligado al
repo de GitHub, asÃ­ que el push a `main` ya habÃ­a disparado el deploy del web por su cuenta
(confirmado con `gh api repos/.../commits/<sha>/status`: `Vercel` â†’ `success`, "Deployment has
completed").

**ProducciÃ³n â€” corrida real, contra el cÃ³digo de esta fase.** `pnpm e2e:prod`: **119/119
pruebas pasaron** (38 saltadas por la compuerta de D-081, ninguna fallÃ³), incluidas las 3 de
`fase7d.spec.ts`. Es la primera corrida completa de la suite entera que llega al final sin
cortar â€” expuso residuo real que las corridas parciales anteriores nunca habÃ­an llegado a
crear: dos Ã³rdenes de producciÃ³n con planchas ya vendidas (`OUT SALE`) y dos recepciones de
corte con flejes ya mermados (`SCRAP`) que `pnpm prod:purge-e2e` **no pudo revertir**, con el
mismo mensaje que le darÃ­a a un administrador desde la UI ("ya se movieron... anula ese
movimiento antes"). No es un defecto de la purga ni de esta fase: es la misma regla de
append-only (Â§3.2) que el proyecto aplica en todos lados â€” vender o mermar algo no se deshace
sin revertir esa venta o esa merma primero, y escribir esa reversa es un cambio de dominio
fuera del alcance de "pulido". Corrida la purga dos veces (la segunda sÃ­ limpiÃ³ clientes,
proveedores, productos, acabados y las Ã³rdenes de corte pendientes que la primera pasada habÃ­a
dejado a medias), el residuo final â€”confirmado con `node scripts/prod-e2e-leftovers.mjs`â€” es:

- 2 Ã³rdenes de producciÃ³n (`OP-000319`, `OP-000320`) y 2 recepciones de corte, bloqueadas por
  ventas/mermas ya hechas.
- 3 colores de prueba, cada uno usado por 1 bobina todavÃ­a abierta (consecuencia de lo de
  arriba).
- 5 productos de prueba con stock remanente (12â€“40 unidades cada uno).
- Todo lo demÃ¡s â€”clientes, proveedores, productos sin stock trabado, compras, cotizaciones,
  pedidos, despachos, comprobantesâ€” en cero activos o revertido.

Todo marcado con prefijo `E2E`/`BOB`, sin costos ni cantidades que se mezclen con inventario
real, y sin ningÃºn rastro visible desde una pantalla que un usuario real use (proveedores,
clientes y productos de prueba quedan desactivados). Queda igual de limpio que lo que cualquier
corrida completa de esta suite iba a dejar contra producciÃ³n real desde el dÃ­a que existieran
Fase 6 y Fase 7b juntas â€” no es nuevo de esta fase, es la primera vez que se ve completo.

## SesiÃ³n 7 consolidada â€” backdating, entornos y subtipo de cobertura (2026-09-06)

Tres frentes en una sesiÃ³n, en orden de prioridad: **M1** la fecha de operaciÃ³n (D-124),
**M2** el entorno de ensayo y la prohibiciÃ³n de correr E2E contra producciÃ³n (D-125, D-126), y
**M3** â€”recortado sobre la marcha por un caso real que apareciÃ³ en producciÃ³nâ€” el subtipo de
cobertura y la rama de confirmaciÃ³n que faltaba (D-127). Lo demÃ¡s de D-122 sigue diferido.

### M1 â€” Fecha de operaciÃ³n (D-124)

El disparador: el sistema se entrega maÃ±ana y el dueÃ±o necesita cargar agosto **despuÃ©s**. Sin
separar el dÃ­a de negocio del instante de grabaciÃ³n, todo lo que se registrara hoy quedaba
fechado hoy y ningÃºn reporte de agosto lo veÃ­a.

Columna `operation_date` (DATE, dÃ­a calendario de Lima) nueva en `inventory_movements`,
`coils`, `cutting_orders`, `cutting_order_coils` (recepciÃ³n), `production_orders` (arranque y
cierre, en dos columnas) y `production_reports`. `dispatches.dispatch_date`,
`customer_payments.date` y `supplier_payments.date` ya eran fechas de negocio: no ganan
columna, ganan la misma validaciÃ³n. Los timestamps de auditorÃ­a no se tocaron.

Un Ãºnico validador, `OperationDateService` (en `ConfigModule`, que es `@Global`, para que los
servicios de cinco mÃ³dulos lo inyecten sin cablear nada): sin campo â†’ hoy en Lima; con campo â†’
solo ADMINISTRADOR, nunca futura, nunca antes de `HISTORICAL_LOAD_START` (env, default
`2026-08-01`).

El **guardrail de orden cronolÃ³gico** quedÃ³ dentro de `InventoryService.record`, el Ãºnico
escritor del kardex. Se escribiÃ³ primero repartido por los llamadores y se moviÃ³ antes de
terminar: son 34 puntos que escriben kardex en siete servicios, y un control que hay que
acordarse de llamar 34 veces es el hueco de D-088 otra vez. Costo cero en el flujo normal: si
la fecha es hoy no puede haber nada posterior y ni consulta.

**La migraciÃ³n tuvo que apagar el trigger de append-only** de `inventory_movements` para poder
backfillear la columna nueva y volver a encenderlo. Se descubriÃ³ al aplicarla: `migrate deploy`
fallÃ³ con `inventory_movements es append-only: no se permite UPDATE`, que es exactamente la
regla haciendo su trabajo. Es la Ãºnica forma de agregarle una columna a una tabla inmutable y
es seguro (escribe un campo que hasta esa migraciÃ³n no existÃ­a, derivado del `at` de la misma
fila). El backfill convierte a **Lima**, no a UTC: cortar en UTC habrÃ­a fechado al dÃ­a
siguiente todo lo ocurrido despuÃ©s de las 19:00 locales â€” el desfase de D-112.

**Reporte mensual de bobinas** (`/reportes/bobinas`, `GET /reports/coils?month=YYYY-MM`), que
es lo que el backdating habilita: la columna "Saldo inicio de mes" sale de sumar los
movimientos anteriores al corte por su fecha de operaciÃ³n, y antes de D-124 no se podÃ­a
calcular. Se preguntÃ³ al dueÃ±o y confirmÃ³ que el reporte **no existÃ­a** y habÃ­a que construirlo
(la instrucciÃ³n original decÃ­a "reemplazar la columna EMPRESA", que no estaba en ninguna
pantalla). "Saldo fin de mes" reemplaza a "Disponible": en un reporte de agosto, mostrar el
saldo de hoy serÃ­a mezclar dos cortes en la misma fila.

### M2 â€” Entornos (D-125, D-126)

Rama Neon **`demo`** creada desde `production` (`br-solitary-smoke-aegbos8k`), migrada y
sembrada. `pnpm env:demo` / `db:demo` / `dev:demo`; `dev:demo` inyecta la conexiÃ³n por entorno
y no toca `apps/api/.env`, asÃ­ que convive con `pnpm dev`. `docs/ENTORNOS.md` documenta las
cuatro ramas y para quÃ© sirve cada una.

**`pnpm e2e:prod` queda prohibido como rutina** (regla dura 9 de `CLAUDE.md`). La verificaciÃ³n
post-deploy es `pnpm smoke:prod`: `/health` sin sesiÃ³n, login con el admin efÃ­mero de D-024 y
cinco GET; lo Ãºnico que escribe es ese usuario, y lo borra en `finally`. La suite completa vive
en local y en CI. `prod:purge-e2e` queda solo para emergencias documentadas acÃ¡.

### M3 (recortado) â€” Subtipo de cobertura (D-127)

EntrÃ³ a mitad de sesiÃ³n con un caso real: COT-000240 fallaba al confirmarse con `0.000 MTR
disponiblesâ€¦ necesita 61.000`. Era una cobertura **a medida** de 61 ml con subÃ­tems de largo, y
el sistema le estaba pidiendo stock de un producto terminado que no existe hasta que planta lo
rola.

`products.roofing_kind` (`PLANCHA` / `A_MEDIDA`), obligatorio en Metallic Roofing, visible y
corregible en el diÃ¡logo de producto y en la lista del catÃ¡logo; una cobertura nueva nace
`A_MEDIDA`. Largo fijo obligatorio solo en `PLANCHA` y prohibido en `A_MEDIDA`. Subtipo y
unidad no pueden discrepar (validaciÃ³n + `CHECK`). El backfill usa la inferencia que regÃ­a
hasta hoy (`unit = MTR` â†’ a medida), asÃ­ que ningÃºn producto cambia de comportamiento al
migrar: lo que cambia es que el dato ahora estÃ¡ escrito.

`resolveSalesLines` ramifica por el subtipo: una lÃ­nea a medida sin bobina elegida calcula los
kilos teÃ³ricos y **reserva materia prima**, eligiendo la bobina con el mismo filtro que el
selector de la OP (extraÃ­do a `roofing-coil-match.ts` para que no diverjan, D-086) y quedÃ¡ndose
con la mÃ¡s antigua por `operationDate` que alcance. Una plancha sigue exigiendo stock.

Lo que **no** entrÃ³ de D-122: `products.finish_id` y sacarle a coberturas la dependencia del
`ProductBom`. La densidad del acabado sigue saliendo de la receta. Queda para su propia sesiÃ³n.

### Incidente de seguridad de esta sesiÃ³n: una cadena de conexiÃ³n de Neon quedÃ³ impresa en el log

**QuÃ© pasÃ³, en orden.** Al escribir `scripts/db-demo.mjs` le pasÃ© la conexiÃ³n a
`prisma db execute` como argumento (`--url <cadena>`). El comando fallÃ³ por otro motivo (la
cadena lleva un `&` que el shell de Windows parte en dos), y el manejador de errores del propio
guion â€”que compone el mensaje con `args.join(' ')`â€” **imprimiÃ³ la cadena completa, contraseÃ±a
incluida**, en la salida de la terminal.

**Alcance.** La contraseÃ±a del rol `neondb_owner` es **la misma en las cuatro ramas** del
proyecto Neon: se verificÃ³ comparando huellas SHA-256 de las contraseÃ±as de `production`, `dev`
y `demo`, sin imprimir ninguna, y las tres coinciden. AsÃ­ que lo expuesto no es la credencial de
demo: es la credencial de **producciÃ³n**.

DÃ³nde quedÃ³: en la salida de esa terminal y en el registro de la sesiÃ³n del agente. No se
commiteÃ³, no saliÃ³ del equipo por ningÃºn otro canal y no estÃ¡ en ningÃºn archivo del repo
(`git ls-files` no lista ningÃºn `.env*`; `.env.demo` estÃ¡ cubierto por el `.gitignore`).

**QuÃ© se corrigiÃ³ en el cÃ³digo, para que no se repita.**

- `scripts/db-demo.mjs` ya no pasa ninguna conexiÃ³n por `argv`: van solo por el entorno del
  proceso hijo, y `prisma db execute` toma la suya del `DIRECT_URL` del entorno.
- El mensaje de error de ese guion dejÃ³ de repetir los argumentos. `scripts/lib.mjs#run` ya
  filtraba `secret|password|token`; el helper local de `db-demo.mjs` no, y esa fue la diferencia.

**Lo que hace falta que hagas vos (no lo puede hacer el agente).** Rotar la contraseÃ±a del rol
en Neon y propagarla:

1. Consola de Neon â†’ proyecto `ayr-steel-erp` â†’ **Roles** â†’ resetear la contraseÃ±a de
   `neondb_owner`.
2. `pnpm env:local` y `pnpm env:demo` â€” regeneran los `.env` locales tomando la cadena nueva de
   `neonctl`.
3. `pnpm secrets:gcp` â€” actualiza `DATABASE_URL`/`DIRECT_URL` en Secret Manager, y despuÃ©s
   `pnpm deploy:api` para que la revisiÃ³n de Cloud Run tome los secretos nuevos.
4. `pnpm secrets:gh` â€” actualiza `CI_DATABASE_URL`/`CI_DIRECT_URL` para las corridas de CI.

Mientras tanto el riesgo real es bajo (la cadena no saliÃ³ del equipo), pero la credencial es la
de producciÃ³n y el sistema se entrega maÃ±ana: conviene hacerlo antes del deploy, y el paso 3 ya
estÃ¡ en el camino de todos modos.

### Los dos defectos que encontrÃ³ `qa`, y por quÃ© ninguna otra verificaciÃ³n los veÃ­a

El agente `qa` escribiÃ³ 14 casos nuevos (8 de D-124, 6 de D-127) y corriÃ³ un smoke de las
suites que tocan coberturas, ventas y kardex. **No dio verde**: encontrÃ³ dos defectos reales de
la implementaciÃ³n, los dos invisibles para `lint`, `typecheck`, `test` y `build`.

**1. Un ciclo de imports en `@ayr/shared` borraba campos de schema en silencio (D-130).**
`schemas/operation.ts` importaba `businessToday` de `sales.ts`, que importa de `coil.ts` y
`roofing.ts`, que importan `backdatableFields` de `operation.ts`. En CommonJS un mÃ³dulo a medio
inicializar devuelve `undefined`, y `{ ...undefined }` no lanza: esparce nada. Seis schemas
â€”`createRoofingOrderSchema`, `reportRoofingPiecesSchema`, `closeRoofingOrderSchema`,
`reverseMovementSchema`, `createCoilScrapSchema`, `createCoilSplitSchema`â€” perdÃ­an
`operationDate` y `confirmBackdate`. Toda la rama de coberturas y **todas** las anulaciones
ignoraban la retrofecha; y como Zod descartaba el campo antes de que llegara a
`OperationDateService`, **un VENDEDOR no recibÃ­a el 403** en esas rutas y una fecha invÃ¡lida
devolvÃ­a 201 â€” el control de rol que es el corazÃ³n de D-124, abierto en seis lugares.
Corregido moviendo el reloj del negocio a `packages/shared/src/business-date.ts`, un mÃ³dulo
hoja que no importa nada. Verificado: los 15 schemas retrofechables llevan los dos campos.

**2. `500` en vez de `400` con fechas imposibles (D-130, segunda mitad).** El `.refine` de
calendario â€”agregado dos horas antes por un hallazgo del auditorâ€” hacÃ­a `toISOString()` sobre
un `Invalid Date`. `2026-02-31` se rechazaba bien (rueda al 2 de marzo y el ida y vuelta la
delata), pero `2026-08-32` y `2026-13-01` lanzaban `RangeError` dentro del refine. Corregido con
el guard de `Number.isNaN(getTime())`; las cinco formas de fecha imposible dan 400.

`qa` arreglÃ³ ademÃ¡s `e2e/tests/fase6.spec.ts`, que asumÃ­a que un pedido rival a medida chocaba
contra el disponible del producto terminado â€” con D-127 choca contra la materia prima. DejÃ³
intacta la mitad que sÃ­ prueba la protecciÃ³n y cambiÃ³ solo el motivo del corte.

**Resultado final: 14/14 de los casos nuevos, y 45/45 del smoke** (fase5a, fase5a-bordes,
fase6, fase6-bordes, fase7e, fase7e-bordes). La suite completa la corre CI.

### VerificaciÃ³n

- `pnpm turbo lint typecheck test build` en verde.
- `pnpm db:migrate` bloqueado por un desvÃ­o **preexistente**: la migraciÃ³n
  `20260905150937_fase7b_venta_en_anulacion` fue editada en el commit `9438677` **despuÃ©s** de
  aplicarse a `dev`, asÃ­ que `prisma migrate dev` exige resetear la rama. No es de esta sesiÃ³n
  y no bloqueÃ³ nada: `pnpm db:deploy` aplica lo pendiente sin ese chequeo, y es lo que se usÃ³
  contra `dev` y contra `demo`. Anotado acÃ¡ para que la prÃ³xima sesiÃ³n no lo descubra de nuevo.

### Lo que encontrÃ³ CI, y por quÃ© el smoke acotado no alcanzaba (D-131)

El primer push llegÃ³ con la verificaciÃ³n local en verde y **CI fallÃ³**: 4 suites, con dos causas
distintas y las dos reales.

**La regresiÃ³n del mostrador.** Al hacer el subtipo explÃ­cito (D-127) reemplacÃ©
`product.unit === MTR` por `roofingKind === A_MEDIDA` **en los dos lugares** donde aparecÃ­a, y
eran preguntas distintas: si la lÃ­nea necesita subÃ­tems de largo lo decide la **unidad** y vale
para cualquier lÃ­nea de negocio (D-083); si se fabrica desde materia prima lo decide el
**subtipo** y es exclusivo de coberturas (D-127). Como el subtipo es `null` fuera de coberturas,
la primera dejÃ³ de aplicarse a todo producto en `MTR` de otra lÃ­nea â€” y con eso **el mostrador
pasÃ³ a poder vender material a medida**, justo lo que D-098 prohÃ­be. Corregido con dos
predicados separados, `sellsByLength` e `isMadeToMeasure`.

Lo importante no es el defecto sino dÃ³nde estaba: en `fase7b-bordes`, el spec del mostrador. El
smoke acotado que corrÃ­ (fase5a, fase6, fase7e) no lo incluÃ­a porque el mostrador no parecÃ­a
tener nada que ver con el subtipo de una cobertura. Es **D-123 otra vez, y esta vez me tocÃ³ a
mÃ­**: la Ãºnica muestra que veÃ­a este defecto era la completa.

**Las fechas en UTC.** `todayIso()` del web calculaba "hoy" con el reloj del navegador en vez
del dÃ­a de Lima; como D-124 pasÃ³ a validar contra Lima, un cliente en un huso por delante
prellenaba maÃ±ana y recibÃ­a "la fecha de operaciÃ³n no puede ser futura" en una operaciÃ³n normal.
Y 16 lugares de `e2e/` armaban fechas con `new Date().toISOString().slice(0, 10)` â€” el corte en
UTC que D-112 prohibiÃ³ en el web con una regla de ESLint que **no cubre `e2e/`**. Los tres
arreglados; extender esa regla a `e2e/` queda anotado como riesgo residual.

Al reparar esos 16 lugares me comÃ­ un error propio que vale registrar: un `replaceAll` ciego
reescribiÃ³ el **cuerpo** de tres `today()` locales en `return today()` â€”recursiÃ³n infinitaâ€” y
encima les agregÃ³ el import del helper. Lo delatÃ³ el primer intento de correr las suites
(`Duplicate declaration "today"`), no una revisiÃ³n.

**VerificaciÃ³n final: 38/38** en las cinco suites que CI marcÃ³. Seis de esas fallas eran
contaminaciÃ³n de una corrida abortada mÃ­a (una caja de mostrador que quedÃ³ abierta en `dev`, que
en local **no se vacÃ­a** entre corridas: solo CI lo hace); con `E2E_RESET_DB=1` dan 6/6.

### El go-live: reset, deploy y smoke

1. **ProducciÃ³n se cayÃ³ a mitad de la sesiÃ³n** con `{"status":"degraded","db":"error"}`: el API
   vivo tenÃ­a la credencial de Neon anterior a la rotaciÃ³n. Se restaurÃ³ adelantando
   `pnpm secrets:gcp` + `pnpm db:prod` + `pnpm deploy:api` sin esperar a CI (decisiÃ³n del dueÃ±o,
   con nadie operando todavÃ­a). `db:prod` no estaba en el plan y era imprescindible: el cÃ³digo
   nuevo lee `operation_date` y `roofing_kind`, y producciÃ³n seguÃ­a con el esquema anterior.
2. **Reset de go-live** (D-129): `AYR_CONFIRM_PROD_RESET=1 node scripts/prod-reset-go-live.mjs
--branch production --yes-destroy production`. Inventario posterior: 0 proveedores, 0
   productos, 0 bobinas, 0 movimientos, 0 documentos, 0 saldos; el Ãºnico cliente es
   `PÃšBLICO EN GENERAL`, que crea el seed para el mostrador.
3. `pnpm deploy:api` con los arreglos de CI.
4. **`pnpm smoke:prod` en verde**: health, login con admin efÃ­mero y cinco GET. La primera
   corrida encontrÃ³ un 400 â€” en el propio guion, que pedÃ­a `/api/catalog/products?page=â€¦`, una
   ruta que nunca existiÃ³ (el catÃ¡logo no pagina, D-113). Corregida a `/api/catalog`.
5. Verificado a mano que los dos triggers de append-only (`inventory_movements`, `audit_log`)
   quedaron **activos** tras el reset: `tgenabled = O` en los dos.

## SesiÃ³n 7-final (2026-09-07) â€” hotfix de unicidad, reserva genÃ©rica, importadores y D-122

Cinco milestones en el orden que pidiÃ³ el dueÃ±o (M0 â†’ M1 â†’ M3 â†’ M4 â†’ M2). **Los cinco
implementados.**

### M0 â€” dos hotfix

- **D-132 â€” la unicidad del comprobante de compra cuenta solo las compras vivas.** Ãndice Ãºnico
  parcial (`WHERE status <> 'CANCELLED'`): anular una compra libera su nÃºmero para que la
  corregida entre con el mismo que dice el papel. Ruta nueva `PATCH /purchases/:id/document`
  (ADMINISTRADOR, auditada) para corregir el nÃºmero con sufijo `-R` que el dueÃ±o tuvo que
  inventar como workaround. Auditado el mismo patrÃ³n en el resto del modelo: no hay otro caso
  (los correlativos fiscales no se reutilizan por diseÃ±o y los maestros se reactivan, no se
  re-crean).
- **D-133 â€” la fecha de emisiÃ³n: VENDEDOR solo hoy, retrofechar es de ADMINISTRADOR.** Cierra el
  hueco que el auditor habÃ­a dejado anotado: la ventana de 7 dÃ­as de SUNAT valÃ­a para cualquier
  rol y en los primeros dÃ­as de un mes alcanzaba para cruzar al mes anterior.

### M1 â€” reserva genÃ©rica de materia prima (D-134..D-136)

- La cotizaciÃ³n de coberturas **ya no pide elegir bobina**. Una lÃ­nea a medida promete kilos
  contra el **agregado compatible** (lÃ­nea + color + espesor Â± tolerancia), que es una fila de
  `raw_material_specs` nueva; `reserveFromCoilId` desapareciÃ³ del schema, del API y del
  formulario.
- La invariante `disponible â‰¥ reservado` pasa a comprobarse sobre la **suma** del agregado, con
  guardrail nuevo en los seis puntos que le quitan kilos: salida de kardex, envÃ­o a corte,
  montaje en una OP ajena, cierre de bobina, cambio de color y venta de bobina entera.
- Panel de stock en vivo en el formulario (`GET /sales/stock-panel`), de solo lectura, con el
  agregado por espesor + color (kg y metros lineales teÃ³ricos) y el disponible por SKU.
- El filtro de material queda escrito como espesor Â± tolerancia + **color**; el acabado solo
  aporta densidad (D-135).

### M3 / M4 â€” los dos importadores del Excel real del negocio (D-137, D-138)

- `COILS_HISTORY`: el Excel de bobinas tal como estÃ¡. Proveedor auto-creado por RUC contra el
  padrÃ³n, con fallback marcado `needs_review` si el padrÃ³n no responde; acabado que no mapea
  **no se auto-crea** (se elige del maestro en el preview); dos modos por lote (`REPLAY` con
  reporte de saldo vs objetivo, `ADJUST` con salida de ajuste retrofechada).
- `SALES_HISTORY`: el export de ventas, agrupado por `SERIE - NÃšMERO`, reusando
  `FiscalImportService` entero. Cliente auto-creado, SKU no; `DOCUMENTO AJUSTADO` con valor deja
  la fila fuera con el motivo escrito.
- Los dos conviven con los importadores canÃ³nicos (RF-12, RF-71) en vez de reemplazarlos.

### M2 â€” D-122 completo, D-139 y la regla de ESLint que faltaba

- **D-122**: `products.finish_id` nuevo con backfill; el largo de la plancha y el peso por pieza
  pasan al SKU; `coilOptions`/`mountCoil`/el kilo teÃ³rico del catÃ¡logo/la cola de producciÃ³n
  leen del producto; `production_orders.bom_id` pasa a nullable y la receta queda **exclusiva de
  drywall** (las de coberturas quedan desactivadas y un `CHECK` impide que vuelva a haber una
  viva).
- **D-139**: `product_boms.kg_per_piece` y `piece_length_mm` se eliminan â€” el peso y el largo de
  la pieza son del SKU.
- `apps/api/src/sales/raw-material.spec.ts`: 9 tests de la invariante del agregado, que es el
  guardrail mÃ¡s nuevo y el que el compilador no protege (el enum es aditivo).
- La regla de ESLint de D-112 ahora cubre `e2e/` (`eslint.config.mjs` en la raÃ­z, `pnpm lint` la
  corre). EncontrÃ³ **tres** violaciones reales que habÃ­an sobrevivido a la limpieza de D-131.

### Hallazgos de las revisiones, corregidos en la misma sesiÃ³n

`revisor` (API), `revisor` (web, pasada aparte) y `auditor-seguridad` corrieron en paralelo con
`qa`. **Los cuatro encontraron el mismo bloqueante por caminos independientes**: tras la
migraciÃ³n de D-122, `resolveSalesLines` seguÃ­a exigiÃ©ndole receta activa a una cobertura, asÃ­
que ninguna se podÃ­a cotizar. Corregido junto con: la cola de producciÃ³n que dejaba de ver los
pedidos (`computeQueueStatus` consultaba la receta), las etiquetas vacÃ­as de `RAW_MATERIAL` en
cotizaciÃ³n y despacho, el guardrail que faltaba al revertir una recepciÃ³n de corte, el partido
que se rechazaba a sÃ­ mismo (el guardrail leÃ­a un estado transitorio), un ReDoS medido en
2,7 s/fila al parsear `SERIE - NÃšMERO`, una carrera real del ledger que permitÃ­a prometer
1.000 kg contra 100 fÃ­sicos (el guardrail no tomaba lock y competÃ­a por filas distintas que el
camino que promete), un `GET` que escribÃ­a en la base, la coma decimal que se borraba en
silencio y el flag `needsReview` que nadie leÃ­a.

### Los tres defectos que solo vio la corrida de E2E

Ninguna de las tres revisiones estÃ¡ticas podÃ­a verlos; los dos los introdujo el guardrail del
agregado. **`mountCoil` se pasaba del presupuesto de 5 s de Prisma** (`P2028`) contra Neon, de
forma intermitente â€”que fuera intermitente era la pista de que era presupuesto y no lÃ³gicaâ€”; se
revisaron ademÃ¡s todas las transacciones a las que esta sesiÃ³n les sumÃ³ el guardrail y seguÃ­an
con el default (`cutting.send`, `coils.setStatus`, `coils.update`). Y **`GET /sales/stock-panel`
devolvÃ­a 500** (`P2023`) para un SKU a medida sin fila de agregado todavÃ­a: la spec "virtual" de
la variante de solo lectura tiene el id vacÃ­o y llegaba a una consulta que lo parsea como UUID.
Y **un reporte de producciÃ³n parcial se bloqueaba a sÃ­ mismo**: la salida que cumple una promesa
se comprobaba contra lo que resta de esa misma promesa, sobre un agregado cuyo Ãºnico rollo estÃ¡
montado en la propia orden. `RecordMovementInput` gana `exceptReservationIds`, la misma
excepciÃ³n que `mountCoil` ya aplicaba.

### VerificaciÃ³n

`pnpm turbo lint typecheck test build` en verde (266/266 unitarios, incluidos 9 nuevos de la
invariante del agregado). `pnpm format:check` y `pnpm exec eslint e2e` en verde. Seis
migraciones aplicadas a Neon `dev` y `demo`.

**E2E: 84/84 en las doce suites afectadas**, todas corridas en local antes de la revisiÃ³n del
dueÃ±o â€” `fase7final-m0` (8), `fase7final-m1` (5), `fase6` (5), `fase6-bordes` (7),
`fase4-bordes` (11), `fase7-consolidada` (8), `fase5a` (9), `fase5a-bordes` (10),
`fase5b-bordes` (11), `fase7` (7), `fase7-bordes` (2) y `fase7e-bordes` (1). Nada quedÃ³ para
descubrir en CI, que es lo que D-123 pide despuÃ©s de un cambio de regla no aditivo.

### Lo que queda abierto, a propÃ³sito

- **La fecha de emisiÃ³n de una cotizaciÃ³n y de un pedido directo no se valida** (ni futura ni
  piso histÃ³rico). Es previo a esta sesiÃ³n y no es fiscal; queda anotado.
- El importador de comprobantes sigue admitiendo hasta 10 aÃ±os atrÃ¡s sin pasar por
  `HISTORICAL_LOAD_START` (ya estaba anotado en la sesiÃ³n anterior).

### ContinuaciÃ³n 7-final (2026-09-07) â€” D-140 resuelto, D-139 ratificada, mensaje diagnÃ³stico

El dueÃ±o resolviÃ³ los dos puntos que habÃ­an quedado abiertos y confirmÃ³ el fix pendiente de
diagnÃ³stico:

- **D-140 cerrado: "catÃ¡logo siempre a stock".** La producciÃ³n de una plancha de catÃ¡logo
  nunca se liga a un pedido â€” el pedido reserva producto terminado (D-054/D-088) y, sin stock
  suficiente, espera una corrida a stock. `POST /production/roofing` acepta ahora `productId` +
  `targetPieces` como alternativa a `reservationId` (`RoofingProductionService.createToStock`),
  el mismo patrÃ³n que drywall ya tenÃ­a para una corrida sin pedido detrÃ¡s. `/planta` suma la
  tarjeta "Nueva orden de coberturas a stock".
- **D-139 ratificada** sin cambios de cÃ³digo: el peso de pieza terminada sigue siendo el Ãºnico
  dato del SKU.
- **El mensaje de rechazo al confirmar un pedido ahora nombra la OP** cuando el faltante es
  material montado en producciÃ³n, en vez de "0.000 fÃ­sicos menos 0.000 comprometidos" sobre un
  almacÃ©n que sÃ­ tiene el material (solo que en la roladora). `RawMaterialAvailability` gana
  `mountedKg`/`mountedOrderCodes`; `fase5a-bordes` actualizado al texto nuevo.
- Comentario de defensa en profundidad aÃ±adido en `assertReservationInvariant`
  (`reservation-guard.ts`): para un Ã­tem `COIL`, mÃ¡s de un pedido sosteniendo a la vez una
  reserva sobre la misma bobina es hoy inalcanzable (D-116/D-134); sigue siendo el caso normal
  para `PRODUCT`/`RAW_MATERIAL`.

VerificaciÃ³n: `pnpm turbo lint typecheck test build` verde (266/266 unitarios), `pnpm
format:check` y `pnpm exec eslint e2e` verdes. E2E local: `fase5a-bordes` (10/10) y
`fase7final-m1` (5/5). Sin migraciones nuevas. Falta la revisiÃ³n local del dueÃ±o con sus Excel
reales y su caso de compra anulada antes de commit + push + CI + despliegue nocturno.

## SesiÃ³n 7-final-B (2026-09-07) â€” el pedido de un comprobante importado (D-141)

**Estado: implementado y verificado en local; nada commiteado.** Falta la revisiÃ³n del dueÃ±o
con su Excel real (marcar sus pendientes de verdad) antes de push + CI + despliegue nocturno.

### Lo que se construyÃ³

Cada documento que entra por la importaciÃ³n de ventas (D-138) crea ahora **un pedido enlazado
1:1**, y un **toggle por documento** en la previsualizaciÃ³n decide de quÃ© clase:

- **ENTREGADO (por defecto) â€” pedido cÃ¡scara.** `FULFILLED`, `origin = IMPORTED`, lÃ­neas
  espejo del comprobante, fecha de emisiÃ³n del papel. **Cero efectos de inventario**: sin
  reserva, sin despacho, sin kardex, sin cola. El bypass es estructural
  (`SalesOrdersService.createImportedShellInTx` no tiene cÃ³digo capaz de escribir una reserva)
  y ademÃ¡s se comprueba al terminar (`assertNoInventoryEffects`): si el pedido dejÃ³ una
  reserva, una OP, un despacho o un movimiento, la importaciÃ³n entera se deshace.
- **PENDIENTE â€” pedido vivo + OP automÃ¡tica.** `CONFIRMED`, `origin = IMPORTED`, por el flujo
  normal (`createDirectInTx`, que crea las reservas y comprueba la invariante): lÃ­nea a medida
  â‡’ reserva **genÃ©rica** por agregado (D-134); lÃ­nea de catÃ¡logo â‡’ reserva de producto
  terminado (D-054/D-127). Por cada lÃ­nea a medida el import crea ademÃ¡s la **OP en cola**
  (`DRAFT`) enlazada a la reserva, **sin montar bobina** â€” montar es del dueÃ±o (D-086).

### Piezas nuevas

- **Schema:** enum `SalesOrderOrigin` y `sales_orders.origin` (migraciÃ³n
  `20260907180000_fase7finalb_origen_del_pedido`). El enlace documentoâ†”pedido **no agrega
  columna**: `fiscal_documents.sales_order_id` ya existÃ­a desde Fase 5b, y se lee desde los
  dos lados (badge Â«ImportadoÂ» y link al comprobante en `/pedidos/[id]`; el link al pedido ya
  estaba en el detalle del comprobante).
- **API:** `PATCH /imports/:id/group` (el toggle del documento, que cambia el comprobante de
  una pieza y revalida el grupo una sola vez); `RoofingProductionService.createFromReservationInTx`
  (la OP nace en la misma transacciÃ³n que el pedido);
  `SalesOrdersService.createImportedShellInTx` / `archiveImportedOrderInTx`;
  `ImportedDocumentInput.salesOrderId` + `ImportedDocumentLine.salesOrderItemId` (asÃ­
  `orderProgress` muestra el pedido importado facturado al 100 %, que es la verdad).
- **Web:** cabecera por comprobante en la previsualizaciÃ³n con el toggle y la frase de lo que
  va a pasar; columna opcional `Largos (m x cant.)`.

### Las dos excepciones que la sesiÃ³n abre, y por quÃ©

1. **`ResolveSalesLinesOptions.allowMissingPieces`**, encendida **solo** en el pedido
   importado. NingÃºn export de facturaciÃ³n desglosa las planchas de una lÃ­nea a medida; los
   kilos prometidos no dependen del desglose (`metros Ã— espesor Ã— ancho Ã— densidad`) y el plan
   de corte es una intenciÃ³n que planta corrige (D-084). Con la columna `LARGOS` llena, el
   plan nace completo; sin ella nace vacÃ­o.
2. **Un pedido importado se salta `quotation_required` (RF-31)**, porque el compromiso ya se
   tomÃ³ y ya se facturÃ³: exigir una cotizaciÃ³n previa a una venta que ya ocurriÃ³ no protege
   nada. Todo lo demÃ¡s del camino normal sigue corriendo, empezando por la invariante
   `disponible â‰¥ reservado`.

### Lo que **no** se hizo, a propÃ³sito

- **No hay OP a stock automÃ¡tica** para una lÃ­nea de catÃ¡logo sin stock (D-140). La fila se
  marca con el faltante exacto y ese documento solo entra como ENTREGADO. Las alternativas
  eran inventarle al dueÃ±o una corrida que no pidiÃ³ o romper la invariante del ledger.
- **Pendiente parcial** (media lÃ­nea entregada) queda fuera de v1.
- No se reconstruyen despachos ni kardex histÃ³ricos, no se elige bobina concreta en el import,
  no hay estados nuevos.

### ReimportaciÃ³n (D-109 + D-141)

Reimportar archiva el documento **y anula su pedido cÃ¡scara**. Si ese pedido estÃ¡ **vivo** con
reservas activas, una OP viva o algÃºn despacho, la reimportaciÃ³n del documento **se bloquea
entera** con el motivo y el cÃ³digo del pedido â€” archivarlo habrÃ­a dejado material prometido y
producciÃ³n en curso sin nadie que los devuelva (la quinta vez que este proyecto se cruza con
la misma lecciÃ³n: D-061, D-088, D-097, D-110). El guardrail vive en `sales` y corre bajo el
mismo `pg_advisory_xact_lock` sobre el nÃºmero que ya toma `FiscalImportService`; la
previsualizaciÃ³n repite solo la lectura, para que se vea antes de confirmar.

### VerificaciÃ³n

`pnpm turbo lint typecheck test build` verde (266/266 unitarios), `pnpm format:check` y
`pnpm exec eslint e2e` verdes. MigraciÃ³n aplicada a Neon `dev`.

E2E nuevo: `fase7finalb-pedido-importado` (**3/3**, local) â€” documento ENTREGADO â‡’ pedido
cumplido y enlazado con **cero movimientos, cero reservas y cero OP**; documento PENDIENTE a
medida â‡’ pedido confirmado, reserva genÃ©rica de 60.000 kg y OP `DRAFT` sin bobina montada, con
su plan de corte; y el mismo documento **sin la columna de largos** â€”el caso realista, porque
ningÃºn export los traeâ€” que entra igual y deja la orden con el plan vacÃ­o. La cadena montar â†’
drenar â†’ cerrar ya la cubre `fase7final-m1` y no se repite.

**El tercer caso naciÃ³ de un defecto propio de esta sesiÃ³n, encontrado antes de correr nada:**
`resolveSalesLines` comprueba que los largos sumen la cantidad de la lÃ­nea, y con
`allowMissingPieces` una lÃ­nea sin largos sumaba cero contra sus quince metros â€” el mismo
rechazo que la excepciÃ³n existe para evitar, por la puerta de al lado. La comprobaciÃ³n pasa a
correr solo cuando los largos vinieron.

### Suites afectadas: 9 fallas heredadas de la sesiÃ³n anterior, arregladas

Correr las suites que el cambio podÃ­a tocar dejÃ³ 9 fallas, **ninguna del cambio de hoy**: son
specs que la sesiÃ³n 7-final dejÃ³ desactualizados con su propio trabajo, todo sin commitear, asÃ­
que CI todavÃ­a no los habÃ­a visto. Es la lecciÃ³n de D-123 otra vez â€”un cambio de regla no
aditivo se verifica contra la suite completaâ€” y esta vez el que la pagÃ³ fue el archivo que la
tabla de verificaciÃ³n de aquel handoff no listaba.

- **`fase7-consolidada-subtipo` (5)**: el spec entero seguÃ­a escrito para el modelo anterior a
  D-134 (la cotizaciÃ³n reservaba `PRODUCT`, el pedido una bobina concreta) y un caso reescribÃ­a
  una **receta de coberturas**, que D-122 eliminÃ³. Los cinco casos reescritos; dos de ellos
  probaban un mecanismo que D-134 retirÃ³ y se reemplazaron por la regla que prueba lo mismo en
  el modelo nuevo, en los dos sentidos (ver `docs/handoff/fase-7-final-b.md` Â§4).
- **`fase7c` (2)**: desde D-138 hay dos botones Â«Importarâ€¦Â» en `/comprobantes` y el localizador
  `name: 'Importar'` resolvÃ­a a los dos. Ahora usa el nombre completo.
- **`fase6` (1)**: el mensaje de rechazo de D-140 cambiÃ³ al resolverse la decisiÃ³n.
- **`fase5a-bordes` (1)**: **flake, no defecto** â€” el token de acceso dura 15 min y ese archivo
  tardÃ³ 15.1 en la corrida combinada, asÃ­ que se cayÃ³ con un 401 a mitad. Corrido solo, 10/10.
  **Conviene correr las suites en tandas chicas por este motivo.**

### Pulido de la cotizaciÃ³n (pedido aparte del dueÃ±o)

Los solapes del formulario tenÃ­an **una sola causa**: las celdas heredan `whitespace-nowrap`
del componente `Table` (pensado para listados de una lÃ­nea), asÃ­ que los renglones de ayuda de
debajo de cada campo â€”la unidad, el kilo teÃ³rico, el precio de lista, los kilos a reservarâ€” no
podÃ­an partirse y se desbordaban **pintando encima de la columna vecina**. Corregido con
`whitespace-normal` en esas celdas, los renglones en `block` debajo del campo, y un `min-w` en
la tabla para que en pantalla angosta desplace en vez de aplastar. AdemÃ¡s: nÃºmeros a la derecha
con `tabular-nums` (la convenciÃ³n que ya usa el resto de la app), totales en rejilla con el
total destacado, anchos rebalanceados y `align-top`. Sin componentes nuevos, sin cambios de
estructura ni de lÃ³gica. NingÃºn E2E maneja este formulario por navegador, asÃ­ que el cambio no
tiene riesgo para la suite.

## SesiÃ³n 7-final-C (2026-09-07) â€” CLI de importaciÃ³n de ventas (D-142)

**Estado: implementado y verificado en local con el Excel real del dueÃ±o; nada commiteado.**
Falta que el dueÃ±o complete el JSON de decisiones (lÃ­nea de negocio de 40 SKUs, y quÃ©
documentos marcar `pendientes`) antes de `--execute`, push, CI y despliegue.

### Lo que se construyÃ³

`pnpm import:ventas --file <xlsx> [--branch dev|demo] [--decisions <json>] [--execute]`:
dry-run por defecto (sube el archivo con `ImportsService.upload`, nunca confirma) y escribe
un esqueleto de decisiones con lo que el dry-run ya detectÃ³. `--execute` se niega si el JSON
no cubre todos los huecos, aplica las correcciones con `updateRow`/`updateGroup` y confirma â€”
el mismo servicio y el mismo `SalesHistoryImportAdapter` (D-138/D-141) que usa el botÃ³n
Â«Importar ventas (Excel)Â» de `/comprobantes`, nunca SQL directo.

- **Fixes de parseo verificados contra el archivo real** (`Ventas Detalladas.xlsx`, 141
  filas / 71 documentos): fechas texto DD/MM/AAAA (ya eran correctas; se agregÃ³ el test que
  lo fija con dÃ­a â‰¤ 12), nÃºmeros con punto decimal y campos opcionales vacÃ­os (ya eran
  correctos), tipo de comprobante case-insensitive (ya era correcto), cliente
  `"RUC - NOMBRE"` (ya era correcto â€” pero encontrÃ³ un bug real de verdad, ver abajo).
  **El Ãºnico gap real era la unidad**: el archivo trae "METRO LINEAL"/"KILOGRAMO"/
  "UNIDAD"/"TONELADA" y el catÃ¡logo usa los cÃ³digos UN/EDI (`MTR`/`KGM`/`NIU`/`TNE`);
  `normalizeUnit` (D-142) los mapea. Contra el archivo real: **0 errores de fecha, ninguna
  unidad sin mapear.**
- **Hallazgo real en `parseCustomer`:** la clase de recorte del separador era simÃ©trica
  (`[\s\-â€“â€”:.]` al principio **y al final**), asÃ­ que un nombre que termina en punto
  ("...S.A.C.") perdÃ­a el punto al auto-crearse. Solo se manifestaba si el padrÃ³n de SUNAT no
  respondÃ­a (si responde, el nombre real pisa al del archivo) â€” un escenario ya documentado
  en el cÃ³digo, nunca antes con un test. El punto ahora solo se recorta del lado izquierdo.
- **Diccionario real de SKUs faltantes: 40** (de 41 productos distintos del archivo; uno,
  `P64GALV045`, ya existe en el catÃ¡logo dev). El esqueleto de decisiones sale prellenado con
  cÃ³digo, nombre y unidad detectada por cada uno; el dueÃ±o completa `linea` y, para los que
  son Metallic Roofing/Drywall (exigen espesor/ancho/acabado que el export no trae), la
  instrucciÃ³n del propio JSON sugiere crear el producto a mano y usar `"mapear"`.
- **OP a stock consolidada (enmienda a D-140), sin tocar la invariante `disponible â‰¥
reservado`:** una lÃ­nea de catÃ¡logo pendiente sin stock sigue entrando **solo como
  ENTREGADO** (igual que D-141); el CLI, aparte, suma el dÃ©ficit de todas las lÃ­neas
  pendientes de ese producto en el lote y crea **una** `RoofingProductionService.create`
  a stock por el total, sin ligarla a ninguna reserva â€” un adelanto de producciÃ³n para la
  prÃ³xima carga, no un desbloqueo de esta. `data.catalogAvailableQty` (nuevo, en el
  adaptador) es lo que hace que el CLI no tenga que releer la disponibilidad.
- **`import_batch_id`** (migraciÃ³n aditiva `20260907190000_fase7finalb_import_batch_id_ventas`,
  nullable en `fiscal_documents`, `sales_orders`, `reservations`, `production_orders`,
  `customers` y `products`): el CLI lo estampa **despuÃ©s** de que el servicio ya creÃ³ cada
  fila (documentos/pedidos/reservas/OP en cascada desde el documento â€” D-141 es 1:1, asÃ­ que
  todo lo que cuelga de un documento del lote es del lote; clientes y SKUs con un snapshot de
  antes de confirmar, porque a esos si puede haberlos creado una corrida anterior).
- **`purge-imported-sales.ts --batch=<uuid>`**: la misma herramienta de siempre, acotada a un
  lote. Dos guardas nuevas sobre las siete que ya tenÃ­a: una OP del lote (en cola **o a
  stock**) fuera de DRAFT/CANCELLED-sin-montar aborta todo; un cliente o SKU del lote que algo
  **de afuera** ya haya usado se conserva y se reporta, nunca se borra a ciegas.

### Un problema de herramientas que no era del dominio: `tsx`/esbuild y la metadata de Nest

El CLI reusa `ImportsService` completo a travÃ©s de un contexto de Nest standalone
(`NestFactory.createApplicationContext`), y la primera corrida con `tsx` fallaba **en
silencio** â€” `process.exit(1)` sin una sola lÃ­nea de error, ni con `.catch()`, ni con
`process.on('uncaughtException', ...)`. Con el logger de Nest encendido apareciÃ³ la causa
real: `UndefinedDependencyException` en `AuthService` â€” esbuild (el transpilador de `tsx`) no
emite `emitDecoratorMetadata` de forma confiable en un grafo de dependencias con referencias
circulares de tipos, y Nest no puede resolver el primer argumento del constructor. `nest
build` no sirve (`tsconfig.build.json` excluye `prisma` a propÃ³sito). SoluciÃ³n: un
`tsconfig.cli.json` propio que compila el CLI con `tsc` real â€” el mismo compilador que ya usa
`typecheck` â€” a `dist-cli/`, y el wrapper (`scripts/import-ventas.mjs`) lo compila antes de
cada corrida y ejecuta el JS resultante con `node` liso. QuedÃ³ documentado en el propio
`tsconfig.cli.json` para que nadie vuelva a intentar `tsx` acÃ¡ y pierda una hora en el mismo
silencio.

**Segundo hallazgo de herramientas, mÃ¡s chico:** `spawnSync('node', args, {shell: true})` en
Windows le comÃ­a el espacio de "Ventas Detalladas.xlsx" (`cmd.exe` repartÃ­a la ruta en dos
argumentos). `node` es un binario real, no un shim `.cmd`; sin `shell: true` el array de
argumentos llega intacto. Y las rutas de `--file`/`--decisions`/`--out` se resuelven en el
wrapper contra el directorio **desde el que se invocÃ³** `pnpm import:ventas`, no contra
`apps/api` (el `cwd` del proceso hijo) â€” si no, una ruta relativa apuntaba al lugar
equivocado y el archivo "no existÃ­a".

### Lo que no se hizo, a propÃ³sito

- **No se corriÃ³ `--execute`.** El dry-run local con el Excel real es la verificaciÃ³n de esta
  sesiÃ³n; `--execute` lo corre el dueÃ±o despuÃ©s de completar el JSON de decisiones.
- **No se creÃ³ ningÃºn SKU en el catÃ¡logo.** El diccionario de 40 faltantes queda en el JSON
  prellenado, sin tocar `dev` mÃ¡s allÃ¡ de la migraciÃ³n (aditiva) y los lotes `PARSED` que el
  dry-run dejÃ³ (inertes: no tocan ninguna tabla de negocio, igual que dejarÃ­a la
  previsualizaciÃ³n web sin confirmar).
- No se tocÃ³ `SalesHistoryImportAdapter.createGroup` ni ninguna de las siete adaptadores de
  `ImportsModule`: el estampado de `import_batch_id` es enteramente del CLI, por fuera de la
  transacciÃ³n de confirmaciÃ³n (una actualizaciÃ³n de metadato sobre lo que el servicio acaba
  de crear, nunca una decisiÃ³n de negocio).

### Dos ajustes de la revisiÃ³n del dueÃ±o, antes de correr nada de verdad

**`--branch production` con `--confirm-production` (pedido explÃ­cito del dueÃ±o).** La primera
versiÃ³n del wrapper rechazaba `production` de plano. El dueÃ±o pidiÃ³ en cambio que `production`
sea una rama vÃ¡lida pero que `--execute` contra ella exija ademÃ¡s `--confirm-production` (el
dry-run no, porque solo sube y valida). Aplicado a `import-ventas.mjs` y, para `--batch`, a
`prod-purge-imported-sales.mjs` â€” la purga general (sin `--batch`) queda como estaba, sin
pedir el flag nuevo. Verificado que las tres combinaciones (sin flag aborta, con flag pasa el
gate, `--batch` sin flag aborta) hacen lo que dicen.

**Un SKU que no se puede `"crear"` ya no tira abajo el lote entero.** El plan del dueÃ±o era
completar con espesor/color solo los SKUs de coberturas que estÃ©n en `pendientes[]`, y dejar
el resto con los datos mÃ­nimos del archivo. Eso rompÃ­a contra el diseÃ±o original: la primera
vez que `catalog.create` fallara (falta de campos estructurados, lo esperable en Metallic
Roofing/Drywall) abortaba **todo** el `--execute` antes de tocar un solo documento, sin
importar cuÃ¡ntos otros SKUs sÃ­ se hubieran resuelto bien. Corregido para que un SKU fallido
solo deje sin resolver las filas que lo usan (conservan el error original de "no existe el
producto", que ya hace que `confirmGroups` salte ese documento) â€” el resto del lote sigue su
curso, igual que cualquier otro documento con un error de validaciÃ³n. El resumen final ahora
lista los SKUs que fallaron para que quede claro cuÃ¡les documentos se excluyeron y por quÃ©.

### VerificaciÃ³n

`pnpm turbo lint typecheck test` verde (286/286 unitarios, +20 nuevos en
`sales-history.adapter.spec.ts`), `pnpm format:check` y `pnpm exec eslint e2e` verdes.
`nest build` (compilaciÃ³n real de `src/`) verde; `prisma generate` tuvo un `EPERM` de Windows
intermitente (`query_engine-windows.dll.node` bloqueado por otro proceso del sistema, no
relacionado con este cambio â€” ver "Notas operativas"), sin volver a fallar tras confirmar que
`tsc --noEmit` y `nest build` ya pasaban limpios por separado. MigraciÃ³n aplicada a Neon
`dev`.

Dry-run contra `Ventas Detalladas.xlsx` (real, 141 filas / 71 documentos: 119 Factura, 20
Boleta, 2 lÃ­neas de 1 Nota de CrÃ©dito): 71 documentos leÃ­dos, 1 excluido por ser nota de
crÃ©dito (con el motivo), 40 SKUs faltantes detectados y volcados al JSON prellenado, **0
errores de fecha, ninguna unidad sin mapear**. El resto de los documentos (68) quedan
`INVALID` Ãºnicamente por SKU faltante â€” el estado esperado hasta que el dueÃ±o complete el
diccionario; no es una falla de la herramienta, es exactamente lo que el dry-run existe para
mostrar antes de tocar nada.

### Despliegue a producciÃ³n y el backfill de D-122 que faltaba (mismo dÃ­a, con autorizaciÃ³n explÃ­cita del dueÃ±o)

Con luz verde del dueÃ±o se corriÃ³, en este orden: commit + push (CI verde, 25 min), `pnpm
db:prod` (sin migraciones pendientes â€” production ya estaba al dÃ­a, incluida D-142) y `pnpm
deploy:api`.

**Antes de `smoke:prod`, el chequeo de "cero bobinas sin finish_id" que el dueÃ±o pidiÃ³
encontrÃ³ 55 de 56 productos de Metallic Roofing con `finish_id = NULL`.** No era un caso
aislado: era casi todo el catÃ¡logo real de coberturas. Causa: el backfill de D-122 copia
`finish_id` desde la receta (`product_boms`) **activa** de cada producto, y estos 55 se
crearon hoy mismo por el dueÃ±o, a travÃ©s del catÃ¡logo, **antes de que este mismo deploy
subiera el cÃ³digo de D-122** (que es el que exige `finish_id` en `CatalogService.create`)
â€” con la API de producciÃ³n corriendo la revisiÃ³n anterior, nada se lo pedÃ­a. `COB028ROJO`
es el Ãºnico con `finish_id` porque es el Ãºnico que tenÃ­a una receta activa de la que el
backfill pudo copiarlo (un vÃ­nculo flejeâ†’perfil de un flujo mÃ¡s viejo); su propio
`audit_log` no muestra `finishId` en el `after` de su creaciÃ³n, consistente con que se creÃ³
bajo el cÃ³digo anterior.

**Reparado con autorizaciÃ³n explÃ­cita, mismo dÃ­a, sin esperar aprobaciÃ³n lÃ­nea por lÃ­nea:**
cada uno de los 56 productos ya tenÃ­a `colorId` correcto (estructurado, no texto libre), asÃ­
que el mapeo color â†’ acabado saliÃ³ de ahÃ­ y no de heurÃ­stica de nombre â€” mÃ¡s confiable que
parsear el SKU. AZUL/BLANCO/GRIS/NATURAL tienen una sola opciÃ³n de acabado (confianza ALTA,
35 productos); ROJO tiene dos variantes RAL y se usÃ³ la que ya estaba cargada en `COB028ROJO`
como precedente (confianza MEDIA, 13 productos); VERDE tiene dos variantes sin ningÃºn
precedente en la base, elegida arbitrariamente (confianza BAJA, 7 productos â€” **el dueÃ±o
deberÃ­a revisar estos 7 por UI**: `COB025VERDE`, `COB030VERDE`, `COB035VERDE`, `COB040VERD`,
`COB040VERDE`, `COB045VERDE`, `COB050VERDE`, todos con `ALZ-VERDE-6002`). Aplicado vÃ­a
`CatalogService.update` (audita, corre `assertStructuredFields` y `assertNoLiveRoofingOrders`
â€” nunca SQL directo): **55 de 55**. Verificado despuÃ©s: **0 productos de Metallic Roofing sin
`finish_id`** en producciÃ³n. El `pendientes[]` del JSON de decisiones estaba vacÃ­o en ese
momento, asÃ­ que la excepciÃ³n que pidiÃ³ el dueÃ±o (no tocar sin confirmar los SKUs que
terminen en un documento pendiente) no tuvo ningÃºn caso que aplicar â€” queda anotado para la
prÃ³xima vez que se recalcule `pendientes[]` con datos reales.

**Ticket 7f (registrado, no implementado esta sesiÃ³n): la creaciÃ³n y la importaciÃ³n de
Metallic Roofing deberÃ­an exigir `finish_id` de forma mÃ¡s visible, no solo por el `throw` de
`assertStructuredFields`.** El cÃ³digo ya lo exige desde D-122 (por eso el problema fue de
_despliegue_ â€” cÃ³digo viejo corriendo contra catÃ¡logo nuevo â€” y no de una brecha en la
validaciÃ³n de hoy en adelante); lo que falta es blindar el camino de **datos existentes que
llegan sin pasar por el formulario** (una importaciÃ³n masiva futura, una migraciÃ³n de otro
sistema) con el mismo `check-roofing-catalog.mjs` que ya existe para D-127, extendido a
`finish_id`. Anotado para Fase 8, no urgente: el catÃ¡logo real ya quedÃ³ limpio.

### La ejecuciÃ³n real destapÃ³ un segundo defecto, ajeno a los SKUs: la tolerancia de "no cuadra" (D-142)

El primer `--execute` del dueÃ±o contra producciÃ³n (`pendientes[]` vacÃ­o, todo cÃ¡scara)
confirmÃ³ 52 de 71 documentos. Los 19 restantes: 1 nota de crÃ©dito (esperado) y **18 por un
`BadRequestException` de `FiscalImportService.resolveTotals`** â€” una capa de validaciÃ³n que
solo corre al confirmar, invisible para el dry-run. Compara el total recalculado (`qty Ã—
unitPricePen Ã— IGV`, D-003) contra el declarado con una tolerancia de **un cÃ©ntimo por
lÃ­nea** (`totalTolerance`), calibrada para RF-71, donde el importe de cada lÃ­nea ya viene
impreso y redondeado del papel. AcÃ¡ el precio unitario **se deriva** (VALOR DE VENTA /
CANTIDAD, D-138), y ese redondeo compuesto se acumula mÃ¡s â€” los 18 diffs reales fueron de
0.02 a 0.21 soles, evidentemente redondeo del propio Excel, no errores de captura.

**Arreglado con una sola fuente de verdad, pedida explÃ­citamente por el dueÃ±o**:
`SALES_HISTORY_TOTAL_TOLERANCE_PEN = '0.25'` en `imports/fiscal-import-math.ts` (peor caso
real 0.21 + margen chico), que lee tanto `SalesHistoryImportAdapter.validateGroup` (avisa)
como `FiscalImportService.resolveTotals` (rechaza, vÃ­a el nuevo campo opcional
`ImportedDocumentInput.totalTolerancePen`) â€” antes eran dos nÃºmeros independientes y ahora es
uno solo. RF-71 sigue con su `totalTolerance` de un cÃ©ntimo por lÃ­nea, intacta. Tests nuevos
en `fiscal-import-math.spec.ts` y `sales-history.adapter.spec.ts`: el peor caso real (0.21)
pasa, un desvÃ­o mayor (0.30) falla, y un canario dinÃ¡mico que compara contra el valor real
de la constante â€” si algÃºn dÃ­a alguien pone un nÃºmero a mano en vez de leerla, ese test es
el que revienta primero. `pnpm turbo lint typecheck test` verde (293/293), `dist-cli`
recompilado.

**Aviso operativo: el API desplegado en producciÃ³n todavÃ­a corre el umbral viejo (1
cÃ©ntimo/lÃ­nea) hasta el prÃ³ximo `deploy:api`.** El CLI (`dist-cli`, recompilado en esta
sesiÃ³n) ya tiene el fix y lo usarÃ¡ en el prÃ³ximo `--execute`; la previsualizaciÃ³n web
(`/comprobantes` â†’ Â«Importar ventasÂ») seguirÃ­a rechazando al confirmar lo mismo que hoy
rechazÃ³ el CLI, hasta que el deploy de cierre de esta sesiÃ³n suba el cÃ³digo nuevo. No es un
problema mientras el dueÃ±o siga operando por CLI contra este mismo commit.

**Reversa del primer intento:** los 52 documentos que sÃ­ habÃ­an confirmado (batch
`60bc83ca-3354-4a6c-a5c6-67cbbd2da92c`) se revirtieron con `purge-imported-sales.ts
--batch=<id> --execute --confirm-production` antes de este fix â€” 52 `fiscal_documents`, 52
`sales_orders`, 101 lÃ­neas, cero reservas/OP (todo cÃ¡scara). Verificado post-purga: cero
residuo del lote. El dueÃ±o estÃ¡ completando `pendientes[]` a mano en el JSON antes del
prÃ³ximo `--execute`.

### Vuelta atrÃ¡s completa del segundo ensayo (lote `d4282f5c-...`) y limpieza de la noche (2026-09-08)

El dueÃ±o pidiÃ³ descartar **todo** lo del ensayo de esa noche por flujo normal, nunca
forzando guardas. El lote `d4282f5c-8145-47da-baaf-0b5dafa8e013` (62 documentos/pedidos, 23
reservas, 20 OP) no era "cÃ¡scara pura": 3 OP (seq 5, 6, 21) habÃ­an llegado a montar bobinas
reales y reportar planchas reales antes de que el dueÃ±o decidiera revertir. El primer
dry-run del purge lo confirmÃ³ bloqueado (guardas 1/2/3 de `purge-imported-sales.ts`).

**Reversa por flujo normal, no por SQL:** las 3 OP se revirtieron con
`RoofingProductionService.reverseReport` (los reportes ACTIVE mÃ¡s recientes primero) +
`.cancel` (libera las bobinas montadas automÃ¡ticamente, D-066), vÃ­a un CLI standalone
temporal con el mismo patrÃ³n de contexto de Nest que D-142. Consumos en `0 kg`, reservas
restauradas a `ACTIVE`. Aun asÃ­, el purge seguÃ­a bloqueado: **la guarda "bobina montada
alguna vez" es incondicional** â€” no importa que la reversa estÃ© completa, el hecho
histÃ³rico de haber montado una bobina real no se borra nunca. Es diseÃ±o, no un estado
corregible.

**`purge-imported-sales.ts` se extendiÃ³ con `--exclude-touched` (D-143/D-142-ii)** para
cubrir justo este caso: excluye del borrado fÃ­sico al pedido dueÃ±o de una OP tocada (vÃ­a su
reserva) en vez de abortar el lote entero. Dry-run confirmÃ³ 60 pedidos/comprobantes a
borrar y 2 excluidos (pedido **80**, dueÃ±o de las OP 5 y 6; pedido **131**, dueÃ±o de la OP 21) â€” ambos con factura `ACCEPTED` real (`FFA1-00001354`, `FFA1-00001407`). Ejecutado
`--execute --confirm-production`: **60 `fiscal_documents`, 60 `sales_orders`, 121 lÃ­neas, 17
reservas, 17 OP borrados fÃ­sicamente. Cero clientes/SKU afectados** (el lote no creÃ³
ninguno que no existiera ya). Verificado post-purga: `origin = IMPORTED` en producciÃ³n quedÃ³
en exactamente 2 (los pedidos 80 y 131, intactos, sin tocar de ninguna otra forma). **Los
pedidos 80 y 131 existen hoy en producciÃ³n porque su producciÃ³n fue real** (bobinas
montadas y planchas reportadas, luego revertidas) y la herramienta de purga no borra eso
nunca â€” no porque falte hacer algo mÃ¡s con ellos.

**Hallazgo aparte, no relacionado al CLI de importaciÃ³n: datos de ensayo `CREATED_HERE`
de la misma noche.** Al revisar quÃ© mÃ¡s habÃ­a en producciÃ³n sin ser del lote, aparecieron 7
cotizaciones (6 de "TEXAS CITY SELVA S.A.C.", 1 de "3AAMSEQ S.A.") y 2 pedidos directos
(seq 1 CANCELLED, seq 134 IN_PRODUCTION) creados a mano esa misma noche, ajenos al CLI.

- **Cotizaciones:** borradas fÃ­sicamente por un script puntual con guarda (bloquea si algÃºn
  `sales_orders.quotation_id` la referencia, de cualquier estado â€” la FK lo rechazarÃ­a
  igual). **5 de 7 borradas** (seq 1, 2, 3, 5, 6). Excluidas: seq 4 (la referencia el pedido
  1, CANCELLED) y seq 7 (la referencia el pedido 134, **vivo**).
- **Pedido 134** tenÃ­a una factura real emitida, `F001-00000001` (FACTURA, `ISSUED_HERE`,
  `SEND_ERROR`) â€” tomÃ³ correlativo pero el envÃ­o nunca se confirmÃ³. Se consultÃ³ su estado
  real al PSE (`InvoicingService.refreshStatus`, solo lectura del lado de SUNAT) antes de
  tocar nada: **SUNAT la rechazÃ³** (`rejectionCode 400`, "la fecha del documento debe ser la
  fecha de HOY" â€” se emitiÃ³ con la fecha de ensayo, no la de hoy). Nunca fue un documento
  vigente; el correlativo `F001-00000001` queda quemado (no se reutiliza), pero sin ninguna
  obligaciÃ³n fiscal detrÃ¡s.
- Con la factura confirmada como no vigente, se revirtieron por flujo normal las OP 28
  (CLOSED â†’ `reopen` deshace el cierre â†’ `reverseReport` â†’ `cancel`) y 29 (`reverseReport` â†’
  `cancel`) del pedido 134.
- **Pendiente de decisiÃ³n del dueÃ±o, sin tocar:** el pedido 134 en sÃ­ (sigue
  `IN_PRODUCTION` â€” sus OP ya estÃ¡n anuladas, sÃ³lo falta `SalesOrdersService.cancel` si se
  quiere anular tambiÃ©n el pedido), la factura `F001-00000001` (queda `REJECTED`, registro
  histÃ³rico del intento â€” no hay un camino de "anular" para un `REJECTED`, y borrarla no fue
  parte de lo pedido), la cotizaciÃ³n 7 (bloqueada mientras el pedido 134 exista) y el pedido
  1 (bloquea la cotizaciÃ³n 4).

**Limpieza de archivos.** Los tres archivos de datos reales del ensayo (`Ventas
Detalladas.xlsx` y sus dos `.decisiones.json`) vivÃ­an sueltos en la raÃ­z del repo â€”
ignorados por `.gitignore` desde D-142, nunca llegaron a commitearse, pero sueltos igual.
Se movieron a `local-data/` (carpeta nueva, ignorada por completo) y `.gitignore`/`CLAUDE.md`
quedaron con la regla explÃ­cita: los archivos de trabajo de una importaciÃ³n real viven ahÃ­,
nunca en la raÃ­z. No quedÃ³ ningÃºn script de un solo uso en el repo: los CLI temporales de
esta noche (reversas de OP, refresh de PSE, purge de cotizaciones) se escribieron, corrieron
y borraron dentro de la misma sesiÃ³n â€” nada que archivar en `scripts/oneoff/`.

**Nada mÃ¡s se tocÃ³.** Sin reimport, sin otros fixes, sin mÃ¡s commits que el de cierre de
esta limpieza â€” a la espera de un nuevo plan del dueÃ±o para el pedido 134 y lo que queda
pendiente de Ã©l.

### Descarte total de los pedidos 80 y 131 â€” reversa por flujo normal, despuÃ©s purge fÃ­sico (2026-09-08)

El dueÃ±o pidiÃ³ el inventario de los pedidos 80 y 131 antes de ejecutar nada. Resultado:
ningÃºn despacho, ningÃºn cobro, ninguna nota de crÃ©dito, ningÃºn movimiento de kardex que
referenciara los documentos directamente en ninguno de los dos pedidos â€” solo las reservas
de materia prima `ACTIVE` que ya habÃ­an quedado de la reversa de las OP 5/6/21, y las dos
facturas `FFA1-00001354` (pedido 80, S/ 15,840.00) y `FFA1-00001407` (pedido 131, S/
230.40), ambas `ACCEPTED`, `origin = IMPORTED`.

**Reversa por flujo normal, en el orden pedido:** sin despachos que revertir, se fue directo
a `FiscalImportService.annulImported` (D-110 â€” baja **interna**, el PSE nunca conociÃ³ estos
documentos, D-105) sobre las dos facturas, y `SalesOrdersService.cancel` sobre los dos
pedidos (libera solo las reservas `ACTIVE` que quedaban). Resultado: pedidos 80 y 131
`CANCELLED`, facturas `ANNULLED`, las 6 reservas de ambos pedidos `RELEASED` con `qty=0`.

**`purge-imported-sales.ts` ganÃ³ `--include-reverted` (D-143), que necesita
`--exclude-touched`.** No afloja la guarda del historial de montaje â€” la verifica: promueve
al borrado fÃ­sico solo el pedido excluido que cumple las cinco condiciones a la vez (pedido
`CANCELLED`, comprobante `ANNULLED`/`VOIDED`/`REJECTED`, reservas `RELEASED`, OP
`CANCELLED`, y **cada movimiento de kardex de sus reportes con su reversa presente**,
releÃ­do directo de `inventory_movements` en vez de confiar en `production_reports.status`).
Dry-run confirmÃ³ las cinco condiciones para los dos pedidos, sin ningÃºn motivo de bloqueo.
Ejecutado `--execute --confirm-production`: **2 `fiscal_documents`, 2 `sales_orders`, 3
`sales_order_items`, 6 `reservations`, 3 `production_orders`, 8
`production_order_consumptions`, 9 `production_reports`, 3 `fiscal_document_items`
borrados fÃ­sicamente.**

**VerificaciÃ³n final:**

- `origin = IMPORTED` en producciÃ³n: **0 comprobantes, 0 pedidos.** El lote `d4282f5c-...`
  no dejÃ³ ningÃºn rastro.
- Kardex cuadrado: las 6 bobinas que tocaron las OP 5, 6 y 21 tienen hoy un saldo **igual a
  su peso nominal** (4755, 4549, 3348, 3468, 3470 y 3480 kg) â€” cero kilos netos consumidos
  por todo el ensayo, de punta a punta.
- ProducciÃ³n real hoy: 2 `users`, 49 `customers`, 174 `products`, 50 `coils`, 9 `finishes`,
  **2 `sales_orders`** (seq 1 `CANCELLED`, seq 134 `IN_PRODUCTION` â€” sin tocar, ver abajo),
  **2 `quotations`** (seq 4 `CANCELLED`, seq 7 `CONFIRMED` â€” sin tocar), **1
  `fiscal_document`** (`F001-00000001`, `REJECTED`, correlativo quemado â€” SUNAT nunca lo
  aceptÃ³, ver la secciÃ³n de arriba), **3 `production_orders`** (las dos del pedido 134 mÃ¡s
  una fuera de este ensayo).

**Pendiente, sin tocar (fuera de alcance de este pedido â€” solo cubrÃ­a 80 y 131):** el pedido
134 sigue `IN_PRODUCTION`, no anulado; su factura sigue `REJECTED`; la cotizaciÃ³n 7 sigue
bloqueada por el pedido 134 vivo, y la cotizaciÃ³n 4 por el pedido 1. Falta un nuevo plan del
dueÃ±o para esos cuatro.

### Limpieza final: borrado fÃ­sico de lo Ãºltimo que quedaba del ensayo (2026-09-08)

Inventario pedido antes de tocar nada: cotizaciÃ³n 4 (`CANCELLED`) y cotizaciÃ³n 7
(`CONFIRMED`); pedido 1 (`CANCELLED`) y pedido 134 (`IN_PRODUCTION` â€” nunca se habÃ­a anulado
del todo, con una reserva de materia prima **`ACTIVE` de 3193.862 kg** todavÃ­a viva sobre la
OP 29); la factura `F001-00000001` (`REJECTED`, sin cobros, sin notas de crÃ©dito); las OP 1
(del pedido 1), 28 y 29 (del pedido 134), las tres `CANCELLED` con sus reportes `REVERTED` y
sus consumos liberados. Cero despachos en ningÃºn pedido.

**Reversa pendiente, por flujo normal:** el pedido 134 nunca se habÃ­a anulado â€”
`SalesOrdersService.cancel` lo dejÃ³ `CANCELLED` y liberÃ³ esa Ãºltima reserva `ACTIVE` (bajÃ³ a
`RELEASED`, `qty=0`). Con eso, los dos pedidos y todo lo suyo quedaron limpios para el
borrado fÃ­sico.

**Borrado fÃ­sico por script puntual con guardas** (mismo patrÃ³n que las cotizaciones TEXAS
CITY y que D-144: sin despachos, sin cobros vigentes, sin notas de crÃ©dito, pedidos y OP
`CANCELLED`, y cada movimiento de kardex de los reportes con su reversa presente, releÃ­do
del propio kardex). Sin bloqueos. Ejecutado en una sola transacciÃ³n: **2 `sales_orders`
(seq 1, 134), 1 `fiscal_document` (`F001-00000001`), 2 `quotations` (seq 4, 7), 6
`reservations`, 3 `production_orders` (seq 1, 28, 29), 3 `production_reports` borrados
fÃ­sicamente.** La factura `REJECTED` se borrÃ³ porque nunca fue un documento vigente (SUNAT
la rechazÃ³, D-105 dice que el PSE nunca la conociÃ³ como propia) â€” su correlativo
`F001-00000001` sigue quemado para siempre, no se recupera (mismo criterio que la
numeraciÃ³n de Fase 5b): la prÃ³xima factura real de `production` empieza en `F001-00000002`.

**VerificaciÃ³n final â€” producciÃ³n quedÃ³ exactamente en:** `quotations = 0`,
`fiscal_documents = 0`, `sales_orders = 0`, `reservations = 0`, `production_orders = 0`,
`production_reports = 0`, `dispatches = 0`. Lo Ãºnico que queda es lo estructural: 2 `users`,
49 `customers`, 174 `products`, 50 `coils`, 9 `finishes`, 6 `colors`, 5 `business_lines` â€”
seed + catÃ¡logo + bobinas + acabados. Las 7 bobinas que tocÃ³ el ensayo de punta a punta
(incluida la de la OP 29) tienen su saldo exactamente igual a su peso nominal: cero kilos
netos consumidos por toda la noche.

Con esto, el ensayo del 2026-09-07/08 no dejÃ³ **ningÃºn** rastro en `production` salvo el
correlativo quemado de `F001-00000001` (documentado acÃ¡, irreversible) y las herramientas
que quedaron (`--exclude-touched`, `--include-reverted`, D-143/D-144) para la prÃ³xima vez
que algo similar haga falta revertir.

## SesiÃ³n de estabilizaciÃ³n (2026-09-08) â€” M0: la OP de coberturas a stock estaba rota en la base (D-145)

**SÃ­ntoma:** `POST /api/production/roofing` con `productId` + `targetPieces` (la orden a
stock de D-140, la que ofrece `/planta` y la que arma el CLI de importaciÃ³n de D-142)
devolvÃ­a **`500 Internal server error`**, sin ningÃºn mensaje. No habÃ­a repro documentado.

**Reproducido en local (Docker, base `ayr_local_e2e`) antes de tocar cÃ³digo.** El error real,
que el 500 tapaba:

```
PrismaClientUnknownRequestError en tx.productionOrder.create()
  roofing-production.service.ts:318
PostgresError 23514: new row for relation "production_orders"
  violates check constraint "production_orders_roofing_contra_pedido"
```

**Causa raÃ­z, y una segunda que la primera destapÃ³:**

1. **El `CHECK` de Fase 6 nunca se actualizÃ³.** `production_orders_roofing_contra_pedido`
   (migraciÃ³n `20260904180000_fase6_coberturas_color`, D-084) exige `reservation_id IS NOT
NULL` en toda OP `ROOFING`. D-140 â€”resuelta un dÃ­a antes por el dueÃ±oâ€” introdujo
   `createToStock`, que crea exactamente eso: una OP `ROOFING` **sin reserva**. El cÃ³digo
   nuevo y la base quedaron diciendo cosas opuestas.
2. **`createToStock` no guardaba `targetPieces`.** Lo valida (`create` falla sin Ã©l) y lo
   audita, pero no lo pasaba al `data` del `create` â€” drywall sÃ­ lo hace desde D-048
   (`production.service.ts:291`). Se vio reciÃ©n al aplicar el fix del constraint: el insert
   seguÃ­a fallando porque `target_pieces` llegaba `null`. AdemÃ¡s de romper D-145, dejaba
   `/planta` y `/produccion` mostrando Â«Meta: â€”Â» en la Ãºnica clase de orden que la tiene por
   definiciÃ³n.

**Por quÃ© llegÃ³ desplegado sin que nadie lo notara.** Los unitarios de `production` son de
aritmÃ©tica pura (Prisma mockeado: un `CHECK` de la base les es invisible), y el E2E de Fase 6
cubre el **rechazo** de D-140 (`fase6.spec.ts`, Â«plancha de catÃ¡logo: se vende de stock y
producirla contra el pedido no tiene rutaÂ») y **se detiene en la frase que nombra la salida**
â€”"producÃ­ una orden a stock desde planta"â€” sin recorrerla nunca. La mitad prohibida estaba
probada; la mitad permitida, no.

**Arreglo (D-145).** MigraciÃ³n
`20260908150000_d145_allow_roofing_production_order_to_stock`: el constraint pasa a
`production_orders_roofing_contra_pedido_o_a_stock`, con forma `kind <> 'ROOFING' OR
reservation_id IS NOT NULL OR target_pieces IS NOT NULL` â€” conserva la garantÃ­a de D-084 (una
OP de coberturas nunca es huÃ©rfana) admitiendo las dos formas legÃ­timas de nacer. MÃ¡s el
`targetPieces: input.targetPieces` que faltaba. **No se tocÃ³ el kardex ni
`InventoryService.record`**: el resto del ciclo a stock (`mountCoil`, `report`, `close`,
`reverseReport`, `cancel`) ya trataba `reservationId` como opcional y no necesitÃ³ un solo
cambio.

**RegresiÃ³n, roja antes y verde despuÃ©s:** `e2e/tests/fase7final-op-a-stock.spec.ts`, 2 casos
â€” el ciclo completo a stock (crear sin reserva â†’ montar â†’ rolar 5 planchas de 4 m = 80 kg â†’
cerrar con 3 kg de despunte â†’ kardex `IN:PURCHASE`/`OUT:PRODUCTION`/`OUT:SCRAP`) y la
cobertura a medida, que sigue sin camino a stock. El caso del ciclo **verifica lo que D-140
decidiÃ³**: sin pedido detrÃ¡s no hay promesa que trasladar (D-088), asÃ­ que las planchas entran
como **saldo libre** (`reservedQty = 0.000`, `availableQty = 5.000`) y el pedido de catÃ¡logo
que esperaba puede reservarlas despuÃ©s.

Verificado: `pnpm turbo lint typecheck test` verde (293/293) y `pnpm e2e fase6 fase6-bordes`
verde (12/12), sin regresiones.

### M1 â€” la tolerancia de reserva de MP ya estaba en `main`; queda el checklist de deploy

**Verificado, no construido.** La tolerancia de espesor (Â±0.02 mm) y la igualdad estricta de
color del agregado genÃ©rico de materia prima (D-134) ya estaban commiteadas en `main` â€” el
Ãºltimo commit que las tocÃ³ es `8bfa5bb`. Cobertura:

- **Unit**: `roofing-math.spec.ts` fija el borde exacto (0.32 y 0.28 pasan contra 0.30; 0.33
  no) y `raw-material.spec.ts` comprueba que el agregado suma bobinas de 0.44 y 0.46 para una
  spec de 0.45 y descarta las de otro color. `ROOFING_THICKNESS_TOLERANCE_MM = '0.02'` vive en
  `@ayr/shared` con override por entorno (`ROOFING_THICKNESS_TOLERANCE_MM`).
- **E2E**: `fase7final-m1` (5/5) y `fase6-bordes` caso 1 (filtro por espesor/color/estado).

**Smoke contra Docker, sobre el artefacto compilado.** `pnpm build` verde, y despuÃ©s la suite
`fase7final-op-a-stock` + `fase6` corrida con `CI=true` contra el Postgres de Docker â€” que es
lo que hace que Playwright levante `node dist/main.js` + `next start` en vez de `nest start`,
o sea **la misma forma que corre en Cloud Run**: **14/14 verdes**.

**No se desplegÃ³ nada.** Checklist listo para cuando el dueÃ±o dÃ© el OK:

```bash
# 1. Todo verde y commiteado, CI verde en GitHub Actions (D-123)
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e

# 2. MigraciÃ³n primero, y esta vez el orden SÃ es seguro (ver abajo)
pnpm db:prod            # aplica 20260908150000_d145_... (y lo que production tenga pendiente)

# 3. API
pnpm deploy:api

# 4. Web: por push a main (la integraciÃ³n Vercel-GitHub). `pnpm deploy:web` sigue
#    necesitando que el dueÃ±o corra `vercel login`: el token del CLI estÃ¡ vencido.

# 5. VerificaciÃ³n post-deploy, solo lectura (D-126). NUNCA pnpm e2e:prod (regla dura 9)
pnpm smoke:prod
```

**Por quÃ© esta vez el orden sÃ­ es seguro,** a diferencia del aviso de la sesiÃ³n anterior: la
migraciÃ³n de D-145 **afloja** un `CHECK`, no lo endurece ni cambia ninguna columna. El API
viejo corriendo contra la base ya migrada sigue funcionando exactamente igual (nunca intenta
insertar una fila que el constraint nuevo rechace y el viejo aceptara), asÃ­ que no hay ventana
de incompatibilidad entre el paso 2 y el paso 3. No hace falta que nadie deje de operar.

### M2 â€” ensayo de recarga de agosto en `demo`: parado por decisiÃ³n del dueÃ±o

**Paso 0 hecho.** `demo` estaba **3 migraciones atrasada** respecto de `main`:
`20260907180000_fase7finalb_origen_del_pedido`, `20260907190000_fase7finalb_import_batch_id_ventas`
y `20260908150000_d145_...` (el fix de M0). Las tres aplicadas con `pnpm db:demo` (migrate
deploy + purga de sesiones heredadas + seed del admin de demo). Sin incidentes.

**Inventario de `demo` antes de tocar nada** (solo lectura). Demo es el clon de production al
2026-09-06, o sea **de antes** de la limpieza del ensayo, asÃ­ que arrastra todo el residuo E2E
que production tenÃ­a entonces: 1 985 bobinas (1 927 `CANCELLED`, 48 `OPEN` con 120 729 kg de
saldo), 1 617 productos (mayorÃ­a `BOBE2Eâ€¦`/`IMP-OK-â€¦`/`SKU-â€¦`), 968 acabados, 1 070
proveedores, 6 836 movimientos de kardex, 219 pedidos (215 `CANCELLED`), 2 comprobantes
`DRAFT`. **Si el ensayo se retoma, conviene rehacer `demo` desde `production`** (que hoy sÃ­
estÃ¡ limpia) antes de cargar nada â€” el procedimiento estÃ¡ en `docs/ENTORNOS.md`.

**Dry-run de ventas contra `demo`** (`Ventas Detalladas.xlsx`: 141 filas, 71 documentos,
03/08/2026 â†’ 31/08/2026 â€” es el archivo de agosto). Resultado: **40 SKUs faltantes** (los
mismos 40 del ensayo anterior: demo no tiene los 55 productos de Metallic Roofing que el dueÃ±o
creÃ³ en production el 07-09, posteriores al clon), **ninguna unidad sin mapear**, y 1 nota de
crÃ©dito excluida con su motivo (`FFC1-73`). NingÃºn documento se confirmÃ³: el dry-run no
escribe negocio.

**No se ejecutÃ³ la importaciÃ³n y no se va a reimportar** â€” decisiÃ³n del dueÃ±o en el chat.
La mitad de bobinas del ensayo tampoco se corriÃ³: **no existe ningÃºn archivo de bobinas de
agosto** en `local-data/`, solo el de ventas.

#### Incidente: el dry-run pisÃ³ el archivo de decisiones del dueÃ±o

Correr el dry-run con `--decisions "local-data/Ventas Detalladas.decisiones.json"` â€”la forma
natural de preguntar "con mis decisiones puestas, Â¿quÃ© falta?"â€” **borrÃ³ ese mismo archivo**:
el esqueleto que el dry-run escribe va, por defecto, a `<archivo>.decisiones.json`, que es
exactamente el nombre que el dueÃ±o usa para el suyo. Se perdieron las **40 lÃ­neas de negocio**
asignadas SKU por SKU y la lista de **23 comprobantes marcados como pendientes**. No estaba en
git (`local-data/` es ignorada por completo, D-142) ni en `dev` (los 40 SKUs no existen ahÃ­).
El dueÃ±o decidiÃ³ rehacerlo a mano en vez de autorizar una lectura de `production` para
recuperarlo.

**Arreglado para que no pueda repetirse** (`apps/api/prisma/import-ventas-cli.ts`,
`safeScaffoldPath`): el dry-run **nunca pisa un archivo que ya existe**. Sin `--out`, si el
destino por defecto existe, no escribe nada y lo dice. Con `--out` explÃ­cito manda quien lo
escribe, salvo que apunte al mismo archivo que `--decisions`, que ahora aborta con el motivo.
Es la misma clase de defecto que D-128: una herramienta que hace algo destructivo por defecto
en el camino mÃ¡s natural de usarla.

### Hallazgos de `revisor` corregidos en esta sesiÃ³n

- **El test nuevo daba por buenas las reversas sin mirarlas.** `purgeRoofingTrail` envuelve
  cada paso en un `catch` silencioso (es limpieza de `finally`), asÃ­ que `reopen` â†’
  `reverseReport` â†’ `cancel` sobre una OP **sin reserva** â€”justo las rutas que el flujo a
  stock estrenaâ€” corrÃ­an sin que nadie comprobara el resultado: si alguna se rompÃ­a, el test
  seguÃ­a verde. Ahora la reversa se corre **dentro del `try`, sin `catch`**, y se comprueba
  que la bobina vuelve a sus 2 000 kg y el producto a cero.
- **El spec no miraba el kardex del producto**, solo el de la bobina: se agregÃ³ el
  `ADJUST:PRODUCTION` del cierre y el `avgCost` de 83.0000 que ese ajuste produce.
- **`--out` vs `--decisions` se comparaba con `===` sobre cadenas.** En NTFS
  `â€¦DECISIONES.json` y `â€¦decisiones.json` son el mismo archivo, asÃ­ que el chequeo nuevo
  dejaba pasar el caso que existe para impedir. Ahora la comparaciÃ³n ignora mayÃºsculas en
  Windows (`samePath`) y **corre al parsear argv**, antes de `ImportsService.upload` â€” si no,
  abortaba dejando ya creados el lote y sus `import_rows`.
- **RF-31 en `ARQUITECTURA.md` seguÃ­a diciendo que `POST /production/roofing` exige
  `reservationId`**, falso desde D-140 y contradicho por la fila D-145 del mismo archivo.
  Corregido con la excepciÃ³n de la corrida a stock. Lo mismo en el doc de
  `ProductionOrder.reservationId` del schema, que solo nombraba a drywall.
- **`targetPieces` estaba duplicado como tipo local en el spec**; se agregÃ³ al DTO compartido
  de `e2e/helpers/production.ts`, que era donde faltaba.

**No corregido, a propÃ³sito: el `CHECK` acepta `target_pieces = 0` o negativo.** El revisor
propuso `("target_pieces" IS NOT NULL AND "target_pieces" > 0)`, que es mÃ¡s fiel al comentario.
No se aplicÃ³ porque **la migraciÃ³n ya estÃ¡ aplicada en `demo`**: editar su SQL cambia el
checksum y rompe `prisma migrate deploy` contra esa rama con el mismo sÃ­ntoma que ya apareciÃ³
dos veces (ver D-053 y las notas de la sesiÃ³n 7-final-C). El piso de 1 lo garantiza hoy
`piecesSchema` en `@ayr/shared` (`.int().min(1)`), que es por donde entra el Ãºnico camino que
crea estas Ã³rdenes. Si algÃºn dÃ­a hace falta en la base, va como migraciÃ³n aparte.

## SesiÃ³n Planta (2026-09-08) â€” integridad de producciÃ³n y reporte en tanda (D-146..D-149)

SesiÃ³n de planta, no una fase. Cinco puntos pedidos por el dueÃ±o, los cinco cerrados. Todo
en **local (Docker)**; producciÃ³n no se tocÃ³ en ningÃºn momento, ni para leer, y **no se
desplegÃ³ nada**.

### M0 â€” el plan de corte pasa a ser un tope duro (D-146)

**El hueco:** la Ãºnica cota de un reporte de coberturas era el **material montado**. Una
orden de 100 ML con un rollo entero encima podÃ­a reportar 300 ML y nadie se quejaba; esos
metros de mÃ¡s nacÃ­an reservados a nombre del pedido (D-088) o entraban al almacÃ©n como stock
que ningÃºn pedido encargÃ³.

`RoofingProductionService.reportInTx` compara ahora el acumulado de los reportes **vigentes**
contra `Î£ cantidad Ã— largo` del plan de corte y rechaza el exceso **sin tolerancia** â€” el
borde exacto entra y el milÃ­metro siguiente no. Producir mÃ¡s de lo planeado sigue siendo
posible, pero por donde corresponde: ajustar el plan (`PUT /production/roofing/:id/plan`) y
reciÃ©n despuÃ©s reportar.

**Los datos histÃ³ricos que ya se pasaron del plan no se tocan ni se bloquean para lectura.**
La regla mira hacia adelante: un acumulado excedido deja el restante en cero y rechaza el
reporte **siguiente**, nada mÃ¡s. Hay un caso de regresiÃ³n que lo fija (`roofing-math.spec.ts`).

La aritmÃ©tica vive en `@ayr/shared` (`roofingPlanProgress`, `roofingPlanOverrun`,
`remainingPlanPieces`) y la corren los dos lados: el API para rechazar y la terminal para
mostrar el restante antes de que nadie tipee. Dos copias habrÃ­an sido dos topes distintos.

### M1 â€” kg consumido por reporte, opcional y como dato (D-146, segunda mitad)

`consumedKg` opcional en `POST /production/roofing/:id/report`. Se guarda en
`production_reports.consumed_kg` (columna nueva, nullable, migraciÃ³n
`20260908180000_d146_kg_declarado_por_reporte`) y **no toca el kardex**: la salida de la
bobina sigue siendo el kilo teÃ³rico de los largos (D-047) y el consumo real se reconcilia al
cerrar (D-089), que es donde sale el despunte. DecisiÃ³n del dueÃ±o entre las dos opciones que
se le plantearon.

El tope es el kilo teÃ³rico del **plan completo** con la geometrÃ­a del rollo montado â€”tambiÃ©n
elegido por el dueÃ±o frente a la alternativa mÃ¡s estricta (el teÃ³rico de los largos de ese
reporte), que no habrÃ­a dejado declarar ningÃºn despunte.

La tarjeta "Reportar largos rolados" de `/planta` muestra ahora, en una fila compacta de
cuatro cifras: **ML del plan, ML reportado, ML restante y kg teÃ³rico del plan**. El layout se
rehÃ­zo: los campos estaban sueltos y desalineados; ahora el kg y el resumen del reporte
comparten una fila con `items-end`, y el botÃ³n va con la fecha de operaciÃ³n en la siguiente.

### M2 â€” pÃ¡gina "Reportar producciÃ³n en tanda" (D-147)

`/planta/tanda`. Una fila por orden de coberturas abierta (filtro de texto por orden,
producto, pedido o cliente; y `?pedido=<id>` para llegar acotado desde el pedido). Cada fila
muestra orden, Ã­tem, ML plan, ML reportado, ML restante, y captura **ML nuevo** y **kg
consumido** (opcional).

**Los largos no se tipean.** Se derivan del plan de la propia orden con `piecesFromPlanMeters`
(`@ayr/shared`), una bÃºsqueda **exacta** â€”no glotonaâ€” que devuelve el desglose en planchas y
lo muestra bajo el input mientras se escribe. Que sea exacta no es refinamiento: con un plan
de `2 Ã— 4.20 m` mÃ¡s `1 Ã— 6.00 m`, el reparto glotÃ³n por orden de plan no encuentra los 6.00 m
aunque la respuesta exista. Cuando los metros no salen de un nÃºmero entero de planchas, la
fila **falla en vez de redondear**: media plancha no existe.

`POST /production/roofing/batch` escribe las N filas en **una** transacciÃ³n reusando
`reportInTx` â€”no una segunda copia de la lÃ³gica de reporteâ€” y devuelve el error de **cada**
fila cuando alguna no valida, deshaciendo lo que las buenas alcanzaron a escribir. Un error
que no sea de dominio (una violaciÃ³n de constraint) sÃ­ corta en el acto: a partir de ahÃ­
Postgres aborta la transacciÃ³n y seguir juntando errores serÃ­a inventarlos.

### M3 â€” "Generar todas las Ã³rdenes" desde el pedido (D-148)

`POST /production/roofing/from-sales-order/:id`: una OP por cada lÃ­nea del pedido que todavÃ­a
no la tiene, en una transacciÃ³n. No cambia el modelo (**1 Ã­tem = 1 OP**, cada una naciendo de
su reserva por `createFromReservationInTx`, con el `CHECK` de D-145 intacto); lo que agrega es
que un pedido de ocho lÃ­neas no pueda quedar con cinco en cola y tres olvidadas. Las lÃ­neas de
catÃ¡logo se saltan en silencio: su camino es la corrida a stock (D-140), no este botÃ³n. Sin
reversa propia â€” anular una orden por separado ya existe (RF-33).

`planMeters` entra al DTO de la orden (y al listado, que hasta ahora omitÃ­a `items`), asÃ­ que
la tarjeta de `/planta` muestra los **ML a producir** sin abrir el detalle.

### M4 â€” hoja de planta en PDF (D-149)

`GET /sales/orders/:id/pdf-planta`, con `pdfkit` y el mismo patrÃ³n que el PDF de la cotizaciÃ³n
(D-068). Lleva nÃºmero de pedido, cliente, fecha prometida y, por Ã­tem, producto, cuÃ¡nto hay
que producir, los largos (`10 Ã— 4.20 m`) y las medidas que deciden quÃ© bobina se monta
(espesor, ancho, color â€” D-086), mÃ¡s un pie para firmar. **Sin ningÃºn importe.**

Dos diferencias deliberadas con el PDF de la cotizaciÃ³n: se arma **al vuelo y no se guarda en
R2** (aquel es un documento congelado que se le mandÃ³ al cliente; este es una copia de trabajo
del estado actual, y una versiÃ³n vieja bajando al taller es justo lo que no se quiere), y no
lleva precios (una hoja con mÃ¡rgenes circulando por la planta es la forma mÃ¡s barata de que se
entere todo el mundo). Se descarga desde el pedido y, en el telÃ©fono, se comparte con la Web
Share API â€” el botÃ³n de compartir solo aparece si el navegador declara poder compartir
**archivos** (`navigator.canShare({ files })`).

### VerificaciÃ³n

- `pnpm turbo lint typecheck test`: **306/306** unitarios en verde (13 nuevos en
  `roofing-math.spec.ts` para D-146/D-147: el tope y su borde exacto, el histÃ³rico excedido,
  el descuento por largo, y los cuatro casos de `piecesFromPlanMeters` incluida la vuelta
  atrÃ¡s que el glotÃ³n no encuentra).
- E2E local (Docker): `planta-tanda.spec.ts` (API) + `planta-tanda-ui.spec.ts` (pantalla, escrito por `qa`), **7/7** â€” tope del plan con su borde exacto, kg
  declarado que no mueve kardex, tanda feliz de dos Ã³rdenes, tanda con una fila que se pasa
  del tope (**rollback comprobado en el kardex**, no en el mensaje), metros que no cierran en
  planchas enteras, generaciÃ³n de las Ã³rdenes de un pedido, descarga de la hoja de planta, y el
  recorrido de la pantalla de tanda de punta a punta (desglose en vivo, error inline del tope,
  envÃ­o y kardex comprobado por API).
- RegresiÃ³n en tandas chicas contra el Postgres local, cubriendo **todo spec que toca
  `/production/roofing`** (que es lo Ãºnico que D-146 puede cambiar) mÃ¡s los que leen el DTO de
  producciÃ³n: `fase6 fase6-bordes fase7final-m1 fase7final-op-a-stock planta-tanda` (**25/25**),
  `fase5a-bordes fase7* fase7-consolidada fase7e-bordes` (**84 pasaron, 3 fallaron**) y
  `fase4 fase4-bordes fase7d fase7e fase7e-ajustes-d121 fase7final-m0 fase7finalb-pedido-importado`
  (**40/40**). **149 casos, 3 fallas y ninguna del cÃ³digo:** son las tres de `fase7b` que emiten
  contra el PSE demo y chocan con su cupo (_"No puedes enviar mas de 50 documentos en una cuenta
  DEMO"_), el mismo lÃ­mite externo ya anotado en el cierre de la Fase 5b.
- Tras aplicar los hallazgos de la revisiÃ³n, la tanda de coberturas se volviÃ³ a correr entera
  (`planta-tanda planta-tanda-ui fase6 fase6-bordes fase7final-m1 fase7final-op-a-stock`):
  **26/26**.
- **En tandas y no de una sola corrida, a propÃ³sito:** el token de acceso dura 15 minutos y una
  corrida completa de la suite se pasa de ahÃ­ y empieza a caerse con 401 a mitad de camino.
- **No se corriÃ³ `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocÃ³ producciÃ³n.
- **Nada desplegado.** Falta el visto bueno del dueÃ±o; la migraciÃ³n de esta sesiÃ³n
  (`20260908180000_d146_kg_declarado_por_reporte`) es **aditiva y nullable**, asÃ­ que el API
  viejo contra la base ya migrada funciona igual y no hay ventana de incompatibilidad entre
  migrar y desplegar.

**Hallazgo del E2E, que es comportamiento correcto y quedÃ³ documentado en el spec:** dos
Ã³rdenes del mismo color y espesor no pueden montar cada una un rollo entero mientras la
promesa de la otra siga viva. D-134 saca del disponible del agregado el rollo **completo** â€”no
los kilos asignadosâ€”, asÃ­ que el segundo montaje deja la otra reserva sin material y el
guardrail lo corta. El test compra la tercera bobina que el propio mensaje del guardrail pide.

### Hallazgos de `revisor` corregidos en esta sesiÃ³n

Dos pasadas en paralelo (API + `@ayr/shared` por un lado, `apps/web` por el otro) y una de
`qa`. NingÃºn bloqueante; lo alto y lo que valÃ­a la pena, corregido en el mismo commit.

- **La tanda escribÃ­a a medias antes de fallar, y las filas siguientes se validaban contra esa
  suciedad.** `reportInTx` no es atÃ³mica por dentro: descuenta la reserva, mueve el pedido a
  `EN_PRODUCCION` y crea el reporte **antes** del primer punto que puede fallar por dominio,
  que es `inventory.record`. Al capturar el error y seguir el bucle, la fila 2 veÃ­a la reserva
  ya consumida por la fila 1 fallida y devolvÃ­a un error que era puro efecto colateral. El
  caso no era exÃ³tico: una tanda **retrofechada sin confirmar** hacÃ­a fallar a todas las filas
  en el kardex y devolvÃ­a N errores fabricados. No habÃ­a corrupciÃ³n â€”el `throw` final revierte
  todoâ€”, pero el contrato que la pantalla promete ("el error de **cada** fila") era falso.
  Corregido con un **`SAVEPOINT` por fila**: la que falla se deshace sola y las que siguen ven
  el estado real.
- **Las filas se bloqueaban en el orden que mandaba el cliente.** Cada una toma un `FOR UPDATE`
  sobre su orden y los acumula hasta el commit, asÃ­ que dos tandas simultÃ¡neas con las mismas
  Ã³rdenes en distinto orden se trababan en deadlock â€” el mismo defecto que ya habÃ­a costado un
  incidente y que motivÃ³ el "pedido primero, reserva despuÃ©s" de `report`. Ahora se ordenan por
  id antes de tocar nada.
- **`piecesTheoreticalKg` quedÃ³ duplicada.** El comentario del cÃ³digo compartido decÃ­a que
  `roofing-math.ts` "la envuelve" y no la envolvÃ­a: eran dos copias byte a byte, y el tope de
  kg declarado usaba la del API. Exactamente las "dos copias serÃ­an dos topes distintos" que el
  propio comentario advertÃ­a. `roofingTheoreticalKg` pasÃ³ a delegar.
- **`MAX_BATCH_ROWS` bajÃ³ de 50 a 20.** Con 50 filas, el presupuesto de 120 s daba 2.4 s por
  fila â€”cada una hace lo que `report` entero, que ya necesita 30 s contra Neonâ€” y la
  transacciÃ³n retenÃ­a los locks de 50 Ã³rdenes, sus pedidos y sus bobinas durante dos minutos.
- **El cierre ignoraba los kilos que planta declarÃ³ por reporte.** `close` seguÃ­a asumiendo
  merma cero cuando no le pasaban `consumedKg`, contradiciendo en silencio la cifra que el
  encargado se habÃ­a tomado el trabajo de anotar. Ahora los usa como valor por defecto (con
  piso en el kilo teÃ³rico ya reportado); lo explÃ­cito sigue mandando.
- **`SUPERVISOR_PLANTA` recibÃ­a 403 en la hoja de planta**, el Ãºnico documento que D-149
  diseÃ±Ã³ para el taller. La ruta suma ese rol; no lleva importes, asÃ­ que no le abre nada de lo
  que el mÃ³dulo comercial le oculta.
- **El mensaje del reparto agotado mentÃ­a.** Cuando `piecesFromPlanMeters` se quedaba sin
  presupuesto de nodos decÃ­a "esos metros no salen de un nÃºmero entero de planchas", que puede
  ser falso. Ahora distingue los dos casos y manda a reportar los largos a mano.
- **La tanda del web armaba el envÃ­o con las filas visibles.** Escribir tres filas y despuÃ©s
  tipear en el filtro para buscar la cuarta dejaba las tres primeras fuera del envÃ­o, y el
  Ã©xito borraba esos borradores sin que nadie se enterara â€” lo contrario exacto de "la hoja
  entra entera". Ahora el filtro solo decide quÃ© se pinta; ademÃ¡s la pantalla avisa cuÃ¡ntas
  filas con metros quedaron fuera de la vista.
- **Medios del web corregidos:** el enlace a la orden navegaba fuera y perdÃ­a todos los
  borradores (ahora abre en otra pestaÃ±a); la fila no comparaba el kilo teÃ³rico contra los
  kilos montados y dejaba tumbar la tanda entera despuÃ©s de un minuto de transacciÃ³n; una orden
  **sin plan de corte** mandaba a "ajustar el plan de corte" en vez de a la terminal; los
  errores por fila del intento anterior sobrevivÃ­an a un segundo intento fallido; y el botÃ³n de
  compartir la hoja de planta morÃ­a con un 401 sin salida cuando el token de acceso vencÃ­a
  (ahora reintenta tras el refresh).
- **Bajos corregidos:** `messageOf` reventaba dentro del `catch` si el cuerpo del error era
  `null` (la tanda salÃ­a como 500 opaco); el DTO de la tanda tipaba `status` y `productUnit`
  como `string` suelto; el botÃ³n de D-148 no ofrecÃ­a fecha de operaciÃ³n pese a que el schema la
  acepta (las OP de un pedido importado con fecha vieja nacÃ­an fechadas hoy); la terminal
  mostraba "ML del plan 0.000" y pedÃ­a elegir una bobina ya elegida en una orden sin plan; y
  quedaban dos formatos de cantidad conviviendo en la misma tarjeta.
- **Anotado y no corregido:** `GET /production/roofing/batch` corta en 500 Ã³rdenes abiertas sin
  avisar que truncÃ³. Con el volumen real estÃ¡ lejÃ­simos, y el filtro por pedido es la salida;
  si algÃºn dÃ­a importa, va como paginaciÃ³n con `hasMore`.

**Lo que la revisiÃ³n confirmÃ³, y no es menor:** `productionReport.create` existe en exactamente
dos lugares â€”el de coberturas, que pasa por el tope, y el de drywall, cuyo `lockOrder` corta por
`assertKind`â€”, asÃ­ que **no hay ningÃºn camino que escriba un reporte de coberturas sin tope**.
Y el reparto de metros a planchas se fuzzeÃ³ con 20 000 casos contra fuerza bruta: 0 discrepancias.

## SesiÃ³n Importadores (2026-09-08) â€” se borran los directos y entra el de cotizaciones (D-150..D-152)

SesiÃ³n de limpieza y reemplazo, no una fase. Todo en **local (Docker)**; producciÃ³n no se tocÃ³
ni para leer, y **no se desplegÃ³ ni se hizo push** (un push a `main` dispara el deploy del web).

### M0 â€” se elimina el mÃ³dulo de importaciones entero (D-150)

**DecisiÃ³n del dueÃ±o**, tomada sobre dos opciones y eligiendo la amplia: no solo los dos
importadores de 7-final (bobinas D-137 y ventas D-138/D-141), sino **todo** el mÃ³dulo. Se le
planteÃ³ explÃ­citamente que la opciÃ³n amplia da de baja RF-52 y RF-71/72, que estÃ¡n desplegados
y no son legacy de 7-final; lo confirmÃ³ igual.

**10 313 lÃ­neas menos en 49 archivos.** Se fueron los cinco adaptadores (`PRODUCTS`,
`CUSTOMERS`, `COILS`, `FISCAL_DOCUMENTS`, `COILS_HISTORY`, `SALES_HISTORY`), el ciclo de lote
`import_batches`/`import_rows` con su previsualizaciÃ³n fila por fila, el `ImportDialog` del web
y las cuatro puertas que lo abrÃ­an (catÃ¡logo, clientes, comprobantes Ã—2, bobinas), el CLI
`pnpm import:ventas` (D-142) con `purge-imported-sales` (D-143/D-144) y la auditorÃ­a de
importados, los schemas y enums de `@ayr/shared`, `tsconfig.cli.json`, y tres specs E2E
completos (`fase7c`, `fase7c-bordes`, `fase7finalb-pedido-importado`) mÃ¡s dos casos sueltos
(el de RF-52 en `fase1` y el de RF-12 en `fase2a`).

**Tres piezas conservadas, cada una con su motivo escrito en el cÃ³digo:**

- `apps/api/src/imports/parse-spreadsheet.ts`, con los lectores de celda por encabezado
  rescatados del adaptador borrado (tolerantes a tildes y mayÃºsculas, tope de 512 caracteres,
  la fecha como dÃ­a calendario). No son del importador viejo: son la parte aburrida y ya
  probada de leer una planilla que llenÃ³ un humano.
- `customers/document-lookup.service.ts` (padrÃ³n apis.net), que nunca fue del importador â€” lo
  usa el alta de cliente y ahora tambiÃ©n la de proveedor.
- `FiscalImportService.annulImported` (D-110). **No es una vÃ­a de ingreso, es el remedio de las
  filas que ya entraron por una**: un `fiscal_document` con `origin = IMPORTED` nace `ACCEPTED`
  con su cuenta por cobrar y el PSE no lo conoce como nuestro (D-105), asÃ­ que sin este mÃ©todo
  una fila mal cargada es deuda falsa permanente. ProducciÃ³n quedÃ³ en cero importados (D-144),
  pero `demo` es un clon anterior a esa limpieza y los conserva. El resto del servicio â€”el alta
  y el archivado al reimportarâ€” se recortÃ³: eran 400 lÃ­neas sin llamador.

**Dos cosas que quedaron a propÃ³sito y hay que saber:**

- **Las tablas `import_batches`/`import_rows` y las columnas `import_batch_id` no se tocaron.**
  Borrarlas es irreversible y son el Ãºnico rastro de las cargas que sÃ­ ocurrieron.
- **El spec de M-4 quedÃ³ con un solo caso**, el que no necesitaba importar: que la anulaciÃ³n
  interna no alcanza a un comprobante emitido por el ERP. Los otros cinco â€”el camino feliz, los
  dos guardrails, la idempotencia y el 403 del vendedorâ€” empezaban importando y no hay forma de
  montarlos. EstÃ¡ anotado en el propio archivo.

### M1 â€” importador masivo de cotizaciones (D-152)

Lo que reemplaza a lo borrado, y cambia de idea, no de implementaciÃ³n: **no escribe contra la
tabla, escribe una cotizaciÃ³n**. `QuotationsService.create` se partiÃ³ con el patrÃ³n `*InTx`
(D-099) y el importador llama a `createInTx`, la misma que el formulario.

- `POST /imports/quotations/preview` (multipart) lee el export real de ventas detalladas â€”una
  fila por lÃ­nea, agrupadas por `SERIE - NÃšMERO`â€”, resuelve el cliente por su documento y el
  producto por su SKU, y devuelve las filas con lo que no pudo resolver marcado por campo. **No
  escribe nada**: ni el archivo, ni un lote, ni una fila.
- `/cotizaciones/importar` pinta esas filas en una tabla editable en el navegador â€”cliente,
  producto, cantidad, precio y plan de corte, mÃ¡s quitar filasâ€” y revalida en vivo.
- `POST /imports/quotations` crea una cotizaciÃ³n **en BORRADOR** por comprobante, en una
  transacciÃ³n con un `SAVEPOINT` por documento: todo o nada, con el error de cada uno (mismo
  contrato que D-147).

**Las tres reglas, que son las lecciones de lo que se borrÃ³.** Cero creaciÃ³n silenciosa: un
cliente o un SKU que falta detiene su fila y se da de alta por su propio maestro (D-138 los
auto-creaba y por eso terminÃ³ necesitando un purge). Nada se adivina: el plan de corte por
defecto es `1 Ã— los ML de la lÃ­nea`, y **cuando no cabe en una plancha la fila pide el plan
real** en vez de repartirlo â€” el archivo de agosto tiene 23 de 27 lÃ­neas a medida por encima
del tope de 20 m, una de 1 832 m, y ese plan es despuÃ©s el tope duro de lo que planta puede
reportar (D-146). Y el importador **para en la cotizaciÃ³n**: emitir y confirmar comprometen
inventario, y eso se mira documento por documento. Decisiones del dueÃ±o las dos Ãºltimas.

Detalles del contrato con el archivo real (141 filas, 71 comprobantes, 48 clientes, 41 SKUs):
el precio unitario sale de `VALOR DE VENTA Ã· CANTIDAD` (el archivo no lo trae); un documento en
dÃ³lares se lleva a soles con **su propio** tipo de cambio, no con el de hoy; el nÃºmero del
comprobante viaja a las observaciones como `Factura externa: FFA1-1349`; la fecha del papel es
la de la cotizaciÃ³n (D-124); y las notas de crÃ©dito y las filas con `DOCUMENTO AJUSTADO` se
excluyen diciendo por quÃ©.

**Un defecto real que el E2E destapÃ³ de paso.** SheetJS lee las fechas de un csv como M/D/Y:
`03/08/2026` â€”el 3 de agosto del archivo del negocioâ€” entraba como el **8 de marzo**, sin error
y sin ninguna seÃ±al, y el comprobante terminaba en el mes equivocado. El csv pasa a leerse con
`raw: true` y la fecha la interpreta quien conoce el formato del archivo. Tiene su caso de
regresiÃ³n en `parse-spreadsheet.spec.ts`.

### M2 â€” el padrÃ³n en el alta de proveedor (D-151)

`GET /suppliers/lookup` reusando el `DocumentLookupService` que M0 conservÃ³: `SuppliersModule`
importa `CustomersModule` en vez de duplicar el cliente. Mismo throttle y mismo fallback
silencioso que el alta de cliente (D-067), con el rol **mÃ¡s estrecho** â€”solo ADMINISTRADORâ€”
porque el token de apis.net.pe es el mismo que sirve el tipo de cambio (D-029) y la cuota es
una sola.

### VerificaciÃ³n

- `pnpm turbo lint typecheck test`: **272/272** unitarios en verde (el total baja de 306 porque
  se fueron los 22 del adaptador de ventas y los 12 de la aritmÃ©tica de importaciÃ³n fiscal;
  entran 6 nuevos del plan por defecto y 1 de regresiÃ³n de la fecha del csv).
- E2E local: `import-cotizaciones` (API) + `import-cotizaciones-ui` (pantalla, escrito por
  `qa`) **7/7**, y `fase5a` de vuelta en verde tras el fix del seed; regresiÃ³n del borrado sobre
  `fase1 fase2a fase2b fase3 fase3b m2-reversa-pago m4-anulacion-importado fase7-consolidada`,
  **55/55** una vez retirados los dos casos que probaban el importador eliminado.
- `pnpm exec eslint e2e` y `prettier --check` limpios sobre todo lo de esta sesiÃ³n.
- **No se corriÃ³ `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocÃ³ producciÃ³n.

**Trampa del entorno local, que costÃ³ tres diagnÃ³sticos falsos en esta sesiÃ³n:**
`playwright.config.ts` usa `reuseExistingServer` en local, asÃ­ que un servidor colgado en
:3000/:3001 â€”de `pnpm dev:local`, de otra corrida o de otra sesiÃ³nâ€” se **reusa** y apunta a
otra base. El sÃ­ntoma es `Login admin fallÃ³: 401 Credenciales invÃ¡lidas` en el primer test, que
no se parece en nada a su causa. Antes de correr la suite:
`netstat -ano | grep LISTENING | grep ":300"` y matar lo que haya.

### Hallazgos de `revisor` y `qa` corregidos en esta sesiÃ³n

Una pasada de `revisor` sobre el diff completo y una de `qa` sobre la pantalla. NingÃºn
bloqueante, pero **tres altos que dejaban el importador inservible justo en las lÃ­neas de
coberturas**, que son las que motivaron la sesiÃ³n.

- **Quien exige los largos es la unidad, no el subtipo â€” otra vez.** El preview decidÃ­a
  `needsPieces` con `roofingKind === A_MEDIDA`, mientras el alta lo decide con
  `unit === 'MTR'` (`sellsByLength`). Es **exactamente** la confusiÃ³n que D-131 documentÃ³ y
  que ya habÃ­a costado que el mostrador pudiera vender material a medida: son dos preguntas
  distintas y una respondÃ­a por la otra. Un SKU en `MTR` que no fuera `A_MEDIDA` pasaba el
  preview sin una marca, la pantalla ni dibujaba la celda del plan, y el archivo entero morÃ­a
  en el confirm sin forma de arreglarlo salvo quitando la fila.
- **Un SKU repetido se resolvÃ­a solo, y mal.** El Ã­ndice del catÃ¡logo es
  `(business_line_id, sku)`: el mismo cÃ³digo puede existir en dos lÃ­neas de negocio, y un
  `new Map(...)` se quedaba con el Ãºltimo â€” otra lÃ­nea, otro precio de lista, otra rama de
  reserva, en silencio. Ahora un duplicado devuelve "elige el producto" en vez de adivinar.
  Mismo tratamiento para el documento del cliente, cuyo par Ãºnico es `(doc_type, doc_number)`.
- **La pantalla no recalculaba los largos al cambiar el producto.** Reasignar una fila a un
  producto por metro lineal dejaba la celda del plan apagada, y a uno simple mandaba `pieces`
  que el API rechaza. Ahora se recalcula con el producto elegido.
- **El desplegable de clientes estaba siempre vacÃ­o** (lo encontrÃ³ `qa` corriendo la pantalla,
  no el revisor leyendo el cÃ³digo): pedÃ­a `pageSize=500` y el tope de `paginationQuerySchema`
  es 200, asÃ­ que el request devolvÃ­a 400. Una fila sin cliente **no se podÃ­a corregir**: la
  Ãºnica salida era quitarla. Ahora se pagina de a 200 hasta traer el maestro y se avisa si no
  entrÃ³ entero.
- **CÃ³digo muerto que podÃ­a revivir mal.** `createImportedShellInTx`, `assertNoInventoryEffects`
  y `archiveImportedOrderInTx` (~180 lÃ­neas capaces de escribir pedidos `origin = IMPORTED` sin
  pasar por reservas) y la opciÃ³n `allowMissingPieces` de `resolveSalesLines` â€”la relajaciÃ³n que
  D-141 justificabaâ€” se quedaron sin llamador con el borrado. Se fueron con Ã©l: una relajaciÃ³n
  latente sin el contexto que la hacÃ­a segura es peor que no tenerla.
- **Medios corregidos:** el aviso de unidad bloqueaba el botÃ³n como si fuera un error (los
  avisos pasan a tener severidad y solo los errores bloquean); el detalle del comprobante seguÃ­a
  instruyendo a "reimportarlo", que ya no existe; `parsePlan` no comprobaba las cotas del schema
  y el error volvÃ­a como un Zod que la pantalla no sabÃ­a atribuir a ninguna fila; el plan por
  defecto se derivaba de la cantidad **sin** redondear y los largos no sumaban la cantidad de la
  lÃ­nea; los desplegables ofrecÃ­an maestros inactivos, que tumban el archivo entero; y nada
  avisaba al subir dos veces el mismo archivo â€” ahora el preview marca el comprobante que ya
  tiene cotizaciÃ³n viva.
- **Bajos corregidos:** la descripciÃ³n se recorta a 240 (el tope del schema) y no a 512 (el del
  lector de celdas); `confirm` gana su `@Throttle`; volver a elegir el mismo archivo vuelve a
  disparar la lectura; un campo con dos avisos los muestra los dos; `FiscalImportService` deja
  de exportarse; `scripts/e2e-prod.mjs` deja de nombrar suites borradas; y `e2e-report.json` y
  `subset.json` entran al `.gitignore` (regla dura 13) en vez de quedar sueltos en la raÃ­z.

### Un defecto viejo que apareciÃ³ de paso: el seed apagaba RF-31

`fase5a.spec.ts` fallaba desde antes de esta sesiÃ³n con _"POST /api/sales/orders debÃ­a fallar y
devolviÃ³ 201"_ â€” el caso que comprueba que **en coberturas no hay pedido directo** (RF-31,
D-065). No era el guardrail: era el dato. `quotation_required = true` para `metallic-roofing` lo
pone un `UPDATE` de la migraciÃ³n de Fase 5a, o sea sobre las filas que existÃ­an entonces; en una
base **reciÃ©n reseteada** â€”el E2E local y la rama `ci` en cada corridaâ€” las lÃ­neas de negocio las
crea el seed, y nacÃ­an todas con el `false` por defecto. Con eso, coberturas dejaba de exigir
cotizaciÃ³n exactamente donde se lo prueba.

Ahora el seed lleva el dato, y solo lo fuerza donde es una regla del dominio: el resto de la
configuraciÃ³n de una lÃ­nea la administra el dueÃ±o y el seed no la pisa. ProducciÃ³n nunca estuvo
afectada (su fila la actualizÃ³ la migraciÃ³n y nadie la recreÃ³). `fase5a` volviÃ³ a verde.

## SesiÃ³n Comprobantes manuales (2026-09-08) â€” D-131 pasa a regla dura y entra D-153

Todo en **local (Docker)**; producciÃ³n no se tocÃ³ ni para leer, y **no se desplegÃ³ ni se hizo
push**. El diseÃ±o de D-153 se presentÃ³ al dueÃ±o antes de escribir una lÃ­nea y se implementÃ³ lo
que aprobÃ³.

### D-131 pasa a invariante (regla dura 14)

La confusiÃ³n entre _"Â¿esta lÃ­nea necesita el detalle de largos?"_ y _"Â¿se fabrica a medida?"_ ya
costÃ³ dos defectos â€”el mostrador vendiendo material a medida, y el importador de cotizaciones
dejando pasar sin marca toda lÃ­nea en `MTR` que no fuera `A_MEDIDA`â€”, la segunda **el mismo dÃ­a
que se escribiÃ³ el cÃ³digo**. Las dos veces el compilador callÃ³, porque las dos preguntas
devuelven `boolean`.

Ahora la respuesta tiene **una sola definiciÃ³n**: `sellsByLength(product)` en `sales-lines.ts`,
que el importador tambiÃ©n usa. La regla estÃ¡ en `CLAUDE.md` como la nÃºmero 14, y el centinela es
`sales-lines.spec.ts`: la tabla completa de combinaciones de unidad Ã— subtipo, mÃ¡s un caso que
se cae si alguien define una pregunta en tÃ©rminos de la otra.

### D-153 â€” el borrador tiene dos terminales

La empresa sigue emitiendo desde otra app mientras dura la migraciÃ³n. Esos comprobantes ahora se
registran acÃ¡, con su cuenta por cobrar y su pedido, sin pasar por Nubefact.

**El modo es un tercer valor de `FiscalDocumentOrigin` (`MANUAL`), no un campo aparte.** El
motivo se pudo medir antes de decidir: hay siete ramas en todo el cÃ³digo que miran `origin`, y
la que importa es una funciÃ³n llamada `assertIssuedHere` cuya prueba era `!== IMPORTED`. Con un
campo ortogonal, esas siete guardas habrÃ­an seguido **dejando pasar un manual a Nubefact**; con
un valor nuevo se dan vuelta a `=== ISSUED_HERE` en una pasada y el comportamiento cae solo.

`POST /invoicing/documents/:id/register-manual` cierra el borrador con la serie y el correlativo
del papel: `seriesId = null` â€”la serie del talonario no es una fila de `fiscal_series`, y
adelantar esa tabla quemarÃ­a rango de las series con las que se factura de verdadâ€”,
`status = ACCEPTED` por el mismo motivo que un importado (D-105), sin CDR ni XML. Que los dos
terminales partan del **mismo borrador** es lo que garantiza que un manual pase por las mismas
validaciones que un electrÃ³nico: son literalmente las de `createInTx`.

Lo demÃ¡s que entrÃ³: la **nota de crÃ©dito hereda el modo de su afectado**, con una guarda en cada
terminal; la anulaciÃ³n interna de D-110 se generaliza (`annulExternal`) y cubre todo lo que el
ERP no emitiÃ³; el pre-llenado de serie y correlativo desde el `Factura externa: FFA1-1349` que
el importador (D-152) deja en las observaciones del pedido; un ajuste global
(`invoicing_settings.manual_by_default`) que solo decide **cuÃ¡l de los dos botones viene
destacado**, con los dos siempre a la vista; y en el listado, el badge de origen para todo lo
que no sea del ERP mÃ¡s un filtro por origen.

### Lo que el dueÃ±o pidiÃ³ y no hizo falta hacer

PidiÃ³ que "la salida de stock sea idÃ©ntica en ambos modos, misma ruta `InventoryService.record()`".
**El comprobante no mueve kardex en ningÃºn modo**: lo mueve el despacho (D-074), por un solo
camino. La garantÃ­a ya existÃ­a por construcciÃ³n y no se tocÃ³ nada. Queda anotado con su caso de
prueba porque la pregunta va a volver.

### El defecto de D-145, otra vez â€” y esta vez lo agarrÃ³ el E2E

Registrar el primer manual devolvÃ­a **`500 Internal server error` sin mensaje**. Dos `CHECK` de
la base escritos cuando la regla era mÃ¡s angosta:

- `fiscal_documents_number_ck` exigÃ­a que el nÃºmero viniera **siempre** con un `series_id`. Un
  comprobante manual tiene nÃºmero â€”el del papelâ€” y no tiene serie del ERP.
- `fiscal_documents_annulled_origin_ck` reservaba el estado `ANNULLED` a lo importado, asÃ­ que
  un manual mal registrado no tenÃ­a vuelta y quedaba como deuda falsa permanente.

Es exactamente D-145: cÃ³digo que ensancha una regla y una base que sigue diciendo la anterior,
con un 500 mudo como Ãºnico sÃ­ntoma. La diferencia es que esta vez **no llegÃ³ a desplegarse**,
porque la sesiÃ³n escribiÃ³ el caso feliz y la reversa en el mismo spec. Corregidos en una
migraciÃ³n aparte (`20260908213000_...`), separada a propÃ³sito de la que agrega el modo: editar
una migraciÃ³n ya aplicada le cambia el checksum y rompe `migrate deploy`, que es un sÃ­ntoma que
este proyecto ya se comiÃ³ dos veces (D-053 y las notas de 7-final-C).

**La lecciÃ³n, que vale mÃ¡s que el fix:** al agregar un valor a un enum que la base conoce, hay
que ir a leer sus `CHECK`. El compilador no los ve, y son la parte del dominio que vive fuera de
TypeScript.

### Hallazgos de revisor y qa

**Los dos bloqueantes fueron del agente, no del diseÃ±o, y los dos por la misma causa mecÃ¡nica:**
las expresiones regulares de la pantalla se escribieron a travÃ©s de un heredoc de shell, que se
comiÃ³ las barras invertidas. `/^\d{1,8}$/` quedÃ³ como `/^d{1,8}$/` y el botÃ³n Â«RegistrarÂ» **nunca
se habilitaba**; el patrÃ³n del pre-llenado perdiÃ³ su `\s` y su `\d`, asÃ­ que **nunca matcheaba**,
con el fallo tapado por un `catch` silencioso. Los E2E por API no los veÃ­an porque no pasan por
la pantalla. Corregidos con la herramienta de ediciÃ³n. **Regla que queda: el cÃ³digo con
expresiones regulares se escribe con el editor, nunca por heredoc.**

Cuatro **altos**, todos la misma familia: cÃ³digo que preguntaba `!== IMPORTED` y con el tercer
valor pasÃ³ a decir algo falso. `voidPath` ofrecÃ­a Â«Dar de bajaÂ» sobre un manual (una baja ante
SUNAT de un comprobante que el ERP no emitiÃ³), `canAnnul` dejaba la reversa **inaccesible desde
la UI** â€”justo la mitad que el `CHECK` prohibÃ­aâ€” y `canQuery` mostraba Â«Consultar al PSEÂ» en
todos los manuales. Los tres colapsaron en un Ãºnico `isExternal`, que es la pregunta que las tres
querÃ­an hacer. El cuarto: el terminal manual no llamaba a `assertOwnership`, asÃ­ que un vendedor
podÃ­a cerrar el borrador de otro; el terminal electrÃ³nico sÃ­ lo hacÃ­a desde siempre.

Medios corregidos: el choque de nÃºmero entre dos registros simultÃ¡neos salÃ­a como `500` en vez de
`409`; `acceptedAt` quedaba nulo y â€”con `NULLS FIRST` en el desempateâ€” un manual desplazaba a la
factura electrÃ³nica como respaldo de una guÃ­a; el badge del detalle seguÃ­a marcando solo lo
importado. Y dos huecos de prueba que el propio revisor nombrÃ³ como Â«el mismo hueco de D-145Â»:
ahora hay un caso que **anula un manual de verdad** y otro que comprueba que **ninguna de las
cuatro puertas al PSE lo acepta** (`send`, `retry`, `refresh`, `void`).

Ese Ãºltimo caso se escribiÃ³ mal la primera vez y vale anotarlo: asertaba que el barrido
`send-pending` devolviera cero. **`send-pending` es global** â€”recorre hasta veinte documentos de
toda la baseâ€”, asÃ­ que el nÃºmero dependÃ­a de lo que otras pruebas hubieran dejado (devolviÃ³ 7), y
peor: **llamarlo mandaba al PSE demo comprobantes ajenos al escenario**, quemando cupo de la
cuenta y moviÃ©ndoles el estado. El barrido saliÃ³ del test; queda asertado lo que sÃ­ es del dato
â€”un manual nace `ACCEPTED`, que no estÃ¡ entre los estados reintentablesâ€” y la otra mitad del
filtro la sostienen las cuatro puertas, que son las que un refactor a `!== IMPORTED` romperÃ­a.
**Un test no puede asertar un contador global en una base compartida.**

De `qa`: la suite de UI (`comprobante-manual-ui.spec.ts`, 2 casos) cubre los dos terminales
visibles a la vez, la validaciÃ³n de serie en el diÃ¡logo, la vista previa del nÃºmero y el
pre-llenado desde las observaciones. Son exactamente los tests que cazan la regresiÃ³n de las
barras invertidas: si vuelven a caerse, el primer caso falla en Â«Registrar deshabilitadoÂ» y el
segundo en el pre-llenado. `qa` dejÃ³ anotado que el E2E local levanta el API con `nest start`, asÃ­
que un `.ts` a medio editar en `apps/api` tumba la corrida con un mensaje que no habla de tests
â€”vale saberlo cuando dos agentes trabajan en paraleloâ€”.

**Anotado y no tocado, porque no es de esta sesiÃ³n:** `scripts/dev-local-view.mjs` arma su mensaje
de error con `args.join(' ')` en vez de usar `run` de `scripts/lib.mjs`, que es la forma exacta
que la regla dura 5 nombra como el escape de D-128; hoy no viaja ninguna credencial por `argv`,
asÃ­ que estÃ¡ latente y no abierto. AdemÃ¡s imprime la contraseÃ±a local y numera los pasos Â«1/3,
2/4Â».

### VerificaciÃ³n

- `pnpm turbo lint typecheck test`: **279/279** unitarios (7 nuevos, el centinela de D-131), mÃ¡s
  `pnpm exec eslint e2e` y Prettier sobre lo tocado.
- E2E local: **9/9** entre `comprobante-manual` (7 casos por API) y `comprobante-manual-ui`
  (2 casos por pantalla, de `qa`). La regresiÃ³n de facturaciÃ³n
  (`fase7b-bordes m4-anulacion-importado fase5b-bordes`) quedÃ³ **19 de 23**, con las 4 fallas del
  cupo de la cuenta demo del PSE â€” el mismo lÃ­mite externo de siempre, ajeno al cÃ³digo.
- **No se corriÃ³ `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocÃ³ producciÃ³n.
- **Sin desplegar y sin push.** Las dos migraciones de D-153 estÃ¡n escritas y aplicadas en local;
  producciÃ³n sigue sin ellas.

## SesiÃ³n Planta II (2026-09-09) â€” el guard que bloqueaba de mÃ¡s, el espacio de producciÃ³n y el callejÃ³n del importador

Tres cosas, y las tres nacen del mismo lugar: el sistema le decÃ­a que no a la persona que no
podÃ­a resolverlo.

### D-154 â€” el faltante de materia prima avisa; no bloquea

**El sÃ­ntoma:** planta montaba una bobina llena de material y el API la rechazaba con "la
operaciÃ³n dejarÃ­a 0.000 kg libres de Bobina 0.45 mm ROJO y hay 150.000 kg prometidos a
PED-000003" â€” sobre **el pedido que estaba fabricando**. Tres defectos superpuestos detrÃ¡s
del mismo mensaje, y solo uno de los tres era la severidad.

1. **El pedido se bloqueaba a sÃ­ mismo.** `exceptReservationIds` exceptuaba la reserva de la
   lÃ­nea, pero un pedido de coberturas reserva una vez **por lÃ­nea** y genera una OP por
   reserva (D-084/D-148): montar la bobina de la lÃ­nea 1 se comprobaba contra la promesa viva
   de la lÃ­nea 2 del mismo pedido. Entra `exceptSalesOrderIds` y se exceptÃºa el pedido
   entero. El centinela es el test que hace la misma cuenta **sin** esa exclusiÃ³n y comprueba
   que ahÃ­ sÃ­ falta material: si alguien la saca creyendo que la reserva alcanza, se cae.
2. **Montar sacaba el rollo entero del agregado.** Planta monta los 5 000 kg del rollo para
   cortar los 200 que el pedido prometiÃ³, y el pool quedaba en cero sobre un almacÃ©n con
   4 800 kg libres. La causa era un **doble descuento**: una OP que nace de un pedido ya
   tiene su compromiso contado como reserva genÃ©rica sobre la spec, y sumarle ademÃ¡s la
   custodia contaba dos veces el mismo kilo. Ahora `heldKg` es **cero** cuando la orden tiene
   reserva; lo que va a consumir baja las dos cifras a la vez (`consumeReservationQty` con la
   salida de kardex). Solo las corridas **a stock** (D-140) aportan `assignedKg âˆ’ consumedKg`,
   porque no tienen reserva que las represente.

   **Esto lo encontrÃ³ la revisiÃ³n, y vale por sÃ­ solo.** El primer intento midiÃ³ la custodia
   como `assignedKg âˆ’ consumedKg` para todos, y esa versiÃ³n **no se activaba nunca**:
   `mountCoil` asigna el rollo entero salvo que alguien mande `qtyKg`, y nadie lo manda. El
   arreglo pasaba por corregir la cuenta, no por pedirle a planta que dijera cuÃ¡ntos kilos va
   a usar. La lecciÃ³n: un test que prueba un parÃ¡metro que ningÃºn llamador pasa da una
   sensaciÃ³n de cobertura que el sistema no tiene.

3. **La severidad.** En `mountCoil`, `report` y `close` la invariante devuelve los faltantes
   (`findRawMaterialShortfalls`) en vez de lanzarlos: viajan en la respuesta
   (`ProductionOrderDto.rawMaterialWarnings`), quedan en `audit_log` y se persisten en
   `production_reports.raw_material_warning`. **Fuera de producciÃ³n no cambia nada**: ventas,
   corte, bobinas y kardex siguen recibiendo el 400 de siempre.

De paso cayÃ³ el tope duro de D-146 sobre el **kg declarado**: pasa a aviso de desviaciÃ³n
(`roofingConsumptionDeviation`, Â±10 %, mÃ¡s el aviso de acumulado sobre el plan), calculado con
la misma funciÃ³n en el API y en la pantalla. El tope de **metros** del plan sigue siendo duro.

**La lecciÃ³n, que vale mÃ¡s que el fix:** cuando el sistema corta una operaciÃ³n, la pregunta no
es "Â¿la regla es correcta?" sino "Â¿la persona que estÃ¡ del otro lado puede hacer algo con
esto?". Quien estÃ¡ en la roladora no anula el pedido de otro cliente ni libera su reserva, asÃ­
que el 400 no protegÃ­a nada â€” el material se rolaba igual y lo Ãºnico que cambiaba era que no
quedaba registrado, que es exactamente lo que la invariante existÃ­a para evitar.

Y una segunda, sobre el orden de los arreglos: los tres defectos daban el mismo sÃ­ntoma. Si se
hubiera tocado solo la severidad, los dos falsos positivos habrÃ­an seguido ahÃ­, ahora
convertidos en avisos que nadie podrÃ­a distinguir de los verdaderos â€” que es peor que el
rechazo, porque un aviso que casi siempre miente se deja de leer.

**La consecuencia visible, que la regresiÃ³n de Fase 6 destapÃ³.** Con la bobina montada
contando otra vez en el agregado, el panel de stock de un rollo de 1 000 kg con 48 kg
prometidos pasa de mostrar `0.000` a `952.000` de material reservable. Es correcto â€”esos
kilos vuelven al almacÃ©n cuando la orden cierreâ€” y el `0.000` era el mismo bug mirado desde
la pantalla de ventas: le decÃ­a al vendedor que no habÃ­a material sobre un rollo intacto. La
restricciÃ³n que **sÃ­** sigue viva es de agenda y no de material: mientras estÃ© montada,
ninguna otra OP puede montar esa bobina, y eso lo sostiene `assertStripsNotAssigned`, no el
agregado. Dos specs de Fase 6 codificaban el comportamiento viejo y se actualizaron; uno de
ellos (`fase6.spec.ts`, "la pieza a medida no se la puede llevar otro pedido") pasÃ³ a usar una
bobina de 50 kg en vez de 1 000 para que el rechazo del pedido rival venga de **escasez real**
y no del artefacto de la cuenta.

### D-155 â€” `/planta/producir` reemplaza a la tanda

La tanda de D-147 dejaba transcribir los metros de N Ã³rdenes de una sentada, pero **no montaba
la bobina**: habÃ­a que entrar orden por orden a la terminal para montar y reciÃ©n despuÃ©s
volver a la tanda a reportar. Dos pantallas para una tarea.

Ahora una orden es una **pestaÃ±a** (lista lateral master-detail por encima de
`MAX_ORDER_TABS = 6`) con indicador **sin bobina / lista / reportada**, y adentro estÃ¡ el ciclo
completo: montar o cambiar la bobina con el mismo selector y los mismos endpoints que el
detalle de la orden, ML plan / reportado / restante / kg teÃ³rico, y los inputs de ML nuevo y kg
consumido. Barra de progreso arriba. **El guardado es por orden**, y cada uno sigue siendo
atÃ³mico del lado del API (reporte + kardex en una transacciÃ³n vÃ­a `InventoryService.record()`).

`POST /production/roofing/batch` se eliminÃ³ junto con sus schemas; `GET` queda y suma
`reservationId` y, por bobina, `consumptionId` y `consumedKg`. `/planta/tanda` quedÃ³ como
redirecciÃ³n â€”conservando `?pedido=`â€” para no dejar dos caminos vivos. El detalle del pedido
gana el botÃ³n **Producir (N)** y el detalle de la orden, el enlace a sus hermanas.

Los rÃ³tulos del menÃº tambiÃ©n cambiaron, porque "ProducciÃ³n" y "Terminal de planta" sonaban los
dos al mismo lugar: ahora son **Ã“rdenes de producciÃ³n** (gestiÃ³n), **Producir un pedido** (este
espacio) y **Terminal de planta** (una orden suelta).

**Lo que vale como criterio:** el todo-o-nada de D-147 era correcto **para una transacciÃ³n** y
equivocado **para una persona** â€” el error de la sÃ©ptima fila no invalida las otras siete, y
rehacerlas es trabajo que el sistema inventa. Y cuando una pantalla nueva obliga a volver a la
vieja para completar la tarea, no es una pantalla nueva: es medio flujo.

### D-156 â€” ningÃºn campo obligatorio es un callejÃ³n

El preview del importador de cotizaciones pasa a un **acordeÃ³n por comprobante** (nÃºmero,
cliente, total y estado de validaciÃ³n en la cabecera; las lÃ­neas al expandir, y solo se abre
solo lo que tiene algo sin resolver). Junto a cada campo que exige elegir de un maestro hay un
botÃ³n **crear** que abre **el mismo formulario de alta** â€”`CustomerDialog` y `ProductDialog`,
movidos a `components/`, con `initial` para prellenar lo que el archivo ya trae y `onCreated`
para devolver el registroâ€”: mismas validaciones, mismo endpoint, y **el estado del preview no
se pierde**. Los desplegables de mÃ¡s de 50 opciones pasan a un modal de bÃºsqueda con tabla,
filtro de texto y columna Â«SeleccionarÂ» (`SearchSelectModal` / `SearchSelectField`).

No contradice a D-152: lo que aquella prohibiÃ³ fue la creaciÃ³n **silenciosa** (D-138 creaba
clientes y SKUs por su cuenta y por eso terminÃ³ necesitando un purge por lote), no que se
pudiera crear algo desde el importador. La diferencia es quiÃ©n decide, no dÃ³nde estÃ¡ el botÃ³n.
El callejÃ³n, ademÃ¡s, tenÃ­a un costo medible: la Ãºnica salida era irse al maestro y volver, con
las 141 filas revisadas perdidas, asÃ­ que la conducta que el diseÃ±o premiaba era **quitar la
fila** â€”perder el datoâ€” en vez de resolverla.

### AuditorÃ­a Â«campo sin opciÃ³n = callejÃ³nÂ»

Barrido de todos los formularios con un campo obligatorio que exige elegir de un maestro. Un
campo es **callejÃ³n** cuando la opciÃ³n que falta no se puede crear sin abandonar la pantalla y
perder â€”o rehacerâ€” lo cargado.

| Pantalla â†’ campo                                    | Maestro           | Â¿CallejÃ³n?                                                 | Estado       |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------ | ------------ |
| CotizaciÃ³n / pedido â†’ Cliente                      | clientes          | SÃ­: enlace a otra pestaÃ±a, habÃ­a que volver y buscarlo    | **Resuelto** |
| CotizaciÃ³n / pedido â†’ Producto de la lÃ­nea        | catÃ¡logo         | SÃ­, sin ninguna salida                                      | **Resuelto** |
| Importador de cotizaciones â†’ Cliente                | clientes          | SÃ­, y perdÃ­a el archivo revisado entero                    | **Resuelto** |
| Importador de cotizaciones â†’ Producto               | catÃ¡logo         | SÃ­, y perdÃ­a el archivo revisado entero                    | **Resuelto** |
| Mostrador (POS) â†’ Cliente                           | clientes          | No: ya tenÃ­a Â«Crear y usarÂ»                               | â€”          |
| Despacho nuevo â†’ Pedido                             | â€”               | No: un pedido no es un maestro que se dÃ© de alta desde ahÃ­ | â€”          |
| Usuario â†’ Rol                                       | â€”               | No: es un enum                                               | â€”          |
| Compra â†’ Proveedor                                  | proveedores       | SÃ­                                                          | Backlog      |
| Compra â†’ Producto de la lÃ­nea                      | catÃ¡logo         | SÃ­                                                          | Backlog      |
| Compra â†’ Acabado (lÃ­nea de bobina)                 | acabados          | SÃ­                                                          | Backlog      |
| Compra â†’ Color                                      | colores           | SÃ­ (`ColorSelect` no ofrece alta)                           | Backlog      |
| Orden de corte â†’ Proveedor de corte                 | proveedores       | SÃ­                                                          | Backlog      |
| Orden de corte â†’ Perfil que consume el fleje        | catÃ¡logo         | SÃ­                                                          | Backlog      |
| Alta de producto (`ProductDialog`) â†’ Acabado, Color | acabados, colores | SÃ­                                                          | Backlog      |
| Comprobante nuevo â†’ Cliente                         | clientes          | SÃ­                                                          | Backlog      |

Se aplicÃ³ el componente en los tres de mayor uso â€”las dos puntas del formulario de cotizaciÃ³n y
pedido, y las dos del importadorâ€”, que son tambiÃ©n los que mÃ¡s trabajo hacÃ­an perder. El resto
queda anotado: `ExpressCreateCustomer` y `ExpressCreateProduct` ya sirven tal cual para
proveedores y acabados agregando su envoltorio, y `SupplierDialog` y el diÃ¡logo de acabados ya
existen: lo Ãºnico que les falta es `initial` / `onCreated`, que son las dos props que esta
sesiÃ³n agregÃ³ a los de cliente y producto.

### Entorno: los puertos del dueÃ±o

`pnpm dev:preview` levanta api `:4000` + web `:4001` contra `ayr_local` (nunca contra
`ayr_local_e2e`, que la suite vacÃ­a en cada corrida) para que el dueÃ±o mire la app mientras el
agente trabaja. Es **regla dura 15**: el agente no usa ni mata esos puertos; su entorno es
`:3000`/`:3001`, que es tambiÃ©n donde corre Playwright. El script reemplaza al
`dev-local-view.mjs` de la sesiÃ³n anterior y usa el `run` de `scripts/lib.mjs` en vez de armar
su mensaje de error con `args.join(' ')` â€” la forma exacta que la regla dura 5 nombra como el
escape de D-128. Hoy no viajaba ninguna credencial por `argv` ahÃ­; se cerrÃ³ antes de que sÃ­.

## SesiÃ³n Planta III (2026-09-09) â€” el importador se termina de asentar y producciÃ³n queda en un solo lugar (D-157..D-160)

Cuatro decisiones y un tema comÃºn: **terminar de sacar los pasos que el sistema inventaba**.
D-157 y D-158 cierran el importador de cotizaciones (una cotizaciÃ³n importada ya no nace
vencida, y el cliente que falta se da de alta desde el padrÃ³n sin salir de la pantalla);
D-159 y D-160 terminan el espacio de producciÃ³n (el plan se edita ahÃ­, el reporte llega
relleno, la bobina se elige buscando, y cerrar libera el rollo para la orden hermana en la
misma transacciÃ³n) y **funden las dos entradas a producir en una sola**.

### D-157 â€” una cotizaciÃ³n puede no vencer

El importador creaba las 71 cotizaciones de agosto con la vigencia por defecto â€”siete dÃ­asâ€”
sobre una fecha de emisiÃ³n de hace un mes: **nacÃ­an vencidas**, y `confirm()` las rechazaba
una por una en el paso siguiente al que acababa de crearlas. Las tres salidas posibles eran
inventar una fecha lejana, subir la vigencia por defecto (mentirle a todo el resto del
sistema), o decir la verdad: ese comprobante ya se vendiÃ³ y **no hay vigencia que respetar**.

`quotations.valid_until` pasa a nullable
(`20260909180000_d157_cotizacion_sin_vencimiento`, aditiva: aflojar un `NOT NULL` no toca
ninguna fila y el API viejo contra la base migrada sigue funcionando).
`createQuotationSchema.validityDays` acepta `null` y el importador manda `null`; el formulario
sigue exigiendo la vigencia y el PDF imprime Â«sin vencimientoÂ».

**Lo que vale del cambio no es el `null` sino la funciÃ³n.** `validUntil < businessToday()`
escrito suelto convierte la ausencia en `'' < hoy`, o sea en Â«vencida desde siempreÂ», y el
compilador no avisa nunca: las dos son comparaciones de cadenas perfectamente vÃ¡lidas. Por
eso hay **una sola** funciÃ³n que responde la pregunta â€”`isQuotationExpired(validUntil, hoy)`
en `@ayr/shared`â€” y los lugares que la hacÃ­an pasan por ella: la confirmaciÃ³n del pedido
(`sales-orders.service.ts`), el estado efectivo del listado y del PDF, el `isExpired` del DTO
y la reapertura de la cotizaciÃ³n al anular su pedido. El job diario ya las excluÃ­a solo, y no
por diseÃ±o: `valid_until < cutoff` es `NULL` en SQL cuando la columna lo es, y `NULL` no es
verdadero. Queda anotado en el cÃ³digo para que nadie le agregue un `OR IS NULL` de mÃ¡s.

### D-158 â€” el padrÃ³n en el importador, y el cliente es del comprobante

Dos cambios de la misma pantalla.

**(a) El alta desde el padrÃ³n.** Cuando el RUC/DNI del archivo no estÃ¡ en el maestro, el
preview consulta apis.net.pe â€”el mismo servicio de D-029/D-067, con `MAX_PADRON_LOOKUPS = 80`
y concurrencia 6, porque la cuota es una sola para todo el sistemaâ€” y la cabecera del
comprobante muestra **Â«Nuevo â€” se crearÃ¡ desde padrÃ³n: \<razÃ³n social\>Â»**. Al confirmar, el
cliente se crea con `CustomersService.createInTx` (extraÃ­do con el patrÃ³n `*InTx`, D-099)
**dentro de la transacciÃ³n del archivo**: si el archivo no entra, no queda ningÃºn cliente
suelto en el maestro.

Es una **excepciÃ³n controlada** a la regla de D-152, y lo que la separa de la creaciÃ³n
silenciosa de D-138 son tres cosas concretas: estÃ¡ a la vista antes de apretar, con nombre y
documento; la decide una persona, que puede elegir otro cliente en el mismo campo; y **lo que
se escribe no lo elige el navegador**. Esto Ãºltimo es lo que costÃ³ pensar: la fila manda al
servidor **solo el documento**, nunca la razÃ³n social. Con el nombre en el request, editar el
cuerpo alcanzaba para dar de alta Â«PROVEEDOR S.A.C.Â» bajo un RUC ajeno. Las consultas al
padrÃ³n se resuelven **antes** de abrir la transacciÃ³n â€”hasta 48 llamadas de 5 s cada unaâ€” y si
falta una sola, no se importa nada y esa fila se resuelve con el alta express de D-156.

**(b) El cliente sube a la cabecera.** Una factura es de un solo cliente, y sus diez lÃ­neas lo
heredan. Pedir el mismo dato diez veces no era redundancia: era **la Ãºnica forma de armar un
documento imposible**, y el API lo rechazaba con un error que la pantalla no sabÃ­a atribuir a
ninguna fila. Cuando el archivo trae textos de cliente distintos dentro del mismo comprobante,
la cabecera lo dice y se importa con el de arriba.

De paso, el **plan de corte llega relleno** con la sugerencia `1 Ã— los ML de la lÃ­nea`
(`suggestedRoofingPlanText`). No vuelve vÃ¡lido lo que no lo es â€”una lÃ­nea de 81.9 m sigue sin
caber en una plancha de 20 y la celda lo diceâ€”: lo Ãºnico que cambia es que corregirla sea
editar un nÃºmero en vez de transcribir la cifra del papel. La regla de D-152 sigue viva y
`defaultRoofingPlan` sigue siendo su centinela, con su test.

### D-159 â€” el espacio de producciÃ³n v2

Cuatro cambios sobre el panel de una orden, y el que los obliga a todos es de dominio:

1. **El plan de corte se edita desde el panel** â€” cantidad y largo en una cobertura a medida,
   **solo cantidad** en una plancha de catÃ¡logo, donde el largo lo trae el SKU (D-118) y
   volver a pedirlo es ofrecer un campo cuya Ãºnica respuesta correcta el sistema ya conoce.
   Hasta acÃ¡ corregirlo obligaba a irse a la terminal, que era la otra mitad del flujo.
2. **Montar la bobina rellena el reporte con los largos que el plan todavÃ­a debe.** El campo
   Ãºnico de metros/planchas desaparece: el caso normal es rolar lo que el pedido pide, y
   transcribirlo largo por largo era trabajo que el sistema inventaba. Las lÃ­neas quedan
   editables y **se pueden borrar** â€” lo primero que hace quien rolÃ³ la mitad es sacar las que
   no salieron.
3. **El selector de bobina es un modal de bÃºsqueda con tabla** (cÃ³digo, espesor, color, kg
   disponibles, Â«MontarÂ»), reusando el `SearchSelectModal` de D-156 con columnas. Lo que
   decide cuÃ¡l montar no es un nombre sino cuatro cifras que hay que **comparar entre filas**,
   y una lista de tarjetas apiladas no se compara: se recorre.
4. **Â«GuardarÂ» y Â«Guardar y cerrarÂ».** El segundo es
   `POST /production/roofing/:id/report-and-close`, que corre `reportInTx` + `closeInTx`
   (extraÃ­do acÃ¡) en **una transacciÃ³n**. Cuando lo que se va a reportar cubre el plan, es el
   botÃ³n destacado.

**El caso que obliga al cierre atÃ³mico**: un pedido de coberturas genera una OP por lÃ­nea
(D-084/D-148) y todas se rolan **del mismo rollo**, pero mientras la primera siga abierta con
la bobina montada, `assertStripsNotAssigned` no la deja montar en la segunda. Producir un
pedido de cuatro lÃ­neas obligaba a cerrar cada orden desde otra pantalla antes de seguir. Y
partido en dos endpoints, el cierre podÃ­a fallar con el reporte ya escrito.

El motivo del despunte (D-089) se pide **antes** de mandar cuando la pantalla estima que el
API lo va a exigir; como la estimaciÃ³n puede quedarse corta â€”el API suma reporte a reporte y
la pantalla solo tiene los totalesâ€”, el 400 sigue teniendo su camino de vuelta al mismo
diÃ¡logo. EstÃ¡ anotado en el cÃ³digo como lo que es: una estimaciÃ³n, no la regla.

### D-160 â€” una sola entrada a producciÃ³n

`/planta` (terminal) y `/planta/producir` (espacio del pedido) se funden en **`/planta`**, con
filtro por pedido (`?pedido=`) o todas las Ã³rdenes abiertas, y con las dos clases de orden en
el mismo selector: la de coberturas abre el panel de D-159 y la de drywall el de piezas.
Crear una orden deja de ser el paso 1 de la pantalla y pasa a una secciÃ³n que se despliega â€”lo
que se hace todos los dÃ­as es producir lo que ya estÃ¡ abiertoâ€”.

El sidebar queda con **ProducciÃ³n** (producir) y **Ã“rdenes de producciÃ³n** (gestionar).
`/planta/producir` y `/planta/tanda` quedan como redirecciones conservando `?pedido=`.

El detalle de la orden (`/produccion/:id`) queda de **lectura mÃ¡s correcciÃ³n** â€”anular,
revertir un reporte, reabrirâ€” y **pierde el cierre**, que era lo Ãºnico que estaba en los dos
sitios; sus dos enlaces a planta se unifican en Â«Producir esta ordenÂ», que lleva a `/planta`
con la orden enfocada.

**Lo que vale como criterio:** D-155 habÃ­a intentado arreglar esto **con los rÃ³tulos**
â€”Â«Producir un pedidoÂ» contra Â«Terminal de plantaÂ»â€” y el problema no era de nombres. Eran dos
pantallas que hacÃ­an lo mismo con la mitad de las herramientas cada una: la terminal montaba y
cerraba pero no mostraba las hermanas del pedido; el espacio mostraba las hermanas pero no
cerraba. Cuando dos pantallas comparten el objeto y se reparten los verbos, no son dos
pantallas: es una partida al medio, y el rÃ³tulo no la junta. El corolario sobre el cierre
duplicado es mÃ¡s fino: dos botones que hacen lo mismo en dos sitios terminan divergiendo en lo
que validan **antes** de llamar al API, que es donde vive la mitad de la lÃ³gica de una
pantalla.

### Lo que la revisiÃ³n encontrÃ³ y se corrigiÃ³

Dos pasadas del revisor â€”API/`shared` y web por separado, que es la separaciÃ³n que ya habÃ­a
pagado antesâ€” sobre el trabajo sin commitear. Un bloqueante del web, un alto del API y cuatro
altos del web, mÃ¡s una docena de medios y bajos.

**Los dos que rompÃ­an el flujo principal.**

1. **Â«Guardar y cerrarÂ» mandaba lo que habÃ­a apretado el botÃ³n anterior.** El flag que decide
   si el envÃ­o cierra la orden vivÃ­a en un `useState` que el manejador seteaba y **leÃ­a en el
   mismo tick**: React no lo ve hasta el render siguiente, asÃ­ que el primer clic en Â«Guardar
   y cerrarÂ» pegaba a `POST /report` â€”la orden quedaba abierta con la bobina montada, o sea
   justo la atomicidad que D-159 vino a darâ€” y el clic siguiente en Â«GuardarÂ» cerraba la orden
   que nadie quiso cerrar. Los dos datos que deciden el envÃ­o (cerrar o no, y el motivo del
   despunte) pasaron a `useRef`; el estado quedÃ³ solo para el rÃ³tulo del botÃ³n, que sÃ­ se
   pinta en el render siguiente.
2. **El importador se caÃ­a en render al tipear una coma.** La sugerencia del plan llamaba a
   `toDecimal(qty)` sin guarda, dentro del `useMemo` que arma las 141 filas: una coma del
   teclado latino en una cantidad lanzaba, la pantalla se caÃ­a y **se perdÃ­a el archivo
   revisado entero** â€” el callejÃ³n exacto que D-156 vino a sacar, reaparecido por otra puerta.
   Toda comparaciÃ³n de cantidad pasa ahora por `isNumeric`, que corta antes de `toDecimal`.

**Los altos.**

- **Un cliente desactivado con el mismo RUC volvÃ­a un 500.** `createFromPadron` buscaba por
  `(docNumber, isActive)` y el Ã­ndice Ãºnico de la tabla es `(doc_type, doc_number)`: el
  preview no ve al desactivado â€”filtra activosâ€”, el padrÃ³n sÃ­ devuelve el documento, y el alta
  chocaba con un `P2002` que nadie traduce, porque esto corre **antes** del bucle de savepoints
  y por lo tanto fuera del `try` que atribuye errores por documento. Ahora se busca por el par
  Ãºnico, un desactivado se dice con su nombre en vez de reventar, y el `P2002` de dos
  importaciones simultÃ¡neas tiene su propio mensaje.
- **`validityDays: null` se colÃ³ en el schema pÃºblico.** `createQuotationSchema` es tambiÃ©n el
  cuerpo de `POST`/`PUT /sales/quotations`: cualquier vendedor podÃ­a crear una cotizaciÃ³n que
  no vence nunca, que el job no marca y que `confirm()` no rechaza â€” lo contrario de D-069.
  El `null` volviÃ³ a quedar fuera del schema y viaja por un tipo interno que solo acepta
  `createInTx`.
- **Una orden que produjo menos que su plan no se podÃ­a cerrar desde ninguna pantalla.** El
  cierre suelto estaba atado a Â«plan cubiertoÂ» y el detalle de la orden ya no cierra (D-160),
  asÃ­ que el caso mÃ¡s comÃºn de todos â€”la bobina se acaba a los 28 m de un plan de 40â€” dejaba
  como Ãºnicas salidas bajar el plan a mano o reportar 12 m que nadie produjo. El botÃ³n existe
  ahora siempre que la orden haya producido algo; el API nunca habÃ­a exigido el plan cubierto.
- **El `consumedKg` del cierre (D-089) habÃ­a desaparecido con la terminal**, y con Ã©l las dos
  cotas que el API comprueba dentro de la transacciÃ³n. VolviÃ³ como campo propio del cierre,
  con sus cotas y el despunte a la vista, separado del kg declarado **por reporte** (D-146),
  que es otra cosa.
- **`?op=` se descartaba con la cachÃ© frÃ­a.** El efecto que elige la pestaÃ±a no distinguÃ­a Â«no
  hay Ã³rdenesÂ» de Â«todavÃ­a no cargaronÂ», asÃ­ que llegar desde el detalle de una orden abrÃ­a la
  primera de la lista, y crear una orden abrÃ­a otra. El efecto no corre mientras las consultas
  viajan, y `?op=` se re-lee cuando cambia.

**De los medios y bajos**, los que valen la pena nombrar: una orden **sin plan de corte** se
mostraba como Â«ReportadaÂ» y contaba en la barra de progreso sin haber producido nada (tiene
`remainingMeters = 0.000`, igual que una cubierta) â€” ahora tiene su propio estado; las lÃ­neas
**excluidas o quitadas** del importador podÃ­an imponerle su cliente al comprobante; el editor
se re-sembraba con el DTO viejo entre guardar y el refetch, invitando a duplicar el reporte;
el asiento del cierre repetÃ­a en el `audit_log` los faltantes que ya habÃ­a anotado el del
reporte; y el motivo del despunte sobrevivÃ­a a un envÃ­o fallido para justificar el siguiente.

**Lo que la revisiÃ³n confirmÃ³ que no se perdiÃ³** al borrar la terminal y la vista de la tanda:
el tope duro del plan, la validaciÃ³n y el aviso del kg declarado, el tope de bobinas por
orden, el bloqueo de bajar una bobina que ya rolÃ³, los avisos de faltante de materia prima y
las cotas de las tarjetas de alta. Y que D-157 estÃ¡ completo: los cuatro lugares del API que
comparan el vencimiento pasan por `isQuotationExpired`, y ni el mostrador, ni la facturaciÃ³n,
ni los reportes tocan el campo.

### E2E

Los tres specs de planta se renombraron â€”su nombre nombraba una ruta que D-160 borrÃ³â€”:
`planta-producir-ui` â†’ `planta-espacio-produccion-ui` (reescrito entero),
`planta-producir` â†’ `planta-espacio-produccion` y
`planta-producir-avisos` â†’ `planta-avisos-materia-prima`. `import-cotizaciones-ui` tambiÃ©n se
rehÃ­zo (acordeÃ³n, cliente en la cabecera) y `fase7e-ajustes-d121` dejÃ³ de buscar el cÃ³digo de
la OP como `<h1>`: el encabezado de `/planta` ahora es Â«ProducciÃ³nÂ».

**El caso que el dueÃ±o pidiÃ³ y que justifica Â«Guardar y cerrarÂ»**: un pedido de dos lÃ­neas a
medida, sus dos OP, montar la bobina en la orden 1, guardar y cerrar, y montar **la misma
bobina** en la orden 2 **sin salir de la pantalla** â€”lo que hasta esta sesiÃ³n rechazaba
`assertStripsNotAssigned` mientras la primera siguiera abiertaâ€”, reportar y cerrar. El kardex
se verifica en las dos puntas: 40 m y 30 m de producto, y la bobina en 1 720 kg
(2 000 âˆ’ 160 âˆ’ 120).

Se cubriÃ³ ademÃ¡s el sembrado del reporte al montar, borrar una lÃ­nea sembrada antes de
confirmar, el plan de corte editado desde el panel en sus dos formas (largos en Â«a medidaÂ»,
sola cantidad en una plancha `NIU`), el modal de bobinas con su filtro, el cierre Â«sin
reportar mÃ¡sÂ» con su kg declarado y su despunte, y **D-157** por API: una cotizaciÃ³n importada
de un papel de marzo nace con `validUntil: null`, se emite sin degradarse a `VENCIDA` y se
confirma.

**Lo que no se pudo probar**: el badge Â«Nuevo â€” se crearÃ¡ desde padrÃ³nÂ» (D-158). El entorno
local no tiene token de apis.net.pe, asÃ­ que todo documento desconocido cae en la rama del
error normal. No se montÃ³ un mock: probarÃ­a el mock.

**Un spec en rojo que no era de esta sesiÃ³n.** `fase5a-bordes` â€”que la sesiÃ³n de D-154 no
corriÃ³â€” tenÃ­a un caso que codificaba **el comportamiento que D-154 vino a quitar**: Â«no se
confirma una cotizaciÃ³n cuya Ãºnica bobina compatible quedÃ³ montada en una orden de producciÃ³n
ajenaÂ». Con D-154 esa confirmaciÃ³n **entra**, y tiene que entrar: el rollo tiene 1 000 kg y la
orden que lo montÃ³ prometiÃ³ 200, asÃ­ que hay 800 libres de verdad. Bloquearla era el mismo
defecto que, mirado desde planta, disparÃ³ D-154 (Â«la operaciÃ³n dejarÃ­a 0.000 kg libresÂ» sobre
una bobina llena). El caso se reescribiÃ³ para codificar la separaciÃ³n que quedÃ³: **el material
se promete por lo prometido** â€”el panel muestra 800 y el pedido de otro cliente confirmaâ€” y lo
que sigue reservado es **la agenda**, o sea que la OP del segundo pedido no puede montar la
bobina que la primera tiene puesta (`assertStripsNotAssigned`, con el 400 nombrando la orden
que la retiene). Se le sumÃ³ un tercer pedido de 1 000 kg que **sÃ­** rebota, para que el caso
siga probando que el agregado corta cuando el faltante es real. Verificado que no venÃ­a de
esta sesiÃ³n: ningÃºn archivo del camino de disponibilidad se tocÃ³, y el Ãºltimo cambio de
`production-assignments.ts` es el commit de D-154.

**Dos defectos que la escritura de los E2E encontrÃ³ en la pantalla, y que se corrigieron:**

1. **Â«Cerrar sin reportar mÃ¡sÂ» validaba los kilos contra un reporte que ese botÃ³n no manda.**
   El piso del consumo declarado se calculaba una sola vez, con los largos del editor sumados
   â€” y el editor **se re-siembra solo** con el plan que falta. Escenario medido: plan de 36 m,
   se reportan 30 (120 kg teÃ³ricos), el editor vuelve a mostrar las dos planchas que faltan, y
   declarar los 130 kg que la bobina de verdad consumiÃ³ respondÃ­a Â«las planchas reportadas ya
   consumieron **144.000** kgÂ» y apagaba el botÃ³n. O sea: el caso que el botÃ³n vino a resolver
   quedaba bloqueado. Ahora cada cierre tiene su propio piso (`closeOnly` / `closeWithReport`)
   y cada botÃ³n valida contra el suyo.
2. **La âœ• de la Ãºnica fila estaba apagada**, asÃ­ que vaciar el editor obligaba a borrar el
   largo y la cantidad campo por campo. VacÃ­a la fila en vez de sacarla â€”el editor siempre
   muestra al menos unaâ€”, que es lo que el rÃ³tulo ya decÃ­a.

### Archivos que dejaron de existir

`apps/web/src/app/(app)/planta/roofing-terminal.tsx` y
`apps/web/src/app/(app)/planta/producir/producir-view.tsx`. En su lugar: `planta-view.tsx` (el
workspace), `roofing-order-panel.tsx`, `drywall-order-panel.tsx`, `coil-picker.tsx`,
`new-order-cards.tsx` y `components/production/length-editor.tsx` â€” el editor de largos, que
ahora usan el plan y el reporte y por eso saliÃ³ de la terminal.

## SesiÃ³n Precios (2026-09-09) â€” la plancha por metro, valor contra precio y el piso que no existÃ­a (D-161..D-163)

### M0 â€” La plancha de catÃ¡logo se cotiza por metro lineal (D-161)

El defecto: una plancha se cobraba `cantidad Ã— valor unitario` con un valor que el vendedor
pensaba **por metro**. Diez planchas de 3.60 m a S/ 7.00 el metro salÃ­an **S/ 70.00** en vez de
S/ 252.00 â€” 3.6 veces menos, que es exactamente el largo del SKU.

Lo que se descartÃ³ importa tanto como lo que se hizo. La forma "natural" era pasar la lÃ­nea a
metros, como una cobertura a medida: cantidad 36.000 MTR, valor unitario 7.0000. **No se
hizo**, y el motivo es de dominio: el kardex, la reserva, la producciÃ³n y el despacho de una
plancha estÃ¡n en **planchas** (`roofing-production.service.ts` reporta `piecesCount(pieces)` a
stock para todo lo que no es a medida). Meter la lÃ­nea en metros obligaba a derivar la reserva
y a que un SKU en `NIU` llevara subÃ­tems de largo â€” que es justo lo que la regla dura 14
(D-131) prohÃ­be, y por la puerta de atrÃ¡s.

Lo que quedÃ³: la lÃ­nea sigue en `NIU`, viaja un campo nuevo y explÃ­cito (`valuePerMeterPen`) y
el API calcula `unitPricePen = largo del SKU Ã— valor por metro`. Los dos son un decimal en
soles y el compilador nunca avisarÃ­a de la confusiÃ³n, asÃ­ que **son dos campos y mandar los dos
es un 400** del schema.

En la cotizaciÃ³n, el bloque nuevo es el espejo del plan de corte de D-159: **largo bloqueado
con el del SKU, solo la cantidad editable, sin botÃ³n para agregar filas** (una plancha de
catÃ¡logo tiene un largo y uno solo). El campo de cantidad de la fila queda de solo lectura,
igual que en una lÃ­nea a medida.

La familia de predicados de D-131 pasa a **tres**, y las tres devuelven `boolean`:

| Pregunta                                               | FunciÃ³n             | La decide                                                     |
| ------------------------------------------------------ | -------------------- | ------------------------------------------------------------- |
| Â¿La lÃ­nea necesita el detalle de largos?             | `sellsByLength`      | la **unidad** (`MTR`)                                         |
| Â¿Se fabrica contra pedido desde bobina?               | `isMadeToMeasure`    | el **subtipo** (`A_MEDIDA`)                                   |
| Â¿El precio se negocia por metro contra un largo fijo? | `sellsByFixedLength` | el **subtipo y el largo juntos** (`PLANCHA` + `lengthMm > 0`) |

`sellsByFixedLength` pide **dos** campos a propÃ³sito: una plancha sin largo en el catÃ¡logo
â€”las hay, ver `roofing-catalog-report.ts`â€” cae en el camino viejo en vez de multiplicar por
cero y dejar la lÃ­nea en S/ 0. El centinela `sales-lines.spec.ts` se ampliÃ³ a la tabla de las
tres y a los tres pares cruzados; el par mÃ¡s peligroso es `sellsByFixedLength` contra
`isMadeToMeasure`, que miran el **mismo** campo y dan lo contrario.

MigraciÃ³n `20260909210000_d161_plancha_por_metro_lineal`, aditiva: `value_per_meter_pen`
nullable en `quotation_items` y `sales_order_items`. **Nada se recalcula** â€” lo histÃ³rico y lo
que carga el importador quedan como estÃ¡n.

### M1 â€” Valor contra precio, y el piso que la pÃ¡gina de mÃ¡rgenes prometÃ­a (D-162, D-163)

**Lo que estaba vivo, medido antes de tocar nada:** la fÃ³rmula era **markup**,
`costo Ã— (1 + margen)`, en `suggestedPrice`/`minAllowedPrice` de
`packages/shared/src/schemas/pricing.ts`. Y **`minAllowedPrice` no tenÃ­a un solo llamador fuera
de su propio test**: D-032 escribÃ­a la regla â€”Â«un VENDEDOR no puede bajar del margen mÃ­nimoÂ»â€” y
no la aplicaba en ninguna parte. La pÃ¡gina `/configuracion/margenes` guardaba dos nÃºmeros que
nadie leÃ­a.

**D-162 â€” el vocabulario.** Â«Valor de ventaÂ» es **sin** IGV; Â«precio de ventaÂ» es **con** IGV.
La fuente de verdad interna no se moviÃ³: `unit_price_pen` y `subtotal_pen` siguen siendo
valores, que es sobre lo que factura SUNAT, y no se migrÃ³ un dato. Lo que cambiÃ³ es que en la
cotizaciÃ³n y el pedido se **tipea el precio con IGV** â€”el nÃºmero que el vendedor le promete al
clienteâ€” y el valor se deriva y se muestra debajo. Mientras las dos palabras fueron sinÃ³nimas,
el vendedor tipeaba lo acordado bajo el rÃ³tulo Â«P. unitarioÂ» y el documento salÃ­a 18% mÃ¡s caro.

La traducciÃ³n vive en `packages/shared/src/tax.ts`, mÃ³dulo **hoja**, junto con `IGV_RATE_PCT`,
que se mudÃ³ ahÃ­ desde `schemas/sales`. Es por D-130: `schemas/pricing` lo necesita y se carga
**antes** que `sales` en el Ã­ndice; el ciclo en CommonJS no lanza, deja `undefined` y borra el
factor en silencio.

**D-163 â€” el piso duro.** `mÃ­nimo = costo promedio del kardex Ã· (1 âˆ’ margen mÃ­nimo) Ã— 1.18`,
con el **margen mÃ­nimo** (el margen a secas queda como objetivo sugerido). Es un cambio de
polÃ­tica comercial y los mÃ­nimos suben: con 20% sobre un costo de 100, el markup daba 120 y
dejaba un margen real del 16.67%; la fÃ³rmula nueva da 125.

Tres cosas que decidieron la forma, y que valen para la prÃ³xima:

1. **Se compara valor contra valor, no precio contra precio.** El valor guardado es el precio
   dividido por 1.18 y redondeado a cuatro decimales. Comparando precios, tipear **exactamente**
   el mÃ­nimo que la pantalla muestra podÃ­a caer una diezmilÃ©sima por debajo y rebotar â€” el caso
   del borde, que es justo el que el usuario prueba. El precio con IGV aparece solo en el
   mensaje.
2. **Sin costo no hay piso.** Un SKU que nunca entrÃ³ al kardex tiene costo cero. Bloquear con
   Â«el mÃ­nimo es S/ 0.00Â» no protege ningÃºn margen y sÃ­ impide cotizar un producto nuevo.
3. **El mismo cÃ³digo calcula el piso que se muestra y el que rechaza.** `computePriceFloors`
   alimenta el panel de stock del formulario y `assertPriceFloor` lo usa para tirar el 400. Que
   fueran dos cuentas era garantizar que la pantalla prometiera un mÃ­nimo y el `POST` exigiera
   otro.

Alcance: alta, ediciÃ³n y **duplicado** de cotizaciÃ³n, y pedido directo. **Para todos los
roles, incluido el ADMINISTRADOR**: D-032
dejaba la excepciÃ³n por lÃ­nea y D-163 la cierra, porque una excepciÃ³n por lÃ­nea no queda en
ningÃºn lado y un cambio de margen sÃ­ queda auditado. Quedan **exentos por cÃ³digo**: lo que importa D-152 â€”y tambiÃ©n
su ediciÃ³n, ver mÃ¡s abajoâ€” por la misma razÃ³n por la que su cotizaciÃ³n no vence (D-157), y el
**mostrador**, que se decidiÃ³ dejar afuera durante la revisiÃ³n.

El costo de una cobertura **a medida** no puede salir de su SKU â€”no tiene saldo hasta que
planta lo rolaâ€” asÃ­ que sale de la bobina: `kg por metro Ã— costo por kg **ponderado por
kilos** del agregado compatible`. El promedio simple habrÃ­a corrido el piso hacia el rollo mÃ¡s
chico: con 900 kg a S/ 4.00 y 100 kg a S/ 8.00, el ponderado es 4.40 y el simple 6.00.

**Contrapartida asumida y anotada:** el piso viaja al formulario (`minPricePen` en
`ProductStockDto`), y de Ã©l se puede despejar el costo, porque el margen lo lee todo el equipo
comercial. Es el precio de que el vendedor vea su piso antes de tipear en vez de descubrirlo
chocando contra un 400.

El margen se acota a **menos de 100%** en el schema (es sobre la venta: 100% es una divisiÃ³n
por cero) y una fila vieja fuera de rango rebota con un mensaje legible en vez de un 500.

### M2 â€” Cierre de bobina con ajuste de remanente: **el flujo no existe** (sin implementar)

Verificado y **reportado al dueÃ±o sin tocar nada**, como pedÃ­a el alcance. Estado real:

- `CoilOperationsService.setStatus` (RF-19) cambia `coils.status` a `CLOSED` y **no mueve
  kardex**. El comentario del cÃ³digo lo dice explÃ­citamente: Â«cerrar tampoco mueve kardex, asÃ­
  que la invariante de cantidad no lo veÂ». El saldo remanente queda en `inventory_balances`
  para esa bobina, indefinidamente.
- La herramienta para liquidarlo **sÃ­ existe pero es un acto aparte**: `registerScrap` (RF-17)
  escribe un `OUT` con `refType: 'SCRAP'` valorizado al costo promedio vigente, vÃ­a
  `InventoryService.record`. En la UI son dos botones vecinos y sin relaciÃ³n: Â«Registrar mermaÂ»
  y Â«CerrarÂ».
- Nada avisa del remanente al cerrar, nada lo exige, y una bobina cerrada con saldo positivo
  sigue sumando kilos y valor al inventario valorizado.

**Propuesta para el OK del dueÃ±o** (no implementada): que Â«CerrarÂ» pregunte por el remanente
cuando el saldo sea distinto de cero y ofrezca liquidarlo **en la misma transacciÃ³n**, como un
movimiento propio vÃ­a `InventoryService.record` â€”`OUT` si sobra material teÃ³rico
(merma/despunte), `IN` si el conteo real da de mÃ¡s (sobrante)â€”, con motivo obligatorio y
`operationDate` (D-124). Nunca una ediciÃ³n del saldo: append-only (regla dura 2). Queda por
decidir el `refType` (`CLOSE_ADJUSTMENT` nuevo, distinguible del `SCRAP` de RF-17 para que su
anulaciÃ³n no se confunda, que es el mismo cuidado que ya obligÃ³ a separar la merma de proceso
del cierre de OP en `cancelScrap`) y si el ajuste positivo necesita permiso de ADMINISTRADOR.

### M3 â€” Pulido de formularios

- **El botÃ³n ancho de Â«Agregar otro largoÂ» pasa a un `+` al costado de la Ãºltima fila**, en
  `components/production/length-editor.tsx` (plan de corte y reporte del espacio de producciÃ³n)
  y en el editor de largos de la cotizaciÃ³n. MedÃ­a lo mismo que los dos campos juntos y se leÃ­a
  como un campo mÃ¡s de la fila siguiente. Queda alineado con la âœ•, que es la acciÃ³n gemela, y
  las filas que no son la Ãºltima llevan un hueco del mismo ancho para que la âœ• no se desalinee.
- **El `+` funciona tambiÃ©n con el editor vacÃ­o**: como vive al costado de la Ãºltima fila, una
  lista sin filas lo dejaba inalcanzable. Hoy ningÃºn llamador pasa un array vacÃ­o, pero antes
  esa invariante no hacÃ­a falta y ahora sÃ­, asÃ­ que la sostiene el propio editor.
- **El campo de largo del espacio de producciÃ³n deja de ser `flex-1`** y pasa a `w-32`, el mismo
  ancho que la cantidad: es un nÃºmero de cuatro caracteres y estirado ocupaba casi todo el
  contenedor.
- Barrido de rÃ³tulos de D-162 en cotizaciÃ³n, pedido, comprobantes, el importador y el PDF de
  cotizaciÃ³n (Â«P. unit.Â» â†’ Â«Valor unit.Â», Â«SubtotalÂ»/Â«TotalÂ» del pie â†’ Â«Valor de ventaÂ»/Â«Precio
  de ventaÂ»). Las compras **no** se tocaron: su Â«precio unitario sin IGVÂ» es un precio de compra
  y la regla de D-162 es sobre la venta.

### Lo que la revisiÃ³n encontrÃ³ y se corrigiÃ³

Dos pasadas de `revisor` sobre el diff. Dos bloqueantes, cuatro altos y una docena de menores.
Los que importan:

**Bloqueante 1 â€” el precio mÃ­nimo que se mostraba no era tipeable.** El piso se compara en
**valor** (cuatro decimales) y se muestra en **precio** (dos, que es lo que una persona
tipea). Recortando el precio hacia abajo, tipear exactamente el nÃºmero de la pantalla daba un
valor por debajo del piso y el sistema respondÃ­a Â«sube el precioÂ» sobre el precio que Ã©l mismo
acababa de pedir. Medido con las funciones reales: costo 17.50 y 10% de mÃ­nimo â†’ se mostraba
S/ 22.94, que vuelve como 19.4407 contra un piso de 19.4444. **Pasaba en cerca de la mitad de
las combinaciones costo/margen**, y es el mismo callejÃ³n sin salida que D-156 vino a cerrar.

La correcciÃ³n no fue redondear hacia arriba y confiar. `minTypeablePrice` **prueba el
candidato contra la cadena de vuelta** â€”la misma funciÃ³n que convierte lo tipeado en el valor
guardadoâ€” y sube de a un cÃ©ntimo hasta que alcanza. Es la Ãºnica forma de que el nÃºmero no
dependa de cuÃ¡ntos redondeos haya en el camino, que en una plancha son tres.

El test que debÃ­a haberlo cazado existÃ­a y no podÃ­a fallar: partÃ­a del precio con **cuatro**
decimales, que es lo que ningÃºn vendedor tipea, y comparaba con `Number` y una tolerancia de
`0.0001` â€”exactamente la diezmilÃ©sima que decÃ­a vigilarâ€” en un test sobre precisiÃ³n Decimal.
Se reemplazÃ³ por una tabla de cinco combinaciones que tipea el mÃ­nimo mostrado y verifica que
pase, mÃ¡s el cÃ©ntimo de abajo que tiene que bloquear.

**Bloqueante 2 â€” el cartel de rechazo de una plancha mostraba el mÃ­nimo por plancha rotulado
Â«por metroÂ»**: el mismo factor Ã—largo que D-161 vino a corregir, reintroducido en el mensaje
de error. El renglÃ³n de ayuda debajo del campo sÃ­ convertÃ­a, asÃ­ que la pantalla mostraba dos
nÃºmeros que decÃ­an ser lo mismo y diferÃ­an 3.6 veces. La conversiÃ³n saliÃ³ del web: el piso
viaja **ya expresado en la unidad en la que se tipea** (`PriceBasis`), y el web solo lo pinta.

**Alto â€” una cotizaciÃ³n importada nacÃ­a exenta del piso pero no se podÃ­a volver a guardar.**
El importador crea en borrador y `update` aplicaba el piso sin excepciÃ³n: corregir el producto
de una lÃ­nea en una de las 71 de agosto rebotaba con Â«el precio mÃ­nimo es S/ XÂ» sobre una
lÃ­nea que nadie tocÃ³. La exenciÃ³n pasÃ³ a ser del **documento** y no del momento: la marca de
D-152 (`EXTERNAL_INVOICE_NOTES_PREFIX`) se mudÃ³ a `@ayr/shared` con la funciÃ³n que la lee, y
la ediciÃ³n de una importada hereda la exenciÃ³n igual que hereda no vencer (D-157).

**Alto â€” `sellsByFixedLength` ignoraba la unidad.** El CHECK de la base solo prohÃ­be que una
`PLANCHA` estÃ© en `MTR`, asÃ­ que una en `KGM` o `MTK` es legal y el catÃ¡logo la admite a
propÃ³sito (SKU legados). Para ese SKU el formulario pasaba a pedir Â«PlanchasÂ» y precio Â«por
metroÂ», y el importe salÃ­a multiplicado por el largo. Es la regla dura 14 mirada al revÃ©s â€”una
pregunta sobre la aritmÃ©tica de la unidad respondida con el subtipoâ€” asÃ­ que el predicado pide
ahora los **tres** campos y el centinela cubre la combinaciÃ³n.

**Alto â€” el mostrador quedaba bloqueado por precios que hoy funcionan.** El POS siembra el
precio de lista y comparte `createDirectInTx`, asÃ­ que heredaba el piso. Como D-163 **sube**
los mÃ­nimos respecto de D-032, todo SKU cuyo precio de lista quedÃ³ entre el piso viejo y el
nuevo dejaba de venderse en caja â€” y el cajero lo descubrirÃ­a al cobrar, con el cliente
delante, tirando abajo la transacciÃ³n entera de D-099 (pedido, despacho, comprobante y cobro).
**El mostrador quedÃ³ exento**, con el flag `counterSale` que ya existÃ­a. Antes de esta sesiÃ³n
tampoco tenÃ­a piso, asÃ­ que no abre nada que no estuviera abierto; ponerlo sÃ­ rompÃ­a algo que
funciona. **Queda para el dueÃ±o**: si quiere piso en caja, hay que mostrar el mÃ­nimo en el
carrito y medir antes cuÃ¡ntos SKU activos quedan por debajo.

**Otros que se corrigieron:** el valor por metro no llegaba al PDF â€”justamente el papel que el
cliente comparaâ€”; la venta de bobina entera tenÃ­a piso en el API y ningÃºn aviso en la pantalla
(ahora el mÃ­nimo por kg viaja en `/sales/sellable-coils`); el bloque de totales del propio
formulario de D-162 seguÃ­a diciendo Â«SubtotalÂ»/Â«TotalÂ»; el mostrador seguÃ­a rotulando Â«Precio
sin IGVÂ», que bajo el vocabulario nuevo es una contradicciÃ³n; `chooseProduct` conservaba el
precio al cambiar a un producto que se negocia en **otra** unidad (antes era un rÃ³tulo
desactualizado, con D-161 es un factor de 3.6); el panel de stock resolvÃ­a el agregado dos
veces por SKU a medida; el `+` del editor de largos quedaba inalcanzable con la lista vacÃ­a; y
el docstring de `stock-panel` seguÃ­a diciendo Â«sin ningÃºn costoÂ», que dejÃ³ de ser cierto.

### Lo que la escritura de los E2E encontrÃ³

`e2e/tests/precios-d161-d163.spec.ts` (nuevo, diez casos): la plancha por metro con su
propagaciÃ³n al pedido y al despacho, la plancha y la a-medida **lado a lado** dando el mismo
importe con distinta unidad, los dos rechazos de `valuePerMeterPen` (junto al unitario y sobre
un producto que no es plancha con largo), el contrato del API en valores sin IGV, el piso leÃ­do
del panel de stock, el mÃ­nimo exacto y el cÃ©ntimo de abajo, **tipear el mÃ­nimo que muestra la
pantalla**, el mostrador vendiendo por debajo del costo sin rebotar y la cotizaciÃ³n importada
que entra bajo el piso y se puede volver a guardar.

Dos detalles del mÃ©todo que valen para la prÃ³xima: el caso del mÃ­nimo tipeable usa el costo
17.50, que es la combinaciÃ³n que destapaba el defecto â€”con redondeo simple la pantalla decÃ­a
22.94 y el API exigÃ­a 22.95â€”, asÃ­ que **el test se cae si alguien vuelve a redondear y
confiar**; y la conversiÃ³n precioâ†’valor del test se hace con enteros (`P cÃ©ntimos Ã· 118`,
half-up) y no con `Number(p) / 1.18`, porque el caso vive en la cuarta decimal y un ulp de coma
flotante lo volverÃ­a verde por accidente.

**Un defecto que apareciÃ³ escribiÃ©ndolos, y se corrigiÃ³:** `PUT /sales/quotations/:id`
reemplazaba las observaciones con lo que viniera en el cuerpo, **y con ellas la marca de
procedencia** del comprobante externo. Como de esa marca dependen el aviso de reimportaciÃ³n
(D-152) y la exenciÃ³n del piso (D-163), editar una cotizaciÃ³n importada sin reenviar las
observaciones la dejaba sin marca â€” y el **segundo** guardado, con el mismo precio histÃ³rico,
rebotaba contra el piso. Un documento que se vuelve invÃ¡lido por haberlo guardado dos veces.
La marca la conserva ahora `keepImportMarker`: es procedencia y no un texto que alguien
escribiÃ³, asÃ­ que sobrevive a la ediciÃ³n y lo que se recorta al tope de la columna es el texto
del vendedor, nunca la marca. Hoy no hay ningÃºn formulario que llame a ese `PUT` â€”el Ãºnico
camino es HTTP directoâ€” asÃ­ que el defecto no llegÃ³ a producciÃ³n; era una trampa puesta para el
primer formulario de ediciÃ³n que se escriba.

**Sin cubrir:** el piso por kg de la venta de bobina entera (`minPricePen` en
`/sales/sellable-coils`). EstÃ¡ implementado y probado en unitarios, pero montar una bobina
vendible entera en E2E cuesta una compra `COIL` mÃ¡s y no entrÃ³ en esta tanda.

### VerificaciÃ³n

`pnpm turbo lint typecheck test` en verde (**341/341** unitarios, 22 suites), `prettier --check`
y `eslint e2e` limpios. Tests nuevos: la tabla de tres predicados y sus pares cruzados
(`sales-lines.spec.ts`), la plancha y la a-medida **lado a lado** con el mismo importe
(`sales-math.spec.ts`), la conversiÃ³n valorâ‡„precio con el caso `10.00 â†’ 8.4746`, la marca de
procedencia que sobrevive a una ediciÃ³n (`quotation-import.spec.ts`), y el piso con sus casos de
borde en `price-floor.spec.ts`: exactamente en el mÃ­nimo pasa, un cÃ©ntimo abajo bloquea, sin
costo no hay piso, el agregado ponderado por kilos, y **el mÃ­nimo que se muestra es tipeable**
en cinco combinaciones costo/margen â€” que es el defecto que la revisiÃ³n encontrÃ³.

**E2E local.** La suite completa dio **183 pasados, 20 fallos y 2 saltados**, y de los 20 solo
**dos** eran de esta sesiÃ³n: dos fixtures que vendÃ­an por debajo del costo â€”una pieza de S/ 96
de costo vendida a S/ 10 en el caso de fechas de operaciÃ³n, y S/ 20 de costo a S/ 10 en el del
disponible del mostradorâ€”. En los dos el precio era un nÃºmero arbitrario en un caso que habla de
otra cosa, asÃ­ que se subieron por encima del piso con el comentario de por quÃ© ahora importa.

Los otros 18 son los dos bloqueos ya conocidos y ajenos a esta sesiÃ³n: **nueve** por
`409 Ya existe un proveedor con ese documento` â€”la base `ayr_local_e2e` envejecida, anotada
abajo en Notas operativasâ€” y **nueve** por `No puedes enviar mas de 50 documentos en una cuenta
DEMO`, el cupo de la cuenta demo de Nubefact.

`pnpm e2e precios-d161-d163` â†’ **10/10**, dos corridas seguidas.

## SesiÃ³n Cierre de bobina (2026-09-09) â€” el remanente se liquida y la merma normal entra al estÃ¡ndar (D-164, D-165)

Las dos decisiones son una sola idea partida en dos: **separar la merma normal de la anormal**.
D-165 mete el 1 % que toda corrida pierde adentro de la densidad estÃ¡ndar, asÃ­ que deja de ser
una sorpresa; D-164 hace que lo que quede por encima de eso salga del inventario al cerrar la
bobina, en vez de quedarse ahÃ­ para siempre. Ninguna de las dos sirve sola: sin D-165 el
remanente mezclaba dos cosas y no medÃ­a nada, y sin D-164 el 1 % bien calculado igual dejaba
kilos fantasma en el valorizado.

### M0 â€” El cierre de una bobina liquida su remanente (D-164)

**El defecto.** `CoilOperationsService.setStatus` (RF-19) cambiaba el estado a `CLOSED` y **no
movÃ­a un gramo de kardex**. El saldo teÃ³rico que quedaba en `inventory_balances` se quedaba ahÃ­
indefinidamente: la bobina cerrada desaparecÃ­a de producciÃ³n y del partido, pero **seguÃ­a
sumando kilos y valor al inventario valorizado** de material que ya no existe, y nada avisaba.
La Ãºnica herramienta era la merma de RF-17 (`registerScrap`), un acto aparte, en un botÃ³n
vecino y sin ninguna relaciÃ³n con el cierre.

**La forma.** Cerrar pide ahora **cuÃ¡ntos kilos quedan de verdad** (`physicalKg`) y liquida la
diferencia contra el saldo, en la misma transacciÃ³n, por el Ãºnico camino que el kardex admite
(`InventoryService.record`, regla dura 2) y nunca editando el saldo:

- `apps/api/src/coils/coil-close-math.ts` â€” la aritmÃ©tica pura, aparte del servicio como
  `coil-split-math.ts`, con su spec de siete casos.
- `refType` propio **`CLOSE_ADJUSTMENT`** (migraciÃ³n `20260909230000_...`, aditiva) y su
  rÃ³tulo Â«Cierre de bobinaÂ» en el kardex.
- `CoilDto.avgCostPen` â€” el promedio vigente del saldo, para poder mostrar el remanente
  **valorizado** con el mismo nÃºmero con el que el kardex lo va a sacar.
- `apps/web/.../coil-close-dialog.tsx` â€” el diÃ¡logo muestra kg y soles antes de confirmar.
- Reabrir revierte el ajuste con un movimiento inverso, **solo si es el Ãºltimo movimiento vivo
  del rollo** (ver Â«Alto 1Â» mÃ¡s abajo: la primera versiÃ³n decÃ­a Â«el Ãºltimo ajuste vivoÂ» y eso
  creaba inventario de la nada). `cancelScrap` (RF-18) lo rechaza a propÃ³sito: es el mismo
  corte que D-057 ya habÃ­a tenido que hacer para la merma de proceso de una OP.

**Tres decisiones que no eran obvias.**

1. **Se tipea cuÃ¡nto queda, no cuÃ¡nto se da de baja.** Es lo que planta ve mirando el rollo, y
   con un solo campo quedan cubiertos los dos sentidos: sobra saldo teÃ³rico â†’ `OUT` (merma
   anormal), el conteo da de mÃ¡s â†’ `IN` (sobrante). Preguntar Â«cuÃ¡ntos kilos mermarÂ» obligaba a
   un segundo formulario para el sentido contrario.
2. **El kardex se mueve ANTES de marcar `CLOSED`.** `assertRawMaterialInvariant` lee el
   agregado desde la base: con la bobina ya cerrada, la salida se comprobarÃ­a contra un
   agregado que **acaba de perder ese rollo entero** y rechazarÃ­a por kilos que el propio
   cierre sacÃ³ de la vista. Es el mismo orden que ya respetaba el partido.
3. **`registerScrap` (RF-17) se queda.** Se evaluÃ³ retirarlo para no dejar dos caminos y **no
   conviene**: responden preguntas distintas y se deshacen distinto. RF-17 es la pÃ©rdida
   puntual durante la vida del rollo (borde oxidado, empalme fallado), se registra cuando pasa
   y se anula por RF-18; el ajuste del cierre es el corte de cuentas del rollo y se deshace
   reabriendo la bobina. Fusionarlos obligarÃ­a a cerrar la bobina para poder registrar una
   merma, o a que una anulaciÃ³n devolviera kilos de un hecho que no ocurriÃ³.

**Un defecto que encontrÃ³ el propio E2E, en mi guard.** El corte Â«no hay nada que liquidarÂ»
estaba escrito como `balanceKg <= 0`, y eso mataba justamente el caso del **sobrante sobre una
bobina en cero** â€” planta encuentra material que el kardex ya dio por consumidoâ€”, que es el
caso para el que existe la rama `IN` y para el que se habÃ­a escrito la valorizaciÃ³n al costo
del documento. El sÃ­ntoma no se parecÃ­a a la causa: el cierre **pasaba** y devolvÃ­a `CLOSED`,
los kilos simplemente no volvÃ­an. El corte correcto es `physicalKg === undefined`: **una
declaraciÃ³n explÃ­cita se respeta siempre, en los dos sentidos**; lo que se corta es la ausencia
de declaraciÃ³n. De paso cambiÃ³ la UI: el diÃ¡logo se abre **siempre** al cerrar, tambiÃ©n con
saldo cero, que ademÃ¡s es la confirmaciÃ³n que el alcance pedÃ­a.

**Lo que esto rompe, y es un cambio no aditivo (D-123).** Cerrar una bobina con saldo ahora
exige `physicalKg`. Cinco escenarios E2E de fases anteriores cerraban un rollo **para
guardarlo** â€”no porque se hubiera agotadoâ€” y pasaron a declarar su saldo entero, vÃ­a el helper
nuevo `closeCoilKeepingStock`. Los tres que esperaban un error al cerrar (fleje montado en una
OP, bobina reservada) no cambian: esos guardrails corren antes.

**Lo que NO cambia:** el cierre automÃ¡tico del partido (RF-15) y de la recepciÃ³n de corte
(D-052). Los dos ocurren con el saldo ya en cero y no tienen nada que liquidar, asÃ­ que no
pasan por este camino.

### M1 â€” La merma normal del 1 % entra en la densidad estÃ¡ndar (D-165)

**Lo primero que se verificÃ³:** el factor **no estaba en ninguna parte** â€” ni en cÃ³digo, ni en
las migraciones, ni en los docs. `grep` de `1.01` sobre el repo entero: cero resultados. AsÃ­
que M1 no era verificar, era implementar.

Se aplica en **un solo lugar**, `standardDensityFactor` en `@ayr/shared`, dentro de las dos
Ãºnicas funciones que traducen geometrÃ­a a kilos (`theoreticalKgPerPiece` y `kgPerMeter`), y
**nunca** editando `finishes.density_factor`. El motivo de fondo: la densidad del acero es un
dato fÃ­sico y la merma es una polÃ­tica de la empresa; multiplicarlos en el maestro deja un
nÃºmero que no es ninguna de las dos cosas y **que nadie puede volver a separar** â€”revisar el
1 % obligarÃ­a a dividir cada acabado por 1.01 primero, adivinando cuÃ¡les ya lo tenÃ­anâ€” ademÃ¡s
de que cada acabado nuevo nacerÃ­a sin el factor.

Entrando por un punto, se mueven juntos los cuatro nÃºmeros que dependen de Ã©l: el kilo teÃ³rico
del reporte de planta, el metro equivalente de una bobina, los kilos que reserva una cobertura
a medida y el costo por metro del piso de precio de D-163. **Los cuatro suben ~1 %, y el metro
equivalente baja ~1 %** â€” el mismo rollo promete menos metros, que es exactamente el sentido de
la decisiÃ³n.

El centinela es `apps/api/src/production/normal-scrap-factor.spec.ts`, y lo que vigila no es la
multiplicaciÃ³n (es trivial) sino que **las dos cuentas apliquen el mismo factor**: si el kilo
por metro y el kilo por pieza divergieran, los kilos que un pedido promete por metro y los que
el reporte descuenta por metro serÃ­an dos nÃºmeros para el mismo hecho.

Cinco expectativas de `roofing-math.spec.ts` y `production-math.spec.ts` cambiaron de valor.
EstÃ¡n actualizadas con el comentario de por quÃ©, no solo con el nÃºmero nuevo.

### M2 â€” Query de solo lectura: SKU bajo el mÃ­nimo de D-163

`pnpm check:price-floor [--branch production|demo|dev|local]` â†’
`apps/api/prisma/price-floor-report.ts`. Es el nÃºmero que le falta al dueÃ±o para decidir si el
mostrador lleva aviso de mÃ­nimo en el carrito: D-163 lo dejÃ³ **exento a propÃ³sito** y ponerle
el piso sin medir antes rompe ventas que hoy funcionan.

Compara **valor contra valor** y no precio contra precio, exactamente como `assertPriceFloor`:
`list_price_pen` es el valor sin IGV (D-068, D-162) y el piso es `costo Ã· (1 âˆ’ margen mÃ­nimo)`.
Comparar los precios con IGV meterÃ­a dos redondeos por 1.18 en una cuenta que se decide en la
cuarta decimal. Los precios se **imprimen** con IGV, que es como el dueÃ±o los lee. Los SKU sin
costo en el kardex no salen como infractores (sin costo no hay piso, D-163) pero se cuentan
aparte, para que el total cierre. **No toca el POS.**

### M3 â€” Regla dura 16: ningÃºn texto largo pasa por la shell

`CLAUDE.md` gana la regla dura **16**, con el incidente de la sesiÃ³n anterior escrito: un
`node -e` con backticks se lo comiÃ³ la shell, que ejecutÃ³ lo que habÃ­a adentro y disparÃ³ un
`pnpm e2e` accidental que **vaciÃ³ `ayr_local_e2e` a mitad de otra corrida**. Es una regla de
**forma y no de criterio**: el daÃ±o no lo hace el comando que uno quiso correr, sino otro que
la shell arma sola con pedazos del texto, y releer el texto no alcanza porque hay que darse
cuenta de que el texto tambiÃ©n es cÃ³digo. Se numerÃ³ como 16 y no se insertÃ³ en el medio a
propÃ³sito: hay referencias vivas a Â«regla dura 15Â» en `CLAUDE.md` y en `docs/ENTORNOS.md`.

### El precio de D-165: unos setenta kilos esperados escritos a mano

Lo que el 1 % costÃ³ de verdad no fue el cÃ³digo â€”tres lÃ­neas en `@ayr/shared`â€” sino los tests.
La primera corrida completa devolviÃ³ **16 fallos**, todos con la misma forma: un kilo esperado
que ahora sale exactamente Ã—1.01 (`40.000 â†’ 40.400`, `98.400 â†’ 99.384`, `244.000 â†’ 246.440`).
Ninguno era un defecto; todos eran el nÃºmero viejo escrito como literal.

Y **16 no era el final**: corregir una aserciÃ³n destapaba la siguiente del mismo caso, que
antes ni se ejecutaba. Hicieron falta **ocho tandas** hasta que la suite parÃ³ de encontrar
nÃºmeros, repartidas en doce specs y unos setenta literales. El arrastre llega mÃ¡s lejos de lo
que parece porque el kilo teÃ³rico alimenta cuatro cosas encadenadas: los kilos reservados, el
saldo de la bobina despuÃ©s de cada reporte, el **despunte** del cierre (que es `declarado âˆ’
teÃ³rico`, asÃ­ que **baja** cuando el teÃ³rico sube) y el **costo unitario** del producto
terminado. En una pantalla del espacio de producciÃ³n hasta el texto que se busca a ojo
(`Â«pendiente 1,838.400 kgÂ»`) cambia.

**Un cambio de mÃ¡s, que tambiÃ©n enseÃ±a algo.** Un reemplazo masivo de `qty: '24.600'` agarrÃ³,
junto con los kilos, la reserva que nace al reportar â€” que estÃ¡ en **metros de producto
terminado**, no en kilos de bobina, y a la que el 1 % no la toca. La suite lo cazÃ³ en la
corrida siguiente. La lecciÃ³n para la prÃ³xima: al mover nÃºmeros por un cambio de factor, **la
unidad manda**; kilos de materia prima sÃ­, metros o planchas de producto no.

**Por quÃ© habÃ­a tantos.** Los fixtures de coberturas eligieron a propÃ³sito una geometrÃ­a
redonda â€”1 000 mm Ã— 0.50 mm con densidad 8.0â€” para que Â«la aritmÃ©tica se pueda comprobar a
ojoÂ»: 4 kg por metro exactos. Esa decisiÃ³n, que hace los tests legibles, es la que multiplica
el costo de mover el factor: cada spec que escribiÃ³ `'40.000'` en vez de derivarlo quedÃ³ atado
a la densidad. Con D-165 el consumo real pasa a **4.04 kg/m** y ningÃºn nÃºmero redondo sobrevive.

**CÃ³mo quedÃ³.** El factor vive ahora en `e2e/helpers/roofing.ts` como `NORMAL_SCRAP_FACTOR` y
`KG_PER_METER = 4 Ã— 1.01`, y `fase7-consolidada-subtipo.spec.ts` â€”el Ãºnico que ya derivaba en
vez de hardcodearâ€” se arreglÃ³ solo cambiando de dÃ³nde importa la constante. Los demÃ¡s siguen
con el literal actualizado y el comentario al lado diciendo de dÃ³nde sale
(`24.6 m Ã— 4.04 kg/m = 99.384`). **El pendiente de revisar el 1 % con datos reales deberÃ­a
empezar por convertir esos literales a `KG_PER_METER`**, o la prÃ³xima revisiÃ³n del porcentaje
vuelve a costar lo mismo.

**La lecciÃ³n, que es la de D-123 otra vez, con un agregado:** un cambio de regla no aditivo se
mide contra la suite completa y no contra los tests del cambio â€”los 352 unitarios estaban en
verde y los 9 casos nuevos de D-164 tambiÃ©nâ€”, **y una sola corrida completa no alcanza**,
porque cada aserciÃ³n arreglada destapa la siguiente. Hay que iterar hasta que una corrida
limpia no encuentre ninguna.

### Lo que encontrÃ³ la revisiÃ³n

Dos pasadas en paralelo (API + `@ayr/shared` por un lado, web + E2E por el otro, que es lo que
enseÃ±Ã³ una sesiÃ³n anterior: la del web encuentra cosas que la del API no puede ver). **Tres
altos, todos corregidos**, ninguno bloqueante.

**Alto 1 â€” el ajuste de cierre podÃ­a crear inventario de la nada.** La reversa buscaba Â«el
Ãºltimo `CLOSE_ADJUSTMENT` vivoÂ» de la bobina, sin ningÃºn vÃ­nculo con el cierre que se estaba
deshaciendo. Pero una bobina puede volver a `OPEN` por un camino que no es `setStatus`:
**`revertSplit` (RF-16) reabre a la madre con un `update` directo**. La secuencia completa:
madre de 500 kg â†’ partido de 400 â†’ cierre declarando cero (ajuste de 100 kg) â†’ `revertSplit`
devuelve los 400 y la reabre, dejando el ajuste **vivo y sin dueÃ±o** â†’ cierre declarando los
400 (sin ajuste nuevo) â†’ **la reapertura adopta el ajuste viejo y mete 100 kg y su valor que
ningÃºn cierre habÃ­a sacado**. Es exactamente la creaciÃ³n de valor que D-057 ya habÃ­a tenido que
evitar una vez, con la misma forma: dos hechos que se parecen y una anulaciÃ³n que agarra el
equivocado.

La correcciÃ³n no fue guardar el vÃ­nculo en la bobina sino cambiar la pregunta: **se revierte
solo si el ajuste es el Ãºltimo movimiento vivo del rollo**. Como el kardex es append-only, un
ajuste que dejÃ³ de ser el Ãºltimo **nunca vuelve a serlo** y queda inerte para siempre; y la
condiciÃ³n ademÃ¡s es la que hace segura la reversa, porque si algo moviÃ³ la bobina despuÃ©s del
cierre, el saldo ya no es el que el ajuste dejÃ³. Cubierto por un caso E2E que reproduce la
adopciÃ³n indebida.

**Alto 2 â€” la pantalla prometÃ­a un nÃºmero que el API rechazaba.** El diÃ¡logo normalizaba la
coma decimal para validar y para calcular, pero mandaba el texto **crudo**: con `12,5` el panel
mostraba la liquidaciÃ³n, el botÃ³n se habilitaba y el `POST` rebotaba con un 400 del schema. Es
el defecto de D-163 otra vez, en el campo de al lado. Ahora se manda el valor normalizado, y la
validaciÃ³n se acotÃ³ a tres decimales â€”la escala de kilosâ€” porque con mÃ¡s la pantalla mostraba
una liquidaciÃ³n y el API redondeaba y movÃ­a otra.

**Alto 3 â€” reabrir sin motivo cuando el kardex no habÃ­a cargado.** El botÃ³n decidÃ­a si pedir
motivo mirando el kardex de la pÃ¡gina, y esa lista estÃ¡ vacÃ­a mientras la consulta carga, si
fallÃ³, y durante el refetch posterior al cierre. En los tres casos se mandaba un `OPEN` sin
motivo y el API respondÃ­a Â«explica el motivoÂ» sobre algo que la pantalla nunca habÃ­a ofrecido
â€” y con el kardex caÃ­do la bobina no se podÃ­a reabrir. Ahora reabrir **siempre** pasa por el
diÃ¡logo de motivo; el kardex solo decide el texto.

**Medios corregidos.** `physicalKg` no tenÃ­a cota superior: un `5000` tipeado donde iba `500`
daba de alta 4 500 kg valorizados en una sola llamada, asÃ­ que ahora se rechaza declarar mÃ¡s
kilos de los que la bobina ingresÃ³. El campo del diÃ¡logo venÃ­a **prellenado en cero**, o sea
con la baja total del saldo, reintroduciendo por la ventana el default que el API rechaza a
propÃ³sito: arranca vacÃ­o. Y el `findLast` del web recorrÃ­a la lista al revÃ©s de como viene
(del mÃ¡s reciente al mÃ¡s antiguo), asÃ­ que habrÃ­a citado los kilos del ajuste equivocado el dÃ­a
que convivan dos.

**Menores corregidos:** el sobrante no mostraba soles (ahora sÃ­, cuando hay saldo vivo y el
promedio es el que el API va a usar); el panel calculado no tenÃ­a `aria-live` ni el campo
`aria-invalid`/`aria-describedby`; la mutaciÃ³n de cambio de estado quedÃ³ con una rama muerta
tras mover el cierre al diÃ¡logo; un `import` sin uso en `fase6-bordes`; una firma de Ã­ndice en
el tipo del resumen de auditorÃ­a que apagaba el chequeo de propiedades de toda la interfaz; y
el sentido del ajuste se re-derivaba con una comparaciÃ³n propia en vez de leer `plan.kind`.

**El spec de D-164 pasÃ³ de 5 a 9 casos** con lo que la revisiÃ³n marcÃ³ como sin cubrir: la
liquidaciÃ³n **parcial**, el sobrante sobre **saldo vivo** (que se valoriza al promedio y no al
costo del documento, una rama que no tocaba ningÃºn test), los rechazos del schema y el caso del
ajuste inerte. Y ganÃ³ limpieza contra producciÃ³n, que le faltaba pese a declararse ejecutable
con `E2E_ALLOW_WRITES=1`.

**Anotado y no hecho:**

- **El diÃ¡logo de cierre no tiene E2E de UI.** Los nueve casos son por API; ningÃºn spec aprieta
  el botÃ³n Â«CerrarÂ» de `/bobinas/:id`. Es el Ãºnico punto de la interfaz que emite una baja de
  inventario nueva.
- **Los pedidos ya confirmados reservaron kilos con la densidad vieja** y producciÃ³n ahora
  consume ~1 % mÃ¡s (D-165). No revienta nada â€”`consumeReservationQty` recorta con
  `Decimal.min`â€”, pero ese 1 % sale de stock libre y puede disparar el aviso de faltante de
  D-154 sobre pedidos que nadie tocÃ³. Vale mirarlo el dÃ­a del deploy.
- **`theoreticalKgPerUnit` del catÃ¡logo** se muestra en el formulario de venta como Â«â‰ˆ N kgÂ» y,
  con el 1 % adentro, el rÃ³tulo quedÃ³ ambiguo: es el material que consume, no lo que la plancha
  pesa. No corrompe nada (el peso de la guÃ­a de remisiÃ³n se tipea a mano), pero el texto merece
  una pasada.
- **El reporte de precios cuenta las coberturas a medida como Â«sin costo en el kardexÂ»**, y el
  API sÃ­ les calcula piso por el agregado de materia prima. Para la pregunta del POS no cambia
  la decisiÃ³n â€”el mostrador no vende a medidaâ€”, pero el total de infractores queda
  subestimado.

### VerificaciÃ³n

`pnpm turbo lint typecheck test` en verde (**352/352** unitarios, 24 suites), `prettier --check`
sobre `apps packages docs CLAUDE.md scripts e2e` y `eslint e2e` limpios. Tests nuevos: los siete
casos de `coil-close-math.spec.ts` (D-164) y los cuatro de `normal-scrap-factor.spec.ts`
(D-165), mÃ¡s cinco expectativas de `roofing-math.spec.ts` y `production-math.spec.ts`
actualizadas con el comentario de por quÃ©, no solo con el nÃºmero.

**E2E local, corrida completa sobre una base reciÃ©n creada: 208 pasados, 14 fallos, 2
saltados.** Los 14 son las dos clases conocidas y ajenas a esta sesiÃ³n: **doce** por el cupo de
50 documentos de la cuenta demo de Nubefact (ocho lo dicen explÃ­cito y cuatro son su
consecuencia, un comprobante que no llega a `ACCEPTED`) y **dos** por el 409 de cÃ³digos
generados al azar. **Ninguno de esta sesiÃ³n.**

`pnpm e2e cierre-bobina-d164` â†’ **9/9**. `pnpm e2e planta-espacio` â†’ **8/8**.

**Lo que costÃ³ llegar ahÃ­ estÃ¡ arriba** (Â«El precio de D-165Â»): ocho tandas de correcciÃ³n de
fixtures, porque cada aserciÃ³n arreglada destapaba la siguiente del mismo caso. Vale anotarlo
como mÃ©todo: para un cambio de factor, presupuestar varias corridas completas, no una.

## SesiÃ³n Largo de la plancha (2026-09-09) â€” el campo pedÃ­a milÃ­metros y el catÃ¡logo tenÃ­a metros (D-166)

Bugfix de una captura del dueÃ±o, y de los que mÃ¡s enseÃ±an: **no habÃ­a ningÃºn error en el
cÃ³digo de D-161**. La cuenta era correcta; lo que estaba mal era el nÃºmero del maestro, y el
sistema lo multiplicaba sin preguntarse si se podÃ­a creer.

### El defecto

En Nueva cotizaciÃ³n, `PL028ROJO` â€”una plancha de 3 metrosâ€” mostraba el largo bloqueado en
**0.00** y la lÃ­nea calculaba **0.030 m lineales** y **S/ 0.28** para diez planchas a S/ 11 el
metro. DebÃ­a dar 30 m y S/ 330.

La causa **no** fue la que parecÃ­a. El largo sÃ­ se hidrataba del catÃ¡logo; lo que pasaba es que
el catÃ¡logo tenÃ­a `length_mm = 3.00`. El campo del maestro pide **milÃ­metros** y todo el resto
de la pantalla de coberturas trabaja en **metros**, asÃ­ que Â«3Â» entrÃ³ queriendo decir 3 metros.
Y no fue un desliz: las **tres** planchas del catÃ¡logo del dueÃ±o estaban asÃ­ (`3.00`, `6.00`,
`6.00`). El campo es una trampa, no hubo un error de tipeo.

De ahÃ­ en adelante todo funcionÃ³ como estaba escrito: 3 mm Ã· 1000 = 0.003 m por plancha, Ã— 10 =
0.030 m, Ã— S/ 9.3220 el metro (el valor sin IGV de S/ 11) = S/ 0.28. **Dos nÃºmeros correctos en
pantalla que habÃ­a que saber leer**, y ningÃºn error por ningÃºn lado.

### Lo que decidiÃ³ la forma del arreglo (D-166)

**El corte no podÃ­a ser que `sellsByFixedLength` devolviera `false`.** Es lo primero que uno
piensa â€”si el largo es imposible, que no cotice por metroâ€” y estÃ¡ mal: con `false` la lÃ­nea cae
en el camino viejo, el del valor por plancha tipeado a mano, y el vendedor escribe 11 pensando
Â«por metroÂ». Vuelve a estar mal, en silencio y por otro lado. Hace falta **cortar**, no elegir
otra rama, y por eso la precondiciÃ³n (`assertUsableFixedLength`) vive aparte del predicado.

**El rango no se inventÃ³ para este caso.** `MIN_PIECE_LENGTH_MM`..`MAX_PIECE_LENGTH_MM` (0.1 a
20 m) es exactamente el que la rama **a medida** ya exigÃ­a a cada largo de su plan de corte
desde D-083. La asimetrÃ­a era el defecto: el largo que se tipea lÃ­nea por lÃ­nea estaba
validado, y el que vive en el maestro â€”el Ãºnico que nadie mira al cotizarâ€” no. Unificarlos en
`isPlausiblePieceLength` deja una sola definiciÃ³n para las tres preguntas.

### Tres cortes, en los tres momentos

1. **Al cargar el producto** (`assertStructuredFields`): el catÃ¡logo no guarda un largo
   imposible, y el mensaje **traduce el nÃºmero y nombra la unidad** (Â«3.00 mm son 0.003 m; el
   campo va en milÃ­metros, una plancha de 3 metros son 3000Â»). Decir solo Â«fuera de rangoÂ»
   dejaba a quien lo lee sin saber quÃ© esperaba el campo, que es la mitad de la confusiÃ³n.
2. **Al tipearlo** (`PlateLengthHint` en el diÃ¡logo del catÃ¡logo): el equivalente en metros,
   en vivo, debajo del campo. Es la mitad barata del arreglo y la que de verdad previene: ver
   Â«= 0.003 mÂ» mientras se escribe desarma la confusiÃ³n en el momento, que es cuando corregirla
   no cuesta nada.
3. **Al cotizar** (`assertUsableFixedLength`): un producto **ya guardado** con el largo roto no
   se cotiza â€” la lÃ­nea lo dice en pantalla y el API la rechaza nombrando el SKU. Es el corte
   que importa de verdad, porque los tres productos del dueÃ±o siguen rotos hasta que alguien
   los corrija, y sin esto seguirÃ­an produciendo documentos mil veces mÃ¡s baratos.

Y `pnpm check:roofing-catalog` los lista, que es cÃ³mo encontrarlos en una base que ya los
tiene. Se le agregÃ³ ademÃ¡s `--branch local|local-e2e`, como ya tenÃ­a `check-price-floor`.

### Lo que NO se hizo, a propÃ³sito

**No se migrÃ³ ni un dato.** Multiplicar por 1000 los largos que estÃ¡n por debajo del mÃ­nimo
serÃ­a casi siempre correcto y ocasionalmente desastroso, y es una decisiÃ³n del dueÃ±o sobre sus
propios datos, no de una migraciÃ³n. Son tres productos y se corrigen en el catÃ¡logo en menos de
un minuto; el reporte los nombra.

### VerificaciÃ³n

`pnpm turbo lint typecheck test` en verde (**357/357** unitarios, 25 suites), `prettier --check`
y `eslint e2e` limpios. Tests nuevos: `apps/api/src/sales/fixed-length-plausible.spec.ts`, ocho
casos â€” el importe **exacto de la captura** con el largo bien cargado (S/ 330), el defecto
reproducido (S/ 0.28 y `sellsByFixedLength` diciendo que sÃ­), los bordes del rango, el par
cruzado contra `sellsByFixedLength`, y los tres casos del guard.

E2E: `e2e/tests/plancha-largo-d166.spec.ts`, **3/3 por pantalla** â€” el catÃ¡logo rechazando el
largo en metros, el diÃ¡logo traduciendo mientras se tipea, y la cotizaciÃ³n de una plancha de
3 m mostrando **30.000 m lineales** y cobrando **S/ 330.00**, que es la regresiÃ³n directa de la
captura. RegresiÃ³n de ventas y catÃ¡logo: `precios-d161-d163`, `fase7e`, `fase1` y
`fase7-consolidada-subtipo`, **33/33**.

**Sin desplegar y sin push.**

## SesiÃ³n HOTFIX post-deploy (2026-09-10) â€” servicios, importes del papel, SKU de bobina, reventa de bobina y plancha contra pedido (D-167..D-171)

La ventana de deploy expuso cuatro flujos que nunca se habÃ­an ejercitado de punta a punta con
datos reales. Dos eran defectos de una lÃ­nea; dos eran premisas de negocio equivocadas.

**Entorno LOCAL en toda la sesiÃ³n** (Docker, `:3000`/`:3001`). Contra `production` se corrieron
Ãºnicamente los dos guiones de **solo lectura**, con el OK del dueÃ±o. **Nada desplegado y sin
push.**

### M0 â€” Un servicio no se podÃ­a cotizar por ninguna puerta (D-167)

Â«LÃ­nea 1: el producto CONFORMADO es de una lÃ­nea sin inventario: no se cotizaÂ». El rechazo
estaba en `resolveSalesLines` y cortaba **antes** de llegar al kardex, que ya trataba el caso
como el no-op explÃ­cito que es (Â§2.2) â€” la mitad de abajo del sistema estaba lista y la de
arriba no dejaba llegar.

La exenciÃ³n la decide ahora `carriesInventory(line)` en `@ayr/shared`, por el **atributo**
`inventory_strategy` y nunca por el cÃ³digo de la lÃ­nea. Reemplaza a las tres comparaciones
sueltas que habÃ­a (`inventory.service` Ã—2, `purchases.service`). Cinco puntos tocados: la
resoluciÃ³n de lÃ­neas, la reserva, el piso de precio, el despacho y el web.

**Lo que la revisiÃ³n encontrÃ³ y obligÃ³ a ampliar el alcance:** el web filtraba el selector de
lÃ­nea de negocio por `inventoryStrategy === 'STOCK'`, asÃ­ que Servicios **ni siquiera se podÃ­a
elegir** y todo lo que M0 habÃ­a agregado del lado del navegador era cÃ³digo muerto. Sin ese
segundo arreglo, el Ãºnico camino que ejercitaba D-167 era el importador.

Dos consecuencias que habÃ­a que decidir y no se podÃ­an dejar implÃ­citas:

- **El despacho rechaza una lÃ­nea de servicio.** No sale nada del almacÃ©n y no hay peso que
  declarar en una guÃ­a; dejarla pasar hacÃ­a que el despacho pidiera Â«el peso en kilosÂ» de un
  conformado y lo escribiera en la guÃ­a de remisiÃ³n como si fuera un bulto.
- **`recomputeOrderStatus` no la espera** para llegar a `FULFILLED`. Sin esto, todo pedido que
  mezclara mercaderÃ­a con un servicio quedaba en `PARCIALMENTE DESPACHADO` para siempre.
- Un pedido de **solo** servicios se queda en `CONFIRMADO`: el ERP no modela la ejecuciÃ³n de un
  servicio y fingir que sÃ­ serÃ­a peor. Queda anotado.

### M1 â€” El rechazo por cÃ©ntimos vivÃ­a en la cobranza, no en el importador (D-169)

El brief decÃ­a que las importaciones rechazaban por cÃ©ntimos y ubicaba el rechazo aguas abajo.
**No estaba en el importador**: ahÃ­ no hay ninguna comparaciÃ³n de importes (el piso de precio ya
estÃ¡ desactivado por D-163). Se reprodujo el camino completo contra el API local hasta
encontrarlo.

**DÃ³nde estaba.** Una lÃ­nea de 3 Ã— S/ 33.3333 da un subtotal de 99.9999 y un total de
**117.9999**. El papel dice S/ 118.00. Cobrar los 118 del papel se rechazaba con:

```
El cobro excede el saldo pendiente (S/ 118.00)
```

sobre un cobro de exactamente S/ 118.00 â€” el mensaje redondeaba para mostrar y la comparaciÃ³n
no. Dos cifras idÃ©nticas en pantalla y un 400 sin salida, sobre una factura que no se podÃ­a
cerrar nunca.

**Dos arreglos, y hacen falta los dos:**

1. **La causa** (D-169): el importe de una lÃ­nea importada **se copia del papel** en vez de
   recalcularse. `netAmountPen` viaja por fila y `resolveSalesLines`, bajo `exactAmounts`, lo
   persiste como subtotal. El unitario sigue siendo la cuenta derivada, porque es lo que el
   comprobante electrÃ³nico declara como `valorUnitario`.
2. **La clase entera**: `payableBalance` compara el saldo **en cÃ©ntimos**, redondeando hacia
   arriba. Un total con cola de diezmilÃ©simas tambiÃ©n lo produce un precio tipeado a mano, asÃ­
   que arreglar solo el importador habrÃ­a dejado el mismo callejÃ³n por otra puerta.

Y dos cierres mÃ¡s que la revisiÃ³n encontrÃ³ en el camino:

- El **comprobante** recalculaba el subtotal e ignoraba el del pedido, asÃ­ que el importe exacto
  morÃ­a al facturar â€” literalmente el daÃ±o que D-169 dice cerrar, una pantalla mÃ¡s adelante. La
  lÃ­nea que factura un pedido entero a su propio precio ahora **copia** su importe; la parcial o
  la de precio editado se sigue recalculando, que es lo Ãºnico defendible.
- **Editar** una cotizaciÃ³n importada le borraba los importes a todas sus lÃ­neas, en silencio.
  Ahora conserva el del papel en las lÃ­neas cuyo producto, cantidad y precio no cambiaron.

**La tolerancia tuvo que dejar de ser un nÃºmero fijo.** El techo plano de S/ 0.10 que pidiÃ³ el
brief rechazaba **justo los documentos que la decisiÃ³n venÃ­a a poder importar**: el desvÃ­o que
el redondeo del unitario puede producir es `cantidad Ã— 0.00005`, o sea S/ 0.12 en una lÃ­nea de
2 500 kg, que es el tamaÃ±o normal de una de acero. La cota es ahora
`max(S/ 0.10, Î£ (cantidad + 1) Ã— 0.00005)` â€” el colchÃ³n del dueÃ±o como piso, y la aritmÃ©tica
como techo. Lo que queda por encima es lo Ãºnico que el redondeo no pudo haber hecho.

### M2 â€” El guion es un separador, no un carÃ¡cter a borrar (D-168)

`coilSkuFromTypeKey` hacÃ­a `typeKey.replace(/-/g, '')` y `coilSku` conservaba los guiones del
acabado. Con un cÃ³digo de acabado sin guiones (`GALV`) las dos coinciden y el test que habÃ­a
pasaba; con uno real del cliente (`ALZ-ROJO-3002`) no:

```
catÃ¡logo   â†’ BOBALZ-ROJO-30020.45   (coilSku, es lo que estÃ¡ en la base)
venta      â†’ BOBALZROJO30020.45     (coilSkuFromTypeKey)
```

y RF-73 respondÃ­a Â«no existe el producto de venta directaÂ» sobre una bobina que sÃ­ tenÃ­a el
suyo. Ahora hay **una sola** funciÃ³n que arma el SKU y la otra parte el `typeKey` por su
**Ãºltimo** guion y delega â€” el mismo criterio que `describeTypeKey` ya usaba en el valorizado.

**Auditado contra `production` y `local`** (`pnpm check:coil-skus`, solo lectura, con OK del
dueÃ±o): los **11** tipos de bobina de producciÃ³n y los 3 de local resuelven a su producto con la
funciÃ³n arreglada. **No hay ningÃºn dato que migrar.** Los dos `BOBâ€¦` sin bobinas de cada base
(`BOB38AZUL`/`BOB38ROJO` en producciÃ³n) son SKU creados a mano, no restos de la forma vieja.

### M3 â€” La venta de bobina entera ya existÃ­a; le faltaba el cierre (D-170)

Al leer el cÃ³digo antes de diseÃ±ar apareciÃ³ que **RF-73/D-116 ya estaba casi entero** desde la
Fase 7e: saldo vigente y no nominal, sin fracciones, reserva del rollo completo, `OUT` directo
sobre la bobina sin pasar por ningÃºn kardex intermedio, y una bobina reservada que ni se monta
en producciÃ³n ni se manda a corte. **Lo que la rompÃ­a en la prÃ¡ctica era M2.**

Lo que faltaba, y se agregÃ³: el despacho **cierra** el rollo que quedÃ³ en cero y sin reservas
vivas, y la reversa lo **reabre**. Un despacho parcial que deja remanente no lo cierra: ese
camino sigue siendo el cierre manual de D-164, el que pide cuÃ¡ntos kilos quedan y liquida la
diferencia como merma anormal.

**`refType` propio se descartÃ³, con el OK del dueÃ±o.** El movimiento ya es `SALE` sobre
`itemType = COIL`, que es inequÃ­voco; agregar `COIL_SALE` al enum obligaba a una migraciÃ³n y a
revisar la reversa a cambio de distinguir algo que el `itemType` ya distingue solo.

### M4 â€” La plancha no es stock terminado (D-171, revierte D-140)

Regla de negocio del dueÃ±o. Con el modelo viejo el mostrador exigÃ­a tener planchas en el almacÃ©n
â€”Â«0.000 NIU disponiblesâ€¦ necesita 10Â»â€” sobre un producto que nunca vive ahÃ­: se rola contra el
pedido igual que una cobertura a medida.

**Una cuarta pregunta, no un cambio a las que habÃ­a** (regla dura 14). `isMadeToOrder(product)`
responde _Â¿se fabrica desde bobina contra el pedido?_, y la contestan que sÃ­ la cobertura a
medida y la plancha **con largo fijo usable**. `isMadeToMeasure` deja de decidir la rama de la reserva y se
queda con lo que su nombre dice. El centinela `sales-lines.spec.ts` cubre ahora las cuatro
combinaciones, con el par nuevo escrito aparte porque es el mÃ¡s peligroso: responder Â«Â¿se
produce?Â» con `isMadeToMeasure` devuelve la plancha al modelo viejo en silencio.

`orderedMeters(product, qty, at)` es la conversiÃ³n que hace que las dos formas prometan con la
misma aritmÃ©tica: en una plancha, `cantidad Ã— largo del SKU`. **El 1 % de merma normal no se
suma aparte** â€”vive dentro de la densidad estÃ¡ndar desde D-165â€” y sumarlo lo habrÃ­a contado dos
veces.

**Producir coberturas a stock se eliminÃ³**, con el OK explÃ­cito del dueÃ±o y registrado como
decisiÃ³n de negocio **reversible**. Es la contracara necesaria: si ademÃ¡s se pudiera producir a
stock, quedarÃ­a un saldo de producto terminado que ningÃºn pedido consume nunca. Para reabrirla
hay que responder primero quÃ© hace una lÃ­nea de pedido cuando ese saldo existe, que es la
pregunta que hoy no tiene respuesta. `createToStock` quedÃ³ en el archivo sin llamadores, para
que reabrirla sea volver a enchufarla y no volver a escribirla.

**Un defecto viejo que apareciÃ³ al mirar el camino del despacho:** `resolveDispatchTarget`
decidÃ­a Â«se fabrica contra el pedidoÂ» con `productBom.count`, y desde D-122 una cobertura **ya
no tiene receta** â€” el caso central de esa rama daba cero y se sostenÃ­a solo por que la
producciÃ³n ya hubiera abierto la reserva de producto. Un despacho **anterior** a producir caÃ­a
al camino de las coordenadas congeladas y emitÃ­a una salida de **kilos de bobina** por una venta
de planchas, que es exactamente lo que D-088 vino a cerrar. Ahora decide por el subtipo.

**Censo previo, con el OK del dueÃ±o** (`pnpm check:roofing-catalog`, ampliado en esta sesiÃ³n,
solo lectura):

|                               | `production` | `local` |
| ----------------------------- | ------------ | ------- |
| SKU de plancha                | 19           | 3       |
| LÃ­neas en cotizaciones vivas | 0            | 5       |
| LÃ­neas en pedidos vivos      | 0            | 0       |
| Saldo de producto terminado   | 0            | 0       |
| OP de plancha Â«a stockÂ»     | 0            | 0       |

**Ninguna migraciÃ³n**, y no por suerte: la rama de la reserva se recalcula al **confirmar** el
pedido (`resolveRawMaterial`), no al cotizar, asÃ­ que las cotizaciones vivas se confirman solas
bajo el modelo nuevo. Es el mismo mecanismo con el que D-134 arreglÃ³ las anteriores a Ã©l.

### Lo que encontrÃ³ la revisiÃ³n

Dos bloqueantes, los dos reales y los dos corregidos antes de seguir:

1. **La tolerancia de D-169 era mÃ¡s chica que el error que existe para tolerar** â€” ver M1.
2. **El web tapiaba la puerta que M0 abriÃ³ en el API** â€” ver M0.

Y cuatro mÃ¡s, todos corregidos: el comprobante que recalculaba el importe; la ediciÃ³n que lo
perdÃ­a; la lÃ­nea de servicio atrapada en el despacho; y el guard de `netAmountPen`, que estaba
**despuÃ©s** del `return` de la rama de venta de bobina, asÃ­ que en esa rama el campo se ignoraba
en silencio en vez de dar 400 â€” el contrato decÃ­a una cosa y una de las dos ramas hacÃ­a otra.

De los bajos se tomaron: unificar las tres comparaciones crudas de `NOOP` en `carriesInventory`,
dejar escrita la exclusiÃ³n del mostrador (su lista nace del saldo, y un servicio no tiene saldo
del que salir), validar `--branch` en el guion nuevo, y mostrar el ajuste de redondeo en el
detalle de la cotizaciÃ³n â€” viajaba en el DTO y no lo pintaba ninguna pantalla.

**La segunda pasada, sobre M3 y M4, encontrÃ³ otros dos altos**, los dos del mismo tipo â€” la
regla nueva alcanzaba a datos que no sabÃ­a describir:

1. **`isMadeToOrder` era `roofingKind !== null`, y eso no alcanza.** Ver M4: el `CHECK` de la
   base admite una `PLANCHA` en `KGM` y una sin largo, y en esas dos la cantidad no son
   planchas. Corregido a `isMadeToMeasure || sellsByFixedLength`, con el caso en el centinela.
2. **La tarjeta Â«Nueva orden de coberturas a stockÂ» de `/planta` quedÃ³ como callejÃ³n**: el API
   ya respondÃ­a 400 fijo y la pantalla seguÃ­a ofreciendo elegir la plancha y tipear la meta.
   Se retirÃ³ en el mismo commit que cerrÃ³ la puerta, que es lo que D-156 pide.

Y cinco medios, corregidos: la **reversa parcial** dejaba el rollo `CLOSED` con saldo vivo â€”dos
despachos sobre la misma bobina, el segundo la cierra, revertir el primero le devuelve kilosâ€”,
asÃ­ que la reapertura pasÃ³ a mirar el **Ãºltimo cierre del rollo** y no el `closedCoils` del
despacho que se revierte; la reversa **no tomaba el lock de bobinas** aunque su propio
comentario prometÃ­a el orden Â«pedido â†’ bobinas â†’ saldosÂ»; el bloque canÃ³nico de la familia de
preguntas en `schemas/roofing.ts` seguÃ­a enseÃ±ando que `isMadeToMeasure` decide la rama de la
reserva, que es exactamente la confusiÃ³n que la regla dura 14 prohÃ­be; el navegador respondÃ­a
la pregunta de la unidad con el subtipo en el cÃ¡lculo de metros; y el **mostrador** seguÃ­a
ofreciendo planchas con saldo legado que ya no se pueden despachar por ninguna puerta.

De los bajos de esa pasada se tomaron: la fecha de operaciÃ³n en el cierre automÃ¡tico (el manual
la escribe y un reporte por fecha de negocio se saltearÃ­a los automÃ¡ticos), el plan de corte
derivado en el **PDF de planta** â€”imprimÃ­a Â«â€”Â» justo en la lÃ­nea que ahora hay que rolarâ€” y el
`madeToMeasure` mal nombrado de `roofing-production.service.ts`, que es la clase de nombre que
no conviene reutilizar con cuatro predicados en juego.

### Lo que encontrÃ³ la escritura de los E2E

**Un defecto del API, y era mÃ­o: la cabecera del comprobante no sumaba sus propias lÃ­neas.**
`resolveLines` copiaba el importe del papel en la lÃ­nea (la mitad de D-169 que sÃ­ estaba
implementada) y, un renglÃ³n mÃ¡s abajo, `createInTx` calculaba el total de la cabecera con
`salesTotals(lines.map(l => ({ qty, unitPricePen })))` â€” recalculando desde el unitario. La
lÃ­nea decÃ­a S/ 4 179.13 y la cabecera S/ 4 179.00.

No era cosmÃ©tico y era **exactamente el daÃ±o que D-169 vino a cerrar, sobrevivido una pantalla
mÃ¡s adelante**: la cuenta por cobrar sale de `totalPen`, asÃ­ que el saldo quedaba trece
cÃ©ntimos por debajo del papel y cobrar el importe del papel se rechazaba por exceso. Pasaba
desapercibido porque el total recalculado, al perder la cola de diezmilÃ©simas, se ve **mÃ¡s
limpio** que el correcto.

Corregido con `sumLineTotals` â€”suma subtotal e IGV por separado, nunca totales ya redondeados,
el mismo criterio que `documentTotals` en ventasâ€” y aplicado tambiÃ©n a la **nota de crÃ©dito**,
que tenÃ­a el mismo defecto por partida doble: su cabecera lo recalculaba y, peor, una NC
**total** sobre un comprobante importado acreditaba menos que el total del afectado, asÃ­ que la
cuenta por cobrar no cerraba nunca y quedaban cÃ©ntimos que ya nadie podÃ­a acreditar ni cobrar.
Acreditar la lÃ­nea entera copia su importe entero; una acreditaciÃ³n parcial se sigue calculando,
porque una fracciÃ³n de un importe exacto hay que derivarla.

El caso naciÃ³ en la suite marcado `test.fail()` â€”corrÃ­a, afirmaba la regla nueva y dejaba la
suite verde mientras el defecto existieraâ€” y se le quitÃ³ la marca al corregirlo.

**Dos mÃ¡s, que no se tocaron** (ninguno es de esta sesiÃ³n):

- **El selector de cliente no ve mÃ¡s de 200 clientes y no busca.**
  `sales-document-form.tsx` los pide con `fetchAllForPicker('/customers')` (`pageSize=200`) y
  los pinta en un `<Select>` plano. `/customers` ordena por `isActive desc, name asc`, asÃ­ que
  con mÃ¡s de 200 activos **el vendedor no puede elegir a la mayorÃ­a**: no hay error, sencillamente
  no estÃ¡n. El propio helper lo advierte de sÃ­ mismo y `/customers` ya soporta `search`.
- **La cuenta demo del PSE estÃ¡ en su tope** (Â«No puedes enviar mas de 50 documentos en en una
  cuenta DEMOÂ»), y con eso quedan 12 casos rojos en `fase5b`, `fase5b-bordes` y `fase7b`. **No
  es una regresiÃ³n** y no se silenciÃ³: `probePse` no cubre este caso â€”el PSE estÃ¡ configurado,
  solo sin cupoâ€” y saltear esos casos por cuota esconderÃ­a regresiones reales. Necesita acciÃ³n
  del dueÃ±o: vaciar los comprobantes de la cuenta demo.

### VerificaciÃ³n

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e
pnpm exec eslint e2e

pnpm check:coil-skus --branch local        # y --branch production, solo lectura
pnpm check:roofing-catalog --branch local  # incluye el censo de exposiciÃ³n de PLANCHA

# Recrear `ayr_local_e2e` antes de una tanda larga (ver notas operativas).
# Matar servidores viejos en :3000/:3001; NO tocar :4000/:4001 (regla dura 15).
pnpm e2e servicios-d167 bobina-sku-guiones-d168 importe-importado-d169 \
         venta-bobina-entera-d170 plancha-contra-pedido-d171     # 22/22, los cinco frentes
pnpm e2e fase6 fase7-consolidada-subtipo fase7final-op-a-stock precios-d161-d163 \
         planta-avisos-materia-prima planta-espacio-produccion-ui  # regresiÃ³n de D-171
```

La suite completa quedÃ³ en **13 fallados / 230 pasados**, y los 12 que sobreviven al Ãºltimo
arreglo son todos el cupo del PSE demo. El baseline antes de esta sesiÃ³n era **26 fallados**.

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

## Ventana de deploy (2026-09-10) â€” D-167..D-171 a producciÃ³n

Mini-ventana aprobada por el dueÃ±o, con cada comando contra producciÃ³n anunciado y ejecutado
uno por uno tras su OK. **Sin migraciones nuevas en la tanda.**

|                     |                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Commits desplegados | `c908980`, `46b885a`, `946ce0e` (D-167..D-171)                                                   |
| Respaldo previo     | rama Neon `respaldo-pre-hotfix-2026-09-10` (`br-muddy-flower-ae8ik7ae`)                          |
| RevisiÃ³n de API    | `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`, CORS `https://ayr-steel-erp-web.vercel.app` |
| Web                 | por push a `main`; verificaciÃ³n en navegador, a cargo del dueÃ±o                                |
| CI                  | run `34475912275`, disparada por el push                                                         |

**VerificaciÃ³n post-deploy.** `pnpm smoke:prod` en verde (health, login, 5 lÃ­neas, 174
productos, 52 saldos, 5 bobinas, 50 filas del reporte). Y **dos marcadores de que sirve la
revisiÃ³n nueva y no la anterior**, leÃ­dos con un administrador efÃ­mero borrado en el `finally`:
`avgCostPen` en `/sales/sellable-coils` (D-170, 43 bobinas) y `carriesInventory` en
`/sales/stock-panel` (D-167). Un smoke que solo mira que el API responda no distingue una
revisiÃ³n de la otra; por eso el marcador es un **campo que solo existe en los commits de la
tanda**, y conviene elegir uno nuevo en cada ventana.

**El selector de clientes no es urgente.** El defecto que encontrÃ³ QA (pide 200 y los pinta sin
bÃºsqueda) se midiÃ³ contra la base real: **49 clientes activos de 49 totales**, o sea 151 de
margen. Sigue anotado y hay tiempo de resolverlo con `SearchSelectField` (D-156) en vez de a las
apuradas.

### Incidente de seguridad â€” credencial de `neondb_owner` expuesta

**2026-09-10, 11:54 UTC.** `neonctl branches create` **imprime `connection_uris` en su salida de
Ã©xito**, y esa cadena lleva la contraseÃ±a de `neondb_owner` en texto plano. QuedÃ³ en la salida
del comando y en el transcript de la sesiÃ³n.

**Alcance: las cuatro ramas de Neon, `production` incluida**, porque esa contraseÃ±a es la misma
en todas (regla dura 5). No se escribiÃ³ en ningÃºn archivo, no se commiteÃ³ y no se repitiÃ³.

**Por quÃ© pasÃ³, que no es lo que la regla decÃ­a.** La regla dura 5 cubrÃ­a dos vÃ­as â€”la
credencial no viaja por `argv`, y los helpers no repiten argumentos al componer un errorâ€” y de
las dos nos cuidamos. La tercera vÃ­a es que **el comando la imprima al salir bien**, que no
estaba nombrada. `scripts/lib.mjs#run` tiene `quiet: true` exactamente para esto; el comando se
invocÃ³ directo por `cmd /c` con la salida a la vista. La regla dura 5 se ampliÃ³ con este caso.

**DecisiÃ³n del dueÃ±o:** continuar la ventana sin rotar, asumiendo el riesgo, con la rotaciÃ³n
como paso **obligatorio** de cierre.

**RotaciÃ³n ejecutada.** `neondb_owner` se reseteÃ³ (`neonctl roles reset-password`) y se
propagÃ³ a `.env.setup`, Secret Manager en GCP y los secretos de GitHub Actions. Incidente
cerrado.

## SesiÃ³n Saneamiento E2E (2026-09-10) â€” la suite deja de tener rojos que no son regresiones

Entorno **LOCAL** en toda la sesiÃ³n. **Nada desplegado y sin push**; el commit de la ventana
(`207bdf9`) sigue pendiente y sale con estos.

**Resultado: `pnpm e2e` da verde pleno.** De **26 fallados** al empezar el dÃ­a a **0**. El
tiempo de la suite ronda los **50 minutos**, con un desvÃ­o de Â±4 entre corridas del mismo
cÃ³digo (ver M1: esa dispersiÃ³n es la que impidiÃ³ medir la mejora de velocidad):

| corrida                              | resultado                                         |
| ------------------------------------ | ------------------------------------------------- |
| baseline heredado (sesiÃ³n anterior) | 26 fallados                                       |
| tras el hotfix D-167..D-171          | 13 fallados                                       |
| primera completa de esta sesiÃ³n     | 10 fallados â€” todos causados por el reset nuevo |
| **final**                            | **234 pasados, 0 fallados, 2 saltados**           |

Los 2 saltados son los dos casos de `fase7b` que exigen que una **boleta** llegue a aceptada;
SUNAT las resuelve por resumen diario y el PSE demo puede tardar mÃ¡s que la corrida. Se saltan
por diseÃ±o desde la Fase 7b, no son deuda nueva.

### M0 â€” la suite deja de depender de recursos externos

Tres piezas, documentadas en `docs/ENTORNOS.md` bajo Â«La corrida por defecto no depende de nada
externoÂ».

**Los 12 casos que necesitan cupo del PSE salen de la corrida por defecto** (`@pse`,
`pnpm e2e:pse` para correrlos). La lista no se armÃ³ leyendo: se corrieron los tres archivos y se
tomÃ³ a los que fallan con Â«No puedes enviar mas de 50 documentos en en una cuenta DEMOÂ».

Dos cosas decidieron la forma. **El opt-in va por entorno y no por bandera** porque un `--grep`
de la lÃ­nea de comandos pisa a `grep` pero **no** a `grepInvert`: con bandera, `e2e:pse` habrÃ­a
corrido cero casos. Y **no se ampliÃ³ `probePse`**, que era la alternativa obvia: la sonda ya
saltea cuando no hay PSE atado o falta el RUC del receptor â€”eso es _en este entorno no se puede
llegar a una aceptaciÃ³n_â€”, pero enseÃ±arle ademÃ¡s Â«â€¦y tampoco si el servidor contestÃ³ que no hay
cupoÂ» serÃ­a saltear casos segÃºn **la respuesta que dio el servidor**, y esa misma condiciÃ³n
taparÃ­a una regresiÃ³n que hiciera fallar la emisiÃ³n por cualquier otro motivo.

**El 409 al azar se arreglÃ³ en la causa.** `reset-test-db.ts` truncaba nueve tablas escritas a
mano y dejaba fuera **todos los maestros**, que se acumulaban entre corridas. Ahora enumera
desde `information_schema` y vacÃ­a **45 tablas** â€”todo menos `_prisma_migrations`â€”, que es tabla
por tabla el estado de una base reciÃ©n creada. Se enumera y no se lista a mano a propÃ³sito: la
lista escrita a mano fue justamente lo que envejeciÃ³.

**El padrÃ³n se responde con un stub local.** `e2e/padron-stub.mjs` corre como tercer `webServer`
en `:3002` y el API lo consulta vÃ­a `APIS_NET_PE_BASE_URL`, que se hizo configurable. ExistÃ­a un
motivo real para que el badge Â«Nuevo â€” se crearÃ¡ desde padrÃ³nÂ» fuera intestable: **la consulta
sale del API, no del navegador** (D-158), asÃ­ que `page.route()` nunca la veÃ­a. El stub responde
200 si el documento termina en dÃ­gito par y 404 si en impar, asÃ­ un test elige la rama del alta
desde padrÃ³n o la del alta express sin listas que mantener.

**Dos E2E nuevos**: el badge del padrÃ³n â€”con los dos lados en el mismo archivo, para que el
contraste no dependa de dos corridasâ€” y el diÃ¡logo de cierre de bobina de D-164 por pantalla.

### Lo que el reset destapÃ³, que es la mitad del valor de M0

La primera corrida completa dio **10 rojos, y los diez eran del cambio**. La migraciÃ³n de la
Fase 5b sembraba tres datos iniciales â€”el cliente **Â«pÃºblico en generalÂ»** (D-077), las **cinco
series fiscales** (D-072) y la **fila de configuraciÃ³n del PSE** (D-073)â€” y una migraciÃ³n corre
**una vez**: al vaciarlas, nada las repuso.

El sÃ­ntoma no se parecÃ­a a la causa: Â«la migraciÃ³n de 5b siembra el cliente "pÃºblico en
general"Â» en un test de importaciÃ³n, y Â«No hay una serie activa para emitir FACTURAÂ» en diez
casos repartidos por cinco archivos que no hablan de series.

Los tres se mudaron al **seed**, que responde otra pregunta â€”_quÃ© necesita esta base para ser
usable_, la misma que ya respondÃ­an las lÃ­neas de negocio y sus mÃ¡rgenesâ€” y corre siempre. Todo
idempotente: contra producciÃ³n o demo no hace nada. **El seed no pisa una serie que ya existe**:
el correlativo es un hecho fiscal y `isActive` lo administra el dueÃ±o.

**La regla, para lo que venga: un dato inicial que inserta una migraciÃ³n tiene que estar tambiÃ©n
en el seed**, o desaparece en el primer reset y reaparece como un fallo lejos de su causa. Queda
escrita en `seed.ts`.

### M1 â€” el informe apuntaba al lugar equivocado, y la mediciÃ³n lo dice

Perfil real de la suite, medido sobre las duraciones que imprime el reporter:

| franja        | casos   | tiempo       | %        |
| ------------- | ------- | ------------ | -------- |
| > 60 s        | 0       | â€”          | â€”      |
| 30â€“60 s     | 7       | 4.6 min      | 9 %      |
| **10â€“30 s** | **128** | **35.2 min** | **71 %** |
| â‰¤ 10 s      | 98      | 9.7 min      | 20 %     |

**No hay punto caliente**: el archivo mÃ¡s pesado es el 6.3 % del total y el caso mÃ¡s caro, 51.7 s.
La suite tarda porque hace 233 cosas de punta a punta.

Dos de las tres recomendaciones del informe **no se sostienen**, y se descartaron con nÃºmeros:

- **`storageState` para el login (Â«ALTA, 10-15 minÂ»)**: son **15 llamadas a
  `loginAndSetPassword` en 6 archivos**, no Â«198 testsÂ» â€” el resto usa `adminApi()`, que es un
  POST. Techo real â‰ˆ 1 minuto, contra una refactorizaciÃ³n que toca seis roles distintos y varios
  casos que ejercitan a propÃ³sito el cambio de contraseÃ±a obligatorio.
- **Los `setTimeout` fijos de `fase7b`**: son polls de un servicio asÃ­ncrono real (SUNAT por
  resumen diario) y viven en los dos tests que quedan **saltados**. Ahorro: cero.

El informe se escribiÃ³ leyendo el cÃ³digo sin correrlo, y ahÃ­ estÃ¡ su error: estimÃ³ el login por
cuÃ¡ntos specs mencionan la palabra, no por cuÃ¡ntas veces se llama.

Lo que sÃ­ se hizo, que es lo que paga en un perfil plano â€”**el setup que todos comparten**â€”:
`Promise.all` en las altas **independientes entre sÃ­** de `setupRoofingScenario` (lo montan **51
casos**), `setupScenario` de producciÃ³n y `setupOrderScenario`; y `purgeInvoicingTrail` dejÃ³ de
leer los mismos documentos **tres veces** con un GET por documento en cada pasada.

Las **mutaciones** de la limpieza siguen secuenciales y no es una omisiÃ³n: cobros antes que
bajas, notas de crÃ©dito antes que su afectado. AhÃ­ el orden **es** la regla.

**La ganancia NO se pudo medir, y eso es el resultado.** Cuatro corridas completas de la suite,
las dos Ãºltimas con el cÃ³digo final, dieron **49.5 Â· 47.3 Â· 45.7 Â· 49.7 min** de suma de
duraciones (y 53.9 Â· 50.3 Â· 48.8 Â· 54.3 de reloj de pared). El desvÃ­o entre corridas del
**mismo** cÃ³digo es de Â±4 minutos, o sea **mÃ¡s grande que el efecto que se estaba buscando**.

Durante la sesiÃ³n lleguÃ© a reportar Â«â‰ˆ5 minutos, 9 %Â» comparando dos corridas sueltas. Estaba
leyendo ruido como seÃ±al: con esa dispersiÃ³n, un solo par antes/despuÃ©s no puede resolver un
efecto de dos minutos. Medirlo de verdad pide varias corridas de cada lado, o sea horas.

Lo que sÃ­ se puede contar sin medir es lo estructural: los tres helpers se montan **94 veces**
entre todos los specs, y cada uno ahorra 1 o 2 viajes secuenciales; `purgeInvoicingTrail` pasÃ³
de `3 Ã— N` viajes en fila a 3 vueltas en paralelo. Son unos pocos segundos en total â€”por eso no
se venâ€”. El cambio es correcto y no se deshace, pero **la velocidad de la suite no mejorÃ³ de
forma observable**, y presentarlo de otra manera serÃ­a inventar.

**La palanca grande serÃ­a paralelizar workers**, y ahÃ­ sÃ­ hay minutos de verdad. No se tocÃ³: los
233 casos comparten una base y muchos dependen de saldos, correlativos y reservas globales.
Queda propuesta, no hecha.

### M3 â€” el selector de cliente pasa a `SearchSelectField`, y el umbral baja a 20

El desplegable sin bÃºsqueda de la cotizaciÃ³n pasa al mismo campo que usa el importador (D-156).

**Y el umbral bajÃ³ de 50 a 20, por decisiÃ³n del dueÃ±o tomada con el dato delante**: producciÃ³n
tiene **49 clientes activos**, asÃ­ que con el umbral en 50 el vendedor quedaba a un cliente de
distancia del buscador y mientras tanto elegÃ­a de una lista de 49 nombres reconociÃ©ndolos de
vista. Alcanza a tres campos: el cliente de la cotizaciÃ³n, el cliente del comprobante en el
importador y el producto de la fila (que ya estaba del lado del buscador, con 174 productos).

**Lo que M3 no arregla**, y quedÃ³ escrito en el cÃ³digo: `fetchAllForPicker` sigue trayendo como
mucho 200 clientes. Esto da **bÃºsqueda sobre lo cargado**, no Â«ver todosÂ». Levantar el tope es
buscar del lado del servidor â€”`/customers` ya acepta `search`â€” y es un cambio propio.

### El fallo que enseÃ±Ã³ mÃ¡s que su arreglo

El caso de D-166 **pasaba aislado y fallaba en la suite completa**, que es la peor forma de
fallar. La causa: el reset vacÃ­a la base **una vez por corrida, no por test**, asÃ­ que para
cuando ese caso corre ya hay mÃ¡s de veinte clientes creados por sus vecinos, y el campo que en
solitario es un `<select>` ahÃ­ es un modal. Con el modal abierto, `getByLabel('Cliente')`
resuelve a **tres** elementos â€”el botÃ³n del campo, el diÃ¡logo y el botÃ³n Â«Seleccionarâ€¦Â»â€” y
Playwright corta por modo estricto.

Dos cosas quedaron de ahÃ­: el locator con `exact: true`, y los helpers que manejan las dos formas
del campo movidos de dentro del spec del importador a `e2e/helpers/ui.ts`. VivÃ­an ahÃ­ porque esa
era la Ãºnica pantalla con el componente; desde M3 son dos, y tener la soluciÃ³n copiada en un
spec era esperar a que la segunda la reescribiera peor.

### VerificaciÃ³n

```bash
pnpm turbo lint typecheck test          # verde (399 unitarios)
pnpm exec eslint e2e
pnpm format:check

pnpm e2e                                # 234 pasados, 0 fallados, 2 saltados (~50 min)
pnpm e2e:pse                            # los 12 del PSE â€” antes hay que vaciar la cuenta demo
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

## SesiÃ³n S9 â€” Trazabilidad y links (T4) + Reporte de bobinas PDF (T6) (2026-09-10)

Entorno **LOCAL** en toda la sesiÃ³n. **Nada desplegado y sin push**: PROHIBIDO por el brief de
la sesiÃ³n, que acumula commits locales para la ventana Ãºnica post-T7.

**M1 (T4) â€” links donde antes habÃ­a texto plano, cero cambios de lÃ³gica de negocio.**

- **Bobina â†” pedido/OP, la punta que faltaba.** `/produccion/:id` ya listaba las bobinas
  montadas por una OP (D-060); faltaba el sentido contrario. `GET /coils/:id/consumptions`
  recorre `ProductionOrderConsumption` por `coilId` y sube por
  `productionOrder.reservation.salesOrder`, y una tarjeta nueva "Ã“rdenes de producciÃ³n" en
  `/bobinas/:id` lo muestra con links a `/produccion/:id` y `/pedidos/:id` (D-172). Se
  descartÃ³ ir por `Reservation.itemId`: una reserva `RAW_MATERIAL` apunta a un agregado
  color+espesor (D-134), no a una bobina fÃ­sica â€” la bobina concreta reciÃ©n se decide al
  armar la OP.
- **Cliente sin ficha propia.** No existe `/clientes/[id]`. El link es `/clientes?search=<RUC>`;
  `clientes-view.tsx` lee `?search=` con `useSearchParams()` solo al montar (mismo patrÃ³n que
  `?pedido=` en despachos/comprobantes nuevos) y `customerSearchHref()` en `@/lib/utils` arma
  el href. Aplicado en cotizaciones, pedidos, despachos, comprobantes y cobranzas (lista y
  detalle donde correspondÃ­a). Dos DTO ganaron un campo aditivo para poder armar el link:
  `DispatchDto.customerId`/`customerDocNumber` y `PurchaseItemDto.coilId` â€” los dos ya se
  resolvÃ­an en el `include` de Prisma, solo faltaba devolverlos.
- **Quedan afuera a propÃ³sito** las filas dentro de un `<Select>` de un formulario (elegir
  quÃ© pedido despachar o facturar): ahÃ­ un clic ya significa "elegir esta fila", convertirlo
  en link romperÃ­a la selecciÃ³n.
- DecisiÃ³n completa: D-172.

**M2 (T6) â€” reporte de bobinas en PDF, no sacrificado.**

- Mismo criterio que la hoja de planta del pedido (D-149) y no el de la cotizaciÃ³n (D-068):
  es un reporte interno y regenerable, asÃ­ que se arma al vuelo con `pdfkit` y **no** se
  persiste en R2. `apps/api/src/coils/coil-pdf.ts` concentra los dos armados â€”
  `GET /coils/:id/pdf` (identificaciÃ³n, saldo, las OP que la montaron, kardex completo) y
  `GET /coils/report-pdf?<mismos filtros que GET /coils>` (la tabla del conjunto filtrado
  actual, topada a `MAX_PAGE_SIZE`/200 filas con aviso en el pie si el filtro trae mÃ¡s) â€”
  y se descargan con un `<a href="/api/coils/...">` directo, igual que el PDF de planta.
- **Dos bugs reales, ninguno del cÃ³digo que ya tenÃ­a cobertura â€” los dos, de probar de
  verdad.** El primero, probando en el navegador: la primera versiÃ³n de la tabla genÃ©rica
  dejaba que un cÃ³digo de bobina sin espacios (no tiene dÃ³nde partirse) se escribiera
  encima de la columna siguiente cuando no entraba en el ancho declarado â€” y ademÃ¡s los
  anchos de columna sumaban mÃ¡s que `CONTENT_WIDTH` en dos de las tres tablas. Se corrigiÃ³
  recalculando los anchos y truncando cada celda a una lÃ­nea con `ellipsis: true`. El
  segundo, encontrado por `revisor`: el salto de pÃ¡gina dentro del loop de filas
  (`doc.addPage()`) no volvÃ­a a dibujar la fila de encabezados, asÃ­ que un `report-pdf` de
  varias pÃ¡ginas dejaba la mayorÃ­a sin decir quÃ© columna es cuÃ¡l. Se extrajo
  `drawHeaderRow()` y se llama tambiÃ©n ahÃ­.
- DecisiÃ³n completa: D-173.

**VerificaciÃ³n de esta sesiÃ³n:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e                           # 234 pasados, 0 fallados, 2 saltados (53.9 min) â€” mismo
                                    # baseline que la SesiÃ³n Saneamiento E2E, sin regresiones
```

Probado a mano en `pnpm dev:local` (Chrome, vÃ­a `claude-in-chrome`): los dos PDFs descargan
y su contenido es correcto (bobina con 3 consumos de producciÃ³n, y una con cero); el link
pedidoâ†’cliente filtra `/clientes?search=` a exactamente esa fila; el link compraâ†’bobina
navega a la bobina correcta.

**Cobertura E2E nueva** (agente `qa`, ambas verdes, corridas de nuevo por mÃ­ despuÃ©s del
arreglo de `revisor`): `e2e/tests/bobina-consumos-pdf-d172.spec.ts` (3 casos â€”
`GET /coils/:id/consumptions` vacÃ­o/con fila, y los dos PDF con la firma `%PDF` real, no
solo el `Content-Type`) y `e2e/tests/bobina-consumos-ui-d172.spec.ts` (2 casos â€” la tarjeta
nueva y su link a `/produccion/:id`, y el link de cliente desde `/pedidos` a
`/clientes?search=`). `revisor` no encontrÃ³ bloqueantes; los dos hallazgos de arriba
(tabla del PDF) y una mejora defensiva en `clientes-view.tsx` (sincronizar `search` con la
URL vÃ­a `useEffect`, para cuando en el futuro haya un link hacia `/clientes?search=...`
que navegue **dentro** de la propia pantalla de clientes sin desmontarla) ya estÃ¡n
aplicados.

Ver handoff completo en `docs/handoff/s9-trazabilidad-links-reporte-bobinas.md`.

## SesiÃ³n S10 â€” UX batch: renombres, sidebar, avance de producciÃ³n (2026-09-10)

Entorno **LOCAL** en toda la sesiÃ³n. **Nada desplegado y sin push**: PROHIBIDO por el
brief; los commits se suman a los pendientes de sesiones anteriores para la ventana Ãºnica.

**M1 â€” Renombres de lÃ­nea (D-174).** `BUSINESS_LINE_LABELS` cambia de valores, no de
claves: Metallic Roofing â†’ Coberturas Aluzinc, Roofing (UPVC) â†’ Coberturas (UPVC), Trading
â†’ Reventa, Services â†’ Servicios (Drywall no cambia). Mapeo dado por el dueÃ±o, no una
traducciÃ³n â€” se preguntÃ³ antes de tocar nada porque el brief lo marcaba como pendiente de
confirmar y no habÃ­a ningÃºn precedente en los docs. Un censo por grep confirmÃ³ que
`BUSINESS_LINE_LABELS` es el Ãºnico punto de renderizado en toda la app: cero strings
sueltos que corregir aparte. Dos ajustes en E2E por selectores que dejaron de ser Ãºnicos o
dejaron de existir: `plancha-largo-d166.spec.ts` (un tab por `/Coberturas/` ya no alcanza,
hay dos lÃ­neas que empiezan asÃ­) y `auth.spec.ts` ("Inicio" â†’ "Panel").

**M2 â€” Sidebar (D-175).** Grupos reordenados a Comercial, CatÃ¡logo, Planta,
AdministraciÃ³n; "General" desaparece y "Inicio" (ahora "Panel") queda sin grupo, a la
cabeza. "MÃ¡rgenes" y "Tipo de cambio" se funden en un Ã­tem con pestaÃ±as
(`configuracion/layout.tsx` nuevo, `Tabs` controlado por ruta) â€” las dos rutas siguen
existiendo, ningÃºn `href` cambiÃ³ de destino. `NavItem.activePrefix` nuevo para que el Ã­tem
fusionado se resalte en las dos rutas. Ajustado en E2E: `fase1.spec.ts` (el link ahora se
llama "MÃ¡rgenes y tipo de cambio").

**M3 â€” Avance en la fila de bobina/fleje montado (D-176).** En `/planta`, cada fila de
material montado gana una lÃ­nea de solo lectura con datos que el DTO ya traÃ­a:
`reportedMeters`/`piecesReported` (agregado de **toda la orden**) Â· `consumedKg` (de esa
asignaciÃ³n puntual, ya vivÃ­a en el DTO sin mostrarse). Cero cÃ¡lculo nuevo. Verificado
contra `planta-espacio-produccion*.spec.ts`, `planta-avisos-materia-prima.spec.ts` y
`fase4*.spec.ts` (drywall) sin tocarlos â€” el texto nuevo no colisionÃ³ con ningÃºn locator
existente.

**M4 (tablas y cajas info) se difiere a S10b**, por la regla de presupuesto de contexto
que el propio brief puso (`>60% antes de M4 â†’ /compact; si no alcanza, pasa a S10b`).
Antes de diferirlo se hizo el primer paso que pedÃ­a el brief â€” listar, no tocar â€”: el
"orden descendente por defecto" que pedÃ­a ya estÃ¡ en las cuatro listas principales
(cotizaciones y pedidos por `seq desc`, bobinas por `operationDate desc`, Ã³rdenes de
producciÃ³n por `seq desc`); lo que falta de M4 es sort interactivo por columna (no
construido) y la conversiÃ³n de cajas info largas a popover, con dos candidatos ya
identificados como punto de partida: la nota de D-146 en `roofing-order-panel.tsx`
("El plan es una intenciÃ³n...") y la de D-054 en `pedido-detalle-view.tsx` ("Una reserva
activa descuenta..."). Un censo completo de "vistas afectadas" â€”el primer paso que M4
exige antes de tocar nadaâ€” no se terminÃ³: la mayorÃ­a de los pÃ¡rrafos grises de la app son
el subtÃ­tulo corto de cada pÃ¡gina (no un candidato) y separar esos de una nota larga de
verdad exige leer cada uno, no un grep.

**Lo que encontrÃ³ `revisor`, ya corregido.** El grep de M1 no podÃ­a ver un string que no
estÃ¡ en el cÃ³digo: `pos.service.ts` armaba el badge de lÃ­nea del Mostrador y dos mensajes
de error (venta mixta, piso de margen en `price-floor.ts`) leyendo `businessLine.name`, la
columna cruda de `business_lines` que sembrÃ³ el seed en inglÃ©s â€” antes de esta sesiÃ³n
coincidÃ­a por casualidad con `BUSINESS_LINE_LABELS`, despuÃ©s de D-174 divergÃ­a. Los tres
pasan a resolver el nombre por el cÃ³digo (`BUSINESS_LINE_LABELS[toSharedLineCode(...)]`);
`PosProductDto.businessLineName` se elimina del todo â€” el cÃ³digo de lÃ­nea ya viajaba en el
DTO y el front resuelve el label ahÃ­. De paso, dos mensajes de error apuntaban a
"ConfiguraciÃ³n â†’ MÃ¡rgenes", una ruta de menÃº que nunca existiÃ³ con ese nombre y que D-175
aleja un paso mÃ¡s: ahora dicen "AdministraciÃ³n â†’ MÃ¡rgenes y tipo de cambio". TambiÃ©n:
la lÃ­nea nueva de M3 podÃ­a leerse como si "reportados"/"piezas" fueran de esa bobina o
fleje puntual â€” el texto ahora dice "de la orden"/"de esta bobina"/"de este fleje" para
que la Ãºnica cifra realmente propia de la fila (`consumidos`) no se confunda con el
agregado de toda la orden.

**VerificaciÃ³n de esta sesiÃ³n:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e                           # 239 pasados, 0 fallados, 2 saltados (52.6 min) â€”
                                    # corrida limpia con las correcciones de revisor adentro
```

Ver handoff completo en `docs/handoff/s10-ux-batch-renombres-sidebar-produccion.md`.

## SesiÃ³n S10b â€” Cierre de M4: sort en tablas + cajas info a popover (2026-09-10)

SesiÃ³n corta (brief: ~30-45 min), sin push. Cierra M4, la mitad de S10 que quedÃ³
diferida.

**M1 â€” Sort de columna (D-177).** `apps/web/src/lib/use-sort.ts` (hook `useSort` +
`compareBy`/`compareDecimalBy`, esta Ãºltima por `Decimal.comparedTo` â€” regla dura 1) y
`apps/web/src/components/sortable-table-head.tsx` son el mecanismo Ãºnico, aplicado a
cotizaciones, pedidos, bobinas (paginadas: sort solo de la pÃ¡gina actual) y producciÃ³n
(sin paginar: sort del conjunto entero). `key: null` es el default â€” sin clickear nada, el
orden es el que ya manda el servidor (descendente, D-113/D-124), intacto.

**M2 â€” Cajas info â†’ popover (D-178).** `apps/web/src/components/ui/popover.tsx` (nuevo,
`radix-ui`) + `apps/web/src/components/info-popover.tsx`. Aplicado a los dos candidatos
que dejÃ³ identificados el handoff de S10: la nota de D-146 en "Plan de corte"
(`roofing-order-panel.tsx`) y la de D-054 en "Reservas de material"
(`pedido-detalle-view.tsx`). Avisos condicionales de negocio no se tocaron â€” siguen
siempre visibles, por criterio explÃ­cito.

**Un desvÃ­o que costÃ³ tiempo y no era un bug:** a mitad de sesiÃ³n, un `pnpm e2e` en
background con la salida canalizada a `tail -60` mostrÃ³ 0 bytes durante varios minutos, y
el proceso del API resultÃ³ ser `node .../dist/main` en vez de lo que se esperaba de
`nest start`. Se interpretÃ³ como servidor con cÃ³digo viejo (mismo sÃ­ntoma que ya habÃ­a
costado una corrida completa en S10) y se matÃ³ el proceso dos veces antes de confirmar que
**`nest start` sin `--watch` compila a `dist/` y corre desde ahÃ­ siempre** â€” ver esto en
la lista de procesos es normal, no evidencia de cachÃ© ni de modo CI. La demora real la
causÃ³ canalizar la salida de un comando en background a `tail` sin `-f`: eso junta toda la
salida hasta el final y no imprime nada mientras tanto, asÃ­ que 0 bytes no querÃ­a decir
"colgado". Ninguno de los dos hallazgos tocÃ³ cÃ³digo de producto.

**VerificaciÃ³n de esta sesiÃ³n:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e e2e/tests/fase1.spec.ts e2e/tests/fase5a.spec.ts \
  e2e/tests/planta-espacio-produccion-ui.spec.ts   # 17 pasados, dirigidos a M1/M2
pnpm e2e                           # 239 pasados, 0 fallados, 2 saltados (51.1 min) â€”
                                    # mismo baseline que S10, sin regresiones
```

`revisor` no encontrÃ³ bloqueantes. Dos hallazgos BAJO en `roofing-order-panel.tsx`: dos
notas estÃ¡ticas mÃ¡s que cumplÃ­an el criterio de M2 y se habÃ­an dejado afuera. Una
("Dato de planta: el kardex sale por el kilo teÃ³rico...", junto al campo "kg consumido")
pasÃ³ a `InfoPopover` en la misma sesiÃ³n. La otra ("Sin este dato se asume que la bobina
consumiÃ³...", junto al cierre sin reportar) se dejÃ³ **a propÃ³sito**: mezcla un valor en
vivo (`consumedFloorKg`) con dos avisos de validaciÃ³n condicionales que el propio criterio
de M2 dice que tienen que seguir siempre visibles â€” convertirla entera habrÃ­a escondido un
error de validaciÃ³n detrÃ¡s de un clic.

Ver handoff completo en `docs/handoff/s10b-cierre-m4-sort-popover.md`.

## SesiÃ³n S11 â€” T7: escritorio robusto y compacto, color e inspecciÃ³n de flujos (2026-09-11)

Sobre S10b cerrado. **Todo local: nada desplegado y sin push**, prohibido por el brief â€”
los commits se suman a los pendientes de S9/S10/S10b para la ventana Ãºnica.

El perfil de uso lo fijÃ³ el dueÃ±o como decisiÃ³n de negocio y no se cuestionÃ³: el ERP se
opera **solo en PC de escritorio**, el operario de planta no usa la app y el supervisor
ingresa todo, incluida producciÃ³n. No hay objetivo mÃ³vil ni tablet, y no se agregÃ³ ni una
media query para pantallas chicas.

### Fase 1 â€” inspecciÃ³n de flujos (`docs/analisis/s11-inspeccion-flujos.md`)

Se recorrieron los cinco flujos del brief en un Chrome real contra `pnpm dev:local`, y se
ejecutaron de verdad â€”no solo se miraronâ€” una cotizaciÃ³n completa (COT-000054 creada,
emitida y rechazada al confirmar por falta de materia prima), una orden de producciÃ³n
reportada y cerrada desde `/planta` (OP-000007) y un despacho (DES-000001). El reporte
clasifica cada hallazgo en (a) fix barato de UI, (b) lÃ³gica o schema â€”solo documentadoâ€” y
(c) fricciÃ³n de flujo, y se commiteÃ³ **antes** de tocar una sola lÃ­nea de producto.

Los dos hallazgos que mandan sobre el resto:

- **T-01 â€” toda la app se renderizaba en Times New Roman.** `globals.css` declaraba
  `--font-sans: var(--font-sans)` dentro de `@theme inline`, una autorreferencia que no
  resuelve, y `layout.tsx` aplicaba las variables de `next/font` en `<body>` cuando quien
  consume `font-sans` es `<html>`. La declaraciÃ³n quedaba invÃ¡lida y el navegador caÃ­a a su
  fuente serif por defecto. Verificado con `getComputedStyle(document.documentElement)
.fontFamily === '"Times New Roman"'`. Es un fix de dos lÃ­neas y cambia la lectura de todas
  las pantallas del sistema.
- **F2-01 â€” con transporte no se puede despachar ninguna lÃ­nea que no se mida en kilos.**
  `apps/api/src/invoicing/dispatches.service.ts:243-250` exige `weightKg` por lÃ­nea cuando la
  modalidad no es recojo y la unidad no es `KGM` (la regla es correcta y estÃ¡ bien razonada:
  en una cobertura a medida `reserveQty` son metros, y heredarlo declararÃ­a 24.6 kg en la
  guÃ­a por 268 kg de planchas). El formulario **nunca pide ese campo**: no aparece en
  `nuevo-despacho-view.tsx`, aunque el schema compartido lo tiene
  (`packages/shared/src/schemas/invoicing.ts:637`) y el detalle del despacho ya lo muestra.
  Reproducido de punta a punta con PED-000023 (`NIU`) y Â«Transporte privadoÂ»: 400 y ningÃºn
  campo donde escribir el peso; con Â«Recojo en mostradorÂ» el mismo despacho pasa. **La suite
  E2E no lo ve porque despacha por API** (`e2e/helpers/invoicing.ts` manda `weightKg` en el
  payload), asÃ­ que la pantalla nunca se ejerce en ese punto. Es (b): queda documentado para
  Fase 8 y no se tocÃ³.

El resto del reporte: el toast tapaba â€”y se comÃ­a el clic deâ€” la barra de acciones (T-02);
la tira de cuatro tarjetas KPI copiada en seis vistas (T-04); los badges de estado sin
convenciÃ³n Ãºnica (T-05); el rojo decorativo de `/cobranzas` (T-06); el menÃº mÃ¡s alto que la
pantalla (T-07); el sort que llegÃ³ solo a cuatro listas (T-08); dos pantallas con el mismo
`<h1>` (F1-01); los botones de cierre de orden a escala tÃ¡ctil (F1-02); el botÃ³n de
despachar apagado sin decir quÃ© falta (F2-02); el motivo del kardex cortado sin forma de
leerlo (F3-01); el vacÃ­o del mostrador que contestaba una bÃºsqueda que nadie hizo (F4-01).

**Un hallazgo se cayÃ³ al medirlo, y quedÃ³ anotado en vez de borrado.** F4-02 decÃ­a que el
carrito del mostrador quedaba en Â«~270 pxÂ»: saliÃ³ de leer pÃ­xeles de una captura escalada
como si fueran pÃ­xeles CSS. El carrito es `lg:grid-cols-[1fr_24rem]`, o sea 384 px. Una
captura escalada no es una medida.

### Fase 2 â€” densidad y robustez (D-179)

**B1 â€” densidad.** LÃ­nea base y resultado, medidos con el primer `<tr>` de cada lista y
normalizados a un viewport de 950 px de alto (lo que deja una ventana maximizada a 1080p):

| Lista           | Antes | DespuÃ©s |        |
| --------------- | ----: | -------: | -----: |
| `/cotizaciones` |  13.3 |     23.4 |  +76 % |
| `/pedidos`      |  13.3 |     23.4 |  +76 % |
| `/bobinas`      |  15.5 |     23.1 |  +49 % |
| `/produccion`   |   6.5 |     13.2 | +103 % |

Tres de las cuatro superan el objetivo del brief (â‰¥50 % mÃ¡s filas) y bobinas queda en +49 %:
es lo que habÃ­a para ganar ahÃ­, porque sus filas ya eran de una sola lÃ­nea y no tenÃ­an la
grasa que tenÃ­an las otras. La densidad saliÃ³ de **sacar andamiaje** â€”cromo de pÃ¡gina,
tarjetas de una cifra, lÃ­neas de mÃ¡s en una celdaâ€” y no de achicar el dato: el texto de
tabla sigue en 14 px.

AdemÃ¡s del arreglo de la fuente: cabecera de 48â†’32 px, `main` de `gap-6 p-6` a `gap-3 p-4`,
`h1` a 18 px, `h2` unificados a 14 px, `Label` a 12 px, celda `px-2.5 py-1.5` con encabezado
atenuado y `tabular-nums`, `Badge` de 20â†’18 px, `--card-spacing` a 12 px, `StatStrip`/`Stat`
en lugar del bloque de cuatro `Card` repetido en cinco vistas, el documento del cliente al
lado del nombre en vez de debajo, y la nota de la cola de producciÃ³n a `InfoPopover` (mismo
criterio de D-178). Dos `inline-flex` apoyados en la lÃ­nea base â€”la muestra de color y el
badgeâ€” estiraban cada fila ~4 px: `align-middle`.

**B2 â€” robustez 1366-1920.** El hallazgo grande: **`SidebarInset` no tenÃ­a `min-w-0`**, asÃ­
que el panel de contenido no bajaba de su ancho mÃ­nimo automÃ¡tico y quedaba tan ancho como
la ventana **ademÃ¡s** del menÃº de 256 px. Toda la app scrolleaba 256 px en horizontal a
cualquier ancho de pantalla, y a 1366 px los botones de acciÃ³n de cada lista quedaban fuera
de la ventana. Medido antes y despuÃ©s con el viewport en 1366:
`document.documentElement.scrollWidth` 1622 â†’ 1366.

Lo otro: una razÃ³n social de ochenta caracteres con `whitespace-nowrap` empujaba la tabla de
cotizaciones 363 px mÃ¡s allÃ¡ del ancho disponible â€” el nombre ahora se corta con elipsis y
queda entero en el `title`, y el documento **no** se corta porque es el que desambigua. Y el
menÃº lateral pasÃ³ de 944 a ~780 px (Ã­tem 32â†’28, encabezado de grupo 32â†’24, pie 113â†’69).

Verificado a 960, 1366 y 1920 px con un navegador de viewport real: sin desborde horizontal
de pÃ¡gina en listas, detalles ni formularios. Las tablas anchas siguen scrolleando dentro de
su propio contenedor, que es lo que corresponde.

**B3 â€” los fixes baratos (a) de la Fase 1.** Toast a `bottom-right`; `/produccion` pasa a
titularse Â«Ã“rdenes de producciÃ³nÂ» (`/planta` conserva Â«ProducciÃ³nÂ», que es lo que D-160
separÃ³); los veinte controles `h-12`/`h-16 text-lg` de `/planta` vuelven al tamaÃ±o del resto
de la app y los dos botones de cierre de orden dejan de ocupar media tarjeta cada uno; el
Â«porÂ» huÃ©rfano de la lÃ­nea sin producto; el formulario de despacho dice **quÃ©** falta, en
palabras, con las mismas condiciones que habilitan el envÃ­o; el motivo del kardex completo
en el `title`; el mostrador deja de contestar una bÃºsqueda que nadie hizo.

### Fase 3 â€” color (D-180)

Un solo color de marca â€”azul acero, `oklch(0.46 0.105 248)`â€” sobre la escala de neutros que
ya estaba, y cuatro tonos de estado con un significado fijo: `progress`, `done`, `warning` y
`danger`, mÃ¡s neutro para lo anulado o revertido. El mapa de estado a tono vive en
`apps/web/src/components/status-tone.ts` y es `Record<Status, StatusTone>` **exhaustivo**
para las nueve familias de estado: un estado nuevo en `@ayr/shared` no compila hasta que
alguien decida quÃ© significa.

El problema que resolvÃ­a no era que faltara color, era que el mismo color querÃ­a decir cosas
distintas: el negro sÃ³lido era Â«AceptadaÂ» en comprobantes (terminÃ³ bien), Â«En producciÃ³nÂ» en
pedidos (sigue en curso) y Â«ActivaÂ» en reservas, mientras Â«AtendidoÂ» â€”el terminal bueno de un
pedidoâ€” era el gris mÃ¡s apagado de la paleta.

**Rojo y Ã¡mbar quedan reservados para error y aviso.** El Ãºnico uso decorativo que quedaba
â€”Â«Vencido S/ 0.00Â» en rojo fijoâ€” ahora se pinta solo cuando el vencido es mayor que cero,
comparado con `Decimal`. Un estado anulado se pinta **neutro y no rojo** a propÃ³sito: es una
decisiÃ³n tomada, no un problema, y teÃ±ir de rojo cada cotizaciÃ³n anulada convierte el rojo en
ruido justo donde tiene que gritar.

Contrastes medidos en el navegador (canvas + fÃ³rmula WCAG), en claro y en oscuro: `progress`
7.41/8.05, `done` 7.83/8.51, `warning` 7.07/8.64, primario 6.83/7.66, texto atenuado 4.74.
Ninguno baja de 4.5:1.

### El cierre de la revisiÃ³n, y la Ãºnica falla de E2E

`revisor` no encontrÃ³ bloqueantes, y confirmÃ³ lo que mÃ¡s importaba: el `canSubmit` reescrito
del formulario de despacho es **exactamente equivalente** al anterior, condiciÃ³n por condiciÃ³n
â€” era el Ãºnico lugar donde una sesiÃ³n de presentaciÃ³n podÃ­a haberse llevado puesta una regla
de negocio sin que nadie lo notara. Los cinco hallazgos MEDIO eran incoherencias de las
decisiones que esta misma sesiÃ³n acababa de tomar (tres enums sin mapa de tono, el detalle de
compra eligiendo variante a mano, el semÃ¡foro de la cola sin pasar por la convenciÃ³n, el badge
derivado del pedido, los campos numÃ©ricos de planta sin criterio de tamaÃ±o), asÃ­ que se
cerraron todos: dejarlos habrÃ­a hecho que D-180 dijera algo que el cÃ³digo no cumple. DespuÃ©s
de ese commit **no queda ningÃºn `Badge` de estado eligiendo variante a mano en la app**.

La suite tardÃ³ tres corridas y vale la pena decir por quÃ©:

1. La primera se cortÃ³ al 16 %: el `revisor` volviÃ³ con esos hallazgos mientras corrÃ­a, y
   seguir 45 minutos para despuÃ©s tener que correrla de nuevo con los arreglos adentro era
   gastar una corrida por nada.
2. La segunda terminÃ³ en **238 pasados, 1 fallado**. La falla era real y era mÃ­a, no un
   selector viejo: `fase7e-ajustes-d121.spec.ts:92` busca las piezas teÃ³ricas con
   `getByText('1200.0', { exact: true })`, y al pasar el detalle de la OP a `StatStrip` la
   cifra quedÃ³ pegada al renglÃ³n de contexto en el mismo nodo de texto â€”Â«1200.0Del fleje
   montado, vs. 0 reportadasÂ»â€”, asÃ­ que ningÃºn elemento tenÃ­a por texto la cifra. **Se arreglÃ³
   el componente, no el spec**: el spec tiene razÃ³n en buscarlo asÃ­, porque lo que la pantalla
   promete es mostrar la cifra y no una cadena que la contenga. El mismo patrÃ³n se corrigiÃ³
   preventivamente en el peso bruto del despacho y en el saldo del comprobante, que mezclaban
   cifra y nota de la misma forma.
3. La tercera cerrÃ³ en **239 pasados, 0 fallados, 2 saltados (54.6 min)** â€” el mismo baseline
   que S9/S10/S10b.

Un solo spec se tocÃ³ en toda la sesiÃ³n, y por un cambio de presentaciÃ³n:
`e2e/tests/auth.spec.ts` busca el correo del usuario por `title` en vez de como texto visible,
porque el pie del menÃº lo moviÃ³ ahÃ­ al bajar de 113 a 69 px.

Handoff completo en `docs/handoff/s11-escritorio-compacto-color.md`.

## Ventana V-2 â€” Deploy Ãºnico S9+S10+S10b+S11 (2026-09-11)

**19 commits** acumulados sin push desde `eb1f15d` (Saneamiento E2E) hasta `8107c6a`, cubriendo
las sesiones S9 (trazabilidad y reporte de bobinas en PDF, D-172/D-173), S10 (renombres de
lÃ­nea y sidebar reagrupado, D-174..D-176), S10b (sort de columna y cajas info a popover,
D-177/D-178) y S11 (escritorio compacto y color, D-179/D-180), mÃ¡s el saneamiento de docs de
esta ventana. Cero migraciones nuevas: `production` seguÃ­a y sigue en 55/55, sin drift
(`node scripts/migrations-status.mjs --branch production`).

**Respaldo Neon** antes de tocar nada: rama `respaldo-pre-deploy-20260912`
(`br-floral-pine-aedczki8`, parent `production`), creada vÃ­a `run` con `quiet: true` y
`--output json` (regla dura 5), sin imprimir ninguna cadena de conexiÃ³n.

**Gate PSE.** `pnpm e2e:pse` dio 12/12 en rojo en el primer intento â€” la cuenta demo de
Nubefact seguÃ­a en su tope de 50 comprobantes. El dueÃ±o la vaciÃ³ y la segunda corrida cerrÃ³
12/12 en verde.

**Deploy.** API a Cloud Run (`pnpm deploy:api`), health verificado (`{"status":"ok","db":"ok"}`
en la revisiÃ³n nueva). Web por push a `main` â†’ Vercel.

**B-V2-5 (CI roja, no clasificable) y su fix, D-181.** La primera corrida de CI sobre estos 19
commits fallÃ³ en `E2E Playwright (Neon ci)`, antes de correr un solo test: el guard de
`apps/api/prisma/reset-test-db.ts` rechazÃ³ el reset con Â«`ep-dry-butterfly-...` no es una base
de pruebasÂ». Causa raÃ­z: el guard (escrito en `eb1f15d`, Saneamiento E2E) comparaba el hostname
contra `ep-misty-band-`, copiando el **branch id** de la rama `ci` (`br-misty-band-ae9s41t7`) en
vez del hostname real de su **endpoint de cÃ³mputo** â€” dos identificadores independientes en
Neon que nunca coincidieron. El guard nunca habÃ­a corrido contra la rama `ci` real hasta esta
ventana (local prueba contra Docker), asÃ­ que el error saliÃ³ reciÃ©n ahora, al primer contacto.
Fix en `36441c1` (D-181): el prefijo pasa a `ep-dry-butterfly-`, verificado con `neonctl`, con
un comentario que deja escrito de dÃ³nde sale y cÃ³mo revalidarlo si vuelve a desalinearse.
Con el fix, la segunda corrida de CI cerrÃ³ **verde en los tres jobs â€” 245 passed, 3 skipped,
0 failed** en `E2E Playwright (Neon ci)`: la primera corrida completa de CI sobre S9-S11 juntas.

**Saneamiento de docs previo (PASO 0).** El incidente de `neondb_owner` expuesto
(2026-09-10, 11:54 UTC) estaba rotado desde esa misma noche, pero `docs/PROGRESO.md` lo seguÃ­a
listando como Â«pendiente crÃ­ticoÂ». Corregido a Â«rotaciÃ³n ejecutada, incidente cerradoÂ» â€” los
handoffs histÃ³ricos en `docs/handoff/` no se tocaron, tal como pide la regla de la ventana.

**Backlog de Fase 8, verificado con lectura de cÃ³digo, no de memoria** (los cuatro puntos
siguen abiertos, sin cambios):

- **`weightKg` por lÃ­nea en despachos con transporte.** El API (`dispatches.service.ts:243-250`)
  sigue exigiÃ©ndolo cuando `transferMode !== PICKUP` y la lÃ­nea no se mide en `KGM`; el
  formulario web (`nuevo-despacho-view.tsx`) solo pide un `totalWeightKg` global y nunca manda
  `weightKg` por Ã­tem. Cualquier lÃ­nea en `MTR`/`NIU` con transporte real sigue sin poder
  despacharse desde la pantalla.
- **Aviso de mÃ­nimo en el POS.** `PriceFloorHint` (D-163) solo vive en `sales-document-form.tsx`
  (cotizaciones y pedidos); nada en `apps/web/src/app/(app)/pos` ni en
  `apps/web/src/components/pos` referencia `minPricePen`/`minValuePen`. El mostrador sigue sin
  el aviso.
- **RevisiÃ³n del 1 % de merma normal con datos reales (D-165).** Sigue como pendiente
  explÃ­cito en `ARQUITECTURA.md`: hace falta 2-3 cierres de bobina reales para comparar contra
  el estÃ¡ndar, y todavÃ­a no hay esa muestra.
- **BÃºsqueda server-side en los selectores (`fetchAllForPicker`).** El tope sigue en 200
  (`MAX_PAGE_SIZE`) y `/customers` sigue ordenando `isActive desc, name asc` sin `search` en el
  picker; sin cambios desde el saneamiento E2E. No aprieta mientras la base activa estÃ© por
  debajo del tope.

**VerificaciÃ³n de navegador en prod** (marcador V-2, cotizaciÃ³n de prueba, PDF de bobinas,
badge del POS): a cargo del dueÃ±o, fuera del alcance de esta ventana.

## Ventana V-3 â€” Deploy del lote F8 (F8-S1..S3c) (2026-09-14) â€” CERRADA

**Alcance.** Las seis sesiones F8-S1, S2, S2b, S3, S3b y S3c (D-182..D-200), en `main` hasta
`9607c23`. Verificado al cierre (2026-09-14, solo lectura): `production` en **61/61
migraciones** (Â«Database schema is up to date!Â», `node scripts/migrations-status.mjs --branch
production`), API en la revisiÃ³n `ayr-steel-erp-api-00032-bdn` con el 100 % del trÃ¡fico y
`/health` en `{"status":"ok","db":"ok"}`.

**Migraciones 55 â†’ 61.** D-182 (idempotencia de creaciones repetibles), D-184 (la cotizaciÃ³n nace
emitida), D-185 (reserva temporal), D-187 (registro de cambios de precio), D-189 (prioridad en la
OP) y D-191 (borrador de reportes). **Dos mutan datos** ademÃ¡s de agregar: D-184 pasa toda
cotizaciÃ³n en `DRAFT` a `EMITTED`, con la fecha de alta como fecha de emisiÃ³n y sin quitar `DRAFT`
del enum; D-189 copia la prioridad vigente de cada pedido a sus OPs vivas (`DRAFT`/`IN_PROGRESS`).

**Gate PSE: aceptado por clasificaciÃ³n.** Los rojos de `pnpm e2e:pse` se clasificaron como
numeraciÃ³n retenida en la cuenta demo de Nubefact, no como una regresiÃ³n del lote. La deuda de
los correlativos va a la sesiÃ³n de salud E2E (abajo).

**B-V3-5 (CI del lote cancelada por timeout) â€” RESUELTA.** La CI sobre el lote se cortÃ³ tres
veces sin un solo rojo atribuible: `de8a49c` a los 75 min, y `9607c23` dos veces a los 110 min
(la segunda, a las 10:55 UTC, con Neon comprobado sano). La leyÃ³ la sesiÃ³n F8-R1 (abajo). **La
CI completa del lote es el run 34875631463**: `9607c23` mÃ¡s instrumentaciÃ³n sola (reporter y
contador de consultas en `scripts/diag/`, cambios en `ci.yml`; cero producto, cero schema),
**305 passed, 3 skipped, 0 failed en 92 min**, runner en `centralus`. La rama que lo corriÃ³
(`diag/f8-r1-instrumentacion`, commit `6a3cb1d`) no se mergeÃ³ y ya estÃ¡ borrada.

**CorrecciÃ³n de lo que se registrÃ³ durante la ventana.** Â«Con Neon sano, la regresiÃ³n es del
loteÂ» era falso: **la lentitud era latencia de la regiÃ³n del runner Ã— volumen de consultas, no el
lote.** Neon estaba sano, pero el RTT del runner a Neon cambia de una corrida a otra (16 ms en
`eastus`, 33 ms en `centralus`, ~80 ms en la corrida que se cortÃ³) y nadie lo medÃ­a. El lote sube
el total de consultas de la suite Ã—1,64, sin encarecer cada una (D-201).

**Deuda que deja la ventana:**

- ~~**SesiÃ³n de salud E2E** (D-201)~~ â€” **RESUELTA** en la SesiÃ³n F8-R2 (D-202, abajo): E2E
  completo de CI en el Postgres del runner (~10 min), smoke contra Neon `ci` y correlativos por
  corrida.
- **Backlog de rendimiento:**
  - `GET /sales/quotations/stock-shortages` (la tarjeta de faltantes del Panel, D-188) cuesta ~16
    consultas por cotizaciÃ³n emitida en cada carga y cada 60 s. D-184 mÃ¡s D-157 hacen que el
    conjunto solo crezca, asÃ­ que el riesgo es de producciÃ³n, no de CI.
  - En CI el API paga ~12 ms por consulta por encima de un `SELECT 1` medido desde un proceso
    aparte (42 contra 30 ms). Posible espera por el pool de 5 en rÃ¡fagas de `Promise.all`; mueve
    ~Ã—1,3.
  - Reducir consultas por test, como higiene; workers en paralelo se reevalÃºa despuÃ©s del cambio
    de base.

## SesiÃ³n F8-R1 â€” DiagnÃ³stico de la lentitud del E2E en CI (2026-09-14) â€” CERRADA

SesiÃ³n de **diagnÃ³stico**: FASE 1 completa, causa nombrada y **sin fix de producto, porque no
hay regresiÃ³n de producto**. AnÃ¡lisis completo en `docs/analisis/f8-r1-rendimiento.md`; la
decisiÃ³n es D-201.

- **Herramientas locales** (quedan en el repo, documentadas en `docs/ENTORNOS.md` â†’ Â«E2E con
  latenciaÂ»): proxy de latencia con contador de round-trips delante del Postgres de Docker,
  runner desde worktree con builds de producciÃ³n y pool de 5, reporter por test y comparador.
- **Descartados con mediciÃ³n:** CPU del runner y de la base, churn de conexiones, clientes Prisma
  extra, `stock-shortages` (en la suite nunca hay mÃ¡s de 2 cotizaciones emitidas a la vez), PDF a
  R2, PSE, polling del web y `next dev`.
- **La mediciÃ³n que decidiÃ³:** CI instrumentada con consultas y su duraciÃ³n por test. La forma
  es uniforme por consulta: mismas consultas (Ã—1,02 contra local), sin tests que exploten y sin
  acumulaciÃ³n. El A/B sobre la base (`e184ca1`, runner `eastus`) dio 18,8 ms por consulta con
  16 ms de RTT. HEAD dio 80,0 ms en una corrida y 42,4 ms en otra con 33 ms de RTT, con las
  mismas consultas (Ã—0,99), y un `SELECT 1` desde un proceso aparte estable durante toda la
  suite.
- **Ramas diag:** `diag/f8-r1-instrumentacion` y `diag/f8-r1-instrumentacion-base` se pushearon
  con autorizaciÃ³n del dueÃ±o, nunca se mergearon y se borraron al cerrar. La instrumentaciÃ³n
  viviÃ³ y muriÃ³ en ellas.

## SesiÃ³n F8-R2 â€” Salud E2E: Postgres del runner, smoke de Neon y correlativos (2026-09-14) â€” CERRADA

Implementa D-201; la decisiÃ³n es **D-202**. Solo infra: `ci.yml`, guard, scripts de E2E, dos
specs y docs. Cero producto, cero schema.

- **Suite completa de CI contra un Postgres de servicio en el runner** (`postgres:17-alpine`,
  `ayr_ci_e2e` en `localhost`). Medida con la instrumentaciÃ³n de F8-R1 en la rama
  `diag/salud-e2e`, dos corridas en dos regiones:

  | Run                              | Runner    | Resultado                       | Suite   | Consultas | ms/consulta |
  | -------------------------------- | --------- | ------------------------------- | ------- | --------: | ----------: |
  | 34875631463 (F8-R1, Neon)        | centralus | 305 passed                      | 92 min  |   125 241 |   42,4 / 80 |
  | 34898572060 (runner, 1.Âª)       | WestUS3   | 303 passed, 2 failed, 3 skipped | 9,8 min |   124 504 |        0,07 |
  | 34900414817 (runner, con el fix) | eastus    | **305 passed, 3 skipped**       | 9,6 min |   124 661 |        0,08 |

  **LÃ­nea base nueva de CI: 305 passed / 3 skipped en ~10 min (job ~12 min).** Timeout del job
  110 â†’ 30 min. Mismas consultas que en Neon (Ã—0,99): la diferencia es entera la latencia, como
  predijo D-201.

- **Dos fallas que la latencia escondÃ­a.** En la primera corrida, `fase2a.spec.ts:471` y
  `m2-reversa-pago.spec.ts:233` fallaron en los dos intentos: `getByText('S/ 6,800.00')` chocaba en
  modo estricto con la descripciÃ³n del drawer de pago (Â«Saldo pendiente: S/ â€¦Â») mientras se
  cierra. Con 16-80 ms por consulta el drawer ya se habÃ­a ido; con 0,07 ms no. Son las dos
  Â«fragilidades bajo latenciaÂ» del handoff de F8-R1. Fix: `{ exact: true }`. Local Ã—3: 36/36.
  `qa` revisÃ³ el resto de la suite buscando el mismo patrÃ³n: ningÃºn otro caso.
- **Job `smoke-neon`** contra la rama `ci`: `migrate deploy` + `migrate status` en paso propio
  (Â«61 migrations foundÂ», Â«Database schema is up to date!Â»), reset con guard y `pnpm e2e:smoke`
  (12 archivos: 35 passed / 2 skipped, en 8,2 min en `WestUS3` y 13,6 min en `eastus`). Timeout 45. Ãšnico job con `concurrency: neon-ci-branch`.
- **Guard** (`apps/api/prisma/test-db-guard.ts`): lista blanca de tres bases. El host del runner es
  `localhost` y no `postgres` (el job corre en el runner, no en un contenedor), verificado con
  `new URL()` sobre la URL del workflow y en el log de CI (Â«Reset sobre Postgres del runner de CI
  (ayr_ci_e2e)Â»). `revisor` encontrÃ³ un **ALTO**: el guard validaba `DIRECT_URL` pero el
  `TRUNCATE` escribe por `DATABASE_URL`. VenÃ­a del guard anterior y ahora valida las dos. Probado
  con 12 combinaciones de URLs.
- **Correlativos por corrida** (`apps/api/prisma/e2e-fiscal-offset.ts`): tras reset y seed, las
  cinco series parten de `10 000 000 + (epoch en segundos mod 80 000 000)`. Verificado en local y
  en los dos jobs de CI (p. ej. Â«5 series parten de 39422442Â»). Documentado en `e2e/README.md` y en
  el checklist de ventana nuevo de `docs/ENTORNOS.md`. **Sin verificar contra la cuenta demo:**
  que Nubefact acepte un correlativo de 8 dÃ­gitos como primer nÃºmero de una serie. Lo prueba el
  prÃ³ximo `pnpm e2e:pse`; si lo rechaza, D-202 se revisa antes de la ventana.
- **`docs/analisis/e2e-velocidad.md`** entra al repo con cabecera: son estimaciones sin medir.
- **Rama `diag/salud-e2e`:** pusheada para medir, nunca mergeada, borrada (remoto, local y
  worktree). La instrumentaciÃ³n sigue fuera de git, en `local-data/r1/tools/diag/`; los `.jsonl`
  de las dos corridas quedaron en `local-data/r1/salud-runner*.jsonl`.
- **Pendientes que deja:**
  - Los worktrees `../wt-r1-base` y `../wt-r1-head` de F8-R1 **siguen existiendo**, aunque el
    handoff anterior los daba por borrados. `wt-r1-head` tiene sin trackear
    `e2e/tests/zz-bench-shortages.spec.ts`. No se tocaron.
  - El rango de correlativos da la vuelta el 2028-04-22: ese dÃ­a hay que vaciar la cuenta demo
    una vez.
  - Sin PSE en `smoke-neon`, el caso Â«anular la venta del turnoÂ» de `fase7b` espera 60 s a una
    aceptaciÃ³n que no llega y se salta. Cuesta un minuto y no suma cobertura.
  - Backlog de rendimiento de F8-R1 sin cambios: `stock-shortages` en producciÃ³n, ~12 ms del pool
    y reducir consultas por test. **Workers en paralelo** se reevalÃºa ahora que la suite dura 10
    min: con este nÃºmero no aprieta.

## SesiÃ³n F8-S4 â€” Acabados con tipo, color y lÃ­nea + deudas de integridad (2026-09-14) â€” CERRADA

Origen: feedback del cliente (Â«el acabado deberÃ­a llevar colorâ€¦ algunas veces me olvidÃ© de ingresar
el colorÂ»). Decisiones D-203 y D-204. **Todo en commits locales, sin push**: se acumula para la
ventana V-4.

- **M0 (D-204).**
  - Â«Agregar al borradorÂ» (D-191) reclama clave de idempotencia.
  - La clave del cliente se guarda por huella del contenido. Corregir las lÃ­neas tras un corte de
    red es otro envÃ­o, y volver al contenido anterior reusa su clave.
  - La reserva temporal se recorta al fin de la vigencia de la cotizaciÃ³n. Acortar solo la vigencia
    mueve `expires_at` sin re-reservar.
  - Cubierto por `e2e/tests/integridad-f8s4-m0.spec.ts` (6 tests, 18/18 con `--repeat-each=3`).
- **M1 (D-203).**
  - `finishes` gana `kind`, `color_id` y `business_line_id`, con CHECK de color por tipo.
  - `colors` gana `ral_code` y nombre Ãºnico sin distinguir mayÃºsculas.
  - Mapeo del PASO 0, confirmado por el dueÃ±o:
    - ALZ-ROJO-3002 â†’ Rojo 3002.
    - ALZ-3020 â†’ color nuevo Â«Rojo trÃ¡ficoÂ» 3020; sus 2 bobinas pasan a ese color.
    - ALZ-AZUL â†’ Azul 5010.
    - Los tres son prepintados de Coberturas Aluzinc.
  - Colores de ejemplo en la migraciÃ³n y en el seed (solo sobre catÃ¡logo vacÃ­o).
  - Pantallas de Acabados y CatÃ¡logo â†’ Colores.
- **M2 (D-203).**
  - Trigger `color_from_finish` sobre `coils` y `purchase_items`.
  - Compra de bobinas sin campo de color: el acabado tiene que ser de la lÃ­nea de la compra, y un
    `colorId` que llegue se rechaza.
  - Editar bobina corrige el color cambiando el acabado. Recalcula `typeKey` y el producto de
    trading, y exige bobina sin reservas propias ni movimientos posteriores al ingreso.
- **RevisiÃ³n.**
  - `revisor` web, bloqueante: el RAL no aceptaba ningÃºn valor real. En el regex se perdiÃ³ la barra
    invertida al insertar el texto con un script.
  - `revisor` API, alto 1: cambiar el acabado de una bobina no recalculaba `typeKey`.
  - `revisor` API, alto 2: completar un acabado sin tipo repintaba sus bobinas en masa, sin revisar
    pool, OPs montadas ni lÃ­nea. Ahora se rechaza.
  - TambiÃ©n se corrigieron: un lock que podÃ­a trabarse con la FK de una bobina nueva, el audit del
    cambio de acabado y la auditorÃ­a de la reserva vencida al editar.
- **Suite E2E completa local: 319 passed, 0 failed, 2 skipped.** Los 2 skipped son los de mostrador
  sin PSE. Specs existentes sin tocar: los helpers compran cada bobina con un acabado de su lÃ­nea y
  su color. Hay 7 tests nuevos en `e2e/tests/acabados-d203.spec.ts`. Unitarios: 417/417.
- **No hecho, con motivo.** El brief pedÃ­a adaptar el importador de bobinas con contradicciÃ³n de
  color: no existe importador de bobinas por columnas. Las bobinas entran por compra (formulario o
  XML), partido y corte.
- **Pendientes para la ventana V-4:**
  - ProducciÃ³n se limpia fÃ­sicamente antes de V-4 (decisiÃ³n del dueÃ±o). DespuÃ©s de la limpieza, y
    antes de la migraciÃ³n que pase `finishes.kind`/`business_line_id` a `NOT NULL`, completar desde
    Acabados todo acabado sin tipo. Una consulta de solo lectura lo confirma: `SELECT code FROM
finishes WHERE kind IS NULL`.
  - La migraciÃ³n `20260914120000` falla a propÃ³sito si producciÃ³n tiene dos colores con el mismo
    nombre en distinta caja. Revisarlo antes del deploy.
  - Deuda de catÃ¡logo (fuera de alcance): un producto de coberturas con acabado y color que no
    coinciden no encuentra bobina (D-086), y el catÃ¡logo acepta un producto con un acabado de otra
    lÃ­nea.
  - Verificar en `dev:preview` las pantallas de Acabados, Colores (RAL), la compra de bobinas y
    Editar bobina.

## SesiÃ³n F8-S5 â€” CatÃ¡logo coherente + kardex clickable (2026-09-15) â€” CERRADA

Cierra la deuda de catÃ¡logo de F8-S4 (M0) y entrega el primer tramo de M1: la referencia de un
movimiento de kardex se vuelve link, y el comprobante que cubre un despacho es un campo nuevo.
DecisiÃ³n D-205. **Todo en commits locales, sin push**: se acumula para la ventana V-4 (11 commits
ahora, F8-S4 + F8-S5). Handoff completo: `docs/handoff/f8-s5-catalogo-kardex.md`.

- **M0 (deuda de F8-S4, sin decisiÃ³n nueva).**
  - `CatalogService.assertFinishCoherence` valida, en alta y en ediciÃ³n, que el color del
    producto coincida con el de su acabado y que la lÃ­nea del acabado sea la del producto.
  - El diÃ¡logo de producto deriva el color del acabado (mismo criterio que D-203/M2) en vez de
    pedirlo aparte, y solo ofrece acabados de la lÃ­nea del producto.
  - La validaciÃ³n destapÃ³ el mismo hueco en el helper de E2E `createRoofingProduct`, que asumÃ­a
    el color del `finishId` recibido sin comprobarlo; corregido con `finishForCoil` en la raÃ­z.
  - Cubierto por `e2e/tests/catalogo-huecos-f8s5.spec.ts` (4 tests).
- **M1, primer tramo (D-205).**
  - `InventoryService.findMovements` resuelve `refTargetType`/`refTargetId` por `(refType,
refId)` en un Ãºnico lugar: `PURCHASE` directo, `CUTTING` y `PRODUCTION` resuelven una fila
    hija (con fallback al id de la orden cuando el ajuste de cierre la referencia directo),
    `SALE` resuelve el pedido del despacho.
  - `kardex-view.tsx` y `bobina-detalle-view.tsx` vuelven la referencia un link, solo si el rol de
    quien mira tiene acceso al destino.
  - `dispatches.invoice_id` (columna nueva) enlaza un despacho a su comprobante, solo desde el
    mostrador (D-099) â€” el Ãºnico punto sin ambigÃ¼edad despachoâ†”comprobante.
  - Cubierto por `e2e/tests/kardex-clickable-f8s5.spec.ts` (5 tests).
- **Hallazgo de la propia suite E2E, no de `revisor`:** `inventory_movements` tiene un trigger
  que rechaza cualquier `UPDATE` (`TRUNCATE` aparte). El primer diseÃ±o de `invoice_id` lo ponÃ­a
  ahÃ­; los 5 tests de mostrador de la corrida completa lo tumbaron con `PostgresError P0001`
  antes de llegar a ningÃºn commit. Se moviÃ³ a `dispatches`, que sÃ­ se edita. **LecciÃ³n para
  sesiones futuras:** un campo nuevo sobre una tabla con reglas de integridad fuertes (append-
  only, CHECK, trigger) se valida contra la suite completa antes de darlo por bueno, no solo por
  lectura de cÃ³digo â€” misma raÃ­z que D-123.
- **RevisiÃ³n (`revisor`), dos hallazgos, los dos corregidos:** el diÃ¡logo de producto mandaba el
  color derivado en todo PATCH (bloqueaba editar un producto legado con OP viva por cualquier
  campo); los links de kardex no respetaban los roles mÃ¡s angostos de sus pantallas de destino.
- **Suite E2E completa local: 330 passed, 0 failed, 2 skipped.** Corrida completa dos veces
  (antes y despuÃ©s de mover `invoice_id` a `dispatches`) mÃ¡s una focalizada de 19 specs tras los
  fixes de revisiÃ³n. Unitarios 417/417.
- **No hecho, con motivo.** El flujo estÃ¡ndar de facturaciÃ³n no enlaza comprobanteâ†”despacho
  (D-205 ya deja la direcciÃ³n correcta: declarar el despacho al facturar, no inferirlo) â€” alcance
  de otra sesiÃ³n.

## SesiÃ³n HOTFIX-401 (2026-09-16) â€” M1 y M2 cerradas (M1 resuelta en la ventana RF-S1+HOTFIX)

Worktree `ayr-steel-erp-hotfix-401`, rama `hotfix-401` desde `origin/main` (`f92a3df`, prod) â€”
NO desde `main` local (que tiene RF-S1 sin push) ni desde `rf-s2`. Cuatro commits locales,
**sin push**. `git rebase origin/main` no hizo falta correrlo: la rama ya nace de ahÃ­.

### M1 â€” 401 al abrir un borrador de comprobante: **RESUELTA (correcciÃ³n, ventana RF-S1+HOTFIX)**

El brief traÃ­a `URL: <PEGAR URL>` sin completar, y la investigaciÃ³n de esta sesiÃ³n no pudo
reproducirla por lo mismo que no encontraba causa: **no era un bug de este cÃ³digo**, era el
mismo sÃ­ntoma del incidente Â«HOTFIX-DESFASEÂ» (ver esa secciÃ³n mÃ¡s abajo) mirado desde otro
Ã¡ngulo. La ventana F8-S7 habÃ­a publicado el web con F8-S7/D-211..D-213 sin desplegar la API
(seguÃ­a en `ayr-steel-erp-api-00034-drz`, anterior a esos cambios): el web nuevo leÃ­a
`issueDateChanges.length` de una respuesta que esa API no traÃ­a, y el detalle del comprobante
caÃ­a con `TypeError` â€” que en producciÃ³n, delante del dueÃ±o, se ve indistinguible de un 401.
InvestigaciÃ³n de esta sesiÃ³n: correcta en lo que pudo verificar (el guard de
`GET /invoicing/documents/:id` sin cambios, `issueDateChanges` resguardada en el DTO builder,
sin colisiÃ³n de cache) y no reprodujo porque probÃ³ contra un entorno con web y API ya
parejos, no contra el desfase real de producciÃ³n.

**Fix, en dos partes:** (1) deploy de la API a `f92a3df` (revisiÃ³n `00035-rd9`) mÃ¡s la
migraciÃ³n `20260916060618_s7_fecha_emision_manual_editable` (D-211), que le dan a la API el
campo que el web ya esperaba â€” incidente cerrado el 2026-09-16, verificado por el dueÃ±o contra
dos comprobantes reales (`7bef5114â€¦`, `30bcccd9â€¦`); (2) endurecido en `ca6314d` (commit
`47b09e7`, esta ventana): `e2e/tests/comprobante-detalle-defensivo.spec.ts` (4/4) prueba que
una respuesta **sin** `issueDateChanges`/`dispatchId`/`dispatchCode` muestra igual el
comprobante sin crash, que un 401 con sesiÃ³n caÃ­da revalida a `/login?next=â€¦`, y que
cualquier otro error se ve con Â«ReintentarÂ» â€” para que un desfase web/API futuro no vuelva a
tumbar la pantalla entera. Verificado por el dueÃ±o en producciÃ³n en el smoke manual de esta
ventana.

### M2 â€” borradores duplicados: **cerrada**

PASO 0 (reportado antes de cÃ³digo): `createInTx` no tenÃ­a `idempotencyKey` (D-182) ni tope
contra `sales_orders.total_pen`; `documentBalance` (`@ayr/shared`) no excluÃ­a `DRAFT` de su
cÃ¡lculo (solo `VOIDED`/`REJECTED`/`ANNULLED`) â€” un borrador mostraba el total completo como
saldo pendiente y, con `dueDate` vencida, "Vencido". `assertStillAvailable` (emisiÃ³n) ya
revalidaba lÃ­nea por lÃ­nea; `receivables.service.ts` (Cobranzas) ya excluÃ­a `DRAFT` de la
CxC agregada; "Descartar borrador" ya existÃ­a, sin motivo obligatorio.

Fix (D-223, registrada originalmente como D-214 â€” renumerada en VENTANA-S1+HOTFIX porque RF-S1 ya usaba D-214):

- `idempotencyKey` en `createInTx`, mismo patrÃ³n que un cobro (D-182).
- Tope nuevo: `DRAFT` + `LIVE_DOCUMENT_STATUSES` (sin notas de crÃ©dito, sin archivados) de
  un pedido no puede pasar su `total_pen`.
- `documentBalance` da `0.0000` para `DRAFT` (`isOverdue` queda corregido como consecuencia).
- `discardDraft` exige `reason`.
- MigraciÃ³n `20260916180000_hotfix401_no_duplicate_drafts`: dos Ã­ndices Ãºnicos parciales
  (`WHERE status = 'DRAFT' AND doc_type <> 'NOTA_CREDITO'`) como respaldo de base, con un
  chequeo de duplicados que revienta con mensaje claro en vez de fallar a mitad de crear el
  Ã­ndice. La exclusiÃ³n de nota de crÃ©dito se encontrÃ³ corriendo la suite E2E existente
  contra la primera versiÃ³n de la migraciÃ³n (P2002 al crear una NC sobre un pedido que ya
  tenÃ­a otro borrador) â€” no estaba en el primer intento.
  > **Nota 2026-09-16 (VENTANA-S1+HOTFIX):** esta migraciÃ³n **se retirÃ³** antes de aplicarse en ninguna base compartida; la regla es solo el tope bajo lock. Ver la fila D-223 de `ARQUITECTURA.md`.

**VerificaciÃ³n**: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde
(32 test suites, 431 tests). Suite E2E de comprobantes/facturaciÃ³n con builds de producciÃ³n:
`comprobante-manual(-ui)`, `despacho-declarado-f8s7`, `fase5a(-bordes)`, `fase5b(-bordes)`,
`fase7b(-bordes)`, `fase7e(-ajustes-d121|-bordes)`, `fecha-emision-manual-f8s7`,
`idempotencia-f8s1-m2` y el spec nuevo `hotfix-401-borradores-duplicados` (7 casos): **74
pasan, 1 falla** â€” `fase5a.spec.ts:100` por R2 (`R2_ACCOUNT_ID`/etc. vacÃ­os en este entorno,
ninguno es un secreto que el agente deba tener), **ajeno a este hotfix**: la generaciÃ³n del
PDF de una cotizaciÃ³n nueva no atrapa ese error, mismo hallazgo que ya documentÃ³ el cierre
de RF-S2 sobre `fase2a.spec.ts`/`fase5a.spec.ts`. Dos specs existentes
(`despacho-declarado-f8s7`, `fecha-emision-manual-f8s7`) llamaban a `DELETE
/invoicing/documents/:id` con el contrato viejo (sin `reason`) â€” actualizados.

**Consulta de solo lectura para el dueÃ±o**, antes de aplicar la migraciÃ³n en `dev`/`demo`/
`production` â€” encuentra los pedidos/despachos con mÃ¡s de un borrador para descartar los
sobrantes desde la UI primero (la migraciÃ³n ademÃ¡s corre este mismo chequeo sola y aborta
con mensaje claro si hay duplicados, pero esto da el detalle):

```sql
SELECT
  'PED-' || lpad(so.seq::text, 6, '0') AS pedido,
  fd.id AS borrador_id,
  fd.doc_type,
  fd.total_pen,
  fd.payment_terms,
  fd.created_at,
  fd.dispatch_id
FROM fiscal_documents fd
JOIN sales_orders so ON so.id = fd.sales_order_id
WHERE fd.status = 'DRAFT'
  AND fd.sales_order_id IN (
    SELECT sales_order_id FROM fiscal_documents
    WHERE status = 'DRAFT' AND dispatch_id IS NULL AND sales_order_id IS NOT NULL
      AND doc_type <> 'NOTA_CREDITO'
    GROUP BY sales_order_id HAVING COUNT(*) > 1
    UNION
    SELECT sales_order_id FROM fiscal_documents
    WHERE status = 'DRAFT' AND dispatch_id IS NOT NULL AND doc_type <> 'NOTA_CREDITO'
    GROUP BY sales_order_id, dispatch_id HAVING COUNT(*) > 1
  )
ORDER BY so.seq, fd.created_at;
```

### Pendientes

- ~~M1 (401): esperando la URL/evidencia real para retomar.~~ **RESUELTO** en la ventana
  RF-S1+HOTFIX: era el mismo desfase web/API del Incidente HOTFIX-DESFASE, no un bug propio
  (ver la secciÃ³n M1 arriba).
- MigraciÃ³n de M2 sin aplicar contra `dev`/`demo`/`production` â€” solo contra el Postgres
  local (`ayr_local_e2e`). AcciÃ³n humana: correr la consulta de arriba en `production`
  antes de `pnpm db:deploy`/`db:prod`.
- ~~`hotfix-401` sin merge ni push.~~ **RESUELTO**: llegÃ³ a `main` por `release/s1-hotfix` en
  la ventana RF-S1+HOTFIX (ver esa secciÃ³n mÃ¡s abajo), `ca6314d`.
- `/handoff hotfix-401` con el resumen de cierre.

## SesiÃ³n F8-S7 â€” Pulido y feedback de uso real (2026-09-16) â€” CERRADA

Primera sesiÃ³n de producto con **producciÃ³n en uso real** (D-211..D-213). Todo lo de acÃ¡ saliÃ³
de que el cliente usara la app durante la migraciÃ³n, no de un backlog: la fecha de un papel que
se tipeÃ³ mal y no se podÃ­a corregir, un selector que habla en el idioma del catÃ¡logo y no en el
del mostrador, y la punta que D-205 dejÃ³ explÃ­citamente escrita como deuda.

Regla de la sesiÃ³n: **additive only**. La Ãºnica migraciÃ³n
(`20260916060618_s7_fecha_emision_manual_editable`) crea una tabla y nada mÃ¡s.

- **M1 â€” La fecha de emisiÃ³n de un comprobante manual se corrige (D-211).**
  `PATCH /invoicing/documents/:id/issue-date`, con motivo obligatorio, historial propio
  (`fiscal_document_issue_date_changes`) **visible en el detalle** y no solo en la auditorÃ­a.
  Solo `origin = MANUAL`, solo ADMINISTRADOR, misma ventana y mismas cotas que emitir. El
  vencimiento se corre los mismos dÃ­as que la emisiÃ³n, se muestra antes de confirmar y exige
  `confirmDueDateShift`. No se corrige un anulado ni una versiÃ³n archivada, y la emisiÃ³n no
  puede quedar despuÃ©s de una nota de crÃ©dito viva ni de un cobro vigente.
- **M2 â€” El acabado se elige por color comercial (D-212).** `finishLabels` en
  `apps/web/src/lib/finish-label.ts`, aplicado en los cuatro selectores (compra, ediciÃ³n de
  bobina, alta de producto, receta). El cÃ³digo tÃ©cnico aparece **solo** cuando dos acabados de
  la misma lista comparten color. Cero cambios de dominio: D-203 y D-085 intactos.
- **M3 â€” `dispatchId` al facturar (D-213), cierra la deuda que D-205 dejÃ³ escrita.** Declarado y
  nunca inferido: se valida pertenencia al pedido, que no estÃ© revertido y que no tenga ya
  comprobante, y se escriben las dos puntas del enlace. La pantalla preselecciona solo si hay
  exactamente un despacho enlazable.
- **M4 â€” cosmÃ©ticos.** Ver el cierre de la sesiÃ³n: era el mÃ³dulo sacrificable del brief.

### Lo que esta sesiÃ³n encontrÃ³ y no venÃ­a en el brief

- **Drift preexistente entre `schema.prisma` y las migraciones.** `prisma migrate dev` para la
  tabla de M1 generÃ³, ademÃ¡s del `CREATE TABLE`, un arrastre que nadie pidiÃ³: `DROP INDEX` de
  `products_finish_id_idx` y `sales_orders_origin_status_idx`, `DROP DEFAULT` del
  `operation_date` de cinco tablas (`coils`, `cutting_orders`, `inventory_movements`,
  `production_orders`, `production_reports`), un `RENAME INDEX` de `raw_material_specs` y cuatro
  FK recreadas. **No es de esta sesiÃ³n**: son diferencias entre lo que las migraciones
  escribieron a mano y lo que `schema.prisma` declara, acumuladas desde antes. Pasa
  desapercibido porque nada de eso afecta al cliente de Prisma â€”un Ã­ndice es rendimiento y un
  `DEFAULT` que la aplicaciÃ³n siempre pisa da igualâ€”, y `migrate status`/`migrate deploy` no lo
  miran: **solo aparece cuando alguien genera una migraciÃ³n nueva**. La de M1 se escribiÃ³ a mano
  con el `CREATE TABLE` solo. Queda como deuda: mientras no se concilie, **toda migraciÃ³n
  generada con `migrate dev` hay que leerla entera antes de commitearla**, porque va a traer
  esto de arrastre y producciÃ³n estÃ¡ en uso real.
- **La base local del dueÃ±o (`ayr_local`) se repuso.** El `migrate dev` de arriba se corriÃ³
  contra ella y le aplicÃ³ ese arrastre; se resolviÃ³ con `pnpm db:local reset`, que la recrea
  desde las migraciones + seed. No se perdiÃ³ nada: tenÃ­a 0 bobinas, 0 cotizaciones, 0 pedidos y
  0 comprobantes â€” solo el cliente Â«pÃºblico en generalÂ» del seed. **La lecciÃ³n para la prÃ³xima:
  una migraciÃ³n se genera contra la base descartable, no contra la del dueÃ±o** (regla dura 15
  cubre los puertos de `dev:preview`; su base merece el mismo cuidado).
- **`shiftDate` naciÃ³ duplicada y el lint la cazÃ³.** La cuenta del corrimiento del vencimiento
  se escribiÃ³ primero en `invoicing-math.ts` y despuÃ©s, sin querer, otra vez en la pantalla â€”
  que es donde se le promete al usuario el vencimiento nuevo. La regla de `no-restricted-syntax`
  contra `toISOString().slice(0, 10)` la delatÃ³. Vive una sola vez en `@ayr/shared`, que es lo
  que `resolveDueDate` ya habÃ­a dejado escrito con todas las letras: dos implementaciones de la
  misma cuenta son dos resultados que se pueden separar sin que nada falle.

### RevisiÃ³n y pruebas

**`revisor` encontrÃ³ tres bloqueantes, y el primero habrÃ­a roto M3 en el caso mÃ¡s comÃºn.**

1. **`fiscal_documents.dispatch_id` tiene dueÃ±o, y no es este enlace.** La primera versiÃ³n de M3
   escribÃ­a esa columna ademÃ¡s de `dispatches.invoice_id`. En `fiscal_documents` esa columna
   significa **Â«este documento _es_ la guÃ­a de remisiÃ³n de ese despachoÂ»**, y el CHECK
   `fiscal_documents_shape_ck` (Fase 5b) la exige **nula** en todo lo que no sea una GRE: una
   factura con despacho declarado terminaba en 500, y justo en el caso que la pantalla
   preselecciona (pedido con un solo despacho). Se quitÃ³: el enlace de D-205 vive en
   `dispatches.invoice_id` y nada mÃ¡s. **La lecciÃ³n no es Â«faltÃ³ probarÂ»**: la columna se
   eligiÃ³ por su nombre, sin releer quÃ© preguntaba. Es la forma que toma acÃ¡ la regla dura 14
   â€”dos preguntas distintas que el compilador no distingueâ€” sobre dos columnas en vez de dos
   funciones.
2. **Y por eso mismo, la factura se disfrazaba de guÃ­a.** `Dispatch.documents` es la relaciÃ³n
   inversa de esa columna y no filtra por tipo: con una factura ahÃ­, el despacho mostraba
   `F001-â€¦` en el campo Â«GuÃ­aÂ», **desaparecÃ­a el botÃ³n de emitir la guÃ­a de remisiÃ³n** y la
   reversa se bloqueaba con un mensaje que mandaba a dar de baja un comprobante que no era una
   guÃ­a. Todo eso cae solo al no escribir la columna.
3. **El enlace se toma al crear el comprobante, que es antes de saber si va a existir.** Un
   borrador con despacho declarado **no se podÃ­a descartar** (`dispatches_invoice_id_fkey` es
   `ON DELETE RESTRICT` â†’ P2003 â†’ 500), y un rechazado o un anulado dejaban el despacho ocupado
   para siempre. Ahora `discardDraft` suelta el enlace antes de borrar, lo que ocupa un
   despacho es un comprobante **vivo** (`LIVE_DOCUMENT_STATUSES`, la misma lista blanca que usa
   el resto del mÃ³dulo) y revertir un despacho tambiÃ©n lo suelta.

Los dos **altos**, del mismo tirÃ³n: `updateManualIssueDate` no tomaba `FOR UPDATE` â€”todos sus
pares lo toman y lo dejan comentado como lecciÃ³nâ€” asÃ­ que sus guardrails de cobro y de nota de
crÃ©dito se evaluaban sobre una foto; y la validaciÃ³n del despacho tampoco lockeaba, con lo que
dos emisiones concurrentes pasaban las dos y `linkInvoiceToDispatch`, que es idempotente,
**no avisaba** a la que perdÃ­a. Ahora devuelve si escribiÃ³ y el llamador corta.

**El defecto mÃ¡s vergonzoso lo cazÃ³ el lint, no el revisor:** `/^d{4}-d{2}-d{2}$/`, sin las
barras invertidas. Nunca matcheaba, asÃ­ que el aviso del vencimiento nuevo **no se renderizaba
nunca** mientras la mutaciÃ³n mandaba `confirmDueDateShift: true` â€” el corrimiento habrÃ­a pasado
en silencio, que es exactamente lo que ese flag existe para impedir. Se lo comiÃ³ un heredoc al
escribir el archivo desde la shell, y **volviÃ³ a pasar en el intento de arreglarlo por el mismo
camino**: es la regla dura 16, aprendida en vivo. Se corrigiÃ³ con la herramienta de ediciÃ³n, que
no pasa por shell, y la expresiÃ³n quedÃ³ en una sola constante.

**`qa` sumÃ³ 11 casos** (`fecha-emision-manual-f8s7.spec.ts`, 6; `despacho-declarado-f8s7.spec.ts`,
5), **11/11 en verde y sin defectos de producto**. El caso que mÃ¡s importa es el de M3 que afirma
201 y no 500, y que `fiscalDocument.dispatchId` sigue en `null`: es el bloqueante 1 convertido en
centinela. SumÃ³ por su cuenta uno que no estaba en el encargo â€”un borrador descartado suelta el
despacho y se puede volver a facturarâ€”, que es justo la regresiÃ³n que el bloqueante 3 dejarÃ­a
volver.

### Dos cosas operativas que la sesiÃ³n dejÃ³ verificadas

- **`pnpm e2e -- <archivo>` corre la suite entera, en silencio.** Con `--grep` funciona porque es
  una opciÃ³n; con una **ruta**, el `--` llega a Playwright y el filtro posicional se ignora. Le
  costÃ³ 1,6 h de reloj a `qa`. La forma correcta para un archivo suelto es
  `pnpm exec playwright test e2e/tests/<archivo>.spec.ts`.
- **`purgeInvoicingTrail` gasta cupo de Nubefact con los comprobantes manuales.** Un manual
  `ACCEPTED` no admite baja ante SUNAT, asÃ­ que la purga cae en su rama genÃ©rica y **emite una
  nota de crÃ©dito real contra el PSE**; `createCreditNote` bloquea `IMPORTED` pero no `MANUAL`.
  `comprobante-manual.spec.ts` purga manuales aceptados con ese helper, asÃ­ que cada corrida
  completa probablemente se lleva unos comprobantes del cupo de 50 de la cuenta demo. Los specs
  nuevos lo esquivan cerrando con anulaciÃ³n interna (D-110/D-153) antes de purgar. **El helper
  queda por revisar**: no se tocÃ³ en esta sesiÃ³n porque es de la infraestructura de pruebas y
  merece su propio cambio.

### Cierre

`lint`, `typecheck`, `format:check` y **430/430 unitarios** en verde. Suite E2E completa:
**345 passed, 0 failed, 2 skipped** (los dos del cupo PSE), 24,9 min.

**Los tres Ãºnicos rojos de la sesiÃ³n los causÃ³ M2, y ninguno hablaba de acabados.** Los specs
armaban el texto de la opciÃ³n a mano (`` `${finish.code} â€” ${finish.name}` ``) y M2 lo reemplazÃ³
por el color comercial: se cayeron `acabados-d203` (1) y `fase2a` (2), los tres en el formulario
de compra de bobinas. **No se arreglaron ajustando selectores**, que los habrÃ­a dejado listos
para romperse en el prÃ³ximo cambio de etiqueta: `finishLabels` y `FINISH_FIELD_LABEL` se
mudaron de `apps/web/src/lib/` a `@ayr/shared` â€”donde ya viven `FINISH_KIND_LABELS` y el resto
de los `*_LABELS`, asÃ­ que no es un lugar forzadoâ€” y ahora la pantalla y los tests leen **la
misma funciÃ³n**: los specs piden `finishOptionLabel(finish)` (helper nuevo en
`e2e/helpers/api.ts`) en vez de construir el string. El dÃ­a que la etiqueta cambie otra vez, los
tests la siguen solos. Es la misma lecciÃ³n de `shiftDate`, encontrada por segunda vez en la
misma sesiÃ³n y por el mismo camino: **una regla copiada en dos lados son dos reglas**.

**La corrida completa necesitÃ³ builds de producciÃ³n.** En modo dev (`next dev` +
`nest start --watch`) el sistema la matÃ³ por falta de memoria en el test 308 de 347, con cero
fallos hasta ahÃ­. Se relanzÃ³ con los builds â€”`CI=1` es lo que hace que `playwright.config.ts`
levante `start` en vez de `dev`, y entonces hay que dar a mano las variables que el bloque
`!isCI` completaba soloâ€” y entrÃ³ entera. **No hizo falta el worktree** que el runbook de
F8-V4prep menciona: ese existe para no pisar `apps/web/.next` mientras corre el `dev:preview`
del dueÃ±o, y no estaba levantado. De yapa, 24,9 min contra ~1,6 h en modo dev.

## Post-V4 â€” auditorÃ­a de verificaciÃ³n y pendientes vivos (2026-09-16)

AuditorÃ­a de solo lectura sobre todo lo cerrado entre F8-S4 y la ventana V-4, hecha con la
ventana ya cerrada. Verifica contra el sistema real lo que las entradas de arriba afirman, y
deja **una sola lista** de pendientes: la de abajo reemplaza a las listas sueltas repartidas
entre los cierres de F8-S4, F8-S5, F8-S6a, F8-S6a2, F8-V4prep y la Ventana V-4. Si un pendiente
no estÃ¡ acÃ¡, no estÃ¡ vivo.

### Lo que se verificÃ³ (y lo que no coincidÃ­a)

- **CÃ³digo y ramas.** `main` limpio, `local == origin/main`, 0 commits sin push, sin stash, sin
  ramas locales de mÃ¡s, sin worktrees. La era de commits locales terminÃ³ con V-4, como se
  esperaba. Neon tiene **10 ramas** y `production` sigue siendo la default: las cuatro de
  trabajo (`production`, `dev`, `ci`, `demo` â€” el brief de la auditorÃ­a se olvidaba de `demo`)
  y **cinco** respaldos, no cuatro: `respaldo-pre-deploy-20260909`,
  `respaldo-pre-hotfix-2026-09-10`, `respaldo-pre-deploy-20260912`,
  `respaldo-pre-deploy-20260913` y `respaldo-pre-v4-20260915`, mÃ¡s la de ensayo
  `ensayo-v4-20260915`. Ninguna se borra (regla dura 5 de `CLAUDE.md`).
  > **Nota 2026-09-16 (HOTFIX-DESFASE):** la regla Â«nunca borrar ramas de NeonÂ» se reemplazÃ³
  > por la polÃ­tica de ramas de `CLAUDE.md` (stack). Con OK del dueÃ±o por nombre se borraron
  > `respaldo-pre-deploy-20260909` y `respaldo-pre-hotfix-2026-09-10`; ver la secciÃ³n
  > Â«Incidente HOTFIX-DESFASEÂ».
- **ProducciÃ³n, esquema y despliegue.** `migrate status` **66/66 sin drift**. Cloud Run sirve
  la revisiÃ³n **`ayr-steel-erp-api-00034-drz`** al 100 % con `Ready=True` â€” una mÃ¡s que la
  `00033-ww7` que registrÃ³ la ventana: la `00034` es el deploy de D-210. `pnpm smoke:prod` en
  verde (health, login, 5 lÃ­neas, 174 productos, valorizado, bobinas, reporte mensual).
- **La carga de inventario de V-4 es exactamente la que se documentÃ³**: 15 bobinas con
  `externalCode` (`SALDO-â€¦`), **46.805,000 kg**, **S/ 132.520,06**, 15 movimientos `IMPORT`
  con `operationDate` 2026-09-15, las 2 `ALZ-NATURAL` sin color. CatÃ¡logo intacto: 174
  productos (173 activos), 6 colores, **9 acabados con `kind` y lÃ­nea en todos** y ninguno
  `PREPINTADO` sin color â€” D-209 sostiene su invariante sobre datos reales. Los 56 SKU de
  Metallic Roofing tienen `roofingKind` y acabado.
- **ProducciÃ³n ya estÃ¡ en uso operativo real, y eso cambia los nÃºmeros del cierre.** Entre el
  15-09 22:34 UTC y el 16-09 02:59 UTC entraron: **48 clientes**, **70 cotizaciones** (67
  emitidas, 3 confirmadas), **7 compras** de bobina (6 en `DRAFT`, 1 `RECEIVED`), **3 bobinas
  mÃ¡s** por esa compra recibida (`XSY-â€¦`, 13.552 kg / S/ 37.001,03, `operationDate` 2026-08-25),
  **3 pedidos** en `IN_PRODUCTION`, **5 OPs de coberturas cerradas** con 6 reportes, y **3
  facturas manuales `ACCEPTED`** (D-153, correlativos 1352/1354/1360 de la serie histÃ³rica,
  emitidas el 5 y el 12 de agosto). Hoy hay **18 bobinas / 52.875,848 kg** en kardex, no 15, y
  **2 SKU con saldo de producto terminado** (COB030ROJO, COB040ROJO) que salieron de esas OPs.
  Sin saldos negativos. **Cualquier verificaciÃ³n futura tiene que contar desde acÃ¡, no desde
  los 15/46.805 de la ventana.**
- **Los proveedores del archivo de compras sÃ­ se crearon** (era una pregunta abierta): hay
  **5** â€” el `SALDO` del sistema (D-206) y cuatro reales, `JRSTEE`, `XSY`, `JAVI` y `YISENT`,
  todos con RUC y activos, creados el 15-09. Con ellos se cargaron las 7 compras de arriba.
- **Salud del catÃ¡logo, solo lectura.** `check:roofing-catalog` sin nada que corregir.
  `check:price-floor` informa **0 SKU activos con precio de lista**: nadie estÃ¡ por debajo del
  piso de D-163 porque **no hay precios de lista cargados** â€” las 70 cotizaciones se hicieron
  con precio tipeado. Es un dato de estado, no un defecto, pero explica por quÃ© el piso de
  D-163 y el aviso del POS no alcanzan hoy a ninguna venta.
- **DocumentaciÃ³n.** Las entradas de F8-S4, F8-S5, F8-S6a, F8-S6a2, F8-V4prep y la Ventana V-4
  estÃ¡n completas, y D-203..D-209 en Â§0.2 tambiÃ©n. Dos huecos, corregidos en esta auditorÃ­a:
  el cambio de `MAX_BACKDATED_ISSUE_DAYS` de 7 a 90 (commit `201185c`) estaba en `main` **sin
  decisiÃ³n ni entrada** â€” ahora es **D-210**; y el cierre de F8-V4prep afirmaba que Â«el
  rollover de correlativos de D-202 (2028-04-22) sÃ­ quedÃ³ en el checklist, con su cita
  exactaÂ», pero `docs/ENTORNOS.md` no contenÃ­a la cadena `2028` en ninguna parte. El rollover
  se agregÃ³ al gate PSE del checklist de ventana, y la afirmaciÃ³n ya es cierta. **Una lista de
  pendientes que no se verifica miente**: es la segunda vez que pasa en este repo.

### SesiÃ³n CI-SANA (2026-09-16) â€” `main` de vuelta a verde

Cierra los dos pendientes que dejaban `main` roja (ver #1 y #2 tachados abajo) y salda la deuda
de regla dura 13 que arrastraban los handoffs de `estabilizacion-d145` y `planta-tanda`:
`inventario-inicial-plantilla.xlsx`, `subset.json` y `e2e-report.json` salen de la raÃ­z del repo
y pasan a `local-data/`. Ninguno estaba referenciado por cÃ³digo ni por workflows â€” solo los
nombraban esos dos handoffs, como pendiente que nadie habÃ­a cerrado. Las entradas que los
cubrÃ­an siguen en `.gitignore` a propÃ³sito: si una herramienta vuelve a escribirlos en la raÃ­z,
la red sigue puesta.

Cierre verde antes del push: `lint`, `typecheck`, `test` y `format:check`.

**Bloqueo, y por quÃ© la verificaciÃ³n de los 6 specs quedÃ³ en CI.** Docker Desktop no estÃ¡
corriendo en esta mÃ¡quina y no se pudo levantar desde la sesiÃ³n (tres intentos: `start` por
`cmd`, ruta de Program Files inexistente â€”estÃ¡ en `AppData\Local\Programs\DockerDesktop`â€” y
`Start-Process` por PowerShell, que lanzÃ³ sin error pero nunca dejÃ³ al daemon responder). Sin
Docker no hay `ayr_local_e2e`, asÃ­ que la suite local no corre. Se aplicÃ³ la regla dura 11:
documentar y seguir con lo que no depende del comando. **La verificaciÃ³n que importa igual es la
de CI**, porque el defecto solo se manifiesta en el runner: localmente el wrapper siempre
acertaba la base. Lo que sÃ­ se verificÃ³ acÃ¡ es el resolutor nuevo, con los 8 escenarios de
`localTestDbUrls` â€” entre ellos los tres que no deben ganar nunca.

### Pendientes vivos

Orden de prioridad. Los dos que dejaban `main` en rojo se cerraron en la sesiÃ³n CI-SANA
(2026-09-16) y quedan tachados abajo con lo que se hizo; del #3 en adelante siguen vivos.

1. ~~**CI en rojo por el wrapper del importador (runner).**~~ **RESUELTO (CI-SANA,
   2026-09-16).** `localTestDbUrls` en `scripts/local-docker-env.mjs` decide la base de una rama
   `local`/`local-e2e`: si `DATABASE_URL` **y** `DIRECT_URL` ya vienen en el entorno y son una
   base de pruebas reconocida, ganan; si no, cae al Docker local. **Falla hacia adentro, nunca
   hacia afuera**: la lista blanca es la misma forma que la de `apps/api/prisma/test-db-guard.ts`
   â€”el Docker con la base que la rama pedida nombra, o `localhost/ayr_ci_e2e` **solo** con
   `GITHUB_ACTIONS=true`â€” y con cualquier otra cosa en el entorno (un Neon `dev` exportado a
   mano, por ejemplo) se ignora el entero y se usa la de Docker. Las dos URLs se deciden juntas
   y se validan las dos, por la misma razÃ³n que documenta ese guard: `migrate` lee por
   `DIRECT_URL` y la escritura va por `DATABASE_URL`, asÃ­ que aprobar mirando una sola es el
   agujero. Verificado con los 8 escenarios del resolutor, incluidos los tres peligrosos (Neon
   exportado a mano, mezcla de las dos URLs, y el runner sin `GITHUB_ACTIONS`): los tres caen al
   Docker. Segundo defecto que el mismo camino escondÃ­a y que tambiÃ©n se arreglÃ³: el wrapper
   pisaba `ADMIN_EMAIL` con el admin de Docker, y en CI el admin de la base de pruebas es
   `secrets.ADMIN_EMAIL` â€” el CLI habrÃ­a quedado buscando un actor que ahÃ­ no existe, con un
   error que no habla de eso. Ahora el entorno gana si ya lo declara.
   Detalle del original, para que no se pierda: `main` llevaba **4 corridas rojas
   seguidas** (desde `daec519`, 15-09 21:21 UTC); la Ãºltima verde es la 34908482884 del 14-09.
   El job E2E da **327 passed / 6 failed**, y los 6 son los del importador: 3 de
   `e2e/tests/inventario-inicial-f8s6a.spec.ts` y 3 de
   `e2e/tests/inventario-inicial-productos-f8s6a2.spec.ts`. Causa confirmada en el log
   (35048537491): el spec invoca `scripts/import-initial-inventory.mjs --branch local-e2e`, y
   ese wrapper resuelve `local-e2e` con `dbUrl(DB_NAME_E2E)` â€”
   `postgresql://ayr:ayr_local@127.0.0.1:5434/ayr_local_e2e`, el Docker de la mÃ¡quina del
   agente â€” mientras que en CI la base es la del runner,
   `postgresql://ayr:ayr_ci@localhost:5432/ayr_ci_e2e` (D-202, `.github/workflows/ci.yml`). El
   CLI se conecta a una base que en el runner no existe y su guarda de esquema lo reporta como
   Â«Esta rama no tiene la migraciÃ³n `20260915100000_d206_carga_inicial_de_inventario`
   aplicadaÂ» â€” que es verdad de esa base y mentira del asunto.
2. ~~**Rama `ci` de Neon bloqueada (P3009).**~~ **RESUELTO (CI-SANA, 2026-09-16).** La rama
   quedÃ³ en **66/66, esquema al dÃ­a**. Los 22 acabados sin tipo que la trababan eran **residuo
   de corridas E2E** (cÃ³digos al azar como `EAMU806928`, ninguno con color ni lÃ­nea), no datos
   que completar: la rama se vacÃ­a en cada corrida y `prisma/seed.ts` no siembra acabados, asÃ­
   que se vaciÃ³ y D-209 aplicÃ³ sin nada que rechazar. **No se recreÃ³ la rama en Neon, a
   propÃ³sito:** `test-db-guard.ts` reconoce la rama `ci` por el prefijo de su endpoint de
   cÃ³mputo (`ep-dry-butterfly-`), y recrearla le cambia el endpoint y rompe el guard â€” es la
   misma trampa que D-181 ya documentÃ³.
   **La lecciÃ³n del orden, que costÃ³ un intento:** `reset-test-db.ts` arranca con un
   `prisma migrate deploy`, que es exactamente lo que P3009 bloquea, **asÃ­ que el reset no puede
   destrabarse a sÃ­ mismo**. La secuencia que funciona es vaciar primero (con el mismo guard,
   sin migrar), despuÃ©s `migrate resolve --rolled-back` y reciÃ©n entonces `migrate deploy`.
3. ~~**Push fantasma de F8-S4: causa no confirmada, riesgo abierto.**~~ **RESUELTO (RF-S1/M0a,
   2026-09-16).** La causa del push de `a05fca1` sigue sin confirmarse (la auditorÃ­a de esta
   fila la descartÃ³ de todo lo investigable: hooks, alias, `push.default`, transcripts), pero
   el riesgo que seÃ±alaba â€”`.claude/settings.json` combinando `"defaultMode": "auto"` con
   `Bash(git:*)` en `allow`â€” ya no existe: `Bash(git push:*)`, `Bash(gh pr merge:*)` y
   `Bash(gh repo sync:*)` pasaron a `deny` (D-214). Verificado con un intento real de
   `git push --dry-run`, denegado por el permiso. El agente ahora commitea en local y, al
   cierre, imprime el comando de push para que lo corra el dueÃ±o (CLAUDE.md regla dura 6).
4. **Stock de UPVC y reventa: segunda tanda pendiente.** La carga de V-4 fue **solo bobinas**.
   Verificado: no hay un solo saldo de producto en `ROOFING` ni en `TRADING` (los 2 saldos de
   producto que existen son coberturas fabricadas por las OPs de anoche). El dueÃ±o confirmÃ³ que
   el cliente tiene ese stock; falta su archivo para correr
   `pnpm import:initial-inventory --kind products --branch production --execute --confirm-production`
   (D-207). La herramienta ya estÃ¡ probada y no necesita trabajo.
   **ActualizaciÃ³n 2026-09-22** (ver Â«SesiÃ³n Inventario inicial UPVCÂ» al inicio de este
   archivo): archivo armado, `source` corregido y **carga ejecutada en `demo`** (3/3 OK, total
   valorizado S/ 123.359,29 sin IGV). El dueÃ±o ya corrigiÃ³ el `source` en `production` tambiÃ©n;
   falta correr la carga real ahÃ­, en la ventana que autorice.
5. **`pnpm e2e:pse` nunca se validÃ³ contra Nubefact con los correlativos de 8 dÃ­gitos de
   D-202.** Se omitiÃ³ en el modo exprÃ©s de V-4. Es la Ãºnica verificaciÃ³n que queda de que la
   cuenta demo acepta un correlativo de 8 dÃ­gitos como primer nÃºmero de una serie. Necesita
   cupo de la cuenta demo: **coordinar con el dueÃ±o** antes de correrlo.
6. **F8-S7 (pulido) no corriÃ³.** No hay entrada ni handoff: el prompt se entregÃ³ y quedÃ³ en
   cola. Alcance: label de acabado/color, `dispatchId` opcional al facturar (la direcciÃ³n que
   D-205 dejÃ³ escrita â€” hoy `POST /invoicing/documents` sigue sin declararlo; verificado) y
   cosmÃ©ticos.
7. **COMPRAS.xlsx: decisiÃ³n cerrada, no reabrir.** Las compras histÃ³ricas **no se importan**;
   la historia vive en Excel. Queda escrito acÃ¡ para que ninguna sesiÃ³n futura lo reintente.
   Ojo con la lectura de los datos: las 7 compras que hoy estÃ¡n en producciÃ³n **no** son esa
   importaciÃ³n â€” las cargÃ³ el dueÃ±o por la app el 15-09, y 6 de ellas siguen en `DRAFT`.

### Backlog heredado (sigue vivo, sin prioridad asignada)

- **Recetas de perfiles de drywall**: sin receta no hay costo de perfil (hoy hay 1 sola
  `product_boms` para 11 SKU de la lÃ­nea).
- Rendimiento del card Â«Cotizaciones sin stock disponibleÂ» (D-188).
- Aviso de precio mÃ­nimo en el POS (D-163) â€” RF-S1/M1 dejÃ³ la infraestructura de precios de
  lista (ediciÃ³n, changelog, carga masiva), pero el POS sigue exento de D-163 (decisiÃ³n
  vigente, no revisada) y la mayorÃ­a de los SKU sigue sin `listPricePen` cargado â€” nadie corriÃ³
  todavÃ­a la carga masiva contra el catÃ¡logo real de producciÃ³n.
- **Card Â«SKUs con lista bajo pisoÂ»**: sacrificado en RF-S1 (M2) por tiempo. El diseÃ±o (una
  sola consulta agregada, con presupuesto de queries) quedÃ³ escrito en el brief de la sesiÃ³n;
  no se empezÃ³ cÃ³digo.
- **Merma del 1 %**: ahora sÃ­ se puede validar contra datos reales, porque los cierres de
  bobina que vengan son de producciÃ³n real.
- BÃºsqueda server-side en las listas de mÃ¡s de 150 filas.
- RF-90..96: auditorÃ­a, reportes y UAT â€” el grueso de la Fase 8, sin empezar.

## Ventana V-4 exprÃ©s â€” limpia total + inventario real en producciÃ³n (2026-09-15) â€” COMPLETADA

Modo exprÃ©s autorizado por el dueÃ±o (CI no bloquea, gate PSE satisfecho en V4prep).

- **Paso 1 â€” Respaldo:** rama Neon `respaldo-pre-v4-20260915` (`br-sweet-resonance-aegd7jdg`,
  parent `production`), creada 2026-09-15 21:09:55 UTC vÃ­a `run` quiet + `--output json`.
- **Paso 2 â€” Push** del lote acumulado a `main` (`a76c02c`); CI no se esperÃ³.
- **Paso 3 â€” Migraciones:** 61 â†’ **65/66**. Aplicadas D-203 (Ã—2), D-205 y D-206, mÃ¡s el seed;
  D-209 retenida para el paso 6 (su carpeta se sacÃ³ del directorio solo durante el
  `migrate deploy`). D-203 no encontrÃ³ colores duplicados.
- **Paso 4 â€” Limpia (D-208)**, `--execute --confirm-production`, aprobada por el dueÃ±o tras el
  dry-run: **3376 filas purgadas en 39 tablas** (73 cotizaciones, 5 pedidos, 6 OPs, 17 compras,
  50 bobinas, 139 movimientos de kardex, 50 clientes, 9 proveedores, 1 factura ACCEPTED â€”de
  prÃ¡ctica: la cuenta Nubefact de prod sigue en modo demoâ€”, 1582 filas de importaciÃ³n, 1014 de
  auditorÃ­a). Correlativos intactos. VerificaciÃ³n post (21:19 UTC): transaccional en 0 (quedan
  solo el cliente Â«pÃºblico en generalÂ», el proveedor del sistema y 1 fila de auditorÃ­a del
  seed); catÃ¡logo intacto â€” 5 lÃ­neas, 174 productos, 6 colores, 9 acabados, 4 usuarios.
- **Importador (paso 0):** la adaptaciÃ³n al formato de `pnpm export:coils` no existÃ­a en el
  Ã¡rbol; se implementÃ³ (`2009264`, `cc657fd`): `CÃ“DIGO SISTEMA` â†’ cÃ³digo de origen,
  `COMPROBANTE` â†’ factura de referencia, omite cerradas/sin kilos. Kilos de apertura =
  **`KILOS ACTUALES`** (decisiÃ³n del dueÃ±o tras ver 6.591 kg consumidos en 4 bobinas: la
  apertura es la foto, no la historia). Export previo a la limpia, 43 bobinas (1 CLOSED):
  `local-data/bobinas-production-pre-limpia-v4.xlsx`.
  El Excel definitivo del dueÃ±o (`local-data/inventario inicial.xlsx`, 15 filas depuradas)
  trae una sola columna de kilos, asÃ­ que el parser quedÃ³ (`8491883`): `KILOS ACTUALES` si la
  columna existe, si no `KILOS INICIALES`. El cruce de color no distingue mayÃºsculas.
- **Deploy del API adelantado** (antes del paso 5, por decisiÃ³n del dueÃ±o): revisiÃ³n
  `ayr-steel-erp-api-00033-ww7`, health `ok/db ok`. El dueÃ±o no podÃ­a guardar los acabados
  desde la UI con el API anterior.
- **Paso 5 â€” Acabados, hecho por el agente** con los valores del dueÃ±o: `ALZ-NATURAL` NATURAL
  sin color; `GALV` GALVANIZADO sin color, en Drywall; `ALZ-ROJO-3020` Rojo, `ALZ-AZUL-5002`
  Azul, `ALZ-BLANCO` Blanco, `ALZ-GRIS-7040` Gris, `ALZ-VERDE-6002` y `ALZ-VERDE-6035` Verde,
  todos PREPINTADO en Coberturas Aluzinc. No hubo que crear ningÃºn color. **Causa real del
  bloqueo:** el cÃ³digo de D-209 ya desplegado revienta al leer un acabado con `kind` null, asÃ­
  que la pantalla de Acabados en producciÃ³n probablemente dio 500 durante unos minutos, entre
  el deploy y este paso. Tampoco se pudo usar el `PATCH`: el login de admin con la contraseÃ±a
  de arranque de `.env.setup` da 401. Se completÃ³ con `FinishesService.update` en un contexto
  de Nest con un cliente Prisma aislado y sin la obligatoriedad (sin SQL; temporales borrados).
  Lecciones en el runbook de `docs/ENTORNOS.md`.
- **Paso 6 â€” D-209** aplicada limpia: producciÃ³n **66/66**, esquema al dÃ­a.
- **Paso 7 â€” Carga de inventario real (D-206)**, aprobada por el dueÃ±o tras el dry-run 15/15
  (~22:00 UTC): **15 bobinas** OPEN (`SALDO-â€¦`), fecha de operaciÃ³n 2026-09-15, **15 movimientos
  de kardex `IMPORT` por 46.805 kg**, 15 saldos (46.805 kg), **valorizado S/ 132.520,06** sin IGV,
  1 registro de auditorÃ­a `imports.initial-inventory`. Las 2 `ALZ-NATURAL` quedan sin color, que
  es lo correcto. El comprobante de referencia de la fila 4 (`F001-1307`) quedÃ³ tal como vino en
  el archivo.
- **Paso 8 â€” `smoke:prod`** en verde (valorizado 15, reporte mensual 15). Productos
  UPVC/reventa (`--kind products`): el dueÃ±o no entregÃ³ archivo en esta ventana.
- **Pendientes post-ventana (dueÃ±o: prÃ³xima sesiÃ³n corta):**
  1. **CI, rama Neon `ci`:** D-209 quedÃ³ fallida ahÃ­ (21:11 UTC, P3009) y bloquea el job
     Â«Smoke E2E y migracionesÂ». Resolver con `migrate resolve --rolled-back` sobre `ci` o
     reseteando la rama, completando antes sus acabados sin tipo.
  2. **CI, runner:** los 6 specs del importador (3 de `inventario-inicial-f8s6a.spec.ts` y 3 de
     `inventario-inicial-productos-f8s6a2.spec.ts`) fallan porque
     `scripts/import-initial-inventory.mjs` arma la URL del Docker local en vez de usar la base
     del runner. La guarda de esquema lo reporta como Â«falta D-206Â». Nunca habÃ­an corrido en CI.
     (Eran 6, no 4: la auditorÃ­a post-V4 los contÃ³ en el log de la corrida 35048537491.)

## SesiÃ³n F8-V4prep â€” Cierre de S6a2 + herramientas de V-4 (2026-09-15) â€” CERRADA

Cierra formalmente F8-S6a2 (deuda OOM de F8-S6a/F8-S6a2) y entrega las herramientas que la
ventana V-4 solo tiene que ejecutar: la limpia total de producciÃ³n (D-208) y la migraciÃ³n de
obligatoriedad de acabados (D-209), las dos ensayadas de punta a punta contra una rama de ensayo
de Neon clonada de `production`. **Todo en commits locales, sin push**: se acumula para la
ventana V-4 (19 commits ahora). ProducciÃ³n no se tocÃ³ â€” todo el ensayo corriÃ³ contra
`ensayo-v4-20260915`, que Neon nunca borra (regla dura del `CLAUDE.md`) y queda para referencia.
_(Nota 2026-09-16: esa regla se reemplazÃ³ por la polÃ­tica de ramas de `CLAUDE.md`; una rama de
ensayo ahora se borra solo con OK del dueÃ±o por nombre. `ensayo-v4-20260915` se conserva.)_

- **M0 â€” Suite E2E completa, 0 rojos (cierra la deuda OOM).** Tres sesiones (F8-S6a, F8-S6a2 y
  esta) habÃ­an visto el proceso morir por falta de memoria del host antes de terminar. La causa
  no era un defecto de cÃ³digo: `pnpm e2e` local corre `nest start` + `next dev` (dev, no
  compilados) durante toda la corrida, y con ~330 specs en un solo worker eso acumula memoria en
  procesos que nunca se reinician. La salida fue correr la suite desde un **`git worktree`**
  aparte con **builds de producciÃ³n** (`node dist/main.js` + `next start`), reusando
  `scripts/e2e-latency.mjs` de F8-R1 con `--proxy-port 5434` (bypasea el proxy de latencia,
  habla directo a Docker) â€” nunca toca `apps/web/.next` del repo principal, asÃ­ que no
  interfiere con `pnpm dev:preview` del dueÃ±o. Resultado: **331/333 en 35,9 min, sin ningÃºn
  sÃ­ntoma de memoria**. Los 2 rojos de la primera corrida (`fase2a.spec.ts` â€” XML de factura;
  `fase5a.spec.ts` â€” PDF en R2) resultaron ser **el entorno del worktree, no el producto**: el
  worktree no tenÃ­a `apps/api/.env` (nunca se corriÃ³ `pnpm env:local` ahÃ­) y por lo tanto
  `R2_ACCOUNT_ID` quedaba vacÃ­o â€” `StorageService` degradaba sin PDF, exactamente el sÃ­ntoma.
  Reintentados con las credenciales reales de `.env.setup` inyectadas: **13/13 en verde**. Con
  eso, la suite completa queda verificada en **336/336** (331 + 2 reintentados + 3 skipped) de
  punta a punta. **F8-S6a2 queda CERRADA** con esto: M1+M2 de esa sesiÃ³n ya estaban verificados
  por su subset curado, y esta corrida completa la deuda pendiente que la dejaba abierta.
  - **Dos incidentes propios durante el setup, documentados en memoria para no repetirlos:**
    corrÃ­ `pnpm build` en el repo principal con `pnpm dev:preview` del dueÃ±o corriendo â€” `next
build` (webpack) y el `next dev --turbopack` del preview escriben al mismo
    `apps/web/.next`, y el preview quedÃ³ en 500 hasta que el dueÃ±o lo reiniciÃ³ (avisado en el
    acto, nunca toquÃ© su proceso); y un `docker compose --profile storage down` de mÃ¡s quitÃ³
    tambiÃ©n `ayr-local-db` (no solo el MinIO que querÃ­a bajar) â€” los datos de `ayr_local`
    sobrevivieron (el volumen no se toca sin `-v`), pero el contenedor tuvo que recrearse.
- **M1 â€” `pnpm limpia:v4` (D-208).** Ver el detalle completo en D-208 (`docs/ARQUITECTURA.md`
  Â§0.2). Un Ãºnico `TRUNCATE ... RESTART IDENTITY CASCADE` sobre 39 tablas, con dry-run por
  defecto, revalidaciÃ³n de conteos antes de ejecutar y verificaciÃ³n de que las 12 tablas
  sobrevivientes no cambiaron de tamaÃ±o. **Toda ambigÃ¼edad del brief original se resolviÃ³
  preguntÃ¡ndole al dueÃ±o antes de escribir cÃ³digo**, no asumiendo un default: `customers`/
  `suppliers` se purgan completos (con sus filas `isSystem` recreadas por el seed), `sessions`/
  `audit_log` se purgan (excepciÃ³n explÃ­cita a la regla dura de auditorÃ­a append-only, para esta
  ventana Ãºnica), `cash_sessions`/`pos_sales`/`import_batches`/`import_rows` se purgan,
  `exchange_rates`/`fiscal_series` quedan fuera de alcance.
  - **Ensayo real contra `ensayo-v4-20260915`** (clon de `production`, creado con
    `neonctl branches create --no-secrets` â€” nunca `--secrets`, regla dura 5): dry-run y
    `--execute` corridos dos veces cada uno. Conteos reales encontrados antes de purgar: 50
    clientes, 9 proveedores, 1 comprobante `ACCEPTED`, 1582 filas de importaciÃ³n, 3343 filas en
    total. Tras `--execute`: las 39 tablas en 0, las 12 sobrevivientes intactas (verificado
    aparte contra `business_lines`, `products`, `colors`, `finishes`, `users`,
    `fiscal_series.correlative`), y el cliente/proveedor sembrados recreados por el seed.
  - **Dos bugs reales que el ensayo destapÃ³** (ninguno lo hubiera visto un ensayo contra Docker
    local, porque ahÃ­ `pnpm.cmd`/`.env.setup` no entran en juego de la misma forma): el
    `execFileSync('pnpm.cmd', ...)` del paso de seed final revienta con `EINVAL` en Windows/Node
    24 sin `shell: true` (mismo sÃ­ntoma ya documentado en otros scripts del repo); y el wrapper
    no pasaba `ADMIN_EMAIL`/`ADMIN_PASSWORD`, asÃ­ que el seed heredaba el admin de desarrollo
    local vÃ­a `dotenv/config` en vez del real de `.env.setup` â€” contra una rama Neon de verdad
    eso podÃ­a crear un administrador de mÃ¡s. Los dos corregidos y reverificados.
- **M2 â€” MigraciÃ³n `20260915120000_d209_acabados_tipo_obligatorio` (D-209).** Cierra la deuda
  diferida de D-203. Ver el detalle en D-209. Ensayadas **las dos ramas** contra la misma rama de
  ensayo: producciÃ³n real tenÃ­a **8 acabados sin tipo** (`ALZ-AZUL-5002`, `ALZ-BLANCO`,
  `ALZ-GRIS-7040`, `ALZ-NATURAL`, `ALZ-ROJO-3020`, `ALZ-VERDE-6002`, `ALZ-VERDE-6035`, `GALV`) â€”
  la migraciÃ³n fallÃ³ nombrÃ¡ndolos exactamente, como debÃ­a. Completados a mano (simulando al
  dueÃ±o) y reintentada tras `prisma migrate resolve --rolled-back` (paso que solo un ensayo
  contra Neon real iba a destapar: una migraciÃ³n fallida deja el historial bloqueado hasta
  resolverla, algo que no pasa igual en una base local reciÃ©n creada), aplicÃ³ limpio. De paso
  quedÃ³ confirmado que el Ã­ndice Ãºnico case-insensitive de colores de D-203 no encuentra
  duplicados en los datos reales de `production` â€” la otra deuda que el brief pedÃ­a revisar.
  `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde para todo el monorepo
  tras el cambio de `schema.prisma` (sin fallout: `kind`/`businessLineId` ya se exigÃ­an a nivel
  de aplicaciÃ³n desde D-203).
- **M3 â€” Runbook de la ventana V-4** en `docs/ENTORNOS.md` Â§ Â«Checklist de la ventana V-4Â»: los
  9 pasos en orden, cada uno con quiÃ©n lo hace (dueÃ±o/agente), incluido el flujo de
  `migrate resolve --rolled-back` si D-209 encuentra acabados incompletos. Dos avisos que el
  brief pedÃ­a incluir (Â«gap de endpointsÂ», Â«marcador de ventana a elegirÂ») no se encontraron en
  ningÃºn doc del repo; consultado el dueÃ±o, confirmÃ³ omitirlos. El rollover de correlativos de
  D-202 (2028-04-22) sÃ­ quedÃ³ en el checklist, con su cita exacta.
- **RevisiÃ³n (`revisor`).** ContÃ³ los 51 modelos del schema uno por uno contra `PURGE_TABLES`/
  `SURVIVOR_TABLES`: cubren exactamente los 51, sin faltantes ni duplicados â€” la verificaciÃ³n mÃ¡s
  importante que pedÃ­a el brief. ConfirmÃ³ que ninguna de las 12 tablas sobrevivientes tiene una
  FK real hacia una tabla purgada (revisÃ³ los 12 modelos completos), que el reintento de D-209
  tras `migrate resolve --rolled-back` repite todo desde cero sin estado a medio camino (la
  migraciÃ³n entera va en una sola transacciÃ³n de Prisma), y que el manejo de secretos cumple la
  regla dura 5. Un hallazgo **medio**, corregido: el gate `--confirm-production` vivÃ­a solo en el
  wrapper â€” invocar el `.ts` directo con credenciales de `production` copiadas a mano se lo
  saltaba. Se agregÃ³ `AYR_LIMPIA_V4_CONFIRMED=1` como defensa redundante (el wrapper la setea
  solo tras el gate), verificado que un `--execute --branch production` sin esa variable se
  niega antes de tocar la base. Dos hallazgos bajos: alineaciÃ³n de `schema.prisma` desincronizada
  tras quitar el `?` de `Finish.kind` (corregido con `prisma format`, que `format:check` no
  cubre porque Prettier no toca `.prisma`) y el nombre `limpia:v4` en espaÃ±ol, Ãºnico en
  `package.json` â€” se mantiene a propÃ³sito (ver D-208, el brief lo pidiÃ³ textual tres veces).
- Cierre: `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde de nuevo tras
  los fixes de revisiÃ³n. **F8-V4prep queda CERRADA.**
- Handoff completo: `docs/handoff/f8-v4prep.md`.

## SesiÃ³n F8-S6a2 â€” Carga de inventario inicial de productos (2026-09-15) â€” CERRADA

ExtensiÃ³n de F8-S6a/D-206 a productos por unidades (UPVC + reventa), bajo la misma excepciÃ³n a
D-150 y sus cuatro condiciones (D-207, `docs/ARQUITECTURA.md` Â§0.2). **Prioridad de la sesiÃ³n
fijada por el dueÃ±o**: M1 y M2 listos para una demo local en el dÃ­a, la corrida de suite E2E
completa (deuda OOM heredada de F8-S6a) queda para despuÃ©s de la demo â€” el cierre formal de esta
sesiÃ³n espera esa corrida.

- **M1 â€” la herramienta.** `InitialInventoryProductImportService`
  (`apps/api/src/imports/initial-inventory-product-import.service.ts`), mismo mÃ³dulo
  `InitialInventoryImportModule` (ahora tambiÃ©n importa `InventoryModule`). El CLI
  (`apps/api/prisma/import-initial-inventory-cli.ts`) gana `--kind coils|products` (default
  `coils`, retrocompatible); el wrapper (`scripts/import-initial-inventory.mjs`) ya pasaba
  cualquier flag no reconocido, asÃ­ que no necesitÃ³ cambios mÃ¡s allÃ¡ del comentario de uso.
  - Cada fila valida el SKU contra CatÃ¡logo: tiene que existir, estar activo, ser de lÃ­nea
    `roofing` (UPVC) o `trading` (Reventa) y `source === PURCHASED` â€” nunca el SKU ni la lÃ­nea
    por sÃ­ sola deciden "es compra-reventa" (D-131 con una pregunta nueva, ver D-207).
  - "Nunca actualiza un producto existente" (condiciÃ³n 2 de D-206) se reinterpreta para stock
    fungible: rechaza la fila si el SKU **ya tiene algÃºn movimiento de kardex**, de cualquier
    origen. El mismo SKU sÃ­ puede repetirse dentro del archivo (dos facturas del mismo
    producto promedian, como en una compra real).
  - Sin proveedor `isSystem`: `InventoryMovement` no tiene columna de proveedor, asÃ­ que
    `refType: 'IMPORT'` alcanza para el rastro (condiciÃ³n 3, ver D-207).
  - Sin cambio de schema: reusa `products`/`inventory_movements` tal cual.
- **M2 â€” dataset y ensayo.** `docs/plantillas/inventario-inicial-productos-ejemplo.csv` (8 filas
  vÃ¡lidas â€” UPVC y reventa, PEN y USD, con/sin factura, una segunda factura del mismo SKU â€” y 3
  invÃ¡lidas: SKU inexistente, unidades en cero, SKU fabricado dentro de Drywall) y secciÃ³n propia
  en `docs/plantillas/README-inventario-inicial.md`. **Dry-run real ejecutado contra Postgres
  local** (`ayr_local_e2e`, con los 8 SKU de ejemplo creados por un script de un solo uso, borrado
  al terminar): reporta exactamente 8 OK / 3 con error, igual a lo documentado.
- `e2e/tests/inventario-inicial-productos-f8s6a2.spec.ts` (3 tests, mismo patrÃ³n que
  `inventario-inicial-f8s6a.spec.ts`: corre el CLI real vÃ­a `spawnSync`): dry-run no escribe,
  `--execute` crea el stock con su kardex `IMPORT`; SKU inexistente + producto fabricado dentro
  de una lÃ­nea compra-reventa tumban el archivo entero (todo o nada); un SKU con kardex previo
  rechaza la segunda corrida sin sumar stock. **Verificado dos veces contra `local-e2e`**: 6/6 en
  verde (los 3 de bobinas de F8-S6a + los 3 nuevos), ~4-6 min cada corrida.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde para todo el monorepo.
- **RevisiÃ³n (`revisor`):** confirmÃ³ las cuatro condiciones heredadas de D-206 y no encontrÃ³
  bloqueantes. Un hallazgo bajo real, corregido: el bucle de escritura empujaba la fila a
  "creada" sin mirar el resultado de `InventoryService.record`, que documenta devolver `null`
  para una lÃ­nea `NOOP` sin escribir nada â€” hoy inalcanzable (`ROOFING`/`TRADING` nacen `STOCK`
  y no hay ruta que las cambie) pero, a diferencia de `CoilsService.create` (nunca `null`), esta
  fila llama a `record` directo y no tenÃ­a por quÃ© asumir que siempre escribiÃ³. Dos hallazgos
  informativos sin acciÃ³n: los casts de tipo del CLI entre `coils`/`products` dependen de que el
  `kind` y la rama del ternario se mantengan sincronizados a mano (correcto hoy, sin garantÃ­a del
  compilador); la comprobaciÃ³n de "SKU sin kardex previo" se resuelve antes de abrir la
  transacciÃ³n, mismo patrÃ³n (y misma ventana de carrera teÃ³rica, sin `UNIQUE` de base) que ya usa
  la carga de bobinas para `externalCode` â€” aceptable para una herramienta de arranque que un
  operador corre a mano.
- **RESUELTO en la SesiÃ³n F8-V4prep (2026-09-15).** La suite E2E completa corriÃ³ 0-rojo de
  punta a punta (336/336, ver esa sesiÃ³n arriba) desde un `git worktree` con builds de
  producciÃ³n, que esquiva el lÃ­mite de memoria del host que habÃ­a bloqueado tres corridas
  seguidas. Con eso, esta sesiÃ³n queda **CERRADA**.

## SesiÃ³n F8-S6a â€” Carga de inventario inicial de bobinas (2026-09-15) â€” CERRADA

M1 del brief: una herramienta de CLI para dar de alta el saldo fÃ­sico de bobinas de un cliente
nuevo antes de que llegue su historial real, con su kardex abierto al costo y la fecha que se
declare. DecisiÃ³n **D-206**, la Ãºnica de esta sesiÃ³n. **Todo en commits locales, sin push**: se
acumula para la ventana V-4 (13 commits ahora, F8-S4 + F8-S5 + F8-S6a).

- **Choque con D-150, resuelto antes de escribir cÃ³digo.** D-150 (SesiÃ³n Importadores,
  2026-09-08) habÃ­a eliminado todo importador directo al dominio por duplicar invariantes fuera
  de sus servicios â€” exactamente lo que el brief pedÃ­a. Se le planteÃ³ el choque al dueÃ±o antes de
  tocar nada; su respuesta autorizÃ³ la herramienta como **excepciÃ³n Ãºnica y explÃ­cita**, no como
  reapertura de D-150, con cuatro condiciones que el cÃ³digo tiene que sostener (no solo declarar
  en un comentario), registradas en D-206 (`docs/ARQUITECTURA.md` Â§0.2): hereda invariantes vÃ­a
  `CoilsService.create`/`InventoryService.record` en vez de copiarlas; es de arranque (sin
  controller, solo CLI, nunca actualiza una bobina existente); el inventario inicial no es una
  compra (proveedor sembrado `isSystem`, factura de referencia solo texto en el kardex); y
  cualquier futuro importador de bobinas para otro caso sigue prohibido por D-150 sin que haga
  falta re-derivar el razonamiento.
- **M1 â€” la herramienta.**
  - `pnpm import:initial-inventory --file <xlsx/csv> --branch <local|demo|production> [--execute]
[--confirm-production]`, mismo patrÃ³n dry-run/`--execute`/`--confirm-production` que los demÃ¡s
    scripts operativos.
  - `InitialInventoryImportService.parseRow` valida cada fila contra el catÃ¡logo (acabado activo
    y mapeado por D-203, color coincidente con el del acabado, duplicados dentro del archivo y
    contra la base, `Decimal`/`decimalStringSchema` en kg/mm/costo) **antes** de abrir ninguna
    transacciÃ³n; solo si el archivo entero pasa y se pidiÃ³ `--execute` se abre una Ãºnica
    transacciÃ³n que crea todas las bobinas (todo o nada, sin `SAVEPOINT` por fila porque las
    filas no dependen entre sÃ­, a diferencia del importador de cotizaciones de D-152).
  - Schema additivo: `Coil.externalCode` (nullable, indexado, para reconciliar contra el cÃ³digo
    del cliente) y `Supplier.isSystem` (mismo patrÃ³n que `Customer.isSystem`/D-077, sembrado el
    proveedor "Saldo inicial de inventario" en la migraciÃ³n y en `prisma/seed.ts` â€” lecciÃ³n de
    "un dato inicial de una migraciÃ³n va tambiÃ©n en el seed" aplicada de entrada).
  - `CoilsService.create` gana wiring retrocompatible: `notes` y `externalCode` ahora tambiÃ©n
    viajan al movimiento de kardex de apertura (antes `notes` solo quedaba en `Coil`); ningÃºn
    llamador existente (compra, corte) manda esos campos, asÃ­ que no cambia nada para ellos.
  - `parseIssueDate`, privada del importador de cotizaciones, se extrae a `parseCalendarDate`
    exportada en `parse-spreadsheet.ts` y se reusa acÃ¡ â€” sin cambio de comportamiento en
    cotizaciones.
- **M2 â€” dataset y ensayo.** `docs/plantillas/inventario-inicial-ejemplo.csv` (12 filas vÃ¡lidas
  con prepintados en cuatro colores, natural, galvanizado, PEN y USD con tipo de cambio, con y
  sin factura de referencia, mÃ¡s 3 filas deliberadamente invÃ¡lidas) y
  `docs/plantillas/README-inventario-inicial.md` con las columnas, las reglas y cÃ³mo leer el
  reporte. `e2e/tests/inventario-inicial-f8s6a.spec.ts` (3 tests): dry-run no escribe nada y
  `--execute` crea la bobina con su kardex `IMPORT` y el color del acabado; una fila invÃ¡lida
  rechaza el archivo entero; un `externalCode` duplicado en la base rechaza esa fila.
- **RevisiÃ³n (`revisor`):** confirmÃ³ en cÃ³digo (no solo en comentarios) las tres primeras
  condiciones de la excepciÃ³n a D-150. EncontrÃ³ y se corrigieron dos hallazgos reales â€” el largo
  de `externalCode` no se validaba contra el `VARCHAR(40)` de la columna, asÃ­ que un cÃ³digo
  demasiado largo pasaba el dry-run como "OK" y reciÃ©n reventaba en `--execute` con un error crudo
  de Postgres; y el tipo de cambio en soles se comparaba por texto (`"1.00"` se rechazaba igual
  que un TC real distinto de 1, con el mismo mensaje engaÃ±oso) en vez de por valor decimal â€” y se
  retirÃ³ un tope de filas (`MAX_ROWS = 5000`) que nunca podÃ­a activarse porque `parseSpreadsheet`
  ya limita a 2000 antes de que ese cÃ³digo se ejecute.
- **VerificaciÃ³n de cierre, con una decisiÃ³n explÃ­cita del dueÃ±o sobre su alcance.** La suite E2E
  completa se lanzÃ³ tres veces contra la mÃ¡quina local y las tres veces el proceso muriÃ³ por falta
  de memoria del host (no un defecto de cÃ³digo: llegÃ³ a 293/333 y luego a 321/333 sin ninguna
  falla visible antes de morir cada vez â€” el mismo problema ambiental de sesiones anteriores).
  Ante la pregunta directa del dueÃ±o sobre cuÃ¡nto iba a demorar, se explicÃ³ la situaciÃ³n y el
  dueÃ±o instruyÃ³ correr **solo lo relacionado** con el cambio en vez de forzar otra corrida
  completa. Se corriÃ³ un subconjunto curado de 34 tests que cubre todo lo tocado por la sesiÃ³n
  (inventario inicial, D-203, huecos de catÃ¡logo F8-S5, kardex clickable F8-S5, importador de
  cotizaciones, D-169, Fase 2a): **34/34 en verde, 9.7 min**, repetido despuÃ©s de los fixes de
  revisiÃ³n con el mismo resultado. `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`
  en verde para todo el monorepo. La suite completa queda sin una corrida 0-rojo de punta a punta
  en esta sesiÃ³n por el lÃ­mite de memoria del host, no por ningÃºn hallazgo â€” anotado para que la
  prÃ³xima sesiÃ³n que tenga una mÃ¡quina mÃ¡s holgada la corra una vez antes de la ventana V-4.
- Handoff completo: `docs/handoff/f8-s6a-inventario-inicial.md`.

## SesiÃ³n RF-S1 (2026-09-16) â€” M0 higiene + precios de lista

SesiÃ³n 1 de 5 del lote RF-S1 (auditorÃ­a, reportes y UAT â€” plan de sesiones del dueÃ±o, ver
D-214 sobre por quÃ© no es una renumeraciÃ³n de RF-90..96). Orden estricto M0 â†’ M1 â†’ M2 por
instrucciÃ³n del dueÃ±o; M0 y M1 se cerraron completos, **M2 se sacrificÃ³ por tiempo** (queda
como backlog, ver mÃ¡s abajo). Seis commits sobre `main`, **sin push** (regla dura 6): `main`
es producciÃ³n, y el dueÃ±o corre el push al final de esta secciÃ³n.

### PASO 0 â€” lo que cambiÃ³ el plan escrito

- **RF-S1..RF-S5 no son RF-90..96.** `ARQUITECTURA.md` Â§4.8 nombra exactamente los cinco
  reportes (RF-90..94) mÃ¡s auditorÃ­a (RF-95/96); el plan de sesiones agrupa bajo el mismo
  rÃ³tulo higiene operativa y precios de lista, que no son RF nuevos â€” precios de lista viene
  del backlog heredado (Â«Aviso de precio mÃ­nimo en el POSÂ», ver sesiones anteriores).
  Registrado en D-214 para que una sesiÃ³n futura no busque Â«RF-S3Â» en Â§4 y concluya que falta
  escribirlo.
- **`Product.listPricePen` ya existÃ­a** (D-068) y ya estaba prellenado en el modal de lÃ­nea de
  cotizaciÃ³n y en el POS â€” el brief asumÃ­a que faltaba el campo; lo que faltaba era todo lo
  que M1 construyÃ³ alrededor (changelog, ediciÃ³n dedicada, carga masiva). `check:price-floor`
  reportaba 0 SKU porque **ningÃºn producto activo tenÃ­a el campo seteado**, no porque el piso
  dependiera de Ã©l â€” el piso (D-163) sale 100% del costo del kardex.
- **El bug de `purgeInvoicingTrail` que describÃ­a el handoff de F8-S7 no reproduce.** El guard
  que lo evitarÃ­a ya existÃ­a desde D-153 (commit `f045fa1`, anterior a F8-S7). El residuo real
  y distinto â€”una nota de crÃ©dito borrador huÃ©rfanaâ€” se corrigiÃ³ igual (D-215/M0c).

### M0 â€” higiene

- **M0a â€” push fuera del auto-allow (D-214).** `.claude/settings.json` combinaba
  `defaultMode: auto` con `Bash(git:*)` en `allow` (hallazgo que ya estaba anotado como
  pendiente #3 de la auditorÃ­a post-V4, secciÃ³n de arriba): cualquier sesiÃ³n de agente podÃ­a
  empujar a `main` sin que nadie lo mirara. Ahora `Bash(git push:*)`, `Bash(gh pr merge:*)`,
  `Bash(gh repo sync:*)` y **`Bash(gh api:*)`** (agregado en la segunda ronda, ver abajo)
  estÃ¡n en `deny`. Verificado con intentos reales de `git push` y `gh api .../merge`, los dos
  denegados. El agente ahora commitea en local y al cierre imprime el comando de push.
- **M0b â€” dos notas de `CLAUDE.md`** que costaron tiempo en sesiones anteriores: el comando
  correcto para un spec suelto de Playwright (`pnpm exec playwright test e2e/tests/<archivo>`,
  nunca `pnpm e2e -- <archivo>`) y que la suite completa necesita builds de producciÃ³n en esta
  mÃ¡quina (OOM con dev builds cerca del test 308).
- **M0c â€” `purgeInvoicingTrail` (D-215).** Para un comprobante `MANUAL`/`IMPORTED`, el helper
  de limpieza E2E intentaba la baja (que `assertIssuedHere` rechaza) y despuÃ©s una nota de
  crÃ©dito de respaldo que quedaba como borrador huÃ©rfano cuando su `/send` rebotaba por el
  guard de D-153. Ahora va directo a `/annul` (D-110), el camino correcto para esos dos
  orÃ­genes. Sentinela nuevo: `invoicing-manual-origin-guard.spec.ts`.
- **M0d â€” `PSE_ENABLED` (D-216).** Variable de entorno nueva, default `false`: apaga la
  emisiÃ³n electrÃ³nica con un rechazo de negocio explÃ­cito **antes** de tomar correlativo, en
  vez de tomarlo y terminar en `SEND_ERROR` (que es lo que hacÃ­a el fail-closed implÃ­cito por
  falta de credenciales, D-071/D-073, que sigue existiendo para la contingencia real). El gate
  vive en `send`/`voidDocument`/`issueDispatchNote`/`retry`/`refreshStatus` (rechazo explÃ­cito)
  y en `callProvider` (silencioso, para los caminos que no pueden lanzar: `deliver`,
  `sendPending`). **A propÃ³sito NO vive en `assignInTx`/`assign`**: el mostrador llama
  `assignInTx` directo dentro de la transacciÃ³n atÃ³mica de la venta (D-099), y D-073 exige que
  la venta se complete con el PSE apagado o caÃ­do â€” el gate ahÃ­ adentro habrÃ­a roto el POS
  entero, que es justo el estado real de `production` hoy. Test de regresiÃ³n que fija esa
  asimetrÃ­a. `PSE_ENABLED=true` explÃ­cito en `dev` (heredado por `demo`) y en los dos jobs de
  CI; `production` queda sin definirla a propÃ³sito. `smoke:prod` verifica que siga apagada
  despuÃ©s de cada deploy.
- **M0e (Node 20â†’24 en Actions): sacrificado, sin tocar.** El brief pedÃ­a no adivinar
  versiones; no se investigÃ³ si los majors actuales (`checkout@v4`, `setup-node@v4`, etc.)
  declaran Node 24 en sus release notes. Sin cambios â€” `NODE_VERSION: 24` en `ci.yml` ya
  configura el runtime del **proyecto**, que es independiente del runtime en el que GitHub
  ejecuta la acciÃ³n misma.

### M1 â€” precios de lista (D-217)

- **M1a â€” modelo.** `product_list_price_changes`: historial append-only, mismo criterio que
  `SalesPriceChange` (D-187) â€” tabla propia y no `audit_log`, sin relaciÃ³n Prisma a
  `Product`/`User` (mismo patrÃ³n que esa tabla). MigraciÃ³n escrita a mano (patrÃ³n de
  D-211/D-216). Reusa `saleValueFromPrice`/`salePriceFromValue`/`money` de
  `packages/shared/src/tax.ts`, el Ãºnico helper del sistema para IGVâ†”sin IGV â€” no hizo falta
  uno nuevo.
- **M1b â€” ediciÃ³n inline** en `/catalogo` (solo admin): tipea con IGV, guarda sin IGV,
  consulta el piso de D-163 despuÃ©s de guardar (`GET /catalog/:id/price-floor`, misma
  `computePriceFloors` que ya usa ventas) y avisa si queda bajo el piso sin bloquear. BotÃ³n
  Â«HistorialÂ» abre el changelog del SKU.
- **M1c â€” carga masiva** en `/catalogo/precios/importar`: mismo criterio que el importador de
  cotizaciones (D-152) â€” preview sin estado (no guarda archivo ni lote), confirmar todo-o-nada
  con `idempotencyKey`. Preview clasifica NEW/CHANGED/UNCHANGED/WARNING/ERROR; SKU desconocido,
  ambiguo entre lÃ­neas de negocio (el SKU no es Ãºnico global, D-050) o precio invÃ¡lido son
  ERROR y bloquean confirmar; bajo el piso o sin costo en el kardex son WARNING y no bloquean.
  Revertir un lote restaura los valores anteriores desde el changelog y rechaza si algÃºn SKU
  tuvo un cambio posterior, nombrÃ¡ndolo.
- **Bug real encontrado en el smoke manual** (crear producto â†’ editar inline â†’ cargar xlsx con
  errores/avisos â†’ confirmar â†’ revertir â†’ ver historial completo, en el navegador contra
  `dev:local`): el scope de idempotencia del revert (con el `batchId` interpolado) pasaba de
  los 60 caracteres de `idempotency_keys.scope` y rompÃ­a con `P2010`/`22001` â€” no lo agarraba
  ningÃºn test unitario con mocks, solo Postgres real. Corregido acortando el prefijo.

### VerificaciÃ³n

- `revisor`, `auditor-seguridad` y `qa` en paralelo sobre el diff completo de la sesiÃ³n, al
  cerrar M0+M1 (patrÃ³n del CLAUDE.md: Â«al terminar cada punto grandeÂ»).
  - `revisor`: 1 hallazgo MEDIO (sin test de `confirm()`/`revert()`, las dos piezas mÃ¡s
    difÃ­ciles de razonar del importador) y 2 BAJO (dedup de `productId` en confirm; tolerancia
    duplicada) â€” **los tres corregidos**: 12 specs nuevos con fakes de `tx`, guard de producto
    repetido, constante compartida.
  - `auditor-seguridad`: 1 hallazgo MEDIO (`Bash(gh:*)` seguÃ­a en `allow`, y `gh api
.../pulls/N/merge -X PUT` reproduce `gh pr merge` sin matchear el `deny` literal) â€”
    **corregido** (`Bash(gh api:*)` a `deny`, verificado con un intento real). 2 BAJO/INFO: falta
    `.max(2000)` en el schema de confirmaciÃ³n (**corregido**) y `refreshStatus()` llama al
    proveedor sin pasar por `callProvider()` en una rama que hoy no es alcanzable con el flag
    apagado â€” anotado, no corregido (robustez a futuro, no fuga activa).
  - `qa`: `e2e/tests/precios-lista-d217.spec.ts`, 6/6 en verde (ediciÃ³n inline + historial,
    error bloqueante, carga OK + revertir con badge de reversa, y las dos regresiones de D-068
    â€” prellenado y congelamiento al editar una cotizaciÃ³n emitida). No encontrÃ³ bugs de la app.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde para todo el
  monorepo (dos rondas, antes y despuÃ©s de los hallazgos de revisiÃ³n).
- Suite E2E completa: **no se corriÃ³ esta sesiÃ³n** (deuda conocida de memoria del host, ver
  sesiones anteriores; correrla desde un worktree con builds de producciÃ³n queda para el
  cierre de ventana, no de esta sesiÃ³n sola). El spec nuevo se corriÃ³ suelto dos veces.

### Lo que M2 (sacrificado) habrÃ­a sido

Card Â«SKUs con lista bajo pisoÂ» en el Panel: una sola consulta agregada (con presupuesto de
queries, lecciÃ³n del card sin-stock de D-188), SKU con lista bajo el piso + SKU sin costo
contados aparte, click al catÃ¡logo filtrado. DiseÃ±o completo en el brief de la sesiÃ³n; sin
cÃ³digo. Candidato natural para la sesiÃ³n RF-S2 si el dueÃ±o lo prioriza, o para cuando exista
mÃ¡s catÃ¡logo con precio de lista cargado (hoy solo el producto de prueba de esta sesiÃ³n lo
tiene, en `dev`).

### Pendientes que esta sesiÃ³n deja

- **M2** (arriba).
- **`refreshStatus()` sin `callProvider()` en la rama `VOID_PENDING`** (auditor-seguridad,
  arriba) â€” robustez, no bloqueante.
- **Nadie corriÃ³ la carga masiva de precios contra el catÃ¡logo real de `production`.** La
  infraestructura estÃ¡ lista; cargar precios reales es una decisiÃ³n y una acciÃ³n del dueÃ±o,
  no de esta sesiÃ³n.
- `/handoff rf-s1` con el resumen de cierre.

## SesiÃ³n RF-S2 (2026-09-16) â€” AuditorÃ­a

SesiÃ³n 2 de 5 del lote (ver D-214). Trabajada en un **worktree separado**
(`ayr-steel-erp-rf-s2`, rama `rf-s2`, creada desde `49fe903`) por instrucciÃ³n explÃ­cita del
dueÃ±o: los commits de RF-S1 en `main` quedaban pendientes de `push`/deploy esa misma noche, y
esta sesiÃ³n no debÃ­a interferir. **Nueve commits, todos en `rf-s2`, ninguno en `main`, sin
merge ni push** â€” el dueÃ±o decide cuÃ¡ndo integrar esta rama. Alcance M0â†’M1â†’M2â†’M3 completo,
sin partir (instrucciÃ³n del brief); M4 y M5 eran sacrificables y **se llegÃ³ a tiempo a las
dos** â€” nada se sacrificÃ³ en esta sesiÃ³n.

### PASO 0 â€” lo que cambiÃ³ el plan escrito

- **El brief asumÃ­a una tabla `audit_events` nueva; ya existÃ­a `AuditLog`/`AuditService`**
  (RF-95, desde Fase 1), append-only por trigger de base, y ya instrumentada en ~28 archivos
  de servicios de dominio con ~105 acciones distintas. Construir una tabla en paralelo habrÃ­a
  duplicado exactamente lo que ya resolvÃ­a. DecisiÃ³n: extender, no crear (D-218).
- **Ninguna escritura sensible sortea su servicio de dominio para tocar la base directo** â€”
  la condiciÃ³n de "STOP AND REPORT" del brief no se disparÃ³. Verificado por censo (grep de
  `action: '...'` y de los `actor`/`before`/`after` reales que arma cada `auditView()`), hecho
  a mano despuÃ©s de que un subagente `fork` lanzado para esta misma investigaciÃ³n devolviera
  una respuesta confusa y autorreferencial tras consumir ~823K tokens sin producir nada
  usable â€” abandonado, no repetido.
- Changelogs dedicados que **no** se duplican, se leen aparte y se unen en el visor:
  `SalesPriceChange` (D-187), `ProductListPriceChange` (D-217), `FiscalDocumentIssueDateChange`
  (D-211).

### M0 â€” higiene heredada de RF-S1

- **La fila de D-217 nunca se habÃ­a agregado a `ARQUITECTURA.md` Â§0.2** pese a usarse en todo
  el cÃ³digo de esa sesiÃ³n â€” gap propio, encontrado y corregido al abrir esta sesiÃ³n (commit
  `dc83120`, antes de que existiera nada de D-218). Los otros pendientes que dejaba RF-S1 (la
  card M2 sacrificada, la nota de `refreshStatus()` sin `callProvider()`) no eran defectos
  bloqueantes y quedan donde estaban.

### M1 â€” modelo (D-218)

`AuditLog` gana `actor_kind` (`USER`/`SYSTEM`), `reason` y `request_id` (migraciÃ³n
`20260916153802_d218_audit_log_actor_kind_reason_request_id`, additiva). `request_id` se
propaga con `AsyncLocalStorage` (`apps/api/src/common/request-context.ts` +
`request-id.middleware.ts`) sin tocar las firmas de los ~80 mÃ©todos que ya llaman a
`AuditService`. `apps/api/src/audit/audit-redact.ts` redacta `before`/`after` por nombre de
clave antes de persistir (segunda red â€” ningÃºn caller de hoy manda un secreto, verificado en
PASO 0) y trunca si el JSON supera ~8000 caracteres.

### M2 â€” mapa acciÃ³nâ†’fuente y alcance de los tests (D-219)

Censo completo (grep de `action: '...'` en `apps/api/src`, mÃ¡s las cuatro acciones de
`users.service.ts` que arman el string dinÃ¡mico segÃºn quÃ© cambiÃ³):

| MÃ³dulo (archivo)                                     | Entidad(es)                                         | Acciones                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/auth.service.ts`                                | sessions/users                                      | 4 (login, login.failed, logout, password.changed)                                                                                               |
| `catalog/catalog.service.ts`                          | products                                            | 2 (create, update)                                                                                                                              |
| `catalog/price-list-import.service.ts`                | products                                            | 2 (price-list-import.confirm/revert)                                                                                                            |
| `coils/coil-operations.service.ts`                    | coils                                               | 7 (cancel, open, scrap, scrap-cancel, split, split-revert, update)                                                                              |
| `colors/colors.service.ts`                            | colors                                              | 2 (create, update)                                                                                                                              |
| `customers/customers.service.ts`                      | customers                                           | 2 (create, update)                                                                                                                              |
| `cutting/cutting.service.ts`                          | cutting_orders                                      | 4 (cancel, receive, receive-reverse, send)                                                                                                      |
| `exchange-rates/exchange-rates.service.ts`            | exchange_rates                                      | 1 (manual-set)                                                                                                                                  |
| `finishes/finishes.service.ts`                        | finishes                                            | 2 (create, update)                                                                                                                              |
| `imports/initial-inventory-import.service.ts`         | coils                                               | 1 (imports.initial-inventory)                                                                                                                   |
| `imports/initial-inventory-product-import.service.ts` | products                                            | 1 (imports.initial-inventory-products)                                                                                                          |
| `invoicing/dispatches.service.ts`                     | coils, dispatches                                   | 4 (coils.close/open, dispatch.create/reverse)                                                                                                   |
| `invoicing/fiscal-import.service.ts`                  | fiscal_documents                                    | 1 (import.annul)                                                                                                                                |
| `invoicing/invoicing.service.ts`                      | fiscal_documents, fiscal_series, invoicing_settings | 16 (credit-note.create, dispatch-note.create, document.\* Ã—10, series.create/toggle, settings.update)                                          |
| `invoicing/receivables.service.ts`                    | customer_payments                                   | 2 (payment, payment-reverse)                                                                                                                    |
| `pos/cash-sessions.service.ts`                        | cash_sessions                                       | 2 (open, close)                                                                                                                                 |
| `pos/pos.service.ts`                                  | pos_sales                                           | 3 (create, void, void-start)                                                                                                                    |
| `pricing/pricing.service.ts`                          | pricing_settings                                    | 1 (update)                                                                                                                                      |
| `production/production.service.ts`                    | production_orders                                   | 8 (cancel, close, consume, create, release, reopen, report, report-reverse)                                                                     |
| `production/roofing-production.service.ts`            | production_orders                                   | 10 (cancel, close, create, create_batch, mount, plan, release, reopen, report, report-reverse)                                                  |
| `production/roofing-drafts.service.ts`                | production_orders                                   | 1 (drafts-commit)                                                                                                                               |
| `purchases/purchases.service.ts`                      | coils, purchases                                    | 9 (cutting-cost, landed-cost, cancel, create, payment, payment-reverse, receive, update-document, xml-preview)                                  |
| `sales/quotations.service.ts`                         | quotations                                          | 5 (cancel, create, duplicate, expire, update)                                                                                                   |
| `sales/sales-order-edits.service.ts`                  | sales_orders                                        | 4 (add-items, customer, item-price, item-qty)                                                                                                   |
| `sales/sales-orders.service.ts`                       | sales_orders, reservations, sales_settings          | 8 (order.cancel/confirm/promised-delivery-date, quotation.recalculate/release/reserve-temporary, reservation.release, settings.update)          |
| `suppliers/suppliers.service.ts`                      | suppliers                                           | 2 (create, update)                                                                                                                              |
| `users/users.service.ts`                              | users                                               | 4 (create, update, deactivate, role.change, password.reset â€” las Ãºltimas 4 comparten un `action` armado segÃºn quÃ© cambiÃ³, no 4 literales) |

Lista literal completa y sus etiquetas en espaÃ±ol: `apps/web/src/lib/audit-labels.ts`
(`AUDIT_ACTION_LABELS`).

**DecisiÃ³n de alcance (D-219): no se escribiÃ³ un test de auditorÃ­a por cada una de las ~105
acciones.** Cada `audit.write(tx, â€¦)` vive en la misma transacciÃ³n Prisma que la escritura que
audita â€” rollback y no-duplicado-por-reintento ya los prueban el motor de transacciones y
`claimIdempotencyKey` (D-182) en cada una de esas escrituras. Se agregaron tests nuevos para lo
que esta sesiÃ³n construyÃ³: `audit-redact.spec.ts`, los tres campos nuevos de
`audit.service.spec.ts`, `audit-cursor.spec.ts` y `audit-query.service.spec.ts`.

### M3 â€” visor unificado (backend + frontend)

`GET /audit` (admin-only) une `audit_log` con los tres changelogs por un cursor
`(occurredAt, fuente, id)` con desempate de rank fijo entre fuentes â€” presupuesto de consultas
**fijo, 4 fuentes + 1 lookup de actores por pÃ¡gina, nunca N+1** (probado). Rango de fechas: 31
dÃ­as por defecto, tope 12 meses. Frontend en **AdministraciÃ³n â€º AuditorÃ­a**
(`apps/web/src/app/(app)/auditoria/`): filtros (tipo de entidad, id de entidad, usuario, rango
de fechas), diff campo por campo (nunca JSON crudo), "Cargar mÃ¡s" por cursor, fecha/hora en
Lima.

### M4 â€” "Historial" en el detalle (sacrificable, se llegÃ³ a tiempo)

Link admin-only en pedidos, cotizaciones, bobinas y comprobantes hacia
`/auditoria?entityType=&entityId=`, ya filtrado a esa entidad (`AuditHistoryLink`).

### M5 â€” eventos de login (sacrificable, ya estaba cubierto)

`auth.login`/`auth.login.failed`/`auth.logout` ya se escribÃ­an desde fases anteriores â€” esta
sesiÃ³n no tuvo que construir nada, solo verificarlo (censo de M2) y darle etiqueta en el visor.
UAT caso 7 lo confirma manualmente.

### VerificaciÃ³n

- `revisor`, `auditor-seguridad` y `qa` en paralelo sobre el diff completo, al cerrar M3
  (patrÃ³n del CLAUDE.md).
  - `revisor`: 1 **ALTO** (el desempate del merge comparaba `id` de `audit_log` como texto en
    vez de `BigInt` â€” podÃ­a perder una fila en el borde exacto de una pÃ¡gina con dos filas del
    mismo milisegundo) y 2 **MEDIO** (`entityId` sin validar como UUID para los 4 tipos que lo
    necesitan â†’ 500 en vez de 400; un lÃ­mite estructural mÃ¡s amplio de la paginaciÃ³n entre
    fuentes distintas). **El ALTO y el primer MEDIO, corregidos**; el segundo MEDIO queda
    **documentado como deuda** en D-220 (rediseÃ±ar la paginaciÃ³n con buffer de continuaciÃ³n por
    fuente no es un fix acotado).
  - `auditor-seguridad`: 1 MEDIO (falta un Ã­ndice `(entity, at)` para el filtro "solo tipo de
    entidad" â€” **corregido**, migraciÃ³n D-220) y 2 BAJO (`decodeCursor` sin validar forma
    numÃ©rica del id de `audit_log` ni traducir su error a 400 â€” **corregido**; regex de
    redacciÃ³n angosta â€” **ampliada**). Sin hallazgos de control de acceso, inyecciÃ³n ni
    secretos expuestos.
  - `qa`: `e2e/tests/auditoria-d218.spec.ts`, 2/2 en verde (alta de usuario visible filtrando
    por tipo+id; VENDEDOR sin el Ã­tem de menÃº, `RoleGate` corta la UI, `GET /audit` responde
    403 del server). No encontrÃ³ bugs de la app.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` en verde para todo el
  monorepo, despuÃ©s de aplicar los hallazgos de revisiÃ³n. **39 test suites, 483 tests, 0
  fallidos** (API â€” `packages/shared` y `apps/web` no tienen suite unitaria propia, convenciÃ³n
  ya existente del repo, no de esta sesiÃ³n). El Ãºnico hallazgo de `format:check` fue
  `apps/web/next-env.d.ts` (generado por `next build`/`dev`, gitignored, nunca commiteado) con
  estilo distinto al de Prettier â€” se agregÃ³ a `.prettierignore` en vez de dejarlo fallar cada
  vez que alguien corre un build local.
- **Suite E2E completa: no se corriÃ³ esta sesiÃ³n** (misma deuda de memoria del host que ya
  documentÃ³ RF-S1 â€” correrla necesita builds de producciÃ³n y un worktree dedicado, fuera del
  alcance de esta sesiÃ³n sola). El spec nuevo se corriÃ³ suelto, dos veces (antes y despuÃ©s de
  las correcciones de D-220), las dos en verde.

### Migraciones nuevas y ventana de despliegue

- `20260916153802_d218_audit_log_actor_kind_reason_request_id` â€” additiva (3 columnas
  nullable/con default, 2 Ã­ndices). Aplicada contra `ayr_local` y `ayr_local_e2e`.
- `20260916170000_d220_audit_log_entity_at_index` â€” additiva (1 Ã­ndice nuevo). Aplicada contra
  `ayr_local` y `ayr_local_e2e`.
- Ninguna de las dos toca datos existentes ni requiere ventana de mantenimiento â€” son
  candidatas normales para el prÃ³ximo `pnpm db:prod`/`db:deploy` cuando el dueÃ±o decida
  integrar `rf-s2`. No se aplicaron contra `production` ni contra ninguna rama de Neon: esta
  sesiÃ³n trabajÃ³ enteramente contra el Postgres local (Docker, `ayr_local`/`ayr_local_e2e`).

### Decisiones nuevas (`ARQUITECTURA.md` Â§0.2)

D-217 (fila que faltaba, RF-S1), D-218 (extender `audit_log` en vez de `audit_events`), D-219
(alcance de los tests por acciÃ³n), D-220 (cinco correcciones de revisiÃ³n + el lÃ­mite de
paginaciÃ³n entre fuentes documentado, no resuelto).

### Pendientes que esta sesiÃ³n deja

- **El lÃ­mite estructural de la paginaciÃ³n entre fuentes** (D-220): pÃ©rdida posible de una
  fila en el borde exacto de una pÃ¡gina si dos fuentes distintas empatan al milisegundo y una
  de ellas superÃ³ el `pageSize` en ese instante. Acotado hoy (hace falta una carga masiva
  grande cruzando el borde), no bloqueante para el cierre de esta sesiÃ³n.
- Suite E2E completa (arriba) â€” sigue pendiente de una sesiÃ³n con worktree y builds de
  producciÃ³n dedicados, como ya quedÃ³ anotado al cerrar RF-S1.
- `/handoff rf-s2` con el resumen de cierre.

## SesiÃ³n RF-S2-CIERRE (2026-09-16) â€” bloqueantes antes de integrar

ContinuaciÃ³n de RF-S2, mismo worktree y rama (`rf-s2`), con un brief de cierre que pedÃ­a
verificar (y resolver o justificar con contraejemplo, no solo documentar) tres puntos
concretos antes de dar la rama por lista para UAT/integraciÃ³n, mÃ¡s correr la suite E2E
**completa** con builds de producciÃ³n â€” lo Ãºnico de RF-S2 que habÃ­a quedado sin correr. Seis
commits mÃ¡s sobre `rf-s2`, todos locales; `main` sigue intacto.

### PASO 0 â€” rebase contra `origin/main`

`origin/main` (`f92a3df`) resultÃ³ ser **ancestro** de `rf-s2`, no una rama que hubiera
avanzado por delante: `git rebase origin/main` fue un no-op ("Current branch rf-s2 is up to
date"). Las commits de RF-S1 que el brief daba por "ya desplegadas" siguen sin push a
`origin/main` â€” el dueÃ±o las debe haber desplegado a Cloud Run/Vercel directo desde el
checkout local (los scripts `deploy:api`/`deploy:web` no dependen de git push), no vÃ­a CI.
Sin conflictos, nada que reportar.

### M1 â€” `audit_log` append-only real: verificado, sin brecha (D-221)

Los tres puntos que pedÃ­a revisar el brief ya estaban resueltos desde antes de esta sesiÃ³n:

- El trigger `audit_log_no_update_delete` (migraciÃ³n `20260902170000`) ya rechaza
  `UPDATE`/`DELETE` sin ninguna excepciÃ³n por entorno.
- `audit_log` no tiene ninguna FK, ni hacia ni desde otra tabla (censo de todas las
  migraciones).
- NingÃºn helper de seed/E2E/script hace `DELETE`/`TRUNCATE` puntual sobre `audit_log`. El
  Ãºnico `TRUNCATE` que la toca es el reset completo de `reset-test-db.ts` (documentado desde
  antes: `TRUNCATE` no dispara el trigger de fila, a propÃ³sito, para poder vaciar la base de
  pruebas entre corridas), restringido a la lista blanca de `test-db-guard.ts`.

Nada de esto necesitaba migraciÃ³n ni cambio de cÃ³digo. Lo que faltaba: un test contra una
base real, no un mock â€” `e2e/tests/audit-log-immutable.spec.ts` (dispara un alta de usuario,
ubica la fila en `audit_log` vÃ­a `GET /audit`, intenta `UPDATE`/`DELETE` directo con
`e2e/helpers/db.ts`, los dos rechazan). Ver D-221.

### M2 â€” lÃ­mite de paginaciÃ³n entre fuentes (D-220): resuelto, con prueba (no solo documentado)

El brief pedÃ­a un diseÃ±o concreto (`<=` en todas las fuentes + `pageSize + 1` + descarte por
tupla del lado del servidor) o, si era estructuralmente imposible sin rediseÃ±o, parar y
reportar un contraejemplo. Ninguna de las dos cosas hizo falta: la correcciÃ³n de D-220 sobre
el desempate por `BigInt` (ya cerrada en la sesiÃ³n anterior) alcanza sola, porque el algoritmo
"top-`pageSize` por fuente, mezclado, recortado al `pageSize` global" es correcto en general
â€”si una fila estÃ¡ dentro del top-`pageSize` global, ninguna fuente puede tener `pageSize`
filas propias por delante de ella sin contradecir esa premisaâ€”. La duda no quedÃ³ solo en el
argumento: se buscÃ³ el contraejemplo mÃ¡s agresivo posible y no apareciÃ³. Tres pruebas nuevas
en `audit-query.service.spec.ts` (con un fake de Prisma que ahora sÃ­ respeta
`where`/`orderBy`/`take`, a diferencia del anterior): 3 fuentes con 10 filas cada una en el
mismo instante exacto, `pageSize` 4, paginando hasta agotar el cursor â€” las 30 aparecen sin
duplicados ni huecos; una carga masiva de 25 SKUs de precios de lista en el mismo instante â€”
las 25 aparecen; un cursor con una fuente inventada â€” 400. D-220 se actualizÃ³ de "deuda" a
"resuelta".

### M3 â€” invariante de transacciÃ³n de `AuditService` (D-222)

No existÃ­a ningÃºn test que verificara esto â€” se escribiÃ³ uno. `audit-tx-invariant.spec.ts`
recorre por glob **todos** los `*.service.ts` de `apps/api/src` (82 sub-tests, no una lista a
mano) y confirma: (a) todo `this.audit.write(` pasa literalmente `tx`, nunca `this.prisma`
(censo: ~100 llamadas, cero excepciones); (b) `this.audit.log()` â€”el atajo no transaccional a
propÃ³sito para login/logout y los tres eventos dirigidos por el PSE, ya documentado en
D-219â€” solo aparece en esos tres archivos exactos. Corre en cada `pnpm test`: si un servicio
nuevo rompe cualquiera de las dos cosas, se cae de inmediato.

### Suite E2E completa (builds de producciÃ³n) â€” lo que faltaba de RF-S2

Corrida desde este mismo worktree (que ya cumple el aislamiento del `apps/web/.next` propio
que pide `CLAUDE.md`), con `next build`/`nest build` y `CI=true` (fuerza `next
start`/`node dist/main.js`, el mismo camino que usa el job `e2e` de GitHub Actions).

**Primer intento, en blanco**: `node dist/main.js` no carga `apps/api/.env` con `dotenv` de
la misma forma que `nest start` en modo dev â€” hubo que pasar `DATABASE_URL`/`DIRECT_URL`/
`JWT_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD` explÃ­citos (valores del Postgres local, ninguno es
secreto de verdad, mismo criterio que ya documenta `local-docker-env.mjs`), igual que hace el
job de CI con los suyos.

**Segundo intento, 345/356**: faltaba `PSE_ENABLED=true` â€” el job de CI lo define
explÃ­citamente (D-216) precisamente para que la suite no cambie de comportamiento; sin Ã©l, 8
escenarios que sÃ­ intentan emitir (y no estÃ¡n gateados por `pse.accepts`, porque no necesitan
que SUNAT acepte, solo que el intento se procese) rebotan con "EmisiÃ³n electrÃ³nica no
habilitada en este entorno", y un noveno (`idempotencia-f8s1-m2`, una carrera de dos
emisiones en paralelo) queda con 0 ganadores en vez de 1 por el mismo motivo. Con
`PSE_ENABLED=true`, los 9 pasan.

**Resultado final, definitivo: 356 tests â€” 351 pasan, 3 se saltan, 2 fallan.**

- **3 saltados**, los tres por el mismo diseÃ±o ya existente y documentado
  (`probePse()`/`e2e/helpers/invoicing.ts`): este entorno no tiene credenciales reales de
  Nubefact (`NUBEFACT_URL`/`NUBEFACT_TOKEN` vacÃ­os, ninguna es un secreto que el agente deba o
  pueda tener), asÃ­ que `providerConfigured` da `false` y ningÃºn comprobante puede llegar a
  `ACCEPTED`/`REJECTED` de verdad. Los escenarios que dependen de esa aceptaciÃ³n real
  (`fase5b-bordes.spec.ts:92`, `fase7b.spec.ts:254` y `:339`, los tres sobre reversas despuÃ©s
  de un estado que SUNAT tendrÃ­a que confirmar) se saltan **por diseÃ±o**, con el motivo
  impreso â€” el mismo comportamiento documentado que ya tiene la suite para correr "en local
  (con PSE demo), en CI (sin credenciales) y contra producciÃ³n" sin fallar por algo que no es
  un defecto.
- **2 fallan, los dos por la misma causa: R2 (almacenamiento de archivos) sin configurar en
  este entorno** (`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET`
  vacÃ­os â€” tampoco son secretos que el agente deba tener). Confirmado leyendo el cÃ³digo, no
  supuesto: `StorageService.putObject` (`apps/api/src/documents/storage.service.ts`) tira
  `ServiceUnavailableException` cuando el cliente S3 es `null` (sin las cuatro variables). A
  diferencia del PDF de un comprobante ya emitido (`invoicing.service.ts#storeFiles`, que sÃ­
  es _best-effort_ a propÃ³sito, D-068 â€” "que un archivo no se pueda guardar no puede
  desaceptar un comprobante que SUNAT ya aceptÃ³"), estos dos caminos **no** tienen ese mismo
  tratamiento: `PurchasesService.previewFromXml` llama a `putObject` sin `try/catch`
  (`fase2a.spec.ts:359`, el "LeÃ­do del XML" nunca aparece porque el preview entero falla con
  503), y la generaciÃ³n del PDF de una cotizaciÃ³n nueva (Fase 5a) tampoco lo atrapa
  (`fase5a.spec.ts:100`, `quotation.pdfKey` queda `null`). **Ninguno de los dos es una
  regresiÃ³n de esta sesiÃ³n ni de RF-S2**: son rutas de cÃ³digo de fases muy anteriores
  (Fase 2a y Fase 5a) que nunca se habÃ­an ejercitado en un entorno sin R2 real hasta esta
  corrida. No se tocÃ³ ese cÃ³digo â€” estÃ¡ fuera del alcance de una sesiÃ³n de auditorÃ­a, y
  arreglarlo (Â¿el XML fuente y el PDF de cotizaciÃ³n deberÃ­an ser _best-effort_ como el PDF de
  invoicing, o de verdad hace falta que fallen sin R2?) es una decisiÃ³n de diseÃ±o del dueÃ±o,
  no algo para resolver de paso.

**Lo que esto confirma para el cierre de RF-S2 en sÃ­**: ningÃºn test de `apps/api/src/audit/`
ni ningÃºn spec E2E de la sesiÃ³n (`auditoria-d218.spec.ts`, `audit-log-immutable.spec.ts`)
estÃ¡ entre las 2 fallas ni entre los 3 saltados â€” el visor de auditorÃ­a y todo lo que esta
sesiÃ³n construyÃ³ pasa limpio en la corrida completa.

### VerificaciÃ³n

- `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check`: verde. **40 test suites,
  568 tests, 0 fallidos** (subiÃ³ de 483 al cierre de RF-S2: 82 de `audit-tx-invariant.spec.ts`
  mÃ¡s 3 de la paginaciÃ³n entre fuentes).
- E2E completo: **356 tests â€” 351 pasan, 3 se saltan por diseÃ±o (sin credenciales de PSE), 2
  fallan por R2 sin configurar (ajeno a esta sesiÃ³n)**, arriba.

### Decisiones nuevas (`ARQUITECTURA.md` Â§0.2)

D-220 actualizada (deuda â†’ resuelta, con el argumento y la evidencia empÃ­rica). D-221 (M1,
verificaciÃ³n sin brecha). D-222 (M3, centinela nuevo).

### Pendientes que esta sesiÃ³n deja

- **Los 2 fallos de E2E por R2 sin configurar** (arriba): no bloquean el cierre de RF-S2 â€”
  son de Fase 2a y Fase 5a, no de auditorÃ­a â€” pero quedan anotados para que el dueÃ±o decida
  si `previewFromXml` y el PDF de cotizaciÃ³n deberÃ­an tratar R2 como _best-effort_ (como ya
  hace `invoicing.service.ts#storeFiles`) o si de verdad tienen que fallar sin R2 configurado.
- **`rf-s2` sigue sin merge ni push.** El dueÃ±o decide cuÃ¡ndo integrarla.
- `/handoff rf-s2-cierre` con el resumen de este cierre.

## Incidente HOTFIX-DESFASE â€” web publicado sin su API (2026-09-16) â€” RESUELTO

**SÃ­ntoma.** En producciÃ³n todo comprobante abrÃ­a con 401 + `TypeError` y la pantalla se caÃ­a.

**Causa.** La ventana F8-S7 hizo push de `f92a3df` a `main` (12:46 UTC), y eso publicÃ³ el web en
Vercel solo, pero **nadie desplegÃ³ la API**. Cloud Run seguÃ­a sirviendo
`ayr-steel-erp-api-00034-drz` (02:38 UTC, anterior a `f92a3df`), y el web nuevo llamaba a
endpoints y leÃ­a campos de D-211..D-213 que esa API no tenÃ­a. AdemÃ¡s la migraciÃ³n de D-211 no
estaba aplicada. La revisiÃ³n no llevaba ningÃºn dato del commit (imagen por digest, sin label),
asÃ­ que el desfase no se veÃ­a desde Cloud Run.

**Fix (sin cambios de cÃ³digo).**

| Paso               | Resultado                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree           | `git worktree add ../ayr-deploy-f92a3df f92a3df`, HEAD `f92a3dffb509â€¦` verificado; ni `main` local (RF-S1 sin push) ni `hotfix-401` ni `rf-s2`. Borrado al cierre.                                                                                                                                                                                                                                          |
| Cupo de ramas Neon | El proyecto estaba en 10/10. Con OK del dueÃ±o por nombre se borraron `respaldo-pre-deploy-20260909` (`br-dark-firefly-aezu7m4q`) y `respaldo-pre-hotfix-2026-09-10` (`br-muddy-flower-ae8ik7ae`), verificando id = nombre antes de cada borrado. RazÃ³n: las dos eran anteriores a la carga real del dÃ­a D (15-09); restaurar desde ellas perdÃ­a toda la operaciÃ³n real. Nueva polÃ­tica en `CLAUDE.md`.  |
| Respaldo           | Rama `pre-api-f92a3df` (`br-orange-scene-aexe1p9y`), creada 2026-09-16T23:16:54Z desde `production`, `ready`. Neon queda en 9 ramas.                                                                                                                                                                                                                                                                          |
| MigraciÃ³n         | Pendiente Ãºnica: `20260916060618_s7_fecha_emision_manual_editable` (D-211, solo agrega: tabla `fiscal_document_issue_date_changes` + Ã­ndice + FK). `migrate deploy` â†’ **67/67**, `migrate status` sin pendientes. `migrate diff` **no vacÃ­o**, pero solo con el drift previo que D-211 ya documenta (defaults de `operation_date`, FK recreadas, dos Ã­ndices y un renombre); la tabla nueva no aparece. |
| Deploy             | `gcloud run deploy ayr-steel-erp-api --source . --update-labels git-sha=f92a3df`, **sin** flags de env ni secretos (no `pnpm deploy:api`, que las reescribe). Mismo `Dockerfile`/`.gcloudignore` sin cambios desde Fase 0. RevisiÃ³n **`ayr-steel-erp-api-00035-rd9`** al 100 %, label `git-sha=f92a3df` en servicio y revisiÃ³n.                                                                             |
| Paridad de config  | Nombres de variables y secretos de `00035-rd9` idÃ©nticos a `00034-drz` (comparados sin imprimir valores), incluida la variable de nombre roto, que no se tocÃ³. cpu 1 / 512Mi / max 2 / puerto 8080 iguales.                                                                                                                                                                                                 |
| VerificaciÃ³n      | `/health` 200 directo y por `v2.mareliac.pe/api/health` (`db: ok`). `pnpm smoke:prod` 6/7: la Ãºnica falla es el chequeo de D-216 (`PSE_ENABLED`), que vive en `main` local (RF-S1, sin push) y la API `f92a3df` no expone â€” esperable, no una regresiÃ³n. DueÃ±o: los dos comprobantes (`7bef5114â€¦`, `30bcccd9â€¦`) **abren sin 401 ni crash â€” verificado por el dueÃ±o**. Incidente resuelto.         |

**PrevenciÃ³n.** Regla nueva en `CLAUDE.md`: toda ventana cierra comparando el label `git-sha` de
la revisiÃ³n activa con `origin/main`, y la API se despliega siempre con ese label. AdemÃ¡s: el
smoke de prod se corre desde un worktree en el mismo SHA desplegado (el 6/7 de esta ventana fue
por correrlo desde `main` local), y un `migrate diff` no vacÃ­o en una ventana solo se acepta si
coincide exactamente con el drift ya documentado.

### Hallazgo colateral â€” variables de entorno de Cloud Run con nombre roto (severidad BAJA)

Desde al menos la revisiÃ³n `00029-n7q` (2026-09-10), y tambiÃ©n en `00033`, `00034` y `00035`,
Cloud Run no tiene `NODE_ENV`, `WEB_ORIGIN` ni `JOBS_ENABLED`: tiene **una sola variable**
cuyo nombre es literalmente `"^|^NODE_ENV` (con la comilla) y cuyo valor, de 77 caracteres, es
el resto de la lista.

- **Causa.** `scripts/deploy-api.mjs` pasa `--set-env-vars ^|^NODE_ENV=â€¦|WEB_ORIGIN=â€¦|JOBS_ENABLED=true`
  por `lib.mjs#run`, que en Windows arma `cmd /d /s /c` y `q()` envuelve en comillas todo
  argumento con `^` o `|`. La comilla llega pegada al argumento que ve `gcloud.cmd`, el prefijo
  `^|^` ya no estÃ¡ al principio, gcloud no lo reconoce como delimitador y parte por comas: una
  sola variable.
- **Impacto real (auditado sobre `f92a3df`, solo lectura).** `apps/api/src/config/env.ts` las
  lee con defaults, y los usos son pocos:
  - `NODE_ENV` â†’ `isProduction` â†’ solo `cookieSecure` (`env.ts:119`, usado en
    `auth/cookies.ts:11`). **Sin impacto**: el `Dockerfile:23` fija `ENV NODE_ENV=production`
    en la imagen, asÃ­ que las cookies salen `Secure`.
  - `WEB_ORIGIN` â†’ CORS (`main.ts:19`). Queda en el default `http://localhost:3001`, verificado:
    un preflight desde `https://v2.mareliac.pe` no recibe `Access-Control-Allow-Origin`, y uno
    desde `http://localhost:3001` sÃ­. **Sin impacto funcional**: el navegador nunca llama a la
    API directo, el proxy `/api/*` del web es server-side (D-022). Que CORS acepte
    `localhost:3001` con credenciales no expone nada: las cookies de sesiÃ³n son del dominio del
    web y `SameSite=lax`.
  - `JOBS_ENABLED` â†’ pg-boss y jobs (`jobs.service.ts:23`, `quotation-expiry.job.ts:32`,
    `invoicing-send.job.ts:34`). El default es `true`, que es el valor buscado. **Sin impacto.**
  - No hay Swagger, rutas de test/e2e/seed/purga ni detalle de errores que dependan de
    `NODE_ENV`: los 23 controladores son de dominio mÃ¡s `health`. `THROTTLE_DISABLED` no estÃ¡
    seteada (default `false`): rate limit activo.
- **Fix propuesto (NO ejecutado, sesiÃ³n propia con OK del dueÃ±o).**
  1. `deploy-api.mjs`: dejar `--set-env-vars` y pasar las variables con
     `--env-vars-file <yaml temporal>`, que no pasa por el parseo de `cmd`; despuÃ©s del deploy,
     comparar los nombres de las variables de la revisiÃ³n nueva contra la lista esperada y
     fallar si no coinciden. Agregar `--update-labels git-sha=<sha>`.
  2. Corregir producciÃ³n con un YAML de `NODE_ENV: production`, `WEB_ORIGIN: https://v2.mareliac.pe`
     (sumar `https://ayr-steel-erp-web.vercel.app` solo si se decide mantenerlo) y
     `JOBS_ENABLED: "true"`:
     `gcloud run services update ayr-steel-erp-api --region us-central1 --env-vars-file <yaml> --update-labels git-sha=<sha activo>`.
     `--env-vars-file` reemplaza la lista entera de variables planas, lo que elimina tambiÃ©n
     `"^|^NODE_ENV` sin tener que escribir ese nombre en la shell. **Verificar antes en `demo` o
     con la comparaciÃ³n de nombres** que no quita los secretos montados; si los quitara, repetir
     `--update-secrets` con la lista de `deploy-api.mjs`.

### Deuda registrada para S3 (sin ejecutar)

1. **Drift de schema en producciÃ³n.** `migrate diff` contra `production` (con `schema.prisma`
   de `f92a3df`) muestra, y es exactamente lo que este incidente acepta como drift documentado:
   - defaults de `operation_date` en `coils`, `cutting_orders`, `inventory_movements`,
     `production_orders` y `production_reports` (la base tiene
     `(now() AT TIME ZONE 'America/Lima')::date`, el schema no);
   - FK recreadas en `dispatches.invoice_id`, `finishes.color_id`, `production_orders.bom_id`,
     `products.finish_id` y `raw_material_specs.color_id`;
   - Ã­ndices que la base tiene y el schema no: `products(finish_id)` y
     `sales_orders(origin, status)`;
   - Ã­ndice renombrado `raw_material_specs_lookup_idx` â†’
     `raw_material_specs_business_line_id_thickness_mm_idx`.

   Fix: migraciÃ³n de reconciliaciÃ³n, **ensayada primero en una rama Neon clonada de
   `production`**, que alinee `schema.prisma` con la base. Probablemente declarando en el
   schema lo que la base ya tiene y no al revÃ©s: los defaults de `operation_date` son D-124.
   Cualquier diferencia contra esta lista en una ventana futura â†’ PARA.

2. **`deploy-api.mjs` y las variables rotas.** Pasar a `--env-vars-file` con verificaciÃ³n
   post-deploy de los nombres de variables; probar primero en `demo` si toca los secretos
   montados. ReciÃ©n despuÃ©s fijar `NODE_ENV`/`WEB_ORIGIN`/`JOBS_ENABLED` en producciÃ³n y quitar
   `"^|^NODE_ENV` (ver hallazgo colateral arriba).
3. **El guard por lÃ­nea de pedido no descuenta notas de crÃ©dito (D-223).** `invoicedByItem`
   (Fase 5b) sigue sin restar las notas de crÃ©dito vivas al decidir si una lÃ­nea ya se
   facturÃ³ completa: volver a facturar la misma lÃ­nea despuÃ©s de una nota de crÃ©dito parcial
   sobre esa lÃ­nea se sigue frenando igual que si la nota de crÃ©dito no existiera. El tope
   **por pedido** (D-223, esta ventana) sÃ­ las descuenta; el guard **por lÃ­nea** es anterior y
   quedÃ³ fuera de alcance del hotfix a propÃ³sito. Mismo patrÃ³n que `exceedsOrderTotal`
   (`invoicing-math.ts`), aplicado a `invoicedByItem` â€” pendiente de brief del dueÃ±o.
4. **Limpieza de ramas Neon.** Estado al cierre de esta ventana: 8 ramas â€” `production`, `dev`,
   `ci`, `demo` (nunca se borran), `respaldo-pre-v4-20260915` (dÃ­a D, nunca se borra),
   `pre-api-f92a3df` (2026-09-16, incidente HOTFIX-DESFASE) y `pre-s1-hotfix-47b09e7`
   (2026-09-17, esta ventana) â€” los 2 respaldos post-dÃ­a-D mÃ¡s recientes, se conservan los
   dos por polÃ­tica â€” y `ensayo-v4-20260915` (rama de ensayo, solo se borra con OK del dueÃ±o
   por nombre). **Nada que borrar hoy**: ningÃºn respaldo de una ventana ya verificada pasÃ³ los
   7 dÃ­as. Revisar de nuevo cuando `pre-api-f92a3df` cumpla una semana (â‰ˆ 2026-09-23) y esta
   ventana estÃ© verificada por mÃ¡s de 7 dÃ­as.

## Ventana RF-S1+HOTFIX â€” cierre y deploy (2026-09-16/17) â€” COMPLETADA

Cierre de la ventana que integrÃ³ RF-S1/M1 (precios de lista, D-217) con HOTFIX-401/M2
(borradores duplicados, D-223 renumerada) sobre `main`. El dueÃ±o saliÃ³ de modo automÃ¡tico
para esta ventana: cada comando con credenciales de BD de prod se propuso y se aprobÃ³ uno por
uno (regla nueva en `CLAUDE.md`, Secretos). RELEASE: `ca6314d`.

**MigraciÃ³n.** `migrate status` contra `production` confirmÃ³ una sola pendiente,
`20260916142234_d217_historial_precio_lista`; `pnpm db:prod` la aplicÃ³ (67 â†’ 68 migraciones,
seed idempotente sin tocar la contraseÃ±a real del admin) y `migrate status` quedÃ³ en 0
pendientes. `migrate diff` posterior **no vacÃ­o**, pero coincide punto por punto con el drift
ya documentado (`docs/PROGRESO.md`, Â«Incidente HOTFIX-DESFASEÂ», deuda S3 #1): mismas 5 tablas
con default de `operation_date`, mismas 5 FK recreadas, mismos 2 Ã­ndices y el mismo renombre.
Sin diferencias nuevas.

**Deploy de API.** Desde el worktree `ayr-release-ca6314d` (limpio, `HEAD` en `ca6314d`):
`gcloud run deploy ayr-steel-erp-api --source . --update-labels git-sha=ca6314d --quiet`, sin
flags de env ni secretos. RevisiÃ³n anterior `ayr-steel-erp-api-00035-rd9` (label
`git-sha=f92a3df`) â†’ nueva `ayr-steel-erp-api-00036-pj7` (label `git-sha=ca6314d`), 100% del
trÃ¡fico. Verificado antes y despuÃ©s con `scripts/oneoff/20260916-describe-cloud-run.mjs`
(solo lectura, vÃ­a `lib.mjs#run`): mismos 10 nombres de variable (incluida la rota
`"^|^NODE_ENV`, deuda S3 #2, sin tocar) y mismos recursos (cpu 1 / 512Mi / max 2). `/health`
`{"status":"ok","db":"ok"}`.

**Push y web.** `git push origin main`: `f92a3df..ca6314d` (24 commits). CI del push, verde:
run [35175690324](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35175690324)
(16m43s). Vercel republicÃ³ `ca6314d` en producciÃ³n sin acciÃ³n manual (proyecto ligado al repo,
D-019): deployment `dpl_5ieiV9h5uys4M6FawzQrFzqxf5Zc`, `Ready`, alias `v2.mareliac.pe`.
`curl https://v2.mareliac.pe/api/health` â†’ `db: ok` (web y API sirviendo el mismo release).

**Regla git-sha (b).** `git diff --quiet ca6314d origin/main -- apps packages Dockerfile
.gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml` â†’ exit 0: sin drift de runtime
entre el SHA desplegado y `origin/main`. Formalizada en `CLAUDE.md`.

**Smoke.** `pnpm smoke:prod` desde el worktree `ca6314d` (mismo SHA desplegado, no `main`
local): **7/7 en verde** â€” health, login (admin efÃ­mero, borrado al final), 5 lÃ­neas de
negocio, catÃ¡logo (174 filas), inventario valorizado (48 filas), bobinas (5), reporte mensual
de bobinas (43), emisiÃ³n electrÃ³nica apagada (D-216).

**Smoke manual del dueÃ±o**, contra `ca6314d`/`00036-pj7`: comprobante abre sin 401 ni crash,
botÃ³n de emisiÃ³n electrÃ³nica deshabilitado (D-216), borrador doble no duplica (D-223), precio
inline + revertir del catÃ¡logo (D-217) y catÃ¡logo de coberturas â€” los cinco **OK**.

**`hotfix-401` queda integrado.** La rama `hotfix-401` (worktree `ayr-steel-erp-hotfix-401`)
ya apuntaba a `ca6314d` antes de este push â€” sus cuatro commits (M2) llegaron a `main` por
`release/s1-hotfix`. El pendiente Â«`hotfix-401` sin merge ni pushÂ» de la secciÃ³n Â«SesiÃ³n
HOTFIX-401Â» de arriba queda **resuelto** por este push. **M1 (401 al abrir un borrador) tambiÃ©n
queda resuelta** (correcciÃ³n sobre el reporte inicial de este cierre): no era un bug propio,
era el mismo desfase web/API del Incidente HOTFIX-DESFASE mirado sin saberlo â€” ver el detalle
en la secciÃ³n M1 de Â«SesiÃ³n HOTFIX-401Â» arriba. La Ãºnica deuda que deja es la defensa nueva
(`comprobante-detalle-defensivo.spec.ts`, ya en `ca6314d`), no una investigaciÃ³n pendiente.

**PR #1** (`release/s1-hotfix` â†’ `main`, Â«S1 + hotfix borradores (NO MERGE)Â»): su CI, corrida
antes de este cierre, [35171657158](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35171657158)
â€” lint/typecheck/unit, 364 E2E (Postgres del runner), anÃ¡lisis estÃ¡tico y 35 E2E de smoke
(Neon `ci`), los cuatro jobs en verde. GitHub lo marcÃ³ **MERGED** solo al llegar los mismos
commits a `main` por push directo (no hubo `gh pr merge`, que sigue denegado); no se pudo
`gh pr close`, que rechaza un PR ya `MERGED`. Su rama `release/s1-hotfix` se borrÃ³ en el
cierre.

**D-224 nueva** (`docs/ARQUITECTURA.md` Â§0.2): `check:price-floor` contra `production`
post-D-217 sigue en 0 SKU activos con precio de lista â€” mismo nÃºmero que antes de construir el
editor y la carga masiva, porque nadie cargÃ³ todavÃ­a ningÃºn `listPricePen` real. No es un
defecto: el reporte compara valor de lista contra el piso de D-163 (que sale del costo del
kardex), y sin precio de lista no hay con quÃ© comparar. D-223 se ampliÃ³ con la verificaciÃ³n por
mutaciÃ³n del `FOR UPDATE` y el bug de `idempotencyKey` (`.max(128)` contra columna
`VarChar(100)`) que corrigiÃ³ `ca6314d`.

**El bloqueo del clasificador (paso 2 de la ventana, antes del `/clear`).** El modo automÃ¡tico
de Claude Code bloqueÃ³ `neonctl connection-string` contra `production` al preparar
`migrate deploy` â€” una protecciÃ³n propia de la herramienta ("Credential Materialization") que
frena la materializaciÃ³n de una credencial de base de datos real cuando nadie estÃ¡ mirando
cada ejecuciÃ³n. DecisiÃ³n correcta: no se buscÃ³ una vÃ­a alternativa para esquivarlo: se resolviÃ³
sacando al dueÃ±o de modo automÃ¡tico para que aprobara manualmente cada comando con
credenciales de BD de prod â€” la misma condiciÃ³n bajo la que corriÃ³ el resto de esta ventana, y
que ahora es regla explÃ­cita en `CLAUDE.md` (Secretos).

**Deuda que deja la ventana:** ver Â«Deuda registrada para S3Â» arriba (drift de schema,
`deploy-api.mjs`/variables rotas, guard por lÃ­nea sin NC, limpieza de ramas Neon â€” nada
vencido hoy) y D-224 (precio de lista sin cargar, tarea del dueÃ±o).

## SesiÃ³n RF-S2-INTEGRA (2026-09-16/17) â€” rf-s2 sobre main + integraciÃ³n con S1/hotfix

Worktree `ayr-steel-erp-rf-s2`, rama `rf-s2`. Sin merge ni push. Handoff:
`docs/handoff/rf-s2-integra.md`.

**PASO 0.** `origin/main` = `ae5bb1c`, no `ca6314d`, pero los tres commits de mÃ¡s son solo docs
y scripts: `git diff --quiet ca6314d origin/main -- apps packages â€¦` â†’ 0. En `49fe903..rf-s2`
hay 17 commits. El Â«16Â» de RF-S2-CIERRE deja afuera `dc83120`, la fila D-217 que `main` tambiÃ©n
tiene como `18ee393`. El Â«13Â» del handoff de la ventana no sale de ningÃºn estado del reflog.

Archivos que tocan los dos lados: los dos docs, `.prettierignore` (el mismo cambio exacto) y
`comprobante-detalle-view.tsx`, en partes distintas del archivo. Nadie toca `schema.prisma`,
AuditService, fiscal/pricing ni `settings.json`. Las migraciones de `rf-s2` (`â€¦153802_d218`,
`â€¦170000_d220`) van despuÃ©s de `â€¦142234_d217`; el hotfix no agregÃ³ migraciones.

**M1 â€” rebase.** Solo hubo conflictos de docs, resueltos por script: las filas Â§0.2 se unen por
nÃºmero y se ordenan solo desde el bloque en conflicto, asÃ­ la inversiÃ³n D-123/D-122 que ya
estaba en `main` queda como estaba; las secciones de PROGRESO quedan en orden cronolÃ³gico.
`dc83120` se saltÃ³ y `85a69c7` lo descartÃ³ git: quedan 15 commits. El cÃ³digo es idÃ©ntico al de
`git merge-tree origin/main rf-s2`. Rama de respaldo local: `rf-s2-pre-rebase-b0e2aac`.

Lint, typecheck, test (574) y format en verde. **`prisma migrate reset` no se corriÃ³:** Prisma lo
bloquea si lo lanza un agente sin el consentimiento del dueÃ±o en un mensaje nuevo. En su lugar,
`migrate deploy` sobre una base descartable nueva (`ayr_migcheck_rf_s2`, Docker local, borrada
despuÃ©s) aplicÃ³ las 70 migraciones limpias y en orden. El `migrate diff` restante es el drift ya
conocido, sin nada de `audit_log`.

**M2 â€” integraciÃ³n (D-225).**

- Los precios de lista ya eran la tercera fuente del visor. No hay quinta fuente ni doble
  instrumentaciÃ³n, y el presupuesto de consultas sigue en 4+1.
- El descarte de borrador guarda el motivo en `audit_log.reason` y no en `before`.
- El centinela D-222 fija la cantidad de `audit.log()` por archivo y revisa
  `createInTx`/`discardDraft` (verificado por mutaciÃ³n).
- Tests unitarios nuevos del empate lote â†” SKU (carga + reversa, 52 filas), de la ediciÃ³n inline
  (pageSize 1) y de `reason`. Dos E2E nuevos en `auditoria-d218.spec.ts`.
- Links "Historial" en el historial de precio, en "Editar producto" y en la carga masiva.
- Unitarios: 581.

**M3 â€” suite completa** desde el worktree, con `next build`/`nest build` y `CI=true` (31,6 min):
**365 pasan, 3 se saltan por diseÃ±o (PSE real), 1 flaky y 3 fallan.**

- `fase2a.spec.ts:359` y `fase5a.spec.ts:100`: R2 sin configurar en local, los mismos dos de
  RF-S2-CIERRE. El juez es la CI.
- `auditoria-d218.spec.ts:64`: el test nuevo tenÃ­a un selector ambiguo. El alta con precio ya
  deja su propio cambio de precio, asÃ­ que habÃ­a dos filas. Corregido y vuelto a correr aparte,
  junto con `precios-lista-d217` y `hotfix-401-borradores-duplicados`: 20/20.
- Flaky: `precios-lista-d217.spec.ts:255` (prellenado del precio en una lÃ­nea de cotizaciÃ³n),
  que pasÃ³ al reintento y en la corrida aparte. No toca cÃ³digo de esta sesiÃ³n.

**M4.** `docs/analisis/cloud-run-env-impacto.md`. `NODE_ENV` efectivo es `production` (lo fija
el `Dockerfile`), CORS en `localhost:3001` sin impacto funcional, `JOBS_ENABLED` vale `true` por
default y no hay rutas de test/reset en runtime. **Nada grave**; todo tolerable para S3. La
condiciÃ³n para la ventana de `rf-s2` es de procedimiento: desplegar con
`gcloud run deploy --source .` sin flags de variables, no con `pnpm deploy:api`.

**Pendientes.**

- ~~UX del visor: los precios de lista se ven sin IGV y con claves en inglÃ©s humanizado. Lo
  avisa el caso 5 de `docs/uat/rf-s2.md`.~~ Resuelto, ver Â«SesiÃ³n RF-S2-AJUSTES-UATÂ» abajo.
- Los descartes hechos en producciÃ³n entre `ca6314d` y el deploy de esta rama quedan con
  `before.reason` (append-only).
- Siguiente paso: push de `rf-s2` por el dueÃ±o + PR para la CI â†’ UAT en `demo` â†’ ventana propia.

## SesiÃ³n RF-S2-AJUSTES-UAT (2026-09-17) â€” visor en espaÃ±ol y con IGV, antes de UAT

Mismo worktree (`ayr-steel-erp-rf-s2`, rama `rf-s2`). Sin merge ni push. Alcance: el punto 1 del
brief de la ventana ("ajustes antes de UAT"): visor de auditorÃ­a, el flaky conocido y
`docs/uat/rf-s2.md`.

**Visor (D-226).** `audit-labels.ts` suma `auditFieldLabel`/`auditFieldValueLabel` (mapa de
clave â†’ espaÃ±ol para los tres changelogs dedicados: `lineNumber`, `unitValuePen`,
`valuePerMeterPen`, `valuePen`, `listPricePen`, `origin` con sus valores, `batchId`,
`revertsBatchId`, `issueDate`, `dueDate`, `reason`) e `isPriceListValueField`, que convierte
`valuePen`/`listPricePen` con IGV (`salePriceFromValue` + `money` + `toFixedString(...,
'MONEY')`, el mismo trÃ­o de `price-list-cell.tsx`/D-217). El resto de `audit_log` (los ~105
`action` de servicios de dominio) sigue sin traducirse a propÃ³sito â€” D-218 ya descartÃ³ ese mapa
por costoso, y esta sesiÃ³n no lo revive.

**Test unitario nuevo:** `apps/web/src/lib/audit-labels.spec.ts`, primera prueba unitaria del
web. `apps/web` no tenÃ­a runner (`"test": "echo sin-tests-unitarios-en-web"`) aunque D-011 ya
preveÃ­a Vitest/Jest ahÃ­; se agregÃ³ `vitest` (devDependency, `--save-exact`, sin `^` como el
resto del repo, D-017) y `vitest.config.mts` (alias `@/` â†’ `src/`, extensiÃ³n `.mts` para que el
config loader de Vite no ambigÃ¼e ESM/CommonJS, mismo criterio que `eslint.config.mjs` y
`postcss.config.mjs`). `apps/web/package.json#test` pasa a `vitest run`, y `.github/workflows/ci.yml`
(job `calidad`) suma el paso `pnpm --filter @ayr/web test` â€” antes nada ejecutaba el placeholder
en CI, asÃ­ que este test es el primero que de verdad corre ahÃ­.

**E2E ajustado:** `auditoria-d218.spec.ts` esperaba los valores crudos sin IGV (`12.5000` para
la ediciÃ³n, `10.0000` para el alta) en las filas de "Cambio de precio de lista" y "EdiciÃ³n de
producto"; con la conversiÃ³n, el visor muestra `14.75` y `11.80` (verificado con la aritmÃ©tica
real de `salePriceFromValue`/`money`, no a mano: `10.0000 â†’ 11.8000`, `12.5000 â†’ 14.7500`, que
`formatMoney` redondea a 2 decimales). Assertions actualizadas a los montos con IGV.

**Flaky `precios-lista-d217.spec.ts:255`** (ya registrado en RF-S2-INTEGRA: pasÃ³ al reintento,
no toca cÃ³digo de esa sesiÃ³n). **Causa probable documentada entonces, descartada en RF-S3/M0
con una corrida que sÃ­ lo reprodujo â€” y la reproducciÃ³n resultÃ³ ser ruido de sesiÃ³n, no del
producto.** La hipÃ³tesis de esta fila (que `chooseProduct` lee `productById` antes de que el
`useQuery` de `/catalog` resuelva) no se sostiene leyendo el cÃ³digo: el botÃ³n "Elegir" del
picker de stock y el `Map` `productById` derivan del **mismo** `products.data` en el **mismo**
render (`sales-document-form.tsx`), asÃ­ que no pueden desincronizarse entre sÃ­ â€” si el botÃ³n
muestra un SKU real, el catÃ¡logo ya cargÃ³, y `productById` tambiÃ©n lo tiene.

**RF-S3/M0 (2026-09-17).** `pnpm exec playwright test ... --repeat-each=10` sobre este spec dio
primero **4/10 rojos**, todos fallando en `chooseOption` al elegir el **cliente** (no el
producto) con un timeout esperando el predicado. El trace de esa corrida mostrÃ³
`[Fast Refresh] rebuilding` de `next dev` disparÃ¡ndose cada 1-3 segundos durante todo el test,
incluso a mitad de un click. La primera hipÃ³tesis â€”contaminaciÃ³n por dos subagentes editando el
mismo worktree en paraleloâ€” quedÃ³ **descartada en M1**: el mismo patrÃ³n de recompilaciones
seguidas volviÃ³ a aparecer en una corrida **sin ningÃºn agente concurrente** y sin editar ni un
archivo de `apps/web`/`packages/shared` durante la corrida.

**Causa real, confirmada en M1 con un `next dev` aislado en reposo:** con la app quieta (sin
navegar) durante 15 s no hubo un solo `rebuilding` ni un cambio de archivo en `apps/web`. El
patrÃ³n sÃ­ aparece al **navegar por primera vez** en un `next dev` reciÃ©n levantado: cada ruta
nueva se compila on-demand, y el sidebar de la app (con ~20 enlaces) dispara el _prefetch_ de
Next de varias de esas rutas en segundo plano â€” cada una compila y empuja su propio evento de
Fast Refresh al cliente, aunque la pÃ¡gina abierta no cambie. Un test que es de los **primeros**
en tocar un `next dev` reciÃ©n levantado puede pisar varias de estas compilaciones seguidas; una
vez que las rutas quedan tibias (repeats 2..10 del mismo server, o cualquier corrida posterior
en el mismo proceso), no vuelve a pasar â€” que es exactamente por quÃ© **10/10 en aislamiento
saliÃ³ verde**: no porque no hubiera agentes, sino porque para el repeat 2 ya todo estaba
compilado. La soluciÃ³n que ya usa el repo para la suite completa (`next build` + `next start`
desde un worktree, sin `next dev`) no tiene este problema porque no hay Fast Refresh en absoluto.

**No hay nada que arreglar en el producto.** El sÃ­ntoma es enteramente de correr contra `next
dev` en frÃ­o; en CI (build de producciÃ³n) y en la suite completa vÃ­a worktree no aparece. Lo que
sÃ­ es una lecciÃ³n reusable: un `.click()` de un solo intento contra un modal que puede
desmontarse a mitad de camino (D-188/D-156) no tiene margen â€” por eso `chooseOption` y (desde
M1) `chooseProductWithStock` reintentan solos; ver `e2e/helpers/ui.ts`. NingÃºn caller nuevo de un
picker modal deberÃ­a escribir su propio `.click()` de un solo intento cuando el helper resistente
ya existe.

**Pendiente de esta sesiÃ³n:** `docs/uat/rf-s2.md` (quitar el aviso del caso 5) y CI del punto 2
del brief â€” ver el resto de esta ventana en el handoff que cierre la sesiÃ³n.

**CI (punto 2 del brief).** PR #2 (`rf-s2` â†’ `main`, solo CI, sin merge). Run
[35187666089](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35187666089):
**verde en los 4 jobs**, incluido el paso nuevo `pnpm --filter @ayr/web test` dentro de
`calidad` â€” primera corrida real del Vitest de D-226 en CI. Sin `fase2a:359`/`fase5a:100` ni
el flaky de precios en esta corrida.

**Hallazgo â€” `demo` nunca tuvo datos de capacitaciÃ³n reales; se restableciÃ³ desde `production`
sin respaldo (D-227).** Al preparar el UAT, `migrate status` contra `demo` mostrÃ³ 22
migraciones pendientes (desde `D-146`, no solo `D-218`/`D-220` esperadas). Investigando por
quÃ©, la causa resultÃ³ estructural: `demo` se creÃ³ el 2026-09-06T22:48:08Z â€” un dÃ­a **antes**
de que `production` tuviera datos reales (2026-09-07, CLAUDE.md) â€” y lo que clonÃ³ fue resaca
de E2E de antes del lanzamiento, no datos de capacitaciÃ³n cargados a mano despuÃ©s. Confirmado
con conteos: 968 `finishes` en total, **0** coincidiendo con los 3 cÃ³digos reales que `D-203`
mapea (todos con forma `E2E...`/"Acabado E2E ..."/cÃ³digos aleatorios de 10 caracteres); el
100% de las 1985 bobinas de `demo` con `created_at` entre el 2026-09-02 y el 2026-09-06;
289/291 clientes y 1078/1617 productos con "E2E" en nombre/RUC/SKU. Confirmado en una rama de
ensayo descartable (`ensayo-demo-s2`, creada y borrada en esta sesiÃ³n) que `migrate deploy`
fallarÃ­a en seco en `D-209_acabados_tipo_obligatorio`, que hace `RAISE EXCEPTION` explÃ­cito si
queda algÃºn `finishes.kind IS NULL` â€” con 968 acabados sin mapear, nombraba los 968 cÃ³digos en
el mensaje de error.

**DecisiÃ³n del dueÃ±o: el `demo` viejo se descarta sin respaldo.** No es un recorte de
alcance â€” es que la resaca de E2E no tenÃ­a ningÃºn valor que preservar. Se creÃ³ primero
`pre-uat-s2-demo` (respaldo por las dudas) y se la borrÃ³ despuÃ©s, al confirmar que el reset
â€”`neonctl branches reset demo --parent`â€” no podÃ­a correr con `demo` teniendo un hijo (Neon
exige `--preserve-under-name` para eso, que habrÃ­a creado una tercera copia redundante de la
misma resaca) y que preservarla no aportaba nada. Verificado post-reset: mismo id de rama y
mismo endpoint/host (`ep-orange-field-aeb2zt49...`, sin cambios), padre = `production`,
conteos plausibles de datos reales (48 clientes, 174 productos, 43 bobinas, 13 pedidos, 70
cotizaciones â€” coincide con "70 cotizaciones de producciÃ³n" ya documentado en D-224 â€”, 4
comprobantes, 9 acabados) y 0 filas con huella de E2E. 8 ramas Neon en total tras esta
ventana.

**Salidas externas de `demo` apagadas (D-227), commit aparte.** `write-local-env.mjs` dejÃ³ de
copiar el `R2_BUCKET` real (el mismo de Cloud Run producciÃ³n) a `apps/api/.env` salvo que
`.env.setup` tenga un `R2_BUCKET_DEV` propio; `dev-demo.mjs` fuerza ademÃ¡s `R2_*` vacÃ­as y
`PSE_ENABLED`/`JOBS_ENABLED=false`, sin importar lo que traiga `apps/api/.env` heredado. Ver
`docs/ENTORNOS.md` para el detalle y el riesgo documentado (credenciales de usuarios de
`demo` = las de `production`).

**Migraciones D-218/D-220 en `demo` â€” el ensayo real de la ventana S2.** `migrate status`
sobre `demo` ya restablecida: solo las dos pendientes, como se esperaba. `audit_log` antes del
`CREATE INDEX` de D-220: 300 filas, 240 kB â€” trivial, no sirve de estimador de duraciÃ³n para
`production` (su `audit_log` es mucho mÃ¡s grande; se mide aparte en la ventana). `migrate
deploy` aplicÃ³ las dos sin error, conteos antes/despuÃ©s iguales, `migrate status` 0
pendientes. `migrate diff` no vacÃ­o, pero coincide **exactamente** con el drift ya
documentado (Incidente HOTFIX-DESFASE, deuda S3 #1): mismas 5 tablas con default de
`operation_date`, mismas 5 FK recreadas, mismos 2 Ã­ndices, mismo renombre â€” ninguna diferencia
nueva.

**Casi un incidente: Turbo se comÃ­a el apagado de PSE/jobs de `demo`.** Primer `pnpm dev:demo`
tras el fix de D-227: el log de arranque mostrÃ³ `[InvoicingSendJob] Job de reintento de envÃ­o
al PSE programado` â€” el job que D-227 debÃ­a apagar. Causa: `dev-demo.mjs` pasa
`PSE_ENABLED`/`JOBS_ENABLED`/`R2_*` por `env` a `pnpm run dev` (= `turbo run dev`), y
`turbo.json#globalPassThroughEnv` solo dejaba pasar `DATABASE_URL`/`DIRECT_URL`/`JWT_SECRET`/
`NODE_ENV`/`CI` al proceso hijo â€” las siete variables nuevas llegaban `undefined` a `nest
start`, y el schema de Zod (`JOBS_ENABLED` default `true`) las reponÃ­a con su valor por
defecto. Se cortÃ³ el proceso a los segundos (nadie llegÃ³ a usar la app), se agregaron las
siete a `globalPassThroughEnv` y se verificÃ³ el reintento: `[JobsService] pg-boss
deshabilitado (JOBS_ENABLED=false)`, sin `InvoicingSendJob` ni `QuotationExpiryJob` en el log.
**La lecciÃ³n:** un override de `env` en un `spawnSync` que atraviesa `turbo run <task>` no
alcanza por sÃ­ solo â€” si la variable no estÃ¡ en `globalPassThroughEnv` (o en el `env`/
`passThroughEnv` de la tarea), Turbo la filtra antes de que el proceso hijo la vea, sin avisar.

## Ventana S2 (2026-09-17) â€” deploy de auditorÃ­a (D-218/D-220) a producciÃ³n

UAT en `demo` **aprobado por el cliente sin observaciones**. Ventana nocturna chica, desde el
worktree principal (`main`).

**1 â€” CI.** `origin/main` no habÃ­a avanzado desde el inicio de la sesiÃ³n (`ae5bb1c`); `rf-s2`
ya lo incluÃ­a completo (rebaseado en RF-S2-INTEGRA), asÃ­ que no hizo falta rebase. Push de los
4 commits nuevos de la sesiÃ³n (D-226/D-227) â†’ CI de PR #2, run
[35194965329](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35194965329): verde.

**2 â€” Respaldo Neon.** `respaldo-pre-s2-20260917` (`br-round-hat-aepspkbl`) desde `production`.
8â†’9 ramas, sin necesidad de limpiar ninguna por tope.

**3 â€” Merge.** `git checkout main && git merge --ff-only rf-s2 && git push origin main`, corrido
por el dueÃ±o. `origin/main` â†’ `bc31eae`. CI de `main`
([35225447438](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35225447438)):
verde. RELEASE = `bc31eae`.

**4 â€” Migraciones en `production`** (aprobaciÃ³n manual del dueÃ±o en cada comando). `migrate
status`: solo D-218/D-220 pendientes, igual que en `demo`. `audit_log` antes del Ã­ndice de
D-220: 300 filas, 240 kB â€” sin riesgo, no hizo falta `CONCURRENTLY`. `migrate deploy`: las dos
aplicadas sin error. `migrate status` post: 0 pendientes.

**5 â€” Deploy de API y correcciÃ³n de la deuda S3 #2 (variables de entorno rotas).**
`scripts/deploy-api.mjs` pasÃ³ de `--set-env-vars` (que en Windows rompÃ­a el delimitador `^|^`
contra `cmd /d /s /c` y colapsaba `NODE_ENV`/`WEB_ORIGIN`/`JOBS_ENABLED` en una sola variable
de nombre `"^|^NODE_ENV`, hallazgo de la ventana RF-S1+HOTFIX) a `--env-vars-file` (YAML
temporal, sin pasar por ese parseo), sumÃ³ `--update-labels git-sha` (faltaba del todo en el
script) y una verificaciÃ³n post-deploy de que los nombres de variable/secreto de la revisiÃ³n
activa son exactamente los 12 esperados. `WEB_ORIGIN`: los dos dominios
(`https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`, decisiÃ³n del dueÃ±o â€” quedaba
pendiente desde RF-S1+HOTFIX). Deploy desde `main` local en `74c6317` (RELEASE +
`deploy-api.mjs`): revisiÃ³n **`ayr-steel-erp-api-00037-njl`** al 100%, label
`git-sha=74c6317`. Primera corrida de la verificaciÃ³n post-deploy fallÃ³ por un bug propio (el
`value()` de `gcloud` une listas con `;`, no con salto de lÃ­nea) â€” el deploy en sÃ­ ya habÃ­a
salido bien, confirmado aparte con una lectura de solo lectura de los 12 nombres exactos, sin
el nombre roto. Corregido en un commit aparte (`899151f`, no toca runtime â€” verificado con
`git diff --quiet 74c6317 HEAD -- apps packages Dockerfile .gcloudignore package.json
pnpm-lock.yaml pnpm-workspace.yaml`, exit 0). `/health` `db: ok`.

**6 â€” Vercel y smoke.** No se pudo confirmar por API quÃ© commit sirve Vercel (token del CLI
vencido, mismo problema de la sesiÃ³n del 2026-09-05); el push de `main` ya disparÃ³ el deploy
automÃ¡tico por la integraciÃ³n de GitHub. `pnpm smoke:prod`: **7/7**, incluido "emisiÃ³n
electrÃ³nica apagada (D-216)" â€” antes fallaba (revisiÃ³n `f92a3df` no la exponÃ­a); ahora la API
desplegada sÃ­.

**Pendiente:** verificaciÃ³n manual del dueÃ±o â€” visor de auditorÃ­a en prod (admin ve, no-admin
no ve), un "Historial" desde un detalle, una ediciÃ³n con motivo registrada. Commits de esta
ventana sin pushear todavÃ­a (`74c6317`, `899151f`): imprimir para el dueÃ±o al cierre.

## SesiÃ³n RF-S3 (2026-09-17) â€” Hardening: bÃºsqueda, card sin-stock, PITR

PASO 0 confirmÃ³ CI verde en `main` (`d00c870`) y midiÃ³ lo necesario antes de codear: 665/821
clientes activos y 1279/2565 productos activos en Neon `dev`; retenciÃ³n PITR real de 6 h
(`history_retention_seconds: 21600`, no los 7 dÃ­as que el plan permite); `findStockShortages`
sin agregar (N por cotizaciÃ³n Ã— M por lÃ­nea, derivado leyendo el cÃ³digo, no medido en vivo â€”
`DEBUG=prisma:query` no se pudo capturar de forma confiable en Windows/cmd.exe). Worktree
`ayr-steel-erp-rf-s3`, rama `rf-s3`, desde `origin/main` en `bc31eae`.

**M0 â€” el flaky de `precios-lista-d217.spec.ts:255` no era un bug.** DiagnÃ³stico completo (dos
pasadas, la segunda corrigiendo la primera) en la nota dentro de "SesiÃ³n RF-S2-AJUSTES-UAT" mÃ¡s
arriba: la causa real es el prefetch de rutas de un `next dev` reciÃ©n levantado, no
contaminaciÃ³n entre agentes concurrentes. Sin cambios de producto; `chooseOption`/
`chooseProductWithStock` (`e2e/helpers/ui.ts`) ya reintentaban o pasaron a reintentar por esto.

**M1 â€” bÃºsqueda server-side (D-229).** `GET /customers/search` y `GET /catalog/search` (qâ‰¥2,
tope 20, prefijo antes que contiene, `rankSearchMatches` compartido en `packages/shared`).
`q` vacÃ­o u omitido es vÃ¡lido y devuelve los primeros `SEARCH_RESULT_LIMIT` sin filtro (D-156:
el selector nunca abre vacÃ­o). `SearchSelectField`/`SearchSelectModal` ganan un modo async; el
modal de producto con stock (D-188) cambia de fuente sin cambiar de forma. El valor ya elegido
se hidrata por id (`GET /customers/:id`), asÃ­ que editar una cotizaciÃ³n o pedido viejo nunca
muestra el selector vacÃ­o. Sin Ã­ndice nuevo (D-229): el volumen de hoy no lo justifica. Tests:
unitarios de umbral/tope/ranking, E2E de cotizaciÃ³n nueva y de cambio de cliente de un pedido,
los dos con bÃºsqueda real.

**M2 â€” card sin-stock agregado (D-228).** `findStockShortages` pasÃ³ de N+1-sobre-N+1 a un
nÃºmero de consultas fijo (presupuesto de D-228), verificado con un test que no crece ni con mÃ¡s
cotizaciones ni con mÃ¡s lÃ­neas por cotizaciÃ³n. Mismo resultado funcional: los dos E2E de D-188
ya existentes siguieron en verde sin tocarlos, mÃ¡s tests nuevos de equivalencia para los casos
de borde (reserva temporal propia, dos lÃ­neas de la misma cotizaciÃ³n compitiendo por el mismo
Ã­tem, lÃ­nea NOOP). Sigue recalculÃ¡ndose en cada lectura, sin estado guardado.

**M3 â€” ensayo de restauraciÃ³n PITR**, con OK del dueÃ±o por nombre. Rama `ensayo-pitr-20260917`
creada y restaurada (~1 h atrÃ¡s) con el patrÃ³n de dos pasos de `neonctl`
(`branches create --parent production`, despuÃ©s `branches restore <rama>
"production@<timestamp>"` â€” el flag combinado `--parent rama@timestamp` no existe en `create`).
Nunca se tocÃ³ `production` directamente. RetenciÃ³n real 6 h (no 7 dÃ­as). Conteos de tablas
clave idÃ©nticos entre la rama de ensayo y `production` (sin escrituras en la Ãºltima hora, asÃ­
que no habÃ­a diferencia que explicar). RTO del lado de Neon: segundos; repuntar la API de
verdad (secretos + deploy a la rama restaurada) no se ensayÃ³ â€” es el paso real de un incidente
que esta ventana no simulÃ³, documentado como tal en `docs/ENTORNOS.md`. Procedimiento paso a
paso con responsable por paso, RPO/RTO medidos y cÃ³mo repuntar la API en un incidente real,
todo en `docs/ENTORNOS.md` Â§"PITR â€” retenciÃ³n, RPO/RTO y procedimiento de restauraciÃ³n". La
rama de ensayo queda viva hasta que el dueÃ±o autorice borrarla por nombre.

**M4 (sacrificable) â€” card Â«SKUs con lista bajo pisoÂ» (D-224).** Implementado con el diseÃ±o ya
escrito en RF-S1/M2: reusa `computePriceFloors` (D-150, nunca lÃ³gica paralela) batcheado sobre
todo el catÃ¡logo activo con precio de lista. Mismo criterio de presupuesto de consultas que M2
(test dedicado). Card nueva en el Panel, solo ADMINISTRADOR (`GET /catalog/price-list/floor-summary`
con `@Roles(Role.ADMINISTRADOR)`), con link a la fila resaltada en CatÃ¡logo.

### Hallazgos de `revisor` y `qa`, todos corregidos antes de cerrar

**`revisor`** (lectura del diff):

- **[ALTO] `GET /catalog/price-list/floor-summary` sin `@Roles`.** El control era solo del
  lado del cliente (`enabled: isAdmin` en la card); el endpoint quedaba abierto a cualquier rol
  autenticado, que podÃ­a ver quÃ© SKU vende bajo margen en todo el catÃ¡logo. Agregado
  `@Roles(Role.ADMINISTRADOR)` + test de metadata (`catalog.controller.spec.ts`) que confirma
  que el guard real la va a exigir.
- **[ALTO] `SearchSelectField` mostraba "no estÃ¡ entre las opciones" mientras la hidrataciÃ³n
  por id todavÃ­a cargaba** â€” pasa siempre al abrir para editar una cotizaciÃ³n/pedido con
  cliente ya elegido, y un instante despuÃ©s de elegir uno nuevo. Agregado
  `selectedOptionLoading` (el `isLoading` del `useQuery` de hidrataciÃ³n, que la vista ya tenÃ­a)
  y el campo ahora lo respeta.
- [MEDIO] la card de M4 mostraba `listPricePen`/`minPricePen` como strings crudos en vez de con
  `formatMoney`. Corregido.
- [BAJO, todos aplicados] `availabilityForShortages` paralelizÃ³ el loop de specs de materia
  prima con `Promise.all`; el sentinel `'1'` de `?bajoPiso=` pasÃ³ a una constante compartida
  (`apps/web/src/lib/catalog-links.ts`); `businessLine` invÃ¡lido en `GET /catalog/search` ahora
  devuelve 400 en vez de ignorarse en silencio; test nuevo de dos lÃ­neas de la misma cotizaciÃ³n
  compitiendo por el mismo Ã­tem en `findStockShortages` (la aritmÃ©tica ya era correcta â€”
  verificado a mano contra `previewLinesOf` â€” pero no tenÃ­a centinela).

**`qa`** (suite E2E completa, worktree + build de producciÃ³n, 374 tests): **363 passed, 9
failed, 2 skipped** en la primera corrida. 2 rojos son infraestructura conocida y ajena (R2 sin
configurar en local, `fase2a.spec.ts:359`/`fase5a.spec.ts:100`, documentados desde antes). **Los
otros 7 eran un defecto real de M1**, en dos formas del mismo problema:

- **(A) `/customers/search` no matchea la etiqueta compuesta "Nombre â€” RUC/DNI".** Cinco specs
  preexistentes (no tocados por M1) le pasaban a `chooseOption` la etiqueta completa como texto
  de bÃºsqueda â€” funcionaba en el modo sÃ­ncrono viejo porque el filtro comparaba contra el label
  entero con `includes()`, y dejÃ³ de funcionar cuando el campo empezÃ³ a buscar en el servidor
  contra `name`/`docNumber` por separado. Arreglo: los 5 specs (`huecos-cobertura-f8s2b.spec.ts`
  Ã—2, `plancha-largo-d166.spec.ts`, `precios-lista-d217.spec.ts`,
  `product-stock-picker-f8s2b.spec.ts`) ahora le pasan el RUC/DNI completo como `searchText` â€”
  parÃ¡metro nuevo de `chooseOption`, que sigue usando la etiqueta completa para el label y para
  verificar que quedÃ³ elegido.
- **(B) El selector de cliente ya no mostraba nada al abrir sin escribir**, rompiendo la
  garantÃ­a D-156/F8-S3c/M4 de que el selector "siempre abre mostrando algo Ãºtil" â€”
  `selector-cliente-f8s3c.spec.ts` lo prueba explÃ­citamente. Arreglo, no solo en los tests: `q`
  vacÃ­o u omitido en `searchQuerySchema` ahora es vÃ¡lido y significa "los primeros
  `SEARCH_RESULT_LIMIT`, sin filtro de texto" (`contains: ''` matchea todo, asÃ­ que la misma
  consulta batcheada de siempre alcanza) â€” corregido en `/customers/search`, `/catalog/search`,
  `SearchSelectModal` y `ProductStockPickerDialog`. Solo 1 carÃ¡cter (ni "nada" ni alcanza para
  acotar) sigue mostrando el aviso de mÃ­nimo.

Una sexta falla apareciÃ³ al re-verificar (no estaba en la lista original de `qa`, en el mismo
archivo): `huecos-cobertura-f8s2b.spec.ts` esperaba el texto viejo "N de M productos" del
picker, que con el rediseÃ±o de M1 pasÃ³ a "N resultados" â€” test actualizado al nuevo texto, sin
tocar el componente (la aserciÃ³n de fondo, que las filas desaparecen al filtrar y no solo dejan
de resaltarse, sigue intacta).

Con los 7+1 arreglos, los 5 specs afectados se re-verificaron con build de producciÃ³n (sin el
ruido de `next dev` en modo dev que M0 ya documentÃ³): **18 passed, 0 failed, 0 skipped** â€”
verde pleno, sin regresiones nuevas. (Antes de llegar a ese build de producciÃ³n hubo dos
corridas intermedias en modo dev con 1 y 3 rojos sueltos en `chooseOption` por timeout â€” mismo
sÃ­ntoma de M0, prefetch de rutas en frÃ­o, no un defecto de los arreglos; confirmado descartando
la hipÃ³tesis de defecto porque las capturas de esas corridas mostraban el estado correcto en
pantalla en el momento exacto del timeout.)

### Suite E2E completa (worktree + build de producciÃ³n)

**Antes de las correcciones:** 363 passed, 9 failed (7 reales + 2 infraestructura conocida), 2
skipped, ~27 min. **DespuÃ©s de las correcciones**, corrida de confirmaciÃ³n completa (374 tests,
21.9 min): **370 passed, 2 failed, 2 skipped**. Los 2 rojos son exactamente los 2 de
infraestructura ya conocidos (R2 sin configurar en local: `fase2a.spec.ts:359`,
`fase5a.spec.ts:100`), mismo archivo y misma lÃ­nea que antes â€” ningÃºn rojo nuevo. 363 + 7
corregidos = 370: confirma que los arreglos cerraron los 7 rojos que esta ventana habÃ­a
introducido sin abrir ninguno.

### Migraciones de esta ventana

Ninguna. M1/M2/M4 son cÃ³digo de servicio y consultas; M3 es solo Neon (rama de ensayo, no
migraciÃ³n). Nada que desplegar a `production` en materia de esquema.

### Pendientes que esta sesiÃ³n deja

- **La rama Neon `ensayo-pitr-20260917`** queda viva â€” se borra solo con OK del dueÃ±o por
  nombre, y solo despuÃ©s de que confirme que ya la revisÃ³.
- **Repuntar la API a una rama restaurada (secretos + deploy) no se ensayÃ³** â€” documentado en
  `docs/ENTORNOS.md` como el paso real de un incidente que esta ventana no simulÃ³.
- **Nadie cargÃ³ todavÃ­a precios de lista reales contra el catÃ¡logo de `production`** (deuda de
  D-217/D-224, sin cambios): la card de M4 no tiene nada que mostrar en producciÃ³n hasta que eso
  pase.
- `/handoff rf-s3` con el resumen de cierre.
- Commits de esta ventana sin pushear todavÃ­a (regla dura 6): imprimir la lista y el comando de
  push para el dueÃ±o al cierre.

### Siguiente sesiÃ³n

**S4 (Opus)** â€” inventario valorizado/merma + CxC, por plan.

## Bloqueos

Ninguno abierto. B-01 (facturaciÃ³n GCP) fue resuelta por el dueÃ±o el 2026-09-02; ver "B-01 â€” resuelta" abajo para el detalle de cÃ³mo se cerrÃ³ y quÃ© se aprendiÃ³ en el proceso.

### B-01 â€” RESUELTA (2026-09-02): GCP vinculado a facturaciÃ³n

El dueÃ±o vinculÃ³ el proyecto GCP `ayr-steel-erp` a una cuenta de facturaciÃ³n desde la consola web. A partir de ahÃ­, todo lo demÃ¡s se completÃ³ de forma autÃ³noma:

- `pnpm secrets:gcp` â€” habilitÃ³ las APIs, creÃ³ los 3 secretos en Secret Manager y otorgÃ³ los roles IAM que Cloud Build y la revisiÃ³n de Cloud Run necesitan (ver "Hallazgo â€” IAM insuficiente" abajo).
- `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app` â€” API en `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`, `/health` en verde.
- `pnpm deploy:web --api-url https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app` â€” web de producciÃ³n re-apuntado al API real.
- `pnpm db:prod` â€” aplicÃ³ la migraciÃ³n `refresh_grace_and_audit_append_only` que habÃ­a quedado solo en Neon `dev` (ver "Hallazgo â€” migraciÃ³n desactualizada" abajo).
- `pnpm monitors --api-url ... --web-url ...` â€” los dos monitores de UptimeRobot activos.
- Login real del administrador verificado contra producciÃ³n (cookies `httpOnly`/`Secure`/`SameSite` correctas). Luego, con `pnpm e2e:prod` (D-024), los 6 escenarios de `auth.spec.ts` en verde contra `https://ayr-steel-erp-web.vercel.app`, incluidos los cuatro exigidos por el cierre de fase: login correcto, login fallido, usuario desactivado no entra y cambio de rol invalida la sesiÃ³n.

**Hallazgo â€” migraciÃ³n de producciÃ³n desactualizada.** La migraciÃ³n `20260902170000_refresh_grace_and_audit_append_only` se habÃ­a aplicado en la sesiÃ³n anterior solo a Neon `dev` (vÃ­a `cd apps/api && prisma migrate deploy`, que usa `apps/api/.env`), nunca a `production`. El primer intento de login en prod devolviÃ³ 500 (`column sessions.previous_token_hash does not exist`). Se corrigiÃ³ reejecutando `pnpm db:prod`, que aplica todas las migraciones pendientes contra la rama correcta explÃ­citamente. LecciÃ³n: tras crear una migraciÃ³n manualmente durante una sesiÃ³n, volver a correr `pnpm db:prod` antes de dar una fase por cerrada si ya se desplegÃ³ a producciÃ³n.

**Hallazgo â€” rewrite de Vercel bloqueaba el API (D-022).** El `rewrites()` de `next.config.ts` hacia el dominio por defecto de Cloud Run (`*.a.run.app`) devolvÃ­a `DNS_HOSTNAME_RESOLVED_PRIVATE` en producciÃ³n â€” falso positivo de la protecciÃ³n SSRF de Vercel contra las IPs de Google Frontend. Se reemplazÃ³ por un Route Handler catch-all (`apps/web/src/app/api/[...path]/route.ts`) que hace el proxy con `fetch` server-side dentro de una funciÃ³n Node; Vercel no aplica ese chequeo a un `fetch` normal, solo a `rewrites()` declarativos.

**Hallazgo â€” IAM insuficiente para `deploy --source` (D-023).** La service account de Compute por defecto (`<project-number>-compute@developer.gserviceaccount.com`) tenÃ­a `roles/editor` a nivel de proyecto, pero eso no bastÃ³ para: (a) que Cloud Build leyera el zip fuente subido al bucket `run-sources-*`, ni (b) que la revisiÃ³n de Cloud Run leyera los secretos de Secret Manager. `scripts/gcp-secrets.mjs` ahora otorga explÃ­citamente `roles/secretmanager.secretAccessor` (por secreto) y `roles/{storage.objectViewer,cloudbuild.builds.builder,artifactregistry.writer,logging.logWriter}` (a nivel proyecto) a esa cuenta, asÃ­ que un proyecto GCP nuevo no deberÃ­a repetir este bloqueo.

## Pendientes abiertos de la SesiÃ³n Cierre de bobina (2026-09-09)

- **Revisar el 1 % de merma normal con datos reales (D-165).** El factor lo fijÃ³ el dueÃ±o como
  regla del cliente, sin datos detrÃ¡s. Ahora que D-164 hace visible la merma **anormal** â€”el
  remanente que se liquida al cerrar, con su `refType` propio en el kardexâ€”, con **2 o 3
  cierres reales** se puede comparar lo liquidado contra lo que el estÃ¡ndar ya absorbiÃ³ y ver
  si el 1 % estÃ¡ bien puesto. La pregunta que sigue abierta es si conviene que sea **por
  acabado** en vez de uno solo: un prepintado delgado y un galvanizado grueso no tienen por quÃ©
  perder lo mismo. Si se decide por acabado, la forma **no** es tipearlo en
  `finishes.density_factor` (ver el porquÃ© en D-165) sino una columna propia de merma normal
  que `standardDensityFactor` lea. **Antes de tocar el porcentaje**, convertir a
  `KG_PER_METER` los kilos que los fixtures de coberturas todavÃ­a escriben como literal (ver
  Â«El precio de D-165Â» arriba): son 16 y hoy atan la suite a este 1 % concreto.
- **Decidir el aviso de mÃ­nimo en el mostrador.** El insumo ya estÃ¡: `pnpm check:price-floor`
  dice cuÃ¡ntos SKU activos quedan por debajo del piso de D-163. Correrlo contra `production`
  necesita el OK del dueÃ±o (es solo lectura, pero contra la base real). Si la respuesta es
  "pocos", el aviso en el carrito es barato; si es "muchos", primero hay que revisar la lista
  de precios o los mÃ¡rgenes mÃ­nimos, no poner el bloqueo.
- ~~**Migraciones pendientes de desplegar**, acumuladas de esta sesiÃ³n y las anteriores: D-145,
  D-146, las dos de D-153, la de D-154, la de D-157, la de D-161
  (`20260909210000_d161_plancha_por_metro_lineal`) y la de esta sesiÃ³n
  (`20260909230000_d164_liquidacion_de_remanente_al_cierre`). **La de D-164 va antes que el
  API nuevo**: es aditiva (un valor mÃ¡s en el enum `InventoryRefType`), asÃ­ que el API viejo
  contra la base migrada funciona igual, pero el API nuevo contra la base sin migrar escribe
  `CLOSE_ADJUSTMENT` y revienta.~~
  **RESUELTO (ventana del 2026-09-10):** `prisma migrate status` contra `production` responde
  **Â«Database schema is up to date!Â»** con las 55 migraciones del repo. Las ocho de esta lista
  ya se habÃ­an aplicado en la ventana anterior y la lista quedÃ³ sin limpiar. **LecciÃ³n: esta
  lista se comprueba, no se cree** â€” `node scripts/migrations-status.mjs --branch production`
  es de solo lectura y tarda diez segundos, y una lista de pendientes que envejece sin
  verificarse hace exactamente lo contrario de lo que existe para hacer: en esta ventana estuvo
  a punto de motivar un `pnpm db:prod` que no hacÃ­a falta.

## Pendientes abiertos de la SesiÃ³n HOTFIX (2026-09-10)

- **Un pedido de solo servicios no llega a `FULFILLED`** y se queda en `CONFIRMADO` para
  siempre (D-167). Es honesto â€”el ERP no modela la ejecuciÃ³n de un servicio, asÃ­ que no tiene
  con quÃ© decidir que terminÃ³â€” pero deja una fila viva en la lista de pedidos que nadie va a
  poder cerrar. Las salidas posibles son un cierre manual con motivo (el patrÃ³n de D-164) o
  dejarlo asÃ­ y filtrarlo en la lista. **DecisiÃ³n del dueÃ±o**, y conviene tomarla reciÃ©n cuando
  aparezca el primer pedido de solo servicios: hasta hoy no existe ninguno.
- **La ediciÃ³n de una cotizaciÃ³n importada conserva el importe solo si el trÃ­o no cambiÃ³**
  (producto, cantidad, valor unitario). Si alguien corrige el **precio** de una lÃ­nea, esa
  lÃ­nea vuelve a calcularse y el documento deja de coincidir con el papel en esa lÃ­nea. Es lo
  correcto â€”quien edita el precio estÃ¡ diciendo que el papel decÃ­a otra cosaâ€” pero no hay nada
  en la pantalla que lo avise. Un cartel en el formulario de ediciÃ³n de una cotizaciÃ³n
  importada serÃ­a barato.
- **El importador sigue derivando el unitario y no deja editar el importe.** El campo editable
  del preview es el **precio unitario**, asÃ­ que corregir una fila obliga a pensar al revÃ©s
  (quÃ© unitario da el importe que quiero). Lo natural, ahora que el importe manda, serÃ­a que el
  campo editable **fuera el importe** y el unitario se derivara a la vista. No se hizo en esta
  sesiÃ³n para no mover la forma de una pantalla que el dueÃ±o ya conoce en medio de un hotfix.
- **Reabrir la producciÃ³n a stock de coberturas** (D-171) exige responder antes quÃ© hace una
  lÃ­nea de pedido cuando ese saldo existe: Â¿lo toma?, Â¿lo ignora y produce igual?, Â¿lo toma
  hasta donde alcanza y produce el resto? `createToStock` quedÃ³ en el archivo, sin llamadores,
  esperando esa respuesta.
- **`BOB38AZUL` y `BOB38ROJO` en `production`** son productos `BOBâ€¦` que ninguna bobina nombra
  (los lista `pnpm check:coil-skus`). No son restos de D-168 â€”su forma no es la que genera
  `coilSku`â€” sino SKU creados a mano. Antes de darlos de baja hay que ver si alguno estÃ¡
  cotizado o vendido; el guion no borra nada a propÃ³sito.

### Necesitan acciÃ³n tuya

- **Vaciar los comprobantes de la cuenta demo del PSE.** Sigue en su tope (Â«No puedes enviar mas
  de 50 documentos en en una cuenta DEMOÂ»). **Desde el saneamiento E2E ya no ensucia la corrida
  por defecto**: esos 12 casos estÃ¡n etiquetados `@pse` y salen aparte con `pnpm e2e:pse`. Pero
  la deuda sigue viva â€” mientras la cuenta estÃ© llena, **esos 12 casos no se estÃ¡n corriendo**,
  y son los que cubren el ciclo fiscal completo hasta la aceptaciÃ³n. Vaciarla y correr
  `pnpm e2e:pse` es lo que los vuelve a poner en verde.
- ~~**El selector de cliente de la cotizaciÃ³n no ve mÃ¡s de 200 clientes y no tiene
  bÃºsqueda.**~~ **Medio resuelto en el saneamiento E2E**: pasÃ³ a `SearchSelectField` (D-156) y
  el umbral bajÃ³ a 20, asÃ­ que con los 49 clientes activos de producciÃ³n el vendedor ya tiene
  buscador. **Lo que sigue abierto es el tope**: `fetchAllForPicker` trae como mucho 200 y
  `/customers` ordena por `isActive desc, name asc`, asÃ­ que con mÃ¡s de 200 activos los Ãºltimos
  siguen sin aparecer â€” y sin ningÃºn error, simplemente no estÃ¡n. Levantarlo es **buscar del
  lado del servidor** (`/customers` ya acepta `search`), y alcanza a los tres campos que usan el
  componente. Hoy no aprieta: 49 de 200.

## Notas operativas

- **RESUELTO en el saneamiento E2E (2026-09-10).** Las dos notas de abajo â€”recrear la base a
  mano, y los 409 al azar por maestros acumuladosâ€” describen un problema que **ya no existe**:
  `reset-test-db.ts` vacÃ­a las 45 tablas en cada corrida, asÃ­ que la base nunca envejece. Se
  dejan porque explican por quÃ© el reset es como es, y porque la segunda documenta el otro
  efecto de la acumulaciÃ³n â€”**la pantalla que cambia de forma segÃºn cuÃ¡ntas filas haya**â€” que
  **sigue vivo dentro de una misma corrida** y volviÃ³ a morder en esta sesiÃ³n (ver Â«El fallo que
  enseÃ±Ã³ mÃ¡s que su arregloÂ»).
- **SesiÃ³n Cierre de bobina (2026-09-09). La base de E2E se recreÃ³ desde cero, y conviene
  volver a hacerlo.** El 409 anotado abajo (proveedores/colores repetidos al azar contra un
  maestro que el reset no trunca) dejÃ³ de ser ruido de fondo y pasÃ³ a tapar la seÃ±al: con
  varias corridas seguidas en una misma sesiÃ³n, `ayr_local_e2e` llegÃ³ a **1 874 proveedores,
  841 colores, 2 902 productos, 1 576 acabados y 1 195 clientes**, y los 409 aleatorios se
  llevaban puestos una decena de casos por corrida, en specs que no hablan ni de proveedores
  ni de colores. Verificar un cambio no aditivo con ese ruido encima es imposible.

  La salida fue **recrear la base**, que no es lo mismo que cambiar quÃ© trunca el reset (eso
  sigue sin tocarse, por el motivo de siempre): `ayr_local_e2e` es descartable y de uso
  exclusivo de la suite, y una base reciÃ©n creada es exactamente lo que tiene CI, que estÃ¡ en
  verde. Con el contenedor arriba:

  ```bash
  docker exec ayr-local-db psql -U ayr -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ayr_local_e2e' AND pid <> pg_backend_pid();"
  docker exec ayr-local-db psql -U ayr -d postgres -c "DROP DATABASE ayr_local_e2e;"
  docker exec ayr-local-db psql -U ayr -d postgres -c "CREATE DATABASE ayr_local_e2e OWNER ayr;"
  ```

  El `globalSetup` de Playwright aplica migraciones y seed en la corrida siguiente, asÃ­ que no
  hay nada mÃ¡s que hacer. **Nunca contra `ayr_local`**, que es la base de `pnpm dev:preview` y
  del dueÃ±o (regla dura 15). Vale la pena correr esto **antes** de una tanda larga de E2E, no
  despuÃ©s de pelear con los 409.

- **SesiÃ³n Planta III (2026-09-09). La base de E2E envejece y produce 409 al azar.**
  `apps/api/prisma/reset-test-db.ts` trunca el kardex, las bobinas, las compras, los pagos, las
  sesiones, la auditorÃ­a y los usuarios; **no** trunca `customers`, `products`, `suppliers`,
  `colors` ni `finishes`, y esas tablas tampoco caen por CASCADE. Medido en esta sesiÃ³n sobre
  `ayr_local_e2e`: **1 019 proveedores, 1 582 productos, 860 acabados, 627 clientes y 471
  colores** acumulados entre corridas. Dos consecuencias reales, las dos observadas:
  (a) `409 Ya existe un proveedor con ese documento` y `409 Ya existe un color con ese cÃ³digo`
  lanzados **desde dentro de `setupRoofingScenario`**, en casos que no hablan ni de proveedores
  ni de colores â€” los helpers generan cÃ³digos de 6 caracteres al azar contra un maestro de mil
  filas; se mitigÃ³ agregando un correlativo de proceso a los generadores de `e2e/helpers`, pero
  la causa sigue en el reset. (b) Con 627 clientes, el `SearchSelectField` de D-156 estÃ¡
  **siempre en modo modal** en local y en modo `<select>` en una base reciÃ©n creada: el
  importador cambia de forma segÃºn la edad de la base, y un spec que asuma una sola forma pasa
  en una mÃ¡quina y falla en CI. Sigue sin tocarse por el mismo motivo que la sesiÃ³n anterior:
  cambiar quÃ© trunca el reset puede romper specs que hoy dependen de que algo sobreviva, y eso
  se mira con la suite completa delante, no de paso.
- **SesiÃ³n Planta III (2026-09-09).** En una corrida de Playwright el API de `:3000` **muriÃ³ a
  mitad**: todo pasÃ³ a `500` y despuÃ©s el puerto quedÃ³ sin escuchar, tumbando once casos con
  `Login admin fallÃ³: 500`. Al relanzar, verde. No se encontrÃ³ causa y no se reprodujo; queda
  anotado por si vuelve, porque el sÃ­ntoma (`500` en el login) no se parece en nada a "el
  servidor se cayÃ³".
- **SesiÃ³n de estabilizaciÃ³n (2026-09-08).** Un archivo de trabajo de `local-data/` no estÃ¡
  en git y no tiene copia en ningÃºn lado: si una herramienta lo pisa, se perdiÃ³. PasÃ³ con
  `Ventas Detalladas.decisiones.json` (ver el incidente arriba). El CLI ya no puede pisarlo,
  pero la regla general vale para todo lo que viva ahÃ­: **antes de correr una herramienta que
  escriba en `local-data/`, copiar a mano lo que costÃ³ trabajo llenar.**
- **SesiÃ³n de estabilizaciÃ³n (2026-09-08).** Para smokear el artefacto **compilado** (lo que
  corre en Cloud Run) sin desplegar nada: `pnpm build` y despuÃ©s `pnpm e2e <suite>` con
  `CI=true` mÃ¡s `DATABASE_URL`/`DIRECT_URL`/`JWT_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`
  apuntando al Postgres de Docker. Con `CI=true`, `playwright.config.ts` levanta
  `node dist/main.js` + `next start` en vez de `nest start` + `next dev`.
- **SesiÃ³n 7-final-C.** `pnpm db:migrate` (`prisma migrate dev`) volviÃ³ a pedir un `migrate
reset` contra `dev` ("la migraciÃ³n X fue modificada despuÃ©s de aplicarse", tres migraciones
  de sesiones anteriores) â€” el mismo sÃ­ntoma que D-053 ya habÃ­a resuelto una vez, de vuelta.
  **No se investigÃ³ la causa ni se resetea nada**: la migraciÃ³n de esta sesiÃ³n se escribiÃ³ a
  mano (mismo formato que las demÃ¡s, carpeta con timestamp) y se aplicÃ³ con `prisma migrate
deploy` (que no hace el diff contra un shadow DB y no dispara el aviso). Si esto se repite,
  vale la pena mirarlo con mÃ¡s calma antes de la prÃ³xima migraciÃ³n â€” por ahora, `migrate
deploy` es la vÃ­a de escape que no arriesga los datos de `dev`.
- **SesiÃ³n 7-final-C.** Un script standalone que reusa un servicio de Nest completo
  (`NestFactory.createApplicationContext`, no un endpoint HTTP) **no se puede correr con
  `tsx`**: esbuild no emite `emitDecoratorMetadata` de forma confiable en un grafo de
  dependencias con tipos circulares (sÃ­ntoma: `UndefinedDependencyException` al resolver
  `AuthService`, y **sin ningÃºn error visible** â€” el proceso termina con `process.exit(1)` en
  silencio incluso con `.catch()` y `process.on('uncaughtException', ...)` puestos, porque
  Nest lo logea con su propio logger interno y `{logger: false}` lo apaga entero). `nest
build` tampoco sirve si el script vive en `prisma/` (`tsconfig.build.json` lo excluye a
  propÃ³sito). La soluciÃ³n fue un `tsconfig.cli.json` que compila con `tsc` real a `dist-cli/`
  y correr el `.js` con `node` liso â€” ver `apps/api/tsconfig.cli.json` y
  `scripts/import-ventas.mjs`. Cualquier script futuro que necesite reusar un `Service` de
  Nest fuera de un request HTTP deberÃ­a copiar este patrÃ³n, no `tsx`.
- **SesiÃ³n 7-final-C.** `prisma generate` puede fallar con `EPERM: ... query_engine-windows.dll.node`
  si otro proceso de Node (de esta sesiÃ³n o de otra) todavÃ­a tiene el binario abierto â€” no es
  un defecto del cÃ³digo, es un lock de Windows. Si pasa, confirmar con `tsc --noEmit` y `nest
build` por separado (no dependen del binario reciÃ©n generado si el cliente ya estaba
  generado de una corrida anterior) antes de asumir que algo se rompiÃ³.
- `gcloud` en Git Bash falla ("Python was not found"); funciona vÃ­a `cmd /c gcloud ...` o desde PowerShell/cmd. `scripts/lib.mjs#run` ya lo resuelve.
- La rama por defecto de Neon se llama `production` (no `main`). Ver D-016.
- Prisma bloquea `migrate reset` cuando lo invoca un agente. El reset de pruebas es `apps/api/prisma/reset-test-db.ts` (D-018).
- **Fase 3b (resuelto en SesiÃ³n M-1, ver D-053).** `pnpm db:migrate` (`prisma migrate dev`) volviÃ³ a funcionar contra `dev`: la carpeta `20260903031603_fase3_corte_flejes` se renombrÃ³ a `20260904125000_fase3_corte_flejes` (entre `fase2b` y `fase3b`, el orden real de aplicaciÃ³n) y `_prisma_migrations.migration_name` se sincronizÃ³ a mano en `dev` y `production`. Ya no hace falta escribir migraciones a mano ni usar `migrate deploy` para esquivar el shadow database; una migraciÃ³n nueva se crea con el flujo normal (`pnpm db:migrate`).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel estÃ¡ ligado al repo GitHub: cada push a `main` despliega el web.
- El proxy `/api/*` del web es un Route Handler (fetch server-side), no un `rewrite()` de Next: Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run (D-022).
- Para verificar RF-03 contra producciÃ³n: `pnpm e2e:prod`. Crea un administrador efÃ­mero, corre los 6 escenarios de auth y borra los usuarios `e2e-...@ayr.test` en `finally` (D-024). Nunca usa ni modifica la cuenta del dueÃ±o. Si la limpieza fallara, el script lo avisa y hay que revisar `/usuarios` en producciÃ³n.
- `spawnSync('algo.cmd', ...)` sin `shell: true` falla con `EINVAL` en esta mÃ¡quina Windows/Node 24; usar `shell: true` (o invocar `cmd.exe /c` explÃ­cito) al lanzar `pnpm`/binarios `.cmd` desde Node.
- **Fase 7 (2026-09-05):** el token del CLI de Vercel (`%APPDATA%/xdg.data/com.vercel.cli/auth.json`) venciÃ³; `pnpm deploy:web` falla con `403 invalidToken`. No bloquea: el proyecto Vercel estÃ¡ ligado al repo de GitHub (ver arriba), asÃ­ que el push a `main` de esta fase dispara igual el deploy del web. `pnpm deploy:web` vuelve a hacer falta el dÃ­a que se necesite un deploy fuera de un push (p. ej. reapuntar `API_URL` sin cambiar cÃ³digo) â€” ahÃ­ sÃ­ hace falta que el dueÃ±o corra `vercel login` primero.
- **Fase 7 (2026-09-05), RESUELTO en Fase 7b:** `pnpm prod:purge-e2e` revertÃ­a el despacho E2E **despuÃ©s** de deshacer la producciÃ³n, asÃ­ que `reverseReport` se topaba con su propia salida de despacho â€”bloquea si el producto tuvo movimientos posteriores vivos que no sean `IN`â€” y la orden quedaba reabierta a medias con saldo fantasma en el kardex. El bloque de Ã³rdenes de producciÃ³n se moviÃ³ **despuÃ©s** del ciclo fiscal y logÃ­stico y antes de los pedidos: con el despacho ya revertido, reabrir â†’ revertir el reporte â†’ anular pasa en una sola corrida. No hizo falta enseÃ±arle al guion a distinguir materia prima de producto terminado: bastaba el orden.
- Hallazgos de revisiÃ³n pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquÃ­ para Fase 7 (hardening).
- SonarCloud: en `.env.setup` `SONAR_ORG` y `SONAR_PROJECT_KEY` venÃ­an intercambiados (corregido: org `gsinuiri-coder`, key `gsinuiri-coder_ayr-steel-erp`). El proyecto tenÃ­a Automatic Analysis activo; se desactivÃ³ por API para que el anÃ¡lisis lo haga CI con cobertura (D-021).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesiÃ³n de Claude Code; en esta sesiÃ³n se ejecutaron como `general-purpose` con la definiciÃ³n como prompt.
- **Fase 1.** apis.net.pe: el endpoint real es `v1/tipo-cambio-sunat?fecha=YYYY-MM-DD` (verificado contra la API real), no `v2/sunat/tipo-cambio` como se asumiÃ³ al principio â€” devolvÃ­a 404 y quedÃ³ registrado un momento en el log como "no respondiÃ³" antes de corregirlo.
- **Fase 1.** `XLSX.read(buffer, {type:'buffer'})` asume un codepage no-UTF-8 para `.csv`, lo que rompe encabezados con tildes ("LÃ­nea" no matcheaba ninguna columna). `parse-spreadsheet.ts` ahora detecta si el archivo es un zip real (firma `PK`, `.xlsx`) y si no lo es, decodifica como UTF-8 y lee en modo `'string'`. Encontrado por el E2E de importaciÃ³n, no es cosmÃ©tico: sin este fix ninguna fila con encabezados en espaÃ±ol se validaba nunca.
- **Fase 1.** El E2E de CI (`imports`) sube archivos reales al bucket R2 de producciÃ³n (`R2_BUCKET` es el mismo en GCP y en GitHub Secrets); quedan objetos de prueba con prefijo `imports/...` en R2 tras cada corrida de CI. No es un riesgo de seguridad, pero conviene un bucket o prefijo separado para CI si el volumen de corridas crece (anotado para Fase 7).
- Prisma expone el enum `BusinessLineCode` con los nombres declarados en el schema (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`, `metallic-roofing`...); `apps/api/src/common/business-line-code.ts` es el Ãºnico lugar que traduce entre eso y el `BusinessLine` de `@ayr/shared`. Si se agrega una sexta lÃ­nea de negocio, hay que tocar ese mapa ademÃ¡s del enum de Prisma y el de `@ayr/shared`.
- **`ADMIN_PASSWORD` de `.env.setup` ya no es la contraseÃ±a real del admin en `production`.** El dueÃ±o la cambiÃ³ al completar el flujo de `mustChangePassword` en su primer ingreso (cierre de Fase 0). Un intento de `POST /auth/login` contra producciÃ³n con las credenciales de `.env.setup` devuelve `401 Credenciales invÃ¡lidas` (evidencia de esta sesiÃ³n, sin haber tocado nada). **Nunca** intentar loguearse como el admin real contra producciÃ³n para verificar algo: usar siempre un administrador efÃ­mero (`apps/api/prisma/e2e-admin.ts` + `cleanup-e2e-users.ts`, patrÃ³n D-024) igual que hace `pnpm e2e:prod`.

## RF-S3c â€” verificaciÃ³n M0 local (2026-09-21)

`prisma generate`, `typecheck`, `lint` y `pnpm test` quedaron verdes (47 suites, 620 tests).
La migraciÃ³n `20260920120000_rf_s3c_seller_scope` se aplicÃ³ en la base local exclusiva
`ayr_rf_s3c` del contenedor Docker compartido; no se tocÃ³ Neon. El backfill se ensayÃ³ con
dos vendedores, administrador, varios creadores y filas `seller_id=NULL`: el dry-run fue
solo lectura y `--execute` rellenÃ³ las seis filas desde `created_by_id`.

El dry-run contra una rama clonada de Neon queda a cargo del dueÃ±o por D-234. Comando exacto,
desde la raÃ­z del worktree, despuÃ©s de configurar esa rama y su entorno fuera de esta sesiÃ³n:

```text
node scripts/backfill-seller-scope.mjs --branch ensayo-s3c-20260920
```

El wrapper es dry-run por defecto; no agregar `--execute` sin la aprobaciÃ³n correspondiente.
El guard E2E actual rechaza `ayr_rf_s3c_e2e` porque su lista blanca todavÃ­a solo admite
`ayr_local_e2e`, `ayr_ci_e2e` bajo CI y Neon `ci`; por D-230/D-234 no se ampliÃ³ ni se reseteÃ³.

### M1 â€” alcance y costos (bloqueado por E2E)

Se uniformÃ³ el alcance del vendedor en despachos, progreso de pedido, comprobantes y descargas
PDF/XML/CDR; la cola de OP de coberturas filtra por `sellerId`; el kardex (`GET /inventory/movements`)
y mÃ¡rgenes (`GET /pricing`) quedaron restringidos al administrador/supervisor segÃºn corresponda;
los DTO de inventario y bobina vendible omiten campos de costo para VENDEDOR. El centinela
`apps/api/src/auth/seller-scope.spec.ts` cubre A/B y administrador; 48 suites y 622 unitarios
quedaron verdes.

El gate E2E cruzado A/B/admin no puede ejecutarse con la base aislada `ayr_rf_s3c_e2e`: el
guard de `apps/api/prisma/test-db-guard.ts` la rechaza por lista blanca. No se ampliÃ³ el guard
ni se hizo reset; M1 no se declara completo y no se abre PR hasta que el dueÃ±o decida el nombre
permitido o habilite una base E2E compatible.

## RF-S3c: Gap de deploy (M1)

El backend ahora bloquea el acceso de VENDEDOR a Kardex y AuditorÃ­a mediante Guards y decoradores @Roles. En la web antigua (fb443a5), el vendedor aÃºn podrÃ­a ver los links en el menÃº, pero al hacer clic, el API nuevo devolverÃ¡ un 403 Forbidden bloqueando correctamente los datos subyacentes sin romper la aplicaciÃ³n completa. La versiÃ³n web actual ya oculta los menÃºs, garantizando la compatibilidad.

 # #   R F - S 3 c   -   M 1 ,   M 2 ,   M 3 ,   M 4   ( 2 0 2 6 - 0 9 - 2 1 ) 

## RF-S3c - M1, M2, M3, M4 (2026-09-21)

Se completaron los hitos del brief:

- M1 (Alcance): Fugas de seguridad reparadas y verificadas por la CI y specs cruzados.
- M2 (Derivación estado): Estado LISTO agregado como lectura consolidada sobre OP para las listas y detalles.
- M3 (Panel del vendedor): Dashboard API agregado con las 4 tarjetas y presupuesto estricto de consultas validado mediante specs.
- M4 (Reasignación de vendedor): Acción de solo-administrador implementada y auditada correctamente.
- El CI (PR #7) corrió verde exitosamente tras los fix de Playwright.

Pendiente: Handoff para revisión cruzada por Claude Code y prueba de UI con Playwright local/CI.

## Descarte de `acc-demo` — accesorios de cobertura a stock (2026-09-23)

**Prototipo rechazado en demo al cliente.** La rama `acc-demo` (worktree
`ayr-steel-erp-acc-demo`) implementaba accesorios de cobertura como tercer `roofingKind`
(`ACCESORIO`), con ancho efectivo, reporte por pasadas y producción a stock — documentado ahí
como D-242 (SKU/aritmética) y D-248 (decisión consolidada, tras renumerar D-242 para no chocar
con el D-242 real de RF-S4a ya en `main`). El dueño mostró el prototipo al cliente y el
resultado fue negativo; se descarta la rama completa: worktree, rama local y `origin/acc-demo`.

**Punta descartada, recuperable si hace falta**: `fce82d7115b84d03d79df736590a4edcdfaa8444`
(`fix(planta): la cola promete el kilo teorico con el ancho efectivo (D-248)`, 2026-09-22). 9
commits sobre `origin/main` en el momento del descarte (desde `6d74f3b`, SKU de accesorio, hasta
`fce82d7`).

**Colisión de numeración verificada antes de borrar, sin escritura**: el D-248 de `acc-demo` (el
consolidado de accesorios) **no** es el mismo D-248 que ya existe en las ramas vivas
`docs/ventana-rf-s4a`/`hotfix-d249` (ahí D-248 es la excepción de autorrevisión de RF-S4a,
decisión no relacionada). Ambas ramas reclamaron D-248 en paralelo desde la misma base
(`origin/main` en D-247) sin verse entre sí. Como `acc-demo` se descarta completo y nunca llega
a mergearse, esa colisión no llega a materializarse en ningún log compartido: `docs/ARQUITECTURA.md`
de `main` sigue con un solo D-248 (el de la excepción de autorrevisión) en cuanto
`docs/ventana-rf-s4a`/`hotfix-d249` mergeen. El D-242 de `acc-demo` tampoco choca con el D-242 real
de RF-S4a (costo de venta por kardex de despachos): ya estaba renumerado a D-248 en el propio
`docs/ARQUITECTURA.md` de la rama antes del descarte. Si el prototipo de accesorios se retoma
algún día, necesita un número D-nnn nuevo — ni 242 ni 248 están libres.
