-- ---------------------------------------------------------------------------
-- Sesión 7-final-B — el pedido enlazado a un comprobante importado (D-141).
--
-- Cada documento que entra por la importación de ventas (D-138) crea **un**
-- pedido, y el dueño decide por documento si ese pedido es una cáscara —la
-- venta ya se entregó, cero efectos de inventario— o un pedido vivo, con su
-- reserva y su orden de producción en cola.
--
-- `origin` es lo que separa las dos poblaciones sin tocar `status`, por el
-- mismo motivo que D-105 lo hizo en `fiscal_documents`: **estado y origen
-- responden preguntas distintas**. Un `IMPORTED` en `SalesOrderStatus` habría
-- obligado a cada lista de estados del módulo —la del despacho, la de la
-- cobranza, la de la cola— a acordarse de él.
--
-- El enlace documento↔pedido **no agrega columna**:
-- `fiscal_documents.sales_order_id` ya existe desde Fase 5b y es la misma
-- relación, leída desde el otro lado.
-- ---------------------------------------------------------------------------

CREATE TYPE "sales_order_origin" AS ENUM ('CREATED_HERE', 'IMPORTED');

-- Con default y NOT NULL: todo pedido que ya existe se creó en el ERP, que es
-- exactamente lo que dice el default. No hay backfill que hacer.
ALTER TABLE "sales_orders"
  ADD COLUMN "origin" "sales_order_origin" NOT NULL DEFAULT 'CREATED_HERE';

-- El listado filtra por origen (lo importado se lee aparte de lo operado) y el
-- guardrail de reimportación busca "pedidos importados de este cliente": las
-- dos consultas entran por acá.
CREATE INDEX "sales_orders_origin_status_idx" ON "sales_orders"("origin", "status");
