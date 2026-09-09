/**
 * Seed de `pnpm dev:preview`: crea (o reafirma) un segundo usuario ADMINISTRADOR desde
 * VIEWER_EMAIL / VIEWER_PASSWORD, con contraseña conocida y sin cambio obligatorio.
 *
 * A diferencia de seed.ts (que solo fuerza la contraseña en el alta, o siempre con
 * SEED_ADMIN_FOR_TESTS=1), este SIEMPRE la reescribe en cada corrida: `dev:preview` comparte
 * base con `pnpm dev:local` (misma `ayr_local`), y admin@ayr.local puede haber pasado por el
 * flujo de cambio obligatorio de contraseña del otro proceso sin que este lo sepa. Reafirmar acá
 * mantiene el login de esta cuenta estable sin tocar la fila de admin@ayr.local.
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Cerco de entorno. Este seed crea un **ADMINISTRADOR con contraseña fija y commiteada** y
 * sin cambio obligatorio: es aceptable en una base local descartable y en ninguna otra parte.
 * `import 'dotenv/config'` carga `apps/api/.env`, que apunta a Neon `dev`, así que correrlo a
 * mano sin el override de `pnpm dev:preview` habría creado esa cuenta en una rama compartida.
 * La contraseña del rol `neondb_owner` es la misma en las cuatro ramas (regla dura 5): un
 * admin de contraseña pública en `dev` es un admin de contraseña pública en producción.
 */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL no es una URL válida: este seed solo corre contra localhost');
  }
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `Este seed crea un administrador con contraseña conocida y solo corre contra el Postgres ` +
        `local; DATABASE_URL apunta a "${host}". Usa "pnpm dev:preview".`,
    );
  }
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const email = process.env.VIEWER_EMAIL?.trim().toLowerCase();
  const password = process.env.VIEWER_PASSWORD;
  if (!email || !password) {
    throw new Error('Faltan VIEWER_EMAIL o VIEWER_PASSWORD en el entorno');
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const viewer = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Viewer (dev:preview)',
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: false,
    },
    update: {
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: false,
    },
  });

  // Regla dura 4 / RF-03: reescribir la contraseña es un reset, y un reset revoca las
  // sesiones. Acá el impacto es local, pero dejar el precedente al revés es cómo se cuela
  // después en un camino que sí importa.
  await prisma.session.deleteMany({ where: { userId: viewer.id } });

  console.warn(`Seed listo: viewer ${viewer.email}`);
}

main()
  .catch((err: unknown) => {
    console.error('Error en seed-view:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
