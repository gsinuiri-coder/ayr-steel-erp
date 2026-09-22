-- D-242, primera mitad: el valor nuevo del enum, **solo**.
--
-- Va en su propia migración y no junto al resto por una regla de Postgres: un valor agregado
-- con `ALTER TYPE ... ADD VALUE` no se puede **usar** en la misma transacción que lo crea, y
-- Prisma corre cada archivo de migración dentro de una. El `CHECK` de la migración siguiente
-- nombra 'ACCESORIO' como literal, así que en un solo archivo fallaría con "unsafe use of new
-- value of enum type".
--
-- `IF NOT EXISTS` para que reaplicarla sobre una rama que ya lo tiene sea inocua.
ALTER TYPE "roofing_product_kind" ADD VALUE IF NOT EXISTS 'ACCESORIO';
