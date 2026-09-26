-- D-328 (correcciones 04, tanda B / M6) — el film de protección de la bobina.
--
-- La bobina nueva llega con el film puesto («Sellada»); «Abrir» es quitarlo para empezar a
-- usarla («Abierta»). Es un eje **aparte** de `coils.status` (OPEN/CLOSED, que en pantalla pasa a
-- llamarse «Terminada»): no cambia ni se reescribe ningún estado existente.
--
-- Migración **aditiva**: una tabla nueva, dos enums nuevos y una columna con default sobre
-- `coils`. Ninguna fila existente se toca — todas quedan «selladas» hasta que el backfill
-- (`pnpm backfill:film`, con dry-run y OK del dueño) deduzca cuáles se abrieron.

-- CreateEnum
CREATE TYPE "CoilFilmEventType" AS ENUM ('OPENED', 'RESEALED');

-- CreateEnum
CREATE TYPE "CoilFilmSource" AS ENUM (
  'MANUAL', 'MOUNT', 'MOUNT_UNDO', 'SCRAP', 'SPLIT', 'CUTTING_SEND', 'CUTTING_UNDO', 'BIRTH', 'BACKFILL'
);

-- AlterTable
ALTER TABLE "coils" ADD COLUMN "film_sealed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "coil_film_events" (
    "id" UUID NOT NULL,
    "coil_id" UUID NOT NULL,
    "type" "CoilFilmEventType" NOT NULL,
    "source" "CoilFilmSource" NOT NULL,
    "operation_date" DATE NOT NULL,
    "reason" VARCHAR(240),
    "ref_id" VARCHAR(80),
    "actor_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coil_film_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coil_film_events_coil_id_operation_date_at_idx" ON "coil_film_events"("coil_id", "operation_date", "at");

-- CreateIndex
CREATE INDEX "coil_film_events_operation_date_idx" ON "coil_film_events"("operation_date");

-- AddForeignKey
ALTER TABLE "coil_film_events" ADD CONSTRAINT "coil_film_events_coil_id_fkey" FOREIGN KEY ("coil_id") REFERENCES "coils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un evento y su causa tienen que ser coherentes: «volver a sellar» solo lo causa el botón manual
-- o deshacer la apertura que hizo una operación; una apertura, cualquiera menos esas dos.
ALTER TABLE "coil_film_events"
  ADD CONSTRAINT "coil_film_events_type_source_coherent" CHECK (
    ("type" = 'OPENED'   AND "source" IN ('MANUAL', 'MOUNT', 'SCRAP', 'SPLIT', 'CUTTING_SEND', 'BIRTH', 'BACKFILL'))
    OR
    ("type" = 'RESEALED' AND "source" IN ('MANUAL', 'MOUNT_UNDO', 'CUTTING_UNDO'))
  );

-- Append-only también en la base (mismo criterio que `inventory_movements` y `audit_log`):
-- abrir y volver a sellar son hechos; corregir uno es insertar el siguiente. `TRUNCATE` (el reset
-- de la base de pruebas) no dispara triggers de fila.
CREATE OR REPLACE FUNCTION "coil_film_events_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coil_film_events es append-only: no se permite %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "coil_film_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "coil_film_events"
  FOR EACH ROW EXECUTE FUNCTION "coil_film_events_immutable"();

-- `coils.film_sealed` sigue al último evento **insertado** en la misma sentencia: no hay ventana
-- en la que la columna y el historial digan cosas distintas, y ninguna ruta de código tiene que
-- acordarse de actualizarla.
CREATE OR REPLACE FUNCTION "coil_film_events_sync"() RETURNS trigger AS $$
BEGIN
  UPDATE "coils" SET "film_sealed" = (NEW."type" = 'RESEALED') WHERE "id" = NEW."coil_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "coil_film_events_sync"
  AFTER INSERT ON "coil_film_events"
  FOR EACH ROW EXECUTE FUNCTION "coil_film_events_sync"();
