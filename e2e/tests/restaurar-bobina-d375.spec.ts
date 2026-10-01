import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, type CoilDto, type CoilRestorePlanDto } from '@ayr/shared';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import { setCoilCancelledForTest } from '../helpers/db';
import { DISPATCH_LINE } from '../helpers/invoicing';
import { apiAs, movementsOf, today, type MovementDto } from '../helpers/production';
import { setupCoilStock } from '../helpers/sales';

/**
 * D-375 — restaurar una bobina anulada que vino de una compra.
 *
 * Misma bobina, entrada append-only. El modo lo decide el clasificador: en su fecha si no
 * recostea ninguna salida, a hoy si no; bloqueada con salidas vivas. Una bobina restaurada a
 * hoy no admite producción con fecha anterior a su entrada.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Compra, anula y restaura bobinas: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

const RECEIVED_DAYS_AGO = 5;

const liveOf = (ms: MovementDto[]) =>
  ms.filter((m) => m.reversalOfId === null && m.reversedById === null);

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

async function cancelledCoil(api: APIRequestContext, unitPrice = '5'): Promise<CoilDto> {
  const { coil } = await setupCoilStock(api, {
    lineCode: DISPATCH_LINE,
    weightKg: '1000',
    unitPrice,
    receivedOn: addDays(today(), -RECEIVED_DAYS_AGO),
  });
  return coil;
}

test.describe('D-375 — restaurar bobina anulada de compra', () => {
  let api: APIRequestContext;
  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('anular → restaurar en su fecha desde el menú de la fila; stock y kardex cuadran', async ({
    page,
  }) => {
    const coil = await cancelledCoil(api);
    const receivedOn = addDays(today(), -RECEIVED_DAYS_AGO);
    await postJson(api, `/api/coils/${coil.id}/cancel`, {
      reason: 'Anulada por error (E2E D-375)',
    });

    const plan = await getJson<CoilRestorePlanDto>(api, `/api/coils/${coil.id}/restore-plan`);
    // D-375 (revisión cc08): la entrada va en la fecha de la anulación (hoy), no en la del ingreso.
    expect(plan).toMatchObject({
      mode: 'EN_SU_FECHA',
      date: today(),
      originalDate: receivedOn,
      qty: '1000.000',
    });

    await loginAsAdmin(page);
    await page.goto(`/bobinas?tab=todas&status=CANCELLED&search=${encodeURIComponent(coil.code)}`);
    await page.getByRole('button', { name: `Más acciones de ${coil.code}` }).click();
    await page.getByRole('menuitem', { name: 'Restaurar' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('restore-coil-plan')).toContainText('En su fecha');
    const confirm = dialog.getByRole('button', { name: 'Restaurar' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Motivo').fill('Se anuló por error (E2E)');
    await confirm.click();
    await expect(page.getByText(`${coil.code} restaurada`)).toBeVisible({ timeout: 30_000 });

    const after = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
    expect(after.id).toBe(coil.id);
    expect(after.code).toBe(coil.code);
    expect(after.status).toBe('OPEN');
    expect(after.availableKg).toBe('1000.000');
    expect(after.avgCostPen).toBe(coil.avgCostPen);

    const live = liveOf(await movementsOf(api, 'COIL', coil.id));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ type: 'IN', refType: 'PURCHASE', operationDate: today() });

    const audit = await getJson<{ items: { action: string; after: Record<string, unknown> }[] }>(
      api,
      `/api/audit?entityType=coils&entityId=${coil.id}&from=${addDays(today(), -1)}&to=${addDays(today(), 1)}`,
    );
    const restored = audit.items.find((e) => e.action === 'coils.restore');
    expect(restored?.after).toMatchObject({
      mode: 'EN_SU_FECHA',
      date: today(),
      originalDate: receivedOn,
    });
  });

  test('restaurar dos veces se rechaza', async () => {
    const coil = await cancelledCoil(api);
    await postJson(api, `/api/coils/${coil.id}/cancel`, { reason: 'Anulada (E2E D-375)' });
    await postJson(api, `/api/coils/${coil.id}/restore`, { reason: 'Primera (E2E)' });
    const again = await api.post(`/api/coils/${coil.id}/restore`, {
      data: { reason: 'Segunda (E2E)' },
    });
    expect(again.status()).toBe(409);
    expect(await again.text()).toContain('no está anulada');
  });

  test('a hoy cuando reinsertar en su fecha recostearía una salida; la producción con fecha anterior se rechaza', async () => {
    const coil = await cancelledCoil(api, '5');
    // Una merma a costo 5 (después anulada) y un cambio de costo a 4: la entrada a reinsertar
    // vale 4, y la merma de hoy quedaría valorizada distinto si la entrada volviera a su fecha.
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '10',
      reason: 'Merma (E2E D-375)',
    });
    const scrap = (await movementsOf(api, 'COIL', coil.id)).find((m) => m.refType === 'SCRAP')!;
    await postJson(api, `/api/coils/scraps/${scrap.id}/cancel`, {
      reason: 'Merma por error (E2E)',
    });
    const recost = await api.patch(`/api/coils/${coil.id}`, {
      data: { unitCostPerKg: '4', reason: 'Costo corregido (E2E D-375)' },
    });
    expect(recost.status(), await recost.text()).toBe(200);
    await postJson(api, `/api/coils/${coil.id}/cancel`, { reason: 'Anulada (E2E D-375)' });

    const plan = await getJson<CoilRestorePlanDto>(api, `/api/coils/${coil.id}/restore-plan`);
    expect(plan.mode).toBe('A_HOY');
    expect(plan.date).toBe(today());

    await postJson(api, `/api/coils/${coil.id}/restore`, { reason: 'Restaurar a hoy (E2E)' });
    const live = liveOf(await movementsOf(api, 'COIL', coil.id));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ type: 'IN', operationDate: today() });

    const backdated = await api.post(`/api/coils/${coil.id}/scrap`, {
      data: {
        qtyKg: '5',
        reason: 'Producción retrofechada (E2E)',
        operationDate: addDays(today(), -1),
        confirmBackdate: true,
      },
    });
    expect(backdated.status()).toBe(400);
    expect(await backdated.text()).toContain(`no puede tener fecha anterior a ${today()}`);
    // Con la fecha de hoy, sí.
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '5',
      reason: 'Producción de hoy (E2E)',
    });
  });

  test('una bobina con salidas vivas se bloquea', async () => {
    const coil = await cancelledCoil(api);
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '10',
      reason: 'Merma viva (E2E D-375)',
    });
    await setCoilCancelledForTest(coil.id);

    const plan = await getJson<CoilRestorePlanDto>(api, `/api/coils/${coil.id}/restore-plan`);
    expect(plan.mode).toBe('BLOQUEADA');
    expect(plan.reasons.join(' ')).toMatch(/salida\(s\) propia\(s\) vivas/);
    const refused = await api.post(`/api/coils/${coil.id}/restore`, {
      data: { reason: 'Intento (E2E)' },
    });
    expect(refused.status()).toBe(400);
  });

  test('con la compra anulada se restaura igual y la compra no se toca (decisión del dueño)', async () => {
    const { coil, purchaseId } = await setupCoilStock(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '1000',
      receivedOn: addDays(today(), -RECEIVED_DAYS_AGO),
    });
    await postJson(api, `/api/purchases/${purchaseId}/cancel`, {
      reason: 'Compra anulada (E2E D-375)',
    });
    expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).status).toBe('CANCELLED');

    const plan = await getJson<CoilRestorePlanDto>(api, `/api/coils/${coil.id}/restore-plan`);
    expect(plan).toMatchObject({ mode: 'EN_SU_FECHA', purchaseStatus: 'CANCELLED' });
    await postJson(api, `/api/coils/${coil.id}/restore`, {
      reason: 'Restaurar con compra anulada (E2E)',
    });

    expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).status).toBe('OPEN');
    const purchase = await getJson<{ status: string }>(api, `/api/purchases/${purchaseId}`);
    expect(purchase.status).toBe('CANCELLED');
  });

  test('un usuario que no es administrador no ve el plan ni restaura (403)', async ({
    baseURL,
  }) => {
    const coil = await cancelledCoil(api);
    await postJson(api, `/api/coils/${coil.id}/cancel`, { reason: 'Anulada (E2E D-375)' });
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    const as = await apiAs(baseURL!, supervisor);
    try {
      expect((await as.get(`/api/coils/${coil.id}/restore-plan`)).status()).toBe(403);
      const res = await as.post(`/api/coils/${coil.id}/restore`, {
        data: { reason: 'Intento (E2E)' },
      });
      expect(res.status()).toBe(403);
    } finally {
      await as.dispose();
    }
  });
});
