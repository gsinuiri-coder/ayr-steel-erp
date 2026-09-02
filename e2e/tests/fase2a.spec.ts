import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from '../helpers/api';
import { loginAndSetPassword, selectOption } from '../helpers/ui';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 2a: compras, bobinas y kardex. Todos los escenarios escriben, así que contra
 * producción solo corren si se piden de forma explícita (D-024), igual que Fase 1.
 *
 * Reversión: compras y bobinas no tienen borrado físico. Cada test anula en su
 * `finally` lo que sí se puede anular (compras en borrador y sin pagos) y desactiva
 * los maestros que creó —proveedor, acabado y el producto de trading que genera la
 * primera bobina de cada tipo (D-037)—, de modo que el rastro queda inerte y
 * reconocible por el prefijo E2E.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

/** RUC del emisor del XML de prueba: el preview busca al proveedor por este documento. */
const XML_SUPPLIER_DOC_NUMBER = '20601234567';
const XML_FIXTURE = resolve(__dirname, '../fixtures/factura-pen-contado.xml');

// ---------------------------------------------------------------------------
// DTOs mínimos del API que consumen los tests (el spec no importa @ayr/shared)
// ---------------------------------------------------------------------------

interface PurchaseItemDto {
  lineNumber: number;
  description: string;
  qty: string;
  unitPrice: string;
  coilCode: string | null;
}

interface PurchaseDto {
  id: string;
  supplierId: string;
  series: string;
  number: string;
  documentLabel: string;
  type: string;
  status: string;
  currency: string;
  subtotal: string;
  igv: string;
  total: string;
  paidAmount: string;
  balance: string;
  sourceXmlKey: string | null;
  items: PurchaseItemDto[];
  payments: { amount: string; currency: string; reference: string | null }[];
}

interface CoilDto {
  id: string;
  code: string;
  typeKey: string;
  purchaseId: string | null;
  weightKg: string;
  widthMm: string;
  thicknessMm: string;
  unitCostPerKg: string;
  availableKg: string;
}

interface MovementDto {
  id: string;
  itemId: string;
  type: string;
  qty: string;
  unit: string;
  unitCost: string;
  totalCost: string;
  refType: string;
  refId: string | null;
}

interface BalanceDto {
  itemId: string;
  itemLabel: string;
  qty: string;
  unit: string;
  avgCost: string;
  totalValue: string;
}

interface StatementDto {
  totalBalancePen: string;
  purchases: { documentLabel: string; balance: string; balancePen: string }[];
}

interface ProductDto {
  id: string;
  sku: string;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Correlativo de comprobante único: dos corridas seguidas no chocan contra el índice
 *  único (proveedor, tipo, serie, número), que no se resetea fuera de CI. */
function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
}

interface CoilLineInput {
  finishLabel: string;
  description: string;
  widthMm: string;
  thicknessMm: string;
  weightKg: string;
  unitPricePerKg: string;
}

/** Completa la línea `index` del formulario de compra de bobinas (cada línea = una bobina). */
async function fillCoilLine(page: Page, index: number, line: CoilLineInput): Promise<void> {
  await selectOption(
    page,
    page.getByRole('combobox', { name: 'Acabado' }).nth(index),
    line.finishLabel,
  );
  await page.getByLabel('Descripción').nth(index).fill(line.description);
  await page.getByLabel('Ancho (mm)').nth(index).fill(line.widthMm);
  await page.getByLabel('Espesor (mm)').nth(index).fill(line.thicknessMm);
  await page.getByLabel('Peso (kg)').nth(index).fill(line.weightKg);
  await page.getByLabel('Precio por kg').nth(index).fill(line.unitPricePerKg);
}

/** Id de la compra a la que redirige el formulario tras registrarla. */
async function waitForPurchaseId(page: Page): Promise<string> {
  await page.waitForURL(/\/compras\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

/**
 * Deja inerte en producción lo que el test creó: anula las compras que todavía admiten
 * anulación (borrador y sin pagos) y desactiva proveedor, acabado y los productos de
 * trading nacidos de las bobinas. Nunca lanza: es limpieza de `finally`.
 */
async function deactivateTrail(
  api: APIRequestContext,
  trail: {
    purchaseIds?: string[];
    supplierId?: string;
    finish?: CreatedFinish;
    supplierActiveAtEnd?: boolean;
  },
): Promise<void> {
  for (const purchaseId of trail.purchaseIds ?? []) {
    await api.post(`/api/purchases/${purchaseId}/cancel`).catch(() => undefined);
  }
  if (trail.supplierId) {
    await api
      .patch(`/api/suppliers/${trail.supplierId}`, {
        data: { isActive: trail.supplierActiveAtEnd ?? false },
      })
      .catch(() => undefined);
  }
  if (trail.finish) {
    await api
      .patch(`/api/finishes/${trail.finish.id}`, { data: { isActive: false } })
      .catch(() => undefined);
    // D-037: la primera bobina de cada tipo crea un producto `BOB{acabado}{espesor}`.
    const products = await getJson<ProductDto[]>(api, '/api/catalog?businessLine=trading').catch(
      () => [] as ProductDto[],
    );
    for (const product of products.filter((p) => p.sku.startsWith(`BOB${trail.finish?.code}`))) {
      await api
        .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  }
}

test.describe('Fase 2a — compras, bobinas y kardex', () => {
  test.skip(skipWrites, 'Crea datos: en produccion solo con E2E_ALLOW_WRITES=1');

  test('una compra de bobinas recién recibida crea las 2 bobinas y su kardex en soles (RF-10, RF-13, D-038)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    const number = uniqueDocumentNumber();
    let purchaseId = '';

    try {
      await page.goto('/compras/nueva?tipo=COIL');
      await expect(page.getByRole('heading', { name: 'Nueva compra' })).toBeVisible();

      await selectOption(
        page,
        page.getByRole('combobox', { name: 'Proveedor' }),
        `${supplier.code} — ${supplier.name}`,
      );
      await page.getByLabel('Serie').fill('F001');
      await page.getByLabel('Número').fill(number);

      await page.getByRole('button', { name: 'Agregar bobina' }).click();
      await expect(page.getByLabel('Peso (kg)')).toHaveCount(2);
      await fillCoilLine(page, 0, {
        finishLabel: `${finish.code} — ${finish.name}`,
        description: 'Bobina E2E gruesa',
        widthMm: '1200',
        thicknessMm: '2',
        weightKg: '5000',
        unitPricePerKg: '4',
      });
      await fillCoilLine(page, 1, {
        finishLabel: `${finish.code} — ${finish.name}`,
        description: 'Bobina E2E delgada',
        widthMm: '1000',
        thicknessMm: '0.9',
        weightKg: '2000',
        unitPricePerKg: '5.5',
      });

      // 5000 × 4 + 2000 × 5.5 = 31 000 sin IGV; con 18% el total es 36 580.
      await expect(page.getByText('S/ 31,000.00')).toBeVisible();
      await expect(page.getByText('S/ 36,580.00')).toBeVisible();

      await page.getByRole('button', { name: 'Registrar compra' }).click();
      purchaseId = await waitForPurchaseId(page);

      // La compra nace en borrador y todavía no tocó el stock (D-030).
      await expect(page.getByText('Borrador', { exact: true })).toBeVisible();
      const draft = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(draft.status).toBe('DRAFT');
      expect(draft.subtotal).toBe('31000.0000');
      expect(draft.igv).toBe('5580.0000');
      expect(draft.total).toBe('36580.0000');
      expect(draft.items.every((i) => i.coilCode === null)).toBe(true);

      const coilsBefore = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
      expect(coilsBefore).toHaveLength(0);
      const movementsBefore = await getJson<MovementDto[]>(
        api,
        '/api/inventory/movements?businessLine=drywall',
      );
      expect(movementsBefore.filter((m) => m.refId === purchaseId)).toHaveLength(0);

      // Recepción: recién acá se crean las bobinas y sus entradas de kardex.
      await page.getByRole('button', { name: 'Recibir' }).click();
      await expect(page.getByText('Compra recibida: el stock ya está en el kardex')).toBeVisible();
      await expect(page.getByText('Recibida', { exact: true })).toBeVisible();

      // RF-13: {proveedor}-{acabado}-{espesor}-{peso}-{correlativo del proveedor}.
      const expectedCodes = [
        `${supplier.code}-${finish.code}-2.00-5000-1`,
        `${supplier.code}-${finish.code}-0.90-2000-2`,
      ];
      for (const code of expectedCodes) {
        await expect(page.getByRole('row').filter({ hasText: code })).toBeVisible();
      }

      const coils = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
      expect(coils).toHaveLength(2);
      const gruesa = coils.find((c) => c.code === expectedCodes[0]);
      const delgada = coils.find((c) => c.code === expectedCodes[1]);
      expect(gruesa, `No se creó la bobina ${expectedCodes[0]}`).toBeDefined();
      expect(delgada, `No se creó la bobina ${expectedCodes[1]}`).toBeDefined();
      // RF-14: el typeKey agrupa por acabado y espesor, ignorando el ancho.
      expect(gruesa?.typeKey).toBe(`${finish.code}-2.00`);
      expect(delgada?.typeKey).toBe(`${finish.code}-0.90`);
      expect(gruesa?.purchaseId).toBe(purchaseId);
      expect(delgada?.purchaseId).toBe(purchaseId);

      // Kardex: una entrada por bobina, en soles y sin IGV (D-038, D-042).
      const expected = [
        { coil: gruesa, qty: '5000.000', unitCost: '4.0000', totalCost: '20000.0000' },
        { coil: delgada, qty: '2000.000', unitCost: '5.5000', totalCost: '11000.0000' },
      ];
      for (const { coil, qty, unitCost, totalCost } of expected) {
        const movements = await getJson<MovementDto[]>(
          api,
          `/api/inventory/movements?itemType=COIL&itemId=${coil?.id}`,
        );
        expect(movements).toHaveLength(1);
        expect(movements[0]).toMatchObject({
          type: 'IN',
          qty,
          unit: 'KGM',
          unitCost,
          totalCost,
          refType: 'PURCHASE',
          refId: purchaseId,
        });

        const balances = await getJson<BalanceDto[]>(
          api,
          `/api/inventory/balances?itemType=COIL&itemId=${coil?.id}`,
        );
        expect(balances).toHaveLength(1);
        expect(balances[0]).toMatchObject({
          itemLabel: coil?.code,
          qty,
          unit: 'KGM',
          avgCost: unitCost,
          totalValue: totalCost,
        });
      }
    } finally {
      if (isProduction) {
        // La compra ya recibida no se puede anular (es Fase 2b): queda en la base junto
        // con sus 2 bobinas, bajo un proveedor y un acabado ya desactivados.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });

  test('el XML de la factura del proveedor prellena la compra y al confirmar queda registrada (RF-11)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    // El emisor del XML tiene un RUC fijo: se reutiliza el proveedor si ya existe de una
    // corrida anterior (el índice de documento es único) y se recuerda cómo estaba.
    const suppliers = await getJson<CreatedSupplier[]>(api, '/api/suppliers');
    const existing = suppliers.find((s) => s.docNumber === XML_SUPPLIER_DOC_NUMBER);
    const supplier =
      existing ??
      (await createSupplier(api, {
        docNumber: XML_SUPPLIER_DOC_NUMBER,
        name: 'E2E ACEROS DEL NORTE S.A.C.',
      }));
    if (existing && !existing.isActive) {
      await api.patch(`/api/suppliers/${supplier.id}`, { data: { isActive: true } });
    }
    const finish = await createFinish(api);

    // El fixture es el mismo de los tests unitarios; solo se le cambia el correlativo
    // para que la compra sea nueva en cada corrida (índice único por comprobante).
    const number = uniqueDocumentNumber();
    const xml = readFileSync(XML_FIXTURE, 'utf8').replace('F001-1523', `F001-${number}`);
    let purchaseId = '';

    try {
      await page.goto('/bobinas/nueva-xml');
      await expect(page.getByRole('heading', { name: 'Bobinas desde XML' })).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles({
        name: 'factura.xml',
        mimeType: 'application/xml',
        buffer: Buffer.from(xml, 'utf8'),
      });

      // El proveedor se reconoció por RUC: no aparece el aviso de proveedor faltante.
      await expect(page.getByText(`Leído del XML: F001-${number}`)).toBeVisible();
      await expect(page.getByText('Falta el proveedor')).toHaveCount(0);

      // Cabecera prellenada desde el comprobante.
      await expect(page.getByLabel('Serie')).toHaveValue('F001');
      await expect(page.getByLabel('Número')).toHaveValue(number);
      await expect(page.getByRole('combobox', { name: 'Proveedor' })).toContainText(supplier.name);

      // Las dos líneas del XML, con su peso y su precio por kg sin IGV.
      await expect(page.getByLabel('Descripción')).toHaveCount(2);
      await expect(page.getByLabel('Descripción').nth(0)).toHaveValue(
        'BOBINA LAMINADO EN CALIENTE (LAC) 2.00MM x 1220MM',
      );
      await expect(page.getByLabel('Peso (kg)').nth(0)).toHaveValue('5000.000');
      await expect(page.getByLabel('Precio por kg').nth(0)).toHaveValue('4.2400');
      await expect(page.getByLabel('Descripción').nth(1)).toHaveValue(
        'BOBINA GALVANIZADA 1.50MM x 1000MM',
      );
      await expect(page.getByLabel('Peso (kg)').nth(1)).toHaveValue('1500.000');
      await expect(page.getByLabel('Precio por kg').nth(1)).toHaveValue('2.0000');

      // Los datos físicos no vienen en el comprobante: los completa el usuario.
      const finishLabel = `${finish.code} — ${finish.name}`;
      await selectOption(page, page.getByRole('combobox', { name: 'Acabado' }).nth(0), finishLabel);
      await page.getByLabel('Ancho (mm)').nth(0).fill('1220');
      await page.getByLabel('Espesor (mm)').nth(0).fill('2');
      await selectOption(page, page.getByRole('combobox', { name: 'Acabado' }).nth(1), finishLabel);
      await page.getByLabel('Ancho (mm)').nth(1).fill('1000');
      await page.getByLabel('Espesor (mm)').nth(1).fill('1.5');

      await page.getByRole('button', { name: 'Confirmar compra y bobinas' }).click();
      purchaseId = await waitForPurchaseId(page);

      await expect(page.getByRole('heading', { name: `Factura F001-${number}` })).toBeVisible();

      const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(purchase).toMatchObject({
        supplierId: supplier.id,
        series: 'F001',
        number,
        type: 'COIL',
        status: 'DRAFT',
        currency: 'PEN',
        // Importes recalculados por el ERP que cuadran con los del XML.
        subtotal: '24200.0000',
        igv: '4356.0000',
        total: '28556.0000',
      });
      expect(purchase.items).toHaveLength(2);
      // El XML original queda archivado y referenciado por la compra (RF-11).
      expect(purchase.sourceXmlKey).toMatch(/^purchases\/xml\//);

      // Aparece en la lista central de compras buscando por su número.
      const listed = await getJson<PurchaseDto[]>(api, `/api/purchases?search=${number}`);
      expect(listed.some((p) => p.id === purchaseId)).toBe(true);
    } finally {
      if (isProduction) {
        // La compra sigue en borrador y sin pagos: se anula. El proveedor del XML vuelve
        // al estado que tenía antes del test.
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          supplierActiveAtEnd: existing ? existing.isActive : false,
          finish,
        });
      }
    }
  });

  test('la planilla de bobinas marca la fila mala, se corrige en la UI y se confirman las 2 (RF-12, RF-52)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    // Fila 1 válida; fila 2 con un código de proveedor que no existe.
    const csv = [
      'Línea,Proveedor (código),Acabado,Peso (kg),Ancho (mm),Espesor (mm),Moneda (PEN/USD),Costo por kg sin IGV,Tipo de cambio',
      `drywall,${supplier.code},${finish.code},3000,1200,2,PEN,4.5,`,
      `drywall,NOEXIS,${finish.code},1000,900,0.9,PEN,6,`,
    ].join('\n');

    const expectedCodes = [
      `${supplier.code}-${finish.code}-2.00-3000-1`,
      `${supplier.code}-${finish.code}-0.90-1000-2`,
    ];

    try {
      await page.goto('/bobinas/importar');
      await expect(page.getByRole('heading', { name: 'Importar bobinas' })).toBeVisible();
      await page.getByRole('button', { name: 'Importar' }).click();

      const dialog = page.getByRole('dialog');
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: 'bobinas.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

      await expect(dialog.getByText('No existe un proveedor con código "NOEXIS"')).toBeVisible();
      await expect(dialog.getByText('1 de 2 filas listas para confirmar.')).toBeVisible();

      // Corrige la fila 2 con el proveedor real y vuelve a validarse al salir del campo.
      const badRowSupplier = dialog.getByLabel('Proveedor (código) fila 2');
      await badRowSupplier.fill(supplier.code);
      await badRowSupplier.blur();
      await expect(dialog.getByText('2 de 2 filas listas para confirmar.')).toBeVisible();

      await dialog.getByRole('button', { name: 'Confirmar 2 filas' }).click();
      await expect(page.getByText('2 de 2 filas importadas')).toBeVisible();
      await dialog.getByRole('button', { name: 'Cerrar' }).click();
      await expect(dialog).toBeHidden();

      // Las 2 bobinas quedaron creadas, con su código RF-13 y su entrada de kardex.
      const coils = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
      expect(coils.map((c) => c.code).sort()).toEqual([...expectedCodes].sort());
      // La carga histórica no genera compra: la bobina entra sin comprobante (RF-12).
      expect(coils.every((c) => c.purchaseId === null)).toBe(true);

      const gruesa = coils.find((c) => c.code === expectedCodes[0]);
      const movements = await getJson<MovementDto[]>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${gruesa?.id}`,
      );
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        type: 'IN',
        qty: '3000.000',
        unitCost: '4.5000',
        totalCost: '13500.0000',
        refType: 'IMPORT',
      });

      await page.goto('/bobinas');
      await expect(page.getByRole('heading', { name: 'Bobinas' })).toBeVisible();
      for (const code of expectedCodes) {
        await expect(page.getByRole('row').filter({ hasText: code })).toBeVisible();
      }
    } finally {
      if (isProduction) {
        // Las bobinas importadas no se borran: quedan bajo un proveedor y un acabado
        // desactivados, reconocibles por el prefijo del código.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });

  test('un pago parcial baja el saldo de la compra y el estado de cuenta del proveedor (D-039)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const number = uniqueDocumentNumber();

    // La compra se crea por API: lo que se prueba acá es el pago, no el alta.
    const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'services',
      type: 'SERVICE',
      docType: 'FACTURA',
      series: 'F001',
      number,
      issueDate: new Date().toISOString().slice(0, 10),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      serviceKind: 'FREIGHT',
      items: [{ description: 'Flete de bobinas E2E', qty: '1', unit: 'ZZ', unitPrice: '10000' }],
    });

    try {
      // 10 000 + 18% = 11 800 de total; sin pagos el saldo es el total.
      expect(purchase.total).toBe('11800.0000');
      expect(purchase.balance).toBe('11800.0000');

      await page.goto(`/compras/${purchase.id}`);
      await expect(page.getByRole('heading', { name: `Factura F001-${number}` })).toBeVisible();
      await expect(page.getByText('S/ 11,800.00').first()).toBeVisible();

      await page.getByRole('button', { name: 'Registrar pago' }).click();
      await page.getByLabel('Monto').fill('5000');
      await page.getByLabel('Referencia').fill('E2E-PAGO-PARCIAL');
      await page.getByRole('button', { name: 'Guardar pago' }).click();

      await expect(page.getByText('Pago registrado')).toBeVisible();
      // Saldo = total − pagos: 11 800 − 5 000 = 6 800.
      await expect(page.getByText('S/ 6,800.00')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: 'E2E-PAGO-PARCIAL' })).toContainText(
        'S/ 5,000.00',
      );

      const paid = await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
      expect(paid.paidAmount).toBe('5000.0000');
      expect(paid.balance).toBe('6800.0000');
      expect(paid.payments).toHaveLength(1);

      // El estado de cuenta del proveedor refleja el mismo saldo.
      await page.getByRole('link', { name: 'Ver estado de cuenta del proveedor' }).click();
      await expect(page.getByRole('heading', { name: 'Estado de cuenta' })).toBeVisible();
      await expect(page.getByText('S/ 6,800.00').first()).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: `F001-${number}` })).toContainText(
        'S/ 6,800.00',
      );

      const statement = await getJson<StatementDto>(
        api,
        `/api/purchases/suppliers/${supplier.id}/statement`,
      );
      expect(statement.totalBalancePen).toBe('6800.0000');
      expect(statement.purchases).toHaveLength(1);
      expect(statement.purchases[0]).toMatchObject({
        documentLabel: `F001-${number}`,
        balance: '6800.0000',
        balancePen: '6800.0000',
      });
    } finally {
      if (isProduction) {
        // Una compra con pagos no se puede anular: queda en borrador con su saldo, bajo
        // un proveedor desactivado.
        await deactivateTrail(api, { supplierId: supplier.id });
      }
    }
  });

  test('una compra de gasto genera cuenta por pagar pero ningún movimiento de inventario (D-030)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const number = uniqueDocumentNumber();

    // Línea con inventario (drywall, STOCK): si el gasto moviera stock, se vería acá.
    const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'drywall',
      type: 'EXPENSE',
      docType: 'FACTURA',
      series: 'F001',
      number,
      issueDate: new Date().toISOString().slice(0, 10),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        { description: 'Alquiler de montacargas E2E', qty: '1', unit: 'ZZ', unitPrice: '2000' },
      ],
    });

    try {
      const movementsBefore = await getJson<MovementDto[]>(
        api,
        '/api/inventory/movements?businessLine=drywall',
      );
      const balancesBefore = await getJson<BalanceDto[]>(
        api,
        '/api/inventory/balances?businessLine=drywall',
      );

      await page.goto(`/compras/${purchase.id}`);
      await expect(page.getByText('Borrador', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Recibir' }).click();
      await expect(page.getByText('Compra recibida: el stock ya está en el kardex')).toBeVisible();
      await expect(page.getByText('Recibida', { exact: true })).toBeVisible();

      const movementsAfter = await getJson<MovementDto[]>(
        api,
        '/api/inventory/movements?businessLine=drywall',
      );
      const balancesAfter = await getJson<BalanceDto[]>(
        api,
        '/api/inventory/balances?businessLine=drywall',
      );
      expect(movementsAfter.filter((m) => m.refId === purchase.id)).toHaveLength(0);
      expect(movementsAfter).toHaveLength(movementsBefore.length);
      expect(balancesAfter).toHaveLength(balancesBefore.length);

      // Pero sí queda la cuenta por pagar: 2 000 + 18% = 2 360.
      const received = await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
      expect(received.status).toBe('RECEIVED');
      expect(received.total).toBe('2360.0000');
      expect(received.balance).toBe('2360.0000');
      await expect(page.getByText('S/ 2,360.00').first()).toBeVisible();

      const statement = await getJson<StatementDto>(
        api,
        `/api/purchases/suppliers/${supplier.id}/statement`,
      );
      expect(statement.totalBalancePen).toBe('2360.0000');
    } finally {
      if (isProduction) {
        // Una compra recibida no se puede anular: queda con su saldo, bajo un proveedor
        // desactivado.
        await deactivateTrail(api, { supplierId: supplier.id });
      }
    }
  });
});
