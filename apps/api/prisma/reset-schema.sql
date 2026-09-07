-- D-129: vacía el esquema completo de una rama para rehacerlo desde el historial de
-- migraciones. Se lleva puesto también `_prisma_migrations`, que es justamente lo que hace
-- que `migrate deploy` vuelva a construir todo desde cero.
--
-- Esto NO borra la rama de Neon (eso sigue prohibido): la deja vacía y lista para que
-- `migrate deploy` + `seed` la reconstruyan con el mismo historial que las demás.
--
-- Lo ejecuta únicamente `scripts/prod-reset-go-live.mjs`, detrás de dos confirmaciones
-- independientes. No lo corras a mano.
DROP SCHEMA IF EXISTS "public" CASCADE;
CREATE SCHEMA "public";
