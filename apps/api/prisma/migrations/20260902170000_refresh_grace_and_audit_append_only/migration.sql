-- Gracia para rotación de refresh token (tolera refresh concurrentes)
ALTER TABLE "sessions" ADD COLUMN "previous_token_hash" VARCHAR(128);
ALTER TABLE "sessions" ADD COLUMN "rotated_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "sessions_previous_token_hash_key" ON "sessions"("previous_token_hash");

-- audit_log es append-only también a nivel de base de datos (RF-95)
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es inmutable: no se permite % ', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
