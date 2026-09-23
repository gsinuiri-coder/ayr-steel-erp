/**
 * One-off SOLO LECTURA (2026-09-22): verifica el saldo e inventario valorizado de los tres SKU
 * UPVC tras la carga de inventario inicial (D-207) contra `demo`. Se borra al cerrar la sesión.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SKUS = ['UPVC36MT', 'UPVC6MT', 'UPVC36MTAZUL'];

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  const products = await prisma.product.findMany({
    where: { sku: { in: SKUS } },
    select: { id: true, sku: true },
  });

  console.log(`Saldo e inventario valorizado en ${label}:`);
  let total = 0;
  for (const sku of SKUS) {
    const product = products.find((p) => p.sku === sku);
    if (!product) {
      console.log(`  FALTA  ${sku}`);
      continue;
    }
    const balance = await prisma.inventoryBalance.findUnique({
      where: { itemType_itemId: { itemType: 'PRODUCT', itemId: product.id } },
    });
    const movements = await prisma.inventoryMovement.findMany({
      where: { itemType: 'PRODUCT', itemId: product.id },
      select: { qty: true, totalCost: true, refType: true, notes: true, operationDate: true },
    });
    const valorized = movements.reduce((acc, m) => acc + Number(m.totalCost), 0);
    total += valorized;
    console.log(
      `  ${sku}: saldo ${balance?.qty.toFixed(3) ?? '0'} | avgCost ${balance?.avgCost.toFixed(4) ?? '-'} | movimientos ${movements.length} (${movements.map((m) => m.refType).join(', ')}) | valorizado S/ ${valorized.toFixed(2)}`,
    );
  }
  console.log(`  TOTAL valorizado: S/ ${total.toFixed(2)} sin IGV`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
