# Handoff — RF-S2 (Auditoría)

## Resumen

Sesión 2 de 5 del lote de auditoría/reportes/UAT (ver D-214). Entregó el visor unificado de
auditoría de RF-95/96: extensión de `audit_log` (RF-95, ya existente) con `actor_kind`,
`reason` y `request_id`, y `GET /audit` + pantalla **Administración › Auditoría** que une
`audit_log` con los tres changelogs dedicados que ya existían (D-187/D-217/D-211) por cursor.
Trabajada en un worktree separado (`ayr-steel-erp-rf-s2`, rama `rf-s2`) por instrucción del
dueño, para no interferir con el deploy pendiente de RF-S1 en `main`. **10 commits locales en
`rf-s2`, ninguno en `main`, sin merge ni push.** `pnpm lint && typecheck && test &&
format:check` en verde (39 suites / 483 tests).

## Hecho

- **M0 — higiene heredada de RF-S1**: fila de D-217 que faltaba en `ARQUITECTURA.md` §0.2
  (`docs/ARQUITECTURA.md`, commit `dc83120`).
- **M1 — modelo (D-218)**: `AuditLog` extendido (`apps/api/prisma/schema.prisma`, migración
  `20260916153802_d218_...`), `AsyncLocalStorage` para `requestId`
  (`apps/api/src/common/request-context.ts`, `request-id.middleware.ts`), redacción de
  secretos (`apps/api/src/audit/audit-redact.ts`).
- **M2 — mapa acción→fuente + alcance de tests (D-219)**: censo de ~105 acciones en 28
  archivos, documentado en `docs/PROGRESO.md` (sección RF-S2); decisión de no duplicar tests
  por acción, apoyada en la transacción compartida y en `claimIdempotencyKey` (D-182).
- **M3 — visor**: backend (`apps/api/src/audit/audit-query.service.ts`,
  `audit-cursor.ts`, `audit.controller.ts`) y frontend
  (`apps/web/src/app/(app)/auditoria/`, `apps/web/src/lib/audit-labels.ts`).
- **M4 — "Historial" en el detalle** (sacrificable, se llegó a tiempo):
  `apps/web/src/components/audit-history-link.tsx`, enlazado en pedidos, cotizaciones,
  bobinas y comprobantes.
- **M5 — eventos de login** (sacrificable, ya estaba cubierto): verificado, sin código nuevo.
- **Revisión y correcciones (D-220)**: `revisor`/`auditor-seguridad`/`qa` en paralelo tras M3.
  1 ALTO (desempate de `id` como texto en vez de `BigInt`) y 3 MEDIO/BAJO corregidos;
  1 índice nuevo (`20260916170000_d220_...`); 1 límite estructural de la paginación entre
  fuentes queda documentado, no resuelto. `e2e/tests/auditoria-d218.spec.ts` (2/2 verde).
- **Documentación**: `docs/uat/rf-s2.md` (7 casos), `docs/PROGRESO.md` (sección de cierre con
  el mapa acción→fuente completo), este handoff.

## Decisiones tomadas

- **D-217**: fila que faltaba desde RF-S1 (historial de precios de lista), agregada acá.
- **D-218**: extender `audit_log` en vez de crear `audit_events` — ya existía, ya lo usaban
  ~28 servicios, una tabla nueva habría duplicado RF-95.
- **D-219**: no se escribió un test de auditoría por acción — la transacción compartida y
  D-182 ya prueban rollback e idempotencia; se documenta en vez de repetirlo con Jest.
- **D-220**: cinco correcciones de la revisión (desempate por `BigInt`, validación de UUID en
  `entityId`, `decodeCursor` más estricto + traducido a 400, regex de redacción más ancha,
  índice `(entity, at)`), más el límite de paginación entre fuentes documentado como deuda.

## Bloqueos / pendientes

- **Límite estructural de la paginación entre fuentes** (D-220): si dos fuentes distintas
  empatan al milisegundo y una de ellas tenía más filas que `pageSize` en ese instante, una
  fila puede quedar sin mostrar nunca. Acotado hoy (hace falta una carga masiva grande
  cruzando el borde exacto de una página); una sesión futura puede rediseñar con buffer de
  continuación por fuente si el volumen de `audit_log` lo vuelve real. Sin acción humana
  requerida ahora.
- **Suite E2E completa: no se corrió** (misma deuda de memoria del host que ya documentó
  RF-S1 — necesita worktree y builds de producción dedicados). El spec nuevo de esta sesión
  sí se corrió suelto, dos veces, en verde.
- **Migraciones sin aplicar contra `dev`/`demo`/`production`**: las dos de esta sesión
  (`20260916153802_d218_...`, `20260916170000_d220_...`) solo se aplicaron contra el Postgres
  local (`ayr_local`/`ayr_local_e2e`). Acción humana: el dueño decide cuándo integrar `rf-s2`
  y correr `pnpm db:deploy`/`db:prod` contra las ramas que corresponda.
- **`rf-s2` no está mergeada ni pusheada.** Acción humana: revisar la rama y decidir merge o
  push cuando convenga, sin pisar el push pendiente de RF-S1 en `main`.

## Cómo verificar

Desde `C:\Users\User\Documents\workspace\ayr\ayr-steel-erp-rf-s2` (worktree de esta sesión,
rama `rf-s2`):

```
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
pnpm exec playwright test e2e/tests/auditoria-d218.spec.ts
```

Para mirar la pantalla: `pnpm dev:local` (Docker Postgres + api/web en `:3000`/`:3001`), login
como `admin@ayr.local`, entrar a **Administración › Auditoría**.

```
git log --oneline 49fe903..HEAD   # los 10 commits de esta sesión
git status --porcelain             # limpio
git diff main --stat               # nada toca main
```

## Siguiente sesión

Con RF-95/96 (auditoría) entregada, lo que queda de la Fase 8 (`ARQUITECTURA.md` §3.7) son
los cinco reportes de RF-90..94, que todavía no empezaron (`docs/PROGRESO.md`, fila de la
Fase 8). Primera tarea concreta de RF-S3 (o la que el dueño priorice): relevar qué reportes
pide exactamente RF-90..94 en `ARQUITECTURA.md` §4.8 y diseñar el primero contra los datos
reales que ya hay en `production` desde el 2026-09-07.
