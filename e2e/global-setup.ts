import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Prepara la base de pruebas: migraciones + vaciado + seed. En CI, contra la rama Neon `ci`.
 * En local, contra el Postgres de docker-compose.yml (base "ayr_local_e2e", ver
 * playwright.config.ts) — descartable y de uso exclusivo de la suite, así que el vaciado va
 * por defecto ahí también (E2E_RESET_DB=1, seteado por playwright.config.ts). Con
 * E2E_RESET_DB=0 se salta el vaciado y solo aplica migraciones + seed (idempotente); sirve
 * para apuntar la suite a otra base a mano sin perder lo que tenga.
 */
export default function globalSetup(): void {
  const apiDir = resolve(__dirname, '../apps/api');
  const reset = process.env.CI === 'true' || process.env.E2E_RESET_DB === '1';
  const opts = {
    cwd: apiDir,
    stdio: 'inherit' as const,
    env: {
      ...process.env,
      SEED_ADMIN_FOR_TESTS: '1',
      ...(reset ? { ALLOW_DB_RESET: '1' } : {}),
    },
  };
  if (reset) {
    execSync('pnpm exec tsx prisma/reset-test-db.ts', opts);
  } else {
    execSync('pnpm exec prisma migrate deploy', opts);
  }
  execSync('pnpm exec tsx prisma/seed.ts', opts);
}
