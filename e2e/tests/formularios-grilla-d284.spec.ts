import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminCredentials } from '../helpers/api';

/**
 * D-284 — los formularios de documento comparten el mismo pie de acciones, y el comprobante
 * nuevo conserva la grilla de cuatro columnas.
 *
 * D-550 (cc36, reemplaza a D-496): la cotización y el pedido directo llevan la cabecera del
 * tablero Main —sin tarjeta con título, los campos en una sola fila bajo el título—. Lo que el
 * test protegía sigue protegido: el orden de los campos, el cliente como el campo más ancho y
 * observaciones hasta el borde derecho de la sección.
 *
 * Se mide en el DOM, no a ojo: bordes que tienen que coincidir y anchos que tienen que ser
 * iguales entre pantallas.
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

test.describe('D-284 / D-550 — cabecera y acciones de los formularios de documento', () => {
  test('cotización y pedido en una fila (Main), comprobante en la grilla de D-284, acciones a la derecha', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await page.goto('/cotizaciones/nueva');
    const quotationData = page.getByRole('region', { name: 'Datos de la cotización' });
    // Sin tarjeta con título: el nombre de la sección es solo para el lector de pantalla.
    await expect(quotationData.getByRole('heading')).toHaveCount(0);
    const sectionBox = await box(quotationData);
    const customer = await box(page.locator('#customer'));
    const quotationDate = await box(page.getByLabel('Fecha de emisión'));
    const validity = await box(page.getByLabel('Vigencia (días)'));
    const notes = await box(page.getByLabel('Observaciones'));
    // Una sola fila, en este orden: cliente, emisión, vigencia, observaciones.
    for (const field of [quotationDate, validity, notes]) {
      expect(Math.abs(field.top - customer.top)).toBeLessThanOrEqual(2);
    }
    expect(customer.right).toBeLessThan(quotationDate.left);
    expect(quotationDate.right).toBeLessThan(validity.left);
    expect(validity.right).toBeLessThan(notes.left);
    // El cliente es el campo más ancho; observaciones llega hasta el borde de la sección.
    for (const field of [quotationDate, validity, notes]) {
      expect(customer.width).toBeGreaterThan(field.width);
    }
    expect(notes.width).toBeGreaterThan(quotationDate.width);
    expect(sectionBox.right - notes.right).toBeLessThanOrEqual(16);
    // «Stock disponible» arriba a la derecha de la página, sobre la sección de datos.
    const stock = await box(page.getByRole('button', { name: 'Stock disponible' }));
    expect(stock.bottom).toBeLessThanOrEqual(sectionBox.top);
    expect(Math.abs(stock.right - sectionBox.right)).toBeLessThanOrEqual(1);
    await expectActionsAligned(page, 'Crear cotización', quotationData);

    await page.goto('/pedidos/nuevo');
    const orderData = page.getByRole('region', { name: 'Datos del pedido' });
    const orderBox = await box(orderData);
    const orderCustomer = await box(page.locator('#customer'));
    const orderDate = await box(page.getByLabel('Fecha de emisión'));
    const orderNotes = await box(page.getByLabel('Observaciones'));
    expect(Math.abs(orderDate.width - quotationDate.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(orderCustomer.width - customer.width)).toBeLessThanOrEqual(1);
    expect(orderDate.right).toBeLessThan(orderNotes.left);
    expect(Math.abs(orderNotes.top - orderDate.top)).toBeLessThanOrEqual(2);
    expect(orderBox.right - orderNotes.right).toBeLessThanOrEqual(16);
    await expectActionsAligned(page, 'Crear pedido', orderData);

    // El comprobante nuevo no cambia: grilla de cuatro columnas (D-284).
    await page.goto('/comprobantes/nuevo');
    const invoiceData = page.getByRole('region', { name: 'Datos del comprobante' });
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
