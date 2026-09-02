import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Prepara la base de pruebas. En CI (rama Neon `ci`): migraciones + vaciado + seed.
 * En local (rama `dev`): solo migraciones + seed (idempotente); los tests crean sus
 * propios datos con correos únicos. Con E2E_RESET_DB=1 también vacía en local.
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
