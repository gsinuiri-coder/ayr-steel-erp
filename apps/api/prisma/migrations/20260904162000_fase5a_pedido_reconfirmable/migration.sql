-- DropIndex
DROP INDEX "sales_orders_quotation_id_key";

-- CreateIndex
CREATE INDEX "sales_orders_quotation_id_idx" ON "sales_orders"("quotation_id");
