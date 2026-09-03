-- AlterTable
ALTER TABLE "supplier_payments" ADD COLUMN     "reversed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reversed_by_id" UUID;
