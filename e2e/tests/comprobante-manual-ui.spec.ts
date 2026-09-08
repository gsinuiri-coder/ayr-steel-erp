import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { today } from '../helpers/production';
import { setupCoilStock, type SalesOrderDto } from '../helpers/sales';
import {
  DISPATCH_LINE,
  createInvoice,
  createInvoiceableCustomer,
  getDocument,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';

/**
 * Comprobante manual **por pantalla** (D-153): `/comprobantes/<id>` en un borrador.
 *
 * `comprobante-manual.spec.ts` cubre las reglas por API —el número que no mueve la
 * numeración del ERP, el duplicado que vuelve 409, el kardex quieto, la anulación
 * bloqueada por un cobro—. Lo que falta y prueba este caso es que **el terminal manual
 * exista de verdad para el usuario**:
 *
 * - Un borrador ofrece **los dos** terminales a la vez, «Registrar manual» y «Emitir y
 *   enviar al PSE». Que los dos estén visibles es el punto de la decisión: el ajuste global
 *   elige cuál es el principal, no cuál se esconde. Esconder el electrónico haría que un
 *   descuido pasara inadvertido.
 * - El diálogo pide serie y correlativo, **frena lo que el API rechazaría** (una serie de
 *   dos caracteres) y muestra el número que va a quedar antes de escribir nada.
 * - Registrado, la pantalla dice lo mismo que la base: número, aceptado, y sin los
 *   terminales del borrador.
 *
 * Y hay una razón concreta para cubrirlo por UI y no solo por API: el registro manual **no
 * habla con el PSE**, así que este camino no depende de `E2E_FISCAL_EMISSION` ni del cupo
 * de la cuenta demo. Es la única parte del ciclo fiscal que se puede ejercitar entera desde
 * la pantalla en cualquier entorno.
 *
 * Escribe pedidos, bobinas y comprobantes: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, bobinas y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

// Monta el escenario por API y encima navega a rutas que el Next de desarrollo compila
// recién en el primer visitante de la corrida: el timeout por defecto no alcanza.
test.describe.configure({ timeout: 240_000 });

/** Serie del talonario de la otra app. `F9xx` no choca con ninguna serie del ERP. */
const MANUAL_SERIES = 'F901';

/**
 * Correlativo único por corrida. El del enunciado (`1349`) se tipea igual para comprobar la
 * vista previa, pero **no** es el que se registra: la base del E2E se vacía en cada corrida
 * y aun así un número fijo haría fallar con 409 a la segunda corrida sobre una base viva, y
 * ese 409 se lee como un defecto de la pantalla.
 */
function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

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
  // Con el App Router la URL cambia recién cuando llega el RSC del destino, y en modo dev el
  // tablero se compila en el primer visitante (mismo motivo que en `import-cotizaciones-ui`).
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-153 — la pantalla del comprobante manual', () => {
  test('un borrador ofrece los dos terminales, el diálogo valida el número y registrarlo lo deja aceptado', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupOrderScenario(api);
    const trail: string[] = [];

    try {
      // -----------------------------------------------------------------
      // 1. El borrador, por API: la pantalla no lo crea.
      // -----------------------------------------------------------------
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '2' }],
      });
      trail.push(draft.id);
      expect(draft.status).toBe('DRAFT');

      // -----------------------------------------------------------------
      // 2. El detalle, como administrador.
      // -----------------------------------------------------------------
      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${draft.id}`);
      // Un borrador no tiene número, así que su título es literalmente «Borrador» (D-072).
      await expect(page.getByRole('heading', { name: 'Borrador' })).toBeVisible({
        timeout: 60_000,
      });

      // -----------------------------------------------------------------
      // 3. Los dos terminales, **a la vez**. Es el punto de D-153.
      // -----------------------------------------------------------------
      const manualButton = page.getByRole('button', { name: 'Registrar manual' });
      const sendButton = page.getByRole('button', { name: 'Emitir y enviar al PSE' });
      await expect(manualButton).toBeVisible();
      await expect(sendButton).toBeVisible();

      // -----------------------------------------------------------------
      // 4. El diálogo: pide serie y correlativo, y no deja registrar cualquier cosa.
      // -----------------------------------------------------------------
      await manualButton.click();
      const dialog = page.getByRole('dialog');
      await expect(
        dialog.getByRole('heading', { name: 'Registrar como comprobante manual' }),
      ).toBeVisible();
      const seriesInput = dialog.getByLabel('Serie');
      const correlativeInput = dialog.getByLabel('Correlativo');
      await expect(seriesInput).toBeVisible();
      await expect(correlativeInput).toBeVisible();

      const submit = dialog.getByRole('button', { name: 'Registrar' });

      // Serie de dos caracteres: la misma cota que `registerManualSchema`. La pantalla la
      // frena antes de gastar un 400, y lo dice.
      await seriesInput.fill('F1');
      await correlativeInput.fill('1349');
      await expect(submit).toBeDisabled();
      await expect(
        dialog.getByText(
          'La serie son cuatro caracteres (ej: F001) y el correlativo un entero mayor a cero.',
        ),
      ).toBeVisible();

      // Con la serie bien escrita aparece el número tal como va a quedar: cuatro caracteres,
      // guion y el correlativo a ocho dígitos.
      await seriesInput.fill(MANUAL_SERIES);
      await expect(dialog.getByText(`${MANUAL_SERIES}-00001349`)).toBeVisible();
      await expect(submit).toBeEnabled();

      // -----------------------------------------------------------------
      // 5. Registrar. El número que se guarda es único por corrida (ver `uniqueCorrelative`).
      // -----------------------------------------------------------------
      const correlative = uniqueCorrelative();
      const expectedNumber = `${MANUAL_SERIES}-${String(correlative).padStart(8, '0')}`;
      await correlativeInput.fill(String(correlative));
      await expect(dialog.getByText(expectedNumber)).toBeVisible();

      const registered = page.waitForResponse(
        (r) => r.url().includes('/register-manual') && r.request().method() === 'POST',
      );
      await submit.click();
      const response = await registered;
      expect(response.ok(), `el registro manual falló: ${await response.text()}`).toBe(true);

      // -----------------------------------------------------------------
      // 6. La pantalla, después: número, aceptado y sin los terminales del borrador.
      // -----------------------------------------------------------------
      await expect(page.getByRole('heading', { name: expectedNumber })).toBeVisible();
      await expect(page.getByText('Aceptado', { exact: true })).toBeVisible();
      await expect(manualButton).toHaveCount(0);
      await expect(sendButton).toHaveCount(0);
      // Ya no es un borrador, así que tampoco se descarta.
      await expect(page.getByRole('button', { name: 'Descartar borrador' })).toHaveCount(0);

      // -----------------------------------------------------------------
      // 7. Y la base dice lo mismo que la pantalla.
      // -----------------------------------------------------------------
      const stored = await getDocument(api, draft.id);
      expect(stored.origin).toBe('MANUAL');
      expect(stored.status).toBe('ACCEPTED');
      expect(stored.number).toBe(expectedNumber);
      expect(stored.series).toBe(MANUAL_SERIES);
      expect(stored.correlative).toBe(correlative);
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        orderIds: [scenario.order.id],
        coilIds: [scenario.coil.id],
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplier.id,
        finish: scenario.finish,
        productIds: [scenario.product.id],
      });
      await api.dispose();
    }
  });

  /**
   * El pre-llenado desde las observaciones del pedido (D-152 → D-153): el importador de
   * cotizaciones escribe `Factura externa: F901-0001349` y confirmarla lo copia al pedido,
   * así que al abrir el diálogo la serie y el correlativo ya tendrían que estar puestos.
   *
   * Es la mitad que justifica el pre-llenado entero: el operador que migra factura por
   * factura no vuelve a tipear un número que el sistema ya sabe.
   */
  test('el diálogo viene pre-llenado con el número que traen las observaciones del pedido', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const stock = await setupCoilStock(api, { lineCode: DISPATCH_LINE, weightKg: '1000' });
    // El mismo texto que deja el importador, con el correlativo **con ceros a la izquierda**:
    // así se comprueba que el campo recibe `1349` y no `0001349`.
    const order = await postJson<SalesOrderDto>(api, '/api/sales/orders', {
      customerId: customer.id,
      issueDate: today(),
      notes: `Factura externa: ${MANUAL_SERIES}-0001349`,
      items: [{ saleCoilId: stock.coil.id, qty: stock.coil.availableKg, unitPricePen: '8.0000' }],
    });
    const trail: string[] = [];

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: '2' }],
      });
      trail.push(draft.id);

      await loginAsAdmin(page);
      await page.goto(`/comprobantes/${draft.id}`);
      await expect(page.getByRole('heading', { name: 'Borrador' })).toBeVisible({
        timeout: 60_000,
      });

      await page.getByRole('button', { name: 'Registrar manual' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Serie')).toHaveValue(MANUAL_SERIES);
      await expect(dialog.getByLabel('Correlativo')).toHaveValue('1349');
      // Y con los dos campos puestos, el número previsto es el del papel.
      await expect(dialog.getByText(`${MANUAL_SERIES}-00001349`)).toBeVisible();
    } finally {
      await purgeInvoicingTrail(api, {
        documentIds: trail,
        orderIds: [order.id],
        coilIds: [stock.coil.id],
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        finish: stock.finish,
      });
      await api.dispose();
    }
  });
});
