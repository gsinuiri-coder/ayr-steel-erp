-- ---------------------------------------------------------------------------
-- Sesión 7-final, M0a — la unicidad del comprobante de compra cuenta solo las
-- compras VIVAS (D-132).
--
-- El caso real: una compra registrada con datos errados se anula y hay que
-- volver a registrarla con el mismo número corregido. La unicidad total lo
-- rechazaba como duplicado, y el número de una factura del proveedor no se
-- puede inventar: es el que dice el papel.
--
-- Es RF-72 invertido: allá la versión archivada convive con la vigente porque
-- las dos existieron; acá lo anulado **libera** el número porque dejó de ser
-- un comprobante registrado. Lo que no puede haber es dos compras vivas con el
-- mismo comprobante del mismo proveedor.
-- ---------------------------------------------------------------------------

DROP INDEX "purchases_supplier_id_doc_type_series_number_key";

CREATE UNIQUE INDEX "purchases_supplier_document_live_key"
  ON "purchases"("supplier_id", "doc_type", "series", "number")
  WHERE "status" <> 'CANCELLED';

-- El índice común queda para las búsquedas por documento (el listado filtra por
-- serie y número) y para encontrar cualquier versión anterior, anulada incluida.
CREATE INDEX "purchases_supplier_id_doc_type_series_number_idx"
  ON "purchases"("supplier_id", "doc_type", "series", "number");
