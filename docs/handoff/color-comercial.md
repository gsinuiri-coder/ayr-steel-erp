# Handoff — Color comercial en producción (2026-09-24)

## 1. Resumen

- **Sesión:** color comercial en producción y reservas. Rama `feat/color-comercial`, PR #18.
  Worktree `../ayr-steel-erp-color`.
- **Entrega:** D-270 a D-274, **sin migración**.
  - El dry-run de production mostró que el maestro de colores **ya es** el color comercial.
  - Se descartó el diseño grande y se implementó lo que el dueño eligió.
- **Estado:**
  - Rama empujada y CI de la PR #18 en curso (ver §5).
  - **Nada desplegado ni mergeado.** El deploy es esta noche, con
    `docs/handoff/ventana-color-comercial.md`.
- **Revisión:** autorrevisión sin P0/P1 de código (`docs/revision/color-comercial-autorrevision.md`),
  **PENDIENTE DE REVISIÓN INDEPENDIENTE**.

## 2. Hecho

- **Housekeeping.**
  - Se borró la rama remota `fix/post-s4b`, verificada como ancestro de `main`.
  - `scripts/apply-ask-rules.mjs` aplica las reglas `ask` de P2-E y de los comandos nuevos.
    Idempotente, dry-run sin `--write`.
- **M0, dry-run** (`pnpm check:color-comercial`).
  - Archivos: `apps/api/prisma/color-comercial-dry-run.ts` y
    `apps/api/src/catalog/commercial-color-plan.ts`, con 9 tests.
  - Corre en una transacción `READ ONLY`. Contra production exige `--confirm-production`.
  - Se corrió contra production con autorización del dueño. Los resultados están en el diseño,
    §9.1.
- **D-271, planta.**
  - `preferExactFinish` en `production/roofing-coil-match.ts`.
  - `coilOptions` devuelve `finishName`, `ral` y `exactFinish`.
  - `finishRal` en `@ayr/shared`.
  - Web: columna «Acabado (RAL)» en `planta/coil-picker.tsx`.
  - Hoja de planta: `sales/plant-measures.ts`.
  - Texto de `bobinas/[id]/coil-edit-dialog.tsx`.
- **D-272, valorizado.**
  - `reports/inventory-valuation.service.ts` agrega `finishKind` y `finishes` al grupo, y
    `finishCode` y `ral` a cada bobina.
  - `coilGroupLabel` en shared.
  - Excel con las columnas Acabado y RAL.
  - La vista web muestra el detalle.
- **D-273, candado.**
  - `commercialColorIssue` en `packages/shared/src/schemas/color.ts`, aplicado al código y al
    nombre. `ralCode` solo admite vacío.
  - El formulario web usa la misma función, sin campo RAL, y aplica el candado solo a lo que se
    escribe.
- **D-274, retiro.**
  - `colors/color-retirement.ts`, con `ColorsService.planRetirement` y `ColorsService.retire`.
  - CLI `apps/api/prisma/retire-unused-color-cli.ts` y wrapper `pnpm retire:unused-color`.
- **Tests:**
  - Unitarios nuevos: `color-lock`, `roofing-coil-match`, `plant-measures`, `color-retirement`,
    el grupo D-272 de `inventory-valuation` y las columnas de `reports-xlsx`. Todos se vieron
    fallar antes de implementar.
  - E2E nuevo: `e2e/tests/color-comercial-d270.spec.ts`.
- **Docs:**
  - D-270..D-274 en `ARQUITECTURA.md` §0.2.
  - Diseño actualizado, §9 y estado.
  - `PROGRESO.md`, runbook, UAT y la revisión.

**Commits (sobre `origin/main` = `feddfa9`):**

- `df9dcc4`: el diseño.
- `678f936`: script de las reglas `ask`.
- `c016029`: dry-run.
- `341277c`: D-273.
- `f125be0`: D-271.
- `0f616f2`: D-272.
- `210517f`: D-274.
- `e1556ed`: docs D-270.
- `26a5f01`: P2 de la autorrevisión.
- Después: el commit de cierre de docs.

## 3. Decisiones tomadas

- **D-270.** `colors` es el color comercial y el RAL vive en el acabado.
  - Sin migración. Se descarta el diseño grande.
  - Las 9 respuestas del dueño quedan registradas con su sentido nuevo.
- **D-271.** Planta ofrece primero las bobinas del acabado exacto y muestra el RAL de cada una.
  Todas siguen montables.
- **D-272.** El valorizado agrupa por color comercial, con el acabado/RAL como detalle.
  - Sin color, agrupa por tipo.
  - Los totales no cambian.
- **D-273.** Candado del maestro de colores: ni RAL ni nombre de tipo.
- **D-274.** Retiro del color NATURAL y sus 2 specs sobrantes.
  - Por dominio, con dry-run.
  - Se niega si existe una sola referencia.

## 4. Bloqueos / pendientes

- **Deploy (dueño + agente, esta noche):** `docs/handoff/ventana-color-comercial.md`.
  - **Orden obligatorio: API, después merge (web).** Con la web nueva y la API vieja, el
    valorizado se cae.
  - Por eso el merge a `main` **no** se hizo en esta sesión, aunque el pedido lo incluía: un
    push a `main` publica la web antes que la API. Queda como paso 3 del runbook, con el
    resumen D-232.
- **Rama remota `docs/diseno-color-comercial`:** no se borró todavía. Su contenido llega a
  `main` recién con el merge. Es el paso 6 del runbook.
- **Reglas `ask`:** el dueño corre
  `! node ../ayr-steel-erp-color/scripts/apply-ask-rules.mjs --write` desde el checkout
  principal.
- **E2E local:** 2 rojos clasificados como infraestructura/tiempo; detalle en `PROGRESO.md`.
  La suite completa corre en CI.
- **`finishRal`:** heurístico de presentación (cuatro dígitos al final). Anotado.

## 5. Cómo verificar

```sh
gh pr checks 18                                         # CI completa verde, Sonar incluido
git diff --name-only origin/main origin/feat/color-comercial -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cd apps/api && npx jest                                  # 1073/1073
node scripts/color-comercial-dry-run.mjs --branch local-e2e      # corre, sin paradas
node scripts/retire-unused-color.mjs --code NATURAL --branch local-e2e   # dry-run: «No existe el color NATURAL»
pnpm exec playwright test e2e/tests/color-comercial-d270.spec.ts
```

Después del deploy: el UAT de `docs/uat/color-comercial.md`.

## 6. Siguiente sesión

Correr con el dueño el runbook `docs/handoff/ventana-color-comercial.md`, paso por paso y con
el OK de cada paso marcado. Nada más.
