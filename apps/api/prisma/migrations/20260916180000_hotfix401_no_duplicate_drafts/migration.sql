-- HOTFIX-401/M2: un pedido no puede tener más de un borrador de comprobante abierto para
-- "todo el pedido" (sin despacho declarado) a la vez, ni más de un borrador por despacho
-- declarado (D-213). Additive: dos índices únicos parciales, nada se borra ni se modifica.
--
-- Una nota de crédito queda fuera a propósito: cuelga del mismo pedido que la factura que
-- afecta (F8-S7/M3, `salesOrderId` heredado), pero es un documento distinto — un pedido
-- puede necesitar, al mismo tiempo, un borrador de factura sin despacho Y un borrador de
-- nota de crédito contra un comprobante ya emitido de ese pedido. Sin esta exclusión, crear
-- la segunda reventaba con "P2002 sales_order_id" — encontrado corriendo la suite E2E
-- existente contra esta migración antes de darla por cerrada.
--
-- Seguro antes de aplicar: la transacción aborta con un mensaje claro si ya hay duplicados
-- en la base, en vez de fallar a mitad de crear el índice con un error críptico de Postgres.
-- Si esto revienta, el dueño descarta los borradores sobrantes desde la pantalla del
-- comprobante ("Descartar borrador") y se reintenta la migración.

DO $$
DECLARE
  dup_orders integer;
  dup_dispatches integer;
BEGIN
  SELECT COUNT(*) INTO dup_orders FROM (
    SELECT "sales_order_id"
    FROM "fiscal_documents"
    WHERE "status" = 'DRAFT' AND "dispatch_id" IS NULL AND "sales_order_id" IS NOT NULL
      AND "doc_type" <> 'NOTA_CREDITO'
    GROUP BY "sales_order_id"
    HAVING COUNT(*) > 1
  ) t;
  IF dup_orders > 0 THEN
    RAISE EXCEPTION 'Hay % pedido(s) con más de un borrador de comprobante sin despacho declarado. Descarta los sobrantes desde "Descartar borrador" en cada comprobante y reintenta esta migración.', dup_orders;
  END IF;

  SELECT COUNT(*) INTO dup_dispatches FROM (
    SELECT "sales_order_id", "dispatch_id"
    FROM "fiscal_documents"
    WHERE "status" = 'DRAFT' AND "dispatch_id" IS NOT NULL AND "doc_type" <> 'NOTA_CREDITO'
    GROUP BY "sales_order_id", "dispatch_id"
    HAVING COUNT(*) > 1
  ) t;
  IF dup_dispatches > 0 THEN
    RAISE EXCEPTION 'Hay % despacho(s) con más de un borrador de comprobante. Descarta los sobrantes desde "Descartar borrador" en cada comprobante y reintenta esta migración.', dup_dispatches;
  END IF;
END $$;

CREATE UNIQUE INDEX "fiscal_documents_draft_order_unique"
  ON "fiscal_documents" ("sales_order_id")
  WHERE "status" = 'DRAFT' AND "dispatch_id" IS NULL AND "sales_order_id" IS NOT NULL
    AND "doc_type" <> 'NOTA_CREDITO';

CREATE UNIQUE INDEX "fiscal_documents_draft_order_dispatch_unique"
  ON "fiscal_documents" ("sales_order_id", "dispatch_id")
  WHERE "status" = 'DRAFT' AND "dispatch_id" IS NOT NULL AND "doc_type" <> 'NOTA_CREDITO';
