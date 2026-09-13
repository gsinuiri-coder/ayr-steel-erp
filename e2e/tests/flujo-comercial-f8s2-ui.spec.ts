import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import { headerAction } from '../helpers/ui';
import { expireTemporaryReservationsNow } from '../helpers/db';
import { apiAs, ROLE_PASSWORD } from '../helpers/production';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  reservationsOf,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import {
  createCustomer,
  createQuotation,
  stockPanel,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * F8-S2 — el flujo comercial nuevo **por pantalla** (D-184..D-187).
 *
 * `flujo-comercial-f8s2.spec.ts` y `pedido-edicion-f8s2.spec.ts` cubren las reglas por API;
 * este archivo cubre lo que solo se ve manejando la app: que el formulario de edición registre
 * el cambio de precio, que cada rol vea los botones que el API le deja usar, que el diálogo de
 * confirmar diga el faltante y apague el botón, que la vista de reservas temporales libere, y
 * que el diálogo de cantidad por largos mueva la reserva.
 *
 * Geometría de prueba: 4.04 kg/m (ver `flujo-comercial-f8s2.spec.ts`), así que una línea de
 * 10 m son 40.400 kg del agregado.
 *
 * Escribe cotizaciones, reservas, pedidos y órdenes: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 240_000 });

type QuotationWithChanges = QuotationDto & {
  priceChanges: { beforeUnitValuePen: string; afterUnitValuePen: string }[];
};

async function availableKg(api: APIRequestContext, s: RoofingScenario): Promise<string> {
  const panel = await stockPanel(api, { businessLine: ROOFING_LINE, productIds: [s.product.id] });
  return panel.products.find((p) => p.productId === s.product.id)?.rawMaterialAvailableKg ?? '';
}

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await login(page, email, password);
}

/** El editor de largos de una línea en metros solo se pinta cuando el catálogo ya llegó. */
async function waitForCatalog(page: Page): Promise<void> {
  await expect(page.getByText('Planchas de esta línea (cantidad × largo)')).toBeVisible({
    timeout: 60_000,
  });
}

test.describe('F8-S2 por pantalla — cotización, confirmar, reservas y pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-184/D-187: editar el precio de una cotización emitida desde el formulario lo deja en «Cambios de precio», y guardar sin tocar no agrega filas', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60', // 70.80 con IGV
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}`);
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      // Una cotización recién emitida no tiene historial de precios: la tarjeta no se pinta.
      await expect(page.getByRole('table', { name: 'Cambios de precio' })).toHaveCount(0);

      await (await headerAction(page, 'Editar')).click();
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}/editar$`));
      await expect(page.getByRole('heading', { name: `Editar ${quotation.code}` })).toBeVisible({
        timeout: 60_000,
      });
      // El precio llega con la cotización, pero el editor de largos solo aparece cuando llegó
      // el catálogo: guardar antes pierde los largos (ver el test del defecto más abajo).
      await waitForCatalog(page);
      const price = page.getByLabel('Precio unitario de la línea 1');
      await expect(price).toHaveValue('70.8000');
      // 76.70 con IGV son 65.0000 sin IGV.
      await price.fill('76.70');
      await page.getByRole('button', { name: 'Guardar cambios' }).click();

      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}$`), {
        timeout: 30_000,
      });
      const changes = page.getByRole('table', { name: 'Cambios de precio' });
      await expect(changes).toBeVisible();
      const changeRows = changes.getByRole('row').filter({ hasText: `L1 · ${s.product.sku}` });
      await expect(changeRows).toHaveCount(1);
      await expect(changeRows.getByText('S/ 70.80', { exact: true })).toBeVisible();
      await expect(changeRows.getByText('S/ 76.70', { exact: true })).toBeVisible();
      // 10 m × 65.00 = 650.00 + 18 % = 767.00.
      await expect(page.getByText('S/ 767.00', { exact: true })).toBeVisible();

      // Volver a guardar desde el formulario sin tocar el precio no es un cambio de precio: el
      // valor tiene que ir y volver por el precio con IGV sin moverse un centavo.
      await (await headerAction(page, 'Editar')).click();
      await waitForCatalog(page);
      await expect(page.getByLabel('Precio unitario de la línea 1')).toHaveValue('76.7000');
      await page.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}$`), {
        timeout: 30_000,
      });
      await expect(
        changes.getByRole('row').filter({ hasText: `L1 · ${s.product.sku}` }),
      ).toHaveCount(1);

      const detail = await getJson<QuotationWithChanges>(
        api,
        `/api/sales/quotations/${quotation.id}`,
      );
      expect(detail.status).toBe('EMITTED');
      expect(detail.items[0]!.unitPricePen).toBe('65.0000');
      expect(detail.priceChanges).toEqual([
        expect.objectContaining({ beforeUnitValuePen: '60.0000', afterUnitValuePen: '65.0000' }),
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-184: guardar la edición antes de que llegue el catálogo no pierde los largos de la línea a medida', async ({
    page,
  }) => {
    /*
     * DEFECTO CORREGIDO (lo encontró este archivo, F8-S2): «Guardar» queda apagado hasta que
     * llega el catálogo, y `validate` no valida una línea sin su producto. Lo que sigue es el
     * contexto del defecto original.
     * `SalesDocumentForm#validate`
     * decide si la línea lleva largos con `sellsByLength(productById.get(l.productId))`, y
     * mientras `/api/catalog` no respondió ese producto es `undefined`: la línea viaja **sin
     * `pieces`** aunque la pantalla ya muestre el precio y la cantidad sembrados desde la
     * cotización. «Guardar cambios» está habilitado todo ese tiempo. El API lo rechaza con «se
     * vende por metro lineal: detalla cuántas planchas de cada largo lleva la línea», que no se
     * parece a la causa. Con la misma raíz, `lineValues` trata una plancha (D-161) como si se
     * negociara por unidad y el piso de D-163 no se comprueba en cliente.
     *
     * En la corrida local salió solo: el catálogo tardó 1.3 s y el PUT salió a los 0.45 s. Acá
     * se hace determinista demorando el catálogo. Cuando se corrija (apagar el botón hasta
     * tener el catálogo, o no validar sin producto), quitar el `test.fail`.
     */
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]);
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);

      await loginAsAdmin(page);
      await page.route('**/api/catalog', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        await route.continue().catch(() => undefined);
      });
      await page.goto(`/cotizaciones/${quotation.id}/editar`);
      const price = page.getByLabel('Precio unitario de la línea 1');
      await expect(price).toHaveValue('70.8000', { timeout: 60_000 });
      await price.fill('76.70');

      const put = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().includes(`/api/sales/quotations/${quotation.id}`),
      );
      await page.getByRole('button', { name: 'Guardar cambios' }).click();
      const response = await put;
      expect(response.status(), await response.text()).toBe(200);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-187: el vendedor dueño del pedido ve «Agregar ítems» y «Cantidad» pero no «Precio» ni «Cambiar cliente»; en un pedido ajeno no ve ninguna edición', async ({
    page,
    baseURL,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    const seller = await createUser(api, 'VENDEDOR');
    const sellerApi = await apiAs(baseURL!, seller);
    try {
      const rows = pieces([10, 1]); // 40.400 kg
      const own = await createQuotation(sellerApi, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(own.id);
      const ownOrder = await postJson<SalesOrderDto>(
        sellerApi,
        `/api/sales/quotations/${own.id}/confirm`,
      );
      trail.orderIds.push(ownOrder.id);

      const foreign = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(foreign.id);
      const foreignOrder = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${foreign.id}/confirm`,
      );
      trail.orderIds.push(foreignOrder.id);

      // `apiAs` ya cambió la contraseña temporal: la pantalla entra directo.
      await login(page, seller.email, ROLE_PASSWORD);

      await page.goto(`/pedidos/${ownOrder.id}`);
      await expect(page.getByRole('heading', { name: ownOrder.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      // F8-S3b/M3: las acciones secundarias del pedido viven en el menú «Más acciones».
      await expect(await headerAction(page, 'Agregar ítems')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Cambiar cliente' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Anular pedido' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cambiar precio de la línea 1' })).toHaveCount(
        0,
      );

      // Lo que ve lo puede usar: la cantidad pasa de 1 a 2 planchas de 10 m desde el diálogo.
      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Planchas del largo 1', { exact: true })).toHaveValue('1');
      await dialog.getByLabel('Planchas del largo 1', { exact: true }).fill('2');
      await dialog.getByRole('button', { name: 'Guardar cantidad' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByText('20.000 m', { exact: true })).toBeVisible();
      const ownActive = (await reservationsOf(api, ownOrder.id)).filter(
        (r) => r.status === 'ACTIVE',
      );
      expect(ownActive).toEqual([expect.objectContaining({ qty: '80.800' })]);

      // En el pedido del administrador no es dueño: ni agregar ni cambiar cantidades.
      await page.goto(`/pedidos/${foreignOrder.id}`);
      await expect(page.getByRole('heading', { name: foreignOrder.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole('link', { name: 'Agregar ítems' })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cambiar precio de la línea 1' })).toHaveCount(
        0,
      );
    } finally {
      await sellerApi.dispose();
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-186: si falta materia prima el diálogo de confirmar dice el faltante y apaga el botón; al liberarse el material, reabrirlo lo habilita', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 2]); // 80.800 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);
      // Un rival aparta 40.400 kg: a esta le quedan 59.600 y le faltan 21.200.
      const rivalRows = pieces([10, 1]);
      const rival = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rivalRows),
        unitPricePen: '60',
        pieces: rivalRows,
      });
      trail.quotationIds.push(rival.id);
      await postJson(api, `/api/sales/quotations/${rival.id}/reserve`);

      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}`);
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });

      await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Reserva MP y genera OP')).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText('faltan 21.200 kg', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Línea 1: .* faltan 21\.200$/)).toBeVisible();
      const confirmButton = dialog.getByRole('button', { name: 'Confirmar', exact: true });
      await expect(confirmButton).toBeDisabled();

      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toBeHidden();

      // El rival suelta el material. El diálogo relee al abrirse: ya no bloquea.
      await postJson(api, `/api/sales/quotations/${rival.id}/release-reservation`, {
        reason: 'El rival no depositó',
      });
      await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
      await expect(dialog.getByText('2 × 10.00 m')).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText(/faltan/)).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Confirmar', exact: true })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Cancelar' }).click();

      // Nada se confirmó por abrir y cerrar el diálogo.
      const detail = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(detail.status).toBe('EMITTED');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-185: «Reservas temporales» lista las vigentes, no las vencidas, y «Liberar» con motivo saca la fila y devuelve el material', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]); // 40.400 kg cada una
      const alive = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(alive.id);
      const expired = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(expired.id);
      await postJson(api, `/api/sales/quotations/${alive.id}/reserve`);
      await postJson(api, `/api/sales/quotations/${expired.id}/reserve`);
      expect(await expireTemporaryReservationsNow(expired.id)).toBe(1);
      expect(await availableKg(api, s)).toBe('459.600');

      await loginAsAdmin(page);
      await page.goto('/reservas-temporales');
      await expect(
        page.getByRole('heading', { name: 'Reservas temporales', level: 1 }),
      ).toBeVisible({ timeout: 60_000 });

      const aliveRow = page
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name: alive.code, exact: true }) });
      await expect(aliveRow).toHaveCount(1, { timeout: 30_000 });
      await expect(aliveRow.getByText(customer.name)).toBeVisible();
      await expect(aliveRow.getByText(/L1 · .* · 40\.400 kg/)).toBeVisible();
      // La vencida no aparece aunque nadie la haya marcado.
      await expect(page.getByRole('link', { name: expired.code, exact: true })).toHaveCount(0);

      await aliveRow.getByRole('button', { name: 'Liberar' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(`Liberar la reserva de ${alive.code}`)).toBeVisible();
      const releaseButton = dialog.getByRole('button', { name: 'Liberar reserva' });
      await expect(releaseButton).toBeDisabled();
      await dialog.getByLabel('Motivo').fill('no');
      await expect(releaseButton).toBeDisabled();
      await dialog.getByLabel('Motivo').fill('El cliente no depositó');
      await releaseButton.click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(aliveRow).toHaveCount(0);

      const detail = await getJson<QuotationDto>(api, `/api/sales/quotations/${alive.id}`);
      expect(detail.temporaryReservation).toBeNull();
      expect(detail.status).toBe('EMITTED');
      expect(await availableKg(api, s)).toBe('500.000');

      // Y el detalle de la cotización ya no muestra la tarjeta de la reserva.
      await page.goto(`/cotizaciones/${alive.id}`);
      await expect(page.getByRole('heading', { name: alive.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText('Reserva temporal', { exact: true })).toHaveCount(0);
      await expect(await headerAction(page, 'Reservar')).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-187: cambiar los largos de una línea a medida desde el diálogo de cantidad mueve la reserva y el plan de su OP', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 1]); // 40.400 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      const before = (await reservationsOf(api, order.id)).find((r) => r.status === 'ACTIVE');
      expect(before).toMatchObject({ qty: '40.400' });

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText('40.400 kg', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Largo 1 en metros', { exact: true })).toHaveValue(
        /^10(\.0+)?$/,
      );
      // 1 × 10 m + 2 × 5 m = 20 m ⇒ 80.800 kg.
      await dialog.getByRole('button', { name: 'Agregar largo' }).click();
      await dialog.getByLabel('Planchas del largo 2', { exact: true }).fill('2');
      await dialog.getByLabel('Largo 2 en metros', { exact: true }).fill('5');
      await dialog.getByRole('button', { name: 'Guardar cantidad' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      // La pantalla refleja la cantidad y la reserva nuevas sin recargar.
      await expect(page.getByText('20.000 m', { exact: true })).toBeVisible();
      const activeRow = page
        .getByRole('row')
        .filter({ hasText: '80.800 kg' })
        .filter({ hasText: 'Activa' });
      await expect(activeRow).toHaveCount(1);

      expect(await availableKg(api, s)).toBe('419.200');
      const active = (await reservationsOf(api, order.id)).filter((r) => r.status === 'ACTIVE');
      expect(active).toEqual([expect.objectContaining({ qty: '80.800' })]);
      expect(active[0]!.productionOrderId).toBe(before!.productionOrderId);
      const op = await getJson<{ items: { lengthMm: string; qty: number }[] }>(
        api,
        `/api/production/${active[0]!.productionOrderId!}`,
      );
      expect(op.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lengthMm: '10000.00', qty: 1 }),
          expect.objectContaining({ lengthMm: '5000.00', qty: 2 }),
        ]),
      );
      expect(op.items).toHaveLength(2);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
