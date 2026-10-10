ALTER TABLE "production_report_drafts"
  ADD COLUMN "meters" DECIMAL(12,3),
  ADD COLUMN "pieces_count" INTEGER;
ALTER TABLE "production_report_drafts"
  ADD CONSTRAINT "production_report_drafts_meters_check"
    CHECK ("meters" IS NULL OR "meters" > 0),
  ADD CONSTRAINT "production_report_drafts_pieces_count_check"
    CHECK ("pieces_count" IS NULL OR ("meters" IS NOT NULL AND "pieces_count" >= 0));
