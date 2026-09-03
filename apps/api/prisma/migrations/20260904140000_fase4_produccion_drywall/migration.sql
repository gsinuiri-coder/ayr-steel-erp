-- CreateEnum
CREATE TYPE "ProductionOrderStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionReportStatus" AS ENUM ('ACTIVE', 'REVERTED');

-- CreateTable
CREATE TABLE "product_boms" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "finish_id" UUID NOT NULL,
    "input_thickness_mm" DECIMAL(6,2) NOT NULL,
    "input_width_mm" DECIMAL(8,2) NOT NULL,
    "piece_length_mm" DECIMAL(8,2) NOT NULL,
    "kg_per_piece" DECIMAL(12,3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_boms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "business_line_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "status" "ProductionOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "target_pieces" INTEGER,
    "reservation_id" UUID,
    "notes" VARCHAR(500),
    "scrap_kg" DECIMAL(12,3),
    "material_cost_pen" DECIMAL(18,4),
    "overhead_cost_pen" DECIMAL(18,4),
    "total_cost_pen" DECIMAL(18,4),
    "unit_cost_pen" DECIMAL(18,4),
    "created_by_id" UUID NOT NULL,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_consumptions" (
    "id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "coil_id" UUID NOT NULL,
    "assigned_kg" DECIMAL(12,3) NOT NULL,
    "consumed_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "released_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_order_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_reports" (
    "id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "pieces" INTEGER NOT NULL,
    "theoretical_kg" DECIMAL(12,3) NOT NULL,
    "material_cost_pen" DECIMAL(18,4) NOT NULL,
    "unit_cost_pen" DECIMAL(18,4) NOT NULL,
    "status" "ProductionReportStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" VARCHAR(240),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_by_id" UUID,
    "reverted_at" TIMESTAMPTZ(3),

    CONSTRAINT "production_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_boms_product_id_key" ON "product_boms"("product_id");

-- CreateIndex
CREATE INDEX "product_boms_finish_id_input_thickness_mm_input_width_mm_idx" ON "product_boms"("finish_id", "input_thickness_mm", "input_width_mm");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_seq_key" ON "production_orders"("seq");

-- CreateIndex
CREATE INDEX "production_orders_business_line_id_status_idx" ON "production_orders"("business_line_id", "status");

-- CreateIndex
CREATE INDEX "production_orders_product_id_idx" ON "production_orders"("product_id");

-- CreateIndex
CREATE INDEX "production_order_consumptions_production_order_id_idx" ON "production_order_consumptions"("production_order_id");

-- CreateIndex
CREATE INDEX "production_order_consumptions_coil_id_released_at_idx" ON "production_order_consumptions"("coil_id", "released_at");

-- CreateIndex
CREATE INDEX "production_reports_production_order_id_status_idx" ON "production_reports"("production_order_id", "status");

-- AddForeignKey
ALTER TABLE "product_boms" ADD CONSTRAINT "product_boms_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_boms" ADD CONSTRAINT "product_boms_finish_id_fkey" FOREIGN KEY ("finish_id") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "product_boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_consumptions" ADD CONSTRAINT "production_order_consumptions_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_consumptions" ADD CONSTRAINT "production_order_consumptions_coil_id_fkey" FOREIGN KEY ("coil_id") REFERENCES "coils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reports" ADD CONSTRAINT "production_reports_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
