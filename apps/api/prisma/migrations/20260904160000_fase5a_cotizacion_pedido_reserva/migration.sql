-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'EMITTED', 'CONFIRMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('CONFIRMED', 'IN_PRODUCTION', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "business_lines" ADD COLUMN     "quotation_required" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "list_price_pen" DECIMAL(18,4);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "issue_date" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "notes" VARCHAR(500),
    "pdf_key" VARCHAR(300),
    "created_by_id" UUID NOT NULL,
    "emitted_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_items" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "description" VARCHAR(240) NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "list_price_pen" DECIMAL(18,4),
    "unit_price_pen" DECIMAL(18,4) NOT NULL,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "reserve_item_type" "InventoryItemType" NOT NULL,
    "reserve_item_id" UUID NOT NULL,
    "reserve_qty" DECIMAL(16,3) NOT NULL,
    "reserve_unit" VARCHAR(20) NOT NULL,

    CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "quotation_id" UUID,
    "customer_id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "issue_date" DATE NOT NULL,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_items" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "description" VARCHAR(240) NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "list_price_pen" DECIMAL(18,4),
    "unit_price_pen" DECIMAL(18,4) NOT NULL,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "reserve_item_type" "InventoryItemType" NOT NULL,
    "reserve_item_id" UUID NOT NULL,
    "reserve_qty" DECIMAL(16,3) NOT NULL,
    "reserve_unit" VARCHAR(20) NOT NULL,

    CONSTRAINT "sales_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "item_type" "InventoryItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(3),
    "released_by_id" UUID,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotations_seq_key" ON "quotations"("seq");

-- CreateIndex
CREATE INDEX "quotations_customer_id_status_idx" ON "quotations"("customer_id", "status");

-- CreateIndex
CREATE INDEX "quotations_business_line_id_status_idx" ON "quotations"("business_line_id", "status");

-- CreateIndex
CREATE INDEX "quotations_status_valid_until_idx" ON "quotations"("status", "valid_until");

-- CreateIndex
CREATE INDEX "quotation_items_quotation_id_idx" ON "quotation_items"("quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_items_quotation_id_line_number_key" ON "quotation_items"("quotation_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_seq_key" ON "sales_orders"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_quotation_id_key" ON "sales_orders"("quotation_id");

-- CreateIndex
CREATE INDEX "sales_orders_customer_id_status_idx" ON "sales_orders"("customer_id", "status");

-- CreateIndex
CREATE INDEX "sales_orders_business_line_id_status_idx" ON "sales_orders"("business_line_id", "status");

-- CreateIndex
CREATE INDEX "sales_order_items_sales_order_id_idx" ON "sales_order_items"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_items_sales_order_id_line_number_key" ON "sales_order_items"("sales_order_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_sales_order_item_id_key" ON "reservations"("sales_order_item_id");

-- CreateIndex
CREATE INDEX "reservations_item_type_item_id_status_idx" ON "reservations"("item_type", "item_id", "status");

-- CreateIndex
CREATE INDEX "reservations_sales_order_id_idx" ON "reservations"("sales_order_id");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
