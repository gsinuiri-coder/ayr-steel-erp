/**
 * Guard de la base de PRUEBAS, compartido por todo lo que la escribe sin pasar por el API:
 * `reset-test-db.ts` (vacía todas las tablas) y `e2e-fiscal-offset.ts` (adelanta los
 * correlativos de una base recién vaciada).
 *
 * Las tres bases legítimas son el Postgres local de Docker (`ayr_local_e2e`), el Postgres de
 * servicio del runner de GitHub Actions (`ayr_ci_e2e`) y la rama Neon `ci`; ninguna otra.
 */

/**
 * **Lista blanca, no lista negra**, y el cambio importa desde que el reset vacía **todas** las
 * tablas y no nueve.
 *
 * El guardrail anterior rechazaba el endpoint de producción y `NODE_ENV=production`, o sea que
 * dejaba pasar todo lo demás — incluida la rama Neon **`dev`**, que es lo que
 * `apps/api/.env` apunta después de un `pnpm env:local` y lo que el reset lee por
 * `dotenv/config`. Mientras el vaciado eran inventario, compras y usuarios, correrlo por error
 * contra `dev` costaba poco. Ahora se lleva también el catálogo, los clientes, las
 * cotizaciones y los comprobantes de esa rama, que es trabajo de verdad.
 *
 * Una lista negra hay que acordarse de ampliarla cada vez que aparece una base nueva; una
 * lista blanca falla sola ante lo que no reconoce, que es el lado correcto para fallar cuando
 * la operación es irreversible.
 */
const ALLOWED = [
  // Postgres de docker-compose.yml (`scripts/local-docker-env.mjs`), base exclusiva de la suite.
  { label: 'Docker local (ayr_local_e2e)', test: (u: URL) => isLocalE2E(u) },
  // Postgres de servicio del job `e2e` de `.github/workflows/ci.yml` (D-202).
  //
  // El job corre **en el runner, no en un contenedor**, así que el servicio se alcanza por el
  // puerto mapeado en `localhost` y no por el nombre del servicio (`postgres`), que solo
  // resuelve entre contenedores. El hostname es el que devuelve `new URL()` sobre la URL del
  // workflow —`localhost`, exacto—, no el que se supone (lección de D-181).
  //
  // Se exige además `GITHUB_ACTIONS=true`: un `localhost/ayr_ci_e2e` en la máquina de alguien
  // no es esta base, aunque se llame igual.
  { label: 'Postgres del runner de CI (ayr_ci_e2e)', test: (u: URL) => isRunnerCiE2E(u) },
  // Rama Neon `ci`, que se resetea en el job de smoke de GitHub Actions.
  //
  // El prefijo es el del **endpoint de cómputo** de la rama, no el de su branch id — son dos
  // identificadores aleatorios independientes en Neon y no tienen por qué coincidir (D-181):
  // el valor anterior, `ep-misty-band-`, copiaba el id de la rama (`br-misty-band-...`) en vez
  // de verificar el endpoint real, y nunca coincidió con nada. Si esto vuelve a desalinearse,
  // el endpoint vigente sale de `neonctl branches get ci --output json` (campo del compute),
  // nunca de la cadena de conexión completa (regla dura 5).
  { label: 'Neon rama ci', test: (u: URL) => u.hostname.startsWith('ep-dry-butterfly-') },
];

function databaseName(url: URL): string {
  return url.pathname.replace(/^\//, '');
}

function isLocalE2E(url: URL): boolean {
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return localHost && databaseName(url) === 'ayr_local_e2e';
}

function isRunnerCiE2E(url: URL): boolean {
  return (
    process.env.GITHUB_ACTIONS === 'true' &&
    url.hostname === 'localhost' &&
    databaseName(url) === 'ayr_ci_e2e'
  );
}

function labelOf(name: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Bloqueado: ${name} no es una URL que se pueda leer`);
  }
  const allowed = ALLOWED.find((candidate) => candidate.test(parsed));
  if (!allowed) {
    // Sin la cadena de conexión en el mensaje: lleva la contraseña (regla dura 5). El host y
    // la base alcanzan para entender qué se estaba por tocar.
    throw new Error(
      `Bloqueado: ${name} apunta a ${parsed.hostname}/${databaseName(parsed)}, que no es una ` +
        `base de pruebas. Solo se admiten: ${ALLOWED.map((c) => c.label).join(', ')}.`,
    );
  }
  return allowed.label;
}

/**
 * Devuelve la etiqueta de la base de pruebas, o lanza si falta `ALLOW_DB_RESET=1` o si
 * **alguna** de las dos URLs no es de la lista blanca.
 *
 * Se validan las dos y tienen que coincidir porque cada escritor usa una distinta:
 * `prisma migrate deploy` va por `DIRECT_URL`, pero el `TRUNCATE` y el `updateMany` van por
 * `DATABASE_URL` (el `url` del datasource). Validar solo una dejaba pasar el caso de quien
 * exporta `DATABASE_URL` a otra base y hereda el `DIRECT_URL` de `ayr_local_e2e` que completa
 * `playwright.config.ts`: el guard aprobaba mirando una y el vaciado caía sobre la otra.
 */
export function assertTestDatabase(): string {
  if (process.env.ALLOW_DB_RESET !== '1') {
    throw new Error('Bloqueado: define ALLOW_DB_RESET=1 solo para la base de pruebas');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Falta DATABASE_URL');
  const label = labelOf('DATABASE_URL', databaseUrl);
  const directUrl = process.env.DIRECT_URL;
  if (directUrl && labelOf('DIRECT_URL', directUrl) !== label) {
    throw new Error('Bloqueado: DATABASE_URL y DIRECT_URL apuntan a bases de pruebas distintas');
  }
  return label;
}
