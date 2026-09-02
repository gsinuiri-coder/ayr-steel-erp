/**
 * Inventario SOLO LECTURA de lo que los E2E de escritura dejan en la base (D-024).
 * Cuenta y lista las entidades con marcas de prueba para poder documentarlo tras cada
 * `pnpm e2e:prod` y revisarlo a simple vista. No borra nada ni imprime datos reales del
 * negocio. Se invoca desde `scripts/prod-e2e-leftovers.mjs`, que le pasa la conexión.
 */
import { PrismaClient } from '@prisma/client';

const TEST_NAME = { contains: 'E2E', mode: 'insensitive' as const };

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const [suppliers, finishes, products, coils, purchases, movements] = await Promise.all([
      prisma.supplier.findMany({
        where: { name: TEST_NAME },
        select: { code: true, isActive: true },
      }),
      prisma.finish.findMany({ where: { name: TEST_NAME }, select: { isActive: true } }),
      prisma.product.findMany({
        where: { sku: { startsWith: 'BOB' } },
        select: { sku: true, isActive: true },
      }),
      prisma.coil.findMany({
        where: { supplier: { name: TEST_NAME } },
        select: { code: true, status: true },
      }),
      prisma.purchase.findMany({
        where: { supplier: { name: TEST_NAME } },
        select: { series: true, number: true, type: true, status: true, total: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.inventoryMovement.count(),
    ]);

    const active = (rows: { isActive: boolean }[]) => rows.filter((r) => r.isActive).length;
    console.warn(`proveedores E2E: ${suppliers.length} (activos: ${active(suppliers)})`);
    console.warn(`acabados E2E: ${finishes.length} (activos: ${active(finishes)})`);
    console.warn(
      `productos BOB de trading (D-037): ${products.length} (activos: ${active(products)})`,
    );
    console.warn(
      `bobinas de proveedores E2E: ${coils.length} [${coils.map((c) => c.status).join(', ')}]`,
    );
    console.warn(`compras de proveedores E2E: ${purchases.length}`);
    for (const p of purchases) {
      console.warn(`  ${p.series}-${p.number}  ${p.type}  ${p.status}  ${p.total.toFixed(2)}`);
    }
    console.warn(`movimientos de kardex en total: ${movements}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
