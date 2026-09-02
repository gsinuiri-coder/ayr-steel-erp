-- CreateEnum
CREATE TYPE "BusinessLineCode" AS ENUM ('drywall', 'metallic-roofing', 'roofing', 'trading', 'services');

-- CreateEnum
CREATE TYPE "InventoryStrategy" AS ENUM ('STOCK', 'NOOP');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('PEN', 'USD');

-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('API', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('MANUFACTURED', 'PURCHASED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('DNI', 'RUC', 'CE');

-- CreateEnum
CREATE TYPE "ImportEntity" AS ENUM ('PRODUCTS', 'CUSTOMERS');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PARSED', 'CONFIRMED');

-- DropEnum
DROP TYPE "BusinessLine";

-- CreateTable
CREATE TABLE "business_lines" (
    "id" UUID NOT NULL,
    "code" "BusinessLineCode" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "inventory_strategy" "InventoryStrategy" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finishes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "density_factor" DECIMAL(10,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "source" "ProductSource" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "doc_type" "DocType" NOT NULL,
    "doc_number" VARCHAR(20) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "address" VARCHAR(240),
    "email" VARCHAR(160),
    "phone" VARCHAR(30),
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "doc_type" "DocType" NOT NULL,
    "doc_number" VARCHAR(20) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "address" VARCHAR(240),
    "email" VARCHAR(160),
    "phone" VARCHAR(30),
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "provides_cutting_service" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_settings" (
    "id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "margin_pct" DECIMAL(7,4) NOT NULL,
    "min_margin_pct" DECIMAL(7,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "currency" "Currency" NOT NULL,
    "buy" DECIMAL(10,4) NOT NULL,
    "sell" DECIMAL(10,4) NOT NULL,
    "source" "ExchangeRateSource" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "file_key" VARCHAR(300) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PARSED',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "errors" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'VALID',
    "created_entity_id" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_lines_code_key" ON "business_lines"("code");

-- CreateIndex
CREATE UNIQUE INDEX "finishes_code_key" ON "finishes"("code");

-- CreateIndex
CREATE INDEX "products_business_line_id_idx" ON "products"("business_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_business_line_id_sku_key" ON "products"("business_line_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "customers_doc_type_doc_number_key" ON "customers"("doc_type", "doc_number");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_doc_type_doc_number_key" ON "suppliers"("doc_type", "doc_number");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_settings_business_line_id_key" ON "pricing_settings"("business_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_date_currency_key" ON "exchange_rates"("date", "currency");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_idx" ON "import_rows"("batch_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
