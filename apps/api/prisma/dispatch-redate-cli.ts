/**
 * CLI del re-fechado de despachos «a la fecha del comprobante» (D-288), para un comprobante
 * cuya fecha de emisión **ya se corrigió** sin re-fechar su despacho (el caso de
 * FFA1-00001386, corregido antes de que existiera la opción en el diálogo).
 *
 * Contexto de Nest y servicio de dominio (`InvoiceDispatchService.redateInTx`, el mismo que usa
 * la corrección de fecha), nunca SQL directo. **Dry-run por defecto**, en una transacción
 * `READ ONLY`: el comprobante, sus despachos enlazados (cuáles se re-fechan y cuáles tienen
 * fecha propia) y la salida de kardex de cada uno. `--execute` hace todo en una transacción:
 * lock del comprobante, reversa como corrección de fecha y despacho nuevo a la fecha de
 * emisión; si alguna línea iría a revisión, no se escribe nada.
 *
 * Uso (vía `pnpm dispatch:redate`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm dispatch:redate --number FFA1-00001386 [--branch local|local-e2e|dev|demo|production]
 *   pnpm dispatch:redate --number FFA1-00001386 --execute --branch production --confirm-production
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { dispatchCode } from '@ayr/shared';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';
import { PrismaService } from '../src/prisma/prisma.service';
import { InvoiceDispatchService } from '../src/invoicing/invoice-dispatch.service';
import type { RequestUser } from '../src/auth/auth.types';

const execute = process.argv.includes('--execute');
const numberFlag = process.argv.indexOf('--number');
const number = numberFlag === -1 ? undefined : process.argv[numberFlag + 1];

const day = (d: Date): string => d.toISOString().slice(0, 10);

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  const branch = process.env.AYR_CLI_BRANCH ?? '(sin declarar)';
  console.error(`Destino: ${branch}`);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  if (number === undefined) throw new Error('Falta --number <serie-correlativo>');

  const prisma = new PrismaClient();
  const actorEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!actorEmail) throw new Error('Falta ADMIN_EMAIL en el entorno');
  const actorUser = await prisma.user.findUnique({ where: { email: actorEmail } });
  await prisma.$disconnect();
  if (!actorUser || !actorUser.active || actorUser.role !== Role.ADMINISTRADOR) {
    throw new Error(`${actorEmail} no es un ADMINISTRADOR activo en esta rama`);
  }
  const actor: RequestUser = {
    id: actorUser.id,
    email: actorUser.email,
    name: actorUser.name,
    role: actorUser.role,
    mustChangePassword: false,
    sessionId: 'cli',
  };

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const db = app.get(PrismaService);
    const service = app.get(InvoiceDispatchService);
    const invoice = await db.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { id: true, number: true, issueDate: true, status: true },
    });
    if (invoice === null) throw new Error(`No existe el comprobante ${number}`);

    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        console.warn(
          `${invoice.number ?? ''} · ${invoice.status} · emisión ${day(invoice.issueDate)}`,
        );
        const linked = await service.linkedInTx(tx, invoice.id);
        for (const d of linked) {
          const items = await tx.dispatchItem.findMany({
            where: { dispatchId: d.id },
            select: { description: true, reserveQty: true, movementId: true },
          });
          console.warn(
            `  ${dispatchCode(d.seq)} al ${day(d.dispatchDate)} · ${d.atIssueDate ? 're-fechable' : 'fecha propia: no se toca'}`,
          );
          for (const it of items) {
            const mv =
              it.movementId === null
                ? null
                : await tx.inventoryMovement.findUnique({
                    where: { id: it.movementId },
                    select: { operationDate: true, qty: true, totalCost: true },
                  });
            console.warn(
              `    ${it.description} · ${it.reserveQty.toString()} · salida ${
                mv === null
                  ? 'sin movimiento'
                  : `${day(mv.operationDate)} ${mv.qty.toString()} S/ ${mv.totalCost.toString()}`
              }`,
            );
          }
        }
        if (!linked.some((d) => d.atIssueDate)) {
          throw new Error('El comprobante no tiene despachos a la fecha del comprobante');
        }
      },
      { timeout: 60_000 },
    );

    if (!execute) {
      console.warn(
        '\nDry-run: no se escribió nada. Con --execute se revierten los re-fechables (a la fecha de su salida) y se vuelve a despachar a la fecha de emisión, en una sola transacción.',
      );
      return;
    }
    console.warn('\nEjecutando…');
    const done = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "fiscal_documents" WHERE "id" = ${invoice.id}::uuid FOR UPDATE
        `;
        return service.redateInTx(tx, actor, invoice.id);
      },
      { timeout: 120_000 },
    );
    console.warn(`Listo, con auditoría: ${JSON.stringify(done)}`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
