-- cc58 (D-676): los tres índices de rendimiento de cc57 (E-14 de audit-01). OK del dueño por nombre
-- (D-460) a la migración «índices de rendimiento de cc57». Solo índices: no cambia ningún dato.
-- El índice único parcial del segundo 02 (D-07) NO va: el dueño decidió que un 02 no se repite.

-- CreateIndex
CREATE INDEX "fiscal_documents_issue_date_idx" ON "fiscal_documents"("issue_date");

-- CreateIndex
CREATE INDEX "dispatch_items_movement_id_idx" ON "dispatch_items"("movement_id");

-- CreateIndex
CREATE INDEX "customer_payments_document_id_reversed_at_idx" ON "customer_payments"("document_id", "reversed_at");
