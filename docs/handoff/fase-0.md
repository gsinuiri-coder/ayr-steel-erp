# Handoff — Fase 0 (Bootstrap) — 2026-09-02

## 1. Resumen

Fase 0 según `docs/ARQUITECTURA.md` §3.7: monorepo, auth, CI, deploy y monitores. Se entregó todo el alcance de código con lint/typecheck/23 unit/7 E2E en verde en local, web desplegado en Vercel, base de producción migrada y sembrada, monitor del web en UptimeRobot.
No cerrado: el API no está en Cloud Run porque el proyecto GCP no tiene facturación (B-01, acción humana). CI corre por primera vez con el push de este cierre.

## 2. Hecho

1. `CLAUDE.md` — reglas de idioma, stack, Decimal (D-003), kardex (§3.2), comandos, protocolo de cierre.
2. `docs/PROGRESO.md`, `docs/DECISIONES.md`, `docs/handoff/`.
3. Monorepo pnpm + Turborepo: `apps/api` (NestJS 11, Prisma 6, pg-boss, config Zod en `apps/api/src/config/env.ts`), `apps/web` (Next 15, Tailwind 4, shadcn 4, TanStack Query, RHF, Zod), `packages/shared` (enums, schemas Zod, `decimal.ts`), `packages/eslint-config`.
4. Prisma v0: `apps/api/prisma/schema.prisma` (User, Session, AuditLog, enums Role/BusinessLine); migraciones `20260902160054_init` y `20260902170000_refresh_grace_and_audit_append_only` (trigger que hace inmutable `audit_log`).
5. Neon: ramas `dev` y `ci` creadas desde `production`; migraciones y seed aplicados en `dev` y en `production` (`pnpm db:prod`).
6. Auth D-010: `apps/api/src/auth/` (login, refresh con rotación y gracia de 30 s, logout público, cambio de contraseña, guard global con `mustChangePassword`, guard por rol); `apps/api/src/users/` (CRUD solo ADMINISTRADOR, protección del último admin, auditoría transaccional); `GET /health`; rate limit por IP+email (`apps/api/src/common/throttler.guard.ts`).
7. Web: `apps/web/src/app/login`, `(app)/cambiar-contrasena`, `(app)/usuarios`, sidebar por rol (`components/app-sidebar.tsx`, `lib/nav.ts`), `middleware.ts`, rewrite `/api/*` (D-015).
8. Tests: `apps/api/src/**/*.spec.ts` (23), `e2e/tests/auth.spec.ts` y `usuarios.spec.ts` (7) con `playwright.config.ts` y `e2e/global-setup.ts`.
9. CI: `.github/workflows/ci.yml` (lint, typecheck, unit, E2E contra Neon `ci`, SonarCloud si hay token / Semgrep si no). Secrets subidos con `pnpm secrets:gh` (credenciales de admin exclusivas de CI).
10. Deploy: `Dockerfile` probado en local (`/health` ok con DB y pg-boss); `scripts/deploy-api.mjs`; web en https://ayr-steel-erp-web.vercel.app (`scripts/deploy-web.mjs`, build remoto, proyecto ligado a GitHub).
11. UptimeRobot (API v3): monitor "AYR Steel ERP - Web" creado; el del API se crea con `pnpm monitors --api-url ...` tras el deploy.
12. Subagentes `.claude/agents/{revisor,auditor-seguridad,qa}.md` y comando `.claude/commands/handoff.md`. Revisor y auditor ejecutados; hallazgos bloqueantes/altos/medios corregidos (Dockerfile, logout tras expiración, rate limit tras proxy, race de refresh, transacciones de auditoría, overrides de dependencias, etc.).

## 3. Decisiones tomadas

- D-015 — Web consume el API por rewrite same-origin `/api/*`; cookies httpOnly Lax sin `domain`.
- D-016 — Rama de producción de Neon se llama `production` (corrige D-005).
- D-017 — Versiones fijadas sin `^` (NestJS 11.2, Next 15.5, Prisma 6.19, TS 5.9, ESLint 9, Zod 3.25, Jest 29).
- D-018 — Reset de DB de pruebas = `migrate deploy` + `TRUNCATE` con `ALLOW_DB_RESET=1`; nunca `migrate reset`.
- D-019 — Deploy web con build remoto en Vercel, `rootDirectory=apps/web`, auto-deploy en push a `main`.
- D-020 — Access token 15 min con `sid` y validación de sesión por request; refresh 7 días rotado.

## 4. Bloqueos / pendientes

- **B-01 (acción humana):** el proyecto GCP `ayr-steel-erp` no tiene cuenta de facturación; Cloud Run/Cloud Build/Secret Manager no se pueden habilitar. Hay dos cuentas de facturación abiertas en la cuenta del dueño. Al vincular una, el resto es automático (ver §5). Hasta entonces el web de producción apunta a `API_URL=https://api-pendiente.invalid` y el login en prod falla.
- Pendiente derivado de B-01: monitor UptimeRobot del API y verificación Playwright del login en producción (`E2E_BASE_URL`).
- Primera corrida de CI: se dispara con el push de este cierre; revisar con `gh run watch`.
- Hallazgos bajos aplazados a Fase 7: pinear acciones de GitHub a SHA, CSP/Permissions-Policy en el web, job de limpieza de `sessions` expiradas.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm e2e                                   # api+web locales contra Neon dev (7 tests)
gh run list --limit 3 && gh run watch      # CI
curl -s https://ayr-steel-erp-web.vercel.app/login -o /dev/null -w "%{http_code}\n"
```

Cuando el dueño vincule facturación (`gcloud billing projects link ayr-steel-erp --billing-account=<ID>`):

```
pnpm secrets:gcp
pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app
pnpm deploy:web --api-url https://<url-cloud-run>
pnpm monitors --api-url https://<url-cloud-run> --web-url https://ayr-steel-erp-web.vercel.app
set E2E_BASE_URL=https://ayr-steel-erp-web.vercel.app && pnpm e2e
```

Producción: web https://ayr-steel-erp-web.vercel.app · API pendiente · DB Neon `production` (migrada, admin sembrado con cambio de contraseña obligatorio).

## 6. Siguiente sesión

Fase 1 (§3.7): líneas de negocio, acabados (RF-25), catálogo por línea (RF-50) e importación desde planilla (RF-52). Primera tarea concreta: modelar `business_lines`, `finishes` (con factor de densidad, `Decimal @db.Decimal(10,4)`) y `products` en `schema.prisma` siguiendo §3.3, con migración, módulos NestJS `business-lines`/`finishes`/`catalog` y páginas web correspondientes; antes, si B-01 ya está resuelto, ejecutar los comandos de §5 para cerrar Fase 0 con login E2E verde en prod.
