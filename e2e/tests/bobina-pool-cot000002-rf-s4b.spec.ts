import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import { insertLegacyCoilProduct } from '../helpers/db';
import {
  commitImport,
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

test.describe.configure({ timeout: 240_000 });

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
});
