-- D-185 (F8-S2/M2) — reserva temporal sobre una cotización emitida.
--
-- El material se aparta mientras el cliente deposita, sin crear el pedido. Tabla aparte del
-- ledger firme (`reservations` cuelga siempre de un pedido); toda suma de disponible del API
-- suma las dos. La expiración es perezosa: no hay job, una fila `ACTIVE` con `expires_at`
-- vencido cuenta como liberada en toda lectura.
CREATE TYPE "TemporaryReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED');

CREATE TABLE "quotation_reservations" (
  "id"             UUID                         NOT NULL,
  "quotation_id"   UUID                         NOT NULL,
  "line_number"    INTEGER                      NOT NULL,
  "item_type"      "InventoryItemType"          NOT NULL,
  "item_id"        UUID                         NOT NULL,
  "qty"            DECIMAL(16,3)                NOT NULL,
  "unit"           VARCHAR(20)                  NOT NULL,
  "status"         "TemporaryReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at"     TIMESTAMPTZ(3)               NOT NULL,
  "created_by_id"  UUID                         NOT NULL,
  "created_at"     TIMESTAMPTZ(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"       TIMESTAMPTZ(3),
  "ended_by_id"    UUID,
  "end_reason"     VARCHAR(240),
  "sales_order_id" UUID,

  CONSTRAINT "quotation_reservations_pkey" PRIMARY KEY ("id"),
  -- Lo mismo que el ledger firme: nunca se promete una cantidad nula o negativa.
  CONSTRAINT "quotation_reservations_qty_positive_ck" CHECK ("qty" > 0),
  -- Terminada = tiene fecha de fin; vigente = no la tiene. Sin esto, una fila podía quedar
  -- `RELEASED` sin decir cuándo, que es justo lo que el append-only existe para contar.
  CONSTRAINT "quotation_reservations_ended_ck" CHECK (("status" = 'ACTIVE') = ("ended_at" IS NULL))
);

ALTER TABLE "quotation_reservations"
  ADD CONSTRAINT "quotation_reservations_quotation_id_fkey"
  FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "quotation_reservations_item_type_item_id_status_expires_at_idx"
  ON "quotation_reservations"("item_type", "item_id", "status", "expires_at");
CREATE INDEX "quotation_reservations_quotation_id_status_idx"
  ON "quotation_reservations"("quotation_id", "status");
CREATE INDEX "quotation_reservations_status_expires_at_idx"
  ON "quotation_reservations"("status", "expires_at");

-- Configuración comercial (una sola fila). Sin fila, rigen los defectos de `@ayr/shared`, así
-- que la migración no siembra nada y un reset de la base no deja la pantalla sin dato.
CREATE TABLE "sales_settings" (
  "id"                                  INTEGER        NOT NULL DEFAULT 1,
  "temporary_reservation_business_days" INTEGER        NOT NULL,
  "updated_by_id"                       UUID,
  "updated_at"                          TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "sales_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_settings_singleton_ck" CHECK ("id" = 1),
  CONSTRAINT "sales_settings_business_days_ck" CHECK ("temporary_reservation_business_days" BETWEEN 1 AND 30)
);
