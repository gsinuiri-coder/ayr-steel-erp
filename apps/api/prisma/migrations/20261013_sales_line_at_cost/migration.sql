-- cc51 (D-641): la marca «A costo» de una línea de venta y su motivo. Solo agrega columnas
-- opcionales: las filas existentes quedan vacías (línea normal).
ALTER TABLE "quotation_items"
  ADD COLUMN "at_cost_reason" VARCHAR(20),
  ADD COLUMN "at_cost_note" VARCHAR(200);
ALTER TABLE "sales_order_items"
  ADD COLUMN "at_cost_reason" VARCHAR(20),
  ADD COLUMN "at_cost_note" VARCHAR(200);
