-- D-189 (F8-S3/M1) — la cola de producción son las OPs no iniciadas, y la prioridad manual
-- pasa del pedido a la orden.
--
-- Aditiva: tres columnas nuevas en `production_orders`, sin tocar las de `sales_orders`, que
-- quedan sin escritor (additive-first; nadie las lee desde esta migración).
ALTER TABLE "production_orders"
  ADD COLUMN "priority_at"     TIMESTAMPTZ(3),
  ADD COLUMN "priority_by_id"  UUID,
  ADD COLUMN "priority_reason" VARCHAR(500);

-- Backfill: la prioridad vigente de un pedido pasa a cada OP **viva** que cuelga de sus
-- reservas. Una OP cerrada o anulada ya no está en la cola y no hereda nada.
UPDATE "production_orders" AS po
SET "priority_at"     = so."priority_at",
    "priority_by_id"  = so."priority_by_id",
    "priority_reason" = so."priority_reason"
FROM "reservations" AS r
JOIN "sales_orders" AS so ON so."id" = r."sales_order_id"
WHERE po."reservation_id" = r."id"
  AND po."status" IN ('DRAFT', 'IN_PROGRESS')
  AND so."priority_at" IS NOT NULL;
