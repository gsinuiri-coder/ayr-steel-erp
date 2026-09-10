/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Diagnóstico de solo lectura del catálogo de coberturas (D-127).
 *
 * Las reglas nuevas —subtipo obligatorio, largo fijo obligatorio en `PLANCHA`, unidad coherente
 * con el subtipo— son un cambio **no aditivo** sobre datos existentes, que es exactamente lo
 * que D-123 dice verificar contra la población completa y no contra una muestra. Este guion
 * lista los productos que quedarían bloqueados para cualquier edición, antes de desplegar.
 *
 * No escribe nada. Uso: `node scripts/check-roofing-catalog.mjs --branch production`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isPlausiblePieceLength, PIECE_LENGTH_RANGE_LABEL } from '@ayr/shared';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  const products = await prisma.product.findMany({
    where: { businessLine: { code: 'METALLIC_ROOFING' } },
    select: {
      sku: true,
      name: true,
      unit: true,
      lengthMm: true,
      roofingKind: true,
      isActive: true,
    },
    orderBy: { sku: 'asc' },
  });

  console.log(`Catálogo de coberturas en ${label}: ${products.length} producto(s).`);

  const sinSubtipo = products.filter((p) => p.roofingKind === null);
  const planchaSinLargo = products.filter(
    (p) => p.roofingKind === 'PLANCHA' && p.lengthMm === null,
  );
  // El servicio exige `NIU` para `PLANCHA` y `MTR` para `A_MEDIDA`; el CHECK de la base es más
  // laxo. Lo que queda en el medio es lo que se puede editar en la base pero no por la app.
  const unidadIncoherente = products.filter(
    (p) =>
      (p.roofingKind === 'A_MEDIDA' && p.unit !== 'MTR') ||
      (p.roofingKind === 'PLANCHA' && p.unit !== 'NIU'),
  );
  // D-166: el largo que **está** pero no se puede creer. El campo del catálogo pide
  // milímetros y el resto de la pantalla de coberturas trabaja en metros, así que un "3" por
  // 3 000 entra sin que nada avise — y D-161 multiplica el precio por ese número, dejando la
  // cotización mil veces más barata. Estos ya no se pueden cotizar (el API los rechaza) y hay
  // que corregirlos a mano en el catálogo.
  const largoImposible = products.filter(
    (p) =>
      p.roofingKind === 'PLANCHA' &&
      p.lengthMm !== null &&
      !isPlausiblePieceLength(p.lengthMm.toFixed(2)),
  );

  const report = (title: string, rows: typeof products) => {
    if (rows.length === 0) {
      console.log(`  ok  ${title}: ninguno.`);
      return;
    }
    console.log(`  ATENCIÓN  ${title}: ${rows.length}`);
    for (const p of rows) {
      console.log(
        `          ${p.sku} — ${p.name} (unidad ${p.unit}, largo ${p.lengthMm?.toFixed(2) ?? 'sin'}, subtipo ${p.roofingKind ?? 'sin'}${p.isActive ? '' : ', desactivado'})`,
      );
    }
  };

  report('sin subtipo', sinSubtipo);
  report('PLANCHA sin largo fijo (no se van a poder editar)', planchaSinLargo);
  report('con unidad incoherente con su subtipo', unidadIncoherente);
  report(
    `PLANCHA con largo IMPOSIBLE — no se pueden cotizar, el largo va entre ${PIECE_LENGTH_RANGE_LABEL} (D-166)`,
    largoImposible,
  );
  if (largoImposible.length > 0) {
    console.log('');
    console.log('  El campo del catálogo va en MILÍMETROS: una plancha de 3 metros son 3000.');
    console.log('  Corrígelos en Catálogo antes de cotizarlos; el largo de arriba está en mm.');
  }

  if (
    sinSubtipo.length +
      planchaSinLargo.length +
      unidadIncoherente.length +
      largoImposible.length ===
    0
  ) {
    console.log('Nada que corregir.');
  }

  await reportPlanchaExposure();
}

/**
 * Censo de la plancha de catálogo bajo el modelo de D-171 (se produce contra el pedido).
 *
 * Responde dos cosas distintas. La primera es **a cuántos documentos vivos alcanzó el
 * cambio** —el censo que hizo falta antes de tomarlo— y si quedó saldo de producto terminado
 * que ningún pedido va a consumir. La segunda es un chequeo de datos que D-171 volvió
 * necesario: una plancha ahora promete **kilos de bobina**, y para calcularlos hace falta su
 * espesor, su ancho y su acabado. Un SKU al que le falte alguno se cotizaba sin problema con
 * el modelo viejo —reservaba unidades— y con el nuevo rebota al cotizar.
 */
async function reportPlanchaExposure(): Promise<void> {
  const planchas = await prisma.product.findMany({
    where: { roofingKind: 'PLANCHA' },
    select: {
      id: true,
      sku: true,
      lengthMm: true,
      thicknessMm: true,
      widthMm: true,
      finishId: true,
      isActive: true,
    },
    orderBy: { sku: 'asc' },
  });
  console.log('');
  console.log(`Exposición del modelo actual de PLANCHA: ${planchas.length} SKU.`);
  if (planchas.length === 0) return;

  const ids = planchas.map((p) => p.id);
  const skuById = new Map(planchas.map((p) => [p.id, p.sku]));

  const [quotationLines, orderLines, balances, toStockOrders] = await Promise.all([
    prisma.quotationItem.groupBy({
      by: ['productId'],
      where: { productId: { in: ids }, quotation: { status: { in: ['DRAFT', 'EMITTED'] } } },
      _count: { _all: true },
    }),
    prisma.salesOrderItem.groupBy({
      by: ['productId'],
      where: {
        productId: { in: ids },
        salesOrder: {
          status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_FULFILLED'] },
        },
      },
      _count: { _all: true },
    }),
    prisma.inventoryBalance.findMany({
      where: { itemType: 'PRODUCT', itemId: { in: ids }, qty: { gt: 0 } },
      select: { itemId: true, qty: true },
    }),
    // D-140: las OP «a stock», las que no cuelgan de ninguna reserva. Son las que hoy reponen
    // el saldo del que se vende una plancha.
    prisma.productionOrder.count({
      where: { productId: { in: ids }, reservationId: null },
    }),
  ]);

  const line = (label: string, rows: { productId: string; _count: { _all: number } }[]) => {
    const total = rows.reduce((acc, r) => acc + r._count._all, 0);
    console.log(`  ${label}: ${total}`);
    for (const r of rows) {
      console.log(`      ${skuById.get(r.productId) ?? r.productId}: ${r._count._all}`);
    }
  };

  line('líneas de plancha en cotizaciones vivas (borrador o emitida)', quotationLines);
  line('líneas de plancha en pedidos vivos (confirmado, en producción o parcial)', orderLines);
  console.log(`  saldo de producto terminado de plancha: ${balances.length} SKU con saldo`);
  for (const b of balances) {
    console.log(`      ${skuById.get(b.itemId) ?? b.itemId}: ${b.qty.toFixed(3)}`);
  }
  console.log(`  órdenes de producción de plancha «a stock» (sin reserva): ${toStockOrders}`);

  // D-171: sin espesor, ancho y acabado no hay forma de convertir planchas en kilos de bobina,
  // y la línea rebota al cotizar. Con el modelo viejo (reserva de unidades) estos SKU se
  // cotizaban sin problema, así que el defecto solo aparece después del cambio.
  const sinGeometria = planchas.filter(
    (p) => p.thicknessMm === null || p.widthMm === null || p.finishId === null,
  );
  if (sinGeometria.length === 0) {
    console.log(
      '  ok  Toda plancha tiene espesor, ancho y acabado: se puede calcular su material.',
    );
    return;
  }
  console.log(
    `  ATENCIÓN  ${sinGeometria.length} plancha(s) sin espesor, ancho o acabado: no se van a poder cotizar (D-171)`,
  );
  for (const p of sinGeometria) {
    const falta = [
      p.thicknessMm === null ? 'espesor' : null,
      p.widthMm === null ? 'ancho' : null,
      p.finishId === null ? 'acabado' : null,
    ]
      .filter((x) => x !== null)
      .join(', ');
    console.log(`      ${p.sku}${p.isActive ? '' : ' (inactivo)'} — falta ${falta}`);
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
