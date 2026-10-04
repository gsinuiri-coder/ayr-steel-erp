import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createSupplier, getJson } from '../helpers/api';
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
  purgeSalesTrail,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-385 — el importador de ventas con una bobina vendida en TONELADA y sin stock.**
 *
 * El caso real (FFA1-1419 de setiembre, con números iguales y el resto inventado): `BOB…AZUL`,
 * 4.192 TONELADA, valor de venta 12789.153. Antes el importador lo leía como 4.192 kg y además
 * dejaba la fila sin resolver porque no había bobina libre.
 *
 * Lo que tiene que pasar: la cantidad se lee en kilos (4192) con el importe del papel intacto; sin
 * bobina que corresponda la cotización entra igual, emitida y marcada «sin bobina asignada», y
 * cuenta como sin stock; al confirmar se elige la bobina entre las libres del SKU —recién ahí se
 * reserva, su saldo entero— y una bobina fuera del ±1 % de los kilos del papel se bloquea con los
 * dos pesos. Sin bobina elegida, confirmar se bloquea (D-054).
 */

test.describe.configure({ timeout: 600_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

interface ConfirmPreviewDto {
  blockers: string[];
  lines: {
    lineNumber: number;
    action: string;
    coilChoices: { coilId: string; code: string; balanceKg: string; withinTolerance: boolean }[];
  }[];
}

test.describe('D-385 — importar una bobina en TONELADA sin stock y elegir la bobina al confirmar', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('TONELADA → kg, cotización emitida sin bobina, bloqueos y reserva al elegir la bobina', async ({
    page,
  }) => {
    const color = await createColor(api, '#0e4c96');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor D-385' });
    // Una bobina del pool que no alcanza para el papel (−2.2 %): crea el producto de venta del SKU
    // y es la que después queda fuera de la tolerancia.
    const { coil: light } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '4100',
      thicknessMm: '0.38',
      widthMm: '1200',
    });
    const customer = await createCustomer(api);
    const sku = `BOB038${color.code}`;

    const quotationIds: string[] = [];
    const orderIds: string[] = [];
    try {
      // --- Importar ---
      const row: SheetRow = {
        issueDate: '08/09/2026',
        docType: 'Factura',
        documentKey: documentKey(),
        customer: customerCell(customer),
        sku,
        productName: `BOBINA ALUZINC ${color.code} 0.38 X 1200 RAL 5002`,
        unit: 'TONELADA',
        qty: '4.1920000000',
        netAmount: '12789.153',
        igv: '2302.04754',
        totalAmount: '15091.200',
      };
      const parsed = await previewImport(api, [row]);
      const previewRow = parsed.rows[0]! as (typeof parsed.rows)[number] & {
        unitConversion: { paperQty: string; paperUnit: string } | null;
      };
      expect(previewRow.qty).toBe('4192.000');
      expect(previewRow.unitConversion).toEqual({ paperQty: '4.192', paperUnit: 'TONELADA' });
      expect(previewRow.productSku).toBe(sku);
      expect(previewRow.saleCoilId).toBeNull();
      expect(previewRow.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(previewRow.issues.map((i) => i.message).join(' ')).toMatch(/sin bobina asignada/);

      const result = await commitImport(api, [toInput(previewRow)]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const listedQuotation = listed.items.find((q) => q.code === result.codes[0]);
      expect(listedQuotation).toBeDefined();
      const quotationId = listedQuotation!.id;
      quotationIds.push(quotationId);

      // Emitida, con los kilos y el importe del papel, y sin bobina.
      const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotationId}`);
      expect(quotation.status).toBe('EMITTED');
      expect(quotation.items[0]!.qty).toBe('4192.000');
      expect(quotation.items[0]!.subtotalPen).toBe('12789.1500');
      expect(quotation.totalPen).toBe('15091.2000');
      expect(quotation.items[0]!.reserveItemType).not.toBe('COIL');

      // Cuenta para el aviso de cotizaciones sin stock.
      const shortages = await getJson<
        { quotationId: string; lines: { label: string; missingQty: string }[] }[]
      >(api, '/api/sales/quotations/stock-shortages');
      const mine = shortages.find((s) => s.quotationId === quotationId);
      expect(mine?.lines[0]?.label).toBe(`${sku} — sin bobina asignada`);
      expect(mine?.lines[0]?.missingQty).toBe('4192.000');

      // --- Confirmar sin bobina que corresponda: bloquea ---
      const before = await getJson<ConfirmPreviewDto>(
        api,
        `/api/sales/quotations/${quotationId}/confirm-preview`,
      );
      expect(before.lines[0]).toMatchObject({ action: 'CHOOSE_COIL' });
      expect(before.lines[0]!.coilChoices).toEqual([
        expect.objectContaining({
          coilId: light.id,
          balanceKg: '4100.000',
          withinTolerance: false,
        }),
      ]);
      expect(before.blockers.join(' ')).toMatch(/ninguna bobina libre de .* pesa lo del papel/);

      const noCoil = await api.post(`/api/sales/quotations/${quotationId}/confirm`, { data: {} });
      expect(noCoil.status()).toBe(400);
      expect(await noCoil.text()).toMatch(/sin bobina asignada|Elige la bobina/);

      // --- Bobina fuera de la tolerancia: bloquea mostrando los dos pesos ---
      const outOfRange = await api.post(`/api/sales/quotations/${quotationId}/confirm`, {
        data: { coilAssignments: [{ lineNumber: 1, saleCoilId: light.id }] },
      });
      expect(outOfRange.status()).toBe(400);
      expect(await outOfRange.text()).toMatch(
        /tiene 4100\.000 kg y el papel dice 4192\.000 kg.*entre 4150\.080 y 4233\.920 kg/,
      );

      // --- Llega la compra de la bobina (−0.29 %, dentro del ±1 %) ---
      const { coil: good } = await buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        weightKg: '4180',
        thicknessMm: '0.38',
        widthMm: '1200',
      });
      const after = await getJson<ConfirmPreviewDto>(
        api,
        `/api/sales/quotations/${quotationId}/confirm-preview`,
      );
      expect(after.blockers).toEqual([]);
      expect(after.lines[0]!.coilChoices.find((c) => c.coilId === good.id)?.withinTolerance).toBe(
        true,
      );

      // --- Confirmar eligiendo la bobina, por pantalla ---
      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotationId}`);
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByText(/sin bobina asignada\. Al confirmar se elige la bobina/),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const picker = dialog.getByRole('combobox', { name: 'Bobina de la línea 1' });
      await expect(picker).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText('Sin bobina asignada: se reserva al confirmar.')).toBeVisible();
      const confirmButton = dialog.getByRole('button', { name: 'Confirmar', exact: true });
      await expect(confirmButton).toBeDisabled();

      await picker.click();
      await page.getByRole('option', { name: new RegExp(`^${light.code} `) }).click();
      await expect(
        dialog.getByText(
          new RegExp(`${light.code} tiene 4,100\\.000 kg y el papel dice 4,192\\.000 kg`),
        ),
      ).toBeVisible();
      await expect(confirmButton).toBeDisabled();

      await picker.click();
      await page.getByRole('option', { name: new RegExp(`^${good.code} `) }).click();
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();
      await expect(page).toHaveURL(/\/pedidos\/[0-9a-f-]{36}$/, { timeout: 60_000 });
      const orderId = page.url().split('/').pop()!;
      orderIds.push(orderId);

      // La reserva recién se hace al elegir: la bobina entera, y la línea factura el papel.
      const order = await getJson<SalesOrderDto>(api, `/api/sales/orders/${orderId}`);
      expect(order.items[0]).toMatchObject({
        reserveItemType: 'COIL',
        reserveItemId: good.id,
        reserveQty: '4180.000',
        qty: '4192.000',
        subtotalPen: '12789.1500',
      });
      expect(order.totalPen).toBe('15091.2000');
      const reservations = order.reservations.filter((r) => r.status === 'ACTIVE');
      expect(reservations).toEqual([
        expect.objectContaining({ itemType: 'COIL', itemId: good.id, qty: '4180.000' }),
      ]);
      // La cotización confirmada dice qué bobina vendió.
      const confirmed = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotationId}`);
      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.items[0]!.reserveItemId).toBe(good.id);
    } finally {
      await purgeSalesTrail(api, { orderIds, quotationIds });
    }
  });
});
