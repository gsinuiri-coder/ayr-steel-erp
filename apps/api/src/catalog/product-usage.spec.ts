import { BusinessLineCode, FinishKind, type Prisma } from '@prisma/client';
import { describeProductUsage, productsWithUsage } from './product-usage';

/**
 * **D-347/M6 — «nunca se usó».** El mismo criterio del dueño en las dos funciones: kardex,
 * documento comercial (compra, cotización, pedido, comprobante, despacho, historial de precio
 * de una línea), reserva o producción cuentan; el historial de precio de **lista** y la
 * auditoría, no (ninguna de las dos entra a este archivo). Ser el destino de una fusión
 * (`mergedFrom`) también cuenta, mismo motivo que el historial de precio por línea: algo
 * quedaría apuntando a un producto que ya no existe.
 */

const PRODUCT = {
  id: 'p-1',
  sku: 'PERFIL01',
  name: 'Perfil sin uso',
  businessLine: { code: BusinessLineCode.DRYWALL },
};

const BOB_PRODUCT = {
  id: 'p-bob',
  sku: 'BOB038ROJO',
  name: 'Bobina Rojo 0.38 mm',
  businessLine: { code: BusinessLineCode.TRADING },
};

function coil(id: string, code: string, colorCode: string | null, kind = FinishKind.PREPINTADO) {
  return { id, code, finish: { kind, color: colorCode === null ? null : { code: colorCode } } };
}

interface Counts {
  purchaseItems?: number;
  boms?: number;
  productionOrders?: number;
  quotationItems?: number;
  salesOrderItems?: number;
  fiscalItems?: number;
  dispatchItems?: number;
  movements?: number;
  reservations?: number;
  quotationReservations?: number;
  mergedFrom?: number;
  priceChanges?: { quotation: { seq: number } | null; salesOrder: { seq: number } | null }[];
  coils?: ReturnType<typeof coil>[];
}

/** Todo en cero por defecto: el producto «nunca se usó» hasta que un test diga lo contrario. */
function fakeTx(counts: Counts = {}): Prisma.TransactionClient {
  const countOf = (n: number | undefined) => jest.fn().mockResolvedValue(n ?? 0);
  const findManyOf = (n: number | undefined, key: 'productId' | 'itemId' | 'mergedIntoId') =>
    jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const ids =
        key === 'mergedIntoId'
          ? ((where.mergedIntoId as { in: string[] }).in ?? [])
          : key === 'itemId'
            ? ((where.itemId as { in: string[] }).in ?? [])
            : ((where.productId as { in: string[] }).in ?? []);
      // Simula «el primer id de la tanda está usado» cuando el conteo pedido es > 0 — solo
      // hace falta para `productsWithUsage`, que trabaja por tanda, no por id.
      return Promise.resolve((n ?? 0) > 0 && ids.length > 0 ? [{ [key]: ids[0] }] : []);
    });
  return {
    purchaseItem: {
      count: countOf(counts.purchaseItems),
      findMany: findManyOf(counts.purchaseItems, 'productId'),
    },
    productBom: { count: countOf(counts.boms), findMany: findManyOf(counts.boms, 'productId') },
    productionOrder: {
      count: countOf(counts.productionOrders),
      findMany: findManyOf(counts.productionOrders, 'productId'),
    },
    quotationItem: {
      count: countOf(counts.quotationItems),
      findMany: findManyOf(counts.quotationItems, 'productId'),
    },
    salesOrderItem: {
      count: countOf(counts.salesOrderItems),
      findMany: findManyOf(counts.salesOrderItems, 'productId'),
    },
    salesPriceChange: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (counts.priceChanges ?? []).length > 0
            ? counts.priceChanges
            : counts.priceChanges === undefined
              ? []
              : [],
        ),
    },
    fiscalDocumentItem: {
      count: countOf(counts.fiscalItems),
      findMany: findManyOf(counts.fiscalItems, 'productId'),
    },
    dispatchItem: {
      count: countOf(counts.dispatchItems),
      findMany: findManyOf(counts.dispatchItems, 'productId'),
    },
    inventoryMovement: {
      count: countOf(counts.movements),
      findMany: findManyOf(counts.movements, 'itemId'),
    },
    reservation: {
      count: countOf(counts.reservations),
      findMany: findManyOf(counts.reservations, 'itemId'),
    },
    quotationReservation: {
      count: countOf(counts.quotationReservations),
      findMany: findManyOf(counts.quotationReservations, 'itemId'),
    },
    product: {
      count: countOf(counts.mergedFrom),
      findMany: findManyOf(counts.mergedFrom, 'mergedIntoId'),
    },
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'ROJO' }, { code: 'ROJO-3020' }]) },
    coil: { findMany: jest.fn().mockResolvedValue(counts.coils ?? []) },
  } as unknown as Prisma.TransactionClient;
}

describe('describeProductUsage — un solo producto, el 409 de DELETE /catalog/:id', () => {
  it('nunca se usó: la lista de motivos viene vacía', async () => {
    await expect(describeProductUsage(fakeTx(), PRODUCT)).resolves.toEqual([]);
  });

  it('el kardex cuenta (movimientos de InventoryMovement)', async () => {
    const reasons = await describeProductUsage(fakeTx({ movements: 3 }), PRODUCT);
    expect(reasons).toEqual(['3 movimiento(s) de kardex']);
  });

  it('una cotización y un pedido cuentan aparte', async () => {
    const reasons = await describeProductUsage(
      fakeTx({ quotationItems: 1, salesOrderItems: 2 }),
      PRODUCT,
    );
    expect(reasons).toEqual(['1 línea(s) de cotización', '2 línea(s) de pedido']);
  });

  it('una receta de drywall histórica (D-344) cuenta, aunque esté desactivada', async () => {
    const reasons = await describeProductUsage(fakeTx({ boms: 1 }), PRODUCT);
    expect(reasons).toEqual(['1 receta(s) de producción (histórico, D-344)']);
  });

  it('reservas firmes y temporales cuentan aparte', async () => {
    const reasons = await describeProductUsage(
      fakeTx({ reservations: 1, quotationReservations: 2 }),
      PRODUCT,
    );
    expect(reasons).toEqual(['1 reserva(s) de pedido', '2 reserva(s) temporal(es) de cotización']);
  });

  it(
    'el historial de precio por línea cuenta y nombra el documento (decisión del dueño, ' +
      'M6 Paso 0): distinto del historial de precio de lista, que no cuenta',
    async () => {
      const reasons = await describeProductUsage(
        fakeTx({
          priceChanges: [
            { quotation: { seq: 7 }, salesOrder: null },
            { quotation: null, salesOrder: { seq: 12 } },
          ],
        }),
        PRODUCT,
      );
      expect(reasons).toEqual(['historial de cambios de precio de COT-000007/PED-000012']);
    },
  );

  it('ser el destino de una fusión (D-253) cuenta: borrarlo dejaría mergedIntoId huérfano', async () => {
    const reasons = await describeProductUsage(fakeTx({ mergedFrom: 2 }), PRODUCT);
    expect(reasons).toEqual(['es el destino de la unión de 2 producto(s) (D-253)']);
  });

  it('un producto de venta de bobina (BOB…) con bobinas en su pool no se puede borrar', async () => {
    const reasons = await describeProductUsage(
      fakeTx({ coils: [coil('c1', 'B-1', 'ROJO'), coil('c2', 'B-2', 'AZUL')] }),
      BOB_PRODUCT,
    );
    expect(reasons).toEqual(['1 bobina(s) de su pool (B-1)']);
  });

  it('un BOB… sin ninguna bobina de su pool se puede borrar', async () => {
    await expect(describeProductUsage(fakeTx({ coils: [] }), BOB_PRODUCT)).resolves.toEqual([]);
  });

  it('varios motivos a la vez se listan todos, no solo el primero', async () => {
    const reasons = await describeProductUsage(
      fakeTx({ purchaseItems: 1, dispatchItems: 1 }),
      PRODUCT,
    );
    expect(reasons).toEqual(['1 línea(s) de compra', '1 línea(s) de despacho']);
  });
});

describe('productsWithUsage — el catálogo entero, presupuesto fijo de consultas', () => {
  it('sin uso en ninguna tabla, el conjunto de usados viene vacío', async () => {
    await expect(productsWithUsage(fakeTx(), [PRODUCT])).resolves.toEqual(new Set());
  });

  it('lista vacía no dispara ninguna consulta', async () => {
    const tx = fakeTx();
    await productsWithUsage(tx, []);
    expect(
      (tx as unknown as { purchaseItem: { findMany: jest.Mock } }).purchaseItem.findMany,
    ).not.toHaveBeenCalled();
  });

  it('un producto usado en cualquier tabla entra al conjunto', async () => {
    const used = await productsWithUsage(fakeTx({ quotationItems: 1 }), [PRODUCT]);
    expect(used.has(PRODUCT.id)).toBe(true);
  });

  it(
    'el pool de bobinas solo se mira para los BOB… que ninguna otra tabla ya marcó usados ' +
      '(no gasta una consulta de más por fila)',
    async () => {
      const tx = fakeTx({ quotationItems: 1, coils: [coil('c1', 'B-1', 'ROJO')] });
      const used = await productsWithUsage(tx, [BOB_PRODUCT]);
      expect(used.has(BOB_PRODUCT.id)).toBe(true);
      expect(
        (tx as unknown as { coil: { findMany: jest.Mock } }).coil.findMany,
      ).not.toHaveBeenCalled();
    },
  );

  it('un BOB… con bobinas en su pool entra al conjunto, aunque ninguna otra tabla lo use', async () => {
    const used = await productsWithUsage(fakeTx({ coils: [coil('c1', 'B-1', 'ROJO')] }), [
      BOB_PRODUCT,
    ]);
    expect(used.has(BOB_PRODUCT.id)).toBe(true);
  });
});
