-- D-124 (Sesión 7 consolidada, M1): fecha de operación — el **día de negocio** en zona de
-- Lima al que pertenece un hecho — separada del instante en que se grabó.
--
-- Los timestamps de auditoría (`at`, `created_at`, `sent_at`, `received_at`, `closed_at`)
-- NO se tocan: siguen diciendo cuándo se tipeó. La columna nueva es la que ordena el
-- kardex y la que todo reporte, listado y agrupado por fecha lee.
--
-- Se agrega nullable, se backfillea desde el timestamp de auditoría convertido a Lima
-- (no a UTC: entre las 19:00 y la medianoche local las dos fechas difieren, D-112) y
-- recién entonces se marca NOT NULL. El DEFAULT que cierra la ventana de deploy lo agrega
-- la migración siguiente (`..._operation_date_default`), que corre en el mismo
-- `migrate deploy` y por eso no deja hueco.

-- inventory_movements ------------------------------------------------------------------
-- El kardex es append-only y un trigger lo hace cumplir (§3.2, RF-95): la tabla
-- "inventory_movements" rechaza todo UPDATE. Rellenar la columna nueva ES un UPDATE, así
-- que el trigger se apaga SOLO durante esta migración y se vuelve a encender antes de
-- terminar. Es la única forma de agregarle una columna a una tabla inmutable, y es seguro
-- porque no cambia ni un dato de negocio: escribe en una columna que hasta esta migración
-- no existía, derivada del "at" de cada fila. Ninguna ruta de la aplicación puede hacer
-- esto: el trigger vuelve a estar activo al terminar, y desde ahí "operation_date" es tan
-- inmutable como el resto de la fila.
ALTER TABLE "inventory_movements" ADD COLUMN "operation_date" DATE;
ALTER TABLE "inventory_movements" DISABLE TRIGGER "inventory_movements_no_update_delete";
UPDATE "inventory_movements" SET "operation_date" = ("at" AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "inventory_movements" ENABLE TRIGGER "inventory_movements_no_update_delete";
ALTER TABLE "inventory_movements" ALTER COLUMN "operation_date" SET NOT NULL;
CREATE INDEX "inventory_movements_item_type_item_id_operation_date_idx"
  ON "inventory_movements"("item_type", "item_id", "operation_date");
CREATE INDEX "inventory_movements_business_line_id_operation_date_idx"
  ON "inventory_movements"("business_line_id", "operation_date");

-- coils --------------------------------------------------------------------------------
ALTER TABLE "coils" ADD COLUMN "operation_date" DATE;
UPDATE "coils" SET "operation_date" = ("created_at" AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "coils" ALTER COLUMN "operation_date" SET NOT NULL;
CREATE INDEX "coils_operation_date_idx" ON "coils"("operation_date");

-- cutting_orders (envío) ----------------------------------------------------------------
ALTER TABLE "cutting_orders" ADD COLUMN "operation_date" DATE;
UPDATE "cutting_orders" SET "operation_date" = ("sent_at" AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "cutting_orders" ALTER COLUMN "operation_date" SET NOT NULL;

-- cutting_order_coils (recepción) -------------------------------------------------------
-- Nullable a propósito: una fila enviada y todavía no recibida no tiene fecha de recepción,
-- y la reversa de recepción (D-051) la limpia igual que limpia `received_at`.
ALTER TABLE "cutting_order_coils" ADD COLUMN "received_operation_date" DATE;
UPDATE "cutting_order_coils"
   SET "received_operation_date" = ("received_at" AT TIME ZONE 'America/Lima')::date
 WHERE "received_at" IS NOT NULL;

-- production_orders (inicio y cierre) ---------------------------------------------------
ALTER TABLE "production_orders" ADD COLUMN "operation_date" DATE;
UPDATE "production_orders" SET "operation_date" = ("created_at" AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "production_orders" ALTER COLUMN "operation_date" SET NOT NULL;
ALTER TABLE "production_orders" ADD COLUMN "closed_operation_date" DATE;
UPDATE "production_orders"
   SET "closed_operation_date" = ("closed_at" AT TIME ZONE 'America/Lima')::date
 WHERE "closed_at" IS NOT NULL;

-- production_reports --------------------------------------------------------------------
ALTER TABLE "production_reports" ADD COLUMN "operation_date" DATE;
UPDATE "production_reports" SET "operation_date" = ("created_at" AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "production_reports" ALTER COLUMN "operation_date" SET NOT NULL;
