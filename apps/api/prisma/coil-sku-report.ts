/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Diagnóstico de SOLO LECTURA del SKU de venta directa de bobina (D-037, arreglado por D-168).
 *
 * Hasta D-168 había **dos** cuentas para el mismo SKU y no coincidían cuando el código de
 * acabado llevaba guiones adentro —`ALZ-ROJO-3002`, que es como los tiene el cliente—: el
 * catálogo daba de alta `BOBALZ-ROJO-30020.45` y la venta directa buscaba
 * `BOBALZROJO30020.45`. El síntoma era «no existe el producto de venta directa» sobre una
 * bobina que sí tenía el suyo.
 *
 * Este guion contesta las dos preguntas que quedan **después** del arreglo, que son sobre los
 * datos y no sobre el código:
 *
 * 1. ¿Hay bobinas cuyo `typeKey` no tiene producto de `trading`? (la venta directa las
 *    rechazaría; el alta de una bobina nueva de ese tipo lo crearía sola).
 * 2. ¿Quedaron productos `BOB…` en `trading` que **ninguna** bobina nombra? Son los que la
 *    forma vieja pudo haber dejado, más los que alguien creó a mano. **No se borran acá**:
 *    un SKU puede estar cotizado o vendido, y darlo de baja es una decisión del dueño.
 *
 * No escribe nada. Uso: `node scripts/check-coil-skus.mjs --branch production`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { COIL_SALE_IDENTITY_SELECT, coilSaleSkus } from '../src/sales/coil-sale-product';

const prisma = new PrismaClient();

/**
 * Revisión cruzada RF-S4b (P2-10): el SKU de venta de cada bobina sale de **la misma** función
 * que usa la venta (`coilSaleSkus`, D-252): el canónico y, durante la transición, el viejo. Con la
 * cuenta de antes (`coilSkuFromTypeKey`), después de la normalización este guion reportaba cada
 * tipo como «sin producto» —el caso de D-168: dos cuentas del mismo SKU que no coinciden—.
 */
async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';

  const [coils, tradingProducts] = await Promise.all([
    prisma.coil.findMany({ select: { code: true, ...COIL_SALE_IDENTITY_SELECT } }),
    prisma.product.findMany({
      where: { businessLine: { code: 'TRADING' }, sku: { startsWith: 'BOB' } },
      select: { sku: true, name: true, isActive: true },
      orderBy: { sku: 'asc' },
    }),
  ]);

  const activeSkus = new Set(tradingProducts.filter((p) => p.isActive).map((p) => p.sku));
  // Un pool por SKU canónico: cuántas bobinas tiene y si alguna forma de su SKU está activa.
  const pools = new Map<string, { legacy: Set<string>; coils: number }>();
  for (const coil of coils) {
    const { canonical, legacy } = coilSaleSkus(coil);
    const pool = pools.get(canonical) ?? { legacy: new Set<string>(), coils: 0 };
    pool.legacy.add(legacy);
    pool.coils += 1;
    pools.set(canonical, pool);
  }
  const named = new Set([...pools].flatMap(([canonical, p]) => [canonical, ...p.legacy]));

  console.log(
    `Bobinas en ${label}: ${String(coils.length)}, en ${String(pools.size)} pool(s) de venta; productos BOB… en trading: ${String(tradingProducts.length)}.`,
  );

  const sinProducto = [...pools].filter(
    ([canonical, p]) => !activeSkus.has(canonical) && ![...p.legacy].some((s) => activeSkus.has(s)),
  );
  if (sinProducto.length === 0) {
    console.log('  ok  Todo pool de bobinas tiene su producto de venta directa activo.');
  } else {
    console.log(`  !!  ${String(sinProducto.length)} pool(s) SIN producto de venta activo:`);
    for (const [canonical, p] of sinProducto) {
      console.log(`      ${canonical} (${String(p.coils)} bobina[s])`);
    }
    console.log(
      '      Se crea solo al dar de alta la próxima bobina de ese pool (D-252); el catálogo no ' +
        'deja crearlo a mano (D-257).',
    );
  }

  const huerfanos = tradingProducts.filter((p) => p.isActive && !named.has(p.sku));
  if (huerfanos.length === 0) {
    console.log('  ok  Ningún producto BOB… activo quedó sin bobinas que lo nombren.');
  } else {
    console.log(
      `  ??  ${String(huerfanos.length)} producto(s) BOB… activos que ninguna bobina nombra:`,
    );
    for (const p of huerfanos) console.log(`      ${p.sku} — ${p.name}`);
    console.log(
      '      Un suelto cargado a mano (como BOB38AZUL de COT-000002) o un pool que se agotó. ' +
        'La normalización (pnpm normalize:coil-skus) los lista y los une; desde acá no se toca nada.',
    );
  }
}
main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
