import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createFinish } from '../helpers/api';
import { postExpectingError } from '../helpers/production';
import {
  buyRoofingCoil,
  coilOptions,
  createRoofingProduct,
  purgeRoofingTrail,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-270..D-273 — el maestro de colores es el color comercial; el RAL vive en el acabado.
 *
 * Dos cosas que solo el API de verdad puede probar: que planta ve las bobinas de **otro RAL
 * del mismo color** y las ve después de las del acabado exacto del producto (D-271), y que el
 * maestro no deja crear ni renombrar un color con RAL o con nombre de tipo (D-273).
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 180_000 });

test.describe('Color comercial (D-270..D-273)', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('planta ve otro RAL del mismo color, después del acabado exacto y con su RAL (D-271)', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '700' });
    // Otro acabado del **mismo color**: el mismo color comercial con otro RAL.
    const otherRal = await createFinish(api, {
      name: 'Aluzinc E2E 3020',
      densityFactor: '8.0000',
      kind: 'PREPINTADO',
      colorId: scenario.color.id,
      businessLine: 'metallic-roofing',
    });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
    };
    const extras: { coilIds: string[]; purchaseIds: string[] } = { coilIds: [], purchaseIds: [] };

    try {
      // Una bobina del otro RAL, comprada **después** que la del escenario: su código es mayor.
      const other = await buyRoofingCoil(api, {
        supplierId: scenario.supplier.id,
        finishId: otherRal.id,
        colorId: scenario.color.id,
        weightKg: '600',
      });
      extras.coilIds.push(other.coil.id);
      extras.purchaseIds.push(other.purchaseId);
      // Un producto vendido en ese otro RAL. Para él, la bobina exacta es la de código mayor:
      // sin D-271 saldría segunda, porque el API ordenaba solo por código.
      const { product: product3020 } = await createRoofingProduct(api, {
        finishId: otherRal.id,
        colorId: scenario.color.id,
      });
      trail.productIds = [...(trail.productIds ?? []), product3020.id];

      // Producto del RAL del escenario: su bobina primero, la 3020 después, y las dos se ofrecen.
      const forScenario = await coilOptions(api, scenario.product.id);
      const ids = forScenario.map((o) => o.coilId);
      expect(ids).toContain(scenario.coil.id);
      expect(ids).toContain(other.coil.id);
      expect(ids.indexOf(scenario.coil.id)).toBeLessThan(ids.indexOf(other.coil.id));
      expect(forScenario.find((o) => o.coilId === scenario.coil.id)?.exactFinish).toBe(true);
      expect(forScenario.find((o) => o.coilId === other.coil.id)).toMatchObject({
        exactFinish: false,
        ral: '3020',
        finishName: 'Aluzinc E2E 3020',
        colorId: scenario.color.id,
      });

      // Producto 3020: el orden se invierte contra el código.
      const for3020 = (await coilOptions(api, product3020.id)).map((o) => o.coilId);
      expect(for3020.indexOf(other.coil.id)).toBeLessThan(for3020.indexOf(scenario.coil.id));
    } finally {
      await purgeRoofingTrail(api, {
        coilIds: extras.coilIds,
        purchaseIds: extras.purchaseIds,
      });
      await purgeRoofingTrail(api, trail);
      await api
        .patch(`/api/finishes/${otherRal.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('el maestro no admite un color con RAL ni con nombre de tipo (D-273)', async () => {
    for (const body of [
      { code: 'E2EROJO-3020', name: 'E2E Rojo tráfico', hexColor: '#9b2423' },
      { code: 'E2EROJOX', name: 'E2E Rojo 3020', hexColor: '#9b2423' },
      { code: 'NATURAL', name: 'E2E Natural', hexColor: '#cccccc' },
      { code: 'E2EGALV', name: 'Galvanizado', hexColor: '#cccccc' },
      { code: 'E2EROJOY', name: 'E2E Rojo con RAL', ralCode: '3020', hexColor: '#9b2423' },
    ]) {
      const error = await postExpectingError(api, '/api/colors', body);
      expect(error.status, JSON.stringify(body)).toBe(400);
    }
  });
});
