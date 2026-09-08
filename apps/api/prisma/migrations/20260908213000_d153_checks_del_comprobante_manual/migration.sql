-- D-153, segunda mitad: los dos `CHECK` que el modo manual destapó.
--
-- Va en una migración aparte de la que agrega el modo, y no por prolijidad: la anterior ya
-- está aplicada en las bases locales, y editar una migración aplicada le cambia el checksum y
-- rompe `prisma migrate deploy` con un síntoma que este proyecto ya se comió dos veces
-- (D-053 y las notas de la sesión 7-final-C).
--
-- **Es el defecto de D-145 otra vez, y esta vez lo encontró el E2E antes del deploy**: un
-- `CHECK` escrito cuando la regla era más angosta, y código nuevo que la ensancha sin tocar la
-- base. Los dos daban un `500` sin mensaje, exactamente como aquella vez.

-- 1. El número podía existir solo colgado de una serie del ERP.
--
-- Un comprobante manual tiene número —el del papel— y **no** tiene serie del ERP: su serie no
-- es una fila de `fiscal_series` y no tiene por qué serlo. La forma nueva admite ese tercer
-- caso y sigue prohibiendo el que nunca fue válido (un número a medio poner).
ALTER TABLE "fiscal_documents" DROP CONSTRAINT "fiscal_documents_number_ck";
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_number_ck" CHECK (
  ("series_id" IS NULL AND "correlative" IS NULL AND "number" IS NULL)
  OR ("series_id" IS NOT NULL AND "correlative" IS NOT NULL AND "correlative" > 0 AND "number" IS NOT NULL)
  OR ("origin" = 'MANUAL' AND "series_id" IS NULL AND "correlative" IS NOT NULL AND "correlative" > 0 AND "number" IS NOT NULL)
);

-- 2. La anulación interna estaba reservada a lo importado.
--
-- D-110 la escribió cuando lo importado era lo único que el ERP no emitía. Desde D-153 hay dos
-- orígenes así, y los dos necesitan vuelta: sin esto, un manual mal registrado es deuda falsa
-- permanente. Lo que la regla sigue prohibiendo es lo que importa: **un comprobante que el ERP
-- emitió no se anula por dentro**, se deshace ante SUNAT.
ALTER TABLE "fiscal_documents" DROP CONSTRAINT "fiscal_documents_annulled_origin_ck";
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_annulled_origin_ck" CHECK (
  "status" <> 'ANNULLED' OR "origin" <> 'ISSUED_HERE'
);
