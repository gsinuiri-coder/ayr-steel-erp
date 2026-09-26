import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems, getJson, postJson } from '../helpers/api';
import { postExpectingError, today, type ProductionOrderDto } from '../helpers/production';
import { headerAction } from '../helpers/ui';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';

/**
 * D-328 — el film de protección de la bobina.
 *
 * Lo que protege: el film es un eje **aparte** del estado (`OPEN`/`CLOSED`), su historial es de
 * eventos —no un campo que se sobrescribe— y los eventos automáticos solo se deshacen cuando
 * corresponde: bajar de la OP o cancelar el envío la vuelve a sellar **si nada salió de ella**;
 * revertir un partido, no.
 *
 * Todo bobina que crea un escenario de E2E nace sellada (la compra ya no la crea «cerrada»).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

interface FilmCoil {
  id: string;
  code: string;
  status: string;
  film: 'SEALED' | 'OPENED';
  widthMm: string;
  availableKg: string;
}

interface FilmEvent {
  type: 'OPENED' | 'RESEALED';
  source: string;
  operationDate: string;
  reason: string | null;
}

const coilOf = (api: APIRequestContext, id: string) => getJson<FilmCoil>(api, `/api/coils/${id}`);
const eventsOf = (api: APIRequestContext, id: string) =>
  getJson<FilmEvent[]>(api, `/api/coils/${id}/film-events`);

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

function trailOf(scenario: RoofingScenario): Parameters<typeof purgeRoofingTrail>[1] {
  return {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
  };
}

test.describe('D-328 — film de protección', () => {
  test('una bobina comprada nace sellada; abrir y volver a sellar quedan en el historial sin tocar estado ni kardex', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
    const id = scenario.coil.id;
    try {
      const born = await coilOf(api, id);
      expect(born).toMatchObject({ status: 'OPEN', film: 'SEALED' });
      expect(await eventsOf(api, id)).toHaveLength(0);

      // El filtro de la lista distingue selladas de abiertas.
      const sealedList = await getItems<{ id: string }>(
        api,
        `/api/coils?film=SEALED&supplierId=${scenario.supplier.id}`,
      );
      expect(sealedList.map((c) => c.id)).toContain(id);
      const openedList = await getItems<{ id: string }>(
        api,
        `/api/coils?film=OPENED&supplierId=${scenario.supplier.id}`,
      );
      expect(openedList.map((c) => c.id)).not.toContain(id);

      const opened = await postJson<FilmCoil>(api, `/api/coils/${id}/film/open`, {
        reason: 'para la corrida de mañana',
      });
      expect(opened).toMatchObject({ status: 'OPEN', film: 'OPENED' });
      // Abrir dos veces no es un no-op silencioso.
      const again = await postExpectingError(api, `/api/coils/${id}/film/open`, {});
      expect(again.status).toBe(409);

      const resealed = await postJson<FilmCoil>(api, `/api/coils/${id}/film/reseal`, {
        reason: 'se abrió por error',
      });
      expect(resealed).toMatchObject({ status: 'OPEN', film: 'SEALED' });
      const twice = await postExpectingError(api, `/api/coils/${id}/film/reseal`, {});
      expect(twice.status).toBe(400);
      expect(twice.message).toContain('ya está sellada');

      // Historial append-only: dos eventos, el más reciente primero, con su fecha y su motivo.
      const events = await eventsOf(api, id);
      expect(events.map((e) => [e.type, e.source])).toEqual([
        ['RESEALED', 'MANUAL'],
        ['OPENED', 'MANUAL'],
      ]);
      expect(events[1]).toMatchObject({
        operationDate: today(),
        reason: 'para la corrida de mañana',
      });

      // Ninguna de las dos toca el kardex: sigue la entrada de la compra y nada más.
      const movements = await getItems<{ id: string }>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${id}`,
      );
      expect(movements).toHaveLength(1);
    } finally {
      await purgeRoofingTrail(api, trailOf(scenario));
      await api.dispose();
    }
  });

  test('la fecha de un evento manual no puede ser anterior al último del film: la ficha, el historial y el reporte no se contradicen', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const id = scenario.coil.id;
    try {
      await postJson(api, `/api/coils/${id}/film/open`, {});
      await postJson(api, `/api/coils/${id}/film/reseal`, {});
      // Abrir con fecha de agosto (retroactivo, solo ADMINISTRADOR) quedaría detrás del «volver a
      // sellar» de hoy en el orden por fecha: se rechaza en vez de decir que abrió y no hacerlo.
      const early = await postExpectingError(api, `/api/coils/${id}/film/open`, {
        operationDate: '2026-08-20',
      });
      expect(early.status).toBe(400);
      expect(early.message).toContain('no puede ser anterior');
      expect((await coilOf(api, id)).film).toBe('SEALED');
      expect(await eventsOf(api, id)).toHaveLength(2);
    } finally {
      await purgeRoofingTrail(api, trailOf(scenario));
      await api.dispose();
    }
  });

  test('la merma abre; con la merma viva no se puede volver a sellar (el error la nombra); anulada, sí; partir abre y su reversa no resella', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '1000' });
    const id = scenario.coil.id;
    try {
      await postJson(api, `/api/coils/${id}/scrap`, { qtyKg: '10', reason: 'borde oxidado' });
      expect(await coilOf(api, id)).toMatchObject({ status: 'OPEN', film: 'OPENED' });
      expect((await eventsOf(api, id))[0]).toMatchObject({ type: 'OPENED', source: 'SCRAP' });

      const blocked = await postExpectingError(api, `/api/coils/${id}/film/reseal`, {});
      expect(blocked.status).toBe(400);
      expect(blocked.message).toMatch(/una merma del \d{4}-\d{2}-\d{2}/);
      expect((await coilOf(api, id)).film).toBe('OPENED');

      // Anulada la merma, ya no hay salida viva: se puede volver a sellar.
      const movements = await getItems<{ id: string; refType: string }>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${id}`,
      );
      const scrap = movements.find((m) => m.refType === 'SCRAP')!;
      await postJson(api, `/api/coils/scraps/${scrap.id}/cancel`, { reason: 'merma mal cargada' });
      const resealed = await postJson<FilmCoil>(api, `/api/coils/${id}/film/reseal`, {});
      expect(resealed.film).toBe('SEALED');

      // Partir una bobina sellada la abre; las hijas nacen abiertas y no se pueden resellar.
      const width = Number((await coilOf(api, id)).widthMm);
      const half = String(Math.floor(width / 2) - 10);
      const children = await postJson<FilmCoil[]>(api, `/api/coils/${id}/split`, {
        kerfLossMm: '0',
        children: [
          { widthMm: half, count: 1 },
          { widthMm: half, count: 1 },
        ],
      });
      expect(children).toHaveLength(2);
      expect(children.every((c) => c.film === 'OPENED')).toBe(true);
      expect((await eventsOf(api, children[0]!.id))[0]).toMatchObject({
        type: 'OPENED',
        source: 'BIRTH',
      });
      const childBlocked = await postExpectingError(
        api,
        `/api/coils/${children[0]!.id}/film/reseal`,
        {},
      );
      expect(childBlocked.message).toContain('nació abierta');
      expect((await eventsOf(api, id))[0]).toMatchObject({ type: 'OPENED', source: 'SPLIT' });

      // Revertir el partido NO vuelve a sellar la madre: cortó, el film ya no está.
      const splits = await getJson<{ id: string }[]>(api, `/api/coils/${id}/splits`);
      await postJson(api, `/api/coils/splits/${splits[0]!.id}/revert`, {
        reason: 'partido de prueba',
      });
      expect(await coilOf(api, id)).toMatchObject({ film: 'OPENED', status: 'OPEN' });
    } finally {
      await purgeRoofingTrail(api, trailOf(scenario));
      await api.dispose();
    }
  });

  test('montar abre la bobina; bajarla sin reportes la vuelve a sellar; si se abrió a mano antes, sigue abierta', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '1500' });
    const customer = await createCustomer(api);
    const { quotation, order } = await quoteAndOrderLines(api, {
      customerId: customer.id,
      lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
    });
    const opId = order.reservations[0]!.productionOrderId!;
    const trail = {
      ...trailOf(scenario),
      productionOrderIds: [opId],
      orderIds: [order.id],
      quotationIds: [quotation.id],
    };
    const id = scenario.coil.id;
    try {
      expect((await coilOf(api, id)).film).toBe('SEALED');
      const mounted = await mountCoil(api, opId, { coilId: id });
      expect((await coilOf(api, id)).film).toBe('OPENED');
      expect((await eventsOf(api, id))[0]).toMatchObject({ type: 'OPENED', source: 'MOUNT' });

      // Sigue montada: no se puede volver a sellar y el error nombra la OP.
      const held = await postExpectingError(api, `/api/coils/${id}/film/reseal`, {});
      expect(held.message).toContain('está montada en');

      const consumption = mounted.consumptions.find((c) => c.releasedAt === null)!;
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/coils/${consumption.id}/release`,
      );
      expect(await coilOf(api, id)).toMatchObject({ film: 'SEALED', status: 'OPEN' });
      expect((await eventsOf(api, id))[0]).toMatchObject({
        type: 'RESEALED',
        source: 'MOUNT_UNDO',
      });

      // Abierta a mano ANTES de montar: bajarla no la vuelve a sellar (la abrió una persona).
      await postJson(api, `/api/coils/${id}/film/open`, { reason: 'la abrí yo' });
      const remounted = await mountCoil(api, opId, { coilId: id });
      const live = remounted.consumptions.find((c) => c.releasedAt === null)!;
      await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${opId}/coils/${live.id}/release`,
      );
      expect((await coilOf(api, id)).film).toBe('OPENED');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('el reporte mensual reparte selladas y abiertas; la terminada con saldo 0 va a «Abiertas»; el total es la suma', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '800' });
    const id = scenario.coil.id;
    const month = today().slice(0, 7);
    type Section = { rows: { id: string; closingKg: string; status: string }[]; totals: Totals };
    type Totals = { closingKg: string; closingValuePen: string | null };
    type Report = { sealed: Section; opened: Section; totals: Totals };
    const report = () => getJson<Report>(api, `/api/reports/coils?month=${month}`);
    const where = (r: Report) => ({
      sealed: r.sealed.rows.some((x) => x.id === id),
      opened: r.opened.rows.some((x) => x.id === id),
    });
    try {
      // Sellada al final del mes: solo en «Selladas».
      const before = await report();
      expect(where(before)).toEqual({ sealed: true, opened: false });

      // Abierta: pasa a «Abiertas» con su saldo.
      await postJson(api, `/api/coils/${id}/film/open`, {});
      const afterOpen = await report();
      expect(where(afterOpen)).toEqual({ sealed: false, opened: true });
      expect(afterOpen.opened.rows.find((r) => r.id === id)!.closingKg).toBe('800.000');

      // Vuelta a sellar: otra vez «Selladas».
      await postJson(api, `/api/coils/${id}/film/reseal`, {});
      expect(where(await report())).toEqual({ sealed: true, opened: false });

      // Terminada con saldo 0 (se declara que no queda nada): «Abiertas», con 0 kg.
      await postJson(api, `/api/coils/${id}/status`, {
        status: 'CLOSED',
        physicalKg: '0.000',
        reason: 'Liquidación de prueba E2E',
      });
      const finished = await report();
      expect(where(finished)).toEqual({ sealed: false, opened: true });
      expect(finished.opened.rows.find((r) => r.id === id)).toMatchObject({
        closingKg: '0.000',
        status: 'CLOSED',
      });

      // El total general es la suma exacta de las dos tablas (kg y valor).
      const sum = (a: string, b: string) => (Number(a) + Number(b)).toFixed(3);
      expect(finished.totals.closingKg).toBe(
        sum(finished.sealed.totals.closingKg, finished.opened.totals.closingKg),
      );
      expect(finished.totals.closingValuePen).not.toBeNull();
    } finally {
      await purgeRoofingTrail(api, trailOf(scenario));
      await api.dispose();
    }
  });

  test('por pantalla: «Abrir bobina» y «Volver a sellar» desde el detalle, con historial; la lista y el reporte dicen Sellada/Abierta', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '600' });
    const { id, code } = scenario.coil;
    try {
      await loginAsAdmin(page);
      await page.goto(`/bobinas/${id}`);
      await expect(page.getByRole('heading', { name: code })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('Sellada', { exact: true }).first()).toBeVisible();

      // Abrir: diálogo, motivo opcional, confirmar.
      await (await headerAction(page, 'Abrir bobina')).click();
      const dialog = page.getByRole('dialog').filter({ hasText: `Abrir ${code}` });
      await dialog.getByLabel('Motivo (opcional)').fill('para la corrida');
      await dialog.getByRole('button', { name: 'Abrir bobina' }).click();
      await expect(page.getByText('Bobina abierta')).toBeVisible();
      await expect(page.getByText('Abierta', { exact: true }).first()).toBeVisible();

      // El historial lo muestra.
      const history = page.getByRole('region', { name: 'Film de protección' });
      await expect(history).toContainText('para la corrida');
      await expect(history).toContainText('Manual');

      // La lista la rotula «Abierta» y el filtro «Solo abiertas» la trae.
      await page.goto(`/bobinas?tab=disponibles&film=OPENED&search=${code}`);
      await expect(page.getByRole('row').filter({ hasText: code })).toContainText('Abierta');

      // Volver a sellar desde el detalle.
      await page.goto(`/bobinas/${id}`);
      await (await headerAction(page, 'Volver a sellar')).click();
      const back = page.getByRole('dialog').filter({ hasText: `Volver a sellar ${code}` });
      await back.getByRole('button', { name: 'Volver a sellar' }).click();
      await expect(page.getByText('Bobina vuelta a sellar')).toBeVisible();

      // El reporte mensual: dos tablas con subtotal.
      await page.goto('/reportes/bobinas');
      await expect(page.getByRole('heading', { name: 'Reporte mensual de bobinas' })).toBeVisible();
      const sealedTable = page.getByRole('region', { name: 'Bobinas selladas' });
      await expect(sealedTable).toContainText('Subtotal Selladas');
      await expect(sealedTable.getByRole('row').filter({ hasText: code })).toContainText('Sellada');
      await expect(page.getByRole('region', { name: 'Bobinas abiertas' })).toContainText(
        'Subtotal Abiertas',
      );
    } finally {
      await purgeRoofingTrail(api, trailOf(scenario));
      await api.dispose();
    }
  });
});
