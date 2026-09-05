-- Fase 7 (D-094, D-096): fecha prometida de entrega y prioridad manual de la cola de
-- producción. Ninguna tabla nueva: la cola en sí es una vista derivada (D-093).
ALTER TABLE "sales_orders"
  ADD COLUMN "promised_delivery_date" DATE,
  ADD COLUMN "priority_at" TIMESTAMPTZ(3),
  ADD COLUMN "priority_by_id" UUID,
  ADD COLUMN "priority_reason" VARCHAR(500);
