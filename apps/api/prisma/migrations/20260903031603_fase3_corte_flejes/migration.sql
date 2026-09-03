-- CreateEnum
CREATE TYPE "CoilKind" AS ENUM ('COIL', 'STRIP');

-- CreateEnum
CREATE TYPE "CuttingOrderStatus" AS ENUM ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CuttingOrderCoilStatus" AS ENUM ('SENT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "CoilStatus" ADD VALUE 'IN_THIRD_PARTY';

-- AlterTable
ALTER TABLE "coils" ADD COLUMN     "cutting_order_coil_id" UUID,
ADD COLUMN     "kind" "CoilKind" NOT NULL DEFAULT 'COIL';

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "related_cutting_order_id" UUID;

-- CreateTable
CREATE TABLE "cutting_orders" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "status" "CuttingOrderStatus" NOT NULL DEFAULT 'SENT',
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cutting_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cutting_order_coils" (
    "id" UUID NOT NULL,
    "cutting_order_id" UUID NOT NULL,
    "coil_id" UUID NOT NULL,
    "width_plan_mm" JSONB NOT NULL,
    "expected_kerf_loss_mm" DECIMAL(8,2) NOT NULL,
    "status" "CuttingOrderCoilStatus" NOT NULL DEFAULT 'SENT',
    "received_at" TIMESTAMPTZ(3),
    "received_widths_mm" JSONB,
    "received_weight_kg" DECIMAL(12,3),
    "received_kerf_loss_mm" DECIMAL(8,2),
    "received_kerf_loss_kg" DECIMAL(12,3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cutting_order_coils_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cutting_orders_supplier_id_status_idx" ON "cutting_orders"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "cutting_orders_business_line_id_status_idx" ON "cutting_orders"("business_line_id", "status");

-- CreateIndex
CREATE INDEX "cutting_order_coils_cutting_order_id_idx" ON "cutting_order_coils"("cutting_order_id");

-- CreateIndex
CREATE INDEX "cutting_order_coils_coil_id_idx" ON "cutting_order_coils"("coil_id");

-- CreateIndex
CREATE INDEX "coils_kind_type_key_idx" ON "coils"("kind", "type_key");

-- CreateIndex
CREATE INDEX "coils_cutting_order_coil_id_idx" ON "coils"("cutting_order_coil_id");

-- CreateIndex
CREATE INDEX "purchases_related_cutting_order_id_idx" ON "purchases"("related_cutting_order_id");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_related_cutting_order_id_fkey" FOREIGN KEY ("related_cutting_order_id") REFERENCES "cutting_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_cutting_order_coil_id_fkey" FOREIGN KEY ("cutting_order_coil_id") REFERENCES "cutting_order_coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_orders" ADD CONSTRAINT "cutting_orders_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_order_coils" ADD CONSTRAINT "cutting_order_coils_cutting_order_id_fkey" FOREIGN KEY ("cutting_order_id") REFERENCES "cutting_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_order_coils" ADD CONSTRAINT "cutting_order_coils_coil_id_fkey" FOREIGN KEY ("coil_id") REFERENCES "coils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
