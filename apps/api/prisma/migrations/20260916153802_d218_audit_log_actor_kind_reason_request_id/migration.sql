-- RF-S2/M1 (D-218): extiende audit_log en vez de crear una tabla `audit_events` en paralelo.
--
-- audit_log ya existe desde Fase 1 (RF-95), ya tiene trigger de inmutabilidad a nivel de base
-- (audit_log_no_update_delete, migración 20260902170000) y ya está instrumentado en ~80
-- puntos de todo el dominio. Crear una tabla nueva habría fragmentado ese rastro. Esta
-- migración es additive pura: tres columnas nuevas (con default/nullable para no romper las
-- filas ya escritas) y dos índices. Escrita a mano por el mismo motivo que D-211/D-216/D-217:
-- producción está en uso real y el drift conocido entre schema.prisma y las migraciones no
-- es de esta sesión.

CREATE TYPE "AuditActorKind" AS ENUM ('USER', 'SYSTEM');

ALTER TABLE "audit_log" ADD COLUMN "actor_kind" "AuditActorKind" NOT NULL DEFAULT 'USER';
ALTER TABLE "audit_log" ADD COLUMN "reason" VARCHAR(500);
ALTER TABLE "audit_log" ADD COLUMN "request_id" UUID;

-- El índice (entity, entity_id) queda subsumido por el nuevo compuesto: toda consulta que
-- filtraba por esas dos columnas sigue sirviéndose de sus primeras dos, y el visor (M3) que
-- ordena por fecha dentro de una entidad gana el tercer campo sin un índice aparte.
DROP INDEX "audit_log_entity_entity_id_idx";
CREATE INDEX "audit_log_entity_entity_id_at_idx" ON "audit_log"("entity", "entity_id", "at");

-- Para el visor sin filtro de entidad ni de actor (solo rango de fechas).
CREATE INDEX "audit_log_at_idx" ON "audit_log"("at");
