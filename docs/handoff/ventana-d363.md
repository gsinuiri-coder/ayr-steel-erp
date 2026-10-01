# Handoff — ventana D-363 (2026-09-29)

## 1. Resumen

PR #58 se integró y desplegó en producción. Release: `df520e0` (merge de la cabeza funcional `0910b3d`); API: `ayr-steel-erp-api-00066-6gt`, 100 % de tráfico y label `git-sha=df520e0`.

El API, Vercel y el smoke de producción quedaron verdes. No hubo migración ni escritura de datos funcionales.

## 2. Hecho

- D-363 excluye `ANNULLED` y `VOIDED` del conteo «sin despacho declarado», manteniéndolos en el conteo por estado.
- Cloud Run recibió primero la revisión de API; `/health` devolvió 200 con DB OK y Vercel confirmó el deployment de `df520e0`.
- `pnpm smoke:prod` pasó y eliminó su administrador efímero.
- `pnpm inspect:undispatched-invoices --branch production --confirm-production` se ejecutó en una transacción `READ ONLY`: 44 `ACCEPTED` (2 pendientes D-285, 1 sin despacho declarado), 7 `ANNULLED` (0 pendientes, 0 sin despacho declarado) y 0 `VOIDED`.

## 3. Decisiones tomadas

- **D-363** — desplegada con `df520e0`. El criterio compartido `LIVE_DOCUMENT_STATUSES` ya rige el conteo operativo y el aviso visual.
- Ninguna decisión nueva en la ventana.

## 4. Bloqueos / pendientes

- `BBV1-00000341` y `BBV1-00000347` permanecen `BLOQUEADO-RECOSTEO`; requieren decisión del dueño y no se tocaron.
- `fix:purchase-received-dates` queda parqueado en `main`. Su undo está cubierto por regresión; no se ejecutó en esta ventana.

## 5. Cómo verificar

```powershell
# Desde un checkout de main con los artefactos locales actualizados.
pnpm --filter @ayr/shared build
pnpm --filter @ayr/api db:generate
pnpm inspect:undispatched-invoices --branch production --confirm-production
```

La salida esperada incluye `ANNULLED | 7 | 0 | 0` y las dos filas `BBV1-00000341` y `BBV1-00000347` como `BLOQUEADO-RECOSTEO`.

Pruebas de PR: lint, typecheck, unit, Sonar (86,2 % de cobertura nueva), Playwright integral y smoke E2E de CI verdes. Ventana: `/health` 200, Vercel verde y `pnpm smoke:prod` verde.

## 6. Siguiente sesión

No reutilizar el tool de fechas sin una decisión específica sobre las compras pendientes de recosteo. La inspección read-only queda disponible para una nueva foto de producción.
