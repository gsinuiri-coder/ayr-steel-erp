-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PosSaleStatus" AS ENUM ('ACTIVE', 'VOIDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'CARD';
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "user_id" UUID NOT NULL,
    "open_user_id" UUID,
    "opening_amount_pen" DECIMAL(18,4) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_notes" VARCHAR(500),
    "expected_cash_pen" DECIMAL(18,4),
    "counted_cash_pen" DECIMAL(18,4),
    "difference_pen" DECIMAL(18,4),
    "closing_notes" VARCHAR(500),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_sales" (
    "id" UUID NOT NULL,
    "seq" SERIAL NOT NULL,
    "status" "PosSaleStatus" NOT NULL DEFAULT 'ACTIVE',
    "cash_session_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "dispatch_id" UUID NOT NULL,
    "fiscal_document_id" UUID NOT NULL,
    "customer_payment_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "total_pen" DECIMAL(18,4) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_by_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" VARCHAR(500),

    CONSTRAINT "pos_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_seq_key" ON "cash_sessions"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_open_user_id_key" ON "cash_sessions"("open_user_id");

-- CreateIndex
CREATE INDEX "cash_sessions_user_id_status_idx" ON "cash_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "cash_sessions_status_opened_at_idx" ON "cash_sessions"("status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sales_seq_key" ON "pos_sales"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sales_sales_order_id_key" ON "pos_sales"("sales_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sales_dispatch_id_key" ON "pos_sales"("dispatch_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sales_fiscal_document_id_key" ON "pos_sales"("fiscal_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_sales_customer_payment_id_key" ON "pos_sales"("customer_payment_id");

-- CreateIndex
CREATE INDEX "pos_sales_cash_session_id_status_idx" ON "pos_sales"("cash_session_id", "status");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "cash_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_dispatch_id_fkey" FOREIGN KEY ("dispatch_id") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_fiscal_document_id_fkey" FOREIGN KEY ("fiscal_document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_customer_payment_id_fkey" FOREIGN KEY ("customer_payment_id") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariantes de forma (mismo criterio que `fiscal_documents_shape_ck` de Fase 5b):
-- lo que tiene que ir junto, va junto, y lo dice la base y no solo el servicio.
-- ---------------------------------------------------------------------------

-- El candado de "un turno abierto por usuario" (D-101). `open_user_id` vale `user_id`
-- si y solo si el turno está `OPEN`; el índice único de Prisma sobre esa columna hace
-- el resto, porque Postgres no cuenta los nulos.
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_open_slot_ck" CHECK (
  ("status" = 'OPEN'  AND "open_user_id" = "user_id") OR
  ("status" = 'CLOSED' AND "open_user_id" IS NULL)
);

-- Un turno cerrado tiene arqueo completo; uno abierto no tiene ninguno. Sin esto, un
-- cierre a medias dejaría una caja con diferencia registrada y sin esperado contra el
-- cual leerla — el número que el cajero firma.
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_arqueo_ck" CHECK (
  ("status" = 'CLOSED'
     AND "expected_cash_pen" IS NOT NULL
     AND "counted_cash_pen" IS NOT NULL
     AND "difference_pen" IS NOT NULL
     AND "closed_at" IS NOT NULL
     AND "closed_by_id" IS NOT NULL)
  OR
  ("status" = 'OPEN'
     AND "expected_cash_pen" IS NULL
     AND "counted_cash_pen" IS NULL
     AND "difference_pen" IS NULL
     AND "closing_notes" IS NULL
     AND "closed_at" IS NULL
     AND "closed_by_id" IS NULL)
);

-- Una diferencia sin motivo es justo lo que el arqueo existe para no permitir (D-101).
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_difference_reason_ck" CHECK (
  "difference_pen" IS NULL OR "difference_pen" = 0 OR "closing_notes" IS NOT NULL
);

-- El monto de apertura y el total de una venta nunca son negativos.
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opening_ck" CHECK ("opening_amount_pen" >= 0);
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_counted_ck" CHECK ("counted_cash_pen" IS NULL OR "counted_cash_pen" >= 0);
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_total_ck" CHECK ("total_pen" > 0);

-- Anular deja las tres marcas juntas, igual que `cancelled_by_id`/`cancelled_at` del pedido.
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_void_ck" CHECK (
  ("status" = 'VOIDED' AND "voided_by_id" IS NOT NULL AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL)
  OR
  ("status" = 'ACTIVE' AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
);
