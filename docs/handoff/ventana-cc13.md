# Runbook: ventana de cc13 (D-378, reactivar con las líneas del pedido)

**Estado: DEPLOY HECHO el 2026-10-02 (pasos 1, 3, 4 y 5).** Pendiente: con los números del
dueño, la foto `READ ONLY` (paso 2), el respaldo (paso 6) y los pasos por la interfaz (7 y 8).

| Qué                   | Valor                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| UAT y CI              | UAT del dueño en demo confirmado (§1-§6); CI 37084224775 en `8c38bb7`: E2E 483, smoke Neon `ci` 36 |
| Revisión API anterior | `ayr-steel-erp-api-00075-9f9` (`git-sha=c7b2645`)                                                  |
| Revisión API nueva    | **`ayr-steel-erp-api-00076-nx7`**, 100 %, `git-sha=8c38bb7`, `/health` 200, smoke 7/7 web vieja    |
| Merge del #80         | `main` = **`0a7344e`**, diff de runtime vacío; Vercel `success`; smoke 8/8 en los dos dominios     |
| Desde dónde           | worktree `../ayr-cc13` en `8c38bb7` con `AYR_ENV_SETUP` (el aislamiento no deja usar el principal) |

## Cierre de la sesión cc13 (2026-10-02)

**Resumen.** D-378 está implementada en la rama `cc13/reactivar-con-lineas`, que sale de `main`
`58955b5` y es independiente de cc14. PR #80 sin merge. Sin migración y nada en producción. CI
37063416075 en verde sobre `f343be9` (ver «Pruebas»).

**Hecho**, por milestone:

- **M1 (API):**
  - `FiscalImportService.previewReactivationWithOrderLines` y `reactivateWithOrderLines`, con
    bloqueos y locks en `planReactivationWithOrderLines`;
  - los bloqueos comunes con D-373 se extrajeron a `lockAnnulledForReactivation`;
  - el cálculo puro está en `apps/api/src/invoicing/reactivate-order-lines.ts`;
  - las rutas están en `invoicing.controller.ts` y los esquemas en
    `packages/shared/src/schemas/invoicing.ts`.
- **M2 (web):** `components/invoicing/reactivate-with-order-lines-dialog.tsx` y el ítem «Reactivar
  con las líneas del pedido» en el menú de la fila de `comprobantes-view.tsx`, más la etiqueta de
  auditoría.
- **M3 (E2E):** `e2e/tests/reactivar-con-lineas-d378.spec.ts`. El selector de
  `reactivar-comprobante-d373.spec.ts` pasó a exacto.
- **M4 (docs):**
  - las filas D-378 (implementación) y D-380 (propuesta) en `docs/ARQUITECTURA.md`;
  - el caso 5 en `docs/manual/corregir-comprobante-manual.md` §7 (las secciones siguientes se
    renumeraron a §8-§11);
  - `docs/uat/cc13.md`, este runbook y `docs/PROGRESO.md`.
- **M5:** QA, revisiones, push y PR. Ningún milestone se sacrificó.

**Decisiones:**

- D-378, decisiones 1-4, aprobadas por el dueño en el arranque.
- D-380 queda registrada como propuesta.
- Tres comportamientos que se sumaron al implementar y conviene que el dueño confirme en su
  revisión:
  - un pedido que no cambió se rechaza y remite a «Reactivar»;
  - no se cruza el tope de boleta a «público en general» (D-077);
  - si la línea del pedido cambió de producto, la fila toma el producto nuevo.

**Pruebas:**

- Unitarios: API 2150 y web 87, todos en verde. De ellos, 33 son de D-378 (22 del servicio y 11 del
  plan puro, incluidos los bloqueos) y 31 de D-373, sin cambios.
- Lint y typecheck en verde.
- E2E local: D-378 (2) y D-373 (3), 5/5.
- CI 37063416075, todo en verde:
  - lint, typecheck y unitarios;
  - Sonar;
  - E2E completo con build de producción: **481 passed, 0 failed, 3 skipped**;
  - smoke de Neon `ci`: 36 passed y 2 skipped;
  - Vercel preview.
  - La corrida anterior (37060365261) se canceló por el push del número del PR, no por un rojo.

**Revisiones:**

- `docs/revision/cc13-autorrevision.md`: 0 P0, 0 P1, 5 P2 y 5 P3.
- `docs/revision/cc13-segundo-modelo.md`: 0 P0, 1 P1, 3 P2 y 4 P3.
- Cada informe tiene su tabla de resolución. El P1 está corregido.

**Pendientes:**

1. Revisión del dueño, que es la única que cierra la revisión.
2. La lista de comprobantes. Con ella, la foto `READ ONLY` del paso 2.
3. Decidir si «Reactivar con las líneas del pedido» va también en el detalle del comprobante (P3-5
   del segundo modelo).
4. El bloqueo «líneas que ya no están en el pedido» es una guarda defensiva: hoy una línea de pedido
   no se quita (H7).

**Cómo verificar:**

- `pnpm --filter @ayr/api exec jest src/invoicing`.
- `E2E_API_PORT=3010 pnpm exec playwright test e2e/tests/reactivar-con-lineas-d378.spec.ts e2e/tests/reactivar-comprobante-d373.spec.ts`.
- Guion manual en `docs/uat/cc13.md`.

**Siguiente sesión:** con la lista del dueño, la foto `READ ONLY` del paso 2. Después, la ventana
desde el paso 0.

Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232). El agente propone el
comando exacto y espera.

- PR: #80 (rama `cc13/reactivar-con-lineas`).
- **No hay migración** y el deploy no escribe datos. Los datos que se tocan son los del paso 7,
  que el dueño hace **por la interfaz** con los servicios de dominio.
- **Orden (decidido por el dueño el 2026-10-02):** UAT en demo → CI → resumen de D-232 y OK →
  API → smoke → merge (web) → smoke. **Después**, cuando el dueño pase los números: foto
  `READ ONLY` (paso 2) → respaldo (paso 6) → pasos por la interfaz → foto posterior. cc14 va
  después de cc13, con su propio OK.
- **La API nueva convive con la web vieja:** agrega tres rutas
  (`GET /invoicing/documents/:id/reactivate-with-order-lines/preview`,
  `POST /invoicing/documents/:id/reactivate-with-order-lines` y
  `GET /invoicing/orders/:id/annulled-documents`, de solo lectura y sin bloqueos) que la web vieja
  no llama, y el detalle del pedido suma el campo `annulledDocumentCount`, que la web vieja ignora. La
  reactivación simple de D-373 no cambia de comportamiento (sus bloqueos se extrajeron a una
  función común; los 31 unitarios y los 3 E2E de D-373 siguen en verde).
- Nubefact no se toca desde el ERP. **El papel de cada comprobante tiene que estar ya corregido en
  Nubefact** antes del paso 7.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc13 rebase origin/main
git -C ../ayr-cc13 push --force-with-lease
gh pr checks 80 --watch
```

Si `main` avanzó (por ejemplo con cc14), los conflictos esperables son de docs: filas de
`docs/ARQUITECTURA.md` §0.2 y `docs/PROGRESO.md`.

## 1. Antes de empezar [agente]

```sh
gh pr checks 80
git rev-parse origin/cc13/reactivar-con-lineas     # = <SHA>
git diff --name-only origin/main origin/cc13/reactivar-con-lineas -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

La revisión vigente antes del deploy es la vuelta atrás. Se anota acá al empezar.

## 2. Foto `READ ONLY` de los comprobantes [OK, antes de la ventana]

**Pendiente de la lista del dueño.** Con los números, el agente toma una foto de producción en una
transacción `READ ONLY` (OK del dueño por la conexión, D-251). El JSON queda en
`local-data/cc13/` (fuera de git, trae datos reales); acá se anota solo el resumen.

Por cada comprobante:

| Qué se mira                                      | Para qué                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| tipo, origen, estado, pedido, cliente            | D-378 solo alcanza a facturas y boletas **manuales** de un pedido         |
| líneas del comprobante y del pedido              | qué falta en el pedido, y si ya se agregó                                 |
| total del comprobante y total del pedido         | el total con las líneas del pedido tiene que ser el del papel vigente     |
| cobros vigentes y notas de crédito               | con cobros, el paso 7 empieza revirtiéndolos (D-380 no está implementada) |
| detracción                                       | con detracción no se reactiva así                                         |
| otros comprobantes vivos y borradores del pedido | bloquean; hay que decidir antes cuál queda                                |
| despachos de las líneas                          | las originales conservan su despacho; las agregadas quedan pendientes     |
| ¿cliente del pedido = cliente del comprobante?   | si cambió, no se reactiva con las líneas                                  |

Resultado: **(a completar)**.

## 3. Resumen de D-232 y OK del dueño [OK]

Commits, CI de la última corrida, qué se despliega (API y web, sin migración) y riesgo.

## 4. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el `git-sha`, la revisión al 100 % y que `/health` responda 200. Después,
`pnpm smoke:prod` desde un worktree en `<SHA>`.

## 5. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 80 --merge
```

Comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en `success`.
Correr `smoke:prod` contra `vercel.app` y contra `--base-url https://v2.mareliac.pe`.

## 6. Respaldo antes de tocar datos [OK, decisión del dueño]

El deploy no escribe datos, pero el paso 7 **reescribe las líneas** de comprobantes reales. La
historia queda en la auditoría (el antes completo), pero volver atrás no es automático (ver
«Vuelta atrás»). Recomendación: un respaldo Neon `respaldo-pre-cc13-<fecha>` con el
procedimiento de cc08, justo antes del paso 7.

## 7. Por cada comprobante, por la interfaz [dueño, administrador]

Es el caso 5 del manual (`docs/manual/corregir-comprobante-manual.md` §7).

1. **Cobros.** Si la foto mostró cobros vigentes, revertirlos (menú del cobro → «Revertir», con
   motivo). Anotar fecha, importe y medio de cada uno para el punto 8.
2. **Anular internamente** el comprobante (menú **⋯ → Anular internamente**, con motivo), si no
   lo está ya.
3. **Corregir el pedido** para que diga lo mismo que el papel vigente: «Agregar ítems» con lo que
   faltó y, si hace falta, precio o cantidad de una línea (la cantidad de una línea despachada no
   se cambia: se agrega un ítem con la diferencia).
4. **Comprobantes → Anulados → ⋯ → «Reactivar con las líneas del pedido».** Leer el antes y el
   después. Si sale un bloqueo, resolverlo y volver a abrir.
5. Escribir el **total del papel vigente** (del PDF de Nubefact, con céntimos). Si no coincide, el
   diálogo muestra los dos y la diferencia: **no forzar**, revisar el pedido o el papel.
6. Motivo, casilla «Confirmo que el comprobante, con estas líneas, coincide con el papel vigente»
   y **«Reactivar con estas líneas»**.
7. **Despachar las líneas agregadas** desde la tarjeta del detalle (D-364), con la fecha que
   corresponda. Las originales ya despachadas no se tocan.
8. Si hubo cobros revertidos, **volver a registrarlos** con su fecha original (administrador).

## 8. Verificación [agente, foto `READ ONLY` con OK del dueño]

Por cada comprobante:

- estado `ACCEPTED`, mismo `number`, `correlative`, `issue_date` y `customer_id` que en la foto
  del paso 2;
- sus líneas son las del pedido entero; las originales conservan su id;
- `total_pen` = total del papel; saldo = total menos cobros vigentes;
- hay un evento `invoicing.document.reactivate-with-order-lines` con el antes y el después;
- el kardex solo tiene las salidas de los despachos del punto 7; las líneas originales siguen con su
  despacho.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión anotada en el paso 1. Con la web
  publicada, abrir un PR de revert, mergearlo y después desplegar la API.
- **Datos del paso 7:**
  - El comprobante se puede **anular internamente** otra vez (si no tiene cobros).
  - Volver a las líneas viejas **no es automático**: la auditoría guarda el antes completo, pero
    hoy una línea de pedido no se quita (H7), así que una nueva reactivación con las líneas del
    pedido seguiría incluyendo la agregada. Si hiciera falta deshacer el contenido, se decide con
    el dueño a partir del respaldo del paso 6.
  - El despacho de las líneas agregadas se revierte desde su detalle (DES-…), con motivo.
