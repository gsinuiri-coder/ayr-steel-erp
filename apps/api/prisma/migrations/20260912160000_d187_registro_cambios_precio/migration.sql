-- D-187 (F8-S2/M4) — registro de cambios de precio de las líneas de venta.
--
-- Una cotización se edita hasta confirmarla (D-184) y un pedido confirmado admite que el
-- ADMINISTRADOR corrija el precio de una línea hasta que tenga comprobante. Cada cambio del
-- valor unitario deja una fila: quién, cuándo, antes y después. Tabla nueva y append-only; no
-- toca ninguna fila existente.
CREATE TABLE "sales_price_changes" (
  "id"                         UUID           NOT NULL,
  "quotation_id"               UUID,
  "sales_order_id"             UUID,
  "line_number"                INTEGER        NOT NULL,
  "product_id"                 UUID           NOT NULL,
  "before_unit_value_pen"      DECIMAL(18,4)  NOT NULL,
  "after_unit_value_pen"       DECIMAL(18,4)  NOT NULL,
  "before_value_per_meter_pen" DECIMAL(18,4),
  "after_value_per_meter_pen"  DECIMAL(18,4),
  "changed_by_id"              UUID           NOT NULL,
  "changed_at"                 TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sales_price_changes_pkey" PRIMARY KEY ("id"),
  -- Un cambio es de una cotización **o** de un pedido, nunca de los dos ni de ninguno.
  CONSTRAINT "sales_price_changes_holder_ck" CHECK (num_nonnulls("quotation_id", "sales_order_id") = 1)
);

ALTER TABLE "sales_price_changes"
  ADD CONSTRAINT "sales_price_changes_quotation_id_fkey"
  FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_price_changes"
  ADD CONSTRAINT "sales_price_changes_sales_order_id_fkey"
  FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sales_price_changes_quotation_id_changed_at_idx"
  ON "sales_price_changes"("quotation_id", "changed_at");
CREATE INDEX "sales_price_changes_sales_order_id_changed_at_idx"
  ON "sales_price_changes"("sales_order_id", "changed_at");
