# Handoff — Ventana RF-S3c (2026-09-22)

Ventana exprés de despliegue, con el sistema sin usuarios activos. Agente: Claude Code.

## Qué quedó desplegado

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| `main`    | `e1c6227` (merge del PR #7, OK D-232 del dueño)                                                 |
| API       | `ayr-steel-erp-api-00039-r4h`, `git-sha=bd84ab8`, 100 % de tráfico, `{"status":"ok","db":"ok"}` |
| Web       | deployment de producción de Vercel sobre `e1c6227`, alias `v2.mareliac.pe`                      |
| Migración | `20260920120000_rf_s3c_seller_scope`, aditiva, aplicada                                         |
| Backfill  | 73 cotizaciones + 19 pedidos, 0 NULLs; segunda pasada en dry-run dio 0 pendientes               |
| Smoke     | `pnpm smoke:prod` verde desde el worktree en `bd84ab8`                                          |
| Respaldo  | `respaldo-pre-s3c-20260922` (`br-old-tooth-ae9txqcv`), LSN `0/14D0C9F0`                         |

Alineación de runtime verificada: `git diff --quiet bd84ab8 origin/main -- apps packages
Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml` → exit 0.

## Decisiones nuevas

- **D-240**: el dueño comercial de un pedido se hereda de su cotización, nunca de quien lo
  confirmó; solo el pedido directo pertenece a su creador. Una sola función,
  `resolveOrderSeller` en `apps/api/src/auth/seller-scope.ts`, usada por el servicio y por el
  backfill.
- **D-241**: el backfill admite `--branch production`, con `--confirm-production` obligatorio
  para `--execute`; el dry-run no lo pide. Lo ejecuta el dueño (D-234).

## Lo que el siguiente tiene que saber antes de tocar esto

1. **Ningún VENDEDOR tiene datos en producción.** Las 73 cotizaciones y los 19 pedidos son de
   `Administrador <gsinuiri@gmail.com>`. La única cuenta con rol VENDEDOR no creó nada. Por eso
   el 404 de alcance pasa trivialmente: para esa cuenta todo es ajeno. No confundir eso con
   haber probado que un vendedor ve su cartera.
2. **Reasignar lo vivo es trabajo de M4, no del backfill.** `PATCH /sales/quotations/:id/seller`
   arrastra el pedido y deja rastro en `audit_log`. El backfill filtra por `seller_id IS NULL`,
   así que nunca pisará una reasignación hecha a mano — y tampoco corregirá una asignación que
   ya exista.
3. **La regla del dueño comercial vive en un solo sitio.** Si hay que cambiarla, se cambia en
   `resolveOrderSeller` y el centinela de `seller-scope.spec.ts` lo exige. Duplicarla fue el
   defecto que casi llega a producción.
4. **Deuda abierta: el quality gate de SonarCloud sobre el PR #7 quedó en rojo** —20.3 % de
   cobertura en código nuevo (exige ≥ 80 %) y Reliability D en código nuevo (exige ≥ A)— y el
   dueño decidió que no bloqueara este merge. **Los issues concretos no se pudieron enumerar**:
   el proyecto de SonarCloud es privado, la API anónima responde `Project doesn't exist`, el
   `SONAR_TOKEN` solo existe en los secrets de Actions y el bot no dejó comentarios inline. Se
   evalúa antes del merge de RF-S4a, con token o desde el dashboard.
5. **`.env.setup` no viene en un worktree nuevo** y lo necesitan `db:prod` y `deploy:api`. En
   esta ventana se copió desde el checkout principal y se retiró al cerrar.

## Ramas Neon vigentes

Ninguna se borra sin OK del dueño por nombre.

- `respaldo-pre-s3c-20260922` — respaldo de esta ventana; conservar.
- `ensayo-s3c-20260920` — clon de ensayo, con migración y backfill aplicados; el dueño decide
  cuándo se retira.
- `respaldo-pre-v4-20260915`, `respaldo-pre-s2-20260917`, `ensayo-v4-20260915`,
  `dev-antes-de-rf-s3-20260917` — sin cambios en esta ventana.

## Rollback (no fue necesario)

Vercel → `dpl_264qqLSver3fDPYRHiRGtWb6yCbe`. API → tráfico a `ayr-steel-erp-api-00038-ljx`
(`git-sha=d25f6b2`). La migración se queda: es aditiva y el API viejo la ignora.
