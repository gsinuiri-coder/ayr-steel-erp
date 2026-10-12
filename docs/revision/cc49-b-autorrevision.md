# Autorrevisión — no vale como pase cruzado

Corte B de cc49 (D-637): «Historial» en el detalle de compra, orden de corte y orden de producción.
Diff revisado: `git diff 4cc9fc21...cc49-b-historial` (4 archivos, +107). Revisor: subagente nuevo,
no leyó el handoff de implementación. Solo lectura; no se corrió nada (ni typecheck ni E2E).

## Comprobaciones

| Punto                                                 | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| entityId = id del documento en las auditorías del API | Sí. `purchases.service.ts` (create 327, receive 719, cancel/editar 408/463/517/898), `purchase-received-edit.service.ts:179`, `purchase-received-date-fix.ts:327/463` → `purchase.id`/`purchaseId`. `cutting.service.ts:215/389/598/703` (send, receive, receive-reverse, cancel) → `order.id`/`cuttingOrderId`. `production.service.ts` (10 sitios), `roofing-production.service.ts` (12), `roofing-drafts.service.ts:333` → `order.id`/`orderId`. Coincide con `p.id`, `o.id`, `o.id` del web. |
| El visor acepta los tipos                             | Sí. `cutting_orders`, `production_orders`, `purchases` están en `AUDIT_ENTITY_TYPES` (`packages/shared/src/schemas/audit.ts:36,46,48`), tienen rótulo (`audit-labels.ts:150,160,162`) y resolutor de código (`audit-entity-refs.ts:93,164,177`). `fetchAuditLog` filtra `entity` + `entity_id` (`audit-query.service.ts:374-375`). 12 meses por defecto con tipo+id: `apps/web/src/lib/audit-url.ts:53`.                                                                                         |
| Ubicación según el estándar                           | Sí: fuera de `HeaderActions`, a su izquierda, igual que pedido/despacho/bobina/comprobante/cotización. No agrega principal ni descarga; D-623 intacto.                                                                                                                                                                                                                                                                                                                                           |
| Permisos                                              | Sin cambio: el componente se oculta a todo rol que no sea ADMINISTRADOR (corte y producción también dejan entrar a SUPERVISOR_PLANTA; para ellos no aparece).                                                                                                                                                                                                                                                                                                                                    |
| Layout                                                | Los tres contenedores ya son `flex flex-wrap ... gap-2`; un botón `sm` más no fuerza scroll horizontal. Sin riesgo nuevo de D-625.                                                                                                                                                                                                                                                                                                                                                               |
| E2E prueba lo que dice                                | En lo esencial sí: href exacto, navegación, chip `filtro-documento`, «Últimos 12 meses» y una fila de acción real de cada documento (`purchases.receive`, `cutting.receive`, `production.create`). Limpia con `deactivateTrail` en `finally`.                                                                                                                                                                                                                                                    |

## Hallazgos

Sin P0 ni P1.

### P2

**P2-1 — Los pagos a proveedor no salen en el Historial de la compra.**
`apps/api/src/purchases/purchases.service.ts:1346-1350` y `:1410-1414`: `purchases.payment` y
`purchases.payment-reverse` se auditan con `entity: 'supplier_payments'`, `entityId: payment.id`
(el `purchaseId` va dentro de `after`/`before`). El filtro `entityType=purchases&entityId=<id>` no
los trae, y `supplier_payments` ni siquiera está en `AUDIT_ENTITY_TYPES`.
Escenario: el admin abre «Historial» de una compra con un pago revertido para ver quién lo
revirtió; la lista no lo muestra y parece que nunca pasó. No es regresión del corte (el dato ya
era así), pero el botón nuevo promete «el historial de esta compra» y deja fuera los eventos de
dinero, que son los que más se buscan.
Propuesta: no ampliar alcance en este corte; registrarlo como límite conocido en el handoff/UAT
(«Historial de compra no incluye pagos; están en Auditoría por acción “Pago a proveedor”») y, si
el dueño lo quiere, decisión aparte para sumar `supplier_payments` al visor o para que el filtro
de compra los incluya por `purchaseId`. Lo mismo, en menor grado, para eventos de la OP
auditados bajo otra entidad (bobinas, reservas) y para lo que una compra genera en `coils`.

### P3

**P3-1 — La OP del E2E se crea fuera del `try`.** `e2e/tests/historial-cc49.spec.ts:58-60`: si
`POST /api/production` falla, el `finally` no corre y quedan la compra recibida, el corte recibido,
proveedor, acabado y producto activos en la base de E2E. Propuesta: abrir el `try` justo después
de `setupScenario` y declarar `let op: ProductionOrderDto | undefined`, pasando
`productionOrderIds: op ? [op.id] : []`.

**P3-2 — `loginAsAdmin` duplicado.** `historial-cc49.spec.ts:22-29` repite el que ya exporta
`e2e/helpers/report-fixtures.ts:24`. Propuesta: importarlo (Sonar cuenta duplicación).

**P3-3 — El E2E no prueba que el filtro excluya otros documentos ni el caso sin permiso.**
`openHistory` (`historial-cc49.spec.ts:32-53`) verifica que hay una fila con el texto esperado,
pero no que todas las filas sean del documento; con el filtro roto (p. ej. ignorando `entityId`)
la prueba seguiría verde porque la recepción propia también aparece. Tampoco verifica que
SUPERVISOR_PLANTA no vea el botón en corte/producción (permisos «sin cambio» se afirma, no se
prueba). Propuesta: contar filas y comprobar que todas muestran el código del documento (o crear
dos compras y verificar que la otra no aparece); el caso de rol puede quedarse fuera si ya lo
cubre otro spec del componente.

**P3-4 — Comentarios desplazados.** En `compra-detalle-view.tsx:273-278` y
`produccion-detalle-view.tsx:202-205`, el comentario nuevo quedó entre el comentario existente de
`HeaderActions` (F8-S3b/M3, cc47b D-623) y el propio `HeaderActions`, que ahora parece describir
al Historial. Propuesta: subir el `AuditHistoryLink` y su comentario por encima del comentario
viejo (como en `corte-detalle-view.tsx:117-119`, donde sí quedó bien).

**P3-5 — Altura desigual en compra.** `compra-detalle-view.tsx:269` usa `items-start`; el
`Historial` es `size="sm"` (h-8) y el principal de `HeaderActions` usa el tamaño por defecto
(h-9), así que quedan 4 px desalineados por abajo. Es el mismo patrón que ya tiene bobina
(`bobina-detalle-view.tsx:207`); no hace falta tocar nada salvo que el dueño lo note en el UAT.

## Fuera de alcance, para registrar

- `supplier_payments` falta en `AUDIT_ENTITY_TYPES` aunque `audit_log` lo usa (la lista de D-050
  dice ser cerrada «de los que ya se usan»). Ver P2-1.
- La importación de compras audita el lote con `entity: 'purchases'` y `entityId: batchId`
  (`purchase-import.service.ts:468-469`, `:614-615`); no cae en el Historial de ninguna compra
  (cada compra importada sí tiene su `purchases.create` vía `createInTx`), lo cual es correcto.
