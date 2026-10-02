import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  live,
  movementsOf,
  postExpectingError,
  today,
  type CoilDto,
} from '../helpers/production';
import { purgeRoofingTrail, setupRoofingScenario, type RoofingScenario } from '../helpers/roofing';
import { headerAction } from '../helpers/ui';

/**
 * **D-372 (cc14) — editar una compra ya recibida, versión 1.**
 *
 * - Sin movimientos posteriores, corregir el precio o los kilos revierte el ingreso y vuelve a
 *   ingresar **en la misma fecha**; la bobina toma el costo de documento corregido y conserva su
 *   código.
 * - Deshacer es volver a editar con el valor anterior: el saldo y el costo quedan como al inicio.
 * - Con consumo posterior, la vista previa bloquea con el detalle de qué movió el ítem; el costo
 *   dice «disponible en la próxima versión» (el ajuste proporcional de la sesión 2).
 * - El PEPS toma el costo corregido y cuadra en cantidades con el kardex promedio.
 *
 * Escribe compras y bobinas: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras y bobinas: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

interface PurchaseDto {
  id: string;
  total: string;
  items: { id: string; qty: string; unitPrice: string; subtotal: string }[];
}
interface PlanDto {
  changes: { field: string; path: string; blockedReason: string | null }[];
  executable: boolean;
}
interface PepsDto {
  rows: { inQty: string | null; outQty: string | null }[];
  closing: { qty: string; unitCost: string; total: string };
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

function trailOf(s: RoofingScenario): Parameters<typeof purgeRoofingTrail>[1] {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
  };
}

test.describe('D-372 — editar una compra recibida', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('sin consumo: corregir el precio revierte e ingresa en la misma fecha, y volver al valor anterior deja todo como al inicio', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      const item = purchase.items[0]!;
      expect(item.unitPrice).toBe('5.0000');
      const before = await balanceOf(api, 'COIL', s.coil.id);
      const original = live(await movementsOf(api, 'COIL', s.coil.id));
      expect(original).toHaveLength(1);
      const receiptDate = original[0]!.operationDate;

      // Vista previa: el precio va por reversa y nuevo ingreso.
      const plan = await postJson<PlanDto>(
        api,
        `/api/purchases/${s.purchaseId}/received-edit/preview`,
        { items: [{ itemId: item.id, unitPrice: '5.5' }] },
      );
      expect(plan.executable).toBe(true);
      expect(plan.changes).toEqual([
        expect.objectContaining({
          field: 'unitPrice',
          path: 'REVERSE_REENTRY',
          blockedReason: null,
        }),
      ]);

      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: item.id, unitPrice: '5.5' }],
        reason: 'Precio mal tipeado (E2E D-372)',
      });

      // Kardex: el ingreso original revertido, su reversa y el ingreso nuevo, los tres en la
      // fecha de la recepción. Vivo, solo el nuevo, por 1000 kg a 5.5.
      const all = await movementsOf(api, 'COIL', s.coil.id);
      expect(all).toHaveLength(3);
      expect(all.every((m) => m.operationDate === receiptDate)).toBe(true);
      const now = live(all);
      expect(now).toHaveLength(1);
      expect(now[0]).toMatchObject({ type: 'IN', qty: '1000.000', totalCost: '5500.0000' });

      const coil = await getJson<CoilDto & { unitCostPerKg: string; totalCostPen: string }>(
        api,
        `/api/coils/${s.coil.id}`,
      );
      expect(coil.unitCostPerKg).toBe('5.5000');
      expect(coil.totalCostPen).toBe('5500.0000');
      expect(coil.code).toBe(s.coil.code);
      const after = await balanceOf(api, 'COIL', s.coil.id);
      expect(after.qty).toBe(before.qty);
      expect(after.avgCost).toBe('5.5000');
      const corrected = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      expect(corrected.items[0]).toMatchObject({ unitPrice: '5.5000', subtotal: '5500.0000' });

      // PEPS: toma el costo corregido y cuadra en cantidades con el kardex promedio.
      const peps = await getJson<PepsDto>(
        api,
        `/api/reports/kardex-peps?itemType=COIL&itemId=${s.coil.id}&from=${receiptDate}&to=${today()}`,
      );
      expect(peps.closing.qty).toBe(after.qty);
      expect(peps.closing.unitCost).toBe('5.5000');
      expect(peps.closing.total).toBe('5500.0000');

      // La auditoría guarda el antes y el después.
      const audit = await getJson<{
        items: { action: string; before: unknown; after: unknown; reason: string | null }[];
      }>(api, `/api/audit?entityType=purchases&entityId=${s.purchaseId}&pageSize=20`);
      const edit = audit.items.find((a) => a.action === 'purchases.update-received');
      expect(edit?.reason).toBe('Precio mal tipeado (E2E D-372)');
      expect(JSON.stringify(edit?.before)).toContain('5.0000');
      expect(JSON.stringify(edit?.after)).toContain('5.5000');

      // Deshacer = volver a editar con el valor anterior.
      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: item.id, unitPrice: '5' }],
        reason: 'Vuelta al valor anterior (E2E D-372)',
      });
      const back = await balanceOf(api, 'COIL', s.coil.id);
      expect(back).toMatchObject({ qty: before.qty, avgCost: before.avgCost });
      const restored = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      expect(restored.total).toBe(purchase.total);
      expect(live(await movementsOf(api, 'COIL', s.coil.id))).toHaveLength(1);
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('sin consumo: corregir los kg deja el saldo y el peso de la bobina correctos, con el mismo código', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      const item = purchase.items[0]!;
      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: item.id, qty: '980' }],
        reason: 'Peso de la balanza (E2E D-372)',
      });
      const balance = await balanceOf(api, 'COIL', s.coil.id);
      expect(balance.qty).toBe('980.000');
      expect(balance.avgCost).toBe('5.0000');
      const coil = await getJson<CoilDto & { weightKg: string }>(api, `/api/coils/${s.coil.id}`);
      expect(coil.weightKg).toBe('980.000');
      expect(coil.code).toBe(s.coil.code);
      const corrected = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      expect(corrected.items[0]).toMatchObject({ qty: '980.000', subtotal: '4900.0000' });
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('con consumo: la vista previa bloquea con el detalle y confirmar se rechaza', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await postJson(api, `/api/coils/${s.coil.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma de prueba (E2E D-372)',
      });
      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      const item = purchase.items[0]!;
      const plan = await postJson<PlanDto>(
        api,
        `/api/purchases/${s.purchaseId}/received-edit/preview`,
        { items: [{ itemId: item.id, unitPrice: '5.5' }], header: { notes: 'corregida' } },
      );
      expect(plan.executable).toBe(false);
      const cost = plan.changes.find((c) => c.field === 'unitPrice');
      expect(cost?.path).toBe('BLOCKED');
      expect(cost?.blockedReason).toContain('próxima versión');
      expect(cost?.blockedReason).toContain('SCRAP');
      // La cáscara sí se puede, aunque el costo esté bloqueado.
      expect(plan.changes.find((c) => c.field === 'notes')?.path).toBe('IN_PLACE');

      const qtyPlan = await postJson<PlanDto>(
        api,
        `/api/purchases/${s.purchaseId}/received-edit/preview`,
        { items: [{ itemId: item.id, qty: '990' }] },
      );
      expect(qtyPlan.changes[0]?.blockedReason).toContain('movimientos posteriores');

      const rejected = await postExpectingError(
        api,
        `/api/purchases/${s.purchaseId}/received-edit`,
        {
          items: [{ itemId: item.id, unitPrice: '5.5' }],
          reason: 'Intento con consumo (E2E D-372)',
        },
      );
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('próxima versión');
      // Nada se movió.
      expect(live(await movementsOf(api, 'COIL', s.coil.id))).toHaveLength(2);
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('pantalla: «Editar compra» revisa el camino de cada cambio y guarda el precio corregido', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await loginAsAdmin(page);
      await page.goto(`/compras/${s.purchaseId}`);
      await (await headerAction(page, 'Editar compra')).click();
      const dialog = page.getByTestId('received-edit-dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByLabel('Precio unitario de la línea 1').fill('5.5');
      await dialog.getByRole('button', { name: 'Revisar cambios' }).click();
      const change = dialog.getByTestId('received-edit-change');
      await expect(change).toHaveCount(1);
      await expect(change).toHaveAttribute('data-path', 'REVERSE_REENTRY');
      await expect(change).toContainText('Reversa y nuevo ingreso');

      await dialog.getByLabel('Motivo').fill('Precio mal tipeado (E2E D-372 pantalla)');
      await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      const balance = await balanceOf(api, 'COIL', s.coil.id);
      expect(balance.avgCost).toBe('5.5000');
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('solo la cáscara con consumo: se guarda sin mover el kardex', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await postJson(api, `/api/coils/${s.coil.id}/scrap`, {
        qtyKg: '10',
        reason: 'Merma de prueba (E2E D-372)',
      });
      const movementsBefore = await movementsOf(api, 'COIL', s.coil.id);
      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        header: { notes: 'Observación corregida (E2E D-372)' },
        reason: 'Observación (E2E D-372)',
      });
      const purchase = await getJson<{ notes: string | null }>(
        api,
        `/api/purchases/${s.purchaseId}`,
      );
      expect(purchase.notes).toBe('Observación corregida (E2E D-372)');
      expect(await movementsOf(api, 'COIL', s.coil.id)).toHaveLength(movementsBefore.length);
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });
});
