import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminCredentials } from '../helpers/api';

/**
 * D-284 — los formularios de documento (cotización, pedido directo, comprobante) comparten una
 * misma grilla de cuatro columnas y el mismo pie de acciones. Se mide en el DOM, no a ojo:
 * bordes que tienen que coincidir y anchos que tienen que ser iguales entre pantallas.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Mide pantallas de alta: sin datos, pero nunca contra producción.');
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1440, height: 900 } });

async function box(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 60_000 });
  const b = await locator.boundingBox();
  if (!b) throw new Error('sin caja');
  return { left: b.x, right: b.x + b.width, width: b.width, top: b.y, bottom: b.y + b.height };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** El pie: la acción principal pegada al borde derecho de la sección de datos, Cancelar a su izquierda. */
async function expectActionsAligned(page: Page, primary: string, section: Locator) {
  const sectionBox = await box(section);
  const main = await box(page.getByRole('button', { name: primary }));
  const cancel = await box(page.getByRole('button', { name: 'Cancelar' }));
  expect(Math.abs(main.right - sectionBox.right)).toBeLessThanOrEqual(1);
  expect(cancel.right).toBeLessThan(main.left);
  expect(Math.abs(cancel.top - main.top)).toBeLessThanOrEqual(1);
}

test.describe('D-284 — grilla y acciones de los formularios de documento', () => {
  test('cotización, pedido directo y comprobante: misma grilla, observaciones a lo ancho y acciones a la derecha', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await page.goto('/cotizaciones/nueva');
    const quotationData = page.getByRole('region', { name: 'Datos de la cotización' });
    const customer = await box(quotationData.getByText('Cliente', { exact: true }));
    const quotationDate = await box(page.getByLabel('Fecha de emisión'));
    const validity = await box(page.getByLabel('Vigencia (días)'));
    const notes = await box(page.getByLabel('Observaciones'));
    // Observaciones ocupa la fila entera: empieza donde Cliente y termina donde Vigencia.
    expect(Math.abs(notes.left - customer.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(notes.right - validity.right)).toBeLessThanOrEqual(1);
    await expectActionsAligned(page, 'Crear cotización', quotationData);

    await page.goto('/pedidos/nuevo');
    const orderData = page.getByRole('region', { name: 'Datos del pedido' });
    const orderDate = await box(page.getByLabel('Fecha de emisión'));
    expect(Math.abs(orderDate.width - quotationDate.width)).toBeLessThanOrEqual(1);
    await expectActionsAligned(page, 'Crear pedido', orderData);

    await page.goto('/comprobantes/nuevo');
    const invoiceData = page.getByRole('region', { name: 'Datos del comprobante' });
    const invoiceDate = await box(page.getByLabel('Fecha de emisión'));
    // La misma columna de la grilla mide lo mismo en las tres pantallas.
    expect(Math.abs(invoiceDate.width - quotationDate.width)).toBeLessThanOrEqual(1);
    const invoiceNotes = await box(page.getByLabel('Observaciones'));
    const invoiceType = await box(page.getByLabel('Tipo'));
    expect(Math.abs(invoiceNotes.left - invoiceType.left)).toBeLessThanOrEqual(1);
    // Cliente ocupa las dos últimas columnas de la primera fila: termina donde Observaciones.
    const invoiceCustomer = await box(page.getByLabel('Cliente'));
    expect(Math.abs(invoiceNotes.right - invoiceCustomer.right)).toBeLessThanOrEqual(1);
    // Las líneas libres son una tabla con columnas alineadas, una etiqueta por columna.
    await expect(page.getByLabel('Descripción de la línea 1')).toBeVisible();
    await expect(page.getByLabel('Cantidad de la línea 1')).toBeVisible();
    await expectActionsAligned(page, 'Crear borrador', invoiceData);
  });
});
