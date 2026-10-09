import { expect, test } from '@playwright/test';
import type { PurchaseDto, SupplierStatementDto } from '@ayr/shared';
import { adminApi, createSupplier, postJson } from '../helpers/api';
import { today } from '../helpers/production';
import { loginAsAdmin } from '../helpers/report-fixtures';

/**
 * cc34 (pendiente de cc33, D-537): en el estado de cuenta del proveedor, una compra a crédito sin
 * fecha de vencimiento se rotula «Crédito sin vencimiento», no «Contado». Esa compra solo existe en
 * datos viejos (hoy el alta exige días de crédito), así que la fila al crédito se arma desde la
 * respuesta real: se copia la compra al contado y se le cambia la condición.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 120_000 });

test('estado de cuenta: «Crédito sin vencimiento» y «Contado» donde corresponde', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const supplier = await createSupplier(api);
  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: 'drywall',
    type: 'EXPENSE',
    docType: 'FACTURA',
    series: 'F034',
    number: `9${String(Date.now()).slice(-6)}`,
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [{ description: 'Gasto E2E cc34', qty: '1', unit: 'ZZ', unitPrice: '10' }],
  });

  try {
    await page.route(`**/api/purchases/suppliers/${supplier.id}/statement`, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as SupplierStatementDto;
      const cash = body.purchases[0]!;
      body.purchases = [
        cash,
        {
          ...cash,
          id: `${cash.id.slice(0, -1)}${cash.id.endsWith('0') ? '1' : '0'}`,
          documentLabel: `${cash.documentLabel}-CR`,
          paymentTerms: 'CREDITO',
          creditDays: null,
          dueDate: null,
          overdueDays: null,
        },
      ];
      await route.fulfill({ response: res, json: body });
    });

    await loginAsAdmin(page);
    await page.goto(`/proveedores/${supplier.id}/estado-cuenta`);
    const cashRow = page.getByRole('row', {
      name: new RegExp(`${purchase.series}-${purchase.number}(?!-CR)`),
    });
    const creditRow = page.getByRole('row', { name: /-CR/ });
    await expect(creditRow).toContainText('Crédito sin vencimiento');
    await expect(creditRow).not.toContainText('Contado');
    await expect(cashRow.first()).toContainText('Contado');
  } finally {
    await api.post(`/api/purchases/${purchase.id}/cancel`, {
      data: { reason: 'Limpieza E2E cc34' },
    });
    await api.dispose();
  }
});
