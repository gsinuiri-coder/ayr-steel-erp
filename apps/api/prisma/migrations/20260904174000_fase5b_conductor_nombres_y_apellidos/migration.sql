-- D-078: SUNAT pide los **nombres** y los **apellidos** del conductor por separado, y el
-- PSE rechaza la guía con "Apellido(s) del conductor no puede estar en blanco" cuando solo
-- se manda el nombre completo.
--
-- Se parten en dos columnas en vez de dividir el texto en el adaptador: partir un nombre
-- por espacios acierta con "Juan Pérez Gómez" y falla con "José Luis Pérez", y el resultado
-- de esa adivinanza sale impreso en un documento fiscal.

ALTER TABLE "dispatches" ADD COLUMN "driver_given_names" VARCHAR(80);
ALTER TABLE "dispatches" ADD COLUMN "driver_family_names" VARCHAR(80);

-- Backfill de lo que haya (solo datos de prueba: la tabla nace en esta misma fase). El
-- último token va a apellidos y el resto a nombres; es la mejor aproximación posible sobre
-- un dato que ya se capturó junto, y por eso mismo es lo que dejamos de hacer de aquí en
-- adelante.
UPDATE "dispatches"
SET "driver_given_names" = NULLIF(regexp_replace("driver_name", '\s+\S+$', ''), ''),
    "driver_family_names" = NULLIF(substring("driver_name" from '\S+$'), '')
WHERE "driver_name" IS NOT NULL;

-- El `CHECK` de la modalidad pasa a exigir las dos columnas nuevas en vez de la vieja.
ALTER TABLE "dispatches" DROP CONSTRAINT "dispatches_transport_ck";
ALTER TABLE "dispatches" DROP COLUMN "driver_name";

ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_transport_ck" CHECK (
  ("transfer_mode" = 'PRIVATE'
     AND "vehicle_plate" IS NOT NULL
     AND "driver_given_names" IS NOT NULL AND "driver_family_names" IS NOT NULL
     AND "driver_doc_type" IS NOT NULL AND "driver_doc_number" IS NOT NULL
     AND "driver_license" IS NOT NULL
     AND "carrier_doc_number" IS NULL AND "carrier_name" IS NULL)
  OR
  ("transfer_mode" = 'PUBLIC'
     AND "carrier_doc_number" IS NOT NULL AND "carrier_name" IS NOT NULL
     AND "vehicle_plate" IS NULL
     AND "driver_given_names" IS NULL AND "driver_family_names" IS NULL
     AND "driver_doc_type" IS NULL AND "driver_doc_number" IS NULL
     AND "driver_license" IS NULL)
);
