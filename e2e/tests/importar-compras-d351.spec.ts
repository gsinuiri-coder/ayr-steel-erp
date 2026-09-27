import { expect, test } from '@playwright/test';
import { businessToday, PURCHASE_IMPORT_COLUMNS, type CoilDto } from '@ayr/shared';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getJson,
  postJson,
} from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';
import { createColor } from '../helpers/roofing';
import { createSellableProduct } from '../helpers/sales';

/**
 * D-351 — el importador de compras de punta a punta: un archivo con los cuatro tipos de compra →
 * preview → corregir una fila en pantalla → confirmar → cuatro compras en BORRADOR → recibir la de
 * bobinas → las bobinas nacen con el color de su acabado, el código externo del archivo y su
 * movimiento de kardex. El proveedor nuevo sale del padrón (stub local: RUC par → encontrado).
 */

test.skip(!!process.env.E2E_BASE_URL, 'Crea compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

const HEADERS = Object.values(PURCHASE_IMPORT_COLUMNS).map((c) => c.header);

type Row = Partial<Record<keyof typeof PURCHASE_IMPORT_COLUMNS, string>>;

function csvOf(rows: Row[]): Buffer {
  const keys = Object.keys(PURCHASE_IMPORT_COLUMNS) as (keyof typeof PURCHASE_IMPORT_COLUMNS)[];
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    HEADERS.join(','),
    ...rows.map((r) => keys.map((k) => escape(r[k] ?? '')).join(',')),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Un RUC al azar que termina en par: el stub del padrón lo «encuentra». */
function evenRuc(): string {
  const body = `20${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 10))}`;
  return `${body}${String(Math.floor(Math.random() * 5) * 2)}`;
}

test('D-351 — cuatro tipos → preview → corregir → confirmar → recibir bobinas', async ({
  page,
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const color = await createColor(api);
  const finish = await createFinish(api, {
    businessLine: 'metallic-roofing',
    kind: 'PREPINTADO',
    colorId: color.id,
  });
  const product = await createSellableProduct(api, { lineCode: 'trading' });
  const supplier = await createSupplier(api);
  const newRuc = evenRuc();
  const [y, m, d] = businessToday().split('-');
  const today = `${d}/${m}/${y}`;
  const n = String(Date.now()).slice(-6);

  const header = { issueDate: today, currency: 'PEN', paymentTerms: 'Contado', igvRate: '18' };
  const file = csvOf([
    // 1. Bobinas: dos líneas del mismo comprobante, con coma decimal y código externo.
    {
      ...header,
      type: 'Bobinas',
      businessLine: 'Coberturas Aluzinc',
      docType: 'Factura',
      document: `F9${n.slice(-2)}-${n}1`,
      supplierRuc: supplier.docNumber,
      unitPrice: '3,20',
      finishCode: finish.code,
      color: color.name,
      thicknessMm: '0,30',
      widthMm: '1220',
      kg: '1500,5',
      externalCode: `EXT-${n}-A`,
    },
    {
      ...header,
      type: 'Bobinas',
      businessLine: 'Coberturas Aluzinc',
      docType: 'Factura',
      document: `F9${n.slice(-2)}-${n}1`,
      supplierRuc: supplier.docNumber,
      unitPrice: '3,20',
      finishCode: finish.code,
      thicknessMm: '0,30',
      widthMm: '1220',
      kg: '1200',
      externalCode: `EXT-${n}-B`,
    },
    // 2. Producto terminado, de un proveedor que el maestro no tiene y el padrón sí.
    {
      ...header,
      type: 'Producto terminado',
      businessLine: 'Reventa',
      docType: 'Factura',
      document: `F8${n.slice(-2)}-${n}2`,
      supplierRuc: newRuc,
      sku: product.sku,
      qty: '10',
      unitPrice: '5',
    },
    // 3. Servicio (flete).
    {
      ...header,
      type: 'Servicio',
      businessLine: 'Coberturas Aluzinc',
      docType: 'Factura',
      document: `E9${n.slice(-2)}-${n}3`,
      supplierRuc: supplier.docNumber,
      serviceKind: 'Flete',
      description: 'Flete E2E',
      qty: '1',
      unitPrice: '100',
    },
    // 4. Gasto, con una cantidad que no es número: se corrige en pantalla.
    {
      ...header,
      type: 'Gasto',
      businessLine: 'Servicios',
      docType: 'Boleta',
      document: `B9${n.slice(-2)}-${n}4`,
      supplierRuc: supplier.docNumber,
      description: 'Energía E2E',
      qty: 'uno',
      unitPrice: '50',
    },
  ]);

  const admin = await createUser(api, 'ADMINISTRADOR');
  await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');
  await page.goto('/compras');
  await page.getByRole('link', { name: 'Importar compras' }).click();
  await expect(page).toHaveURL(/\/compras\/importar/);

  await page
    .locator('#import-file')
    .setInputFiles({ name: 'compras.csv', mimeType: 'text/csv', buffer: file });
  await expect(page.getByText('filas leídas en 4 comprobantes')).toBeVisible({ timeout: 60_000 });

  // El proveedor nuevo sale del padrón con su código sugerido.
  const productDoc = page.getByTestId(`purchase-doc-F8${n.slice(-2)}-${n}2`);
  await expect(productDoc.getByText(/Nuevo — se creará desde padrón: PADRON STUB/)).toBeVisible();
  await expect(productDoc.getByLabel(/Código corto del proveedor nuevo/)).toHaveValue(
    /^[A-Z]{3,6}$/,
  );

  // El gasto trae un error y el botón de confirmar no deja avanzar.
  const expenseDoc = page.getByTestId(`purchase-doc-B9${n.slice(-2)}-${n}4`);
  await expect(expenseDoc.getByText('1 cosa por resolver')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear las compras' })).toBeDisabled();

  // Corregir la fila en pantalla: se revalida contra el servidor y queda lista.
  await expenseDoc.getByLabel('Cantidad de la fila 6').fill('1');
  await expect(expenseDoc.getByText('Lista')).toBeVisible({ timeout: 30_000 });
  const confirmButton = page.getByRole('button', { name: 'Crear las compras' });
  await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
  await confirmButton.click();
  await expect(page.getByText(/Se crearon\s*4\s*compras en borrador/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/Proveedores creados desde el padrón/)).toBeVisible();

  // Las cuatro compras, en BORRADOR.
  const links = page.locator('a[href^="/compras/"]').filter({ hasText: /-/ });
  const hrefs = await links.evaluateAll((els) =>
    els.map((e) => e.getAttribute('href') ?? '').filter((h) => /\/compras\/[0-9a-f-]{36}$/.test(h)),
  );
  expect(hrefs).toHaveLength(4);
  const purchases = await Promise.all(
    hrefs.map((h) =>
      getJson<{ id: string; status: string; type: string; series: string; number: string }>(
        api,
        `/api${h.replace('/compras/', '/purchases/')}`,
      ),
    ),
  );
  expect(purchases.map((p) => p.status)).toEqual(['DRAFT', 'DRAFT', 'DRAFT', 'DRAFT']);
  expect(purchases.map((p) => p.type).sort()).toEqual([
    'COIL',
    'EXPENSE',
    'FINISHED_GOOD',
    'SERVICE',
  ]);

  // Recibir la de bobinas: las bobinas nacen con el color del acabado, el código externo y kardex.
  const coilPurchase = purchases.find((p) => p.type === 'COIL');
  await postJson(api, `/api/purchases/${coilPurchase!.id}/receive`, {});
  const coils = await getJson<{ items: CoilDto[] }>(
    api,
    `/api/coils?finishId=${finish.id}&pageSize=50`,
  );
  const imported = coils.items.filter((c) => c.purchaseId === coilPurchase!.id);
  expect(imported).toHaveLength(2);
  expect(imported.every((c) => c.colorId === color.id)).toBe(true);
  expect(imported.map((c) => c.externalCode).sort()).toEqual([`EXT-${n}-A`, `EXT-${n}-B`]);
  expect(imported.map((c) => c.weightKg).sort()).toEqual(['1200.000', '1500.500']);
  for (const coil of imported) {
    const moves = await getJson<{ items: unknown[] }>(
      api,
      `/api/inventory/movements?itemType=COIL&itemId=${coil.id}`,
    );
    expect(moves.items.length).toBeGreaterThan(0);
  }

  // Deshacer el lote: anula por el servicio las tres que siguen en borrador; la recibida se nombra.
  await page.getByRole('button', { name: 'Deshacer lote' }).click();
  const undoDialog = page.getByRole('dialog', { name: 'Deshacer el lote' });
  await undoDialog.getByLabel('Motivo').fill('Prueba E2E: archivo equivocado');
  await undoDialog.getByRole('button', { name: 'Deshacer lote' }).click();
  await expect(
    page.getByText(/Lote deshecho: 3 anuladas; no se tocaron .*ya se recibió/),
  ).toBeVisible({
    timeout: 60_000,
  });
  const after = await Promise.all(
    purchases.map((p) => getJson<{ id: string; status: string }>(api, `/api/purchases/${p.id}`)),
  );
  expect(after.filter((p) => p.status === 'CANCELLED')).toHaveLength(3);
  expect(after.find((p) => p.id === coilPurchase!.id)?.status).toBe('RECEIVED');
});
