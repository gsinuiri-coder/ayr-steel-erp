-- D-205 (F8-S5/M1) — el comprobante que cubre un despacho, cuando se conoce sin ambigüedad al
-- emitirlo.
--
-- `inventory_movements` es append-only de verdad: un trigger en la base rechaza cualquier
-- UPDATE (TRUNCATE aparte, que no dispara triggers de fila), así que el enlace no puede vivir
-- ahí. Vive en `dispatches`, que sí se edita (mismo lugar que su `status`) — y de paso es la
-- forma correcta del dato: un despacho con varias líneas comparte un solo comprobante.
--
-- Aditiva y nullable: solo el mostrador (D-099) la llena hoy, porque es el único punto que
-- arma un despacho y un comprobante uno a uno, en la misma transacción, sin adivinar qué
-- despacho factura. El flujo estándar de facturación factura por `sales_order_id` sin decir
-- qué despacho cubre —un pedido puede tener varios despachos parciales—, así que ahí la
-- columna queda NULL a propósito.
ALTER TABLE "dispatches" ADD COLUMN "invoice_id" UUID;

ALTER TABLE "dispatches"
  ADD CONSTRAINT "dispatches_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "dispatches_invoice_id_idx" ON "dispatches"("invoice_id");
