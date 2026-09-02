-- Fase 2a (D-041): kardex append-only, compras con recepción y pagos parciales,
-- y bobinas con código RF-13 / typeKey RF-14.

-- CreateEnum
CREATE TYPE "InventoryItemType" AS ENUM ('PRODUCT', 'COIL');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('IN', 'OUT', 'ADJUST');

-- CreateEnum
CREATE TYPE "InventoryRefType" AS ENUM ('PURCHASE', 'SALE', 'PRODUCTION', 'SPLIT', 'SCRAP', 'CUTTING', 'ADJUSTMENT', 'IMPORT');

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('COIL', 'FINISHED_GOOD', 'SERVICE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PurchaseDocType" AS ENUM ('FACTURA', 'BOLETA', 'NOTA_CREDITO', 'NOTA_DEBITO');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('CONTADO', 'CREDITO');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('CUTTING', 'FREIGHT', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CHECK', 'DEPOSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "CoilStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- AlterEnum
-- (PG 12+ admite ADD VALUE dentro de una transacción mientras el valor nuevo no se use
--  en esa misma transacción; esta migración no lo usa.)
ALTER TYPE "ImportEntity" ADD VALUE 'COILS';

-- AlterTable: overhead de fábrica por kg (D-035/P-11)
ALTER TABLE "pricing_settings" ADD COLUMN     "overhead_per_kg" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable: código corto de proveedor (primer segmento del código de bobina, RF-13)
-- y correlativo por proveedor de ese código.
ALTER TABLE "suppliers" ADD COLUMN     "code" VARCHAR(6),
ADD COLUMN     "coil_seq" INTEGER NOT NULL DEFAULT 0;

-- Backfill del código de los proveedores que ya existen: hasta 4 letras del nombre
-- (sin tildes ni signos) más un sufijo de 2 letras que garantiza unicidad. El
-- resultado es siempre 3-6 letras, igual que exige el schema Zod para altas nuevas.
WITH base AS (
  SELECT
    "id",
    REGEXP_REPLACE(
      UPPER(TRANSLATE(
        "name",
        'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑÇáàäâéèëêíìïîóòöôúùüûñç',
        'AAAAEEEEIIIIOOOOUUUUNCAAAAEEEEIIIIOOOOUUUUNC'
      )),
      '[^A-Z]', '', 'g'
    ) AS letters,
    ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS rn
  FROM "suppliers"
)
UPDATE "suppliers" s
SET "code" = LEFT(COALESCE(NULLIF(b.letters, ''), 'PRV'), 4)
          || CHR((65 + (((b.rn - 1) / 26) % 26))::int)
          || CHR((65 + ((b.rn - 1) % 26))::int)
FROM base b
WHERE s."id" = b."id";

ALTER TABLE "suppliers" ALTER COLUMN "code" SET NOT NULL;

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" BIGSERIAL NOT NULL,
    "business_line_id" UUID NOT NULL,
    "item_type" "InventoryItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "total_cost" DECIMAL(18,4) NOT NULL,
    "ref_type" "InventoryRefType" NOT NULL,
    "ref_id" VARCHAR(80),
    "reversal_of_id" BIGINT,
    "actor_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "item_type" "InventoryItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "avg_cost" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "business_line_id" UUID NOT NULL,
    "type" "PurchaseType" NOT NULL,
    "doc_type" "PurchaseDocType" NOT NULL,
    "series" VARCHAR(10) NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "issue_date" DATE NOT NULL,
    "currency" "Currency" NOT NULL,
    "exchange_rate" DECIMAL(10,4) NOT NULL,
    "exchange_rate_source" "ExchangeRateSource" NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL,
    "igv" DECIMAL(18,4) NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "payment_terms" "PaymentTerms" NOT NULL,
    "credit_days" INTEGER,
    "due_date" DATE,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "service_kind" "ServiceKind",
    "source_xml_key" VARCHAR(300),
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_items" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID,
    "description" VARCHAR(240) NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL,
    "igv" DECIMAL(18,4) NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "finish_id" UUID,
    "width_mm" DECIMAL(8,2),
    "thickness_mm" DECIMAL(6,2),

    CONSTRAINT "purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" "Currency" NOT NULL,
    "exchange_rate" DECIMAL(10,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" VARCHAR(80),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coils" (
    "id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "type_key" VARCHAR(40) NOT NULL,
    "business_line_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_id" UUID,
    "purchase_item_id" UUID,
    "finish_id" UUID NOT NULL,
    "weight_kg" DECIMAL(12,3) NOT NULL,
    "width_mm" DECIMAL(8,2) NOT NULL,
    "thickness_mm" DECIMAL(6,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "exchange_rate" DECIMAL(10,4) NOT NULL,
    "unit_cost_per_kg" DECIMAL(18,4) NOT NULL,
    "total_cost" DECIMAL(18,4) NOT NULL,
    "total_cost_pen" DECIMAL(18,4) NOT NULL,
    "status" "CoilStatus" NOT NULL DEFAULT 'OPEN',
    "parent_coil_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coils_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_item_type_item_id_at_idx" ON "inventory_movements"("item_type", "item_id", "at");

-- CreateIndex
CREATE INDEX "inventory_movements_business_line_id_at_idx" ON "inventory_movements"("business_line_id", "at");

-- CreateIndex
CREATE INDEX "inventory_movements_ref_type_ref_id_idx" ON "inventory_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_reversal_of_id_key" ON "inventory_movements"("reversal_of_id");

-- CreateIndex
CREATE INDEX "inventory_balances_business_line_id_idx" ON "inventory_balances"("business_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_item_type_item_id_key" ON "inventory_balances"("item_type", "item_id");

-- CreateIndex
CREATE INDEX "purchases_business_line_id_issue_date_idx" ON "purchases"("business_line_id", "issue_date");

-- CreateIndex
CREATE INDEX "purchases_supplier_id_status_idx" ON "purchases"("supplier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_supplier_id_doc_type_series_number_key" ON "purchases"("supplier_id", "doc_type", "series", "number");

-- CreateIndex
CREATE INDEX "purchase_items_purchase_id_idx" ON "purchase_items"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_items_purchase_id_line_number_key" ON "purchase_items"("purchase_id", "line_number");

-- CreateIndex
CREATE INDEX "supplier_payments_purchase_id_idx" ON "supplier_payments"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "coils_code_key" ON "coils"("code");

-- CreateIndex
CREATE UNIQUE INDEX "coils_purchase_item_id_key" ON "coils"("purchase_item_id");

-- CreateIndex
CREATE INDEX "coils_business_line_id_status_idx" ON "coils"("business_line_id", "status");

-- CreateIndex
CREATE INDEX "coils_type_key_idx" ON "coils"("type_key");

-- CreateIndex
CREATE INDEX "coils_supplier_id_idx" ON "coils"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "inventory_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_finish_id_fkey" FOREIGN KEY ("finish_id") REFERENCES "finishes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_business_line_id_fkey" FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_purchase_item_id_fkey" FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_finish_id_fkey" FOREIGN KEY ("finish_id") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_parent_coil_id_fkey" FOREIGN KEY ("parent_coil_id") REFERENCES "coils"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- La cantidad de un movimiento de kardex siempre es positiva: el sentido lo da `type`.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_qty_positive" CHECK ("qty" > 0);

-- Un pago a proveedor siempre es positivo (D-039).
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_positive" CHECK ("amount" > 0);

-- inventory_movements es append-only también a nivel de base de datos (§3.2):
-- anular es insertar el movimiento inverso, nunca UPDATE ni DELETE.
CREATE OR REPLACE FUNCTION inventory_movements_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements es append-only: no se permite %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movements_no_update_delete
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_immutable();
