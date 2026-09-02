# AYR Steel ERP — reglas operativas del agente

ERP web para una empresa peruana de transformación y venta de acero. Fuente de verdad del dominio y la arquitectura: `docs/ARQUITECTURA.md`. Este archivo solo tiene reglas operativas.

## Documentos (leer antes de programar)

- `docs/ARQUITECTURA.md` — requisitos (RF-nn), decisiones (§0.2, D-nnn), arquitectura (§3), fases (§3.7), preguntas abiertas con recomendación (§5).
- `docs/PROGRESO.md` — estado por fase y bloqueos. Actualizar al cerrar cada punto grande.
- `docs/DECISIONES.md` — contexto largo de decisiones cuando §0.2 no basta.
- `docs/handoff/` — resúmenes de cierre de sesión (`/handoff <nombre>`).

## Idioma

- Identificadores de código (variables, funciones, columnas, rutas API, archivos) en **inglés**.
- UI, mensajes de error, comentarios, docs y commits en **español**.
- Commits: conventional commits en español. Ej.: `feat(auth): login con email y password`, `fix(users): no permitir desactivarse a sí mismo`.

## Stack (D-002..D-008)

- Monorepo `pnpm` + Turborepo: `apps/api` (NestJS 11, Prisma 6, pg-boss, config por Zod), `apps/web` (Next.js 15 App Router, Tailwind 4, shadcn/ui, TanStack Query, React Hook Form, Zod), `packages/shared` (schemas Zod, enums `Role`/`BusinessLine`, helper `Decimal`).
- DB: Neon Postgres, proyecto `ayr-steel-erp`. Ramas: `production` (prod), `dev` (local), `ci` (tests, se resetea por corrida). **Nunca borrar ramas de Neon.**
- Hosting: API en Cloud Run `us-central1`; web en Vercel. El web llama al API por `/api/*` (rewrite de Next, D-015).
- Auth propia (D-010): argon2id, JWT de acceso corto + refresh en tabla `sessions`, cookies httpOnly.

## Reglas duras

1. **Decimal (D-003)**: dinero, kg y mm NUNCA se operan con `number`. Usar `Decimal`/`money()`/`kg()`/`mm()` de `@ayr/shared`. Columnas `NUMERIC` con escala explícita: dinero 4, kg 3, mm 2. Serializar como string.
2. **Kardex (§3.2)**: todo cambio de stock pasa por el módulo `inventory` como movimiento append-only en `inventory_movements`. Ningún módulo escribe stock directamente. Anular = movimiento inverso, nunca `DELETE`.
3. **Auditoría (RF-95)**: `audit_log` es append-only. Acciones críticas pasan por `AuditService.log`.
4. **Sesiones (RF-03)**: cambiar rol, desactivar o resetear contraseña llama a `AuthService.revokeAllSessions`.
5. **Secretos**: `.env.setup` tiene todas las credenciales. Nunca imprimirlo, nunca commitearlo, nunca copiar valores a código o docs. Los scripts lo leen con `scripts/lib.mjs#readEnvFile`.
6. **Git**: nunca `git push --force`. Commits pequeños por punto de alcance.
7. **Windows**: scripts cross-platform (Node/pnpm), sin bash-isms. `gcloud` se invoca vía `cmd /c gcloud ...` desde Git Bash.
8. Si un comando externo falla 3 veces, documentar el bloqueo en `docs/PROGRESO.md` y seguir con lo que no dependa de él.
9. Dudas de diseño: aplicar la recomendación de `docs/ARQUITECTURA.md` §5 y registrar la decisión en §0.2. Preguntar al dueño solo si un servicio externo exige acción humana.

## Comandos

```
pnpm install                 # dependencias
pnpm env:local               # genera apps/api/.env y apps/web/.env.local (Neon rama dev)
pnpm dev                     # api :3000 + web :3001
pnpm build | lint | typecheck | test
pnpm db:migrate              # prisma migrate dev (rama dev)
pnpm db:deploy               # prisma migrate deploy (CI/prod)
pnpm db:seed                 # admin desde ADMIN_EMAIL/ADMIN_PASSWORD
pnpm e2e                     # Playwright (levanta api+web contra Neon rama ci)
pnpm secrets:gh              # gh secret set desde .env.setup
pnpm deploy:api | deploy:web # Cloud Run / Vercel
pnpm monitors                # UptimeRobot
```

## Subagentes (`.claude/agents/`)

- `revisor`: lee el diff y reporta bugs/smells. No edita.
- `auditor-seguridad`: OWASP, secretos, dependencias. Puede pedir segunda opinión a `agy`.
- `qa`: escribe y ejecuta Playwright bajo `e2e/`.
  Usarlos al terminar cada punto grande; en paralelo cuando no dependan entre sí.

## Protocolo de cierre de sesión

1. `pnpm lint && pnpm typecheck && pnpm test` en verde.
2. Actualizar `docs/PROGRESO.md` (estado, bloqueos).
3. Nuevas decisiones → `docs/ARQUITECTURA.md` §0.2 (y `docs/DECISIONES.md` si necesitan contexto).
4. `/handoff <fase-o-tema>` → `docs/handoff/<nombre>.md`.
5. Commit y push a `main`. Verificar CI verde en GitHub Actions.
