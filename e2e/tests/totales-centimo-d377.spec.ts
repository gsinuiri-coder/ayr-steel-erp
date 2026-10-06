import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { deactivateTrail } from '../helpers/production';
import {
  createInvoice,
  getDocument,
  purgeInvoicingTrail,
  type FiscalDocumentDto,
} from '../helpers/invoicing';
import {
  createCustomer,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-377 (R2) — el documento se redondea al céntimo una sola vez, al final.**
 *
 * La línea sigue a cuatro decimales; la cabecera es gravada = céntimo(Σ valor), IGV =
 * céntimo(Σ valor × 18 %), total = gravada + IGV. Es la convención del papel de Nubefact (medida
 * sobre 141 comprobantes) y el caso que la separa de redondear por línea son **tres líneas de
 * valor 10.01**: 35.44 al final, 35.43 por línea, 35.4354 sin redondear.
 *
 * El recorrido completo, cotización → pedido → comprobante → cobro, con el total fijo en cada
 * paso. Además:
 *
 * - **B3:** las líneas viajan sin precio y valen la lista exacta (10.01), no el precio con IGV
 *   que vio el vendedor (11.8118 ÷ 1.18).
 * - **Cobro:** el diálogo se precarga con el saldo al céntimo (35.44, no 35.4400 de un saldo de
 *   cuatro decimales), y el API rechaza un monto con fracciones de céntimo.
 *
 * Usa la línea de servicios (sin inventario, D-167) para no depender de stock. Escribe
 * cotizaciones, pedidos y comprobantes: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea cotizaciones, pedidos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

const SERVICES_LINE = 'services';

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

test.describe('D-377 — totales al céntimo de la cotización al cobro', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('tres líneas de 10.01: 35.44 en la cotización, el pedido, el comprobante y el cobro', async ({
    page,
  }) => {
    const products = [
      await createSellableProduct(api, { lineCode: SERVICES_LINE, listPricePen: '10.0100' }),
      await createSellableProduct(api, { lineCode: SERVICES_LINE, listPricePen: '10.0100' }),
      await createSellableProduct(api, { lineCode: SERVICES_LINE, listPricePen: '10.0100' }),
    ];
    const customer = await createCustomer(api);
    const sales: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };
    const documentIds: string[] = [];

    try {
      // 1) Cotización: las líneas sin precio toman la lista (B3) y quedan a cuatro decimales.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: SERVICES_LINE,
        items: products.map((p) => ({ productId: p.id, qty: '1' })),
      });
      sales.quotationIds.push(quotation.id);
      for (const item of quotation.items) {
        expect(item).toMatchObject({
          unitPricePen: '10.0100',
          subtotalPen: '10.0100',
          igvPen: '1.8018',
          totalPen: '11.8118',
        });
      }
      // La cabecera, al céntimo: IGV céntimo(30.03 × 18 %) = 5.41. Antes, 35.4354.
      expect(quotation).toMatchObject({
        subtotalPen: '30.0300',
        igvPen: '5.4100',
        totalPen: '35.4400',
      });

      // 2) Pedido: copia la cotización y vuelve a sumar con la misma regla.
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      sales.orderIds.push(order.id);
      expect(order).toMatchObject({
        subtotalPen: '30.0300',
        igvPen: '5.4100',
        totalPen: '35.4400',
      });

      // 3) Comprobante desde el pedido, registrado con el número del papel (D-153).
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: order.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
      });
      documentIds.push(draft.id);
      expect(draft).toMatchObject({
        subtotalPen: '30.0300',
        igvPen: '5.4100',
        totalPen: '35.4400',
      });
      const invoice = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: 'F904', correlative: uniqueCorrelative() },
      );
      expect(invoice).toMatchObject({ totalPen: '35.4400', balancePen: '35.4400' });

      // 4) Cobro: un monto con fracciones de céntimo no entra; el precargado del diálogo sí.
      const tooFine = await api.post(`/api/invoicing/documents/${invoice.id}/payments`, {
        data: { date: invoice.issueDate, amountPen: '35.4399', method: 'CASH' },
      });
      expect(tooFine.status()).toBe(400);
      expect(await tooFine.text()).toContain('dos decimales');

      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${invoice.id}`);
      await page.getByRole('button', { name: 'Registrar cobro', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Monto', { exact: true })).toHaveValue('35.44');
      await dialog.getByRole('button', { name: 'Registrar cobro', exact: true }).click();
      await expect(page.getByText('Cobro registrado')).toBeVisible();

      const paid = await getDocument(api, invoice.id);
      expect(paid.paidPen).toBe('35.4400');
      expect(paid.balancePen).toBe('0.0000');
    } finally {
      await purgeInvoicingTrail(api, { documentIds });
      await purgeSalesTrail(api, sales);
      await deactivateTrail(api, { productIds: products.map((p) => p.id) });
    }
  });

  // El arreglo A (un saldo de fracciones de céntimo no es pendiente) no tiene caso acá: con R2 el
  // total nace al céntimo y un cobro va en céntimos, así que por la API ya no se puede fabricar
  // la cola de 0.0001 que lo dispara. Lo cubren los unitarios de `hasCollectibleBalance`
  // (`invoicing-math.spec.ts`); en producción lo ejercen los comprobantes grabados antes de R2.
});
