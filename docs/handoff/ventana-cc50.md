# Ventana cc50 — Auditoría que faltaba en el «Historial», y menores de cc49

2026-10-12/13, Lima (noche). Dos cortes, cada uno con su PR y merge de a uno, más el cierre de docs. Sin
migraciones ni SQL contra producción. Decisión D-638, provisional. El dueño ratificó D-627 a D-632,
D-634, D-635, D-636 y D-637 (D-632 como «no se aplica»).

## En producción

- **Corte A (PR #193, merge `5985df62`):** API `ayr-steel-erp-api-00121-jql` (`git-sha=700092ba`),
  desplegada antes del merge, y web de `5985df62`.
- **Corte B (PR #194, merge `bd1d545d`):** solo web. La API sigue en `00121-jql`.
- `smoke:prod` en verde en los dos dominios tras cada corte, con `--expect-api-sha 700092ba`. La web
  publicó el sha del merge en el intento 10 (A) y 6 (B). Salidas en `local-data/cc50/smoke-*.log`.
- **Vuelta atrás:**
  - Corte B: revert del merge.
  - Corte A: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00120-clh=100`
    y revert del merge; después, el smoke con `--expect-api-sha 9cf2a91b`.

## Qué entró

### Corte A — D-638

Cada registro con `AuditService.write(tx, …)` dentro de la transacción de la operación, armado por
funciones puras en `apps/api/src/audit/document-audit-entries.ts`.

| Acción                           | Dónde (en `apps/api/src`)                                                | «Historial» donde aparece                                            | Acción de auditoría                              |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------ |
| Pago y reversa                   | `purchases/purchases.service.ts` `addPayment`, `reversePayment`          | la compra                                                            | `purchases.payment`, `purchases.payment-reverse` |
| Costo de importación             | `purchases.service.ts` `applyLandedCost`                                 | compra de bobinas (la del servicio, en su recepción)                 | `purchases.landed-cost`                          |
| Su reversa al anular el servicio | `purchases.service.ts` `cancel`                                          | compra de bobinas                                                    | `purchases.landed-cost-reverse`                  |
| Factura del corte (vincular)     | `purchases.service.ts` `createInTx`                                      | orden de corte                                                       | `cutting.invoice-linked`                         |
| Lote confirmar / deshacer        | `imports/purchase-import.service.ts` `confirm`, `undo`                   | tipo `purchase_import_batches` (+ el lote en la alta de cada compra) | `imports.purchases`, `imports.purchases.undo`    |
| Anular el pedido                 | `sales/sales-orders.service.ts` `cancel`                                 | pedido (ya estaba) + cada OP anulada                                 | `production.cancel-by-sales-order`               |
| Cambiar cantidad                 | `sales/sales-order-edits.service.ts` `resizeUnstartedInTx`, `followPlan` | pedido (ya estaba) + la OP cuyo plan cambia                          | `production.plan-by-sales-order`                 |

- Tipo nuevo en `AUDIT_ENTITY_TYPES` y su resolver (`audit-entity-refs.ts`, código «Lote xxxxxxxx» sin
  consulta); rótulos de las acciones y de las claves del detalle en `packages/shared/src/audit-labels.ts`.
- **Excepción a «misma transacción»:** el resumen del deshacer del lote (el deshacer es parcial; cada
  anulación audita la suya).
- `seed:escenarios`: caso **H1** (pago y reversa, flete imputado, factura del corte, lote importado);
  `voidPrevious` anula primero los servicios. `seed:escenarios:test` cuenta 15 compras.
- `apps/api/prisma/inspect-cc33-cli.ts` lee los pagos nuevos (`after.paymentId`).

### Corte B — menores de cc49

- `scripts/smoke-version.mjs` / `smoke-prod.mjs`: «la web aún no publica /version; reintentando…»
  mientras `/version` responde HTML; la espera y el tope no cambian.
- `e2e/tests/historial-cc49.spec.ts`: SUPERVISOR_PLANTA no ve «Historial» en compra, corte y OP.
- `apps/web/src/components/audit-history-link.tsx`: altura de «Más opciones» (32 px); los diálogos de
  catálogo piden `size="sm"`.

## Verificación

- Lint (con hooks), typecheck, Prettier; unitarias API 3163 (2 omitidas), web 335, `test:scripts` 106.
- db-spec (`purchase-audit.db-spec.ts` nuevo, `order-qty-change.db-spec.ts`): 25 de 25 en base propia,
  con el registro forzado a fallar después de los demás en cada acción.
- E2E sueltos en base propia en verde; `cambiar-cantidad-cc45` necesitó `--timeout=180000` con
  `next dev` en frío (infraestructura). Suite completa: CI verde en los dos PR (2 shards, Neon ci,
  escenarios, Sonar 87,5 % de cobertura nueva).
- Recorrido en `ayr_local` con `seed:escenarios` y API/web propias (3000/3001; 4000/4001 del dueño sin
  tocar): capturas de las 6 acciones en su «Historial» y de la alineación, en
  `local-data/cc50/capturas/`.

## Revisiones

- Corte A: sin P0/P1. P2 corregidos: reversa del costo de importación (autorrevisión) y pruebas de
  rollback reales (los dos pases). Sonar pedía cobertura de unitarios: funciones puras + specs.
- Corte B: sin P0/P1. P2 corregido: una aserción del test del smoke había quedado como comentario; y
  «reintentando…» solo donde se reintenta.
- Informes en `docs/revision/cc50-{a,b}-*.md`.

## Pendiente / para la siguiente sesión

- **El dueño:** ratificar D-638.
- Anotado, sin hacer:
  - No retroactivo: pagos anteriores en `supplier_payments` (fuera del visor) y lotes anteriores con
    entity `purchases` (se ven «Eliminado · …»).
  - Anular la factura del corte no deja registro en la orden de corte.
  - P3: monto total del servicio aunque se salte una bobina; registro de la OP aunque los metros no
    cambien; valores sin traducir (`FREIGHT`, `TRANSFER`, `PEN`); el lote no es buscable; la E2E del
    otro rol espera un `<h1>` que también tiene la pantalla de error; un JSON roto de la API se
    informa como «todavía no responde JSON».
- Bases `ayr_local_e2e_cc50` y `ayr_local_e2e_cc50db` se borran al cerrar. `ayr_local` quedó con el
  juego de la segunda corrida de `seed:escenarios` (incluido H1); la primera, con el cambio de
  cantidad en C1 y el pedido de prueba anulado, quedó anulada como historia (D-592).

## Commits

- Corte A (PR #193): `16813963` auditoría; `710ad9b1` revisión; `cad274cd`, `700092ba` unitarias.
- Corte B (PR #194): `fb0d587d` menores; `5e1309e4` revisión.
