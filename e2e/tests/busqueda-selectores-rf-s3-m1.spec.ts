import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { chooseOption, chooseProductWithStock, headerAction } from '../helpers/ui';
import { deactivateTrail } from '../helpers/production';
import { POS_LINE, setupPosStock } from '../helpers/pos';
import {
  createCustomer,
  createQuotation,
  createSellableProduct,
  purgeSalesTrail,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * RF-S3/M1 — búsqueda server-side en los selectores de cliente y producto.
 *
 * Reemplaza el patrón de traer el maestro entero y filtrar en el navegador: el selector
 * llama a `GET /customers/search`/`GET /catalog/search` mientras el usuario escribe, con un
 * mínimo de 2 caracteres. Cubre lo que solo se ve manejando la app: el umbral, que elegir
 * sigue funcionando igual que antes (vía `chooseOption`/`chooseProductWithStock`, las dos ya
 * resistentes a que `next dev` recompile a mitad de camino, D-201), y que un valor ya elegido
 * (al editar) se ve sin buscar nada (hidratación por id).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

function customerLabel(c: { name: string; docNumber: string }): string {
  return `${c.name} — ${c.docNumber}`;
}

/** El sufijo aleatorio de `createCustomer`/`createSellableProduct` (E2E Cliente/E2E-VTA + 5
 * letras): buscar por él, y no por el nombre entero, es lo que garantiza una sola coincidencia
 * aunque la base tenga otros clientes o productos E2E de la misma corrida. */
function needleOf(label: string): string {
  return label.slice(-5);
}

test.describe('RF-S3/M1 — búsqueda server-side en selectores', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('cotización nueva: cliente y producto se eligen buscando (con umbral de 2 caracteres), y editarla después hidrata el cliente sin buscar', async ({
    page,
  }) => {
    const customer = await createCustomer(api);
    const product = await createSellableProduct(api, {
      lineCode: POS_LINE,
      listPricePen: '10.0000',
    });
    const customerNeedle = needleOf(customer.name);
    const skuNeedle = needleOf(product.sku);
    let quotationId: string | null = null;

    try {
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');

      // --- Cliente: el umbral se ve antes de comprometerse a elegir ---
      await page.getByLabel('Cliente', { exact: true }).click();
      const customerDialog = page.getByRole('dialog');
      await customerDialog.getByLabel('Filtrar opciones').fill(customerNeedle.slice(0, 1));
      await expect(
        customerDialog.getByText('Escribe al menos 2 caracteres para buscar.'),
      ).toBeVisible();
      await page.keyboard.press('Escape');

      await chooseOption(
        page,
        page.getByLabel('Cliente', { exact: true }),
        customerLabel(customer),
        customerNeedle,
      );

      // --- Línea de negocio y producto: mismo umbral en el picker con stock (D-188) ---
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Coberturas (UPVC)', exact: true }).click();

      await page.getByLabel('Producto de la línea 1').click();
      const productDialog = page.getByRole('dialog');
      await productDialog.getByLabel('Filtrar productos').fill(skuNeedle.slice(0, 1));
      await expect(
        productDialog.getByText('Escribe al menos 2 caracteres para buscar.'),
      ).toBeVisible();
      await page.keyboard.press('Escape');

      await chooseProductWithStock(page, page.getByLabel('Producto de la línea 1'), product.sku);

      await page.getByLabel('Cantidad de la línea 1').fill('2');
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('11.8000');

      const created = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('/api/sales/quotations'),
      );
      await page.getByRole('button', { name: 'Crear cotización' }).click();
      const response = await created;
      expect(response.status(), await response.text()).toBe(201);
      const body = (await response.json()) as { id: string };
      quotationId = body.id;
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${body.id}$`));

      // --- Hidratación por id: reabrir para editar muestra el cliente sin buscar nada ---
      await page.goto(`/cotizaciones/${quotationId}/editar`);
      await expect(page.getByLabel('Cliente', { exact: true })).toContainText(customer.name, {
        timeout: 30_000,
      });
    } finally {
      if (quotationId) await purgeSalesTrail(api, { quotationIds: [quotationId] });
      await deactivateTrail(api, { productIds: [product.id], customerIds: [customer.id] });
    }
  });

  test('cambiar cliente de un pedido: busca en el servidor y no ofrece al cliente actual', async ({
    page,
  }) => {
    const owner = await createCustomer(api);
    const target = await createCustomer(api);
    // Confirmar el pedido reserva stock real: un producto vendible sin compra recibida no
    // tiene disponible, y la confirmación lo rechaza (ese no es el punto de este test).
    // El precio de venta tiene que respetar el piso de D-163 sobre el costo (S/ 20 la unidad).
    const stock = await setupPosStock(api, { qty: '10', unitPrice: '20' });
    const quotation = await createQuotation(api, {
      customerId: owner.id,
      businessLine: POS_LINE,
      productId: stock.product.id,
      qty: '1',
      unitPricePen: '30',
    });
    const order = await postJson<SalesOrderDto>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
    );
    const targetNeedle = needleOf(target.name);

    try {
      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await (await headerAction(page, 'Cambiar cliente')).click();

      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Cliente nuevo').click();
      await dialog.getByLabel('Filtrar opciones').fill(needleOf(owner.name));

      // El cliente de hoy no se ofrece como "nuevo cliente", ni buscando su propio nombre.
      await expect(dialog.getByText('Ninguna opción coincide con ese texto.')).toBeVisible();
      await page.keyboard.press('Escape');

      await chooseOption(
        page,
        dialog.getByLabel('Cliente nuevo'),
        customerLabel(target),
        targetNeedle,
      );

      await dialog.getByLabel('Motivo').fill('Corrección E2E RF-S3/M1');
      const patch = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          r.url().includes(`/api/sales/orders/${order.id}/customer`),
      );
      await dialog.getByRole('button', { name: 'Cambiar cliente', exact: true }).click();
      const response = await patch;
      expect(response.status(), await response.text()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(page.getByText(target.docNumber)).toBeVisible();
    } finally {
      await purgeSalesTrail(api, { orderIds: [order.id], quotationIds: [quotation.id] });
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
        customerIds: [owner.id, target.id],
      });
    }
  });
});
