import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createSupplier, createUser, postJson } from '../helpers/api';
import { today, uniqueDocumentNumber } from '../helpers/production';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import {
  createCustomer,
  createDirectOrder,
  createQuotation,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
  type SalesOrderDto,
} from '../helpers/sales';
import { chooseOption, loginAndSetPassword } from '../helpers/ui';

/**
 * QA de la sesión F8-S2b: huecos de cobertura sobre lo que dejaron D-185 (addendum F8-S2b) y
 * D-188 — ver `docs/ARQUITECTURA.md` §0.2. Los specs de la sesión (`product-stock-picker-f8s2b`,
 * `reserva-bobina-picker-f8s2b`, `stock-shortage-f8s2b`, `cotizacion-sin-vencimiento-f8s2b`)
 * cubren el camino feliz de cada punto; este archivo cubre lo que quedó afuera:
 *
 * 1. El picker de producto en una línea SIN pool de bobinas (Drywall/UPVC/Trading).
 * 2. Que el filtro de texto del picker de verdad acota (con más de un producto activo).
 * 3. Que cancelar el diálogo de precio/cantidad del pedido y reabrirlo en OTRA línea no
 *    arrastra lo que quedó tipeado de la línea anterior.
 * 4. Que la tarjeta "sin stock" del Panel no pinta nada — ni una tarjeta vacía — sin faltantes.
 * 5. Que un VENDEDOR (no solo ADMINISTRADOR) ve esa tarjeta.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 180_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** Un producto con stock propio (compra `FINISHED_GOOD` + recepción), en la línea que se pida. */
async function stockedProduct(
  api: APIRequestContext,
  lineCode: string,
  options: { qty: string; listPricePen: string; unitPrice?: string },
): Promise<{ sku: string; id: string }> {
  const supplier = await createSupplier(api, { name: `E2E Proveedor huecos ${lineCode}` });
  const product = await createSellableProduct(api, {
    lineCode,
    listPricePen: options.listPricePen,
  });
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: lineCode,
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
        description: `Producto E2E de mostrador (${lineCode})`,
        qty: options.qty,
        unit: 'NIU',
        unitPrice: options.unitPrice ?? '5',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  return { sku: product.sku, id: product.id };
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

/** Etiquetas de línea de negocio tal como las pinta el `<Select>` (D-174, `BUSINESS_LINE_LABELS`). */
const LINE_LABEL: Record<string, string> = {
  drywall: 'Drywall',
  roofing: 'Coberturas (UPVC)',
  trading: 'Reventa',
};

test.describe('F8-S2b — huecos de cobertura', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-188: sin cotizaciones con faltante, la tarjeta del Panel no pinta nada (ni una vacía)', async ({
    page,
  }) => {
    // La base **no** está recién reseteada cuando corre la suite completa: el reset es uno por
    // corrida y los specs anteriores pueden dejar cotizaciones EMITTED con faltante (F8-S3 lo
    // vio dos veces, con cotizaciones distintas). Lo que este caso prueba es la pantalla con
    // una lista vacía, así que la respuesta vacía se fija con `page.route`; del API real solo se
    // comprueba que responde bien y con la forma esperada, para no confundir "no cargó" con
    // "cargó y no había nada".
    await page.route('**/api/sales/quotations/stock-shortages', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(adminCredentials().email);
    await page.getByLabel('Contraseña', { exact: true }).fill(adminCredentials().password);
    const shortagesResponse = page.waitForResponse((r) =>
      r.url().includes('/api/sales/quotations/stock-shortages'),
    );
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });

    const resp = await shortagesResponse;
    expect(await resp.json()).toEqual([]);
    const real = await page.request.get('/api/sales/quotations/stock-shortages');
    expect(real.ok(), await real.text()).toBe(true);
    expect(Array.isArray(await real.json())).toBe(true);

    await expect(page.getByRole('heading', { name: 'Panel', level: 1 })).toBeVisible();
    await expect(page.getByText('Cotizaciones sin stock disponible')).toHaveCount(0);
  });

  test('D-188: el picker de producto en una línea sin pool de bobinas muestra solo el disponible del SKU', async ({
    page,
  }) => {
    // Drywall, UPVC y Trading no tienen bobinas abiertas propias (D-116: el material físico
    // solo entra por Drywall o Metallic Roofing, y Trading/UPVC son compra-venta pura, D-091).
    // En una base recién vaciada eso alcanza para que `rawMaterial` venga vacío sin necesidad
    // de comprobar negativamente cada tabla — pero además ninguno de estos tres escenarios
    // compra una bobina, así que la ausencia del pool queda garantizada por el propio test.
    const customer = await createCustomer(api);
    await loginAsAdmin(page);

    for (const lineCode of ['drywall', 'roofing', 'trading']) {
      const product = await stockedProduct(api, lineCode, { qty: '12', listPricePen: '40.0000' });

      await page.goto('/cotizaciones/nueva');
      await chooseOption(
        page,
        page.getByLabel('Cliente', { exact: true }),
        `${customer.name} — ${customer.docNumber}`,
      );

      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: LINE_LABEL[lineCode], exact: true }).click();

      await page.getByLabel('Producto de la línea 1').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(`Elegir producto · ${LINE_LABEL[lineCode]}`)).toBeVisible();

      // Sin pool: ni el título de la sección, ni el "sin bobinas abiertas" que se ve cuando el
      // pool existe pero está vacío — la sección entera está ausente, no una versión vacía.
      await expect(dialog.getByText('Bobinas del pool (espesor + color)')).toHaveCount(0);
      await expect(
        dialog.getByText('No hay bobinas abiertas en esta línea de negocio.'),
      ).toHaveCount(0);

      await dialog.getByLabel('Filtrar productos').fill(product.sku);
      const row = dialog.getByRole('row', { name: new RegExp(product.sku) });
      await expect(row.getByText(/12\.\d+ u disponibles/)).toBeVisible({ timeout: 15_000 });

      await dialog.getByRole('button', { name: `Elegir ${product.sku}`, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByLabel('Producto de la línea 1')).toContainText(product.sku);
    }
  });

  test('D-188: el filtro del picker acota de verdad con más de un producto activo', async ({
    page,
  }) => {
    const customer = await createCustomer(api);
    const productA = await createSellableProduct(api, {
      lineCode: 'roofing',
      listPricePen: '15.0000',
    });
    const productB = await createSellableProduct(api, {
      lineCode: 'roofing',
      listPricePen: '22.0000',
    });

    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');
    await chooseOption(
      page,
      page.getByLabel('Cliente', { exact: true }),
      `${customer.name} — ${customer.docNumber}`,
    );
    await page.getByLabel('Línea de negocio de la línea 1').click();
    await page.getByRole('option', { name: LINE_LABEL.roofing, exact: true }).click();

    await page.getByLabel('Producto de la línea 1').click();
    const dialog = page.getByRole('dialog');

    // Sin filtrar, los dos conviven en la lista.
    await expect(dialog.getByRole('row', { name: new RegExp(productA.sku) })).toBeVisible();
    await expect(dialog.getByRole('row', { name: new RegExp(productB.sku) })).toBeVisible();
    const baseline = await dialog.getByText(/de \d+ productos/).textContent();
    const total = /de (\d+) productos/.exec(baseline ?? '')?.[1];
    expect(total, `no se pudo leer el total de "${baseline ?? ''}"`).toBeDefined();

    // Filtrar por el SKU de A: el de B desaparece de verdad, no solo "no se resalta".
    await dialog.getByLabel('Filtrar productos').fill(productA.sku);
    await expect(dialog.getByRole('row', { name: new RegExp(productA.sku) })).toBeVisible();
    await expect(dialog.getByRole('row', { name: new RegExp(productB.sku) })).toHaveCount(0);
    await expect(dialog.getByText(`1 de ${total} productos`)).toBeVisible();

    // Y al revés: filtrar por B saca a A de la lista.
    await dialog.getByLabel('Filtrar productos').fill(productB.sku);
    await expect(dialog.getByRole('row', { name: new RegExp(productB.sku) })).toBeVisible();
    await expect(dialog.getByRole('row', { name: new RegExp(productA.sku) })).toHaveCount(0);
    await expect(dialog.getByText(`1 de ${total} productos`)).toBeVisible();
  });

  test('D-187: cancelar el diálogo de precio o cantidad y reabrirlo en otra línea no arrastra lo tipeado', async ({
    page,
  }) => {
    const customer = await createCustomer(api);
    const productA = await stockedProduct(api, 'trading', { qty: '20', listPricePen: '25.0000' });
    const productB = await stockedProduct(api, 'trading', { qty: '20', listPricePen: '40.0000' });
    // Precio con IGV = valor × 1.18 (D-162); valores redondos para que el resultado tenga
    // exactamente dos decimales y no dependa de cómo `typedPriceOf` recorta ceros.
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: 'trading',
      items: [
        { productId: productA.id, qty: '5', unitPricePen: '20' }, // 23.60 con IGV
        { productId: productB.id, qty: '9', unitPricePen: '35' }, // 41.30 con IGV
      ],
    });
    try {
      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });

      // Precio: se tipea uno distinto en la línea 1, se cancela sin guardar, y la línea 2 tiene
      // que abrir con SU propio precio — no con el "999.99" que quedó sin guardar.
      await page.getByRole('button', { name: 'Cambiar precio de la línea 1' }).click();
      let dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel(/Precio con IGV/)).toHaveValue('23.60');
      await dialog.getByLabel(/Precio con IGV/).fill('999.99');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toBeHidden();

      await page.getByRole('button', { name: 'Cambiar precio de la línea 2' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel(/Precio con IGV/)).toHaveValue('41.30');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toBeHidden();

      // Misma pregunta para el diálogo de cantidad.
      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel(/Cantidad/)).toHaveValue('5.000');
      await dialog.getByLabel(/Cantidad/).fill('777');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toBeHidden();

      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 2' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel(/Cantidad/)).toHaveValue('9.000');
    } finally {
      await purgeSalesTrail(api, { orderIds: [order.id] });
    }
  });

  test('D-187: cancelar el diálogo de cantidad de una línea a medida y reabrirlo en otra no arrastra sus largos', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows1 = pieces([10, 1]); // 1 largo: 10 m × 1
      const rows2 = pieces([6, 1], [4, 1]); // 2 largos: 6 m × 1 y 4 m × 1
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        items: [
          { productId: s.product.id, qty: metersOf(rows1), unitPricePen: '60', pieces: rows1 },
          { productId: s.product.id, qty: metersOf(rows2), unitPricePen: '60', pieces: rows2 },
        ],
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${order.id}`);
      await expect(page.getByRole('heading', { name: order.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });

      // Línea 1 (un solo largo): se agrega una fila más y se llena, sin guardar.
      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 1' }).click();
      let dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Largo 1 en metros')).toHaveValue('10.000');
      await expect(dialog.getByLabel('Planchas del largo 1')).toHaveValue('1');
      await dialog.getByRole('button', { name: 'Agregar largo' }).click();
      await dialog.getByLabel('Planchas del largo 2').fill('9');
      await dialog.getByLabel('Largo 2 en metros').fill('8');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dialog).toBeHidden();

      // Línea 2 (dos largos propios): tiene que abrir con SUS dos filas, ni con la fila extra
      // que quedó armada en la línea 1, ni con solo una fila si el reseteo se quedó a medias.
      await page.getByRole('button', { name: 'Cambiar cantidad de la línea 2' }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: /Quitar el largo/ })).toHaveCount(2);
      await expect(dialog.getByLabel('Largo 1 en metros')).toHaveValue('6.000');
      await expect(dialog.getByLabel('Planchas del largo 1')).toHaveValue('1');
      await expect(dialog.getByLabel('Largo 2 en metros')).toHaveValue('4.000');
      await expect(dialog.getByLabel('Planchas del largo 2')).toHaveValue('1');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-188: un VENDEDOR también ve la tarjeta de cotizaciones sin stock disponible', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    const vendedor = await createUser(api, 'VENDEDOR');
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

      await loginAndSetPassword(page, vendedor, 'ClaveVendedorE2E-1!');
      await expect(page.getByText('Cotizaciones sin stock disponible')).toBeVisible({
        timeout: 30_000,
      });
      const row = page.getByRole('link', { name: new RegExp(quotation.code) });
      await expect(row).toBeVisible();
      await expect(row.getByText(/faltan 21\.200/)).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
