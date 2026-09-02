/**
 * Crea (o restablece) el ADMINISTRADOR efímero que usan los E2E de escritura.
 * Pensado para verificar producción sin tocar la cuenta real del dueño: se crea
 * al inicio de la corrida y `cleanup-e2e-users.ts` lo borra al terminar.
 *
 * Requiere `ALLOW_E2E_ADMIN=1` y la contraseña en `E2E_ADMIN_PASSWORD` (la genera
 * quien invoca; nunca se persiste en disco). El correo debe seguir el patrón que
 * reconoce la limpieza: `e2e-...@ayr.test`.
 *
 * Uso: ALLOW_E2E_ADMIN=1 E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... tsx prisma/e2e-admin.ts
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';
import { isE2EUserEmail } from './e2e-users';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.ALLOW_E2E_ADMIN !== '1') {
    throw new Error('Bloqueado: define ALLOW_E2E_ADMIN=1 para crear el admin efímero de E2E');
  }
  const email = process.env.E2E_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Faltan E2E_ADMIN_EMAIL o E2E_ADMIN_PASSWORD');
  if (!isE2EUserEmail(email)) {
    // Si no coincide con el patrón, la limpieza no lo borraría y quedaría un
    // administrador extra vivo en la base. Mejor fallar aquí.
    throw new Error(`E2E_ADMIN_EMAIL debe ser de la forma e2e-...@ayr.test (recibido: ${email})`);
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Administrador E2E',
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      // Sin cambio obligatorio: el guard bloquea todo lo demás hasta cambiarla.
      mustChangePassword: false,
    },
    update: {
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: false,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: null,
      action: 'e2e.admin.create',
      entity: 'users',
      entityId: admin.id,
      after: { email: admin.email, role: admin.role },
    },
  });

  console.warn(`Admin efímero de E2E listo: ${admin.email}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
