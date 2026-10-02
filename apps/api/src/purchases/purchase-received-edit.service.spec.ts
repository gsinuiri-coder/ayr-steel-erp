import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseStatus, PurchaseType, Role } from '@prisma/client';
import { ReceivedPurchaseEditService } from './purchase-received-edit.service';
import * as assignments from '../production/production-assignments';
import * as ledger from '../sales/reserved-ledger';
import * as rawMaterial from '../sales/raw-material';

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn(),
}));
jest.mock('../sales/reserved-ledger', () => ({ reservedByItem: jest.fn() }));
jest.mock('../sales/raw-material', () => ({
  assertRawMaterialInvariant: jest.fn(),
  findRawMaterialShortfalls: jest.fn(),
}));

/**
 * D-372 (cc14) — el servicio con una base simulada: lo que lee para clasificar y lo que escribe al
 * confirmar (reversa + reingreso por `InventoryService`, la línea, la bobina, la cabecera y la
 * auditoría). El kardex real lo cubre el E2E `editar-compra-recibida-d372.spec.ts`.
 */

const ADMIN = {
  id: 'admin-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 's',
};
const D = (v: string) => new Prisma.Decimal(v);
const RECEIPT = new Date('2026-09-10T00:00:00.000Z');

function coilPurchase(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    type: PurchaseType.COIL,
    status: PurchaseStatus.RECEIVED,
    businessLineId: 'bl-roof',
    supplierId: 'sup-1',
    supplier: { name: 'ACME', docNumber: '20123456789' },
    docType: 'FACTURA',
    series: 'F001',
    number: '123',
    issueDate: RECEIPT,
    paymentTerms: 'CONTADO',
    creditDays: null,
    notes: null,
    subtotal: D('5000'),
    igv: D('900'),
    total: D('5900'),
    exchangeRate: D('1'),
    items: [
      {
        id: 'item-1',
        lineNumber: 1,
        productId: null,
        product: null,
        unit: 'KGM',
        qty: D('1000'),
        unitPrice: D('5'),
        subtotal: D('5000'),
        igv: D('900'),
        total: D('5900'),
        finishId: 'fin-rojo',
        widthMm: D('1000'),
        thicknessMm: D('0.4'),
      },
    ],
    ...over,
  };
}

const ownIn = {
  id: 10n,
  type: 'IN',
  itemType: 'COIL',
  itemId: 'coil-1',
  qty: D('1000'),
  unit: 'KGM',
  refType: 'PURCHASE',
  operationDate: RECEIPT,
  reversalOfId: null,
  reversals: [],
};

function makeTx(opts: {
  purchase?: Record<string, unknown>;
  movements?: unknown[];
  payments?: number;
  productMovements?: unknown[];
  productBalance?: string;
  auditEvents?: unknown[];
}) {
  const purchase = coilPurchase(opts.purchase);
  const updates: { model: string; args: unknown }[] = [];
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    purchase: {
      findUnique: jest.fn().mockResolvedValue(purchase),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn((args: unknown) => {
        updates.push({ model: 'purchase', args });
        return Promise.resolve({});
      }),
    },
    supplierPayment: { count: jest.fn().mockResolvedValue(opts.payments ?? 0) },
    finish: {
      findMany: jest.fn().mockResolvedValue([{ id: 'fin-rojo', code: 'ROJO' }]),
      findUnique: jest.fn().mockResolvedValue({
        code: 'AZUL',
        kind: 'PREPINTADO',
        isActive: true,
        businessLineId: 'bl-roof',
        color: { name: 'Azul', isActive: true },
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ code: 'AZUL', colorId: 'color-azul' }),
    },
    coil: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'coil-1', purchaseItemId: 'item-1', status: 'OPEN' }]),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'coil-1',
        finishId: 'fin-rojo',
        colorId: 'color-rojo',
        thicknessMm: D('0.4'),
        widthMm: D('1000'),
      }),
      update: jest.fn((args: unknown) => {
        updates.push({ model: 'coil', args });
        return Promise.resolve({});
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryMovement: {
      findMany: jest.fn((args: { where: { itemType?: string; refType?: string } }) =>
        Promise.resolve(
          args.where.itemType === 'COIL'
            ? (opts.movements ?? [ownIn])
            : args.where.refType === 'PURCHASE'
              ? (opts.productMovements ?? [])
              : [],
        ),
      ),
      count: jest.fn().mockResolvedValue(0),
    },
    purchaseItem: {
      findMany: jest.fn((args: { select?: { unit?: boolean } }) =>
        Promise.resolve(
          args.select?.unit
            ? [{ id: 'item-1', unit: 'NIU' }]
            : [{ subtotal: D('5500'), igv: D('990') }],
        ),
      ),
      update: jest.fn((args: unknown) => {
        updates.push({ model: 'purchaseItem', args });
        return Promise.resolve({});
      }),
    },
    supplier: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'OTRO', docNumber: '20999999999', isActive: true }),
    },
    inventoryBalance: {
      findUnique: jest.fn().mockResolvedValue({ qty: D(opts.productBalance ?? '100') }),
    },
    auditLog: { findMany: jest.fn().mockResolvedValue(opts.auditEvents ?? []) },
    product: {
      findMany: jest.fn().mockResolvedValue([{ id: 'prod-2', unit: 'NIU' }]),
      findUnique: jest.fn().mockResolvedValue({
        sku: 'PERFIL-2',
        isActive: true,
        businessLineId: 'bl-roof',
        unit: 'NIU',
      }),
    },
  };
  return { tx, updates };
}

describe('D-372 — ReceivedPurchaseEditService con base simulada', () => {
  const audit = { write: jest.fn() };
  const inventory = {
    reverse: jest.fn().mockResolvedValue({ id: 11n }),
    record: jest.fn().mockResolvedValue({ id: 12n }),
    lockAvailability: jest.fn(),
  };
  const coils = { ensureTradingProduct: jest.fn() };
  let service: ReceivedPurchaseEditService;

  function withTx(tx: unknown): void {
    service = new ReceivedPurchaseEditService(
      { $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)) } as never,
      audit as never,
      inventory as never,
      coils as never,
      {} as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(assignments.findLiveStripAssignments).mockResolvedValue([]);
    jest.mocked(ledger.reservedByItem).mockResolvedValue(new Map());
    jest.mocked(rawMaterial.assertRawMaterialInvariant).mockResolvedValue(undefined);
    jest.mocked(rawMaterial.findRawMaterialShortfalls).mockResolvedValue([]);
  });

  it('vista previa: lee la compra en solo lectura y clasifica', async () => {
    const { tx } = makeTx({});
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
    });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(plan.changes[0]).toMatchObject({ field: 'unitPrice', path: 'REVERSE_REENTRY' });
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('vista previa: los movimientos posteriores llegan al plan con su tipo y fecha', async () => {
    const { tx } = makeTx({
      movements: [
        ownIn,
        {
          ...ownIn,
          id: 20n,
          type: 'OUT',
          refType: 'SCRAP',
          operationDate: new Date('2026-09-12T00:00:00.000Z'),
        },
      ],
    });
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
    });
    expect(plan.changes[0]?.blockedReason).toContain('merma (SCRAP) el 2026-09-12');
  });

  it('compra en borrador o anulada, o inexistente: se rechaza', async () => {
    withTx(makeTx({ purchase: { status: PurchaseStatus.DRAFT } }).tx);
    await expect(service.preview(ADMIN, 'p-1', {})).rejects.toThrow(/borrador/);
    withTx(makeTx({ purchase: { status: PurchaseStatus.CANCELLED } }).tx);
    await expect(service.preview(ADMIN, 'p-1', {})).rejects.toThrow(/anulada/);
    const { tx } = makeTx({});
    tx.purchase.findUnique.mockResolvedValue(null);
    withTx(tx);
    await expect(service.preview(ADMIN, 'p-1', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('confirmar el precio: reversa y reingreso en la fecha de la recepción, bobina y cabecera corregidas, auditado', async () => {
    const { tx, updates } = makeTx({});
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
      reason: 'Precio mal tipeado',
    });
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      10n,
      'admin-1',
      expect.stringContaining('Precio mal tipeado'),
      '2026-09-10',
      true,
    );
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        itemType: 'COIL',
        itemId: 'coil-1',
        type: 'IN',
        qty: '1000.000',
        totalCost: '5500.0000',
        operationDate: '2026-09-10',
        confirmBackdate: true,
        refType: 'PURCHASE',
        refId: 'p-1',
      }),
    );
    const coilUpdate = updates.find((u) => u.model === 'coil')?.args as {
      data: Record<string, unknown>;
    };
    expect(coilUpdate.data).toMatchObject({
      unitCostPerKg: '5.5000',
      totalCost: '5500.0000',
      totalCostPen: '5500.0000',
    });
    // El código no se toca (decisión 5).
    expect(coilUpdate.data).not.toHaveProperty('code');
    const header = updates.find((u) => u.model === 'purchase')?.args as {
      data: Record<string, unknown>;
    };
    expect(header.data).toMatchObject({ subtotal: '5500.0000', total: '6490.0000' });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'purchases.update-received',
        reason: 'Precio mal tipeado',
        after: expect.objectContaining({
          reversedMovementIds: ['10'],
          newMovementIds: ['12'],
        }) as unknown,
      }),
    );
  });

  it('confirmar la especificación de una bobina intacta: sin kardex, tipo y color nuevos', async () => {
    const { tx, updates } = makeTx({});
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', finishId: 'fin-azul', thicknessMm: '0.5', widthMm: '1200' }],
      reason: 'Acabado equivocado',
    });
    expect(inventory.reverse).not.toHaveBeenCalled();
    const coilUpdate = updates.find((u) => u.model === 'coil')?.args as {
      data: Record<string, unknown>;
    };
    expect(coilUpdate.data).toMatchObject({
      typeKey: expect.stringContaining('AZUL') as unknown,
      thicknessMm: '0.50',
      widthMm: '1200.00',
    });
    expect(coils.ensureTradingProduct).toHaveBeenCalledWith(tx, 'fin-azul', '0.50');
    expect(rawMaterial.assertRawMaterialInvariant).toHaveBeenCalled();
  });

  it('confirmar la cáscara: proveedor, comprobante y condiciones; el vencimiento se recalcula', async () => {
    const { tx, updates } = makeTx({});
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      header: {
        supplierId: 'sup-2',
        series: 'F002',
        number: '9',
        docType: 'BOLETA',
        issueDate: '2026-09-11',
        paymentTerms: 'CREDITO',
        creditDays: 30,
        notes: 'ok',
      },
      reason: 'Comprobante mal registrado',
    });
    const header = updates.find((u) => u.model === 'purchase')?.args as {
      data: Record<string, unknown>;
    };
    expect(header.data).toMatchObject({
      series: 'F002',
      number: '9',
      docType: 'BOLETA',
      paymentTerms: 'CREDITO',
      creditDays: 30,
      notes: 'ok',
      dueDate: new Date('2026-10-11T00:00:00.000Z'),
    });
    expect(tx.coil.updateMany).toHaveBeenCalledWith({
      where: { purchaseId: 'p-1' },
      data: { supplierId: 'sup-2' },
    });
    expect(inventory.reverse).not.toHaveBeenCalled();
  });

  it('al crédito sin días: se rechaza', async () => {
    withTx(makeTx({}).tx);
    await expect(
      service.commit(ADMIN, 'p-1', {
        header: { paymentTerms: 'CREDITO', creditDays: null },
        reason: 'x',
      }),
    ).rejects.toThrow(/días de crédito/);
  });

  it('comprobante duplicado: 409', async () => {
    const { tx } = makeTx({});
    tx.purchase.findFirst.mockResolvedValue({ id: 'otra' });
    withTx(tx);
    await expect(
      service.commit(ADMIN, 'p-1', { header: { number: '124' }, reason: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un cambio bloqueado no escribe nada y devuelve el motivo', async () => {
    const { tx } = makeTx({ payments: 1 });
    withTx(tx);
    await expect(
      service.commit(ADMIN, 'p-1', { items: [{ itemId: 'item-1', unitPrice: '6' }], reason: 'x' }),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.reverse).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('sin cambios: no escribe ni audita', async () => {
    const { tx } = makeTx({});
    withTx(tx);
    const plan = await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5' }],
      reason: 'x',
    });
    expect(plan.changes).toEqual([]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('producto terminado: cambiar de producto revierte el ingreso del viejo e ingresa el nuevo', async () => {
    const productIn = {
      ...ownIn,
      itemType: 'PRODUCT',
      itemId: 'prod-1',
      unit: 'NIU',
      qty: D('100'),
    };
    const { tx } = makeTx({
      purchase: {
        type: PurchaseType.FINISHED_GOOD,
        items: [
          {
            ...coilPurchase().items[0],
            productId: 'prod-1',
            product: { sku: 'PERFIL-1' },
            unit: 'NIU',
            qty: D('100'),
            unitPrice: D('50'),
            finishId: null,
            widthMm: null,
            thicknessMm: null,
          },
        ],
      },
      productMovements: [productIn],
    });
    tx.coil.findMany.mockResolvedValue([]);
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', productId: 'prod-2' }],
      reason: 'Producto equivocado',
    });
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      10n,
      'admin-1',
      expect.any(String),
      '2026-09-10',
      true,
    );
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ itemType: 'PRODUCT', itemId: 'prod-2', qty: '100.000' }),
    );
    // Los saldos del producto viejo y del nuevo se bloquean antes de leer, en orden fijo.
    expect(
      (inventory.lockAvailability.mock.calls as [unknown, { itemId: string }][]).map(
        (c) => c[1].itemId,
      ),
    ).toEqual(['prod-1', 'prod-2']);
  });

  it('confirmar bloquea el saldo de la bobina antes de leer sus movimientos', async () => {
    const { tx } = makeTx({});
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
      reason: 'x',
    });
    expect(inventory.lockAvailability).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ itemType: 'COIL', itemId: 'coil-1', businessLineId: 'bl-roof' }),
    );
    const lockOrder = inventory.lockAvailability.mock.invocationCallOrder[0] ?? 0;
    const readOrder = tx.inventoryMovement.findMany.mock.invocationCallOrder[0] ?? 0;
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('sin ingreso de kardex vivo: la vista previa bloquea y no se toca la compra', async () => {
    const { tx } = makeTx({ movements: [] });
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
    });
    expect(plan.changes[0]?.blockedReason).toContain('ingreso de kardex vivo');
    await expect(
      service.commit(ADMIN, 'p-1', {
        items: [{ itemId: 'item-1', unitPrice: '5.5' }],
        reason: 'x',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.purchaseItem.update).not.toHaveBeenCalled();
  });

  it('bobina con reserva: el precio se bloquea en la vista previa (la reversa la dejaría sin cubrir)', async () => {
    jest.mocked(ledger.reservedByItem).mockResolvedValue(new Map([['coil-1', D('100')]]));
    const { tx } = makeTx({});
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
    });
    expect(plan.changes[0]?.blockedReason).toContain('material reservado');
  });

  it('bobina que respalda material prometido por agregado: la vista previa lo nombra y bloquea', async () => {
    jest.mocked(rawMaterial.findRawMaterialShortfalls).mockResolvedValue([
      {
        specId: 'spec-1',
        label: 'ROJO 0.40',
        freeKg: '0.000',
        promisedKg: '300.000',
        shortfallKg: '300.000',
        orders: [{ code: 'PED-000009', qtyKg: '300.000' }],
        message: '',
      },
    ]);
    const { tx } = makeTx({});
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
      header: { notes: 'x' },
    });
    expect(rawMaterial.findRawMaterialShortfalls).toHaveBeenCalledWith(
      tx,
      ['coil-1'],
      expect.any(String),
      expect.objectContaining({ withoutCoilIds: ['coil-1'] }),
    );
    expect(plan.changes.find((c) => c.field === 'unitPrice')?.blockedReason).toBe(
      'No se puede corregir porque esta bobina respalda material comprometido de PED-000009 (300.000 kg): la reversa del ingreso dejaría esa promesa sin cubrir',
    );
    // La cáscara no simula nada: sin líneas en la edición no se consulta el agregado.
    jest.mocked(rawMaterial.findRawMaterialShortfalls).mockClear();
    await service.preview(ADMIN, 'p-1', { header: { notes: 'x' } });
    expect(rawMaterial.findRawMaterialShortfalls).not.toHaveBeenCalled();
  });

  it('producto con reserva que no cabe sin este ingreso: bloqueado; si cabe, ejecutable', async () => {
    const fg = {
      type: PurchaseType.FINISHED_GOOD,
      items: [
        {
          ...coilPurchase().items[0],
          productId: 'prod-1',
          product: { sku: 'PERFIL-1' },
          unit: 'NIU',
          qty: D('100'),
          unitPrice: D('50'),
          finishId: null,
          widthMm: null,
          thicknessMm: null,
        },
      ],
    };
    const productIn = {
      ...ownIn,
      itemType: 'PRODUCT',
      itemId: 'prod-1',
      unit: 'NIU',
      qty: D('100'),
    };
    jest.mocked(ledger.reservedByItem).mockResolvedValue(new Map([['prod-1', D('30')]]));

    const short = makeTx({ purchase: fg, productMovements: [productIn], productBalance: '120' });
    short.tx.coil.findMany.mockResolvedValue([]);
    withTx(short.tx);
    const blocked = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '55' }],
    });
    expect(blocked.changes[0]?.path).toBe('BLOCKED');

    const fits = makeTx({ purchase: fg, productMovements: [productIn], productBalance: '200' });
    fits.tx.coil.findMany.mockResolvedValue([]);
    withTx(fits.tx);
    const ok = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '55' }],
    });
    expect(ok.changes[0]?.path).toBe('REVERSE_REENTRY');
  });

  it('IGV no estándar: la cáscara se guarda sin reescribir totales; el precio se bloquea', async () => {
    const { tx, updates } = makeTx({ purchase: { igv: D('500') } });
    withTx(tx);
    const plan = await service.preview(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5.5' }],
    });
    expect(plan.changes[0]?.blockedReason).toContain('tasa de IGV');
    await service.commit(ADMIN, 'p-1', { header: { notes: 'nota' }, reason: 'x' });
    const header = updates.find((u) => u.model === 'purchase')?.args as {
      data: Record<string, unknown>;
    };
    expect(header.data).toEqual({ notes: 'nota' });
  });

  it('deshacer: volver a la cantidad y el precio de antes restaura los importes del papel', async () => {
    // Papel original: 1000 × 5 con subtotal 4999.99 (redondeo del papel, D-359). La edición
    // anterior lo dejó en 5.5; volver a 5 restaura 4999.99, no 5000.
    const { tx, updates } = makeTx({
      purchase: {
        subtotal: D('5500'),
        igv: D('990'),
        total: D('6490'),
        items: [
          {
            ...coilPurchase().items[0],
            unitPrice: D('5.5'),
            subtotal: D('5500'),
            igv: D('990'),
            total: D('6490'),
          },
        ],
      },
      auditEvents: [
        {
          before: {
            lines: [
              {
                itemId: 'item-1',
                qty: '1000.000',
                unitPrice: '5.0000',
                subtotal: '4999.9900',
                igv: '900.0000',
                total: '5899.9900',
              },
            ],
          },
        },
      ],
    });
    withTx(tx);
    await service.commit(ADMIN, 'p-1', {
      items: [{ itemId: 'item-1', unitPrice: '5' }],
      reason: 'Deshacer',
    });
    const line = updates.find((u) => u.model === 'purchaseItem')?.args as {
      data: Record<string, unknown>;
    };
    expect(line.data).toMatchObject({ subtotal: '4999.9900', igv: '900.0000', total: '5899.9900' });
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ totalCost: '4999.9900' }),
    );
    // Y la edición deja su propio «antes» para poder volver a esta versión.
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        before: expect.objectContaining({
          lines: [expect.objectContaining({ unitPrice: '5.5000', subtotal: '5500.0000' })],
        }) as unknown,
      }),
    );
  });
});
