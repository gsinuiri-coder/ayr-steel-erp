-- Sesión M-4, D-110: un comprobante **importado** (RF-71) puede anularse por dentro. Va
-- **sola** en su migración porque Postgres no admite usar un valor de enum recién agregado
-- dentro de la transacción que lo agregó, y la migración siguiente lo usa en un `CHECK`.
ALTER TYPE "FiscalDocumentStatus" ADD VALUE 'ANNULLED';
