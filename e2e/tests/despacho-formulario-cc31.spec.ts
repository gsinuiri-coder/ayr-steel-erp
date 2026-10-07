import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createSupplier, postJson } from '../helpers/api';
import { today, uniqueDocumentNumber } from '../helpers/production';
import { createCustomer, createDirectOrder, createSellableProduct } from '../helpers/sales';

/**
 * cc31 (ESPEC §6, «Formulario de página», modelo Nuevo despacho): el botón principal no se apaga
 * por un dato faltante. Al pulsarlo con faltantes no envía, la barra fija dice «Faltan N datos»
 * con un enlace a cada campo y el campo queda marcado con una frase que dice qué corregir.
 * Además, «Qué sale» viene llenado con lo pendiente y «Vaciar cantidades» lo deja en blanco.
 *
 * Mismo escenario que `despacho-peso-por-linea.spec.ts`: un producto de drywall con stock propio
 * y un pedido directo que lo reserva.
 */

const isProduction = !!process.env.E2E_BASE_URL;

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true });
}

test.describe('cc31 — formulario de nuevo despacho', () => {
  test('con datos faltantes «Despachar» sigue habilitado, no envía y marca los campos', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      isProduction,
      'Crea proveedor, producto y pedido: nunca contra producción (D-126, regla dura 9).',
    );

    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api, { name: 'E2E Proveedor formulario cc31' });
    const product = await createSellableProduct(api, {
      lineCode: 'drywall',
      listPricePen: '50.0000',
    });
    const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'drywall',
      type: 'FINISHED_GOOD',
      docType: 'FACTURA',
      series: 'F001',
      number: uniqueDocumentNumber(),
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        {
          productId: product.id,
          description: 'Producto E2E de drywall con stock propio',
          qty: '10',
          unit: 'NIU',
          unitPrice: '30',
        },
      ],
    });
    await postJson(api, `/api/purchases/${purchase.id}/receive`);

    const customer = await createCustomer(api);
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: 'drywall',
      items: [{ productId: product.id, qty: '5', unitPricePen: '50.0000' }],
    });

    await loginAsAdmin(page);
    await page.goto('/despachos/nuevo');
    await expect(page.getByRole('heading', { name: 'Nuevo despacho', level: 1 })).toBeVisible();

    await page.getByRole('combobox', { name: 'Pedido', exact: true }).click();
    await page.getByRole('option', { name: `${order.code} · ${customer.name}` }).click();
    await expect(page.getByText(product.sku, { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // «Qué sale» viene llenado con lo pendiente.
    const qtyInput = page.getByRole('textbox', {
      name: `Cantidad a despachar de la línea 1 (${product.sku})`,
      exact: true,
    });
    await expect(qtyInput).toHaveValue(/^5(\.0+)?$/, { timeout: 20_000 });

    // Todo menos la placa y la licencia.
    await field(page, 'Dirección de partida').fill('Av. Almacén 100, Lima');
    await field(page, 'Ubigeo de partida').fill('150101');
    await field(page, 'Dirección de llegada').fill('Av. Cliente 200, Lima');
    await field(page, 'Ubigeo de llegada').fill('150132');
    await field(page, 'Nombres del conductor').fill('Juan');
    await field(page, 'Apellidos del conductor').fill('Pérez');
    await field(page, 'Número de documento').fill('45678912');

    const bar = page.locator('[data-slot="sticky-action-bar"]');
    await expect(bar.getByText('Faltan 2 datos:')).toBeVisible();
    await expect(bar.getByRole('link', { name: 'placa', exact: true })).toBeVisible();

    let dispatchPosts = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/dispatches') && r.method() === 'POST') dispatchPosts += 1;
    });

    const despachar = page.getByRole('button', { name: 'Despachar', exact: true });
    await expect(despachar).toBeEnabled();
    await despachar.click();

    // No envía: la URL sigue en el formulario y la placa queda marcada, con el foco.
    const plate = field(page, 'Placa');
    await expect(plate).toHaveAttribute('aria-invalid', 'true');
    await expect(plate).toBeFocused();
    await expect(page.getByText('Escribe la placa.', { exact: true })).toBeVisible();
    await expect(field(page, 'Licencia de conducir')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/despachos\/nuevo/);
    expect(dispatchPosts, 'Con faltantes, «Despachar» no debía llamar al API').toBe(0);

    // El enlace de la barra lleva al campo.
    await field(page, 'Nombres del conductor').focus();
    await bar.getByRole('link', { name: 'licencia de conducir', exact: true }).click();
    await expect(field(page, 'Licencia de conducir')).toBeFocused();

    // Escribir lo que faltaba quita la marca.
    await field(page, 'Placa').fill('ABC-123');
    await expect(field(page, 'Placa')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(bar.getByText('Falta 1 dato:')).toBeVisible();

    // «Vaciar cantidades» deja las cantidades en blanco; «Llenar con lo pendiente» las repone.
    await page.getByRole('button', { name: 'Vaciar cantidades', exact: true }).click();
    await expect(qtyInput).toHaveValue('');
    await page.getByRole('button', { name: 'Llenar con lo pendiente', exact: true }).click();
    await expect(qtyInput).toHaveValue(/^5(\.0+)?$/);
    expect(dispatchPosts).toBe(0);
  });
});
