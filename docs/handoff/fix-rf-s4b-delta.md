# Handoff — Correcciones del delta RF-S4b (2026-09-24)

Agente: Claude Code. Worktrees `ayr-steel-erp-fix-s4b` (M1, rama `fix/rf-s4b-delta`) y
`ayr-steel-erp-fix-s4b-2` (M2–M6, rama `fix/rf-s4b-delta-2`). Informe de origen:
`docs/revision/rf-s4b-delta.md`. Rige D-251; el dueño autorizó en la sesión la secuencia
merge M1 → verificación → segundo PR → merge → deploy de API si cambia el runtime.

## 1. Resumen

- **M1 (P1-1, D-263) en production.** PR #15 → `main` = `6492b4d` (fast-forward), CI verde
  (run 35968709566), Vercel production `success`, `pnpm smoke:prod` verde desde `6492b4d`.
- **Verificación en production (solo lectura):** dry-run del barrido → 40 documentos abiertos con
  0 hallazgos; ninguna línea de plancha abierta difiere del papel.
- **Segundo PR:** M2–M6 + D-264/D-265/D-266. Estado de CI, merge y deploy: ver §5.

## 2. Hecho

| Milestone | Qué                                                                                                                                                                                                | Archivos clave                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| M1        | La unidad del precio la dice lo guardado: la plancha importada por plancha se edita por plancha (D-263)                                                                                            | `sales-document-form.tsx`, `e2e/tests/plancha-importada-d263.spec.ts`                                         |
| M2        | `snapshot-reports`: `--base-url` obligatorio, `--ephemeral-admin` exige `--branch` coherente con el host, correo propio por corrida y limpieza solo de ese correo                                  | `scripts/snapshot-reports*.mjs`, `prisma/cleanup-e2e-users.ts` (`E2E_CLEANUP_ONLY_EMAIL`)                     |
| M3        | `db-reset-dev` rota la contraseña de `neondb_owner` por la API de Neon después del reset y verifica por hash; sin `NEON_API_KEY` no resetea; `--rotate-only`. AGENTS.md §3.1 y ENTORNOS corregidos | `scripts/neon-role-rotation.mjs`, `scripts/db-reset-dev.mjs`                                                  |
| M4        | `ask` de 23 a 62 reglas: `pnpm run`/`--silent`, `node scripts/*.mjs` que escriben, snapshot con admin efímero                                                                                      | `.claude/settings.json`                                                                                       |
| M5        | Trío del papel único (P2-1); «editada a propósito» por contenido y barrido fuera del registro de precios (D-264); parte que cierra con el resto (D-265)                                            | `quotation-import.service.ts`, `imported-documents-sweep.service.ts`, `price-changes.ts`, `invoicing-math.ts` |
| M6        | Bobina atada visible en cotización y pedido; el selector dice por qué no ofrece una                                                                                                                | `coil-sale-product.ts` (`taken`), las dos vistas de detalle y los dos selectores                              |
| Sonar     | TSX del web fuera de la métrica de cobertura (D-266)                                                                                                                                               | `sonar-project.properties`                                                                                    |

## 3. Decisiones tomadas

- **D-263:** unidad del precio por lo guardado (M1).
- **D-264:** «editada a propósito» por producto + precio vigente; dos líneas del mismo producto
  cuentan juntas; cambio de producto + precio se registra; el barrido no se registra, y sus
  filas viejas se reconocen por `audit_log` (decisión del dueño en la sesión).
- **D-265:** la parte que cierra toma el resto si queda a ≤ 0.01 del recálculo.
- **D-266:** cobertura de Sonar sin los TSX del web.

## 4. Bloqueos / pendientes

- **E2E local no corrió en esta sesión:** un `nuxt dev` de otro proyecto del dueño
  (`yacco/v2/apps/web-nuxt`) escucha en `[::1]:3000` y Playwright lo reusa. No se mató. M1 sí se
  verificó local (rojo → verde) antes de que apareciera; el resto, en CI.
- **La rotación de M3 nunca corrió contra Neon** (no autorizada). Primera ejecución: el próximo
  reset de demo, con `NEON_API_KEY`.
- «Volver a por metro» y la clave de línea estable: pendientes en PROGRESO.
- Todo lo de esta sesión queda **PENDIENTE DE REVISIÓN INDEPENDIENTE**.

## 5. Cómo verificar

- Tests: `pnpm --filter @ayr/api test` (1009 + nuevos), `pnpm test:scripts` (31),
  `pnpm exec playwright test e2e/tests/plancha-importada-d263.spec.ts` y
  `--grep D-265` sobre `importe-importado-d169.spec.ts`.
- Cobertura de código nuevo medida local contra `main`: 76/81 líneas instrumentadas (93.8 %).
- Merge del segundo PR, deploy de API y `git-sha`: se completan abajo al cerrar.

## 6. Siguiente sesión

Revisión independiente de RF-S4b y de estas correcciones. Antes del próximo reset de demo:
agregar `NEON_API_KEY` y correr el reset (con OK del dueño) para estrenar la rotación.
