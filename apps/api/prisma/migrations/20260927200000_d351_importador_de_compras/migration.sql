-- D-351: importador de compras. Aditiva: dos columnas nullable y un índice; nada se reescribe.
--
-- `purchases.import_batch_id`: el lote del importador que creó la compra (referencia suelta, sin
-- FK — mismo criterio que las demás `import_batch_id` que D-150 conservó). Deshacer un lote anula
-- por el servicio las compras de ese lote que sigan en borrador y sin pagos.
ALTER TABLE "purchases" ADD COLUMN "import_batch_id" UUID;
CREATE INDEX "purchases_import_batch_id_idx" ON "purchases"("import_batch_id");

-- `purchase_items.external_code`: el código con el que el proveedor identifica la bobina (opcional,
-- solo en compras de bobinas). La recepción lo copia a `coils.external_code` (D-206).
ALTER TABLE "purchase_items" ADD COLUMN "external_code" VARCHAR(40);
