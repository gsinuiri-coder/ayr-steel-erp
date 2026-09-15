-- D-209 (F8-V4prep/M2) — cierra la deuda diferida de D-203: `kind`/`business_line_id` de
-- `finishes` pasan a NOT NULL. D-203 los dejó nulos a propósito para las filas anteriores a esa
-- migración que el dueño todavía no había mapeado ("una migración posterior los pasa a NOT
-- NULL cuando ya no quede ninguna fila sin mapear").
--
-- Esta migración VALIDA antes de alterar nada: si queda algún acabado sin tipo, falla con un
-- mensaje que nombra los códigos exactos, en vez de adivinar un valor o dejarlo pasar. Corre
-- **después** de que el dueño complete el catálogo de Acabados en la UI (runbook de la ventana
-- V-4, paso 6) — nunca antes, y nunca junto con la limpia de datos (D-208): la limpia no toca
-- `finishes` (sobrevive), así que el orden entre las dos no importa para los datos, pero sí
-- para el checklist (primero se completa el catálogo, después se exige).
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg("code", ', ' ORDER BY "code") INTO missing
  FROM "finishes"
  WHERE "kind" IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'D-209: no se puede exigir tipo en acabados todavía — completar tipo/color/línea en la pantalla de Acabados para: %. Esta migración no adivina el valor.',
      missing;
  END IF;
END $$;

ALTER TABLE "finishes"
  ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "business_line_id" SET NOT NULL;

-- El CHECK de D-203 ("kind IS NULL) = (business_line_id IS NULL)") queda trivialmente cierto
-- una vez que ninguna de las dos columnas admite NULL: se retira en vez de dejarlo como código
-- muerto que nadie vuelve a poder violar.
ALTER TABLE "finishes" DROP CONSTRAINT "finishes_kind_with_line";
