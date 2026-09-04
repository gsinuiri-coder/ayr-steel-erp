-- CreateEnum
CREATE TYPE "FiscalDocType" AS ENUM ('FACTURA', 'BOLETA', 'NOTA_CREDITO', 'GUIA_REMISION_REMITENTE');

-- CreateEnum
CREATE TYPE "FiscalDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'SEND_ERROR', 'VOID_PENDING', 'VOIDED');

-- CreateEnum
CREATE TYPE "CreditNoteReason" AS ENUM ('ANULACION_OPERACION', 'ANULACION_ERROR_RUC', 'CORRECCION_DESCRIPCION', 'DESCUENTO_GLOBAL', 'DESCUENTO_ITEM', 'DEVOLUCION_TOTAL', 'DEVOLUCION_ITEM', 'OTROS_AJUSTES');

-- CreateEnum
CREATE TYPE "TransferMode" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('ISSUED', 'REVERSED');

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'PARTIALLY_FULFILLED';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "is_system" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "fiscal_series" (
    "id" UUID NOT NULL,
    "doc_type" "FiscalDocType" NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "affected_doc_type" "FiscalDocType",
    "correlative" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoicing_settings" (
    "id" UUID NOT NULL,
    "provider_offline" BOOLEAN NOT NULL DEFAULT false,
    "alert_after_hours" INTEGER NOT NULL DEFAULT 6,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoicing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" UUID NOT NULL,
    "doc_type" "FiscalDocType" NOT NULL,
    "status" "FiscalDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "series_id" UUID,
    "correlative" INTEGER,
    "number" VARCHAR(20),
    "customer_id" UUID NOT NULL,
    "sales_order_id" UUID,
    "dispatch_id" UUID,
    "affected_document_id" UUID,
    "credit_note_reason" "CreditNoteReason",
    "replaces_document_id" UUID,
    "issue_date" DATE NOT NULL,
    "payment_terms" "PaymentTerms" NOT NULL DEFAULT 'CONTADO',
    "due_date" DATE,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "detraction_code" VARCHAR(10),
    "detraction_pct" DECIMAL(6,2),
    "detraction_amount_pen" DECIMAL(18,4),
    "generic_customer_override_by_id" UUID,
    "notes" VARCHAR(500),
    "provider_response" JSONB,
    "provider_ticket" VARCHAR(80),
    "sunat_hash" VARCHAR(120),
    "rejection_code" VARCHAR(20),
    "rejection_message" VARCHAR(500),
    "pdf_key" VARCHAR(300),
    "xml_key" VARCHAR(300),
    "cdr_key" VARCHAR(300),
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_send_error" VARCHAR(500),
    "last_attempt_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "void_requested_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_document_items" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID,
    "description" VARCHAR(240) NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "unit_price_pen" DECIMAL(18,4) NOT NULL,
    "subtotal_pen" DECIMAL(18,4) NOT NULL,
    "igv_pen" DECIMAL(18,4) NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "sales_order_item_id" UUID,
    "affected_item_id" UUID,

    CONSTRAINT "fiscal_document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'ISSUED',
    "dispatch_date" DATE NOT NULL,
    "origin_address" VARCHAR(240) NOT NULL,
    "destination_address" VARCHAR(240) NOT NULL,
    "transfer_mode" "TransferMode" NOT NULL,
    "total_weight_kg" DECIMAL(16,3) NOT NULL,
    "package_count" INTEGER,
    "vehicle_plate" VARCHAR(10),
    "driver_name" VARCHAR(160),
    "driver_doc_type" "DocType",
    "driver_doc_number" VARCHAR(20),
    "driver_license" VARCHAR(20),
    "carrier_doc_number" VARCHAR(20),
    "carrier_name" VARCHAR(160),
    "notes" VARCHAR(500),
    "created_by_id" UUID NOT NULL,
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_items" (
    "id" UUID NOT NULL,
    "dispatch_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "description" VARCHAR(240) NOT NULL,
    "qty" DECIMAL(16,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "weight_kg" DECIMAL(16,3) NOT NULL,
    "item_type" "InventoryItemType" NOT NULL,
    "item_id" UUID NOT NULL,
    "movement_id" BIGINT,

    CONSTRAINT "dispatch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payments" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "amount_pen" DECIMAL(18,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" VARCHAR(120),
    "created_by_id" UUID NOT NULL,
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_series_series_key" ON "fiscal_series"("series");

-- CreateIndex
CREATE INDEX "fiscal_series_doc_type_is_active_idx" ON "fiscal_series"("doc_type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_number_key" ON "fiscal_documents"("number");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_replaces_document_id_key" ON "fiscal_documents"("replaces_document_id");

-- CreateIndex
CREATE INDEX "fiscal_documents_status_doc_type_idx" ON "fiscal_documents"("status", "doc_type");

-- CreateIndex
CREATE INDEX "fiscal_documents_customer_id_status_idx" ON "fiscal_documents"("customer_id", "status");

-- CreateIndex
CREATE INDEX "fiscal_documents_sales_order_id_idx" ON "fiscal_documents"("sales_order_id");

-- CreateIndex
CREATE INDEX "fiscal_documents_dispatch_id_idx" ON "fiscal_documents"("dispatch_id");

-- CreateIndex
CREATE INDEX "fiscal_documents_affected_document_id_idx" ON "fiscal_documents"("affected_document_id");

-- CreateIndex
CREATE INDEX "fiscal_documents_status_issued_at_idx" ON "fiscal_documents"("status", "issued_at");

-- CreateIndex
CREATE INDEX "fiscal_document_items_document_id_idx" ON "fiscal_document_items"("document_id");

-- CreateIndex
CREATE INDEX "fiscal_document_items_sales_order_item_id_idx" ON "fiscal_document_items"("sales_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_document_items_document_id_line_number_key" ON "fiscal_document_items"("document_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_seq_key" ON "dispatches"("seq");

-- CreateIndex
CREATE INDEX "dispatches_sales_order_id_status_idx" ON "dispatches"("sales_order_id", "status");

-- CreateIndex
CREATE INDEX "dispatches_status_dispatch_date_idx" ON "dispatches"("status", "dispatch_date");

-- CreateIndex
CREATE INDEX "dispatch_items_dispatch_id_idx" ON "dispatch_items"("dispatch_id");

-- CreateIndex
CREATE INDEX "dispatch_items_sales_order_item_id_idx" ON "dispatch_items"("sales_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_items_dispatch_id_line_number_key" ON "dispatch_items"("dispatch_id", "line_number");

-- CreateIndex
CREATE INDEX "customer_payments_document_id_idx" ON "customer_payments"("document_id");

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "fiscal_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "dispatches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_affected_document_id_fkey" FOREIGN KEY ("affected_document_id") REFERENCES "fiscal_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_replaces_document_id_fkey" FOREIGN KEY ("replaces_document_id") REFERENCES "fiscal_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "fiscal_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_affected_item_id_fkey" FOREIGN KEY ("affected_item_id") REFERENCES "fiscal_document_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "dispatches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas que Prisma no expresa (§3.3): invariantes de forma en la base misma.
-- ---------------------------------------------------------------------------

-- D-072: una sola serie **activa** por combinación tipo/tipo afectado. Un `@@unique` de
-- Prisma no sirve: Postgres trata los NULL como distintos, así que dos filas
-- (FACTURA, NULL) no chocarían entre sí.
-- Dos índices y no uno con COALESCE: castear un enum a texto no es IMMUTABLE y
-- Postgres no lo admite dentro de una expresión de índice.
CREATE UNIQUE INDEX "fiscal_series_active_key"
  ON "fiscal_series" ("doc_type")
  WHERE "is_active" AND "affected_doc_type" IS NULL;

CREATE UNIQUE INDEX "fiscal_series_active_affected_key"
  ON "fiscal_series" ("doc_type", "affected_doc_type")
  WHERE "is_active" AND "affected_doc_type" IS NOT NULL;

-- D-071/D-073: la guía de remisión comparte tabla con los comprobantes de pago, pero no
-- es uno: no lleva importes y siempre documenta un despacho. Y al revés, un comprobante
-- de pago nunca apunta a un despacho — lo que factura son líneas de pedido, no bultos.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_shape_ck" CHECK (
  ("doc_type" = 'GUIA_REMISION_REMITENTE'
     AND "dispatch_id" IS NOT NULL
     AND "subtotal_pen" = 0 AND "igv_pen" = 0 AND "total_pen" = 0)
  OR
  ("doc_type" <> 'GUIA_REMISION_REMITENTE' AND "dispatch_id" IS NULL)
);

-- D-072: el motivo del catálogo 09 y el comprobante afectado van juntos, y solo en una
-- nota de crédito. Una NC sin documento afectado no es emitible, y el PSE la rechazaría
-- después de haberle gastado un correlativo.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_credit_note_ck" CHECK (
  ("doc_type" = 'NOTA_CREDITO' AND "affected_document_id" IS NOT NULL AND "credit_note_reason" IS NOT NULL)
  OR
  ("doc_type" <> 'NOTA_CREDITO' AND "affected_document_id" IS NULL AND "credit_note_reason" IS NULL)
);

-- D-072: serie, correlativo y número se asignan los tres juntos, al enviar. Un documento
-- con serie y sin correlativo sería un número a medias, que es peor que no tener ninguno.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_number_ck" CHECK (
  ("series_id" IS NULL AND "correlative" IS NULL AND "number" IS NULL)
  OR
  ("series_id" IS NOT NULL AND "correlative" IS NOT NULL AND "correlative" > 0 AND "number" IS NOT NULL)
);

-- Los importes de un comprobante nunca son negativos: una nota de crédito resta por ser
-- una NC, no por llevar el signo adentro (mismo criterio que el kardex, donde el sentido
-- lo da `type` y no el signo de `qty`).
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_amounts_ck" CHECK (
  "subtotal_pen" >= 0 AND "igv_pen" >= 0 AND "total_pen" >= 0
);

ALTER TABLE "fiscal_document_items" ADD CONSTRAINT "fiscal_document_items_qty_ck" CHECK (
  "qty" > 0 AND "unit_price_pen" >= 0 AND "subtotal_pen" >= 0 AND "igv_pen" >= 0 AND "total_pen" >= 0
);

-- D-078: la modalidad decide qué datos de transporte son obligatorios. Sin esto, una guía
-- privada sin placa o una pública sin transportista llegan hasta el PSE y vuelven
-- rechazadas con el correlativo ya gastado (D-072).
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_transport_ck" CHECK (
  ("transfer_mode" = 'PRIVATE'
     AND "vehicle_plate" IS NOT NULL AND "driver_name" IS NOT NULL
     AND "driver_doc_type" IS NOT NULL AND "driver_doc_number" IS NOT NULL
     AND "driver_license" IS NOT NULL
     AND "carrier_doc_number" IS NULL AND "carrier_name" IS NULL)
  OR
  ("transfer_mode" = 'PUBLIC'
     AND "carrier_doc_number" IS NOT NULL AND "carrier_name" IS NOT NULL
     AND "vehicle_plate" IS NULL AND "driver_name" IS NULL
     AND "driver_doc_type" IS NULL AND "driver_doc_number" IS NULL
     AND "driver_license" IS NULL)
);

ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_weight_ck" CHECK ("total_weight_kg" > 0);

ALTER TABLE "dispatch_items" ADD CONSTRAINT "dispatch_items_qty_ck" CHECK (
  "qty" > 0 AND "weight_kg" >= 0
);

-- D-075: un cobro de cero o negativo no es un cobro. Mismo criterio que el kardex.
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amount_ck" CHECK ("amount_pen" > 0);

-- ---------------------------------------------------------------------------
-- Datos iniciales
-- ---------------------------------------------------------------------------

-- D-072: series del punto de emisión. Un solo punto de emisión en v1; la NC hereda la
-- serie del tipo de comprobante que afecta (FC01 para facturas, BC01 para boletas).
INSERT INTO "fiscal_series" ("id", "doc_type", "series", "affected_doc_type", "correlative", "is_active", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'FACTURA',                 'F001', NULL,      0, true, NOW(), NOW()),
  (gen_random_uuid(), 'BOLETA',                  'B001', NULL,      0, true, NOW(), NOW()),
  (gen_random_uuid(), 'NOTA_CREDITO',            'FC01', 'FACTURA', 0, true, NOW(), NOW()),
  (gen_random_uuid(), 'NOTA_CREDITO',            'BC01', 'BOLETA',  0, true, NOW(), NOW()),
  (gen_random_uuid(), 'GUIA_REMISION_REMITENTE', 'T001', NULL,      0, true, NOW(), NOW())
ON CONFLICT ("series") DO NOTHING;

-- D-073: fila única de configuración del módulo. Nace con el PSE en línea y el umbral de
-- alerta en 6 horas.
INSERT INTO "invoicing_settings" ("id", "provider_offline", "alert_after_hours", "updated_at")
SELECT gen_random_uuid(), false, 6, NOW()
WHERE NOT EXISTS (SELECT 1 FROM "invoicing_settings");

-- D-077: cliente "público en general" para la boleta de venta menor sin documento.
-- `is_system` lo hace inmutable: ninguna ruta lo edita ni lo da de baja.
INSERT INTO "customers" ("id", "doc_type", "doc_number", "name", "address", "credit_days", "is_system", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'DNI', '00000000', 'PÚBLICO EN GENERAL', NULL, 0, true, true, NOW(), NOW())
ON CONFLICT ("doc_type", "doc_number") DO UPDATE SET "is_system" = true;
