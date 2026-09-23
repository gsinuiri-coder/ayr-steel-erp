/* eslint-disable no-console -- guion de diagnostico one-off: su salida ES la consola. */
/**
 * One-off SOLO LECTURA (2026-09-22): verifica en el catálogo si existen los SKU UPVC36MT,
 * UPVC6MT y UPVC36MTAZUL antes de armar el archivo de inventario inicial de productos
 * (D-207). No escribe nada. Se borra al cerrar la sesión.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SKUS = ['UPVC36MT', 'UPVC6MT', 'UPVC36MTAZUL'];

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  console.log(`Catálogo UPVC en ${label}`);
  console.log('');

  for (const sku of SKUS) {
    const products = await prisma.product.findMany({
      where: { sku },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        source: true,
        isActive: true,
        businessLine: { select: { code: true, name: true } },
        finish: { select: { code: true, kind: true } },
        color: { select: { name: true } },
      },
    });
    if (products.length === 0) {
      console.log(`  FALTA  ${sku}: no existe en ningún catálogo.`);
      continue;
    }
    for (const p of products) {
      console.log(
        `  OK  ${p.sku} — "${p.name}" | línea ${p.businessLine.code} (${p.businessLine.name}) | unidad ${p.unit} | source ${p.source} | activo ${p.isActive} | acabado ${p.finish?.code ?? 'sin'} (${p.finish?.kind ?? 'sin'}) | color ${p.color?.name ?? 'sin'}`,
      );
    }
  }

  console.log('');
  console.log('Todo el catálogo de la línea Coberturas (UPVC), para contexto:');
  const roofing = await prisma.product.findMany({
    where: { businessLine: { code: 'ROOFING' } },
    select: {
      sku: true,
      name: true,
      unit: true,
      source: true,
      isActive: true,
      color: { select: { name: true } },
    },
    orderBy: { sku: 'asc' },
  });
  if (roofing.length === 0) {
    console.log('  (vacío)');
  }
  for (const p of roofing) {
    console.log(
      `  ${p.sku} — "${p.name}" | unidad ${p.unit} | source ${p.source} | activo ${p.isActive} | color ${p.color?.name ?? 'sin'}`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
