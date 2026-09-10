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
import { coilSkuFromTypeKey } from '@ayr/shared';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';

  const [coils, tradingProducts] = await Promise.all([
    prisma.coil.groupBy({ by: ['typeKey'], _count: { _all: true } }),
    prisma.product.findMany({
      where: { businessLine: { code: 'TRADING' }, sku: { startsWith: 'BOB' } },
      select: { sku: true, name: true, isActive: true },
      orderBy: { sku: 'asc' },
    }),
  ]);

  const bySku = new Map(tradingProducts.map((p) => [p.sku, p]));
  const expected = coils.map((c) => ({
    typeKey: c.typeKey,
    coils: c._count._all,
    sku: coilSkuFromTypeKey(c.typeKey),
  }));
  const expectedSkus = new Set(expected.map((e) => e.sku));

  console.log(
    `Bobinas en ${label}: ${coils.length} tipo(s) distinto(s); productos BOB… en trading: ${tradingProducts.length}.`,
  );

  const sinProducto = expected.filter((e) => !bySku.has(e.sku));
  if (sinProducto.length === 0) {
    console.log('  ok  Todo typeKey de bobina tiene su producto de venta directa.');
  } else {
    console.log(`  !!  ${sinProducto.length} tipo(s) de bobina SIN producto de venta directa:`);
    for (const row of sinProducto) {
      console.log(`      ${row.typeKey} (${row.coils} bobina[s]) → falta el SKU ${row.sku}`);
    }
    console.log(
      '      Se crean solos al dar de alta la próxima bobina de ese tipo; para venderlas ya, ' +
        'créalos en el catálogo de Trading con ese SKU exacto.',
    );
  }

  const huerfanos = tradingProducts.filter((p) => !expectedSkus.has(p.sku));
  if (huerfanos.length === 0) {
    console.log('  ok  Ningún producto BOB… quedó sin bobinas que lo nombren.');
  } else {
    console.log(`  ??  ${huerfanos.length} producto(s) BOB… que ninguna bobina nombra:`);
    for (const p of huerfanos) {
      console.log(`      ${p.sku}${p.isActive ? '' : ' (inactivo)'} — ${p.name}`);
    }
    console.log(
      '      Puede ser un tipo de bobina que se agotó y se anuló, un SKU creado a mano, o un ' +
        'resto de la forma vieja del SKU (D-168). NO se migran ni se borran desde acá: primero ' +
        'hay que ver si alguno está cotizado o vendido.',
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
