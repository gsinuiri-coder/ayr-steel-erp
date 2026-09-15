import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createFinish } from '../helpers/api';
import { businessLineId } from '../helpers/production';
import {
  COIL_WIDTH,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  NOMINAL_THICKNESS,
  ROOFING_LINE,
} from '../helpers/roofing';

/**
 * F8-S5 — M0: dos huecos de catálogo heredados de F8-S4 (D-203).
 *
 * D-086 monta una bobina en la OP de coberturas solo si `coil.colorId === product.colorId`, y
 * desde D-203/M2 `coil.colorId` sale siempre del acabado de la bobina. Nada impedía que el
 * catálogo guardara un producto con un color distinto al de su propio acabado: esa combinación
 * no encuentra bobina jamás, y el defecto solo aparecía al cotizar, lejos de dónde se originó.
 * El segundo hueco es más simple: nada impedía un acabado de otra línea de negocio en un
 * producto, que rompe el filtro `businessLineId` del mismo D-086.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea acabados, colores y productos: nunca contra producción (D-126).');

interface ApiRejection {
  status: number;
  message: string;
}

async function rejection(
  api: APIRequestContext,
  method: 'post' | 'patch',
  path: string,
  data: unknown,
): Promise<ApiRejection> {
  const res = await api[method](path, { data });
  expect(res.ok(), `${method.toUpperCase()} ${path} debía fallar y devolvió ${res.status()}`).toBe(
    false,
  );
  const body = (await res.json()) as {
    message?: string | string[];
    errors?: Record<string, string[] | undefined>;
  };
  const head = Array.isArray(body.message) ? body.message : [body.message ?? ''];
  const fields = Object.values(body.errors ?? {}).flatMap((m) => m ?? []);
  return { status: res.status(), message: [...head, ...fields].join(' | ') };
}

async function deactivate(api: APIRequestContext, kind: 'finishes' | 'colors', ids: string[]) {
  for (const id of ids) {
    await api.patch(`/api/${kind}/${id}`, { data: { isActive: false } }).catch(() => undefined);
  }
}

async function deactivateProduct(api: APIRequestContext, id: string) {
  await api.patch(`/api/catalog/${id}`, { data: { isActive: false } }).catch(() => undefined);
}

test.describe('F8-S5/M0 — huecos de catálogo: color y línea del acabado (D-203)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el catálogo rechaza al crear un producto cuyo color no coincide con el de su acabado', async () => {
    const [colorA, colorB] = await Promise.all([
      createColor(api, '#111111'),
      createColor(api, '#222222'),
    ]);
    const finish = await createRoofingFinish(api, { colorId: colorA.id });
    const lineId = await businessLineId(api, ROOFING_LINE);
    let productId = '';
    try {
      const mismatched = await rejection(api, 'post', '/api/catalog', {
        businessLineId: lineId,
        sku: `E2E-M0COL${Date.now()}`,
        name: 'Cobertura E2E color desalineado',
        unit: 'MTR',
        source: 'MANUFACTURED',
        finishId: finish.id,
        colorId: colorB.id,
        thicknessMm: NOMINAL_THICKNESS,
        widthMm: COIL_WIDTH,
        roofingKind: 'A_MEDIDA',
      });
      expect(mismatched.status).toBe(400);
      expect(mismatched.message).toContain('no coincide con el del acabado');

      // Con el color que sí es del acabado, se crea sin problema.
      const { product } = await createRoofingProduct(api, {
        finishId: finish.id,
        colorId: colorA.id,
      });
      productId = product.id;
      expect(product.colorId).toBe(colorA.id);
    } finally {
      if (productId) await deactivateProduct(api, productId);
      await deactivate(api, 'finishes', [finish.id]);
      await deactivate(api, 'colors', [colorA.id, colorB.id]);
    }
  });

  test('el catálogo rechaza al editar un producto hacia un color o un acabado que ya no coinciden', async () => {
    const [colorA, colorB] = await Promise.all([
      createColor(api, '#333333'),
      createColor(api, '#444444'),
    ]);
    const finishA = await createRoofingFinish(api, { colorId: colorA.id });
    const finishB = await createRoofingFinish(api, { colorId: colorB.id });
    const { product } = await createRoofingProduct(api, {
      finishId: finishA.id,
      colorId: colorA.id,
    });
    try {
      // Cambiar solo el color, dejando el acabado de A: se desalinea con finishA.
      const byColor = await rejection(api, 'patch', `/api/catalog/${product.id}`, {
        colorId: colorB.id,
      });
      expect(byColor.status).toBe(400);
      expect(byColor.message).toContain('no coincide con el del acabado');

      // Cambiar solo el acabado a B, dejando el color en A: se desalinea con finishB.
      const byFinish = await rejection(api, 'patch', `/api/catalog/${product.id}`, {
        finishId: finishB.id,
      });
      expect(byFinish.status).toBe(400);
      expect(byFinish.message).toContain('no coincide con el del acabado');

      // Cambiando los dos a la vez, coherentes entre sí, se acepta.
      const res = await api.patch(`/api/catalog/${product.id}`, {
        data: { finishId: finishB.id, colorId: colorB.id },
      });
      expect(res.ok(), await res.text()).toBe(true);
    } finally {
      await deactivateProduct(api, product.id);
      await deactivate(api, 'finishes', [finishA.id, finishB.id]);
      await deactivate(api, 'colors', [colorA.id, colorB.id]);
    }
  });

  test('el catálogo rechaza al crear un producto con un acabado de otra línea de negocio', async () => {
    const drywallFinish = await createFinish(api, { businessLine: 'drywall' });
    const lineId = await businessLineId(api, ROOFING_LINE);
    try {
      const otherLine = await rejection(api, 'post', '/api/catalog', {
        businessLineId: lineId,
        sku: `E2E-M0LIN${Date.now()}`,
        name: 'Cobertura E2E acabado de otra línea',
        unit: 'MTR',
        source: 'MANUFACTURED',
        finishId: drywallFinish.id,
        thicknessMm: NOMINAL_THICKNESS,
        widthMm: COIL_WIDTH,
        roofingKind: 'A_MEDIDA',
      });
      expect(otherLine.status).toBe(400);
      expect(otherLine.message).toContain(`El acabado ${drywallFinish.code} es de otra línea`);
    } finally {
      await deactivate(api, 'finishes', [drywallFinish.id]);
    }
  });

  test('el catálogo rechaza al editar un producto hacia un acabado de otra línea de negocio', async () => {
    const color = await createColor(api, '#555555');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const drywallFinish = await createFinish(api, { businessLine: 'drywall' });
    const { product } = await createRoofingProduct(api, { finishId: finish.id, colorId: color.id });
    try {
      const otherLine = await rejection(api, 'patch', `/api/catalog/${product.id}`, {
        finishId: drywallFinish.id,
      });
      expect(otherLine.status).toBe(400);
      expect(otherLine.message).toContain(`El acabado ${drywallFinish.code} es de otra línea`);
      // Y el producto se quedó con el acabado que tenía.
      const still = await api.get(`/api/catalog/${product.id}`);
      expect((await still.json()).finishId).toBe(finish.id);
    } finally {
      await deactivateProduct(api, product.id);
      await deactivate(api, 'finishes', [finish.id, drywallFinish.id]);
      await deactivate(api, 'colors', [color.id]);
    }
  });
});
