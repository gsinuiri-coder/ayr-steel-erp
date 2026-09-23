# Handoff — RF-S4b: SKU canónico de bobina, pool de venta y el importe que manda (2026-09-23)

Agente: Claude Code. Rama `rf-s4b` desde `origin/main` `f60ab6c`. **Con migración aditiva.**
Nada tocó producción: la normalización, el barrido y las lecturas de prod quedan para la ventana,
con OK del dueño comando por comando (D-251).

## Qué quedó

|                 |                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| Decisiones      | D-252 (SKU canónico), D-253 (unión), D-254 (R1, pool), D-255 (R2, importe), D-256 (D-163), D-257 |
| Migración       | `20260923180000_rf_s4b_products_merged_into` — columna nullable, índice, FK RESTRICT y un CHECK  |
| Herramientas    | `pnpm normalize:coil-skus`, `pnpm sweep:imported --file …` (dry-run por defecto las dos)         |
| Rutas nuevas    | `PATCH /sales/orders/:id/items/:itemId/coil`, `GET /sales/coil-pool`                             |
| Rutas cambiadas | `PATCH …/items/:itemId/price` acepta precio con IGV o importe de línea; el alta y la edición de  |
|                 | cotizaciones y pedidos aceptan `unitPriceWithIgvPen` y `netAmountPen` (ya no solo el importador) |
| Web             | importador con selector de bobina e importe editable; formulario manda precio con IGV o importe; |
|                 | diálogos de pedido con modo de precio y «Cambiar bobina»                                         |
| Guion UAT       | `docs/uat/rf-s4b.md`                                                                             |
| Autorrevisión   | `docs/revision/rf-s4b-autorrevision.md` — **no** vale como pase cruzado                          |

## Lo que el siguiente tiene que saber antes de tocar esto

1. **Una bobina no le pertenece a un producto.** El saldo vive en el kardex de la bobina y el
   `BOB…` de reventa se **deduce** de ella (espesor + color comercial o tipo). Todo lo que
   responde «qué producto vende esta bobina» pasa por `apps/api/src/sales/coil-sale-product.ts`.
   Si alguien vuelve a armar el SKU en otro lado, reabre D-168.
2. **Los cuatro decimales de `unit_price_pen` son de adorno.** El dato es el importe de la
   línea. Toda cuenta nueva que necesite el unitario usa `derivedUnitValue(qty, subtotal)`
   (diez decimales). Multiplicar el guardado por la cantidad es exactamente el defecto de
   FFA1-1355 (3.0508 × 3840 ≠ 11 715.254).
3. **Una línea del papel vende la cantidad del papel** sobre una bobina con saldo suficiente; el
   alta a mano sigue vendiendo el rollo entero (D-116). Lo decide `exactAmounts` (documento
   importado), no el formulario.
4. **Transición de SKU.** Hasta que corra la normalización en producción, la resolución acepta
   el canónico y el viejo. Después del execute, el viejo ya no existe en productos activos y la
   rama de respaldo solo sirve para lo heredado raro.
5. **El choque de base** solo se mira entre **prepintados** del mismo color comercial, por
   densidad. La línea de negocio no cuenta a propósito (`finishForCoil`).
6. **E2E y CLI.** Los specs de normalización y barrido corren la CLI real contra `local-e2e`;
   después de la CLI se abre un contexto HTTP nuevo, porque el viejo quedó ocioso ~2 min y su
   socket keep-alive moría con ECONNRESET (tres corridas seguidas, diagnóstico en el spec).

## Plan de la ventana (antes del viernes a la noche)

Cada paso con comando a la vista y OK del dueño (D-251). Orden de AGENTS.md §3 regla 11.

1. **[Dueño] Respaldo Neon** de `production`: rama `respaldo-pre-rf-s4b-AAAAMMDD` (patrón de
   `docs/ENTORNOS.md`, vía `scripts/lib.mjs#run` con `quiet: true` y `--output json`).
2. **[Agente] PR + CI verde** (la rama `rf-s4b` todavía no está en el remoto: el push lo rechazó
   el clasificador de permisos en esta sesión; lo hace el dueño o lo aprueba).
3. **[Agente, con OK] Migración:** `node scripts/migrations-status.mjs --branch production`
   (tiene que listar solo `20260923180000_rf_s4b_products_merged_into`), `migrate diff` contra
   el drift conocido, y `pnpm db:prod`.
4. **[Agente, con OK] Deploy API** desde el worktree en el SHA a desplegar:
   `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   con `--update-labels git-sha=<sha>`; verificar `/health` y el label. La API nueva es
   compatible con el web viejo (el formulario viejo sigue mandando `unitPricePen`; una fila de
   bobina del importador viejo queda bloqueada en el preview, que es lo correcto).
5. **[Agente] Dry-runs contra production, solo lectura, con OK:**
   - `pnpm normalize:coil-skus --branch production` → el dueño ve renombres, uniones, no
     interpretables, documentos abiertos, kilos antes/después y paradas.
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production` →
     listas (a), (b) y (c).
   - **Anotar los totales** de Inventario valorizado y Ventas y margen (agosto) antes del execute.
6. **[Agente, con OK explícito por cada uno] Execute:**
   - `pnpm normalize:coil-skus --branch production --execute --confirm-production` (más
     `--ack-open-documents` solo si el dueño aprobó la lista de abiertos).
   - `pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx --branch production
--execute --confirm-production`.
   - Comprobar que los totales de los dos reportes son los anotados en el paso 5.
7. **[Dueño] Merge a `main`** (D-232, `AYR_OWNER_PUSH=1`) → Vercel publica el web.
8. **[Agente] `pnpm smoke:prod`** desde un worktree en el SHA desplegado.
9. **[Dueño] COT-000002**: confirmarla; tiene que reservar SALDO-ALZ-AZUL-5002-0.38-4194-7 y
   cuadrar 14 679.00. Y el pedido de FFA1-1355, si sigue abierto, facturable con el importe del
   papel.

**Rollback.** La migración es aditiva: volver la API al SHA anterior no necesita revertirla. La
normalización se deshace desde la auditoría (`catalog.product-rename-sku`,
`catalog.product-merge`) o restaurando la rama de respaldo si hiciera falta.

## Verificación

- Unitarios: API 929/929, web 11/11. `pnpm lint`, `pnpm typecheck`, `prettier --check` verdes.
- **SonarCloud:** el gate falló en el primer push (12.6 % de cobertura en código nuevo, exige
  ≥ 80 %). Se cubrió con unitarios: 97.9 % en la API. Reconfirmar en la CI del segundo push.
- E2E completo con builds de producción: 331/36/2/20 en la primera corrida; todo rojo
  clasificado (infraestructura del runner local salvo dos, corregidos). Re-corrida de los rojos y
  del tramo sin correr: 80/2/1, los dos explicados. Detalle en `docs/PROGRESO.md`.
- **Falta la CI del PR** (R2 y PSE reales): la rama no está en el remoto.

## Lo que queda pendiente

- **Pase cruzado independiente** (AGENTS.md §2.2) — registrado en `PROGRESO.md`.
- Pendientes del dueño sin implementar: bobina 3020 en OP ROJO (D-252); pool real de kg con
  despacho multi-bobina (D-254).
- M3: el render de la vista de margen — **requiere decidir D-011** (el dueño pidió no agregar
  jsdom ni testing-library).
- Autorrevisión: pendientes P2 listados en `docs/revision/rf-s4b-autorrevision.md`.
- E2E nuevos para la UI del selector de bobina del importador, el importe editable, el modo de
  precio del pedido y «Cambiar bobina»: la cobertura de hoy es por API.
- Limpiar el worktree del subagente web (`.claude/worktrees/agent-…`) y su rama local al cerrar.

## Secuencia de commits

`0338d47` test M0 → `a4abe3c` feat R1/R2 base → `1411c11` feat unión, normalización y barrido →
`ab9eae7`/`987c0e2`/`e9cafe4` web → `cedcdff` test E2E → `f0f6d58` merge web → `1268c39` estilo
→ `5084f80` M3 → docs.
