-- cc52 (D-646): devolución de mercadería de una nota de crédito (motivo SUNAT 06/07).
-- OK del dueño por nombre (D-460). El nuevo valor 'SALES_RETURN' de "InventoryRefType" no se usa
-- en esta migración (ALTER TYPE ... ADD VALUE no se puede usar en la misma transacción).
-- Sin los DROP DEFAULT de operation_date: son el drift aprobado (drift-esperado.sql, D-593).

-- CreateEnum
CREATE TYPE "SalesReturnStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterEnum
ALTER TYPE "InventoryRefType" ADD VALUE 'SALES_RETURN';

-- CreateTable
CREATE TABLE "sales_returns" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "operation_date" DATE NOT NULL,
    "status" "SalesReturnStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_id" UUID,
    "reverse_reason" VARCHAR(240),

    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_items" (
    "id" UUID NOT NULL,
    "sales_return_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "credit_note_item_id" UUID NOT NULL,
    "dispatch_item_id" UUID NOT NULL,
    "item_type" "InventoryItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "reserve_qty" DECIMAL(16,3) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "total_cost" DECIMAL(18,4) NOT NULL,
    "movement_id" BIGINT NOT NULL,

    CONSTRAINT "sales_return_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_return_items_qty_check" CHECK ("qty" > 0),
    CONSTRAINT "sales_return_items_reserve_qty_check" CHECK ("reserve_qty" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_seq_key" ON "sales_returns"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_credit_note_id_key" ON "sales_returns"("credit_note_id");

-- CreateIndex
CREATE INDEX "sales_returns_sales_order_id_idx" ON "sales_returns"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_items_movement_id_key" ON "sales_return_items"("movement_id");

-- CreateIndex
CREATE INDEX "sales_return_items_dispatch_item_id_idx" ON "sales_return_items"("dispatch_item_id");

-- CreateIndex
CREATE INDEX "sales_return_items_credit_note_item_id_idx" ON "sales_return_items"("credit_note_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_items_sales_return_id_line_number_key" ON "sales_return_items"("sales_return_id", "line_number");

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_sales_return_id_fkey" FOREIGN KEY ("sales_return_id") REFERENCES "sales_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_credit_note_item_id_fkey" FOREIGN KEY ("credit_note_item_id") REFERENCES "fiscal_document_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_dispatch_item_id_fkey" FOREIGN KEY ("dispatch_item_id") REFERENCES "dispatch_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
