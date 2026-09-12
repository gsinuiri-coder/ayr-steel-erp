-- D-182 (F8-S1/M2) — deduplicación de creaciones repetibles.
--
-- Un reporte de producción o un cobro son eventos de negocio legítimos si se repiten
-- (dos tandas iguales de piezas, dos cobros iguales), así que el guardrail no puede ser
-- de estado como en una transición (confirmar, emitir, despachar) — ahí no hay un
-- "segundo estado" que rechazar. Lo que hay que impedir es que el MISMO intento de
-- submit (doble click, reintento de red) llegue dos veces al servidor y ejecute el
-- efecto dos veces. `key` la genera el cliente una vez por intento.
CREATE TABLE "idempotency_keys" (
  "key"         VARCHAR(100)   NOT NULL,
  "scope"       VARCHAR(60)    NOT NULL,
  "resource_id" UUID           NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);
