-- D-191 (F8-S3/M3) — borrador server-side de reportes por orden de producción.
--
-- Filas staged: cada una es un reporte que todavía no se ejecutó (bobina, largos y kilo
-- declarado opcional). No mueven kardex ni reservas; ejecutar el borrador las convierte en
-- reportes en una sola transacción y las borra. Tablas nuevas, aditivas; no tocan filas
-- existentes.
CREATE TABLE "production_report_drafts" (
  "id"                  UUID           NOT NULL,
  "seq"                 SERIAL         NOT NULL,
  "production_order_id" UUID           NOT NULL,
  "coil_id"             UUID           NOT NULL,
  "consumed_kg"         DECIMAL(12,3),
  "notes"               VARCHAR(240),
  "created_by_id"       UUID           NOT NULL,
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_report_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_report_drafts_seq_key" ON "production_report_drafts"("seq");
CREATE INDEX "production_report_drafts_production_order_id_seq_idx"
  ON "production_report_drafts"("production_order_id", "seq");

ALTER TABLE "production_report_drafts"
  ADD CONSTRAINT "production_report_drafts_production_order_id_fkey"
  FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_report_drafts"
  ADD CONSTRAINT "production_report_drafts_coil_id_fkey"
  FOREIGN KEY ("coil_id") REFERENCES "coils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "production_report_draft_pieces" (
  "id"          UUID          NOT NULL,
  "draft_id"    UUID          NOT NULL,
  "line_number" INTEGER       NOT NULL,
  "length_mm"   DECIMAL(8,2)  NOT NULL,
  "qty"         INTEGER       NOT NULL,

  CONSTRAINT "production_report_draft_pieces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_report_draft_pieces_draft_id_line_number_key"
  ON "production_report_draft_pieces"("draft_id", "line_number");

ALTER TABLE "production_report_draft_pieces"
  ADD CONSTRAINT "production_report_draft_pieces_draft_id_fkey"
  FOREIGN KEY ("draft_id") REFERENCES "production_report_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
