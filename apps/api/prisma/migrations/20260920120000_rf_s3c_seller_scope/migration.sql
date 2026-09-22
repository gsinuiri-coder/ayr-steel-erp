-- RF-S3c M1. Aditiva: el backfill corre por script, no dentro de la migración.
ALTER TABLE "quotations" ADD COLUMN "seller_id" UUID;
ALTER TABLE "sales_orders" ADD COLUMN "seller_id" UUID;

ALTER TABLE "quotations"
  ADD CONSTRAINT "quotations_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_orders"
  ADD CONSTRAINT "sales_orders_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "quotations_seller_id_status_issue_date_idx"
  ON "quotations"("seller_id", "status", "issue_date");
CREATE INDEX "sales_orders_seller_id_status_issue_date_idx"
  ON "sales_orders"("seller_id", "status", "issue_date");
