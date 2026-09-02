# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                        | Estado                       | Cierre                            |
| ------------------------------------------- | ---------------------------- | --------------------------------- |
| 0 — Bootstrap                               | 🟡 Casi cerrada (2026-09-02) | Login E2E verde en prod, CI verde |
| 1 — Líneas, acabados, catálogo, importación | ⚪ Pendiente                 | —                                 |
| 2 — Bobinas + kardex                        | ⚪ Pendiente                 | —                                 |
| 3 — Corte tercerizado + flejes              | ⚪ Pendiente                 | —                                 |
| 4 — Producción + `/planta`                  | ⚪ Pendiente                 | —                                 |
| 5 — Cotizaciones y ventas                   | ⚪ Pendiente                 | —                                 |
| 6 — Facturación Nubefact                    | ⚪ Pendiente                 | —                                 |
| 7 — Auditoría, reportes, UAT                | ⚪ Pendiente                 | —                                 |

## Fase 0 — detalle

| #   | Entregable                                                   | Estado                                                                                                      |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | CLAUDE.md                                                    | ✅                                                                                                          |
| 2   | docs/PROGRESO.md, docs/DECISIONES.md, docs/handoff/          | ✅                                                                                                          |
| 3   | Monorepo pnpm + Turborepo (api, web, shared, eslint-config)  | ✅ `pnpm build/lint/typecheck/test` en verde                                                                |
| 4   | Prisma v0 (User, Session, AuditLog) + migración inicial      | ✅ `20260902160054_init`                                                                                    |
| 5   | Neon ramas dev/ci + migración en dev + seed admin            | ✅ ramas `dev` y `ci` creadas; migración y seed aplicados en `dev`                                          |
| 6   | Auth D-010 + CRUD usuarios + GET /health                     | ✅ revisado por `revisor` y `auditor-seguridad`; hallazgos corregidos                                       |
| 7   | Web: login, cambio de contraseña, sidebar por rol, /usuarios | ✅                                                                                                          |
| 8   | Tests unit (Jest) + E2E Playwright                           | ✅ 23 unit; 7 E2E verdes en local (api+web contra Neon `dev`)                                               |
| 9   | CI GitHub Actions + SonarCloud/Semgrep                       | 🟡 workflow y secrets listos; primera corrida al hacer push                                                 |
| 10  | Deploy Cloud Run + Vercel, login verificado en prod          | 🔴 Web en Vercel OK; imagen Docker del API probada en local; Cloud Run bloqueado por facturación GCP (B-01) |
| 11  | UptimeRobot (API /health, Web /)                             | 🟡 monitor Web creado; API pendiente del deploy                                                             |
| 12  | Subagentes revisor, auditor-seguridad, qa                    | ✅ `.claude/agents/`; ejecutados sobre Fase 0                                                               |
| 13  | Cierre: handoff, decisiones, commit, push                    | ✅ `docs/handoff/fase-0.md`; commit inicial en `main`                                                       |

## Bloqueos

### B-01 — GCP: el proyecto `ayr-steel-erp` no tiene cuenta de facturación (acción humana)

`gcloud services enable run.googleapis.com ...` falla con `UREQ_PROJECT_BILLING_NOT_FOUND`. Cloud Run, Cloud Build, Artifact Registry y Secret Manager exigen facturación activa aunque se use el free tier. Hay dos cuentas de facturación abiertas en la cuenta del dueño (`gcloud billing accounts list`). Vincular una es decisión del dueño (implica tarjeta):

```
gcloud billing projects link ayr-steel-erp --billing-account=<ID_DE_CUENTA>
```

Después, sin más intervención humana:

```
pnpm secrets:gcp
pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app
pnpm deploy:web --api-url https://<url-cloud-run>
pnpm monitors --api-url https://<url-cloud-run> --web-url https://ayr-steel-erp-web.vercel.app
```

La base de producción (Neon `production`) ya tiene las migraciones y el administrador sembrado (`pnpm db:prod`). Verificación final: `E2E_BASE_URL=https://ayr-steel-erp-web.vercel.app pnpm e2e` (solo login/logout).

Mientras tanto el web de producción (https://ayr-steel-erp-web.vercel.app) tiene `API_URL=https://api-pendiente.invalid`: el login responde error hasta desplegar el API.

## Notas operativas

- `gcloud` en Git Bash falla ("Python was not found"); funciona vía `cmd /c gcloud ...` o desde PowerShell/cmd. `scripts/lib.mjs#run` ya lo resuelve.
- La rama por defecto de Neon se llama `production` (no `main`). Ver D-016.
- Prisma bloquea `migrate reset` cuando lo invoca un agente. El reset de pruebas es `apps/api/prisma/reset-test-db.ts` (D-018).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel está ligado al repo GitHub: cada push a `main` despliega el web.
- Hallazgos de revisión pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquí para Fase 7 (hardening).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesión de Claude Code; en esta sesión se ejecutaron como `general-purpose` con la definición como prompt.
