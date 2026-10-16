# Ventana cc55 — hallazgos de audit-01: permisos y costos, un solo costo de coberturas y correcciones de datos

2026-10-16, Lima. Dos PR de código, cada uno con su despliegue, y este cierre de docs. Decisiones D-664..D-667
(D-667 es decisión del dueño; las cuatro **ratificadas por el dueño el 2026-10-16**). **Sin migraciones ni escrituras masivas.** Sin SQL contra producción. Sin
ramas nuevas de Neon (sigue en 9 de 10). El corte C (datos) se detuvo en un PARA y no se ejecutó.

## En producción

- **Corte A (PR #213, merge `5ae7fb30`):**
  - API `ayr-steel-erp-api-00131-2n4` (`git-sha=a51c0100`), desplegada antes del merge;
  - `smoke:prod --expect-sha 5ae7fb30 --expect-api-sha a51c0100` en verde en los dos dominios.
- **Corte B (PR #214, merge `6b348861`):**
  - API `00132-rdj` (`git-sha=4a9afb3b`), desplegada antes del merge;
  - `smoke:prod --expect-sha 6b348861 --expect-api-sha 4a9afb3b` en verde.
- **Revisión final (nota de cc56):** después del merge de la CLI de solo lectura (PR #215) se volvió a desplegar la API desde `main` para alinear el sha: la revisión final de cc55 fue `ayr-steel-erp-api-00133-tfm` (`git-sha=fe0ca043`), no `00132-rdj`.
- **Vuelta atrás:**
  - Comando: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` y revert del merge.
    La revisión anterior es `00131-2n4` para el corte B y `00130-62b` para el A.
  - Sin cambios de schema.
  - Un cierre de OP hecho con la API de cc55 que recosteó entradas (D-665) deja sus `ADJUST`: la API anterior los lee
    como recosteos por fecha (D-649).
- `--web-origin`: `https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app` (leído del servicio vigente; el valor
  de los runbooks viejos quedó corto).

## Qué entró

- **D-664 (corte A):**
  - `price-floor.ts` `assertPriceFloor(…, { showCost })`: opaco por defecto, y `showCost` solo para ADMINISTRADOR en
    todos los llamadores;
  - `invoicing.service.ts` `previewCreditNote`: `costPen` en `null` para otros roles (esquema `nullable`, la web no lo
    pinta);
  - `pricing.controller.ts` solo ADMINISTRADOR;
  - `refreshStatus` con `assertOwnership`;
  - `fiscal-import.service.ts`:
    - `annulExternal` bloquea, relee y suelta el enlace D-205 (salvo el reemplazo de un 02) y audita los ids;
    - `relinkUnlinkedDispatches` al reactivar;
  - `sales-returns.service.ts` `liveInvoiceId`: un enlace a un comprobante no vivo ni en borrador no declara.
- **D-665 (corte A):**
  - `InventoryService.recostEntries` (`recostForward` con `overrides` y `note`);
  - `inventory-recost.ts`: semilla `atMovementId` e `initialOverrides`;
  - `production/close-recost.ts`: `applyCloseAdjustment`, `recostCloseIntoEntries` y `assertNoCloseRecost`, usados por
    los dos cierres y las dos reaperturas.
- **D-666 (corte A):** `POST /pos/sales` con `idempotencyKey` (scope `pos-sale`); la web la manda por contenido del
  carrito.
- **D-667 (corte B):**
  - `sales-margin.service.ts`: `withEngineCosts`, `declaredDocuments` y `costsByOrder` por línea de pedido;
  - `SalesByMaterialService.engineLinesOf`;
  - `document-profitability.ts`: `engineLineCosts`.
- **Corte C (rama `cc55-c-datos`):** `pnpm inspect:cc55`, de solo lectura (re-fecha simulada con el motor de D-652 y la
  auditoría de la bobina).

## Verificación

- Unitarias de API y web en verde, con specs nuevos para cada pieza. SonarCloud en verde en los dos PR (cobertura de
  código nuevo ≥ 80 %).
- db-spec en base propia (`ayr_local_e2e_cc55db`):
  - suite completa 200/202; los dos rojos (`lock-order` (d) y `roofing-drafts-accessory`) pasan solos con la base
    reseteada: datos acumulados y tiempos, no de producto;
  - los tocados, en verde: `credit-note-reasons`, `pos-floor`, `recost`, `order-qty-change`, `at-cost`,
    `sales-returns`, `cost-basis-cc55`, `report-xlsx-totals` y `dashboards`.
- CI completa en verde en los dos PR (E2E en dos shards, Neon ci, escenarios, drift).
- Medido en producción (solo lectura, `local-data/cc55/cc55b-before-after*.json`):

  | Mes        | Costo antes | Costo después |
  | ---------- | ----------- | ------------- |
  | Agosto     | 505 893,63  | 506 516,70    |
  | Septiembre | 581 396,75  | 580 773,90    |

  Los 109 comprobantes coinciden con su Rentabilidad.

## Revisiones

- **Corte A:** autorrevisión y segundo modelo (`docs/revision/cc55-a-*.md`). Sin P0 ni P1.
  - Corregidos:
    - R-1: el borrador cuenta como enlace;
    - R-2/A-01: reactivar repone el enlace;
    - R-3: relectura bajo lock;
    - A-03: el caso de cierre después de despachar.
  - Ese caso mostró que la primera versión de E-01 (imputar por fecha) no cubría parte y despacho del mismo día. Se
    rehízo con `recostEntries`.
  - A-02 (la reapertura se rechaza) queda en D-665.
  - Anotados: R-4 (la clave no compara cuerpo ni usuario) y R-5 (tope de 500 y aviso del cierre).
- **Corte B:** autorrevisión y segundo modelo (`docs/revision/cc55-b-*.md`).
  - Corregidos los P1: H1 (un comprobante mixto no declara por el motor) y H2 (`PARTIAL` al promedio).
  - Anotados: H4 (despacho contra otra línea de pedido), H5 (PARCIAL de una línea del motor sin despachar), H6
    (latencia) y H7.
- Revisión del dueño: UAT en `docs/uat/cc55.md`, **aprobado por el dueño el 2026-10-16**.

## Pendiente / para la siguiente sesión

- **El dueño:**
  - ~~UAT de cc55; ratificar D-664 a D-667~~ — **hecho el 2026-10-16** (UAT aprobado y D-664..D-667 ratificadas);
  - decidir C1 y C2.
- **C1 · re-fecha D-278 (PARA):**
  - el dry-run da 34 despachos de 33 comprobantes y 17/17 ítems negativos en alguna fecha;
  - el producto se fabricó después de facturar; mover la salida a la fecha del comprobante viola D-652/D-662;
  - salidas posibles: dejarlo como está (D-278 lo decidió así) o informar el «facturado no despachado» al cierre de
    mes.
- **C2 · bobina 4150-23 (PARA):**
  - el costo bajo está en la bobina (`coils.update` del 25/09, «vender a menos costo» y «menos costo», cuenta del
    dueño), no en la compra; la línea 22 ya dice 2,87;
  - «Editar compra» no lo corrige (no hay cambio en la línea y la bobina está vendida, D-372);
  - la corrección posible es `recostEntries` sobre la entrada viva de la bobina (movimiento 468, 11 179,27 →
    11 910,50): +S/ 731,23 a la venta FFA1-00001448 (octubre);
  - necesita su OK por nombre para ese mecanismo, con dry-run y respaldo.
- **cc56 (decisión del dueño):** cobranzas en la app con importador de saldos iniciales.
- **Anotado:** R-4, R-5, H4 a H7; la nota del drywall al cerrar con recosteo sigue diciendo `costAdjusted: false`.
- **Fuera del repo:** quedó una carpeta `C:/Users/User/Documents/workspace/local-data/cc54` de una sesión anterior (no
  es de cc55, no se tocó).
