-- El `CHECK` de la constancia era una implicación y tenía que ser una equivalencia: admitía
-- una fila con `annulled_at`, autor y motivo completos **y un estado que sigue debiendo**,
-- que es una anulación a medio aplicar contando como deuda viva. El precedente correcto es
-- el de la venta de mostrador (`fase7b_check_de_venta_en_anulacion`), que ata las dos
-- direcciones. Encontrado por `revisor` en la Sesión M-4.
ALTER TABLE "fiscal_documents" DROP CONSTRAINT "fiscal_documents_annulled_trace_ck";

ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_annulled_trace_ck" CHECK (
  ("status" = 'ANNULLED') = ("annulled_at" IS NOT NULL)
);
