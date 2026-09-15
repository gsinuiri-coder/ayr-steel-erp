-- D-206 (F8-S6a/M1) — herramienta de inventario inicial: excepción única a D-150.
--
-- `suppliers.is_system` (mismo criterio que `customers.is_system`, D-077): marca al proveedor
-- sembrado "Saldo inicial de inventario", que ninguna ruta edita ni da de baja. Existe para que
-- la bobina de arranque tenga el proveedor que el modelo exige sin que el archivo de carga
-- declare uno — el inventario inicial no es una compra (D-206).
ALTER TABLE "suppliers" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- `coils.external_code`: el código con el que el cliente identifica la bobina en su propio
-- inventario. Nullable y solo lo llena la carga inicial; nunca reemplaza a `code` (RF-13).
ALTER TABLE "coils" ADD COLUMN "external_code" VARCHAR(40);

CREATE INDEX "coils_external_code_idx" ON "coils"("external_code");

-- Mismo patrón que D-077 ("público en general", ver la migración de Fase 5b): el dato nace acá
-- para que production no dependa de un `pnpm db:seed` posterior, y `seed.ts` lo repite para que
-- un reset de pruebas (que vacía la tabla pero no vuelve a correr esta migración) lo recomponga.
INSERT INTO "suppliers"
  ("id", "code", "doc_type", "doc_number", "name", "credit_days", "is_system", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), 'SALDO', 'DNI', '00000000', 'Saldo inicial de inventario', 0, true, true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM "suppliers" WHERE "doc_type" = 'DNI' AND "doc_number" = '00000000');
