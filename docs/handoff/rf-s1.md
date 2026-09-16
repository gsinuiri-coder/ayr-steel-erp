# RF-S1 — M0 higiene + precios de lista

Cierre de la sesión del 2026-09-16 (sesión 1 de 5 del lote RF-S1). Se entregaron M0 (higiene
operativa) y M1 (precios de lista) completos; **M2 se sacrificó por tiempo**, por instrucción
explícita del brief («si falta tiempo: se sacrifica M2, luego M0e»). Seis commits locales
sobre `main`, en verde (`lint`/`typecheck`/`test`/`format:check`), **sin push** — `main` es
producción y el push queda para el dueño.

## Hecho

**PASO 0** — el plan de sesiones RF-S1..RF-S5 no es una renumeración de RF-90..96 (§4.8 solo
nombra los cinco reportes + auditoría); `Product.listPricePen` ya existía (D-068) y ya estaba
prellenado en todos lados — lo que faltaba era todo lo que M1 construyó alrededor. El bug de
`purgeInvoicingTrail` que describía el handoff de F8-S7 no reproducía en el código actual.

**M0 — higiene**

- M0a: push fuera del auto-allow del agente — `.claude/settings.json`
  (`deny`: `git push:*`, `gh pr merge:*`, `gh repo sync:*`, `gh api:*`).
- M0b: dos notas operativas en `CLAUDE.md` (spec suelto de Playwright, suite completa necesita
  builds de producción en esta máquina).
- M0c: `e2e/helpers/invoicing.ts#purgeInvoicingTrail` — un `MANUAL`/`IMPORTED` va directo a
  `/annul` en vez de intentar baja + nota de crédito de respaldo.
- M0d: `PSE_ENABLED` — `apps/api/src/config/env.ts`, `apps/api/src/invoicing/invoicing.service.ts`.
- M0e: sacrificado, sin tocar (el brief pedía no adivinar versiones de Actions).

**M1 — precios de lista**

- M1a: `apps/api/prisma/schema.prisma` (`ProductListPriceChange`), migración
  `20260916142234_d217_historial_precio_lista`, `apps/api/src/catalog/price-list-changes.ts`.
- M1b: `apps/web/src/components/catalog/price-list-cell.tsx`,
  `price-list-history-dialog.tsx`, `GET /catalog/:id/price-floor` en `catalog.service.ts`.
- M1c: `apps/api/src/catalog/price-list-import.{service,controller}.ts`,
  `apps/web/src/app/(app)/catalogo/precios/importar/`, plantilla en
  `docs/plantillas/precios-de-lista.csv` (+ copia servida en `apps/web/public/plantillas/`).

**Verificación** — `revisor` + `auditor-seguridad` + `qa` en paralelo sobre el diff completo:
1 MEDIO de cada uno de los dos primeros (ambos corregidos), `e2e/tests/precios-lista-d217.spec.ts`
(6/6, escrito por `qa`, sin bugs de la app encontrados). Detalle completo, con qué se corrigió
y qué quedó anotado, en `docs/PROGRESO.md` → sección "Sesión RF-S1".

## Decisiones tomadas

- **D-214** — RF-90..96 (§4.8) son los cinco reportes + auditoría; el plan de sesiones
  RF-S1..RF-S5 es agenda de trabajo, no renumeración de requisitos.
- **D-215** — El bug de `purgeInvoicingTrail` del handoff de F8-S7 no existe en el código
  actual; el residuo real es una nota de crédito borrador huérfana (corregido).
- **D-216** — `PSE_ENABLED`: apagado explícito de la emisión electrónica, con el gate
  deliberadamente fuera de `assignInTx` para no romper el mostrador (D-099/D-073).
- **D-217** — Historial append-only de `listPricePen` (`product_list_price_changes`), mismo
  criterio que `SalesPriceChange` (D-187); carga masiva sin estado entre preview y confirmar,
  mismo criterio que el importador de cotizaciones (D-152).

## Bloqueos / pendientes

- **M2** (card «SKUs con lista bajo piso»): sacrificado, diseño completo en el brief, sin
  código. Candidato natural para RF-S2 si el dueño lo prioriza.
- **`refreshStatus()` sin pasar por `callProvider()`** en la rama `VOID_PENDING` (hallazgo
  BAJO/INFO de `auditor-seguridad`): hoy no es explotable porque `assertPseEnabled()` ya corta
  al principio del método; robustez a futuro, no bloqueante.
- **Nadie cargó precios de lista reales en `production`.** La infraestructura está lista
  (M1); cargarlos es una decisión y una acción del dueño, no de esta sesión.
- **Suite E2E completa: no se corrió esta sesión** (deuda de memoria del host, ya conocida).
  El spec nuevo se corrió suelto, dos veces, en verde.
- **Acción humana requerida:** el dueño corre el push (comando exacto abajo) y, cuando lo
  considere, decide si/cuándo cargar precios de lista reales contra `production`.

## Cómo verificar

```
git log --oneline f92a3df..HEAD              # los 6 commits de esta sesión
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check   # en verde, ya corrido
pnpm exec playwright test e2e/tests/precios-lista-d217.spec.ts  # 6/6, ya corrido
git push origin main                          # el dueño, cuando revise el diff
```

Después del push, verificar CI verde en GitHub Actions (`gh run watch` o
`gh run list --branch main --limit 1`).

## Siguiente sesión

RF-S2 (auditoría, según `docs/ARQUITECTURA.md` §3.7 y el plan de sesiones del dueño). Primera
tarea concreta: relevar qué de RF-95/96 (auditoría append-only, consulta del registro) ya está
cubierto por `AuditService`/`audit_log` (que ya existe y ya se usa en toda la app) contra lo
que falta — probablemente una pantalla de consulta, no el registro en sí. Si el dueño prioriza
M2 de esta sesión (card de precios bajo piso) antes que RF-S2, el diseño ya está escrito en
`docs/PROGRESO.md` → "Lo que M2 (sacrificado) habría sido".
