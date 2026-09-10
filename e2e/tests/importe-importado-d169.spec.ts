import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import {
  addPayment,
  createInvoice,
  freeLine,
  purgeInvoicingTrail,
  type FiscalDocumentDto,
} from '../helpers/invoicing';
import {
  deactivateTrail,
  postExpectingError,
  today,
  uniqueDocumentNumber,
  type ProductDto,
} from '../helpers/production';
import {
  commitExpectingError,
  commitImport,
  customerCell,
  documentKey,
  previewImport,
  toEditedInput,
  toInput,
  type SheetRow,
} from '../helpers/quotation-import';
import {
  createCustomer,
  createSellableProduct,
  purgeSalesTrail,
  updateQuotationBody,
  type CustomerDto,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-169 — el importe de un comprobante importado se copia, no se recalcula.**
 *
 * El defecto, en una línea: el archivo trae el **importe** de la línea (la columna «VALOR DE
 * VENTA»), no el unitario. El ERP dividía ese importe entre la cantidad, redondeaba el unitario
 * a cuatro decimales y volvía a multiplicar — y eso **no devuelve el importe**. La diferencia
 * es minúscula por línea y crece con la cantidad, así que en las líneas de miles de kilos, que
 * son las normales en acero, el ERP y el papel decían cifras distintas.
 *
 * El daño no se veía en la cotización sino tres pantallas más adelante, en la cobranza: un
 * comprobante de S/ 117.9999 rechazaba un cobro de S/ 118.00 —el importe que decía el papel—
 * con «El cobro excede el saldo pendiente (S/ 118.00)», porque el mensaje redondeaba para
 * mostrar y la comparación no. La factura quedaba sin poder cerrarse nunca por un diezmilésimo.
 *
 * Los casos siguen la cifra por el camino entero: **archivo → cotización → pedido →
 * comprobante**, que es la única forma de comprobar que ninguna de las etapas la vuelve a
 * recalcular, y el cobro en céntimos por separado. Y los tres bordes de la decisión:
 *
 * - **fuera del importador, mandar el importe es un 400** — si no, sería un campo por el que
 *   entra cualquier cifra desde el formulario normal;
 * - **la fila editada en el preview viaja sin importe** y se recalcula desde lo que la persona
 *   tipeó, porque el importe del papel ya no describe esa línea;
 * - **hay un techo de tolerancia por documento**: copiar el importe hace que ninguno se rechace
 *   nunca, y la diferencia contra `cantidad × unitario` es la única señal que queda de que la
 *   fila se leyó bien.
 *
 * El comprobante se cierra por `register-manual` (D-153) y no por el PSE a propósito: lo que se
 * está probando es la aritmética del importe, y colgarla del cupo de la cuenta demo del PSE
 * convertiría un caso de dinero en un caso de infraestructura.
 *
 * Escribe cotizaciones, pedidos y comprobantes: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Importa cotizaciones y emite comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

/** UPVC: compra-venta pura (D-091), sin cotización obligatoria ni producción de por medio. */
const LINE = 'roofing';

/**
 * La línea del caso: **3 500 kg por S/ 4 179.13**.
 *
 * Elegida para que el defecto sea visible sin ser absurdo: `4179.13 / 3500 = 1.19403714…`, que
 * redondeado a los cuatro decimales de dinero da `1.1940`, y `3500 × 1.1940 = 4179.00`. Trece
 * céntimos de diferencia sobre una sola línea, producidos íntegramente por el redondeo del
 * unitario — y por debajo del techo, que para esta cantidad es `3501 × 0.00005 = S/ 0.175`.
 */
const QTY = '3500.000';
const NET_AMOUNT = '4179.13';
const UNIT_PRICE = '1.1940';
/** Lo que el recálculo daba, y que ya no se persiste: `3500 × 1.1940`. */
const RECOMPUTED = '4179.0000';

interface Scenario {
  customer: CustomerDto;
  product: ProductDto;
  supplierId: string;
  purchaseId: string;
}

/** Un SKU en kilos con saldo de sobra: el pedido que nace de la importación tiene que confirmar. */
async function setupScenario(api: APIRequestContext, qty = '9000'): Promise<Scenario> {
  const customer = await createCustomer(api);
  const supplier = await createSupplier(api, { name: 'E2E Proveedor importación D-169' });
  const product = await createSellableProduct(api, {
    lineCode: LINE,
    unit: 'KGM',
    listPricePen: '2.0000',
  });
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: supplier.id,
    businessLine: LINE,
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
        productId: product.id,
        description: 'Material E2E importado por kilo',
        qty,
        unit: 'KGM',
        unitPrice: '1',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  return { customer, product, supplierId: supplier.id, purchaseId: purchase.id };
}

function rowFor(scenario: Scenario, over: Partial<SheetRow> = {}): SheetRow {
  return {
    issueDate: '03/08/2026',
    docType: 'Factura',
    documentKey: documentKey(),
    customer: customerCell(scenario.customer),
    sku: scenario.product.sku,
    productName: 'Material E2E importado por kilo',
    unit: 'KILOGRAMO',
    qty: QTY,
    netAmount: NET_AMOUNT,
    ...over,
  };
}

test.describe('D-169 — el importe del papel manda de punta a punta', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('3 500 kg por S/ 4 179.13: la cotización, el pedido y la línea del comprobante dicen el importe del archivo', async () => {
    const scenario = await setupScenario(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = {
      documentIds: [],
      orderIds: [],
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplierId,
      productIds: [scenario.product.id],
    };
    const quotationIds: string[] = [];

    try {
      // --- 1. El archivo ---
      const row = rowFor(scenario);
      const parsed = await previewImport(api, [row]);
      expect(parsed.rows).toHaveLength(1);
      const previewRow = parsed.rows[0]!;
      expect(previewRow.issues.filter((i) => i.severity === 'error')).toEqual([]);
      // El unitario es una cuenta derivada, y es la que pierde información al redondear.
      expect(previewRow.unitPricePen).toBe(UNIT_PRICE);
      // El importe del papel viaja **aparte**, y es el que manda.
      expect(previewRow.netAmountPen).toBe('4179.1300');

      // --- 2. La cotización ---
      const result = await commitImport(api, [toInput(previewRow)]);
      expect(result).toMatchObject({ quotations: 1, rows: 1 });
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0]);
      expect(mine, 'la cotización importada no aparece en el listado').toBeDefined();
      quotationIds.push(mine!.id);

      const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine!.id}`);
      const quotationLine = quotation.items[0]!;
      // **El corazón de D-169.** Antes acá había 4179.0000 y nadie lo miraba.
      expect(quotationLine.subtotalPen).toBe('4179.1300');
      expect(quotationLine.subtotalPen).not.toBe(RECOMPUTED);
      expect(quotationLine.unitPricePen).toBe(UNIT_PRICE);
      expect(quotationLine.qty).toBe(QTY);
      // 4179.13 × 18% = 752.2434, y el total arrastra la cola de diezmilésimas. **No es un
      // defecto**: es lo que pasa cuando el importe del papel no es divisible por la cantidad,
      // y es exactamente la cola que hacía imposible cobrar el documento.
      expect(quotation.subtotalPen).toBe('4179.1300');
      expect(quotation.igvPen).toBe('752.2434');
      expect(quotation.totalPen).toBe('4931.3734');

      // --- 3. El pedido ---
      await postJson<QuotationDto>(api, `/api/sales/quotations/${mine!.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${mine!.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];
      const orderLine = order.items[0]!;
      expect(orderLine.subtotalPen).toBe('4179.1300');
      expect(order.totalPen).toBe('4931.3734');

      // --- 4. El comprobante ---
      // Línea entera y a su propio precio: el comprobante **copia** el importe del pedido en
      // vez de recalcularlo desde el unitario, que es la misma decisión una pantalla adelante
      // (`invoicing.service.ts`, la rama `fullLine`).
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: orderLine.id, qty: QTY }],
      });
      trail.documentIds = [draft.id];
      expect(draft.items[0]!.subtotalPen).toBe('4179.1300');
      expect(draft.items[0]!.totalPen).toBe('4931.3734');

      const issued = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        {
          series: `F9${String(Math.floor(Math.random() * 90) + 10)}`,
          correlative: Math.floor(Math.random() * 90_000) + 1_000,
        },
      );
      expect(issued.items[0]!.subtotalPen).toBe('4179.1300');
    } finally {
      await purgeInvoicingTrail(api, trail);
      await purgeSalesTrail(api, { quotationIds });
    }
  });

  test('la cabecera del comprobante suma sus propias líneas', async () => {
    /**
     * **Este caso nació marcado `test.fail()`: era un defecto que la suite encontró.**
     *
     * `InvoicingService.createInTx` calculaba el total de la cabecera con
     * `salesTotals(lines.map(l => ({ qty, unitPricePen })))` — recalculando desde el
     * unitario— justo después de que `resolveLines` armara las líneas copiando el importe
     * exacto del pedido, que es lo que D-169 decidió. La línea decía S/ 4 179.13 y la cabecera
     * S/ 4 179.00: el comprobante **no sumaba sus propias líneas**.
     *
     * No era cosmético: la cuenta por cobrar sale de `totalPen`, así que el saldo quedaba 13
     * céntimos **por debajo** del papel y cobrar el importe del papel se rechazaba por exceso
     * — exactamente el daño que D-169 vino a cerrar, sobrevivido una pantalla más adelante. Y
     * pasaba desapercibido: al recalcular desde un unitario redondeado, el total pierde la cola
     * de diezmilésimas y parece «más limpio» que el correcto.
     *
     * Corregido con `sumLineTotals`, que suma subtotal e IGV por separado (nunca totales ya
     * redondeados), acá y en la cabecera de la nota de crédito.
     */
    const scenario = await setupScenario(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = {
      documentIds: [],
      orderIds: [],
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplierId,
      productIds: [scenario.product.id],
    };
    const quotationIds: string[] = [];

    try {
      const parsed = await previewImport(api, [rowFor(scenario)]);
      const result = await commitImport(api, [toInput(parsed.rows[0]!)]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0])!;
      quotationIds.push(mine.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${mine.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${mine.id}/confirm`,
        {},
      );
      trail.orderIds = [order.id];

      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: order.items[0]!.id, qty: QTY }],
      });
      trail.documentIds = [draft.id];

      // La cabecera tiene que ser la suma de las líneas. Hoy devuelve 4179.0000 / 4931.2200.
      expect(draft.subtotalPen).toBe(draft.items[0]!.subtotalPen);
      expect(draft.totalPen).toBe(draft.items[0]!.totalPen);
    } finally {
      await purgeInvoicingTrail(api, trail);
      await purgeSalesTrail(api, { quotationIds });
    }
  });

  test('un saldo con cola de diezmilésimas se cobra con los céntimos del papel', async () => {
    /**
     * **La mitad de D-169 que vive aguas abajo**, y la que se veía como un sistema roto: la
     * cobranza compara el saldo **en céntimos** (`payableBalance`), porque un cobro se hace en
     * céntimos y un saldo con cuatro decimales no es alcanzable.
     *
     * Antes, un comprobante de S/ 139.2399 rechazaba un cobro de S/ 139.24 con «El cobro
     * excede el saldo pendiente (S/ 139.24)» — el mensaje redondeaba para mostrar y la
     * comparación no, así que el sistema pedía exactamente el número que rechazaba, y la
     * factura no se podía cerrar nunca por un diezmilésimo.
     *
     * Se arma con una **línea libre** y no con un documento importado a propósito: D-169
     * arregló la causa (que un importe importado tuviera cola), pero `payableBalance` arregla
     * la **clase entera**, que también alcanza a un precio tipeado a mano. 3 × 39.3333 =
     * 117.9999 de valor; con IGV, 139.2399.
     */
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = { documentIds: [] };

    try {
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('3', '39.3333', 'servicio con cola de diezmilésimas')],
      });
      trail.documentIds = [draft.id];
      expect(draft.subtotalPen).toBe('117.9999');
      expect(draft.totalPen).toBe('139.2399');

      const issued = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        {
          series: `F9${String(Math.floor(Math.random() * 90) + 10)}`,
          correlative: Math.floor(Math.random() * 90_000) + 1_000,
        },
      );
      expect(issued.balancePen).toBe('139.2399');

      // El cliente transfiere lo que se puede transferir: céntimos.
      const paid = await addPayment(api, issued.id, { amountPen: '139.24' });
      expect(paid.payments).toHaveLength(1);
      expect(paid.payments[0]!.amountPen).toBe('139.2400');
      // Y el documento queda saldado: el diezmilésimo de más lo absorbe `documentBalance`,
      // que nunca devuelve negativo.
      expect(Number(paid.balancePen)).toBeLessThanOrEqual(0);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('fuera del importador, mandar el importe de línea es un 400', async () => {
    /**
     * Copiar el importe sin recalcularlo es seguro **porque solo el importador puede hacerlo**.
     * Si el formulario normal pudiera mandarlo, sería un campo por el que entra cualquier cifra
     * sin que ninguna cuenta la contradiga.
     */
    const scenario = await setupScenario(api, '100');

    try {
      const rejected = await postExpectingError(api, '/api/sales/quotations', {
        customerId: scenario.customer.id,
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: '10',
            unitPricePen: '2.0000',
            netAmountPen: '999.0000',
          },
        ],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('importador de comprobantes');
    } finally {
      await deactivateTrail(api, {
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplierId,
        productIds: [scenario.product.id],
      });
    }
  });

  test('la fila que el usuario editó en el preview viaja sin importe y se recalcula', async () => {
    /**
     * La ausencia del campo **significa algo**: esta fila ya no responde al importe del papel.
     * Mandarlo igual habría hecho que corregir el precio no cambiara el importe, y el rechazo
     * por tolerancia habría culpado al archivo de una diferencia que introdujo la corrección.
     */
    const scenario = await setupScenario(api, '100');
    const quotationIds: string[] = [];

    try {
      const parsed = await previewImport(api, [
        rowFor(scenario, { qty: '10.000', netAmount: '1000.00' }),
      ]);
      const previewRow = parsed.rows[0]!;
      expect(previewRow.unitPricePen).toBe('100.0000');
      expect(previewRow.netAmountPen).toBe('1000.0000');

      // El usuario corrige el precio en la tabla: 90 en vez de 100.
      const result = await commitImport(api, [
        toEditedInput(previewRow, { unitPricePen: '90.0000' }),
      ]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0])!;
      quotationIds.push(mine.id);

      const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine.id}`);
      // Manda lo que la persona tipeó: 10 × 90 = 900, no los 1 000 del archivo.
      expect(quotation.items[0]!.unitPricePen).toBe('90.0000');
      expect(quotation.items[0]!.subtotalPen).toBe('900.0000');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, {
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplierId,
        productIds: [scenario.product.id],
      });
    }
  });

  test('un importe que el redondeo no puede explicar rebota nombrando el documento y la peor fila', async () => {
    /**
     * El techo. Sin él, copiar el importe convertiría al importador en un canal por el que entra
     * cualquier cifra: la diferencia contra `cantidad × unitario` es la única señal que queda de
     * que la fila se leyó bien —un cero de más en la cantidad, o el precio con IGV en la columna
     * del valor—.
     */
    const scenario = await setupScenario(api, '100');

    try {
      const parsed = await previewImport(api, [
        rowFor(scenario, { qty: '10.000', netAmount: '1000.00' }),
      ]);
      const previewRow = parsed.rows[0]!;

      // Se manda el archivo con el importe manipulado: 1 180 en vez de 1 000 (el precio con
      // IGV en la columna del valor, que es el error real que esto atrapa). El redondeo de
      // diez unidades explica como mucho S/ 0.10.
      const rejected = await commitExpectingError(api, [
        { ...toInput(previewRow), netAmountPen: '1180.0000' },
      ]);
      expect(rejected.status).toBe(400);
      expect(rejected.body).toContain('no entraron');
      // El rechazo nombra el documento y las dos cifras: la corrección es del archivo, y quien
      // lo recibe tiene que poder abrir esa fila del Excel y ver cuál columna está mal.
      expect(rejected.body).toContain(previewRow.documentKey);
      expect(rejected.body).toContain('1180.00');
      expect(rejected.body).toContain('1000.00');
    } finally {
      await deactivateTrail(api, {
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplierId,
        productIds: [scenario.product.id],
      });
    }
  });

  test('editar una cotización importada conserva el importe de las líneas que no cambiaron', async () => {
    /**
     * La reapertura es el otro lugar por el que el importe se podía perder: `PUT` reemplaza las
     * líneas completas (RF-66), así que sin nada que las reconozca, guardar sin tocar nada
     * habría recalculado las cuatro cifras y deshecho la importación entera en silencio.
     *
     * Lo que se conserva es el importe de la línea cuyo **producto, cantidad y precio** no
     * cambiaron; cualquier otra cosa vuelve al recálculo.
     */
    const scenario = await setupScenario(api);
    const quotationIds: string[] = [];

    try {
      const parsed = await previewImport(api, [rowFor(scenario)]);
      const result = await commitImport(api, [toInput(parsed.rows[0]!)]);
      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0])!;
      quotationIds.push(mine.id);

      const before = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine.id}`);
      expect(before.items[0]!.subtotalPen).toBe('4179.1300');

      // Se reabre y se guarda **sin tocar la línea**: solo cambia el cliente del documento.
      const other = await createCustomer(api);
      const res = await api.put(`/api/sales/quotations/${mine.id}`, {
        data: updateQuotationBody({
          customerId: other.id,
          issueDate: before.issueDate,
          items: [
            {
              productId: before.items[0]!.productId,
              qty: before.items[0]!.qty,
              unitPricePen: before.items[0]!.unitPricePen,
            },
          ],
        }),
      });
      expect(res.ok(), `la edición falló: ${await res.text()}`).toBe(true);
      const after = (await res.json()) as QuotationDto;

      // El importe sobrevive: producto, cantidad y precio son los mismos.
      expect(after.items[0]!.subtotalPen).toBe('4179.1300');
      expect(after.totalPen).toBe('4931.3734');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, {
        purchaseId: scenario.purchaseId,
        supplierId: scenario.supplierId,
        productIds: [scenario.product.id],
      });
    }
  });
});
