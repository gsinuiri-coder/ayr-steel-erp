# Revision del corte B de cc49 (segundo modelo, solo lectura)

Diff: 4cc9fc21...cc49-b-historial (3 vistas + 1 E2E). Veredicto: sin P0, P1 ni P2.

## Hallazgos

### P3-1 El E2E solo prueba al ADMINISTRADOR

e2e/tests/historial-cc49.spec.ts: no hay aserción de que otro rol no vea «Historial» (AuditHistoryLink devuelve null salvo ADMINISTRADOR). Es el mismo componente ya usado en 6 detalles, y D-637 dice permisos sin cambio, así que es riesgo bajo. Propuesta (opcional): una aserción negativa con un usuario no admin, o dejarlo cubierto por el test del componente.

### P3-2 Orden visual en compras

compra-detalle-view.tsx:277-278. El contenedor es `items-start` y el Badge lleva `mt-2` para alinearse con el botón principal, que lleva el footer de fecha debajo. «Historial» (size sm) queda alineado arriba, junto al Badge. Es correcto, pero conviene mirarlo en el UAT porque el principal con `primaryFooter` es más alto. No es un defecto confirmado.

### P3-3 loginAsAdmin duplicado en el spec

Ya hay un helper compartido en e2e/helpers/report-fixtures.ts:24. Muchos specs lo copian localmente, así que sigue la convención; solo deuda menor.

## Revisado sin hallazgos

- Tipo de entidad e id: 'purchases', 'cutting_orders' y 'production_orders' están en AuditEntityType (packages/shared/src/schemas/audit.ts:36,46,48). El API audita con `entity` igual y `entityId` = id del documento. Compras: purchases.service.ts (receive en 718). Corte: cutting.service.ts, cutting.send/receive/receive-reverse con `entityId: order.id` / `cuttingOrderId`. Producción: production.create (production.service.ts:386) y las acciones de roofing, todas con `production_orders`. Los ids que pasa la vista (p.id, o.id, o.id) son los mismos.
- Etiquetas que espera el E2E: 'Recepción de compra' (purchases.receive), 'Recepción de corte' (cutting.receive) y 'Orden de producción creada' (production.create) existen en packages/shared/src/audit-labels.ts.
- Coherencia: mismo componente, misma posición (antes de HeaderActions, dentro del grupo de acciones) que pedidos, despachos y los demás. Los contenedores de los tres detalles son `flex flex-wrap`, sin desbordes.
- Permisos: el enlace se oculta salvo para ADMINISTRADOR, igual que el destino /auditoria. No se tocó nada en el API.
- URL: `/auditoria?entityType=X&entityId=Y` con 12 meses por defecto (audit-url.ts: auditDefaultPeriodLabel). Los testids `filtro-documento` y `fila-auditoria` existen en auditoria-view.tsx. `getByText('Últimos 12 meses')` aparece una sola vez en la vista, y lo usa también auditoria-d218.
- E2E: omitido contra producción (D-126). El setup usa setupScenario y la limpieza va en `finally` con deactivateTrail (purga la OP, revierte el corte, cancela bobina y compra). Las aserciones verifican el href exacto, la navegación, el filtro y la fila con la etiqueta correcta de cada documento.
- No se ejecutó nada (revisión estática).
