import { expect, test, type APIRequestContext } from '@playwright/test';
import type { PurchaseDto } from '@ayr/shared';
import { adminApi, createSupplier, getItems, postJson } from '../helpers/api';
import { today } from '../helpers/production';

/**
 * cc33 — número y fechas de una compra, por API:
 * - B8: el número admite letras, dígitos, guion y barra, hasta 20.
 * - Ceros a la izquierda: se guarda sin ellos y el duplicado se rechaza comparando así.
 * - N5: una fecha con formato correcto que no existe (`2026-09-31`) se rechaza en vez de rodar al
 *   1 de octubre.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

test.describe('cc33 — número y fechas de una compra', () => {
  let api: APIRequestContext;
  const toCancel: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    for (const id of toCancel) {
      await api
        .post(`/api/purchases/${id}/cancel`, { data: { reason: 'Limpieza del E2E cc33' } })
        .catch(() => undefined);
    }
    await api.dispose();
  });

  function body(supplierId: string, over: Record<string, unknown>) {
    return {
      supplierId,
      businessLine: 'drywall',
      type: 'EXPENSE',
      docType: 'FACTURA',
      series: 'F033',
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [{ description: 'Gasto E2E cc33', qty: '1', unit: 'ZZ', unitPrice: '10' }],
      ...over,
    };
  }

  test('ceros a la izquierda: se guarda sin ellos y el duplicado se rechaza', async () => {
    const supplier = await createSupplier(api);
    // Empieza en 9: un sufijo del reloj puede empezar con ceros, y esos también se quitan.
    const seed = `9${String(Date.now()).slice(-5)}`;
    const first = await postJson<PurchaseDto>(
      api,
      '/api/purchases',
      body(supplier.id, { number: `000${seed}` }),
    );
    toCancel.push(first.id);
    expect(first.number).toBe(seed);
    // Quien busca con el número del papel, ceros incluidos, la encuentra igual.
    const found = await getItems<{ id: string }>(api, `/api/purchases?search=000${seed}`);
    expect(found.map((p) => p.id)).toContain(first.id);

    const duplicate = await api.post('/api/purchases', {
      data: body(supplier.id, { number: seed }),
    });
    expect(duplicate.status()).toBe(409);
    expect(await duplicate.text()).toContain('ya está registrado');
  });

  test('B8: alfanumérico aceptado; vacío y más de 20 rechazados', async () => {
    const supplier = await createSupplier(api);
    const alnum = await postJson<PurchaseDto>(
      api,
      '/api/purchases',
      body(supplier.id, { number: `a-${String(Date.now()).slice(-5)}/7` }),
    );
    toCancel.push(alnum.id);
    expect(alnum.number).toMatch(/^A-\d{5}\/7$/);

    for (const number of ['', '123456789012345678901']) {
      const rejected = await api.post('/api/purchases', { data: body(supplier.id, { number }) });
      expect(rejected.status(), `número «${number}»`).toBe(400);
    }
  });

  test('N5: una fecha que no existe se rechaza al crear y al pagar', async () => {
    const supplier = await createSupplier(api);
    for (const issueDate of ['2026-02-31', '2026-09-31', '2026-08-32']) {
      const rejected = await api.post('/api/purchases', {
        data: body(supplier.id, { number: String(Date.now()).slice(-7), issueDate }),
      });
      expect(rejected.status(), issueDate).toBe(400);
      expect(await rejected.text()).toContain('no existe en el calendario');
    }

    const purchase = await postJson<PurchaseDto>(
      api,
      '/api/purchases',
      body(supplier.id, { number: String(Date.now()).slice(-7) }),
    );
    toCancel.push(purchase.id);
    const payment = await api.post(`/api/purchases/${purchase.id}/payments`, {
      data: { date: '2026-09-31', amount: '1', currency: 'PEN', method: 'CASH' },
    });
    expect(payment.status()).toBe(400);
    expect(await payment.text()).toContain('no existe en el calendario');
  });
});
