-- ---------------------------------------------------------------------------
-- Sesión 7-final-C — CLI de importación de ventas: dry-run/execute y reversa
-- por lote (D-142, enmienda operativa a D-138/D-140/D-141).
--
-- `import_batch_id` es una referencia SUELTA (sin FK), el mismo criterio que
-- ya usa el kardex con `ref_id`: el lote (`import_batches.id`) vive y muere
-- por su cuenta, y una fila con este campo apuntando a un lote borrado no es
-- un caso que el dominio necesite prevenir con una restricción — el CLI de
-- reversa por lote es quien lee esta columna, no el flujo de ventas normal.
--
-- Nullable en las seis tablas y sin backfill: todo lo que existe hoy se creó
-- por otro camino que no es este CLI (el propio flujo de ventas, la
-- importación anterior por UI, o antes de que este campo existiera), y eso
-- es exactamente lo que el `NULL` dice.
-- ---------------------------------------------------------------------------

ALTER TABLE "fiscal_documents" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "fiscal_documents_import_batch_id_idx" ON "fiscal_documents"("import_batch_id");

ALTER TABLE "sales_orders" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "sales_orders_import_batch_id_idx" ON "sales_orders"("import_batch_id");

ALTER TABLE "reservations" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "reservations_import_batch_id_idx" ON "reservations"("import_batch_id");

ALTER TABLE "production_orders" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "production_orders_import_batch_id_idx" ON "production_orders"("import_batch_id");

ALTER TABLE "customers" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "customers_import_batch_id_idx" ON "customers"("import_batch_id");

ALTER TABLE "products" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "products_import_batch_id_idx" ON "products"("import_batch_id");
