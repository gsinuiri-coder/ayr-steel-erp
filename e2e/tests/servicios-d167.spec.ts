import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getJson, postJson } from '../helpers/api';
import { DISPATCH_LINE, dispatchOrder, purgeInvoicingTrail } from '../helpers/invoicing';
import {
  createCatalogProduct,
  deactivateTrail,
  errorFrom,
  postExpectingError,
  today,
  type ProductDto,
} from '../helpers/production';
import {
  commitImport,
  customerCell,
  documentKey,
  previewImport,
  toInput,
} from '../helpers/quotation-import';
import {
  buyCoilForSale,
  createCustomer,
  createDirectOrder,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
  stockPanel,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * **D-167 — una línea de negocio sin inventario se cotiza y se vende.**
 *
 * Lo que estos casos protegen, en una línea: **una línea `NOOP` no es una línea sin stock; es
 * una línea a la que la pregunta «cuánto hay» no se le hace.** Mientras la respuesta vivió solo
 * dentro de `InventoryService`, vender un servicio se rechazaba antes de llegar ahí —«es de una
 * línea sin inventario: no se cotiza»— y un servicio (conformado, corte de terceros, flete) es
 * justamente lo que una empresa de transformación factura todo el tiempo.
 *
 * La parte peligrosa de la decisión es la que separa las dos cosas que se parecen: **«no se le
 * pregunta cuánto hay» y «hay cero» tienen que seguir dando resultados distintos.** Por eso el
 * caso del servicio sin stock y el del producto físico sin stock viven en el mismo archivo: el
 * primero pasa, el segundo tiene que seguir muriendo con su mensaje de disponible. Si alguien
 * "simplifica" `carriesInventory` a algo que también exima al producto físico, es el segundo
 * caso el que lo cuenta.
 *
 * Y aguas abajo: el servicio **no se despacha** (no sale nada del almacén, no hay peso que
 * declarar en la guía) y **no frena el cierre del pedido**, que es la otra mitad — sin eso, todo
 * pedido que mezclara mercadería con un conformado quedaba en `PARCIALMENTE DESPACHADO` para
 * siempre, o alguien lo despachaba con un peso inventado.
 *
 * Escribe cotizaciones, pedidos y despachos: nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea cotizaciones, pedidos y despachos: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/** La línea `NOOP` sembrada por defecto (§2.2): la única con `inventoryStrategy = NOOP`. */
const SERVICES_LINE = 'services';

/** Un servicio vendible: conformado, corte de terceros, flete. No tiene ni puede tener stock. */
async function createService(api: APIRequestContext): Promise<ProductDto> {
  return createSellableProduct(api, { lineCode: SERVICES_LINE, listPricePen: '150.0000' });
}

test.describe('D-167 — se cotiza y se vende una línea sin inventario', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('cotizar y confirmar un servicio sin una sola unidad en el almacén pasa, y no abre reserva', async () => {
    const service = await createService(api);
    const customer = await createCustomer(api);
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };

    try {
      // El servicio no tiene kardex: no hay saldo que consultar, y esa es la premisa.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: SERVICES_LINE,
        items: [{ productId: service.id, qty: '3', unitPricePen: '150.0000' }],
      });
      trail.quotationIds.push(quotation.id);
      expect(quotation.items[0]).toMatchObject({
        productId: service.id,
        qty: '3.000',
        subtotalPen: '450.0000',
      });

      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);

      // **El corazón de D-167**: se confirma. Antes moría en la cotización con «es de una línea
      // sin inventario: no se cotiza», y después de eso habría muerto en la reserva con
      // «tiene 0.000 disponibles», que es el mismo callejón un paso más adelante.
      expect(order.status).toBe('CONFIRMED');
      // Y **no** abre reserva: `createReservations` salta estas líneas. Abrirla habría creado
      // la fila de saldo de un ítem que nunca va a tener un movimiento.
      expect(order.reservations).toHaveLength(0);
      expect(order.totalPen).toBe('531.0000');
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, { productIds: [service.id] });
    }
  });

  test('un producto físico sin stock sigue sin poder confirmarse, y el rechazo nombra el disponible', async () => {
    /**
     * El par del caso anterior, y el que hace que `carriesInventory` no se pueda aflojar: el
     * producto de una línea `STOCK` sin saldo tiene que seguir rebotando. Las dos líneas se
     * cotizan igual; lo que cambia es qué pasa al **confirmar**, que es donde se promete
     * material.
     */
    const physical = await createCatalogProduct(api, {
      lineCode: DISPATCH_LINE,
      unit: 'NIU',
      source: 'PURCHASED',
      name: 'Perfil E2E sin stock (D-167)',
    });
    const customer = await createCustomer(api);
    const trail: { quotationIds: string[] } = { quotationIds: [] };

    try {
      // Cotizar sí: la cotización no promete material, solo dice un precio.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ productId: physical.id, qty: '5', unitPricePen: '40.0000' }],
      });
      trail.quotationIds.push(quotation.id);
      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);

      const rejected = await errorFrom(
        await api.post(`/api/sales/quotations/${quotation.id}/confirm`, { data: {} }),
        'confirmar la cotización de un producto físico sin stock',
      );
      expect(rejected.status).toBe(400);
      // El mensaje tiene que seguir hablando de **disponible**: es lo que distingue «no hay»
      // de «no se pregunta».
      expect(rejected.message.toLowerCase()).toContain('disponible');
      expect(rejected.message).toContain(physical.sku);
    } finally {
      await purgeSalesTrail(api, trail);
      await deactivateTrail(api, { productIds: [physical.id] });
    }
  });

  test('un servicio entra por el importador de comprobantes como cualquier otra línea', async () => {
    /**
     * La carga histórica (D-152) es el otro camino por el que un servicio llega a una
     * cotización, y no pasa por el formulario: llama a `QuotationsService.createInTx`, o sea
     * que hereda la misma validación que rechazaba el servicio. Un flete o un conformado son
     * de las líneas más frecuentes de un archivo real de ventas, así que sin esto el mes
     * entero se caía por una fila —el importador es todo o nada—.
     */
    const service = await createService(api);
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const parsed = await previewImport(api, [
        {
          issueDate: '03/08/2026',
          docType: 'Factura',
          documentKey: documentKey(),
          customer: customerCell(customer),
          sku: service.sku,
          productName: 'Servicio de conformado E2E',
          unit: 'UNIDAD',
          qty: '2.000',
          netAmount: '300.00',
        },
      ]);
      const row = parsed.rows[0]!;
      expect(row.productId).toBe(service.id);
      expect(row.issues.filter((i) => i.severity === 'error')).toEqual([]);

      const result = await commitImport(api, [toInput(row)]);
      expect(result).toMatchObject({ quotations: 1, rows: 1 });

      const listed = await getJson<{ items: { id: string; code: string }[] }>(
        api,
        '/api/sales/quotations?pageSize=200',
      );
      const mine = listed.items.find((q) => q.code === result.codes[0])!;
      quotationIds.push(mine.id);
      const quotation = await getJson<QuotationDto>(api, `/api/sales/quotations/${mine.id}`);
      expect(quotation.items[0]!.productId).toBe(service.id);
      expect(quotation.items[0]!.subtotalPen).toBe('300.0000');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, { productIds: [service.id] });
    }
  });

  test('el panel de stock marca el servicio como línea sin inventario en vez de mostrarle un cero', async () => {
    /**
     * La mitad que el web pinta: la celda dice «Servicio · no lleva inventario». Un cero ahí
     * es peor que no decir nada, porque es exactamente lo que muestra un producto agotado — y
     * el vendedor tiene que poder distinguirlos de un vistazo.
     */
    const service = await createService(api);
    const physical = await createCatalogProduct(api, {
      lineCode: DISPATCH_LINE,
      unit: 'NIU',
      source: 'PURCHASED',
      name: 'Perfil E2E sin stock para comparar (D-167)',
    });

    try {
      const panel = await stockPanel(api, { productIds: [service.id, physical.id] });
      const serviceRow = panel.products.find((p) => p.productId === service.id);
      const physicalRow = panel.products.find((p) => p.productId === physical.id);
      expect(serviceRow, 'el servicio no aparece en el panel de stock').toBeDefined();
      expect(physicalRow).toBeDefined();

      // El dato que separa las dos filas, y del que sale el rótulo de la pantalla.
      expect(serviceRow!.carriesInventory).toBe(false);
      expect(physicalRow!.carriesInventory).toBe(true);
      // Los dos tienen disponible cero: el número **no** alcanza para distinguirlos, que es
      // justo por qué hace falta la marca.
      expect(serviceRow!.availableQty).toBe('0.000');
      expect(physicalRow!.availableQty).toBe('0.000');
      // Y un servicio no tiene costo promedio contra el que medir un piso de precio (D-163).
      expect(serviceRow!.minPricePen).toBeNull();
    } finally {
      await deactivateTrail(api, { productIds: [service.id, physical.id] });
    }
  });

  test('un pedido con mercadería y servicio llega a FULFILLED despachando solo la mercadería', async () => {
    /**
     * Las dos mitades de aguas abajo, en un solo camino:
     *
     * - el despacho **rechaza** la línea de servicio, nombrándola («es un servicio y no se
     *   despacha») en vez de pedirle un peso en kilos a un conformado;
     * - y `recomputeOrderStatus` **no la espera**: despachada la mercadería, el pedido queda
     *   `FULFILLED`. Sin esto quedaba `PARTIALLY_FULFILLED` para siempre.
     */
    const stock = await buyCoilForSale(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '300',
      coilStatus: 'OPEN',
    });
    const service = await createService(api);
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = {
      dispatchIds: [],
      orderIds: [],
      coilIds: [stock.coil.id],
      purchaseId: stock.purchaseId,
      supplierId: stock.supplier.id,
      finish: stock.finish,
      productIds: [service.id],
    };

    try {
      // Una línea de mercadería (la bobina entera, RF-73) y una de servicio, en el mismo
      // pedido. D-119 ya permitía mezclar líneas de negocio; lo nuevo es que una de ellas no
      // lleve inventario.
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [
          { saleCoilId: stock.coil.id, qty: '300.000', unitPricePen: '8.0000' },
          { productId: service.id, qty: '1', unitPricePen: '150.0000' },
        ],
      });
      trail.orderIds = [order.id];
      expect(order.status).toBe('CONFIRMED');
      expect(order.items).toHaveLength(2);

      const goods = order.items.find((i) => i.productId !== service.id)!;
      const serviceLine = order.items.find((i) => i.productId === service.id)!;
      // Solo la mercadería tiene reserva; el servicio no abre ninguna.
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]!.salesOrderItemId).toBe(goods.id);

      // 1) El servicio no se despacha, y el rechazo lo dice nombrando la línea.
      const rejected = await postExpectingError(api, '/api/dispatches', {
        salesOrderId: order.id,
        dispatchDate: today(),
        originAddress: 'Av. Almacén 100, Lima',
        destinationAddress: 'Av. Cliente 200, Lima',
        originUbigeo: '150101',
        destinationUbigeo: '150132',
        transferMode: 'PRIVATE',
        totalWeightKg: '1.000',
        packageCount: 1,
        vehiclePlate: 'AEE-123',
        driverGivenNames: 'Juan Carlos',
        driverFamilyNames: 'Pérez de Prueba',
        driverDocType: 'DNI',
        driverDocNumber: '44556677',
        driverLicense: 'Q44556677',
        notes: 'Intento de despachar un servicio (D-167)',
        items: [{ salesOrderItemId: serviceLine.id, qty: '1.000', weightKg: '1.000' }],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('es un servicio y no se despacha');
      expect(rejected.message).toContain(serviceLine.productSku);

      // 2) Despachada la mercadería —y **solo** la mercadería— el pedido queda atendido.
      const dispatch = await dispatchOrder(api, {
        salesOrderId: order.id,
        items: [{ salesOrderItemId: goods.id, qty: '300.000', weightKg: '300.000' }],
      });
      trail.dispatchIds = [dispatch.id];
      expect(dispatch.items).toHaveLength(1);

      const after = await getJson<SalesOrderDto>(api, `/api/sales/orders/${order.id}`);
      expect(after.status).toBe('FULFILLED');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
