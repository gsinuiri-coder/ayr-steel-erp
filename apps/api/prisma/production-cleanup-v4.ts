/* eslint-disable no-console -- guion de operación: su salida ES la consola (mismo criterio que price-floor-report.ts). */
/**
 * Limpia total de la ventana V-4: vacía todo lo transaccional de una rama para dejarla lista
 * para la carga de inventario real, preservando catálogo, líneas de negocio, usuarios y
 * configuración. Decisión del dueño (F8-V4prep, 2026-09-15): los comprobantes, clientes y
 * proveedores de hoy son todos de práctica — se purgan igual que compras, bobinas y kardex.
 *
 * PURGA (39 tablas, un solo `TRUNCATE ... RESTART IDENTITY CASCADE`): cotizaciones, pedidos,
 * OPs y sus reportes/staging, reservas, despachos, comprobantes, cobranzas/pagos, compras,
 * bobinas y todo su kardex, movimientos e inventario de productos, clientes, proveedores,
 * sesiones, auditoría, claves de idempotencia, cambios de precio, caja/POS y lotes de
 * importación. Ver `PURGE_TABLES` abajo para la lista exacta con su tabla real (`@@map`).
 *
 * SOBREVIVE (12 tablas, nunca se leen para escribir): líneas de negocio, catálogo de productos
 * (+ receta y materia prima), colores, acabados, usuarios, configuración (márgenes, ventas,
 * facturación). `exchange_rates` y `fiscal_series` quedan **fuera de alcance** de este script a
 * propósito (decisión del dueño): el historial de TC y los correlativos SUNAT los maneja el
 * runbook de la ventana (M3), no esta limpia.
 *
 * **Por qué un solo TRUNCATE y no 39 DELETE en cascada a mano.** `TRUNCATE ... CASCADE`
 * arrastra automáticamente cualquier tabla que tenga una FK hacia una de las nombradas — pero
 * nunca al revés. Antes de escribir esto se verificaron a mano las FK de las 12 tablas que
 * sobreviven contra las 39 que se purgan: ninguna sobreviviente tiene una columna que apunte a
 * una tabla purgada (todas sus FK van hacia otras sobrevivientes), así que el `CASCADE` no
 * puede alcanzarlas. El chequeo de conteos de `SURVIVOR_TABLES` al final de `main` es la red
 * de seguridad si esa verificación manual se equivocó en algo.
 *
 * `customers`/`suppliers` se purgan completos, incluidas sus dos filas sembradas por el
 * sistema (`isSystem`): el cliente «público en general» (D-077) y el proveedor «Saldo inicial
 * de inventario» (D-206). Después del truncate se corre `pnpm db:seed` completo — es
 * idempotente (no toca nada que ya sobreviva) y es exactamente lo que recrea esas dos filas.
 *
 * Dry-run por defecto: cuenta filas y no escribe nada. `--execute` trunca de verdad, revalida
 * los conteos justo antes (por si algo cambió entre el dry-run que miró el dueño y este
 * momento) y corre el seed al final. Nunca hay una segunda vía para borrar: quien quiera hacer
 * esto por SQL directo tiene que reescribir este archivo.
 *
 * Uso (vía el wrapper, nunca directo — regla dura 5 sobre las credenciales):
 *   pnpm limpia:v4 [--branch dev|demo|production|local|local-e2e]
 *   pnpm limpia:v4 --execute [--branch local]
 *   pnpm limpia:v4 --execute --branch production --confirm-production
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface PurgeTable {
  group: string;
  table: string;
}

/** Las 39 tablas que se vacían, en el orden en que las agrupa el brief de V-4prep. */
const PURGE_TABLES: PurgeTable[] = [
  { group: 'Cotizaciones', table: 'quotation_item_pieces' },
  { group: 'Cotizaciones', table: 'quotation_reservations' },
  { group: 'Cotizaciones', table: 'quotation_items' },
  { group: 'Cotizaciones', table: 'quotations' },
  { group: 'Pedidos', table: 'sales_order_item_pieces' },
  { group: 'Pedidos', table: 'sales_order_items' },
  { group: 'Pedidos', table: 'sales_orders' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_report_draft_pieces' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_report_drafts' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_report_pieces' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_reports' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_order_consumptions' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_order_items' },
  { group: 'Producción (OPs, reportes, staging)', table: 'production_orders' },
  { group: 'Reservas', table: 'reservations' },
  { group: 'Despachos', table: 'dispatch_items' },
  { group: 'Despachos', table: 'dispatches' },
  { group: 'Comprobantes', table: 'fiscal_document_items' },
  { group: 'Comprobantes', table: 'fiscal_documents' },
  { group: 'Cobranzas y pagos', table: 'customer_payments' },
  { group: 'Cobranzas y pagos', table: 'supplier_payments' },
  { group: 'Compras', table: 'purchase_items' },
  { group: 'Compras', table: 'purchases' },
  { group: 'Bobinas y su kardex', table: 'cutting_order_coils' },
  { group: 'Bobinas y su kardex', table: 'cutting_orders' },
  { group: 'Bobinas y su kardex', table: 'coil_splits' },
  { group: 'Bobinas y su kardex', table: 'coils' },
  { group: 'Inventario de productos', table: 'inventory_balances' },
  { group: 'Inventario de productos', table: 'inventory_movements' },
  { group: 'Cambios de precio', table: 'sales_price_changes' },
  { group: 'Idempotencia', table: 'idempotency_keys' },
  { group: 'Caja / mostrador', table: 'pos_sales' },
  { group: 'Caja / mostrador', table: 'cash_sessions' },
  { group: 'Importaciones (staging)', table: 'import_rows' },
  { group: 'Importaciones (staging)', table: 'import_batches' },
  { group: 'Clientes y proveedores', table: 'customers' },
  { group: 'Clientes y proveedores', table: 'suppliers' },
  { group: 'Sesiones y auditoría', table: 'sessions' },
  { group: 'Sesiones y auditoría', table: 'audit_log' },
];

/** Las 12 tablas que este script nunca escribe. Se usan solo para el chequeo de después. */
const SURVIVOR_TABLES = [
  'business_lines',
  'products',
  'product_boms',
  'raw_material_specs',
  'finishes',
  'colors',
  'users',
  'pricing_settings',
  'sales_settings',
  'invoicing_settings',
  'exchange_rates',
  'fiscal_series',
];

async function countTable(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${table}"`,
  );
  return Number(rows[0]?.count ?? 0n);
}

async function countAll(tables: string[]): Promise<Map<string, number>> {
  const entries = await Promise.all(
    tables.map(async (table) => [table, await countTable(table)] as const),
  );
  return new Map(entries);
}

/** Desglose para que el dueño confirme a ojo que no hay nada que contradiga "todo es de práctica". */
async function printFiscalDocumentBreakdown(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ doc_type: string; status: string; count: bigint }[]>(
    `SELECT doc_type, status, count(*)::bigint AS count
     FROM "fiscal_documents" GROUP BY doc_type, status ORDER BY doc_type, status`,
  );
  if (rows.length === 0) {
    console.log('  (no hay comprobantes)');
    return;
  }
  for (const row of rows) {
    console.log(`  ${row.doc_type.padEnd(24)} ${row.status.padEnd(14)} ${row.count}`);
  }
}

function printReport(label: string, counts: Map<string, number>): void {
  console.log(`\n${label}`);
  let currentGroup = '';
  let total = 0;
  for (const { group, table } of PURGE_TABLES) {
    if (group !== currentGroup) {
      console.log(`  ${group}:`);
      currentGroup = group;
    }
    const count = counts.get(table) ?? 0;
    total += count;
    console.log(`    ${table.padEnd(34)} ${count}`);
  }
  console.log(`  TOTAL de filas a purgar: ${total}`);
}

/** Corre `pnpm db:seed` (idempotente) con el mismo DATABASE_URL/DIRECT_URL de este proceso. */
function runSeed(): void {
  console.log('\nCorriendo el seed (recrea cliente y proveedor sembrados)...');
  const isWin = process.platform === 'win32';
  // `shell: true` en Windows: `pnpm.cmd` sin shell falla con EINVAL (Node 24, ver
  // docs/PROGRESO.md — mismo síntoma que en `dev-local.mjs`/`db-demo.mjs`).
  execFileSync(isWin ? 'pnpm.cmd' : 'pnpm', ['db:seed'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: isWin,
  });
}

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  const execute = process.argv.includes('--execute');
  const tables = PURGE_TABLES.map((t) => t.table);

  // Defensa redundante (hallazgo de revisión, F8-V4prep): el gate `--confirm-production` del
  // wrapper es lo único que impide un `--execute` contra producción sin querer, y este archivo
  // también se puede invocar directo (`pnpm exec tsx prisma/production-cleanup-v4.ts`) con
  // `DATABASE_URL`/`DIRECT_URL` copiadas a mano — ahí el gate del wrapper no corre. El wrapper
  // pone esta variable solo cuando ya pidió `--confirm-production` contra `production`; sin
  // ella, un `--execute` contra esa rama se niega acá también, sea cual sea el camino.
  if (execute && label === 'production' && process.env.AYR_LIMPIA_V4_CONFIRMED !== '1') {
    throw new Error(
      'Falta la confirmación de producción (AYR_LIMPIA_V4_CONFIRMED). Correr por ' +
        '`pnpm limpia:v4 --execute --branch production --confirm-production`, nunca este ' +
        'archivo directo con las credenciales copiadas a mano.',
    );
  }

  console.log(
    `Limpia V-4 sobre ${label}${execute ? ' — EJECUTANDO' : ' — dry-run (solo lectura)'}`,
  );

  const before = await countAll(tables);
  printReport('Conteos ANTES de purgar:', before);
  console.log('\nDesglose de comprobantes (doc_type / status), para confirmar que no hay nada');
  console.log('que contradiga "todos son de práctica":');
  await printFiscalDocumentBreakdown();

  if (!execute) {
    console.log('\nDry-run: no se escribió nada. Repetir con --execute para purgar de verdad.');
    return;
  }

  // Revalidación justo antes de escribir: si algo cambió entre el dry-run que miró el dueño y
  // este momento (alguien siguió usando la app), el conteo de ahora es el que manda.
  const revalidated = await countAll(tables);
  printReport('Conteos revalidados justo antes de truncar:', revalidated);

  const survivorsBefore = await countAll(SURVIVOR_TABLES);

  const quotedTables = tables.map((t) => `"${t}"`).join(', ');
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quotedTables} RESTART IDENTITY CASCADE`),
  ]);
  console.log(`\n${String(tables.length)} tablas purgadas.`);

  const after = await countAll(tables);
  const notEmpty = [...after.entries()].filter(([, count]) => count > 0);
  if (notEmpty.length > 0) {
    throw new Error(
      `Quedaron filas tras el truncate (no debería pasar): ${notEmpty
        .map(([t, c]) => `${t}=${String(c)}`)
        .join(', ')}`,
    );
  }

  const survivorsAfter = await countAll(SURVIVOR_TABLES);
  const changed = SURVIVOR_TABLES.filter((t) => survivorsBefore.get(t) !== survivorsAfter.get(t));
  if (changed.length > 0) {
    // Si esto dispara, la verificación manual de FK del comentario de arriba se equivocó en
    // algo: el CASCADE alcanzó una tabla que debía sobrevivir. Es la red de seguridad, no se
    // espera que corra nunca.
    throw new Error(
      `ALERTA: tablas que debían sobrevivir cambiaron de tamaño: ${changed
        .map((t) => `${t} (${String(survivorsBefore.get(t))} → ${String(survivorsAfter.get(t))})`)
        .join(', ')}`,
    );
  }
  console.log('Las 12 tablas que sobreviven no cambiaron de tamaño.');

  runSeed();
  console.log('\nLimpia V-4 completa. Anotar en docs/PROGRESO.md: rama, fecha/hora y este conteo.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
