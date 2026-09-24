/**
 * CLI del retiro de un color sin uso y sus specs sobrantes (D-274).
 *
 * Mismo patrón que la normalización de SKU de bobina (D-253): contexto de aplicación de Nest y
 * el servicio de dominio (`ColorsService`), nunca SQL directo. **Dry-run por defecto**: muestra
 * el color, sus specs y cada referencia contada, sin escribir nada. `--execute` aplica, y el
 * servicio se niega si aparece una sola referencia.
 *
 * Uso (vía `pnpm retire:unused-color`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm retire:unused-color --code NATURAL [--branch local|local-e2e|dev|demo|production]
 *   pnpm retire:unused-color --code NATURAL --execute --branch production --confirm-production
 *
 * Entorno: `DATABASE_URL`/`DIRECT_URL` y `ADMIN_EMAIL` los pone el wrapper
 * `scripts/retire-unused-color.mjs` en el entorno del hijo (regla dura 5).
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { ColorsService } from '../src/colors/colors.service';
import type { ColorRetirementPlan } from '../src/colors/color-retirement';

const execute = process.argv.includes('--execute');
const codeFlag = process.argv.indexOf('--code');
const code = codeFlag === -1 ? undefined : process.argv[codeFlag + 1]?.trim().toUpperCase();

function printPlan(plan: ColorRetirementPlan): void {
  if (plan.color === null) {
    console.warn('El color no existe.');
  } else {
    console.warn(
      `Color ${plan.color.code} («${plan.color.name}»), ${plan.color.isActive ? 'activo' : 'ya inactivo'} → queda inactivo`,
    );
  }
  console.warn(`Specs sobrantes a borrar (${String(plan.specs.length)}):`);
  for (const s of plan.specs) {
    console.warn(`  ${s.id} · ${s.thicknessMm} mm · línea ${s.businessLineId}`);
  }
  console.warn('Referencias:');
  for (const [k, v] of Object.entries(plan.references)) console.warn(`  ${k}: ${String(v)}`);
  console.warn(`\nParadas (${String(plan.stops.length)}):`);
  for (const s of plan.stops) console.error(`  - ${s}`);
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  console.error(`Destino: ${process.env.AYR_CLI_BRANCH ?? '(sin declarar)'}`);
  if (code === undefined || code === '') throw new Error('Falta --code <CÓDIGO DEL COLOR>');
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });

  const prisma = new PrismaClient();
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  await prisma.$disconnect();
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const colors = app.get(ColorsService);
    if (!execute) {
      console.warn('Simulando (dry-run): no se escribe nada.\n');
      const plan = await colors.planRetirement(code);
      printPlan(plan);
      if (plan.stops.length > 0) process.exitCode = 1;
      return;
    }
    console.warn('Ejecutando el retiro…\n');
    const plan = await colors.retire({ id: actorUser.id }, code);
    printPlan(plan);
    console.warn(
      `\nListo: ${String(plan.specs.length)} spec(s) borrada(s) y el color ${code} inactivo, con auditoría.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
