---
name: ayr-qa
description: Ejecuta el pase de calidad de AYR Steel ERP, añade o ajusta Playwright cuando corresponde y clasifica cada fallo como producto, prueba o infraestructura. Usar al verificar milestones o cerrar una sesión.
---

# QA AYR

El rol QA puede escribir **solo bajo `e2e/`**. Puede leer todo el repo y ejecutar verificaciones,
pero nunca parchea código de aplicación, configuración, migraciones ni docs.

1. Lee `AGENTS.md`, `playwright.config.ts`, `e2e/README.md` si existe y los RF/decisiones del
   alcance. Inspecciona el diff para decidir qué casos necesitan cobertura.
2. Para tests nuevos:
   - usa `getByRole`, `getByLabel` y texto visible en español, nunca clases CSS;
   - crea datos propios mediante `e2e/helpers/api.ts` y no depende del orden;
   - toma credenciales únicamente de variables de entorno;
   - nunca ejecuta ni escribe una suite contra producción (D-126).
3. Corre desde la raíz y desde el worktree de la sesión:
   - `pnpm lint`;
   - `pnpm typecheck`;
   - `pnpm test`;
   - la suite E2E completa cuando el alcance o el cierre la exige.
4. La suite completa usa builds de producción (`next build`/`next start` y
   `nest build`/`node dist/main.js`, `CI=true`), siguiendo `docs/ENTORNOS.md` y el patrón de
   `scripts/e2e-latency.mjs`. No usar builds dev: esta máquina cae por OOM cerca del test 308.
5. Para un spec aislado usa
   `pnpm exec playwright test e2e/tests/<archivo>.spec.ts`; no uses
   `pnpm e2e -- <archivo>` porque el filtro posicional se ignora.
6. Ante un fallo, lee trace/screenshot/log antes de cambiar el test. Clasifica cada rojo como:
   - **producto**: defecto reproducible de la aplicación; reporta pasos y archivo probable, no
     lo parches;
   - **prueba**: expectativa, fixture o selector defectuoso bajo `e2e/`;
   - **infraestructura**: proceso, red, R2/PSE, lock de Windows, OOM o entorno.
7. Reporta comandos exactos, duración cuando esté medida y conteos
   `passed/failed/skipped/flaky`. Nunca declares verde sin la corrida correspondiente.

Fuentes portadas: `.claude/agents/qa.md`, `CLAUDE.md` («Suite completa en esta máquina»),
`docs/ENTORNOS.md`.
