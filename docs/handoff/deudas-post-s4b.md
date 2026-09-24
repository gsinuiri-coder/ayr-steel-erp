# Handoff — Deudas post-RF-S4b y preparación de la revisión del cliente (2026-09-24)

Agente: Claude Code. Worktree `ayr-steel-erp-deudas`, rama `fix/deudas-post-s4b`, construida
sobre `feat/color-comercial` (PR #18) porque comparte `sales-orders.service.ts`, PROGRESO,
ARQUITECTURA y el runbook de la ventana. PR #19 hacia `main`, **sin mergear**. El dueño
autorizó la secuencia entera, sin production, sin Neon, sin merge ni deploy.

## 1. Resumen

- Las reglas `ask` de `apply-ask-rules.mjs` están en el `.claude/settings.json` del checkout
  principal (el script en dry-run: «Nada que agregar»). **Sin commitear**: el cambio vive solo en
  el checkout principal.
- Cinco deudas cerradas, cada una con un test que fallaba antes (§2).
- Guía para la revisión del cliente: `docs/cliente/revision-2026-09-25.md`.
- Runbook de esta noche: paso 5b en `docs/handoff/ventana-color-comercial.md`.

## 2. Hecho

| Deuda   | Qué                                                                                                                                                | Archivos clave                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a/D-275 | Un VENDEDOR llegaba a los dos mensajes. Ahora lee «cotización no disponible (reserva temporal)» y «pedido no disponible» para lo de otro vendedor. | `reserved-ledger.ts`, `raw-material.ts`, `reservation-guard.ts`, `inventory.service.ts`, `dispatches.service.ts`, `sales-orders.service.ts` |
| b/D-276 | `recordPriceChanges` empareja por posición aunque cambie la unidad (revierte D-269 b).                                                             | `price-changes.ts`                                                                                                                          |
| c       | `smoke:prod` acepta `v2.mareliac.pe`; la lista de hosts es exacta.                                                                                 | `scripts/smoke-prod-guard.mjs`                                                                                                              |
| d       | `E2E_API_PORT` (por defecto 3000; rechaza 4000/4001/3001/3002). Con el puerto movido, el web no se reusa.                                          | `scripts/local-docker-env.mjs`, `playwright.config.ts`                                                                                      |
| e       | El `beforeAll` de `auth.service.spec.ts` usa argon2id de costo mínimo; hook con tope de 30 s.                                                      | `auth.service.spec.ts`                                                                                                                      |

Tests nuevos: `reservation-guard.spec.ts`, casos en `raw-material.spec.ts` y `price-changes.spec.ts`,
`scripts/smoke-prod-guard.test.mjs`, `scripts/local-docker-env.test.mjs` y
`e2e/tests/reserva-temporal-alcance-vendedor-d275.spec.ts` (el E2E se corrió contra un build sin
el arreglo y falló con «COT-000001 (reserva temporal)» a la vista de B).

## 3. Decisiones

- **D-275:** criterio de D-267/D-238 en los rechazos de reserva (orden del dueño; los pedidos se
  sumaron por el P1-1 de la autorrevisión, con la misma regla ya vigente de D-238).
- **D-276:** revierte D-269 (b) (orden del dueño).

No hay migraciones.

## 4. Verificación

Detalle en PROGRESO («Deudas post-RF-S4b»). Suite E2E completa local con builds de producción:
388 passed, 10 failed (infraestructura: sin PSE, sin R2 y `fase2a` RF-11), 1 flaky, 2 skipped.
CI de la PR: ver §6.

## 5. Pendientes

- P2 de la autorrevisión (lista en PROGRESO).
- `fase2a` RF-11: rojo local, verde en CI (entorno).
- **Revisión:** lo de esta sesión queda **PENDIENTE DE REVISIÓN INDEPENDIENTE**.

## 6. Commits y CI

Secuencia sobre `be6ecb6` (`feat/color-comercial`): D-275, D-276, smoke, puerto E2E, auth spec,
guía del cliente, hallazgos de la autorrevisión y docs de cierre. CI de la PR: primera corrida con todo verde salvo SonarCloud (Reliability D en código nuevo; el proyecto es privado y no se pudo enumerar el issue). Se corrigieron los bugs de SonarJS de los archivos tocados (`sort()` sin comparador en locks de ids → `byCodeUnit`, `reverse()` que mutaba, una comparación siempre verdadera, un `it` entre hooks) sin cambiar comportamiento, y el gate pasó: 0 issues nuevos. La E2E de la CI pasó entera, incluido `fase2a` RF-11 (el rojo local era del entorno)..
