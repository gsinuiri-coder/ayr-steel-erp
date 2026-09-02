# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                         | Estado                  | Cierre                                                   |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 0 — Bootstrap                                | ✅ Cerrada (2026-09-02) | Login E2E verde en prod, CI verde                        |
| 1 — Maestros, catálogo, precios, importación | ✅ Cerrada (2026-09-02) | E2E de Fase 1 verdes en local + CI, deploy en producción |
| 2 — Compras + bobinas + kardex               | ⚪ Pendiente            | —                                                        |
| 3 — Corte tercerizado + flejes               | ⚪ Pendiente            | —                                                        |
| 4 — Producción + `/planta`                   | ⚪ Pendiente            | —                                                        |
| 5 — Cotizaciones y ventas                    | ⚪ Pendiente            | —                                                        |
| 6 — Facturación Nubefact                     | ⚪ Pendiente            | —                                                        |
| 7 — Auditoría, reportes, UAT                 | ⚪ Pendiente            | —                                                        |

## Fase 0 — detalle

| #   | Entregable                                                   | Estado                                                                                                                       |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | CLAUDE.md                                                    | ✅                                                                                                                           |
| 2   | docs/PROGRESO.md, docs/DECISIONES.md, docs/handoff/          | ✅                                                                                                                           |
| 3   | Monorepo pnpm + Turborepo (api, web, shared, eslint-config)  | ✅ `pnpm build/lint/typecheck/test` en verde                                                                                 |
| 4   | Prisma v0 (User, Session, AuditLog) + migración inicial      | ✅ `20260902160054_init` + `20260902170000_refresh_grace_and_audit_append_only`                                              |
| 5   | Neon ramas dev/ci + migración en dev + seed admin            | ✅ ramas `dev` y `ci` creadas; migraciones y seed aplicados en `dev`, `ci` y `production`                                    |
| 6   | Auth D-010 + CRUD usuarios + GET /health                     | ✅ revisado por `revisor` y `auditor-seguridad`; hallazgos corregidos                                                        |
| 7   | Web: login, cambio de contraseña, sidebar por rol, /usuarios | ✅                                                                                                                           |
| 8   | Tests unit (Jest) + E2E Playwright                           | ✅ 23 unit; 7 E2E en local (Neon `dev`); 6 E2E de auth verdes contra producción, incluidos los 4 escenarios exigidos (D-024) |
| 9   | CI GitHub Actions + SonarCloud/Semgrep                       | ✅ corrida 33660853547 verde: calidad, SonarCloud, E2E (Neon `ci`)                                                           |
| 10  | Deploy Cloud Run + Vercel, login verificado en prod          | ✅ API en Cloud Run, web en Vercel, login real de administrador verificado en producción                                     |
| 11  | UptimeRobot (API /health, Web /)                             | ✅ ambos monitores activos (API v3 de UptimeRobot)                                                                           |
| 12  | Subagentes revisor, auditor-seguridad, qa                    | ✅ `.claude/agents/`; ejecutados sobre Fase 0                                                                                |
| 13  | Cierre: handoff, decisiones, commit, push                    | ✅ `docs/handoff/fase-0.md`; varios commits en `main`, CI verde                                                              |

## Fase 1 — detalle

| #   | Entregable                                                                                                              | Estado                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Decisiones D-025..D-034, §5 resuelta, §3.7 reordenado, RF-80..94 (§4.7/§4.8)                                            | ✅ `docs/ARQUITECTURA.md`, `docs/DECISIONES.md`                                                                   |
| 2   | Prisma: business_lines, finishes, products, customers, suppliers, pricing_settings, exchange_rates, import_batches/rows | ✅ migración `20260902195110_fase1_maestros_catalogo_importacion` aplicada en `dev`, `ci` (vía CI) y `production` |
| 3   | API: business-lines, finishes, catalog, customers, suppliers, pricing, exchange-rates, documents, imports               | ✅ auditoría + roles en cada mutación; revisado por `revisor` y `auditor-seguridad`, hallazgos corregidos         |
| 4   | Importación genérica (RF-52) con adaptadores products/customers                                                         | ✅ sube a R2, valida fila por fila (tolerante a tildes), detecta duplicados intra-archivo, confirma fila por fila |
| 5   | Web: /lineas, /acabados, /catalogo, /clientes, /proveedores, /configuracion/{margenes,tipo-cambio}                      | ✅ CRUD + baja lógica + búsqueda (RF-84) donde aplica; probado a mano en Chrome contra Neon `dev`                 |
| 6   | Tests unit (exchange-rates, pricing) + E2E (`e2e/tests/fase1.spec.ts`)                                                  | ✅ 35 unit; 12 E2E locales (Fase 0 + Fase 1); CI verde (corridas 33682260101, 33682674374)                        |
| 7   | Deploy: API a Cloud Run, migración+seed en `production`, web vía push a `main`                                          | ✅ `pnpm db:prod`, `pnpm deploy:api`; `pnpm e2e:prod` (6/6) tras el deploy                                        |
| 8   | Cierre: handoff, decisiones, commit, push                                                                               | ✅ `docs/handoff/fase-1.md`                                                                                       |

**Hallazgos de seguridad corregidos en esta fase:** `xlsx@0.18.5` tenía 2 CVE high sin parche en npm (prototype pollution, ReDoS) → reemplazado por el build oficial `0.20.3` de `cdn.sheetjs.com`; el nombre de archivo subido en `imports` se saneaba antes de ir a la key de R2 y a la columna `file_name`; los errores de Prisma ya no se exponen crudos en el preview de importación.

**Hallazgos de seguridad diferidos a Fase 7 (hardening), riesgo bajo dado que `imports` es ADMINISTRADOR-only:**

- `parse-spreadsheet.ts` aplica el límite de 2000 filas después de que SheetJS ya descomprimió el archivo completo en memoria; un `.xlsx` diseñado como zip bomb podría agotar memoria antes del chequeo. Mitigación futura: acotar el tamaño descomprimido o mover el parseo a un worker con límite de memoria.
- El `ContentType` guardado en R2 para el archivo de origen es el `mimetype` que declara el cliente, no uno derivado del contenido real. Hoy no hay endpoint que sirva ese objeto de vuelta, así que no es explotable; si se agrega un endpoint de descarga, fijar el `ContentType` según el tipo detectado por el parser.

## Bloqueos

Ninguno abierto. B-01 (facturación GCP) fue resuelta por el dueño el 2026-09-02; ver "B-01 — resuelta" abajo para el detalle de cómo se cerró y qué se aprendió en el proceso.

### B-01 — RESUELTA (2026-09-02): GCP vinculado a facturación

El dueño vinculó el proyecto GCP `ayr-steel-erp` a una cuenta de facturación desde la consola web. A partir de ahí, todo lo demás se completó de forma autónoma:

- `pnpm secrets:gcp` — habilitó las APIs, creó los 3 secretos en Secret Manager y otorgó los roles IAM que Cloud Build y la revisión de Cloud Run necesitan (ver "Hallazgo — IAM insuficiente" abajo).
- `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app` — API en `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`, `/health` en verde.
- `pnpm deploy:web --api-url https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app` — web de producción re-apuntado al API real.
- `pnpm db:prod` — aplicó la migración `refresh_grace_and_audit_append_only` que había quedado solo en Neon `dev` (ver "Hallazgo — migración desactualizada" abajo).
- `pnpm monitors --api-url ... --web-url ...` — los dos monitores de UptimeRobot activos.
- Login real del administrador verificado contra producción (cookies `httpOnly`/`Secure`/`SameSite` correctas). Luego, con `pnpm e2e:prod` (D-024), los 6 escenarios de `auth.spec.ts` en verde contra `https://ayr-steel-erp-web.vercel.app`, incluidos los cuatro exigidos por el cierre de fase: login correcto, login fallido, usuario desactivado no entra y cambio de rol invalida la sesión.

**Hallazgo — migración de producción desactualizada.** La migración `20260902170000_refresh_grace_and_audit_append_only` se había aplicado en la sesión anterior solo a Neon `dev` (vía `cd apps/api && prisma migrate deploy`, que usa `apps/api/.env`), nunca a `production`. El primer intento de login en prod devolvió 500 (`column sessions.previous_token_hash does not exist`). Se corrigió reejecutando `pnpm db:prod`, que aplica todas las migraciones pendientes contra la rama correcta explícitamente. Lección: tras crear una migración manualmente durante una sesión, volver a correr `pnpm db:prod` antes de dar una fase por cerrada si ya se desplegó a producción.

**Hallazgo — rewrite de Vercel bloqueaba el API (D-022).** El `rewrites()` de `next.config.ts` hacia el dominio por defecto de Cloud Run (`*.a.run.app`) devolvía `DNS_HOSTNAME_RESOLVED_PRIVATE` en producción — falso positivo de la protección SSRF de Vercel contra las IPs de Google Frontend. Se reemplazó por un Route Handler catch-all (`apps/web/src/app/api/[...path]/route.ts`) que hace el proxy con `fetch` server-side dentro de una función Node; Vercel no aplica ese chequeo a un `fetch` normal, solo a `rewrites()` declarativos.

**Hallazgo — IAM insuficiente para `deploy --source` (D-023).** La service account de Compute por defecto (`<project-number>-compute@developer.gserviceaccount.com`) tenía `roles/editor` a nivel de proyecto, pero eso no bastó para: (a) que Cloud Build leyera el zip fuente subido al bucket `run-sources-*`, ni (b) que la revisión de Cloud Run leyera los secretos de Secret Manager. `scripts/gcp-secrets.mjs` ahora otorga explícitamente `roles/secretmanager.secretAccessor` (por secreto) y `roles/{storage.objectViewer,cloudbuild.builds.builder,artifactregistry.writer,logging.logWriter}` (a nivel proyecto) a esa cuenta, así que un proyecto GCP nuevo no debería repetir este bloqueo.

## Notas operativas

- `gcloud` en Git Bash falla ("Python was not found"); funciona vía `cmd /c gcloud ...` o desde PowerShell/cmd. `scripts/lib.mjs#run` ya lo resuelve.
- La rama por defecto de Neon se llama `production` (no `main`). Ver D-016.
- Prisma bloquea `migrate reset` cuando lo invoca un agente. El reset de pruebas es `apps/api/prisma/reset-test-db.ts` (D-018).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel está ligado al repo GitHub: cada push a `main` despliega el web.
- El proxy `/api/*` del web es un Route Handler (fetch server-side), no un `rewrite()` de Next: Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run (D-022).
- Para verificar RF-03 contra producción: `pnpm e2e:prod`. Crea un administrador efímero, corre los 6 escenarios de auth y borra los usuarios `e2e-...@ayr.test` en `finally` (D-024). Nunca usa ni modifica la cuenta del dueño. Si la limpieza fallara, el script lo avisa y hay que revisar `/usuarios` en producción.
- `spawnSync('algo.cmd', ...)` sin `shell: true` falla con `EINVAL` en esta máquina Windows/Node 24; usar `shell: true` (o invocar `cmd.exe /c` explícito) al lanzar `pnpm`/binarios `.cmd` desde Node.
- Hallazgos de revisión pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquí para Fase 7 (hardening).
- SonarCloud: en `.env.setup` `SONAR_ORG` y `SONAR_PROJECT_KEY` venían intercambiados (corregido: org `gsinuiri-coder`, key `gsinuiri-coder_ayr-steel-erp`). El proyecto tenía Automatic Analysis activo; se desactivó por API para que el análisis lo haga CI con cobertura (D-021).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesión de Claude Code; en esta sesión se ejecutaron como `general-purpose` con la definición como prompt.
- **Fase 1.** apis.net.pe: el endpoint real es `v1/tipo-cambio-sunat?fecha=YYYY-MM-DD` (verificado contra la API real), no `v2/sunat/tipo-cambio` como se asumió al principio — devolvía 404 y quedó registrado un momento en el log como "no respondió" antes de corregirlo.
- **Fase 1.** `XLSX.read(buffer, {type:'buffer'})` asume un codepage no-UTF-8 para `.csv`, lo que rompe encabezados con tildes ("Línea" no matcheaba ninguna columna). `parse-spreadsheet.ts` ahora detecta si el archivo es un zip real (firma `PK`, `.xlsx`) y si no lo es, decodifica como UTF-8 y lee en modo `'string'`. Encontrado por el E2E de importación, no es cosmético: sin este fix ninguna fila con encabezados en español se validaba nunca.
- **Fase 1.** El E2E de CI (`imports`) sube archivos reales al bucket R2 de producción (`R2_BUCKET` es el mismo en GCP y en GitHub Secrets); quedan objetos de prueba con prefijo `imports/...` en R2 tras cada corrida de CI. No es un riesgo de seguridad, pero conviene un bucket o prefijo separado para CI si el volumen de corridas crece (anotado para Fase 7).
- Prisma expone el enum `BusinessLineCode` con los nombres declarados en el schema (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`, `metallic-roofing`...); `apps/api/src/common/business-line-code.ts` es el único lugar que traduce entre eso y el `BusinessLine` de `@ayr/shared`. Si se agrega una sexta línea de negocio, hay que tocar ese mapa además del enum de Prisma y el de `@ayr/shared`.
