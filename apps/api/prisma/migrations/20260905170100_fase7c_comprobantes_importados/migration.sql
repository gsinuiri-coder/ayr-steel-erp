-- ---------------------------------------------------------------------------
-- Fase 7, tramo 3 — importación de comprobantes ya emitidos (RF-71, RF-72).
-- D-105 (origen), D-106 (serie del importado), D-108 (reimportar archiva).
-- ---------------------------------------------------------------------------

-- D-105: de dónde salió el documento. Todo lo que ya existe se emitió acá.
CREATE TYPE "FiscalDocumentOrigin" AS ENUM ('ISSUED_HERE', 'IMPORTED');

ALTER TABLE "fiscal_documents"
  ADD COLUMN "origin" "FiscalDocumentOrigin" NOT NULL DEFAULT 'ISSUED_HERE',
  ADD COLUMN "supersedes_document_id" UUID,
  ADD COLUMN "archived_at" TIMESTAMPTZ(3);

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_supersedes_document_id_fkey" FOREIGN KEY ("supersedes_document_id") REFERENCES "fiscal_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "fiscal_documents_supersedes_document_id_key" ON "fiscal_documents"("supersedes_document_id");

-- RF-72: la unicidad del número pasa a ser **parcial**. Una reimportación deja conviviendo
-- la versión archivada y la vigente con el mismo `F001-00000123`; lo que no puede haber es
-- dos vigentes. El índice completo se reemplaza por uno sobre las no archivadas más un
-- índice común, que es el que usa el importador para encontrar cualquier versión anterior.
DROP INDEX "fiscal_documents_number_key";

CREATE UNIQUE INDEX "fiscal_documents_number_active_key" ON "fiscal_documents"("number") WHERE "archived_at" IS NULL;

CREATE INDEX "fiscal_documents_number_idx" ON "fiscal_documents"("number");

-- D-108: archivar es privativo de la reimportación, y solo se reimporta lo importado. Un
-- comprobante emitido acá nunca queda archivado ni archiva a otro — su corrección es la
-- reemisión de D-072, que ya tiene su propio par de columnas.
--
-- Las dos puntas viven en filas distintas (la archivada lleva `archived_at`, la nueva lleva
-- `supersedes_document_id`), así que un CHECK no puede exigir que aparezcan juntas: eso lo
-- sostiene la transacción de `FiscalImportService`. Acá se ata lo que sí es por fila.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_archive_ck" CHECK (
  ("archived_at" IS NULL AND "supersedes_document_id" IS NULL)
  OR "origin" = 'IMPORTED'
);
