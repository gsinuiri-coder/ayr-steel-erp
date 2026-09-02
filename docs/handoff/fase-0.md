# Handoff — Fase 0 (Bootstrap) — 2026-09-02

## 1. Resumen

Fase 0 según `docs/ARQUITECTURA.md` §3.7 (monorepo, auth, CI, deploy y monitores): **cerrada**. Todo el alcance está entregado, desplegado y verificado contra producción, no solo en local.
Estado: `pnpm turbo lint typecheck test` sale 0; CI verde en `main`; API en Cloud Run y web en Vercel funcionando; los cuatro escenarios de autenticación pasan contra la URL de producción; dos monitores activos en UptimeRobot.
No queda ningún bloqueo abierto. B-01 (facturación GCP) la resolvió el dueño y el resto se completó de forma autónoma.

## 2. Hecho

1. `CLAUDE.md` — reglas de idioma, stack, Decimal (D-003), kardex (§3.2), comandos, protocolo de cierre.
2. `docs/PROGRESO.md`, `docs/DECISIONES.md`, `docs/handoff/`.
3. Monorepo pnpm + Turborepo: `apps/api` (NestJS 11, Prisma 6, pg-boss, config Zod en `apps/api/src/config/env.ts`), `apps/web` (Next 15, Tailwind 4, shadcn 4, TanStack Query, RHF, Zod), `packages/shared` (enums, schemas Zod, `decimal.ts`), `packages/eslint-config`.
4. Prisma v0: `apps/api/prisma/schema.prisma` (User, Session, AuditLog, enums Role/BusinessLine); migraciones `20260902160054_init` y `20260902170000_refresh_grace_and_audit_append_only` (esta última añade la gracia de rotación del refresh token y el trigger que hace inmutable `audit_log`). Ambas aplicadas en `dev`, `ci` y `production`.
5. Neon: ramas `dev` y `ci` creadas desde `production`; seed del administrador en `dev` y `production`.
6. Auth D-010: `apps/api/src/auth/` (login, refresh con rotación y gracia de 30 s, logout público que funciona con el access token ya expirado, cambio de contraseña, guard global que además bloquea al usuario con contraseña temporal pendiente, guard por rol); `apps/api/src/users/` (CRUD solo ADMINISTRADOR, protección del último administrador activo, auditoría en la misma transacción que la mutación); `GET /health`; rate limit por IP+email (`apps/api/src/common/throttler.guard.ts`).
7. Web: `apps/web/src/app/login`, `(app)/cambiar-contrasena`, `(app)/usuarios`, sidebar por rol (`components/app-sidebar.tsx`, `lib/nav.ts`), `middleware.ts`, y el proxy same-origin `/api/*` como Route Handler (`app/api/[...path]/route.ts`, D-022).
8. Tests: `apps/api/src/**/*.spec.ts` (23 unit), `e2e/tests/auth.spec.ts` y `usuarios.spec.ts` (7 E2E) con `playwright.config.ts`, `e2e/global-setup.ts` y el flujo de producción `scripts/e2e-prod.mjs` (D-024).
9. CI: `.github/workflows/ci.yml` (lint, typecheck, unit, E2E contra Neon `ci`, SonarCloud con cobertura / Semgrep si no hay token). Secrets con `pnpm secrets:gh`, con credenciales de administrador exclusivas de CI, distintas de las de producción.
10. Deploy: API en Cloud Run (`scripts/deploy-api.mjs`, `Dockerfile` multi-stage con usuario no root) y web en Vercel (`scripts/deploy-web.mjs`, build remoto, proyecto ligado a GitHub para auto-deploy en push a `main`).
11. UptimeRobot: monitores "AYR Steel ERP - API /health" (tipo KEYWORD sobre `"status":"ok"`) y "AYR Steel ERP - Web", ambos UP, con alerta al correo configurado.
12. Subagentes `.claude/agents/{revisor,auditor-seguridad,qa}.md` y comando `.claude/commands/handoff.md`. Revisor y auditor ejecutados sobre toda la fase; se corrigieron el bloqueante y los hallazgos altos y medios (ver §3 y `docs/PROGRESO.md`).

## 3. Decisiones tomadas

- D-015 — El web consume el API por proxy same-origin `/api/*` (mecanismo actualizado por D-022).
- D-016 — La rama de producción de Neon se llama `production`, no `main` (corrige D-005).
- D-017 — Versiones fijadas sin `^` (NestJS 11.2, Next 15.5, Prisma 6.19, TS 5.9, ESLint 9, Zod 3.25, Jest 29).
- D-018 — Reset de la base de pruebas = `migrate deploy` + `TRUNCATE` con `ALLOW_DB_RESET=1`; nunca `migrate reset`.
- D-019 — Deploy del web con build remoto en Vercel, `rootDirectory=apps/web`, auto-deploy en push a `main`.
- D-020 — Access token de 15 min con `sid` y validación de la sesión en cada request; refresh de 7 días, rotado en cada uso.
- D-021 — SonarCloud analiza desde CI con cobertura; Automatic Analysis desactivado.
- D-022 — El proxy `/api/*` es un Route Handler, no un `rewrites()` de Next (Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run).
- D-023 — IAM explícito para la service account de Compute (Cloud Build + Secret Manager); `roles/editor` no basta.
- D-024 — Los E2E de escritura contra producción corren con un administrador efímero y limpian los usuarios de prueba al terminar.

## 4. Bloqueos / pendientes

Ninguno abierto.

Aplazado a Fase 7 (hardening), son hallazgos de severidad baja de la auditoría: pinear las acciones de GitHub a SHA, añadir CSP y `Permissions-Policy` en el web, y un job que limpie las sesiones expiradas.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test              # exit 0
pnpm e2e                                    # api+web locales contra Neon dev (7 tests)
pnpm e2e:prod                               # 6 escenarios de auth contra producción (D-024)
gh run list --limit 3                       # CI en main
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
curl -s https://ayr-steel-erp-web.vercel.app/api/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, migrada, con el administrador sembrado y cambio de contraseña obligatorio en su primer ingreso.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla a producción con `pnpm db:prod` antes de desplegar el API.

## 6. Siguiente sesión

Fase 1 (§3.7): líneas de negocio, acabados (RF-25), catálogo por línea (RF-50) e importación desde planilla (RF-52).

Primera tarea concreta: modelar en `schema.prisma` las entidades `business_lines`, `finishes` (con su factor de densidad como `Decimal @db.Decimal` con escala explícita, según §3.3) y `products` (con `businessLineId` obligatorio), crear la migración y aplicarla a `dev`; luego los módulos NestJS `business-lines`, `finishes` y `catalog`, y sus páginas web. Recordar la regla del kardex (§3.2) al llegar a inventario en Fase 2: ningún módulo escribe stock directamente.
