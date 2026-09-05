-- D-103: recojo en mostrador. Va **sola** en su migración porque Postgres no admite usar
-- un valor de enum recién agregado dentro de la misma transacción que lo agregó, y la
-- migración siguiente lo usa en dos `CHECK`.
ALTER TYPE "TransferMode" ADD VALUE 'PICKUP';
