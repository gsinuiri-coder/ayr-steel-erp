-- F8-S7/M1: registro de correcciones de la fecha de emisión de un comprobante MANUAL.
--
-- Additive pura: crea una tabla nueva y nada más. Escrita a mano a propósito — `migrate dev`
-- arrastraba, además de esto, el drift preexistente entre `schema.prisma` y las migraciones
-- (dos índices, cinco `DEFAULT` de `operation_date`, un índice renombrado y cuatro FK
-- recreadas). Ese drift no es de esta sesión y no se toca acá: producción está en uso real y
-- una sesión de pulido no le cambia índices ni defaults de paso. Queda reportado aparte.

-- CreateTable
CREATE TABLE "fiscal_document_issue_date_changes" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "before_issue_date" DATE NOT NULL,
    "after_issue_date" DATE NOT NULL,
    "before_due_date" DATE,
    "after_due_date" DATE,
    "reason" VARCHAR(200) NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_document_issue_date_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_document_issue_date_changes_document_id_changed_at_idx" ON "fiscal_document_issue_date_changes"("document_id", "changed_at");

-- AddForeignKey
ALTER TABLE "fiscal_document_issue_date_changes" ADD CONSTRAINT "fiscal_document_issue_date_changes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
