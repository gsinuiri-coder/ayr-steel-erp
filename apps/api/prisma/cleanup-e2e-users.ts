/**
 * Borra los usuarios que dejan los E2E de escritura (incluido el admin efímero).
 * Se usa después de correr la suite contra producción para no dejar cuentas de
 * prueba visibles en `/usuarios`.
 *
 * Alcance deliberadamente estrecho:
 * - solo correos `e2e-...@ayr.test` (ver `e2e-users.ts`); cualquier otro se ignora;
 * - las sesiones caen por `onDelete: Cascade`;
 * - `audit_log` NO se toca: es append-only (RF-95) y sus filas quedan como
 *   registro de lo que ocurrió, aunque el usuario ya no exista.
 *
 * Requiere `ALLOW_E2E_CLEANUP=1`.
 * Uso: ALLOW_E2E_CLEANUP=1 tsx prisma/cleanup-e2e-users.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { E2E_EMAIL_PREFIX, E2E_EMAIL_SUFFIX, isE2EUserEmail } from './e2e-users';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.ALLOW_E2E_CLEANUP !== '1') {
    throw new Error('Bloqueado: define ALLOW_E2E_CLEANUP=1 para borrar los usuarios de E2E');
  }

  const candidates = await prisma.user.findMany({
    where: { email: { startsWith: E2E_EMAIL_PREFIX, endsWith: E2E_EMAIL_SUFFIX } },
    select: { id: true, email: true },
  });

  // Segundo filtro en código: la consulta y el criterio compartido deben coincidir.
  const targets = candidates.filter((u) => isE2EUserEmail(u.email));
  if (targets.length !== candidates.length) {
    throw new Error('Inconsistencia entre el filtro SQL y el patrón de correos de E2E');
  }
  if (targets.length === 0) {
    console.warn('Sin usuarios de E2E que borrar');
    return;
  }

  const { count } = await prisma.user.deleteMany({
    where: { id: { in: targets.map((u) => u.id) } },
  });
  console.warn(`Usuarios de E2E borrados: ${count}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
