-- D-328 (autorrevisión) — `coils.film_sealed` sigue al último evento **por fecha de negocio**, no
-- por orden de inserción.
--
-- El reporte mensual, el historial y las reglas de «volver a sellar» ordenan los eventos por
-- (operation_date, at, id). Con un evento retrofechado (un ADMINISTRADOR abre con fecha de agosto
-- una bobina cuyo último evento es de septiembre) el trigger anterior dejaba la columna por lo
-- último **insertado** y la ficha decía «Abierta» mientras el reporte y el historial decían
-- «Sellada». Ahora la columna se recalcula con el mismo orden que todo lo demás.
--
-- Migración aditiva y aparte de la anterior: la primera ya corrió en la rama Neon `ci`, y editar
-- una migración aplicada cambia su checksum.

CREATE OR REPLACE FUNCTION "coil_film_events_sync"() RETURNS trigger AS $$
BEGIN
  UPDATE "coils"
  SET "film_sealed" = COALESCE(
    (
      SELECT e."type" = 'RESEALED'
      FROM "coil_film_events" e
      WHERE e."coil_id" = NEW."coil_id"
      ORDER BY e."operation_date" DESC, e."at" DESC, e."id" DESC
      LIMIT 1
    ),
    true
  )
  WHERE "id" = NEW."coil_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
