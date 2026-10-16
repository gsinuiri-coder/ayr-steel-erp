# Ventana cc56 — cobranzas y pagos con saldos iniciales, costo de bobinas protegido y cierre de mes

2026-10-16, Lima. Tres PR de código, cada uno con su despliegue, y este cierre de docs. Decisiones D-668..D-670
(provisionales; D-668 y D-669 son decisión del dueño). **Sin migraciones.** Sin SQL contra producción. **Sin escrituras
en producción:** el importador de saldos espera el Excel del dueño y la corrección C2 quedó en PARA. Sin ramas nuevas de
Neon (sigue en 9 de 10): no hizo falta respaldo porque no se ejecutó nada.

## En producción

- **Corte A (PR #217, merge `68ba8adb`):** API `ayr-steel-erp-api-00134-5vp` (`git-sha=4f0c1c5d`), desplegada antes del
  merge; `smoke:prod --expect-sha 68ba8adb --expect-api-sha 4f0c1c5d` en verde.
- **Corte B (PR #218, merge `02175b1d`):** API `ayr-steel-erp-api-00135-t9b` (`git-sha=2e7c4510`); smoke en verde.
- **Corte C (PR #219, merge `b33748da`):** API `ayr-steel-erp-api-00136-q2t` (`git-sha=e1e18424`); smoke en verde. **Revisión final de la
  API: `ayr-steel-erp-api-00136-q2t`.**
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` y revert del
  merge. Anteriores: `00133-tfm` (para A), `00134-5vp` (para B), `ayr-steel-erp-api-00135-t9b` (para C). Sin cambios de schema ni de datos.
- `--web-origin`: `https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`.

## Qué entró

- **D-668 (corte A):** `pnpm import:saldos-iniciales` (`apps/api/prisma/import-opening-balances-cli.ts`,
  `apps/api/src/imports/opening-balances*.ts`): plantillas, plan puro, registro por `ReceivablesService.addPaymentInTx` y
  `PurchasesService.addPaymentInTx` (nuevo), lote en `audit_log` (`imports.opening-balances`), deshacer
  (`reversePaymentInTx` nuevos en los dos servicios). Candado vista previa → ejecución.
- **D-669 (corte B):** `COST_CHANGE_REASONS` (`@ayr/shared`, `schemas/cost-change.ts`); `costReason` en `updateCoilSchema`
  y `commitReceivedPurchaseEditSchema`, exigido en `CoilOperationsService.update` y en
  `ReceivedPurchaseEditService.commit` (grupo COST); selector en `coil-edit-dialog.tsx` y
  `edit-received-purchase-dialog.tsx`. `correctCoilEntryCost` (`coils/coil-entry-cost.ts`) y `pnpm fix:costo-bobina`
  con `entryCostViolations`.
- **D-670 (corte C):** `GET /reports/undispatched-at-close[/xlsx]` (`UndispatchedAtCloseService`,
  `undispatched-at-close.ts`, por cantidades por línea de pedido); `UndispatchedAtClose` y `UndispatchedAtCloseMonth` en
  Ventas y margen e Inventario valorizado.

## Medido en producción (solo lectura)

- Saldos: dry-run con la plantilla en blanco y «sigue pendiente» → 109 comprobantes y 26 compras leídos, 0 pagos, 0
  errores.
- Facturado y no despachado al cierre: **agosto 26 comprobantes** (venta S/ 516 292,73, costo estimado S/ 419 034,93;
  25 salieron después, 1 parcial); **septiembre 33** (venta S/ 633 726,78, costo estimado S/ 514 542,69; 32 y 1). Coincide
  con audit-01 (ago→sep 20 + ago→oct 6; sep→oct 33 comprobantes).
- C2 (dry-run, tres corridas, la última con el código final): entrada 468 y venta 960 +S/ 731,23 cada una; FFA1-00001448
  +731,23 en Rentabilidad y en Ventas y margen; saldo de la bobina 0 → 0; sin movimientos de cantidad. **Ventas y margen
  de septiembre: 580 773,90 → 581 505,13** (la factura es del 24/09; la salida, del 07/10; la entrada, del 28/09).

## Verificación

- Unitarias de API (3 644+) y web (354) en verde; specs nuevos de cada pieza.
- db-spec en base propia (`ayr_local_e2e_cc56db`): `opening-balances`, `purchase-audit`, `credit-note-reasons`,
  `coil-split-kerf-cost` y `lock-order` en verde (37 + 43).
- Ensayo local de punta a punta del importador (plantillas, dry-run, ejecutar, segundo lote rechazado, deshacer, «pagado
  al corte»).
- CI completa en verde en los tres PR (E2E en dos shards, Neon ci, escenarios, drift, SonarCloud).

## Revisiones

Autorrevisión y segundo modelo por corte (`docs/revision/cc56-{a,b,c}-*.md`), con la resolución al pie de cada uno.

- **A:** P1 de la autorrevisión (filas de cobro sobre cobros ya registrados) corregido; P2 de las dos corregidos.
- **B:** P1 (formato en CI) corregido; P2 (datos reales en el spec, ajustes de costo propios, hijas y flejes, escala,
  candado de la CLI) corregidos.
- **C:** los dos P1 de cada revisión (despachos no declarados, fechas en vez de cantidades) llevaron a rehacer el armado
  por cantidades.
- Revisión del dueño: UAT en `docs/uat/cc56.md`, pendiente.

## Pendiente / para la siguiente sesión

- **El dueño:**
  - llenar el Excel de saldos (ver «Qué llenar» abajo) y elegir fecha de corte y opción de faltantes;
  - **decidir C2** (abajo);
  - UAT de cc56 y de cc55; ratificar D-664..D-670.
- **Correr el importador en producción** cuando llegue el Excel: dry-run, revisar la vista previa con el dueño, respaldo
  Neon (regla 18 si falta lugar) y `--execute --confirm-production` con su OK por nombre.
- **C2 · bobina IMPO-ALZ-AZUL-5002-0.28-4150-23 (PARA).** El OK decía «+731,23 en el costo, octubre». El dry-run cumple
  todo lo demás, pero en los reportes el aumento cae en **septiembre** (Ventas y margen por la fecha de la factura, 24/09;
  inventario valorizado al 30/09, porque la entrada es del 28/09); solo la salida del kardex es de octubre (07/10). Si el
  dueño acepta septiembre: `pnpm fix:costo-bobina --branch production --confirm-production --bobina
IMPO-ALZ-AZUL-5002-0.28-4150-23 --costo-kg 2.87 --motivo PURCHASE_CORRECTION --detalle "…" --comprobante FFA1-00001448
--delta 731.23` (dry-run, respaldo, y `--execute` con su OK).
- **C1 de cc55: cerrado** («se dejan como están», decisión del dueño); lo muestra D-670.
- **Anotado:** los P3 de las seis revisiones (al pie de cada informe); R-4, R-5, H4–H7 de cc55.

## Qué llenar (para el dueño)

- Archivos en `local-data/cc56/plantillas/` del checkout principal: `cobranzas-prellenada-production.xlsx` (109
  comprobantes) y `pagos-prellenada-production.xlsx` (26 compras). Las `plantilla-*-vacia.xlsx` traen un ejemplo inventado.
- Por cada comprobante (o compra), **una** de dos formas: lo cobrado hasta el corte (fecha, monto, medio; una fila por
  cobro, repitiendo el comprobante) **o** solo el saldo que quedaba pendiente al corte (0 si estaba pagado).
- Lo que se deje en blanco se trata según la opción del lote: «pagado al corte» o «sigue pendiente».
- Montos de cobranzas en soles con IGV; de compras, en la moneda de la compra.
