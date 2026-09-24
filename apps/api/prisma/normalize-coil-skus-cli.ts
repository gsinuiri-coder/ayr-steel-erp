/**
 * CLI de normalización de SKU de bobina (D-252/D-253, RF-S4b/M1).
 *
 * Mismo patrón que la carga de inventario inicial (D-206): contexto de aplicación de Nest
 * standalone y el servicio de dominio (`CoilSkuNormalizationService`), nunca SQL directo.
 * **Dry-run por defecto**: muestra renombres, uniones, no interpretables, documentos abiertos y el
 * cuadre de kilos, sin escribir nada. `--execute` aplica, y se niega si hay paradas.
 *
 * Uso (vía `pnpm normalize:coil-skus`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm normalize:coil-skus [--branch local|local-e2e|dev|demo|production]
 *   pnpm normalize:coil-skus --execute [--ack-open-documents] [--branch …]
 *   pnpm normalize:coil-skus --json [--branch …]          (el plan en JSON, para el E2E)
 *   pnpm normalize:coil-skus --revert [--execute] [--branch …]  (deshace la última corrida)
 *
 * Entorno: `DATABASE_URL`/`DIRECT_URL` y `ADMIN_EMAIL` los pone el wrapper
 * `scripts/normalize-coil-skus.mjs` en el entorno del hijo (regla dura 5).
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import {
  CoilSkuNormalizationService,
  type NormalizationGroup,
  type NormalizationPlan,
  type RevertPlan,
} from '../src/catalog/coil-sku-normalization.service';

const execute = process.argv.includes('--execute');
const acknowledgeOpenDocuments = process.argv.includes('--ack-open-documents');
const asJson = process.argv.includes('--json');
// Revisión cruzada RF-S4b (P1-4): el plan B de la ventana. Dry-run por defecto, como todo.
const revert = process.argv.includes('--revert');

function printRevert(plan: RevertPlan): void {
  if (plan.runId === null) {
    console.warn('No hay ninguna normalización sin deshacer.');
    return;
  }
  console.warn(`Corrida a deshacer: ${plan.runId} (${plan.at ?? '?'})`);
  console.warn(`Pasos (${String(plan.steps.length)}), en este orden:`);
  for (const step of plan.steps) {
    console.warn(
      step.kind === 'RENAME'
        ? `  renombre ${step.fromSku} → ${step.toSku}`
        : `  ${step.sku} vuelve a estar activo y deja de estar unido`,
    );
  }
  console.warn(`\nParadas (${String(plan.stops.length)}):`);
  for (const s of plan.stops) console.error(`  - ${s}`);
}

function printGroup(group: NormalizationGroup): void {
  const target = group.renamePrincipal
    ? `${group.principal.sku} → ${group.canonicalSku}`
    : `${group.canonicalSku} (principal, ya canónico)`;
  console.warn(
    `  ${target} · ${String(group.principal.uses)} movimientos · ${String(group.coils)} bobinas · ${group.kg} kg`,
  );
  for (const m of group.merged) {
    console.warn(
      `      + se une ${m.sku} («${m.name}») · ${String(m.uses)} movimientos → queda inactivo`,
    );
  }
}

function printPlan(plan: NormalizationPlan): void {
  console.warn(`Renombres simples (${String(plan.renames.length)}):`);
  for (const g of plan.renames) printGroup(g);
  console.warn(`\nGrupos a unir (${String(plan.merges.length)}):`);
  for (const g of plan.merges) printGroup(g);
  console.warn(`\nYa canónicos, sin cambios: ${String(plan.unchanged)}`);
  console.warn(`\nNo interpretables (${String(plan.uninterpretable.length)}):`);
  for (const u of plan.uninterpretable) console.warn(`  ${u.sku} («${u.name}»)`);
  console.warn(
    `\nDocumentos abiertos con productos a unir (${String(plan.openDocuments.length)}):`,
  );
  for (const d of plan.openDocuments) {
    console.warn(`  ${d.kind} ${d.code} (${d.status}) → ${d.productSku}`);
  }
  console.warn(
    `\nKilos: ${String(plan.kg.coils)} bobinas con saldo, ${plan.kg.total} kg en total; ` +
      `${plan.kg.before} kg resuelven hoy a un producto, ${plan.kg.after} kg resolverían después.`,
  );
  if (plan.kg.unresolvedBefore.length > 0) {
    console.warn(`  Hoy sin producto: ${plan.kg.unresolvedBefore.join(', ')}`);
  }
  console.warn(`\nParadas (${String(plan.stops.length)}):`);
  for (const s of plan.stops) console.error(`  - ${s}`);
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  // Revisión cruzada RF-S4b: el destino, a la vista antes de cualquier cosa.
  console.error(`Destino: ${process.env.AYR_CLI_BRANCH ?? '(sin declarar)'}`);
  // Revisión cruzada RF-S4b (P1-2): antes de levantar Nest, que arrancaría cola, PSE y R2.
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT "merged_into_id" FROM "products" LIMIT 0`;
  } catch {
    await prisma.$disconnect();
    throw new Error(
      'Esta rama no tiene la migración `20260923180000_rf_s4b_products_merged_into`. Corré `pnpm db:deploy` primero.',
    );
  }
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }
  await prisma.$disconnect();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(CoilSkuNormalizationService);
    if (revert) {
      const plan = execute
        ? await service.executeRevert({ id: actorUser.id })
        : await service.planRevert();
      if (asJson) {
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        return;
      }
      console.warn(
        execute ? 'Reversa aplicada.\n' : 'Simulando la reversa (dry-run): no se escribe nada.\n',
      );
      printRevert(plan);
      if (!execute && plan.stops.length > 0) process.exitCode = 1;
      return;
    }
    if (!execute) {
      const plan = await service.plan();
      if (asJson) {
        process.stdout.write(`${JSON.stringify(plan)}\n`);
        return;
      }
      console.warn('Simulando (dry-run): no se escribe nada.\n');
      printPlan(plan);
      if (plan.stops.length > 0) process.exitCode = 1;
      return;
    }
    console.warn('Ejecutando la normalización…\n');
    const result = await service.execute({ id: actorUser.id }, { acknowledgeOpenDocuments });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    printPlan(result.before);
    console.warn(
      `\nListo: ${String(result.before.renames.length)} renombre(s), ${String(result.before.merges.length)} unión(es). ` +
        `Después: ${result.after.kg.after} kg resuelven a su producto canónico, sin paradas.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
