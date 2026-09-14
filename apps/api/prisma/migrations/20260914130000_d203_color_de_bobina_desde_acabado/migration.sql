-- D-203 (F8-S4/M2) — el color de una bobina y de su ítem de compra sale de su acabado.
--
-- Las columnas `coils.color_id` y `purchase_items.color_id` se quedan: las leen el filtro de
-- montaje de la OP (D-086), el pool de materia prima (D-134/D-154), el stock por color, los PDFs
-- y el reporte mensual, con su índice. Lo que desaparece es la **fuente aparte**: ningún
-- formulario ni endpoint las escribe ya, y la base las completa desde el acabado. Así una bobina
-- no puede quedar sin color —ni con otro— porque alguien se olvidó de elegirlo (el feedback que
-- originó D-203).
--
-- Solo manda un acabado **mapeado** (`kind` no nulo). Uno anterior a D-203 sin mapear deja el
-- color como estaba hasta que se complete; al completarlo, el trigger de `finishes` alinea sus
-- bobinas y compras.

CREATE OR REPLACE FUNCTION "color_from_finish"() RETURNS trigger AS $$
DECLARE
  finish_kind  "FinishKind";
  finish_color UUID;
BEGIN
  IF NEW."finish_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT f."kind", f."color_id" INTO finish_kind, finish_color
  FROM "finishes" f WHERE f."id" = NEW."finish_id";
  IF finish_kind IS NOT NULL THEN
    NEW."color_id" := finish_color;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "coils_color_from_finish"
  BEFORE INSERT OR UPDATE OF "finish_id", "color_id" ON "coils"
  FOR EACH ROW EXECUTE FUNCTION "color_from_finish"();

CREATE TRIGGER "purchase_items_color_from_finish"
  BEFORE INSERT OR UPDATE OF "finish_id", "color_id" ON "purchase_items"
  FOR EACH ROW EXECUTE FUNCTION "color_from_finish"();

-- Si el color o el tipo de un acabado cambia (solo se permite sin uso, o al completar uno sin
-- mapear), sus bobinas y compras lo siguen en la misma sentencia.
CREATE OR REPLACE FUNCTION "finish_color_to_items"() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS NOT NULL
     AND (NEW."color_id" IS DISTINCT FROM OLD."color_id" OR OLD."kind" IS NULL) THEN
    UPDATE "coils" SET "color_id" = NEW."color_id"
    WHERE "finish_id" = NEW."id" AND "color_id" IS DISTINCT FROM NEW."color_id";
    UPDATE "purchase_items" SET "color_id" = NEW."color_id"
    WHERE "finish_id" = NEW."id" AND "color_id" IS DISTINCT FROM NEW."color_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "finishes_color_to_items"
  AFTER UPDATE OF "kind", "color_id" ON "finishes"
  FOR EACH ROW EXECUTE FUNCTION "finish_color_to_items"();
