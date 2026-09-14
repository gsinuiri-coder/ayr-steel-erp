import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { putJson } from '../helpers/production';
import {
  metersOf,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import {
  createCustomer,
  createQuotation,
  isoDaysFromToday,
  stockPanel,
  updateQuotationBody,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';
import { chooseProductWithStock, headerAction } from '../helpers/ui';

/**
 * F8-S4/M0 — deudas de integridad.
 *
 * 1. «Agregar al borrador» de reportes (D-191) reclama una clave de idempotencia por intento
 *    (D-182): el mismo intento dos veces deja UNA fila; dos intentos con el mismo cuerpo, dos.
 * 2. La clave del cliente queda atada al **contenido** del envío: tras un corte de red, corregir
 *    las líneas y reintentar es otro envío y no puede devolver el resultado del primero.
 * 3. Editar una cotización que acorta su vigencia acorta la reserva temporal (D-185): nunca
 *    vence después que la cotización.
 *
 * Geometría: 4.04 kg por metro (ver `flujo-comercial-f8s2.spec.ts`).
 *
 * Escribe cotizaciones, pedidos, órdenes y borradores: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales y de planta: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface DraftDto {
  id: string;
  rowNumber: number;
  meters: string;
}

const draftsPath = (opId: string) => `/api/production/roofing/${opId}/drafts`;

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    productionOrderIds: [] as string[],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

/** Fin del día `YYYY-MM-DD` en Lima, como lo escribe el API. */
function endOfLimaDay(isoDate: string): string {
  return new Date(`${isoDate}T23:59:59.999-05:00`).toISOString();
}

async function availableKg(api: APIRequestContext, s: RoofingScenario): Promise<string> {
  const panel = await stockPanel(api, { businessLine: ROOFING_LINE, productIds: [s.product.id] });
  return panel.products.find((p) => p.productId === s.product.id)?.rawMaterialAvailableKg ?? '';
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('F8-S4/M0 — deudas de integridad', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. Agregar al borrador con clave de idempotencia (API)
  // -------------------------------------------------------------------------

  test('agregar al borrador dos veces con la misma clave —en paralelo y en serie— deja una sola fila', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '2000' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      // Plan: 10 × 4 m = 40 m.
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [{ productId: s.product.id, rows: pieces([4, 10]) }],
      });
      trail.quotationIds.push(quotation.id);
      trail.orderIds.push(order.id);
      const opId = order.reservations[0]!.productionOrderId!;
      trail.productionOrderIds.push(opId);
      await mountCoil(api, opId, { coilId: s.coil.id });

      // El mismo intento disparado dos veces a la vez (doble click): antes de F8-S4/M0 el API
      // descartaba la clave y cada POST agregaba su fila.
      const idempotencyKey = randomUUID();
      const body = { pieces: pieces([4, 2]), idempotencyKey };
      const [a, b] = await Promise.all([
        api.post(draftsPath(opId), { data: body }),
        api.post(draftsPath(opId), { data: body }),
      ]);
      expect(a.ok(), await a.text()).toBe(true);
      expect(b.ok(), 'el segundo es el mismo intento, no un error').toBe(true);
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toHaveLength(1);

      // Y el reintento en serie (la red cortó después del commit) tampoco agrega.
      const retried = await postJson<DraftDto[]>(api, draftsPath(opId), body);
      expect(retried, 'el reintento devuelve el borrador tal como quedó').toHaveLength(1);
      expect(retried[0]!.meters).toBe('8.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('agregar al borrador el mismo cuerpo con claves distintas deja dos filas: son dos hechos', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '2000' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [{ productId: s.product.id, rows: pieces([4, 10]) }],
      });
      trail.quotationIds.push(quotation.id);
      trail.orderIds.push(order.id);
      const opId = order.reservations[0]!.productionOrderId!;
      trail.productionOrderIds.push(opId);
      await mountCoil(api, opId, { coilId: s.coil.id });

      const rows = pieces([4, 2]);
      await postJson(api, draftsPath(opId), { pieces: rows, idempotencyKey: randomUUID() });
      const drafts = await postJson<DraftDto[]>(api, draftsPath(opId), {
        pieces: rows,
        idempotencyKey: randomUUID(),
      });
      expect(drafts.map((d) => [d.rowNumber, d.meters])).toEqual([
        [1, '8.000'],
        [2, '8.000'],
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 2. La clave del cliente va atada al contenido (UI de «Agregar ítems»)
  // -------------------------------------------------------------------------

  /**
   * Pedido confirmado de una línea (10 m) y el formulario «Agregar ítems» abierto con una
   * plancha de 10 m cargada. El primer POST a `/items` llega al servidor y graba, pero su
   * respuesta se pierde (corte de red después del commit).
   */
  async function openAddItemsWithLostResponse(
    page: Page,
    s: RoofingScenario,
    trail: ReturnType<typeof trailOf>,
  ) {
    const customer = await createCustomer(api);
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
    const order = await postJson<SalesOrderDto>(
      api,
      `/api/sales/quotations/${quotation.id}/confirm`,
    );
    trail.orderIds.push(order.id);

    const posts: string[] = [];
    await page.route(`**/api/sales/orders/${order.id}/items`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey);
      if (posts.length === 1) {
        // Llega al servidor y graba; el navegador nunca ve la respuesta.
        const res = await route.fetch();
        expect(res.ok(), 'el primer envío tiene que grabar en el servidor').toBe(true);
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });

    await loginAsAdmin(page);
    await page.goto(`/pedidos/${order.id}`);
    await (await headerAction(page, 'Agregar ítems')).click();
    await expect(page.getByRole('heading', { name: `Agregar ítems a ${order.code}` })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByLabel('Línea de negocio de la línea 1').click();
    await page.getByRole('option', { name: 'Coberturas Aluzinc' }).click();
    await chooseProductWithStock(page, page.getByLabel('Producto de la línea 1'), s.product.sku);
    await page.getByLabel('Planchas del largo 1 de la línea 1').fill('1');
    await page.getByLabel('Largo 1 de la línea 1 en metros').fill('10');
    await page.getByLabel('Precio unitario de la línea 1').fill('70.80');

    await page.getByRole('button', { name: 'Agregar ítems' }).click();
    // El formulario se queda con el error genérico: no sabe si el servidor grabó.
    await expect(page.getByText('No se pudo guardar')).toBeVisible({ timeout: 30_000 });
    expect(posts).toHaveLength(1);

    return { order, posts };
  }

  test('tras un corte de red, corregir las líneas y reenviar agrega la corrección además del primer envío', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const trail = trailOf(s);
    try {
      const { order, posts } = await openAddItemsWithLostResponse(page, s, trail);
      expect(
        (await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`)).items,
      ).toHaveLength(2);

      // El usuario corrige: dos planchas en vez de una. Es otro envío, con otra clave.
      await page.getByLabel('Planchas del largo 1 de la línea 1').fill('2');
      await page.getByRole('button', { name: 'Agregar ítems' }).click();
      await expect(page).toHaveURL(new RegExp(`/pedidos/${order.id}$`), { timeout: 30_000 });

      expect(posts).toHaveLength(2);
      expect(posts[1], 'el contenido cambió: la clave se renueva').not.toBe(posts[0]);

      // Antes de F8-S4/M0 el segundo reusaba la clave, el servidor devolvía el primer resultado
      // y la corrección se perdía en silencio: el pedido quedaba con 2 ítems.
      const detail = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(detail.items.map((i) => [i.lineNumber, i.qty])).toEqual([
        [1, '10.000'],
        [2, '10.000'],
        [3, '20.000'],
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('tras un corte de red, reenviar sin cambiar nada no duplica los ítems', async ({ page }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const trail = trailOf(s);
    try {
      const { order, posts } = await openAddItemsWithLostResponse(page, s, trail);

      // Mismo contenido: es el mismo intento y viaja con la misma clave.
      await page.getByRole('button', { name: 'Agregar ítems' }).click();
      await expect(page).toHaveURL(new RegExp(`/pedidos/${order.id}$`), { timeout: 30_000 });

      expect(posts).toHaveLength(2);
      expect(posts[1], 'el contenido no cambió: la clave es la misma').toBe(posts[0]);
      const detail = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(detail.items.map((i) => [i.lineNumber, i.qty])).toEqual([
        [1, '10.000'],
        [2, '10.000'],
      ]);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Acortar la vigencia acorta la reserva temporal (API)
  // -------------------------------------------------------------------------

  test('editar una cotización acortando su vigencia deja la reserva temporal venciendo al fin de esa vigencia', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
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
        validityDays: 30,
      });
      trail.quotationIds.push(quotation.id);
      const reserved = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/reserve`,
      );
      const byBusinessDays = reserved.temporaryReservation!.expiresAt;
      expect(await availableKg(api, s)).toBe('59.600');

      // Emitida ayer con un día de vigencia: vence hoy. Cualquier plazo en días hábiles (≥ 1)
      // termina después, así que el recorte es seguro sin importar la configuración.
      const edited = await putJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          issueDate: isoDaysFromToday(-1),
          validityDays: 1,
          items: [
            { productId: s.product.id, qty: metersOf(rows), unitPricePen: '60', pieces: rows },
          ],
        }),
      );
      expect(edited.status).toBe('EMITTED');
      expect(edited.validUntil).toBe(isoDaysFromToday(0));
      const expected = endOfLimaDay(edited.validUntil);
      expect(Date.parse(expected)).toBeLessThan(Date.parse(byBusinessDays));

      // Antes de F8-S4/M0 las líneas iguales cortaban el recálculo y la reserva seguía venciendo
      // a los días hábiles, después que la cotización.
      expect(edited.temporaryReservation?.expiresAt).toBe(expected);
      expect(edited.temporaryReservation?.lines).toEqual([
        expect.objectContaining({ lineNumber: 1, qty: '40.400' }),
      ]);
      // Sigue vigente y apartando lo mismo, no el doble ni nada.
      expect(await availableKg(api, s)).toBe('59.600');
      const listed = await getJson<{ quotationId: string; expiresAt: string }[]>(
        api,
        '/api/sales/temporary-reservations',
      );
      expect(listed.find((r) => r.quotationId === quotation.id)?.expiresAt).toBe(expected);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('editar una cotización sin acortar la vigencia por debajo del vencimiento no toca la reserva temporal', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
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
        validityDays: 30,
      });
      trail.quotationIds.push(quotation.id);
      const reserved = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/reserve`,
      );
      const expiresAt = reserved.temporaryReservation!.expiresAt;

      // La vigencia baja de 30 a 20 días y sube a 60, con un cambio de precio: en ningún caso
      // termina antes que la reserva, así que el vencimiento queda como estaba.
      for (const validityDays of [20, 60]) {
        const edited = await putJson<QuotationDto>(
          api,
          `/api/sales/quotations/${quotation.id}`,
          updateQuotationBody({
            customerId: customer.id,
            validityDays,
            items: [
              { productId: s.product.id, qty: metersOf(rows), unitPricePen: '65', pieces: rows },
            ],
          }),
        );
        expect(edited.validUntil).toBe(isoDaysFromToday(validityDays));
        expect(edited.temporaryReservation?.expiresAt, `vigencia de ${validityDays} días`).toBe(
          expiresAt,
        );
      }
      expect(await availableKg(api, s)).toBe('59.600');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});
