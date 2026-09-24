/**
 * RF-S4b: la cerradura de las CLI de dominio (normalización de SKU de bobina y barrido de lo
 * importado), **dentro** de la propia CLI y no solo en su wrapper `scripts/run-api-cli.mjs`.
 *
 * El wrapper pone `AYR_CLI_BRANCH` y `AYR_CLI_CONFIRMED_PRODUCTION`.
 *
 * - Sin rama declarada no se escribe: es alguien corriendo el JS compilado a mano con un
 *   `DATABASE_URL`, la puerta que el wrapper cerraba y el JS dejaba abierta.
 * - **Contra production no corre nada —ni siquiera el dry-run— sin `--confirm-production`**
 *   (repaso de RF-S4b, P1-B). El dry-run no escribe, pero lee datos reales y es el paso
 *   previo a un execute; confirmarlo cada vez hace que ninguna corrida contra production salga
 *   por un `--branch` tipeado de más. Contra demo, dev o local no hace falta.
 */
export function assertCliRunAllowed(env: NodeJS.ProcessEnv, execute: boolean): void {
  const branch = env.AYR_CLI_BRANCH;
  if (branch === 'production' && env.AYR_CLI_CONFIRMED_PRODUCTION !== '1') {
    throw new Error(
      'Contra production la CLI no corre sin --confirm-production, tampoco en dry-run.',
    );
  }
  if (!execute) return;
  if (branch === undefined || branch === '') {
    throw new Error(
      '--execute solo corre desde su wrapper (`pnpm normalize:coil-skus` / `pnpm sweep:imported`), que declara la rama.',
    );
  }
}
