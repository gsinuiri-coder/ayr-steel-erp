/**
 * RF-S4b: el gate de escritura de los CLI de dominio (normalización de SKU de bobina y barrido de
 * lo importado), **dentro** del propio CLI y no solo en su wrapper `scripts/run-api-cli.mjs`.
 *
 * El wrapper pone `AYR_CLI_BRANCH` y `AYR_CLI_CONFIRMED_PRODUCTION`. Sin rama declarada no se
 * escribe —es alguien corriendo el JS compilado a mano con un `DATABASE_URL`, que es justo la
 * puerta que el wrapper cerraba y el JS dejaba abierta—; contra production hace falta además la
 * confirmación explícita (regla dura 5 de AGENTS.md).
 */
export function assertExecuteAllowed(execute: boolean): void {
  if (!execute) return;
  const branch = process.env.AYR_CLI_BRANCH;
  if (branch === undefined || branch === '') {
    throw new Error(
      '--execute solo corre desde su wrapper (`pnpm normalize:coil-skus` / `pnpm sweep:imported`), que declara la rama.',
    );
  }
  if (branch === 'production' && process.env.AYR_CLI_CONFIRMED_PRODUCTION !== '1') {
    throw new Error('--execute contra production exige --confirm-production.');
  }
}
