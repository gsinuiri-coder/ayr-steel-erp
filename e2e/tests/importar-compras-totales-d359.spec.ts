import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  Decimal,
  cents,
  money,
  PURCHASE_IMPORT_COLUMNS,
  type CoilDto,
  type PurchaseImportDocumentDto,
  type PurchaseImportPreviewDto,
  type PurchaseImportResultDto,
} from '@ayr/shared';
import { adminApi, createFinish, createSupplier, getJson, postJson } from '../helpers/api';
import { createColor } from '../helpers/roofing';
import { createSellableProduct } from '../helpers/sales';

/**
 * D-359 — importador de compras: el total del papel manda, contra la base real.
 *
 * - El comprobante del dueño (`F001-00043612`: 500 × 0.144068, tasa escrita como fracción, total
 *   85): el preview no avisa nada y la compra queda con el total del papel al céntimo.
 * - Corregir el número de esa compra en BORRADOR no recalcula sus importes (la única edición que
 *   tiene una compra: serie y número).
 * - Recibirla: el kardex entra por el subtotal sin IGV, no por cantidad × unitario de 4 decimales.
 * - Una bobina en dólares con importe de línea: la bobina y su kardex en subtotal × TC al céntimo.
 * - Una diferencia grande con el total es error del comprobante, con las dos cifras con IGV.
 */

test.skip(!!process.env.E2E_BASE_URL, 'Crea compras: nunca contra producción (D-126).');
test.describe.configure({ timeout: 300_000 });

type Row = Partial<Record<keyof typeof PURCHASE_IMPORT_COLUMNS, string>>;

function csvOf(rows: Row[]): Buffer {
  const keys = Object.keys(PURCHASE_IMPORT_COLUMNS) as (keyof typeof PURCHASE_IMPORT_COLUMNS)[];
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    keys.map((k) => PURCHASE_IMPORT_COLUMNS[k].header).join(','),
    ...rows.map((r) => keys.map((k) => escape(r[k] ?? '')).join(',')),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function preview(api: APIRequestContext, rows: Row[]): Promise<PurchaseImportPreviewDto> {
  const res = await api.post('/api/imports/purchases/preview', {
    multipart: { file: { name: 'compras.csv', mimeType: 'text/csv', buffer: csvOf(rows) } },
  });
  expect(res.ok(), `el preview falló: ${await res.text()}`).toBe(true);
  return (await res.json()) as PurchaseImportPreviewDto;
}

const issuesOf = (d: PurchaseImportDocumentDto) => [
  ...d.issues.map((i) => i.message),
  ...d.lines.flatMap((l) => l.issues.map((i) => i.message)),
];

interface PurchaseRow {
  id: string;
  type: string;
  status: string;
  series: string;
  number: string;
  subtotal: string;
  igv: string;
  total: string;
  items: { productId: string | null; subtotal: string; igv: string; unitPrice: string }[];
}

interface Movement {
  type: string;
  refType: string;
  qty: string;
  unitCost: string;
  totalCost: string;
}

test('D-359 — el total del papel manda al importar, al editar y al recibir', async ({
  baseURL,
}) => {
  const api = await adminApi(baseURL!);
  const supplier = await createSupplier(api);
  const product = await createSellableProduct(api, { lineCode: 'trading' });
  const color = await createColor(api);
  const finish = await createFinish(api, {
    businessLine: 'metallic-roofing',
    kind: 'PREPINTADO',
    colorId: color.id,
  });
  // Empieza en 9: un número que empieza con 0 se guarda sin el cero (D-538).
  const n = `9${String(Date.now()).slice(-5)}`;
  const header = {
    docType: 'Factura',
    issueDate: '12/08/2026',
    supplierRuc: supplier.docNumber,
    paymentTerms: 'Contado',
  };
  const goodsDoc = `F7${n.slice(-2)}-${n}1`;
  const coilDoc = `F6${n.slice(-2)}-${n}2`;
  const wrongDoc = `F5${n.slice(-2)}-${n}3`;

  const pre = await preview(api, [
    // El caso del dueño: tasa como fracción (una celda de porcentaje) y total con IGV.
    {
      ...header,
      type: 'Producto terminado',
      businessLine: 'Reventa',
      document: goodsDoc,
      currency: 'PEN',
      igvRate: '0,18',
      documentTotal: '85',
      sku: product.sku,
      qty: '500',
      unit: 'NIU',
      unitPrice: '0,144068',
    },
    // Bobina en dólares con importe de línea (manda) y un precio de seis decimales.
    {
      ...header,
      type: 'Bobinas',
      businessLine: 'Coberturas Aluzinc',
      document: coilDoc,
      currency: 'USD',
      exchangeRate: '3,745',
      igvRate: '18%',
      documentTotal: '5.227,59',
      finishCode: finish.code,
      thicknessMm: '0,30',
      widthMm: '1220',
      kg: '4520',
      unitPrice: '0,980123',
      lineAmount: '4.430,16',
    },
    // Una diferencia que el redondeo no explica.
    {
      ...header,
      type: 'Producto terminado',
      businessLine: 'Reventa',
      document: wrongDoc,
      currency: 'PEN',
      documentTotal: '120',
      sku: product.sku,
      qty: '1',
      unit: 'NIU',
      lineAmount: '100',
    },
  ]);

  const byNumber = (doc: string) => {
    const found = pre.documents.find((d) => `${d.series}-${d.number}` === doc);
    expect(found, `el preview no trae ${doc}`).toBeDefined();
    return found!;
  };
  const goods = byNumber(goodsDoc);
  expect(issuesOf(goods)).toEqual([]);
  expect(goods.total).toBe('85.00');
  const coil = byNumber(coilDoc);
  expect(issuesOf(coil)).toEqual([]);
  expect(coil.total).toBe('5227.59');
  const wrong = byNumber(wrongDoc);
  expect(issuesOf(wrong).join(' ')).toMatch(
    /El total del archivo con IGV \(120\.00\) no cuadra con el recalculado con IGV \(118\.00\): diferencia 2\.00/,
  );

  // Confirmar los dos que están bien.
  const result = await postJson<PurchaseImportResultDto>(api, '/api/imports/purchases', {
    documents: [goods, coil],
    fileName: 'compras.csv',
    idempotencyKey: `e2e-d359-${n}`,
  });
  expect(result.purchases).toHaveLength(2);
  const purchaseOf = (doc: string) =>
    getJson<PurchaseRow>(
      api,
      `/api/purchases/${result.purchases.find((p) => p.document === doc)!.id}`,
    );

  // El total del papel al céntimo; el subtotal con todos los decimales del precio.
  const goodsPurchase = await purchaseOf(goodsDoc);
  expect(goodsPurchase).toMatchObject({
    status: 'DRAFT',
    subtotal: '72.0300',
    igv: '12.9700',
    total: '85.0000',
  });
  expect(goodsPurchase.items[0]).toMatchObject({ unitPrice: '0.1441', subtotal: '72.0300' });

  // Corregir el número no recalcula los importes.
  const renumbered = await api.patch(`/api/purchases/${goodsPurchase.id}/document`, {
    data: { series: goodsPurchase.series, number: `${goodsPurchase.number}9` },
  });
  expect(renumbered.ok(), await renumbered.text()).toBe(true);
  expect(await getJson<PurchaseRow>(api, `/api/purchases/${goodsPurchase.id}`)).toMatchObject({
    subtotal: '72.0300',
    igv: '12.9700',
    total: '85.0000',
  });

  // Recibir: el kardex del producto entra por el subtotal (TC 1), no por 500 × 0.1441 = 72.05.
  await postJson(api, `/api/purchases/${goodsPurchase.id}/receive`, {});
  const productMoves = await getJson<{ items: Movement[] }>(
    api,
    `/api/inventory/movements?itemType=PRODUCT&itemId=${product.id}`,
  );
  expect(productMoves.items.find((m) => m.refType === 'PURCHASE')).toMatchObject({
    type: 'IN',
    qty: '500.000',
    unitCost: '0.1441',
    totalCost: '72.0300',
  });

  // La bobina en dólares: importe del papel, y kardex = subtotal × TC al céntimo.
  const coilPurchase = await purchaseOf(coilDoc);
  expect(coilPurchase).toMatchObject({ subtotal: '4430.1600', total: '5227.5900' });
  await postJson(api, `/api/purchases/${coilPurchase.id}/receive`, {});
  const coils = await getJson<{ items: CoilDto[] }>(
    api,
    `/api/coils?finishId=${finish.id}&pageSize=50`,
  );
  const received = coils.items.find((c) => c.purchaseId === coilPurchase.id);
  expect(received).toBeDefined();
  // 4430.16 × 3.745 = 16590.9492 → al céntimo.
  const expectedPen = cents(new Decimal('4430.16').times('3.745'));
  expect(received!.totalCost).toBe('4430.1600');
  expect(received!.totalCostPen).toBe(expectedPen.toFixed(4));
  const coilMoves = await getJson<{ items: Movement[] }>(
    api,
    `/api/inventory/movements?itemType=COIL&itemId=${received!.id}`,
  );
  expect(coilMoves.items.find((m) => m.refType === 'PURCHASE')).toMatchObject({
    totalCost: expectedPen.toFixed(4),
    unitCost: money(expectedPen.div('4520')).toFixed(4),
  });
  await api.dispose();
});
