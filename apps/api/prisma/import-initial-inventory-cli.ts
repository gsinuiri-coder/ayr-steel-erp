/**
 * CLI de carga de inventario inicial (D-206, excepción única a D-150).
 *
 * Usa el **mismo servicio de dominio** que la recepción de una compra
 * (`CoilsService.create` vía `InitialInventoryImportService`) a través de un contexto de
 * aplicación de Nest standalone (`NestFactory.createApplicationContext`) — nunca SQL directo
 * para crear una bobina. Dry-run por defecto (valida y reporta, no escribe nada). `--execute`
 * confirma de verdad, y solo si **todas** las filas del archivo pasaron su validación.
 *
 * Uso:
 *   pnpm exec tsx prisma/import-initial-inventory-cli.ts --file <ruta.xlsx|csv>
 *   pnpm exec tsx prisma/import-initial-inventory-cli.ts --file <ruta.xlsx|csv> --execute
 *
 * (En la práctica se invoca vía `pnpm import:initial-inventory`, que compila este archivo con
 * `tsc` real — ver `tsconfig.cli.json` — y no con `tsx`: `NestFactory.createApplicationContext`
 * necesita `emitDecoratorMetadata` bien emitido, y esbuild no lo garantiza.)
 *
 * Entorno: mismo patrón que el resto del repo — `DATABASE_URL`/`DIRECT_URL` ya en el proceso
 * (los pone el wrapper `scripts/import-initial-inventory.mjs`, nunca por argv, regla dura 5).
 * `ADMIN_EMAIL` decide el actor que audita la carga (mismo criterio que `prisma/seed.ts`), salvo
 * que se pase `--actor-email`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import type { RequestUser } from '../src/auth/auth.types';
import {
  InitialInventoryImportService,
  type InitialInventoryRowSummary,
} from '../src/imports/initial-inventory-import.service';
import {
  InitialInventoryProductImportService,
  type ProductInitialInventoryRowSummary,
} from '../src/imports/initial-inventory-product-import.service';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const filePath = argValue('--file');
const execute = process.argv.includes('--execute');
const operationDate = argValue('--operation-date');
const actorEmailFlag = argValue('--actor-email');
// F8-S6a2: `coils` (default, retrocompatible) carga bobinas; `products` carga productos
// UPVC/reventa por unidades. Dos servicios de dominio distintos, un solo CLI de arranque.
const kindFlag = argValue('--kind') ?? 'coils';
if (kindFlag !== 'coils' && kindFlag !== 'products') {
  throw new Error(`--kind tiene que ser "coils" o "products" (recibido: "${kindFlag}").`);
}
const kind: 'coils' | 'products' = kindFlag;

function printCoilRow(row: InitialInventoryRowSummary): void {
  const label = `  fila ${String(row.rowNumber)} (${row.externalCode || 'sin código'})`;
  if (row.ok) {
    console.warn(`${label}: OK${row.coilCode ? ` → ${row.coilCode}` : ''}`);
    return;
  }
  console.error(`${label}:`);
  for (const err of row.errors) console.error(`      - ${err}`);
}

function printProductRow(row: ProductInitialInventoryRowSummary): void {
  const label = `  fila ${String(row.rowNumber)} (${row.sku || 'sin SKU'})`;
  if (row.ok) {
    console.warn(`${label}: OK${row.created ? ' → stock creado' : ''}`);
    return;
  }
  console.error(`${label}:`);
  for (const err of row.errors) console.error(`      - ${err}`);
}

async function main(): Promise<void> {
  if (!filePath) {
    throw new Error(
      'Uso: import-initial-inventory-cli.ts --file <ruta.xlsx|csv> [--kind coils|products] ' +
        '[--execute] [--operation-date AAAA-MM-DD] [--actor-email correo]',
    );
  }

  const prisma = new PrismaClient();

  // GUARDA DE ESQUEMA: contra una rama sin la migración de D-206 desplegada, abortar con un
  // mensaje claro en vez del error crudo de Postgres a mitad de la lectura del archivo.
  try {
    await prisma.$queryRaw`SELECT "external_code" FROM "coils" LIMIT 0`;
    await prisma.$queryRaw`SELECT "is_system" FROM "suppliers" LIMIT 0`;
  } catch {
    await prisma.$disconnect();
    throw new Error(
      'Esta rama no tiene la migración `20260915100000_d206_carga_inicial_de_inventario` ' +
        'aplicada. Corré `pnpm db:migrate` / `pnpm db:deploy` primero.',
    );
  }

  const actorEmail = (actorEmailFlag ?? process.env.ADMIN_EMAIL)?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno (o pasa --actor-email)');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }
  const actor: RequestUser = {
    id: actorUser.id,
    email: actorUser.email,
    name: actorUser.name,
    role: actorUser.role,
    mustChangePassword: actorUser.mustChangePassword,
    sessionId: `cli-import-initial-inventory-${randomUUID()}`,
  };
  await prisma.$disconnect();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const buffer = readFileSync(resolve(filePath));
    const fileName = filePath.split(/[\\/]/).pop() ?? 'inventario-inicial';
    const runInput = { fileName, buffer, execute, operationDate, batchId: randomUUID() };

    console.warn(`${execute ? 'Ejecutando' : 'Simulando (dry-run)'} ${fileName} (${kind})…\n`);

    const report =
      kind === 'coils'
        ? await app.get(InitialInventoryImportService).run(actor, runInput)
        : await app.get(InitialInventoryProductImportService).run(actor, runInput);

    if (kind === 'coils') {
      for (const row of report.rows as InitialInventoryRowSummary[]) printCoilRow(row);
    } else {
      for (const row of report.rows as ProductInitialInventoryRowSummary[]) printProductRow(row);
    }

    const failed = report.rows.filter((r) => !r.ok).length;
    console.warn(
      `\n${String(report.totalRows)} fila(s): ${String(report.totalRows - failed)} ok, ` +
        `${String(failed)} con error.`,
    );

    if (!report.ok) {
      console.error(
        '\nNo se importó nada: hay filas con error (arriba). Corrígelas y vuelve a subir el archivo.',
      );
      process.exitCode = 1;
      return;
    }
    if (!execute) {
      console.warn(
        '\nDry-run limpio: todas las filas pasaron. No se escribió nada. Agrega --execute para importar de verdad.',
      );
      return;
    }
    console.warn(
      `\nListo: ${String(report.totalRows)} ${kind === 'coils' ? 'bobina(s)' : 'línea(s) de producto'} creada(s).`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
