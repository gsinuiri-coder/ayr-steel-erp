/**
 * Seed: crea (o actualiza) el usuario ADMINISTRADOR inicial desde
 * ADMIN_EMAIL / ADMIN_PASSWORD con `mustChangePassword = true`. Si el usuario ya existe solo
 * asegura rol y estado; con SEED_ADMIN_FOR_TESTS=1 (pruebas) también restablece la contraseña y quita el cambio obligatorio.
 * Lee variables de process.env (cargar .env antes con dotenv o el entorno de CI).
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Faltan ADMIN_EMAIL o ADMIN_PASSWORD en el entorno');
  }

  // En pruebas (E2E/CI) el admin entra sin cambio de contraseña obligatorio; ese flujo se prueba con usuarios nuevos.
  const forTests = process.env.SEED_ADMIN_FOR_TESTS === '1';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Administrador',
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: !forTests,
    },
    update: {
      role: Role.ADMINISTRADOR,
      active: true,
      ...(forTests ? { passwordHash, mustChangePassword: false } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: null,
      action: 'seed.admin',
      entity: 'users',
      entityId: admin.id,
      after: { email: admin.email, role: admin.role },
    },
  });

  console.warn(`Seed listo: administrador ${admin.email}`);
}

main()
  .catch((err: unknown) => {
    console.error('Error en seed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
