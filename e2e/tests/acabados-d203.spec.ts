import { FINISH_FIELD_LABEL } from '@ayr/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createUser,
  finishOptionLabel,
  getItems,
  getJson,
  postJson,
} from '../helpers/api';
import {
  createCuttingSupplier,
  today,
  uniqueDocumentNumber,
  type ApiError,
  type CoilDto,
  type PurchaseDto,
} from '../helpers/production';
import {
  buyRoofingCoil,
  COIL_WIDTH,
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  mountCoil,
  NOMINAL_THICKNESS,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  ROOFING_LINE,
  setupRoofingScenario,
  TEST_DENSITY,
} from '../helpers/roofing';
import { createCustomer, stockPanel } from '../helpers/sales';
import { loginAndSetPassword, selectOption } from '../helpers/ui';

/**
 * F8-S4 — D-203: un acabado es tipo + color + línea, y el color de la bobina sale de él.
 *
 * Lo que se prueba es la regla completa, de punta a punta: el maestro no admite un acabado
 * incoherente (prepintado sin color, natural con color), no cambia de identidad cuando ya hay
 * material comprado con él, la compra ya no acepta un color suelto ni un acabado de otra línea,
 * la bobina hereda el color del acabado —y por eso cuenta en el agregado de ese color—, y el
 * color de una bobina se corrige cambiando su acabado, nunca a mano.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea acabados, compras y bobinas: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

interface FinishDto {
  id: string;
  code: string;
  kind: 'NATURAL' | 'PREPINTADO' | 'GALVANIZADO' | null;
  colorId: string | null;
  colorName: string | null;
  businessLine: string | null;
  /** Tiene bobinas o ítems de compra: tipo, color y línea quedan fijos. */
  inUse?: boolean;
}

async function patchJson<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await api.patch(path, { data });
  if (!res.ok()) throw new Error(`PATCH ${path} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Un rechazo con **todo** su texto. `errorFrom` solo lee `message`, y un rechazo del schema
 * (`ZodValidationPipe`) dice ahí «Datos inválidos» y deja el motivo real en `errors` por campo.
 * Las reglas de D-203 viven en los dos lados —schema compartido y servicio—, así que el caso
 * mira los dos.
 */
async function rejection(
  api: APIRequestContext,
  method: 'post' | 'patch',
  path: string,
  data: unknown,
): Promise<ApiError> {
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

function patchExpectingError(api: APIRequestContext, path: string, data: unknown) {
  return rejection(api, 'patch', path, data);
}

function postExpectingError(api: APIRequestContext, path: string, data: unknown) {
  return rejection(api, 'post', path, data);
}

/** Cuerpo de compra COIL de una sola bobina; `item` pisa lo que el caso quiera romper. */
function coilPurchaseBody(input: {
  supplierId: string;
  finishId: string;
  lineCode?: string;
  item?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    supplierId: input.supplierId,
    businessLine: input.lineCode ?? ROOFING_LINE,
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina E2E D-203',
        qty: '500',
        unit: 'KGM',
        unitPrice: '5',
        finishId: input.finishId,
        widthMm: COIL_WIDTH,
        thicknessMm: NOMINAL_THICKNESS,
        coilStatus: 'OPEN',
        ...input.item,
      },
    ],
  };
}

async function deactivate(api: APIRequestContext, kind: 'finishes' | 'colors', ids: string[]) {
  for (const id of ids) {
    await api.patch(`/api/${kind}/${id}`, { data: { isActive: false } }).catch(() => undefined);
  }
}

test.describe('F8-S4 — acabado con tipo, color y línea; la bobina toma el color del acabado (D-203)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('un acabado prepintado exige color y los otros tipos no lo admiten', async () => {
    const color = await createColor(api, '#1f6f43');
    const created: string[] = [];
    try {
      const base = {
        densityFactor: TEST_DENSITY,
        businessLine: ROOFING_LINE,
      };

      const sinColor = await postExpectingError(api, '/api/finishes', {
        ...base,
        code: `EPS${uniqueDocumentNumber().slice(-8)}`,
        name: 'Prepintado sin color E2E',
        kind: 'PREPINTADO',
        colorId: null,
      });
      expect(sinColor.status).toBe(400);
      expect(sinColor.message).toContain('Un acabado prepintado lleva color');

      for (const kind of ['NATURAL', 'GALVANIZADO'] as const) {
        const conColor = await postExpectingError(api, '/api/finishes', {
          ...base,
          code: `E${kind.slice(0, 2)}${uniqueDocumentNumber().slice(-8)}`,
          name: `${kind} con color E2E`,
          kind,
          colorId: color.id,
        });
        expect(conColor.status, `${kind} con color`).toBe(400);
        expect(conColor.message).toContain('Solo un acabado prepintado lleva color');
      }

      const code = `EPC${uniqueDocumentNumber().slice(-8)}`;
      const res = await api.post('/api/finishes', {
        data: {
          ...base,
          code,
          name: 'Prepintado con color E2E',
          kind: 'PREPINTADO',
          colorId: color.id,
        },
      });
      expect(res.status()).toBe(201);
      const ok = (await res.json()) as FinishDto;
      created.push(ok.id);
      expect(ok).toMatchObject({
        kind: 'PREPINTADO',
        colorId: color.id,
        colorName: color.name,
        businessLine: ROOFING_LINE,
      });
    } finally {
      await deactivate(api, 'finishes', created);
      await deactivate(api, 'colors', [color.id]);
    }
  });

  test('tipo, color y línea no se cambian en un acabado con una bobina comprada; sin uso, sí', async () => {
    const [supplier, colorX, colorY] = await Promise.all([
      createCuttingSupplier(api),
      createColor(api, '#aa0000'),
      createColor(api, '#0000aa'),
    ]);
    const used = await createRoofingFinish(api, { colorId: colorX.id });
    const unused = await createRoofingFinish(api, { colorId: colorX.id });
    let purchaseId = '';
    let coilId = '';
    try {
      const bought = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: used.id,
        colorId: colorX.id,
        weightKg: '300',
      });
      purchaseId = bought.purchaseId;
      coilId = bought.coil.id;
      expect(bought.coil.finishId, 'se compró con el acabado pedido, sin variante').toBe(used.id);
      expect((await getJson<FinishDto>(api, `/api/finishes/${used.id}`)).inUse).toBe(true);
      expect((await getJson<FinishDto>(api, `/api/finishes/${unused.id}`)).inUse).toBe(false);

      for (const change of [
        { colorId: colorY.id },
        { kind: 'NATURAL', colorId: null },
        { businessLine: 'drywall' },
      ]) {
        const error = await patchExpectingError(api, `/api/finishes/${used.id}`, change);
        expect(error.status, JSON.stringify(change)).toBe(400);
        expect(error.message).toContain('no se cambian');
      }
      // Lo que no es identidad sí se edita aunque tenga uso.
      const renamed = await patchJson<FinishDto & { name: string }>(
        api,
        `/api/finishes/${used.id}`,
        { name: 'Acabado E2E renombrado con uso' },
      );
      expect(renamed.name).toBe('Acabado E2E renombrado con uso');
      expect((await getJson<CoilDto>(api, `/api/coils/${coilId}`)).colorId).toBe(colorX.id);

      // Sin bobinas ni compras, la identidad se puede corregir.
      const recolored = await patchJson<FinishDto>(api, `/api/finishes/${unused.id}`, {
        colorId: colorY.id,
      });
      expect(recolored).toMatchObject({ kind: 'PREPINTADO', colorId: colorY.id });
      const galvanized = await patchJson<FinishDto>(api, `/api/finishes/${unused.id}`, {
        kind: 'GALVANIZADO',
      });
      expect(galvanized, 'pasar a un tipo sin color limpia el color').toMatchObject({
        kind: 'GALVANIZADO',
        colorId: null,
      });
      const moved = await patchJson<FinishDto>(api, `/api/finishes/${unused.id}`, {
        businessLine: 'drywall',
      });
      expect(moved.businessLine).toBe('drywall');
    } finally {
      await purgeRoofingTrail(api, {
        coilIds: coilId ? [coilId] : [],
        purchaseIds: purchaseId ? [purchaseId] : [],
        supplierId: supplier.id,
        finishId: used.id,
      });
      await deactivate(api, 'finishes', [unused.id]);
      await deactivate(api, 'colors', [colorX.id, colorY.id]);
    }
  });

  test('la bobina comprada con un acabado prepintado toma su color y cuenta en el agregado de ese color', async () => {
    const [supplier, color] = await Promise.all([
      createCuttingSupplier(api),
      createColor(api, '#7a3e9d'),
    ]);
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
    });
    let purchaseId = '';
    let coilId = '';
    try {
      // Compra a mano, sin el helper: lo que se mira es que el ítem **no** lleva color.
      const purchase = await postJson<PurchaseDto & { items: { colorId: string | null }[] }>(
        api,
        '/api/purchases',
        coilPurchaseBody({ supplierId: supplier.id, finishId: finish.id, item: { qty: '750' } }),
      );
      purchaseId = purchase.id;
      expect(purchase.items[0]!.colorId, 'el ítem de compra toma el color del acabado').toBe(
        color.id,
      );
      await postJson(api, `/api/purchases/${purchase.id}/receive`, {});
      const coils = await getItems<CoilDto & { purchaseId: string }>(
        api,
        `/api/coils?supplierId=${supplier.id}`,
      );
      const coil = coils.find((c) => c.purchaseId === purchase.id);
      expect(coil, 'la recepción dejó la bobina').toBeDefined();
      coilId = coil!.id;
      expect(coil).toMatchObject({ finishId: finish.id, colorId: color.id });

      // El agregado de materia prima del color (D-134) la cuenta: 750 kg, una bobina.
      const panel = await stockPanel(api, {
        businessLine: ROOFING_LINE,
        productIds: [product.id],
      });
      const group = panel.rawMaterial.find(
        (g) => g.colorId === color.id && g.thicknessMm === NOMINAL_THICKNESS,
      );
      expect(group, 'el agregado del color tiene que aparecer').toBeDefined();
      expect(group).toMatchObject({ coils: 1, availableKg: '750.000' });
      const row = panel.products.find((p) => p.productId === product.id);
      expect(row?.rawMaterialAvailableKg, 'el SKU de ese color ve el material').toBe('750.000');
    } finally {
      await purgeRoofingTrail(api, {
        coilIds: coilId ? [coilId] : [],
        purchaseIds: purchaseId ? [purchaseId] : [],
        productIds: [product.id],
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });

  test('la compra rechaza un color suelto en el ítem y un acabado de otra línea', async () => {
    const [supplier, color] = await Promise.all([
      createCuttingSupplier(api),
      createColor(api, '#d4a017'),
    ]);
    const roofingFinish = await createRoofingFinish(api, { colorId: color.id });
    const drywallFinish = await createFinish(api, { businessLine: 'drywall' });
    try {
      const withColor = await postExpectingError(
        api,
        '/api/purchases',
        coilPurchaseBody({
          supplierId: supplier.id,
          finishId: roofingFinish.id,
          item: { colorId: color.id },
        }),
      );
      expect(withColor.status).toBe(400);
      expect(withColor.message).toContain('El color de la bobina sale de su acabado');

      const otherLine = await postExpectingError(
        api,
        '/api/purchases',
        coilPurchaseBody({ supplierId: supplier.id, finishId: drywallFinish.id }),
      );
      expect(otherLine.status).toBe(400);
      expect(otherLine.message).toContain(`El acabado ${drywallFinish.code} es de otra línea`);
    } finally {
      await purgeRoofingTrail(api, { supplierId: supplier.id });
      await deactivate(api, 'finishes', [roofingFinish.id, drywallFinish.id]);
      await deactivate(api, 'colors', [color.id]);
    }
  });

  test('cambiar el acabado de una bobina le cambia el color; montada en una OP, se rechaza', async () => {
    const scenario = await setupRoofingScenario(api, { weightKg: '900' });
    const colorY = await createColor(api, '#00838f');
    const finishY = await createRoofingFinish(api, { colorId: colorY.id });
    const drywallFinish = await createFinish(api, { businessLine: 'drywall' });
    const customer = await createCustomer(api);
    const extra: { coilIds: string[]; purchaseIds: string[] } = { coilIds: [], purchaseIds: [] };
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // Una segunda bobina, suelta, para editar sin tocar la del escenario.
      const loose = await buyRoofingCoil(api, {
        supplierId: scenario.supplier.id,
        finishId: scenario.finish.id,
        colorId: scenario.color.id,
        weightKg: '400',
      });
      extra.coilIds.push(loose.coil.id);
      extra.purchaseIds.push(loose.purchaseId);
      expect(loose.coil.colorId).toBe(scenario.color.id);

      // `colorId` ya no es un campo editable de la bobina: se rechaza en vez de ignorarse.
      const byColor = await patchExpectingError(api, `/api/coils/${loose.coil.id}`, {
        colorId: colorY.id,
      });
      expect(byColor.status).toBe(400);
      expect((await getJson<CoilDto>(api, `/api/coils/${loose.coil.id}`)).colorId).toBe(
        scenario.color.id,
      );

      const otherLine = await patchExpectingError(api, `/api/coils/${loose.coil.id}`, {
        finishId: drywallFinish.id,
      });
      expect(otherLine.status).toBe(400);
      expect(otherLine.message).toContain('es de otra línea');

      const recolored = await patchJson<CoilDto>(api, `/api/coils/${loose.coil.id}`, {
        finishId: finishY.id,
      });
      expect(recolored).toMatchObject({ finishId: finishY.id, colorId: colorY.id });
      expect((await getJson<CoilDto>(api, `/api/coils/${loose.coil.id}`)).colorId).toBe(colorY.id);

      // Montada en una OP, el acabado (y con él el color) no se toca (D-060/D-086).
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: pieces([4, 2]),
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const reservation = (await reservationsOf(api, order.id))[0]!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      await mountCoil(api, op.id, { coilId: scenario.coil.id });

      const mounted = await patchExpectingError(api, `/api/coils/${scenario.coil.id}`, {
        finishId: finishY.id,
      });
      expect(mounted.status).toBe(400);
      // Dos guardrails la protegen y cualquiera puede cortar primero: la OP viva (D-060) o los
      // movimientos de kardex posteriores al ingreso.
      expect(mounted.message).toMatch(/orden de producción|movimiento\(s\) posterior\(es\)/i);
      const still = await getJson<CoilDto>(api, `/api/coils/${scenario.coil.id}`);
      expect(still).toMatchObject({ finishId: scenario.finish.id, colorId: scenario.color.id });
    } finally {
      await purgeRoofingTrail(api, trail);
      await purgeRoofingTrail(api, {
        coilIds: extra.coilIds,
        purchaseIds: extra.purchaseIds,
        finishId: finishY.id,
        colorId: colorY.id,
      });
      await deactivate(api, 'finishes', [drywallFinish.id]);
    }
  });

  test('el formulario de compra de bobinas no pide color: lo muestra desde el acabado elegido', async ({
    page,
    baseURL,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    const color = await createColor(api, '#b22222');
    const prepainted = await createFinish(api, {
      businessLine: 'drywall',
      kind: 'PREPINTADO',
      colorId: color.id,
    });
    const roofingOnly = await createRoofingFinish(api);
    try {
      await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
      await page.goto('/compras/nueva?tipo=COIL');
      await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible();

      const finishField = page.getByRole('combobox', { name: FINISH_FIELD_LABEL }).first();
      await expect(finishField).toBeVisible();
      // Ya no hay campo «Color» en la línea de la bobina.
      await expect(page.getByLabel('Color', { exact: true })).toHaveCount(0);

      // La compra nace en Drywall: el acabado de Coberturas no se ofrece.
      await finishField.click();
      await expect(page.getByRole('option', { name: finishOptionLabel(prepainted) })).toBeVisible();
      await expect(page.getByRole('option', { name: finishOptionLabel(roofingOnly) })).toHaveCount(
        0,
      );
      await page.keyboard.press('Escape');

      await selectOption(page, finishField, finishOptionLabel(prepainted));
      await expect(page.getByText('Color de la bobina:')).toBeVisible();
      await expect(page.getByText('Color de la bobina:')).toContainText(color.name);
    } finally {
      await deactivate(api, 'finishes', [prepainted.id, roofingOnly.id]);
      await deactivate(api, 'colors', [color.id]);
    }
  });

  test('en Acabados, el color aparece solo con «Prepintado» y guardarlo sin color muestra el error', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    const code = `EUI${uniqueDocumentNumber().slice(-8)}`;
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
    await page.getByRole('link', { name: 'Acabados' }).click();
    await expect(page.getByRole('heading', { name: 'Acabados' })).toBeVisible();

    await page.getByRole('button', { name: 'Nuevo acabado' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Código').fill(code);
    await dialog.getByLabel('Nombre').fill('Prepintado E2E sin color');
    await dialog.getByRole('combobox', { name: 'Línea' }).click();
    await page.getByRole('option', { name: 'Coberturas Aluzinc' }).click();
    await dialog.getByLabel('Factor de densidad').fill('7.85');

    await dialog.getByRole('combobox', { name: 'Tipo' }).click();
    await page.getByRole('option', { name: 'Natural' }).click();
    await expect(dialog.getByText('Color', { exact: true })).toBeHidden();

    await dialog.getByRole('combobox', { name: 'Tipo' }).click();
    await page.getByRole('option', { name: 'Prepintado' }).click();
    await expect(dialog.getByText('Color', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Crear acabado' }).click();
    await expect(
      dialog.getByText('Un acabado prepintado lleva color: elígelo del catálogo'),
    ).toBeVisible();
    await expect(dialog).toBeVisible();

    // No se creó nada.
    const finishes = await getJson<FinishDto[]>(api, '/api/finishes');
    expect(finishes.some((f) => f.code === code)).toBe(false);
  });
});
