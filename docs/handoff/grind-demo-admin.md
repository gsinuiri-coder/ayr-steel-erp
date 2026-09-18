# Handoff — grind de credencial del administrador demo

## 1. Resumen

Se resolvió la contradicción detectada durante la ventana RF-S3: `pnpm db:demo` ahora obliga al
seed a restablecer el hash del administrador con la contraseña propia de `.env.demo`. El cambio
vive en `fix/demo-admin-seed`; no se ejecutó contra Neon ni se tocaron schema o datos.

## 2. Hecho

- `scripts/db-demo.mjs` define `SEED_ADMIN_FOR_TESTS=1` en el entorno de sus procesos hijos.
- `scripts/db-demo.test.mjs` actúa como centinela para que el guardrail no desaparezca.
- `pnpm test:scripts` se ejecuta en el job de calidad de CI.
- D-236 registra que la promesa de `docs/ENTORNOS.md` se conserva y el script se corrige.
- La deuda quedó marcada como resuelta en el handoff de la ventana RF-S3.

## 3. Decisiones tomadas

- **D-236:** demo reemplaza deliberadamente el hash clonado usando el modo de seed para pruebas;
  producción conserva el comportamiento normal que nunca pisa una contraseña existente.

## 4. Bloqueos / pendientes

- La revisión independiente con Antigravity quedó bloqueada tras tres intentos: el modo headless
  auto-deniega el permiso `command` necesario para leer el diff. No se usó el modo sin permisos.
- Falta CI remota y el OK D-232 del dueño antes de integrar a `main`.

## 5. Cómo verificar

```bash
pnpm --filter @ayr/api db:generate
pnpm test:scripts
pnpm lint
pnpm typecheck
```

Resultado local: test de scripts 1 passed/0 failed; lint y typecheck verdes. La primera corrida
de lint/typecheck falló porque el worktree nuevo no tenía generado Prisma; tras `db:generate`,
ambas verificaciones quedaron verdes. No aplica E2E: no cambian rutas de aplicación ni dominio.

## 6. Siguiente sesión

Revisar la CI del PR y, si queda verde, presentar el resumen D-232 al dueño antes del merge.
