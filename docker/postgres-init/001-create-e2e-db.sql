-- Segunda base en el mismo Postgres local: separa la data descartable de "pnpm dev:local"
-- (ayr_local) de la que la suite E2E vacía en cada corrida (ayr_local_e2e), para que correr
-- los tests no se lleve por delante datos que se estaban probando a mano.
CREATE DATABASE ayr_local_e2e;
