/**
 * Reset de base de datos de PRUEBAS (Neon rama `ci`): aplica migraciones pendientes y
 * vacía las tablas. Exige ALLOW_DB_RESET=1 explícito y rechaza la rama `production`.
 * Uso: ALLOW_DB_RESET=1 pnpm exec tsx prisma/reset-test-db.ts
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const PRODUCTION_ENDPOINT = 'ep-square-cherry';

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('Falta DATABASE_URL');
  if (process.env.ALLOW_DB_RESET !== '1') {
    throw new Error('Reset bloqueado: define ALLOW_DB_RESET=1 solo para la base de pruebas');
  }
  if (url.includes(PRODUCTION_ENDPOINT) || process.env.NODE_ENV === 'production') {
    throw new Error('Reset bloqueado: la conexión apunta a producción');
  }

  execSync('pnpm exec prisma migrate deploy', { stdio: 'inherit', env: process.env });

  const prisma = new PrismaClient();
  try {
    // SQL estático (sin entrada de usuario). `audit_log` e `inventory_movements` tienen
    // trigger anti-UPDATE/DELETE: TRUNCATE no dispara triggers de fila, así que pasa.
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "inventory_movements", "inventory_balances", "supplier_payments", ' +
        '"coils", "purchase_items", "purchases", "sessions", "audit_log", "users" ' +
        'RESTART IDENTITY CASCADE',
    );
    console.warn('Base de pruebas vaciada');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
