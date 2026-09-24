/**
 * CLI del barrido de lo ya importado (RF-S4b). Dry-run por defecto.
 *
 * Compara todas las cotizaciones y pedidos que trajo el importador contra el comprobante de
 * origen (el export de ventas detalladas) y lista (a) líneas que R1 resolvería distinto, (b)
 * importes que no son los del papel y (c) documentos abiertos que no se pueden confirmar ni emitir
 * y que el execute no resuelve solo. `--execute` corrige solo documentos **abiertos**, por los
 * servicios de dominio y auditado.
 *
 * Uso (vía `pnpm sweep:imported`, que compila con `tsc -p tsconfig.cli.json`):
 *   pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx [--branch …]
 *   pnpm sweep:imported --file … --execute --branch production --confirm-production
 *   pnpm sweep:imported --file … --json                    (el reporte en JSON)
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { assertExecuteAllowed } from './cli-gate';
import type { RequestUser } from '../src/auth/auth.types';
import {
  ImportedDocumentsSweepService,
  type SweepDocument,
} from '../src/imports/imported-documents-sweep.service';
import { readPaperLines } from '../src/imports/quotation-import.service';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const filePath = argValue('--file');
const execute = process.argv.includes('--execute');
const asJson = process.argv.includes('--json');

function printDocument(doc: SweepDocument): void {
  const head = `  ${doc.kind} ${doc.code} (${doc.status}${doc.open ? ', abierto' : ''}) ← ${doc.externalKey}`;
  if (doc.unmatched) {
    console.warn(`${head}: ${doc.unmatched}`);
    return;
  }
  console.warn(head);
  for (const f of doc.findings) {
    // Revisión cruzada RF-S4b (P1-1): cada hallazgo dice qué SKU tiene la línea, cuál tendría
    // después y con qué fila del papel se emparejó, para que un cruce se vea antes del execute.
    const skus = `${f.productSku} → ${f.newSku} (papel: ${f.paperSku ?? 'sin pareja'})`;
    if (f.product) {
      const fix = f.product.autoCoilCode
        ? `→ se ata a ${f.product.autoCoilCode}`
        : `→ ${String(f.product.candidates)} candidata(s): elige a mano`;
      console.warn(`      (a) línea ${String(f.lineNumber)} ${skus}: ${f.product.reason} ${fix}`);
    }
    if (f.unpaired) {
      console.warn(
        `      (c) línea ${String(f.lineNumber)} ${f.productSku}: ${f.unpaired}; no se toca`,
      );
    }
    if (f.amounts) {
      const p = f.amounts.paper;
      const s = f.amounts.stored;
      console.warn(
        `      (b) línea ${String(f.lineNumber)} ${skus}: guardado ${s.net} / ${s.igv} / ${s.total} · ` +
          `papel ${p.net} / ${p.igv ?? '(IGV calculado)'} / ${p.total ?? '(total calculado)'}`,
      );
    }
  }
  if (doc.unpairedPaperRows.length > 0) {
    console.warn(
      `      filas del papel sin línea en el documento: ${doc.unpairedPaperRows.join(', ')}`,
    );
  }
}

async function main(): Promise<void> {
  assertExecuteAllowed(execute);
  if (!filePath)
    throw new Error(
      'Uso: sweep-imported-documents-cli.ts --file <export.xlsx> [--execute] [--json]',
    );
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
    mustChangePassword: actorUser.mustChangePassword,
    sessionId: `cli-sweep-imported-${randomUUID()}`,
  };

  const paper = readPaperLines(readFileSync(resolve(filePath)));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const service = app.get(ImportedDocumentsSweepService);
    if (!execute) {
      const report = await service.report(paper);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
        return;
      }
      const withIssues = report.documents.filter((d) => d.findings.length > 0 || d.unmatched);
      const a = withIssues.filter((d) => d.findings.some((f) => f.product));
      const b = withIssues.filter((d) => d.findings.some((f) => f.amounts));
      const c = withIssues.filter(
        (d) =>
          d.open &&
          (d.unmatched !== null ||
            d.findings.some(
              (f) => f.unpaired !== null || (f.product !== null && f.product.autoCoilId === null),
            )),
      );
      console.warn(
        `Simulando (dry-run): ${String(report.reviewed)} documento(s) importado(s) revisado(s).\n`,
      );
      console.warn(
        `(a) Líneas con un producto que R1 resolvería distinto — ${String(a.length)} documento(s):`,
      );
      for (const d of a) printDocument(d);
      console.warn(`\n(b) Importes que no son los del papel — ${String(b.length)} documento(s):`);
      for (const d of b) printDocument(d);
      console.warn(
        `\n(c) Abiertos que el execute no resuelve solo — ${String(c.length)} documento(s):`,
      );
      for (const d of c) printDocument(d);
      const unmatched = withIssues.filter((d) => d.unmatched);
      console.warn(`\nSin comparar contra el papel: ${String(unmatched.length)} documento(s).`);
      return;
    }
    const result = await service.execute(actor, paper);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    console.warn(`Corregidos: ${String(result.fixed.length)} documento(s).`);
    for (const f of result.fixed)
      console.warn(`  ${f.kind} ${f.code}: líneas ${f.lines.join(', ')}`);
    console.warn(`\nRechazados por el dominio al corregir: ${String(result.failed.length)}.`);
    for (const f of result.failed) console.error(`  ${f.kind} ${f.code}: ${f.reason}`);
    console.warn(`\n(c) Quedan para el dueño: ${String(result.pending.length)} documento(s).`);
    for (const d of result.pending) printDocument(d);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
