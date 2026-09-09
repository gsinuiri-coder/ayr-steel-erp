import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems, getJson, postJson } from '../helpers/api';
import { setupPosStock } from '../helpers/pos';
import { createCatalogProduct, randomLetters, type ProductDto } from '../helpers/production';
import { createCustomer, type CustomerDto } from '../helpers/sales';

/**
 * Importador masivo de cotizaciones (D-152, D-157, D-158).
 *
 * Lo que estos casos protegen, en una línea: **la carga histórica entra por la misma puerta que
 * una venta normal**. El importador no escribe contra la tabla — llama a
 * `QuotationsService.createInTx`, la misma del formulario— así que hereda sus validaciones en
 * vez de copiarlas, que es exactamente lo que los importadores que D-150 borró no hacían.
 *
 * Los cinco comportamientos que no se pueden aflojar:
 *
 * - **Cero creación silenciosa**: un cliente o un SKU que no está en el maestro detiene su fila.
 * - **Todo o nada**: una fila mala deja el archivo entero sin escribir, y eso se comprueba
 *   contando cotizaciones antes y después, no leyendo el mensaje.
 * - **La edición del preview manda**: lo que se confirma es lo que el usuario dejó en la tabla,
 *   no lo que el archivo decía.
 * - **Una fila quitada no entra**, y si era la única de su comprobante, ese comprobante tampoco.
 * - **D-157: la cotización importada nace sin vencimiento y se puede confirmar** por más viejo
 *   que sea el comprobante que la originó. Es la decisión entera en un caso: sin él, el
 *   `validUntil < hoy` que la rechazaba puede volver sin que nadie se entere, y la carga
 *   histórica queda otra vez en un callejón —cotizaciones creadas que no se pueden convertir—.
 *
 * Se usa CSV y no xlsx a propósito: el endpoint acepta los dos y `parseSpreadsheet` trata el csv
 * como texto UTF-8 (el defecto de la Fase 1 con los encabezados con tilde), así que el archivo
 * del test se arma sin depender de ninguna librería.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea clientes, productos y cotizaciones: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

const HEADERS = [
  'F. EMISIÓN',
  'TIPO COMPROBANTE',
  'SERIE - NÚMERO',
  'CLIENTE',
  'MONEDA',
  'TIPOCAMBIO',
  'DOCUMENTO AJUSTADO',
  'CÓDIGO PRODUCTO',
  'NOMBRE PRODUCTO',
  'UNIDAD MEDIDA',
  'CANTIDAD',
  'VALOR DE VENTA',
];

interface SheetRow {
  issueDate: string;
  docType: string;
  documentKey: string;
  customer: string;
  currency?: string;
  exchangeRate?: string;
  adjusted?: string;
  sku: string;
  productName: string;
  unit: string;
  qty: string;
  netAmount: string;
}

function csvOf(rows: readonly SheetRow[]): string {
  const body = rows.map((r) =>
    [
      r.issueDate,
      r.docType,
      r.documentKey,
      r.customer,
      r.currency ?? 'Soles',
      r.exchangeRate ?? '',
      r.adjusted ?? '',
      r.sku,
      r.productName,
      r.unit,
      r.qty,
      r.netAmount,
    ].join(','),
  );
  return [HEADERS.join(','), ...body].join('\n');
}

interface PreviewRow {
  rowNumber: number;
  documentKey: string;
  issueDate: string;
  customerId: string | null;
  productId: string | null;
  qty: string;
  unitPricePen: string;
  rawSku: string;
  needsPieces: boolean;
  issues: { field: string; severity: 'error' | 'warning'; message: string }[];
  excludedReason: string | null;
}

interface PreviewDto {
  fileName: string;
  rows: PreviewRow[];
  quotations: number;
  excluded: number;
  withIssues: number;
}

async function preview(api: APIRequestContext, rows: readonly SheetRow[]): Promise<PreviewDto> {
  const res = await api.post('/api/imports/quotations/preview', {
    multipart: {
      file: {
        name: 'ventas.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvOf(rows), 'utf8'),
      },
    },
  });
  expect(res.ok(), `la previsualización falló: ${await res.text()}`).toBe(true);
  return (await res.json()) as PreviewDto;
}

/** Lo que el navegador manda de vuelta: la fila del preview, ya resuelta. */
function toInput(row: PreviewRow): Record<string, unknown> {
  return {
    rowNumber: row.rowNumber,
    documentKey: row.documentKey,
    issueDate: row.issueDate,
    customerId: row.customerId,
    productId: row.productId,
    qty: row.qty,
    unitPricePen: row.unitPricePen,
  };
}

interface QuotationListItem {
  id: string;
  code: string;
  status: string;
  customerName: string;
  totalPen: string;
}

async function quotationCount(api: APIRequestContext): Promise<number> {
  return (await getItems<QuotationListItem>(api, '/api/sales/quotations')).length;
}

test.describe('D-152 — importador masivo de cotizaciones', () => {
  let api: APIRequestContext;
  let customer: CustomerDto;
  let product: ProductDto;
  const created: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    customer = await createCustomer(api);
    product = await createCatalogProduct(api, { source: 'PURCHASED' });
  });

  test.afterAll(async () => {
    for (const id of created) {
      await api
        .post(`/api/sales/quotations/${id}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
        .catch(() => undefined);
    }
    await api.dispose();
  });

  const line = (over: Partial<SheetRow> = {}): SheetRow => ({
    issueDate: '03/08/2026',
    docType: 'Factura',
    documentKey: `FFA1-${String(Math.floor(Math.random() * 900000) + 100000)}`,
    customer: `${customer.docNumber} - ${customer.name.replace(/,/g, ' ')}`,
    sku: product.sku,
    productName: product.name.replace(/,/g, ' '),
    unit: 'UNIDAD',
    qty: '10.000',
    netAmount: '1000.00',
    ...over,
  });

  test('importación feliz: un comprobante por cotización, con su número en las observaciones', async () => {
    const first = line({ documentKey: `FFA1-${randomLetters(4)}` });
    const second = line({
      documentKey: `FFA1-${randomLetters(4)}`,
      qty: '4.000',
      netAmount: '600.00',
    });
    // Dos líneas del mismo comprobante: tienen que terminar en **una sola** cotización.
    const secondLineOfFirst = { ...first, qty: '2.000', netAmount: '250.00' };

    const parsed = await preview(api, [first, secondLineOfFirst, second]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.quotations).toBe(2);
    expect(parsed.withIssues).toBe(0);
    // El precio unitario no viene en el archivo: sale de valor de venta ÷ cantidad.
    expect(parsed.rows[0]!.unitPricePen).toBe('100.0000');
    expect(parsed.rows[1]!.unitPricePen).toBe('125.0000');
    // La fecha del papel, no la de hoy: es lo que ubica la cotización en agosto (D-124).
    expect(parsed.rows[0]!.issueDate).toBe('2026-08-03');

    const result = await postJson<{ quotations: number; rows: number; codes: string[] }>(
      api,
      '/api/imports/quotations',
      { rows: parsed.rows.map(toInput) },
    );
    expect(result).toMatchObject({ quotations: 2, rows: 3 });
    expect(result.codes).toHaveLength(2);

    const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
    const mine = all.filter((q) => result.codes.includes(q.code));
    created.push(...mine.map((q) => q.id));
    expect(mine).toHaveLength(2);
    // **En borrador**: el importador no emite ni confirma, así que no compromete inventario.
    expect(mine.every((q) => q.status === 'DRAFT')).toBe(true);

    // El número del comprobante externo queda en las observaciones, con formato reconocible.
    const detail = await getJson<{ notes: string | null; items: { qty: string }[] }>(
      api,
      `/api/sales/quotations/${mine[0]!.id}`,
    );
    expect(detail.notes).toContain('Factura externa: ');
  });

  test('un cliente que no está en el maestro detiene su fila, y la tanda entera no se escribe', async () => {
    const good = line({ documentKey: `FFA1-${randomLetters(4)}` });
    const orphan = line({
      documentKey: `FFA1-${randomLetters(4)}`,
      customer: '20999999999 - CLIENTE QUE NO EXISTE S.A.C.',
    });

    const parsed = await preview(api, [good, orphan]);
    const orphanRow = parsed.rows.find((r) => r.documentKey === orphan.documentKey)!;
    // Cero creación silenciosa: no se inventa el cliente, se marca la fila.
    expect(orphanRow.customerId).toBeNull();
    expect(orphanRow.issues.some((i) => i.field === 'customer' && i.severity === 'error')).toBe(
      true,
    );
    expect(parsed.withIssues).toBe(1);

    const before = await quotationCount(api);

    // Se manda igual, con un cliente inventado que sí tiene forma de uuid: es lo que haría un
    // cliente HTTP que se saltara la pantalla, y el API tiene que cortarlo.
    const res = await api.post('/api/imports/quotations', {
      data: {
        rows: parsed.rows.map((r) => ({
          ...toInput(r),
          customerId: r.customerId ?? '00000000-0000-4000-8000-000000000000',
        })),
      },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { message: string; errors?: Record<string, string[]> };
    expect(body.message).toContain('no entraron');
    expect(Object.keys(body.errors ?? {})).toEqual([orphan.documentKey]);

    // **Lo que de verdad prueba el todo o nada:** la fila buena tampoco se escribió.
    expect(await quotationCount(api)).toBe(before);
  });

  test('lo editado en el preview es lo que se guarda, y una fila quitada no entra', async () => {
    const unknownSku = line({
      documentKey: `FFA1-${randomLetters(4)}`,
      sku: `NOEXISTE-${randomLetters(5)}`,
    });
    const dropped = line({ documentKey: `FFA1-${randomLetters(4)}` });

    const parsed = await preview(api, [unknownSku, dropped]);
    const fixable = parsed.rows.find((r) => r.documentKey === unknownSku.documentKey)!;
    expect(fixable.productId).toBeNull();
    expect(fixable.issues.some((i) => i.field === 'product' && i.severity === 'error')).toBe(true);

    // Se corrige el producto a mano —lo que la pantalla hace con el desplegable— y se quita la
    // otra fila entera.
    const result = await postJson<{ quotations: number; codes: string[] }>(
      api,
      '/api/imports/quotations',
      {
        rows: [
          { ...toInput(fixable), productId: product.id, qty: '7.000', unitPricePen: '33.0000' },
        ],
      },
    );
    expect(result.quotations).toBe(1);

    const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
    const mine = all.filter((q) => result.codes.includes(q.code));
    created.push(...mine.map((q) => q.id));
    expect(mine).toHaveLength(1);

    // El comprobante de la fila quitada no existe en ninguna cotización.
    const detail = await api
      .get(`/api/sales/quotations/${mine[0]!.id}`)
      .then((r) => r.json() as Promise<{ notes: string | null; items: { qty: string }[] }>);
    expect(detail.notes).toContain(unknownSku.documentKey);
    // Y lo que se guardó es lo editado (7 unidades a 33), no lo que traía el archivo.
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.qty).toBe('7.000');
  });

  test('D-157: la cotización importada nace sin vencimiento y se emite y confirma aunque el papel sea de hace meses', async () => {
    /**
     * **El caso que justifica D-157.** El importador carga comprobantes que ya se vendieron:
     * un papel de marzo no tiene vigencia que respetar. Mientras `validUntil` fue obligatorio
     * había que elegir entre dos mentiras —una vigencia inventada, o una cotización que nace
     * vencida— y la segunda era además un callejón: `confirm()` comparaba `validUntil < hoy`
     * y rechazaba la cotización en el paso siguiente a haberla creado.
     *
     * Se comprueba el ciclo completo (importar → emitir → confirmar) y no solo el `null` en la
     * fila, porque el `null` por sí solo no prueba nada: lo que se rompía era la confirmación,
     * y hay tres lugares distintos que leen esa fecha (`effectiveStatus`, el DTO y `confirm`).
     *
     * El producto llega **con saldo** a propósito: confirmar reserva contra el disponible
     * (D-054), así que sin stock el pedido se caería por un motivo que no tiene nada que ver
     * con la vigencia y el caso pasaría a probar otra cosa.
     */
    const stock = await setupPosStock(api, { qty: '40' });
    const documentKey = `FFA1-${randomLetters(4)}`;
    const orderIds: string[] = [];
    const quotationIds: string[] = [];

    try {
      const parsed = await preview(api, [
        line({
          documentKey,
          // Casi seis meses atrás: muy por fuera de cualquier vigencia por defecto.
          issueDate: '15/03/2026',
          sku: stock.product.sku,
          productName: stock.product.name.replace(/,/g, ' '),
          qty: '10.000',
          netAmount: '500.00',
        }),
      ]);
      expect(parsed.rows[0]!.issueDate).toBe('2026-03-15');
      expect(parsed.rows[0]!.customerId).toBe(customer.id);
      expect(parsed.rows[0]!.issues.filter((i) => i.severity === 'error')).toEqual([]);

      const result = await postJson<{ codes: string[]; createdCustomers: string[] }>(
        api,
        '/api/imports/quotations',
        { rows: parsed.rows.map(toInput) },
      );
      const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
      const mine = all.find((q) => result.codes.includes(q.code))!;
      quotationIds.push(mine.id);
      // D-158: nada se dio de alta desde el padrón — el cliente ya estaba en el maestro.
      expect(result.createdCustomers).toEqual([]);

      // 1. Nace **sin** vencimiento, y sin vencimiento no vence: `isExpired` es la bandera que
      //    la pantalla usa para pintarla en rojo, y un `null` leído como cadena vacía la
      //    dejaría "vencida desde siempre".
      const draft = await getJson<{
        status: string;
        validUntil: string | null;
        isExpired: boolean;
      }>(api, `/api/sales/quotations/${mine.id}`);
      expect(draft.status).toBe('DRAFT');
      expect(draft.validUntil).toBeNull();
      expect(draft.isExpired).toBe(false);

      // 2. Emitida sigue EMITIDA: `effectiveStatus` no la degrada a EXPIRED al vuelo.
      await postJson(api, `/api/sales/quotations/${mine.id}/emit`);
      const emitted = await getJson<{ status: string; validUntil: string | null }>(
        api,
        `/api/sales/quotations/${mine.id}`,
      );
      expect(emitted.status).toBe('EMITTED');
      expect(emitted.validUntil).toBeNull();

      // 3. **Y se confirma**, que es lo que la regla vieja impedía.
      const order = await postJson<{ id: string; code: string; status: string }>(
        api,
        `/api/sales/quotations/${mine.id}/confirm`,
        {},
      );
      orderIds.push(order.id);
      expect(order.status).toBe('CONFIRMED');
    } finally {
      for (const id of orderIds) {
        await api
          .post(`/api/sales/orders/${id}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
          .catch(() => undefined);
      }
      for (const id of quotationIds) {
        await api
          .post(`/api/sales/quotations/${id}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api
        .post(`/api/purchases/${stock.purchaseId}/cancel`, {
          data: { reason: 'Limpieza de prueba E2E' },
        })
        .catch(() => undefined);
      await api
        .patch(`/api/catalog/${stock.product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/suppliers/${stock.supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  });

  test('una nota de crédito no se importa y el preview dice por qué', async () => {
    const parsed = await preview(api, [
      line({ documentKey: `FFC1-${randomLetters(4)}`, docType: 'Nota Crédito' }),
    ]);
    expect(parsed.excluded).toBe(1);
    expect(parsed.quotations).toBe(0);
    expect(parsed.rows[0]!.excludedReason).toContain('ajuste de otro comprobante');
  });

  test('un archivo que no es el export se rechaza nombrando las columnas que faltan', async () => {
    const res = await api.post('/api/imports/quotations/preview', {
      multipart: {
        file: {
          name: 'otra-cosa.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('COLUMNA A,COLUMNA B\n1,2', 'utf8'),
        },
      },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('SERIE - NÚMERO');
  });
});
