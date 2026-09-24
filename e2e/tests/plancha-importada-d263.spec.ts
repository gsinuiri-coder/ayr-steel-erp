import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createFinish, createSupplier, getJson } from '../helpers/api';
import { createCatalogProduct, deactivateTrail, type ProductDto } from '../helpers/production';
import {
  commitImport,
  customerCell,
  documentKey,
  previewImport,
  toInput,
} from '../helpers/quotation-import';
import {
  createCustomer,
  purgeSalesTrail,
  type CustomerDto,
  type QuotationDto,
} from '../helpers/sales';

/**
 * **D-263 — la plancha importada por plancha no se reinterpreta como precio por metro.**
 *
 * El defecto (P1-1 de la revisión del delta RF-S4b): el importador guarda una plancha de
 * catálogo con su unitario **por plancha** y sin valor por metro (D-152). El formulario de
 * edición sembraba ese número en el campo de precio, que en una plancha es por metro (D-161),
 * y como la línea de plancha nunca contaba como intacta (D-255) lo mandaba como
 * `valuePerMeterPen`. El API multiplicaba por el largo: guardar la cotización —aunque solo se
 * hubieran tocado las observaciones— dejaba la línea ×6 en una plancha de 6 m y ×3.6 en una de
 * 3.60 m. Es la huella de COT-000053/054 del 22/09.
 *
 * Por la UI a propósito: el defecto vive entero en el formulario, y un caso por API mandaría el
 * cuerpo correcto y pasaría con el defecto puesto.
 *
 * Escribe cotizaciones: nunca contra producción (D-126, regla dura 12).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Importa cotizaciones: nunca contra producción (D-126, regla dura 12).');
test.describe.configure({ timeout: 120_000 });

/** Coberturas metálicas: la única línea con subtipo `PLANCHA` (D-127). */
const ROOFING_LINE = 'metallic-roofing';

interface Scenario {
  customer: CustomerDto;
  supplierId: string;
  six: ProductDto;
  threeSixty: ProductDto;
}

/**
 * Lo que el caso fue creando, para limpiarlo aunque falle a mitad: cada id entra apenas existe
 * (autorrevisión de D-263: con el armado fuera del `try`, un fallo intermedio dejaba vivo lo
 * creado hasta ahí).
 */
interface Trail {
  supplierId?: string;
  productIds: string[];
  quotationIds: string[];
}

async function setup(api: APIRequestContext, trail: Trail): Promise<Scenario> {
  const supplier = await createSupplier(api, { name: 'E2E Proveedor planchas D-263' });
  trail.supplierId = supplier.id;
  const finish = await createFinish(api, { businessLine: ROOFING_LINE });
  const plancha = async (lengthMm: string, name: string): Promise<ProductDto> => {
    const product = await createCatalogProduct(api, {
      lineCode: ROOFING_LINE,
      unit: 'NIU',
      source: 'PURCHASED',
      roofingKind: 'PLANCHA',
      lengthMm,
      finishId: finish.id,
      name,
    });
    trail.productIds.push(product.id);
    return product;
  };
  return {
    customer: await createCustomer(api),
    supplierId: supplier.id,
    six: await plancha('6000.00', 'Plancha E2E importada 6 m'),
    threeSixty: await plancha('3600.00', 'Plancha E2E importada 3.60 m'),
  };
}

/**
 * Una factura de dos líneas, las dos a S/ 50.00 la plancha sin IGV (59.00 con IGV): 10 de 6 m
 * y 5 de 3.60 m. Con el defecto, la primera salía S/ 3 000 y la segunda S/ 900.
 */
async function importInvoice(
  api: APIRequestContext,
  s: Scenario,
  trail: Trail,
): Promise<QuotationDto> {
  const key = documentKey();
  const row = (product: ProductDto, qty: string, netAmount: string) => ({
    issueDate: '03/08/2026',
    docType: 'Factura',
    documentKey: key,
    customer: customerCell(s.customer),
    sku: product.sku,
    productName: product.name,
    unit: 'UNIDAD',
    qty,
    netAmount,
  });
  const parsed = await previewImport(api, [
    row(s.six, '10.000', '500.00'),
    row(s.threeSixty, '5.000', '250.00'),
  ]);
  for (const r of parsed.rows) {
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  }
  const result = await commitImport(api, parsed.rows.map(toInput));
  // Por su código, no en la primera página del listado: en una base de E2E acumulada la
  // cotización nueva puede no estar entre las 200 primeras.
  const code = result.codes[0]!;
  const listed = await getJson<{ items: { id: string; code: string }[] }>(
    api,
    `/api/sales/quotations?pageSize=50&search=${encodeURIComponent(code)}`,
  );
  const mine = listed.items.find((q) => q.code === code);
  expect(mine, `${code} no aparece al buscarla`).toBeDefined();
  trail.quotationIds.push(mine!.id);
  const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine!.id}`);
  // El punto de partida: por plancha, sin valor por metro (D-152).
  expect(quotation.items.map((i) => [i.unitPricePen, i.valuePerMeterPen])).toEqual([
    ['50.0000', null],
    ['50.0000', null],
  ]);
  return quotation;
}

async function cleanup(api: APIRequestContext, trail: Trail): Promise<void> {
  await purgeSalesTrail(api, { quotationIds: trail.quotationIds });
  await deactivateTrail(api, {
    ...(trail.supplierId ? { supplierId: trail.supplierId } : {}),
    productIds: trail.productIds,
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/**
 * El formulario pinta las líneas antes de tener el catálogo: hasta entonces no sabe que son
 * planchas. El editor de largo fijo aparece recién con el producto cargado.
 */
async function waitForPlanchas(page: Page): Promise<void> {
  await expect(page.getByLabel('Planchas de la línea 1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Planchas de la línea 2')).toBeVisible();
}

async function saveForm(page: Page, quotationId: string): Promise<QuotationDto> {
  const put = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' && r.url().includes(`/api/sales/quotations/${quotationId}`),
  );
  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  const response = await put;
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as QuotationDto;
}

test.describe('D-263 — la plancha importada por plancha', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('cambiar solo las observaciones no mueve el importe de las planchas de 6 m ni de 3.60 m', async ({
    page,
  }) => {
    const trail: Trail = { productIds: [], quotationIds: [] };
    try {
      const s = await setup(api, trail);
      const before = await importInvoice(api, s, trail);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${before.id}/editar`);
      await waitForPlanchas(page);

      // La marca del importador se conserva: solo se agrega una línea al final.
      const notes = page.getByLabel('Observaciones');
      await notes.fill(`${before.notes ?? ''}\nLlamar antes de despachar`);
      const after = await saveForm(page, before.id);

      for (const [i, line] of after.items.entries()) {
        const was = before.items[i]!;
        expect(line.subtotalPen, `línea ${i + 1}`).toBe(was.subtotalPen);
        expect(line.totalPen, `línea ${i + 1}`).toBe(was.totalPen);
        expect(line.unitPricePen, `línea ${i + 1}`).toBe('50.0000');
        expect(line.valuePerMeterPen, `línea ${i + 1}`).toBeNull();
      }
      expect(after.subtotalPen).toBe('750.0000');
      expect(after.totalPen).toBe(before.totalPen);
      expect(after.notes).toContain('Llamar antes de despachar');
    } finally {
      await cleanup(api, trail);
    }
  });

  test('tocar la cantidad de la plancha de 3.60 m la recalcula por plancha, nunca por metro', async ({
    page,
  }) => {
    const trail: Trail = { productIds: [], quotationIds: [] };
    try {
      const s = await setup(api, trail);
      const before = await importInvoice(api, s, trail);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${before.id}/editar`);
      await waitForPlanchas(page);
      // El campo dice lo que es: el precio por plancha con IGV, no «por metro».
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('59.0000');
      await expect(page.getByLabel('Precio unitario de la línea 2')).toHaveValue('59.0000');
      await expect(page.getByLabel(/Precio por metro de la línea/)).toHaveCount(0);
      await expect(page.getByText('por plancha, como se cotizó')).toHaveCount(2);

      await page.getByLabel('Planchas de la línea 2').fill('6');
      const after = await saveForm(page, before.id);

      // La de 6 m no se tocó: su importe guardado.
      expect(after.items[0]!.subtotalPen).toBe(before.items[0]!.subtotalPen);
      // La de 3.60 m: 6 planchas × S/ 59.00 con IGV = S/ 354.00, S/ 300.00 sin IGV. Leída por
      // metro habría sido 6 × 3.6 × 50 = S/ 1 080.
      expect(after.items[1]!.qty).toBe('6.000');
      expect(after.items[1]!.subtotalPen).toBe('300.0000');
      expect(after.items[1]!.totalPen).toBe('354.0000');
      expect(after.items[1]!.valuePerMeterPen).toBeNull();
    } finally {
      await cleanup(api, trail);
    }
  });
});
