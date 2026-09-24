import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, createUser, getJson, postJson } from '../helpers/api';
import { setQuotationSellerForTest } from '../helpers/db';
import { apiAs, today, uniqueDocumentNumber, type ProductDto } from '../helpers/production';
import {
  commitImport,
  customerCell,
  documentKey,
  previewImport,
  toInput,
  type SheetRow,
} from '../helpers/quotation-import';
import { buyRoofingCoil, createColor, createRoofingFinish } from '../helpers/roofing';
import {
  createCustomer,
  createSellableProduct,
  purgeSalesTrail,
  type CustomerDto,
  type QuotationDto,
} from '../helpers/sales';

/**
 * **D-256 (aclaración, revisión cruzada RF-S4b) — la exención del piso es del ADMINISTRADOR, y
 * solo la línea que sigue representando al comprobante conserva el papel.**
 *
 * Una cotización importada (D-152) se vendió a los precios a los que se vendió: una línea que
 * nadie tocó conserva sus importes y no pasa por el piso, la edite quien la edite. Pero la
 * línea que cambia de producto, cantidad o precio deja de ser el comprobante y se recalcula
 * (R2): con un **VENDEDOR**, pasa por el piso y por las reglas normales de bobina (sin venta
 * parcial); con un **ADMINISTRADOR**, sigue exenta. Y el texto de las observaciones nunca
 * otorga nada: tipear «Factura externa:» en una cotización nueva se rechaza.
 *
 * Con un usuario VENDEDOR real, que abre la cotización porque es su vendedor (D-238). El
 * importador la deja a nombre del ADMINISTRADOR que importó; reasignarla es cosa del test.
 *
 * Escribe cotizaciones: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Importa y edita cotizaciones: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

interface QuotationItemDto {
  productId: string;
  qty: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  reserveItemType: string;
  reserveItemId: string;
}
type Quotation = Omit<QuotationDto, 'items'> & { items: QuotationItemDto[] };

/** Un SKU por kilo comprado a S/ 1: 100 kg vendidos por S/ 50 quedan **debajo** del piso. */
async function belowFloorProduct(api: APIRequestContext): Promise<ProductDto> {
  const supplier = await createSupplier(api, { name: 'E2E Proveedor D-256' });
  const product = await createSellableProduct(api, {
    lineCode: 'roofing',
    unit: 'KGM',
    listPricePen: '2.0000',
  });
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: 'roofing',
    type: 'FINISHED_GOOD',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      { productId: product.id, description: 'D-256', qty: '5000', unit: 'KGM', unitPrice: '1' },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  return product;
}

async function importOne(api: APIRequestContext, row: SheetRow): Promise<Quotation> {
  const parsed = await previewImport(api, [row]);
  const previewRow = parsed.rows[0]!;
  expect(previewRow.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const result = await commitImport(api, [toInput(previewRow)]);
  const listed = await getJson<{ items: { id: string; code: string }[] }>(
    api,
    '/api/sales/quotations?pageSize=200',
  );
  const mine = listed.items.find((q) => q.code === result.codes[0]);
  expect(mine).toBeDefined();
  return getJson<Quotation>(api, `/api/sales/quotations/${mine!.id}`);
}

function body(customer: CustomerDto, items: Record<string, unknown>[]): Record<string, unknown> {
  return { customerId: customer.id, issueDate: today(), items };
}

async function put(
  api: APIRequestContext,
  id: string,
  data: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const res = await api.put(`/api/sales/quotations/${id}`, { data });
  return { status: res.status(), text: await res.text() };
}

/** La línea tal como está guardada: mismo producto, cantidad y los tres importes. */
function untouched(item: QuotationItemDto): Record<string, unknown> {
  return {
    ...(item.reserveItemType === 'COIL'
      ? { saleCoilId: item.reserveItemId }
      : { productId: item.productId }),
    qty: item.qty,
    netAmountPen: item.subtotalPen,
    igvAmountPen: item.igvPen,
    totalAmountPen: item.totalPen,
  };
}

test.describe('D-256 — exención del piso por rol en un documento importado', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('producto bajo el piso: la línea intacta pasa para los dos roles; la cambiada, solo con ADMINISTRADOR', async ({
    baseURL,
  }) => {
    const product = await belowFloorProduct(api);
    const customer = await createCustomer(api);
    const vendedor = await createUser(api, 'VENDEDOR');
    const seller = await apiAs(baseURL!, vendedor);
    const quotationIds: string[] = [];
    try {
      const quotation = await importOne(api, {
        issueDate: '05/08/2026',
        docType: 'Factura',
        documentKey: documentKey(),
        customer: customerCell(customer),
        sku: product.sku,
        productName: 'Material D-256',
        unit: 'KILOGRAMO',
        qty: '100.000',
        netAmount: '50.00',
      });
      quotationIds.push(quotation.id);
      await setQuotationSellerForTest(quotation.id, vendedor.id);
      const line = quotation.items[0]!;
      expect(line.subtotalPen).toBe('50.0000');

      // VENDEDOR, línea intacta: conserva el papel y no pasa por el piso.
      const same = await put(seller, quotation.id, body(customer, [untouched(line)]));
      expect(same.status, same.text).toBe(200);
      const kept = await getJson<Quotation>(api, `/api/sales/quotations/${quotation.id}`);
      expect(kept.items[0]!.subtotalPen).toBe('50.0000');

      // VENDEDOR, precio cambiado: la línea ya no es el comprobante y pasa por el piso.
      const repriced = await put(
        seller,
        quotation.id,
        body(customer, [{ productId: product.id, qty: '100.000', unitPricePen: '0.6000' }]),
      );
      expect(repriced.status).toBe(400);
      expect(repriced.text).toMatch(/precio mínimo/);

      // VENDEDOR, cantidad cambiada con el mismo importe: tampoco es el comprobante.
      const requantified = await put(
        seller,
        quotation.id,
        body(customer, [{ productId: product.id, qty: '90.000', netAmountPen: '50.0000' }]),
      );
      expect(requantified.status).toBe(400);
      expect(requantified.text).toMatch(/precio mínimo/);

      // ADMINISTRADOR, línea intacta y línea cambiada: exento en los dos casos.
      const adminSame = await put(api, quotation.id, body(customer, [untouched(line)]));
      expect(adminSame.status, adminSame.text).toBe(200);
      const adminRepriced = await put(
        api,
        quotation.id,
        body(customer, [{ productId: product.id, qty: '100.000', unitPricePen: '0.6000' }]),
      );
      expect(adminRepriced.status, adminRepriced.text).toBe(200);
      const after = await getJson<Quotation>(api, `/api/sales/quotations/${quotation.id}`);
      // Recalculado con R2: el importe sale del precio nuevo, no del papel.
      expect(after.items[0]!.subtotalPen).toBe('60.0000');
    } finally {
      await seller.dispose();
      await purgeSalesTrail(api, { orderIds: [], quotationIds });
    }
  });

  test('venta de bobina del papel: el VENDEDOR no vende una parte; el ADMINISTRADOR sí', async ({
    baseURL,
  }) => {
    const color = await createColor(api, '#7a1f1f');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor D-256 bobina' });
    const { coil } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '4194',
      thicknessMm: '0.38',
      widthMm: '1200',
    });
    const customer = await createCustomer(api);
    const vendedor = await createUser(api, 'VENDEDOR');
    const seller = await apiAs(baseURL!, vendedor);
    const quotationIds: string[] = [];
    try {
      // El papel vende 1000 kg de la bobina de 4194: una venta parcial, que solo vale del papel.
      const quotation = await importOne(api, {
        issueDate: '07/08/2026',
        docType: 'Factura',
        documentKey: documentKey(),
        customer: customerCell(customer),
        sku: `BOB38${color.code}`,
        productName: `BOBINA ALUZINC ${color.code} 0.38 X 1200`,
        unit: 'KILOGRAMO',
        qty: '1000.000',
        netAmount: '3000.00',
        igv: '540.00',
        totalAmount: '3540.00',
      });
      quotationIds.push(quotation.id);
      await setQuotationSellerForTest(quotation.id, vendedor.id);
      const line = quotation.items[0]!;
      expect(line.reserveItemId).toBe(coil.id);
      expect(line.qty).toBe('1000.000');

      // VENDEDOR, línea intacta: sigue vendiendo la cantidad del papel.
      const same = await put(seller, quotation.id, body(customer, [untouched(line)]));
      expect(same.status, same.text).toBe(200);

      // VENDEDOR, cantidad cambiada: ya no es el papel, y fuera del papel se vende el rollo entero.
      const partial = await put(
        seller,
        quotation.id,
        body(customer, [{ saleCoilId: coil.id, qty: '900.000', netAmountPen: '2700.0000' }]),
      );
      expect(partial.status).toBe(400);
      expect(partial.text).toMatch(/el saldo de .* cambió/);

      // ADMINISTRADOR, la misma edición: exento, sigue siendo una línea del papel.
      const adminPartial = await put(
        api,
        quotation.id,
        body(customer, [{ saleCoilId: coil.id, qty: '900.000', netAmountPen: '2700.0000' }]),
      );
      expect(adminPartial.status, adminPartial.text).toBe(200);
      const after = await getJson<Quotation>(api, `/api/sales/quotations/${quotation.id}`);
      expect(after.items[0]!.qty).toBe('900.000');
    } finally {
      await seller.dispose();
      await purgeSalesTrail(api, { orderIds: [], quotationIds });
    }
  });

  test('las observaciones no otorgan nada: «Factura externa:» tipeado se rechaza', async ({
    baseURL,
  }) => {
    const product = await belowFloorProduct(api);
    const customer = await createCustomer(api);
    const vendedor = await createUser(api, 'VENDEDOR');
    const seller = await apiAs(baseURL!, vendedor);
    try {
      const res = await seller.post('/api/sales/quotations', {
        data: {
          ...body(customer, [{ productId: product.id, qty: '1.000', unitPricePen: '5.0000' }]),
          notes: 'Factura externa: F001-99999',
        },
      });
      expect(res.status()).toBe(400);
      expect(await res.text()).toMatch(/esa marca la pone el importador/);
    } finally {
      await seller.dispose();
    }
  });
});
