-- D-103: la tercera modalidad de traslado no lleva **ningún** dato de transporte, y sin
-- guía de remisión tampoco lleva peso bruto que declarar.
--
-- Se reescriben los dos `CHECK` de Fase 5b en vez de agregar un tercero: dos constraints
-- solapados sobre las mismas columnas dan dos mensajes distintos para el mismo error, y el
-- que salta primero es el que Postgres decida.

ALTER TABLE "dispatches" DROP CONSTRAINT "dispatches_transport_ck";
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
  OR
  ("transfer_mode" = 'PICKUP'
     AND "carrier_doc_number" IS NULL AND "carrier_name" IS NULL
     AND "vehicle_plate" IS NULL
     AND "driver_given_names" IS NULL AND "driver_family_names" IS NULL
     AND "driver_doc_type" IS NULL AND "driver_doc_number" IS NULL
     AND "driver_license" IS NULL)
);

ALTER TABLE "dispatches" DROP CONSTRAINT "dispatches_weight_ck";
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_weight_ck" CHECK (
  ("transfer_mode" = 'PICKUP' AND "total_weight_kg" >= 0)
  OR
  ("transfer_mode" <> 'PICKUP' AND "total_weight_kg" > 0)
);
