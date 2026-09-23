import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import { breakQuotationLineForTest, insertLegacyCoilProduct } from '../helpers/db';
import {
  commitImport,
  csvOf,
  customerCell,
  documentKey,
  previewImport,
  toInput,
  type SheetRow,
} from '../helpers/quotation-import';
import { buyRoofingCoil, createColor, createRoofingFinish } from '../helpers/roofing';
import {
  createCustomer,
  purgeSalesTrail,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **RF-S4b — centinela de COT-000002 (FFA1-1350), con números sintéticos idénticos a los reales.**
 *
 * Lo que pasó en producción: el archivo de agosto trae `BOB38AZUL`, 4194 kg, valor 12439.831,
 * IGV 2239.169, precio 14679.000. El catálogo tenía un producto `BOB38AZUL` cargado a mano —sin
 * saldo y sin ninguna bobina detrás— y el importador enganchó la línea ahí, así que confirmar
 * rebotaba con «BOB38AZUL tiene 0.000 KGM disponibles». La bobina de 4194 kg existía.
 *
 * Lo que tiene que pasar (R1, D-252/D-254): el código del origen se normaliza al SKU canónico
 * `BOB038<color>`, su disponibilidad es el pool de bobinas de ese espesor y color, y como hay
 * una sola candidata la línea se ata sola a ella. Y (R2, D-255) los importes del papel se guardan
 * tal cual: el pedido cuadra 14679.00 sin que nadie lo toque.
 */

test.describe.configure({ timeout: 600_000 });

const QTY = '4194.000';

test.describe('RF-S4b — un código de bobina del origen resuelve al pool, no a un producto suelto', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('COT-000002: BOB38<color> se ata a la única bobina de 4194 kg y el pedido cuadra 14679.00', async () => {
    const color = await createColor(api, '#0e4c96');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor RF-S4b pool' });
    const { coil } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '4194',
      thicknessMm: '0.38',
      widthMm: '1200',
    });
    const customer = await createCustomer(api);
    // El dato heredado: un `BOB…` suelto con el código tal como lo escribe el origen.
    const sourceCode = `BOB38${color.code}`;
    await insertLegacyCoilProduct(sourceCode, `Bobina suelta heredada ${color.code}`);

    const quotationIds: string[] = [];
    const orderIds: string[] = [];
    try {
      const row: SheetRow = {
        issueDate: '07/08/2026',
        docType: 'Factura',
        documentKey: documentKey(),
        customer: customerCell(customer),
        sku: sourceCode,
        productName: `BOBINA ALUZINC ${color.code} 0.38 X 1200 RAL 5002`,
        unit: 'KILOGRAMO',
        qty: '4194.0000000000',
        netAmount: '12439.831',
        igv: '2239.169',
        totalAmount: '14679.000',
      };
      const parsed = await previewImport(api, [row]);
      const previewRow = parsed.rows[0]!;
      expect(previewRow.issues.filter((i) => i.severity === 'error')).toEqual([]);
      // R1: el canónico, nunca el producto suelto que coincide letra por letra con el origen.
      expect(previewRow.productSku).toBe(`BOB038${color.code}`);
      expect(previewRow.saleCoilId).toBe(coil.id);

      const result = await commitImport(api, [toInput(previewRow)]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0]);
      expect(mine).toBeDefined();
      quotationIds.push(mine!.id);

      const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine!.id}`);
      expect(quotation.items[0]!.reserveItemId).toBe(coil.id);
      expect(quotation.items[0]!.qty).toBe(QTY);
      // R2: los tres importes del papel, tal cual.
      expect(quotation.items[0]!.subtotalPen).toBe('12439.8310');
      expect(quotation.items[0]!.igvPen).toBe('2239.1690');
      expect(quotation.totalPen).toBe('14679.0000');

      // Confirmar ya no rebota por «0.000 KGM disponibles»: reserva la bobina del pool.
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${mine!.id}/confirm`,
        {},
      );
      orderIds.push(order.id);
      expect(order.items[0]!.reserveItemType).toBe('COIL');
      expect(order.items[0]!.reserveItemId).toBe(coil.id);
      expect(order.totalPen).toBe('14679.0000');
    } finally {
      await purgeSalesTrail(api, { orderIds, quotationIds });
    }
  });

  test('el barrido encuentra COT-000002 tal como quedó en producción y la deja confirmable, sin tocarla a mano', async ({
    baseURL,
  }) => {
    const color = await createColor(api, '#0e4c96');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor RF-S4b barrido' });
    const { coil } = await buyRoofingCoil(api, {
      supplierId: supplier.id,
      finishId: finish.id,
      colorId: color.id,
      weightKg: '4194',
      thicknessMm: '0.38',
      widthMm: '1200',
    });
    const customer = await createCustomer(api);
    const sourceCode = `BOB38${color.code}`;
    const looseId = await insertLegacyCoilProduct(
      sourceCode,
      `Bobina suelta heredada ${color.code}`,
    );

    const quotationIds: string[] = [];
    const orderIds: string[] = [];
    try {
      const row: SheetRow = {
        issueDate: '07/08/2026',
        docType: 'Factura',
        documentKey: documentKey(),
        customer: customerCell(customer),
        sku: sourceCode,
        productName: `BOBINA ALUZINC ${color.code} 0.38 X 1200 RAL 5002`,
        unit: 'KILOGRAMO',
        qty: '4194.0000000000',
        netAmount: '12439.831',
        igv: '2239.169',
        totalAmount: '14679.000',
      };
      const parsed = await previewImport(api, [row]);
      const result = await commitImport(api, [toInput(parsed.rows[0]!)]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const quotation = listed.items.find((q) => q.code === result.codes[0])!;
      quotationIds.push(quotation.id);

      // Lo que pasó en producción: el importador de antes la enganchó al suelto, y la edición con
      // precio con IGV 3.5 la dejó en 12439.82 / 14678.99.
      await breakQuotationLineForTest(quotation.id, {
        productId: looseId,
        unitPricePen: '2.9661',
        subtotalPen: '12439.8234',
        igvPen: '2239.1682',
        totalPen: '14678.9916',
      });

      const file = path.join(test.info().outputDir, 'ventas.csv');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, csvOf([row]), 'utf8');

      // --- Dry-run: (a) y (b) sobre esta cotización, con la bobina a la que se va a atar ---
      const report = sweep(file, []) as SweepReportDto;
      const doc = report.documents.find((d) => d.id === quotation.id);
      expect(doc?.open).toBe(true);
      expect(doc?.findings[0]?.product?.autoCoilId).toBe(coil.id);
      expect(doc?.findings[0]?.amounts?.paper).toEqual({
        net: '12439.8310',
        igv: '2239.1690',
        total: '14679.0000',
      });

      // --- Execute: corrige los abiertos ---
      const run = sweep(file, ['--execute']) as { fixed: { code: string }[] };
      expect(run.fixed.map((f) => f.code)).toContain(quotation.code);
      // Un contexto nuevo después de la CLI: el anterior quedó ~2 minutos ocioso mientras la CLI
      // compilaba y corría, y su primera petición moría con ECONNRESET en tres corridas seguidas
      // (el servidor ya había cerrado el socket keep-alive; un `fetch` nuevo contestaba 200 en
      // el acto). Es de la conexión, no del barrido.
      const fresh = await adminApi(baseURL!);
      const fixed = await getJson<QuotationDto>(fresh, `/api/sales/quotations/${quotation.id}`);
      expect(fixed.items[0]!.reserveItemType).toBe('COIL');
      expect(fixed.items[0]!.reserveItemId).toBe(coil.id);
      expect(fixed.totalPen).toBe('14679.0000');

      // El criterio de éxito del dueño: se confirma contra el pool y cuadra 14679.00.
      const order = await postJson<SalesOrderDto>(
        fresh,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      orderIds.push(order.id);
      expect(order.items[0]!.reserveItemId).toBe(coil.id);
      expect(order.totalPen).toBe('14679.0000');
      await fresh.dispose();
    } finally {
      await purgeSalesTrail(api, { orderIds, quotationIds });
    }
  });
});

interface SweepReportDto {
  documents: {
    id: string;
    open: boolean;
    findings: {
      product: { autoCoilId: string | null } | null;
      amounts: { paper: { net: string; igv: string | null; total: string | null } } | null;
    }[];
  }[];
}

/** La CLI real del barrido contra la base de pruebas, con el reporte en JSON. */
function sweep(file: string, args: string[]): unknown {
  const res = spawnSync(
    'node',
    [
      'scripts/sweep-imported-documents.mjs',
      '--branch',
      'local-e2e',
      '--file',
      file,
      '--json',
      ...args,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 },
  );
  expect(res.status, `el barrido falló:\n${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '');
}
