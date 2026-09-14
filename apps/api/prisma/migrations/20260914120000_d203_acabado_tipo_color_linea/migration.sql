-- D-203 (F8-S4/M1) — un acabado es tipo + color + línea, y el color de la bobina sale de él.
--
-- Additive-first. `finishes` gana `kind`, `color_id` y `business_line_id`, **nulos** por ahora:
-- solo se completan los acabados que el dueño mapeó (PASO 0 de la sesión). Una fila sin mapear
-- sigue funcionando para lo que ya existe; la API exige los tres campos en toda alta y edición,
-- y una migración posterior los pasa a NOT NULL cuando no quede ninguna fila sin tipo (producción
-- se limpia antes de la ventana V-4). `colors` gana `ral_code` y nombre único sin distinguir
-- mayúsculas.

CREATE TYPE "FinishKind" AS ENUM ('NATURAL', 'PREPINTADO', 'GALVANIZADO');

ALTER TABLE "finishes"
  ADD COLUMN "kind"             "FinishKind",
  ADD COLUMN "color_id"         UUID,
  ADD COLUMN "business_line_id" UUID;

ALTER TABLE "finishes"
  ADD CONSTRAINT "finishes_color_id_fkey" FOREIGN KEY ("color_id")
    REFERENCES "colors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finishes_business_line_id_fkey" FOREIGN KEY ("business_line_id")
    REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "finishes_business_line_id_is_active_idx" ON "finishes"("business_line_id", "is_active");

-- El color depende del tipo: prepintado lo exige; natural y galvanizado no lo admiten. Una fila
-- sin tipo (anterior a D-203, sin mapear) no tiene todavía nada que cumplir.
ALTER TABLE "finishes"
  ADD CONSTRAINT "finishes_color_by_kind" CHECK (
    "kind" IS NULL
    OR ("kind" = 'PREPINTADO' AND "color_id" IS NOT NULL)
    OR ("kind" IN ('NATURAL', 'GALVANIZADO') AND "color_id" IS NULL)
  );

-- Tipo y línea van juntos: un acabado mapeado sabe a qué línea pertenece.
ALTER TABLE "finishes"
  ADD CONSTRAINT "finishes_kind_with_line" CHECK (("kind" IS NULL) = ("business_line_id" IS NULL));

-- ---------------------------------------------------------------------------
-- Colores
-- ---------------------------------------------------------------------------

ALTER TABLE "colors" ADD COLUMN "ral_code" VARCHAR(10);

-- El color que ya existía pasa al nombre que se muestra y gana su RAL.
UPDATE "colors" SET "name" = 'Rojo', "ral_code" = '3002', "updated_at" = CURRENT_TIMESTAMP
WHERE "code" = 'ROJO' AND "ral_code" IS NULL;

-- Catálogo de ejemplo: el dueño lo ajusta desde Catálogo. Se omite todo color cuyo código o
-- nombre ya exista, para no chocar con lo que una base ya tenga cargado.
INSERT INTO "colors" ("id", "code", "name", "ral_code", "hex_color", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), v.code, v.name, v.ral, v.hex, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('ROJO',   'Rojo',   '3002', '#9b2423'),
  ('AZUL',   'Azul',   '5010', '#0e4c96'),
  ('VERDE',  'Verde',  '6005', '#114232'),
  ('BLANCO', 'Blanco', '9010', '#f1ece1'),
  ('GRIS',   'Gris',   '7035', '#cbd0cc')
) AS v(code, name, ral, hex)
WHERE NOT EXISTS (
  SELECT 1 FROM "colors" c WHERE c."code" = v.code OR lower(c."name") = lower(v.name)
);

-- ALZ-3020 es RAL 3020, no el rojo 3002 con el que se cargaron sus bobinas (decisión del dueño):
-- su color se crea solo si ese acabado existe.
INSERT INTO "colors" ("id", "code", "name", "ral_code", "hex_color", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), 'ROJO-3020', 'Rojo tráfico', '3020', '#bb1e10', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "finishes" WHERE "code" = 'ALZ-3020')
  AND NOT EXISTS (
    SELECT 1 FROM "colors" c WHERE c."code" = 'ROJO-3020' OR lower(c."name") = 'rojo tráfico'
  );

-- Si una base ya tuviera dos colores con el mismo nombre en distinta caja, esto falla a
-- propósito: elegir cuál sobrevive es del dueño, no de una migración.
CREATE UNIQUE INDEX "colors_name_lower_key" ON "colors" (lower("name"));

-- ---------------------------------------------------------------------------
-- Mapeo de los acabados existentes (PASO 0, confirmado por el dueño)
-- ---------------------------------------------------------------------------

UPDATE "finishes" f
SET "kind" = 'PREPINTADO',
    "color_id" = (SELECT "id" FROM "colors" WHERE "code" = m.color_code),
    "business_line_id" = (SELECT "id" FROM "business_lines" WHERE "code" = 'metallic-roofing'),
    "updated_at" = CURRENT_TIMESTAMP
FROM (VALUES
  ('ALZ-ROJO-3002', 'ROJO'),
  ('ALZ-3020',      'ROJO-3020'),
  ('ALZ-AZUL',      'AZUL')
) AS m(finish_code, color_code)
WHERE f."code" = m.finish_code
  AND f."kind" IS NULL
  AND EXISTS (SELECT 1 FROM "colors" WHERE "code" = m.color_code);

-- El color de cada bobina y de cada ítem de compra con acabado mapeado pasa a ser el de su
-- acabado: desde acá esa es la única fuente (las dos bobinas de ALZ-3020 dejan de decir ROJO).
UPDATE "coils" c
SET "color_id" = f."color_id", "updated_at" = CURRENT_TIMESTAMP
FROM "finishes" f
WHERE c."finish_id" = f."id"
  AND f."kind" IS NOT NULL
  AND c."color_id" IS DISTINCT FROM f."color_id";

UPDATE "purchase_items" pi
SET "color_id" = f."color_id"
FROM "finishes" f
WHERE pi."finish_id" = f."id"
  AND f."kind" IS NOT NULL
  AND pi."color_id" IS DISTINCT FROM f."color_id";
