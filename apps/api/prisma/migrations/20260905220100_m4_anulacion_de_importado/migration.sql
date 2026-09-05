-- ---------------------------------------------------------------------------
-- Sesión M-4 — anulación interna de un comprobante importado (D-110).
--
-- Hasta acá, un `fiscal_document` con `origin = IMPORTED` no tenía **ningún** camino de
-- vuelta: nace `ACCEPTED` con su cuenta por cobrar y el PSE no lo conoce (D-105), así que
-- ni la baja ni la nota de crédito lo alcanzan. Un importado equivocado era deuda falsa
-- permanente. Es la cuarta vez que el proyecto se topa con lo mismo (D-061, D-088, D-097):
-- la reversa se construye en la misma fase que lo que revierte, o no se construye.
-- ---------------------------------------------------------------------------

ALTER TABLE "fiscal_documents"
  ADD COLUMN "annulled_at" TIMESTAMPTZ(3),
  ADD COLUMN "annulled_by_id" UUID,
  ADD COLUMN "annul_reason" VARCHAR(240);

-- Las tres columnas van juntas o no van: una anulación sin autor ni motivo no es auditable
-- (RF-95), y un motivo sin fecha es una fila a medio escribir.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_annul_shape_ck" CHECK (
  ("annulled_at" IS NULL AND "annulled_by_id" IS NULL AND "annul_reason" IS NULL)
  OR ("annulled_at" IS NOT NULL AND "annulled_by_id" IS NOT NULL AND "annul_reason" IS NOT NULL)
);

-- El estado y el origen no se pueden separar: `ANNULLED` es privativo de un importado, y un
-- comprobante que el ERP emitió sigue el camino fiscal de D-072 (baja o nota de crédito ante
-- SUNAT). Sin este CHECK, un `UPDATE` a mano podría hacer desaparecer del balance una deuda
-- real sin que SUNAT se enterara, que es justo lo que la anulación interna **no** es.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_annulled_origin_ck" CHECK (
  "status" <> 'ANNULLED' OR "origin" = 'IMPORTED'
);

-- Y al revés: si está anulado, tiene que tener su constancia.
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_annulled_trace_ck" CHECK (
  "status" <> 'ANNULLED' OR "annulled_at" IS NOT NULL
);
