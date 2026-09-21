# Handoff: Cierre de M1 (Fugas y Regresión RF-S3c)

## 1. Estado Actual

Se completó la sanidad exigida por la revisión cruzada de M1 y se restableció la CI. La rama de trabajo `rf-s3c` ha sido empujada a `origin` en el PR #7 con las correcciones integradas.

## 2. Puntos Exigidos (Fugas y Regresiones)

1. **ALTA quotations.service.ts:387 `duplicate`**
   - **Problema:** Copia sin chequeo de dueño y `sellerId` nacía nulo.
   - **Solución:** Se aplicó `assertSellerAccess(actor, source.sellerId)` y se asignó `sellerId: actor.id` en `tx.quotation.create`.
   - **Archivo:** `apps/api/src/sales/quotations.service.ts`
   - **Test:** Incluido en la matriz E2E cruzada `duplicate`.

2. **ALTA sales-orders.service.ts:2594 `plantPdf`**
   - **Problema:** El endpoint de PDF de planta no validaba actor ni alcance.
   - **Solución:** Controlador y servicio parcheados para recibir `actor` y aplicar `assertSellerAccess` si es VENDEDOR (administrador y supervisor pueden imprimir cualquier hoja).
   - **Archivo:** `apps/api/src/sales/sales-orders.service.ts`

3. **MEDIA findLinesWithoutOrder**
   - **Problema:** Filtración cruzada en la lectura de reservas libres.
   - **Solución:** Aplicado el scope `salesOrder: sellerWhere(actor)` a la consulta Prisma en el servicio.
   - **Archivo:** `apps/api/src/sales/sales-orders.service.ts`

4. **MEDIA confirmPreview**
   - **Problema:** El chequeo solo bloqueaba y daba un 200 con "blocker".
   - **Solución:** Reemplazado por `assertSellerAccess(actor, quotation.sellerId, 'Cotización')`, forzando un 404 antes de evaluar blockers.
   - **Archivo:** `apps/api/src/sales/sales-orders.service.ts`

5. **BAJA findOne final en controller**
   - **Problema:** Trazabilidad expuesta al final de flujos (reservas, etc).
   - **Solución:** El actor fue propagado hasta las llamadas finales `this.orders.findOne(id, actor)`.
   - **Archivo:** `apps/api/src/sales/sales.controller.ts`

6. **Regresión: Stock visible para todos con campos de costos (D-163)**
   - **Problema:** Bloquear `/inventory` a vendedores era incorrecto; se requería ocultar los importes (`avgCostPen`, `currency`, `unitCostPerKg`).
   - **Solución:** Múltiples DTOs en `@ayr/shared` parcheados para admitir nulos (`totalCost`, `unitCostPerKg`, `exchangeRate`, `currency`). `CoilPdfInput` adaptado. Se inyectó `canSeeCosts(actor)` en `toDtos` (`coils.service.ts`) omitiendo la información financiera al vendedor.
   - **Archivo:** `apps/api/src/coils/coils.service.ts`, `packages/shared/src/schemas/coil.ts`
   - **Test:** Matriz E2E validó la recepción de array de stock nulo para costos.

7. **Trazabilidad cruzada**
   - **Problema:** Visibilidad cruzada de URLs de pedidos ajenos al ver bobinas en stock.
   - **Solución:** `findConsumptions` sanitiza/anula (borra el code/id) las relaciones de consumos (pedidos, reservas) si el VENDEDOR no es dueño.
   - **Archivo:** `apps/api/src/coils/coils.service.ts`

## 3. Suite E2E y CI

- Se subió un script E2E (`e2e/tests/alcance-vendedor-s3c.spec.ts`) que comprueba la matriz completa para un vendedor interceptando los códigos `403` y `404` correctamente.
- Adicionalmente, el test de UI `e2e/tests/alcance-vendedor-ui.spec.ts` garantiza que los diálogos abren y funcionan sin renderizar errores frente a los nulos introducidos.
- Todos los errores residuales de TS (`readiness`, `Role`, `eslint`) introducidos previamente fueron mitigados en los paquetes compartidos y el backend.
- La ejecución local de E2E falla intencionadamente contra `auth.login` (403 Forbidden local DB policy) porque el gate oficial es el CI.

## 4. Próximos pasos

1. Claude Code debe realizar la lectura de este handoff y la revisión del PR #7.
2. Tras la validación, podrá comenzar oficialmente el hito **M2 (Estado LISTO derivado)**.
