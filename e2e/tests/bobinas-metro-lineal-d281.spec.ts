import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  adminApi,
  adminCredentials,
  createFinish,
  createSupplier,
  getItems,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from '../helpers/api';
import { today, uniqueDocumentNumber } from '../helpers/production';

/**
 * Correcciones 02 / M5 (D-281): la tabla de `/bobinas` deja la columna «Ancho» y suma
 * «Metro lineal teórico» justo después de «Disponible».
 *
 * El número es el `equivalentMeters` que el API ya calcula por bobina con la fórmula del
 * dominio (`equivalentMeters` de `@ayr/shared`: kg disponibles ÷ (ancho × espesor × densidad
 * estándar), D-116/D-165). Con un acabado de densidad 1 la cuenta se hace a mano:
 * 1 000 kg ÷ (1.220 m × 0.50 mm × 1 × 1.01) = 1 623.113 m.
 *
 * Escribe kardex (una compra recibida): contra producción solo con `E2E_ALLOW_WRITES=1`.
 */
const isProduction = !!process.env.E2E_BASE_URL;
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

test.describe.configure({ timeout: 240_000 });

interface CoilRow {
  id: string;
  code: string;
  purchaseId: string | null;
  availableKg: string;
  equivalentMeters: string | null;
}

const purchaseIds: string[] = [];

async function buyCoil(
  api: APIRequestContext,
  supplier: CreatedSupplier,
  finish: CreatedFinish,
): Promise<CoilRow> {
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: 'drywall',
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
        description: 'Bobina E2E para el metro lineal teórico (D-281)',
        qty: '1000',
        unit: 'KGM',
        unitPrice: '4',
        finishId: finish.id,
        widthMm: '1220',
        thicknessMm: '0.50',
        coilStatus: 'OPEN',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  purchaseIds.push(purchase.id);
  const coils = await getItems<CoilRow>(api, `/api/coils?supplierId=${supplier.id}`);
  const coil = coils.find((c) => c.purchaseId === purchase.id);
  expect(coil, 'La compra no dejó ninguna bobina').toBeDefined();
  return coil!;
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-281 — metro lineal teórico en la tabla de bobinas', () => {
  test.skip(skipWrites, 'Escribe kardex: contra producción solo con E2E_ALLOW_WRITES=1 (D-024)');

  let api: APIRequestContext;
  let supplier: CreatedSupplier;
  let finish: CreatedFinish;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    supplier = await createSupplier(api);
    finish = await createFinish(api, { densityFactor: '1' });
  });

  test.afterAll(async () => {
    if (isProduction) {
      for (const purchaseId of purchaseIds) {
        await api
          .post(`/api/purchases/${purchaseId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
    }
    await api.dispose();
  });

  test('sin «Ancho», y «Metro lineal teórico» después de «Disponible» con la cuenta del dominio', async ({
    page,
  }) => {
    const coil = await buyCoil(api, supplier, finish);
    expect(coil.availableKg).toBe('1000.000');
    expect(coil.equivalentMeters).toBe('1623.113');

    await loginAsAdmin(page);
    await page.goto('/bobinas');
    await page.getByLabel('Buscar bobinas por código').fill(coil.code);
    const table = page.getByRole('table');
    await expect(table.getByRole('row').filter({ hasText: coil.code })).toBeVisible({
      timeout: 60_000,
    });
    const headers = table.getByRole('columnheader');
    await expect(headers.filter({ hasText: 'Metro lineal teórico' })).toBeVisible({
      timeout: 60_000,
    });
    const labels = (await headers.allInnerTexts()).map((t) => t.trim());
    expect(labels).not.toContain('Ancho');
    const disponible = labels.findIndex((t) => t.startsWith('Disponible'));
    expect(disponible).toBeGreaterThanOrEqual(0);
    expect(labels[disponible + 1]).toBe('Metro lineal teórico');

    // La fila de la bobina: la celda que sigue al disponible.
    const row = table.getByRole('row').filter({ hasText: coil.code });
    const cells = (await row.getByRole('cell').allInnerTexts()).map((t) => t.trim());
    const kgAt = cells.indexOf('1,000.000 kg');
    expect(kgAt, `Fila: ${cells.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(cells[kgAt + 1]).toBe('1,623.113 m');
  });
});
