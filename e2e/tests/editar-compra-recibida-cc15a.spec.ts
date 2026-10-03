import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import { setupPosStock, POS_LINE } from '../helpers/pos';
import {
  balanceOf,
  live,
  movementsOf,
  postExpectingError,
  today,
  uniqueDocumentNumber,
} from '../helpers/production';
import { purgeRoofingTrail, setupRoofingScenario, type RoofingScenario } from '../helpers/roofing';
import { createSellableProduct } from '../helpers/sales';
import { headerAction } from '../helpers/ui';

/**
 * **D-372, sesión 2, primera parte (cc15a).**
 *
 * - Punto 1: después de cambiar el producto de una línea, la compra se puede anular aunque el
 *   producto viejo se haya movido por otro documento.
 * - Punto 2: con consumo posterior, corregir el precio graba un ajuste **proporcional** sobre lo
 *   que queda de la compra, con la fecha de hoy; lo que ya salió conserva su costo y se lista.
 *   Deshacer con consumo entre las dos ediciones deja un resultado correcto y explicado.
 *
 * Escribe compras, bobinas y mermas: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras y bobinas: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

interface PurchaseDto {
  id: string;
  status: string;
  total: string;
  items: { id: string; qty: string; unitPrice: string; subtotal: string; description: string }[];
}
interface PlanDto {
  changes: {
    field: string;
    path: string;
    blockedReason: string | null;
    adjustment?: {
      remainingQty: string;
      amountPen: string;
      affected: { operationDate: string; document: string; qty: string; unitCost: string }[];
    } | null;
  }[];
  warnings?: string[];
  executable: boolean;
}
interface PepsDto {
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

async function scrap(api: APIRequestContext, coilId: string, qtyKg: string): Promise<void> {
  await postJson(api, `/api/coils/${coilId}/scrap`, { qtyKg, reason: 'Merma (E2E cc15a)' });
}

test.describe('D-372 sesión 2 (cc15a)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('punto 1: tras cambiar el producto, la compra se anula aunque el producto viejo se haya movido', async () => {
    const stock = await setupPosStock(api, { qty: '10', unitPrice: '20' });
    const other = await createSellableProduct(api, { lineCode: POS_LINE, unit: 'NIU' });
    const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${stock.purchaseId}`);
    const item = purchase.items[0]!;

    // A → B por «Editar compra».
    await postJson(api, `/api/purchases/${stock.purchaseId}/received-edit`, {
      items: [{ itemId: item.id, productId: other.id }],
      reason: 'Producto equivocado (E2E cc15a)',
    });
    const edited = await getJson<PurchaseDto>(api, `/api/purchases/${stock.purchaseId}`);
    // Decisión D: la descripción pasa a ser el nombre del producto nuevo.
    const otherName = (await getJson<{ name: string }>(api, `/api/catalog/${other.id}`)).name;
    expect(edited.items[0]!.description).toBe(otherName);
    expect((await balanceOf(api, 'PRODUCT', stock.product.id)).qty).toBe('0.000');
    expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('10.000');

    // Otra compra mueve el producto viejo A.
    const second = await postJson<{ id: string }>(api, '/api/purchases', {
      supplierId: stock.supplier.id,
      businessLine: POS_LINE,
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
          productId: stock.product.id,
          description: 'Otra compra de A',
          qty: '4',
          unit: 'NIU',
          unitPrice: '20',
        },
      ],
    });
    await postJson(api, `/api/purchases/${second.id}/receive`);

    // Antes de cc15 esto se rechazaba: «ya tiene movimientos posteriores». Ahora el producto
    // viejo no cuenta (la compra no tiene nada vigente en él) y la anulación revierte solo B.
    await postJson(api, `/api/purchases/${stock.purchaseId}/cancel`, {
      reason: 'Anulación tras cambio de producto (E2E cc15a)',
    });
    const cancelled = await getJson<PurchaseDto>(api, `/api/purchases/${stock.purchaseId}`);
    expect(cancelled.status).toBe('CANCELLED');
    expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('0.000');
    expect((await balanceOf(api, 'PRODUCT', stock.product.id)).qty).toBe('4.000');

    await postJson(api, `/api/purchases/${second.id}/cancel`, { reason: 'Limpieza (E2E cc15a)' });
  });

  test('punto 2: con consumo, el precio se corrige con un ajuste sobre lo que queda; deshacer con consumo entre medio queda explicado', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await scrap(api, s.coil.id, '400');
      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      const item = purchase.items[0]!;
      expect(item.unitPrice).toBe('5.0000');

      // Vista previa: 600 de 1000 quedan; a 5.5 la diferencia es 500 → ajuste de 300.
      const plan = await postJson<PlanDto>(
        api,
        `/api/purchases/${s.purchaseId}/received-edit/preview`,
        { items: [{ itemId: item.id, unitPrice: '5.5' }] },
      );
      expect(plan.executable).toBe(true);
      expect(plan.changes[0]).toMatchObject({
        path: 'COST_ADJUST',
        adjustment: { remainingQty: '600.000', amountPen: '300.0000' },
      });
      expect(plan.changes[0]!.adjustment!.affected).toEqual([
        expect.objectContaining({ document: 'Merma', qty: '400.000', unitCost: '5.0000' }),
      ]);
      expect(plan.warnings?.join(' ')).toContain('reportes mensuales de bobinas ya pasados');

      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: item.id, unitPrice: '5.5' }],
        reason: 'Precio mal tipeado (E2E cc15a)',
      });

      // Kardex: la merma conserva su costo; un ajuste de 300 con la fecha de hoy; lo que queda,
      // a 5.5. La ficha de la bobina toma el costo de la factura (decisión C).
      const movements = live(await movementsOf(api, 'COIL', s.coil.id));
      const merma = movements.find((m) => m.type === 'OUT');
      expect(merma).toMatchObject({ qty: '400.000', totalCost: '2000.0000' });
      const adjust = movements.find((m) => m.type === 'ADJUST');
      expect(adjust).toMatchObject({ totalCost: '300.0000', operationDate: today() });
      const balance = await balanceOf(api, 'COIL', s.coil.id);
      expect(balance).toMatchObject({ qty: '600.000', avgCost: '5.5000' });
      const coil = await getJson<{ unitCostPerKg: string; totalCostPen: string }>(
        api,
        `/api/coils/${s.coil.id}`,
      );
      expect(coil.unitCostPerKg).toBe('5.5000');
      expect(coil.totalCostPen).toBe('5500.0000');

      // PEPS: lo que queda cierra con el costo nuevo; la merma salió a 5.
      const receipt = movements.find((m) => m.type === 'IN')!.operationDate;
      const peps = await getJson<PepsDto>(
        api,
        `/api/reports/kardex-peps?itemType=COIL&itemId=${s.coil.id}&from=${receipt}&to=${today()}`,
      );
      expect(peps.closing).toMatchObject({
        qty: '600.000',
        unitCost: '5.5000',
        total: '3300.0000',
      });

      // Sale más material, ahora a 5.5, y recién después se deshace la corrección.
      await scrap(api, s.coil.id, '200');
      const undo = await postJson<PlanDto>(
        api,
        `/api/purchases/${s.purchaseId}/received-edit/preview`,
        { items: [{ itemId: item.id, unitPrice: '5' }] },
      );
      expect(undo.changes[0]).toMatchObject({
        path: 'COST_ADJUST',
        adjustment: { remainingQty: '400.000', amountPen: '-200.0000' },
      });
      // Las dos salidas, cada una con el costo que llevó.
      expect(undo.changes[0]!.adjustment!.affected.map((a) => [a.qty, a.unitCost])).toEqual([
        ['400.000', '5.0000'],
        ['200.000', '5.5000'],
      ]);
      expect(undo.warnings?.join(' ')).toContain('Deshacer');

      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: item.id, unitPrice: '5' }],
        reason: 'Vuelta al precio anterior (E2E cc15a)',
      });
      // Correcto y explicado: lo que queda vuelve a 5; los 200 que salieron entre medio
      // conservan 5.5 (no es idéntico al inicio, y la vista previa lo dijo).
      expect(await balanceOf(api, 'COIL', s.coil.id)).toMatchObject({
        qty: '400.000',
        avgCost: '5.0000',
      });
      const after = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      expect(after.items[0]).toMatchObject({
        unitPrice: '5.0000',
        subtotal: purchase.items[0]!.subtotal,
      });
      expect(after.total).toBe(purchase.total);
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('punto 1 + 2: después de un ajuste proporcional, la anulación sigue viendo el consumo y se rechaza', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await scrap(api, s.coil.id, '300');
      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      await postJson(api, `/api/purchases/${s.purchaseId}/received-edit`, {
        items: [{ itemId: purchase.items[0]!.id, unitPrice: '6' }],
        reason: 'Precio mal tipeado (E2E cc15a)',
      });
      // El ajuste propio es el movimiento más nuevo de la compra: no puede esconder la merma.
      const rejected = await postExpectingError(api, `/api/purchases/${s.purchaseId}/cancel`, {
        reason: 'Intento de anular con consumo (E2E cc15a)',
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('movimientos posteriores');
      const after = await getJson<PurchaseDto>(api, `/api/purchases/${s.purchaseId}`);
      expect(after.status).toBe('RECEIVED');
      expect(await balanceOf(api, 'COIL', s.coil.id)).toMatchObject({
        qty: '700.000',
        avgCost: '6.0000',
      });
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });

  test('pantalla: con consumo, la revisión muestra el ajuste, lo que ya salió y los avisos', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '1000' });
    try {
      await scrap(api, s.coil.id, '100');
      await loginAsAdmin(page);
      await page.goto(`/compras/${s.purchaseId}`);
      await (await headerAction(page, 'Editar compra')).click();
      const dialog = page.getByTestId('received-edit-dialog');
      await dialog.getByLabel('Precio unitario de la línea 1').fill('6');
      await dialog.getByRole('button', { name: 'Revisar cambios' }).click();
      const change = dialog.getByTestId('received-edit-change');
      await expect(change).toHaveAttribute('data-path', 'COST_ADJUST');
      await expect(change).toContainText('Ajuste sobre lo que queda');
      await expect(dialog.getByTestId('received-edit-adjustment')).toContainText('S/ 900.0000');
      await expect(dialog.getByTestId('received-edit-affected')).toContainText('Merma');
      await expect(dialog.getByTestId('received-edit-warnings')).toContainText(
        'reportes mensuales',
      );
      await dialog.getByLabel('Motivo').fill('Precio mal tipeado (E2E cc15a pantalla)');
      await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      expect((await balanceOf(api, 'COIL', s.coil.id)).avgCost).toBe('6.0000');
    } finally {
      await purgeRoofingTrail(api, trailOf(s));
    }
  });
});
