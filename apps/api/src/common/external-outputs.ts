/**
 * Revisión cruzada RF-S4b (P1-2): las salidas externas que una CLI de dominio **no** puede
 * tener encendidas. La CLI levanta `AppModule` entero, y con él arranca solo lo que el API
 * arranca en Cloud Run: la cola (pg-boss), el reintento de envíos al PSE —que al arrancar barre
 * los pendientes de la base a la que apunta— y el cliente de R2. El wrapper
 * (`scripts/run-api-cli.mjs`) las apaga; esto es la segunda cerradura, **dentro** de la CLI,
 * para quien corra el JS compilado a mano.
 */
export interface ExternalOutputs {
  jobs: boolean;
  pse: boolean;
  r2: boolean;
}

/** Lo que el entorno enciende, con la misma lectura que `config/env.ts`. */
export function externalOutputs(env: NodeJS.ProcessEnv): ExternalOutputs {
  const set = (name: string): boolean => (env[name] ?? '').trim() !== '';
  return {
    // `JOBS_ENABLED` vale `true` por defecto: solo lo apaga un `false` explícito.
    jobs: (env.JOBS_ENABLED ?? 'true') !== 'false',
    pse: env.PSE_ENABLED === 'true',
    // El cliente de R2 se crea si están las credenciales y el bucket (`StorageService`).
    r2:
      set('R2_ACCOUNT_ID') ||
      set('R2_ACCESS_KEY_ID') ||
      set('R2_SECRET_ACCESS_KEY') ||
      set('R2_BUCKET'),
  };
}

/**
 * Imprime las tres banderas y aborta si alguna quedó encendida. Va antes de levantar Nest: una
 * vez arrancado, el barrido de envíos al PSE ya salió.
 */
export function assertExternalOutputsOff(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): void {
  const state = externalOutputs(env);
  const flag = (on: boolean): string => (on ? 'ENCENDIDO' : 'apagado');
  log(
    `Salidas externas: cola (JOBS_ENABLED) ${flag(state.jobs)} · PSE (PSE_ENABLED) ${flag(state.pse)} · R2 ${flag(state.r2)}`,
  );
  const on = Object.entries(state)
    .filter(([, value]) => value)
    .map(([name]) => name);
  if (on.length > 0) {
    throw new Error(
      `La CLI no corre con salidas externas encendidas (${on.join(', ')}): córrela con su wrapper (pnpm normalize:coil-skus / pnpm sweep:imported), que las apaga.`,
    );
  }
}
