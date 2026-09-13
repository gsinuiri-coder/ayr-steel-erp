import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { headerAction } from '../helpers/ui';
import { expireTemporaryReservationsNow } from '../helpers/db';
import { postExpectingError, putExpectingError, putJson } from '../helpers/production';
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
  updateQuotationBody,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * F8-S2 — el flujo comercial nuevo (D-184, D-185, D-186).
 *
 * La geometría de prueba (acabado de densidad 8.0, 1 000 mm de ancho, 0.50 mm) da 4 kg/m, y
 * D-165 los lleva a 4.04 kg/m con el 1 % de merma normal adentro. Una línea de 10 m son
 * 40.400 kg del agregado.
 *
 * Escribe cotizaciones, reservas, pedidos y órdenes: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 180_000 });

interface ConfirmPreview {
  temporaryReservationExpiresAt: string | null;
  lines: {
    lineNumber: number;
    action: 'PRODUCE' | 'RESERVE_STOCK' | 'NONE';
    reserveQty: string | null;
    availableQty: string | null;
    shortfallQty: string | null;
    plan: string | null;
  }[];
  blockers: string[];
}

interface TemporaryListItem {
  quotationId: string;
  lines: { qty: string }[];
}

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

test.describe('F8-S2 — reserva temporal y confirmar en un paso', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-185: reservar descuenta disponible como una firme; liberar lo devuelve', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 2]); // 20 m ⇒ 80.800 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.status).toBe('EMITTED');
      expect(quotation.temporaryReservation).toBeNull();
      expect(await availableKg(api, s)).toBe('100.000');

      const reserved = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/reserve`,
      );
      expect(reserved.temporaryReservation).not.toBeNull();
      expect(reserved.temporaryReservation!.lines).toEqual([
        expect.objectContaining({
          lineNumber: 1,
          itemType: 'RAW_MATERIAL',
          qty: '80.800',
          unit: 'KGM',
        }),
      ]);
      // Vence en el futuro: al menos un día hábil.
      expect(Date.parse(reserved.temporaryReservation!.expiresAt)).toBeGreaterThan(Date.now());
      // Descuenta igual que una firme.
      expect(await availableKg(api, s)).toBe('19.200');

      // Una segunda reserva sobre la misma cotización no se apila.
      const twice = await postExpectingError(api, `/api/sales/quotations/${quotation.id}/reserve`);
      expect(twice.status).toBe(409);

      // Otra cotización que necesita más de lo que quedó choca con el guardrail de siempre, y
      // el mensaje nombra la temporal que tiene el material.
      const rivalRows = pieces([10, 1]); // 40.400 kg > 19.200
      const rival = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rivalRows),
        unitPricePen: '60',
        pieces: rivalRows,
      });
      trail.quotationIds.push(rival.id);
      const rivalReserve = await postExpectingError(
        api,
        `/api/sales/quotations/${rival.id}/reserve`,
      );
      expect(rivalReserve.status).toBe(400);
      expect(rivalReserve.message).toContain('19.200');

      // Aparece en la vista de vigentes.
      const listed = await getJson<TemporaryListItem[]>(api, '/api/sales/temporary-reservations');
      expect(listed.find((r) => r.quotationId === quotation.id)?.lines).toEqual([
        expect.objectContaining({ qty: '80.800' }),
      ]);

      // Liberar exige motivo y devuelve el material.
      const noReason = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/release-reservation`,
        { reason: '' },
      );
      expect(noReason.status).toBe(400);
      const released = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/release-reservation`,
        { reason: 'El cliente no depositó' },
      );
      expect(released.temporaryReservation).toBeNull();
      expect(released.status).toBe('EMITTED');
      expect(await availableKg(api, s)).toBe('100.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-185: una reserva vencida cuenta como liberada sin que nadie la marque', async () => {
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
      await postJson(api, `/api/sales/quotations/${quotation.id}/reserve`);
      expect(await availableKg(api, s)).toBe('19.200');

      // El reloj pasa el vencimiento. No hay job: la próxima lectura ya no la cuenta.
      expect(await expireTemporaryReservationsNow(quotation.id)).toBe(1);
      expect(await availableKg(api, s)).toBe('100.000');
      const detail = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(detail.temporaryReservation).toBeNull();
      const listed = await getJson<TemporaryListItem[]>(api, '/api/sales/temporary-reservations');
      expect(listed.some((r) => r.quotationId === quotation.id)).toBe(false);

      // Y la cotización se puede volver a reservar.
      const again = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/reserve`,
      );
      expect(again.temporaryReservation?.lines[0]?.qty).toBe('80.800');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-185: editar con reserva la recalcula, y si no alcanza la edición entera se deshace', async () => {
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
      });
      trail.quotationIds.push(quotation.id);
      const reserved = await postJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}/reserve`,
      );
      const expiresAt = reserved.temporaryReservation!.expiresAt;

      // Crece a 20 m (80.800 kg): alcanza, se recalcula con el mismo vencimiento.
      const grownRows = pieces([10, 2]);
      const grown = await putJson<QuotationDto>(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            {
              productId: s.product.id,
              qty: metersOf(grownRows),
              unitPricePen: '60',
              pieces: grownRows,
            },
          ],
        }),
      );
      expect(grown.temporaryReservation?.lines[0]?.qty).toBe('80.800');
      expect(grown.temporaryReservation?.expiresAt).toBe(expiresAt);
      expect(await availableKg(api, s)).toBe('19.200');

      // Crece a 30 m (121.200 kg): no alcanza. Se rechaza y **nada** cambia — ni las líneas ni
      // la reserva: nunca se libera en silencio ni se reserva de más sin validar.
      const tooMuchRows = pieces([10, 3]);
      const rejected = await putExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}`,
        updateQuotationBody({
          customerId: customer.id,
          items: [
            {
              productId: s.product.id,
              qty: metersOf(tooMuchRows),
              unitPricePen: '60',
              pieces: tooMuchRows,
            },
          ],
        }),
      );
      expect(rejected.status).toBe(400);
      const unchanged = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(unchanged.items[0]?.qty).toBe('20.000');
      expect(unchanged.temporaryReservation?.lines[0]?.qty).toBe('80.800');
      expect(await availableKg(api, s)).toBe('19.200');

      // Anular la cotización suelta el material.
      await postJson(api, `/api/sales/quotations/${quotation.id}/cancel`, {
        reason: 'Prueba de anulación con reserva',
      });
      expect(await availableKg(api, s)).toBe('100.000');
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-186: la vista previa dice qué va a pasar y bloquea con el faltante; confirmar convierte la temporal y deja la OP en cola', async () => {
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

      // Un rival toma 40.400 kg: a esta le faltan 21.200.
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

      const blocked = await getJson<ConfirmPreview>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm-preview`,
      );
      expect(blocked.lines[0]).toMatchObject({
        action: 'PRODUCE',
        reserveQty: '80.800',
        availableQty: '59.600',
        shortfallQty: '21.200',
        plan: '2 × 10.00 m',
      });
      expect(blocked.blockers.join(' ')).toContain('faltan 21.200');
      // Confirmar bloquea igual que la vista previa lo dijo.
      const cannotConfirm = await postExpectingError(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(cannotConfirm.status).toBe(400);

      // Se libera el rival y la propia reserva: la vista previa ya no bloquea y cuenta la
      // temporal propia como suya.
      await postJson(api, `/api/sales/quotations/${rival.id}/release-reservation`, {
        reason: 'El rival no depositó',
      });
      await postJson(api, `/api/sales/quotations/${quotation.id}/reserve`);
      const ready = await getJson<ConfirmPreview>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm-preview`,
      );
      expect(ready.blockers).toEqual([]);
      expect(ready.temporaryReservationExpiresAt).not.toBeNull();
      expect(ready.lines[0]).toMatchObject({ availableQty: '100.000', shortfallQty: null });

      // Confirmar: pedido + reserva firme + OP, en un paso. La temporal se convierte: el
      // disponible no se descuenta dos veces.
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      trail.orderIds.push(order.id);
      expect(order.status).toBe('CONFIRMED');
      expect(await availableKg(api, s)).toBe('19.200');
      const reservations = await reservationsOf(api, order.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({ status: 'ACTIVE', qty: '80.800' });
      expect(reservations[0]!.productionOrderId, 'confirmar deja la OP en cola').not.toBeNull();

      const detail = await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`);
      expect(detail.status).toBe('CONFIRMED');
      expect(detail.temporaryReservation).toBeNull();
      const listed = await getJson<TemporaryListItem[]>(api, '/api/sales/temporary-reservations');
      expect(listed.some((r) => r.quotationId === quotation.id)).toBe(false);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-186: confirmar desde la pantalla es un clic después de ver la vista previa', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 2]);
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
      await page.goto(`/cotizaciones/${quotation.id}`);
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible({
        timeout: 60_000,
      });

      // Reservar desde la pantalla deja la sección con el material apartado.
      await (await headerAction(page, 'Reservar')).click();
      await expect(page.getByText('Reserva temporal', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Reserva MP y genera OP')).toBeVisible();
      await expect(dialog.getByText('2 × 10.00 m')).toBeVisible();
      await expect(dialog.getByText('se convierte en firme')).toBeVisible();

      await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
      await expect(page).toHaveURL(/\/pedidos\/[0-9a-f-]+$/, { timeout: 30_000 });
      const orderId = page.url().split('/').pop()!;
      trail.orderIds.push(orderId);
      const reservations = await reservationsOf(api, orderId);
      expect(reservations[0]?.productionOrderId).not.toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}
