import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  cancelCuttingOrderSchema,
  confirmPurchaseImportSchema,
  createCuttingOrderSchema,
  createFinishSchema,
  createPurchaseSchema,
  createSupplierPaymentSchema,
  createSupplierSchema,
  receiveCuttingOrderCoilSchema,
  reversePaymentSchema,
  type CreatePurchaseInput,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { CuttingService } from '../cutting/cutting.service';
import { FinishesService } from '../finishes/finishes.service';
import { PurchaseImportService } from '../imports/purchase-import.service';
import { PrismaService } from '../prisma/prisma.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { CoilOperationsService } from '../coils/coil-operations.service';
import { InventoryService } from '../inventory/inventory.service';
import { PurchasesService } from './purchases.service';

/**
 * cc50 (D-638) — **la auditoría que faltaba en el «Historial» de compra y de orden de corte,
 * contra la base.** Cada operación deja su registro en el documento que lo muestra, en la misma
 * transacción: si la operación falla no queda registro, y si el registro falla la operación no
 * se confirma.
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(5 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let purchases: PurchasesService;
let cutting: CuttingService;
let imports: PurchaseImportService;
let audit: AuditService;
let admin: RequestUser;
let supplierId = '';
let supplierRuc = '';
let cutterId = '';
let galvanizedId = '';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  purchases = moduleRef.get(PurchasesService);
  cutting = moduleRef.get(CuttingService);
  imports = moduleRef.get(PurchaseImportService);
  audit = moduleRef.get(AuditService);
  const suppliers = moduleRef.get(SuppliersService);

  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  admin = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };
  const supplier = (name: string, providesCuttingService: boolean) =>
    suppliers.create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name,
        creditDays: 0,
        providesCuttingService,
      }),
    );
  const main = await supplier('Proveedor cc50', false);
  supplierId = main.id;
  supplierRuc = main.docNumber;
  cutterId = (await supplier('Proveedor de corte cc50', true)).id;
  galvanizedId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `G${letters(5)}`,
        name: 'Galvanizado cc50',
        densityFactor: '7.85',
        kind: 'GALVANIZADO',
        businessLine: 'drywall',
      }),
    )
  ).id;
});

afterAll(async () => {
  jest.restoreAllMocks();
  await moduleRef?.close();
});

/** Una compra de una bobina de drywall de 1 000 kg a S/ 4, recibida o en borrador. */
async function coilPurchase(receive = true) {
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number: digits(8),
      issueDate: businessToday(),
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'drywall',
      type: 'COIL',
      items: [
        {
          description: 'Bobina cc50',
          qty: '1000',
          unit: 'KGM',
          unitPrice: '4',
          finishId: galvanizedId,
          widthMm: '1220',
          thicknessMm: '0.45',
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  if (receive) await purchases.receive(admin, purchase.id);
  return purchase;
}

function service(over: Partial<CreatePurchaseInput>) {
  return purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId: over.serviceKind === 'CUTTING' ? cutterId : supplierId,
      docType: 'FACTURA',
      series: 'F002',
      number: digits(8),
      issueDate: businessToday(),
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'drywall',
      type: 'SERVICE',
      items: [{ description: 'Servicio cc50', qty: '1', unit: 'ZZ', unitPrice: '100' }],
      ...over,
    }),
  );
}

/** Hace fallar solo el registro de `action`; el resto se escribe de verdad. */
function failAudit(action: string) {
  const original = audit.write.bind(audit);
  return jest
    .spyOn(audit, 'write')
    .mockImplementation((tx, entry: AuditEntry) =>
      entry.action === action ? Promise.reject(new Error('auditoría caída')) : original(tx, entry),
    );
}

function auditsOf(entity: string, entityId: string, action: string) {
  return prisma.auditLog.findMany({ where: { entity, entityId, action }, orderBy: { id: 'asc' } });
}

async function rejection(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (err) {
    return (err as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
  throw new Error('Se esperaba un rechazo');
}

const payment = (amount: string) =>
  createSupplierPaymentSchema.parse({
    date: businessToday(),
    amount,
    currency: 'PEN',
    method: 'TRANSFER',
  });

describe('cc50 (D-638) — pagos a proveedor, en el «Historial» de la compra', () => {
  it('el pago y su reversa dejan un registro cada uno en la compra, con el pago y el proveedor', async () => {
    const purchase = await coilPurchase();
    const withPayment = await purchases.addPayment(admin, purchase.id, payment('100'));
    const paymentId = withPayment.payments[0]?.id ?? '';
    expect(paymentId).not.toBe('');

    const paid = await auditsOf('purchases', purchase.id, 'purchases.payment');
    expect(paid).toHaveLength(1);
    expect(paid[0]?.after).toMatchObject({
      paymentId,
      supplierId,
      document: `${purchase.series}-${purchase.number}`,
      amount: '100.0000',
      currency: 'PEN',
    });
    // Ya no se registra en la entidad del pago.
    expect(await prisma.auditLog.count({ where: { entityId: paymentId } })).toBe(0);

    await purchases.reversePayment(
      admin,
      purchase.id,
      paymentId,
      reversePaymentSchema.parse({ reason: 'Pago duplicado' }),
    );
    const reversed = await auditsOf('purchases', purchase.id, 'purchases.payment-reverse');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.before).toMatchObject({ paymentId, supplierId, amount: '100.0000' });
    expect(reversed[0]?.after).toMatchObject({ reason: 'Pago duplicado' });

    // Revertirlo otra vez falla y no deja otro registro.
    expect(
      await rejection(
        purchases.reversePayment(
          admin,
          purchase.id,
          paymentId,
          reversePaymentSchema.parse({ reason: 'Otra vez' }),
        ),
      ),
    ).toBe(409);
    expect(await auditsOf('purchases', purchase.id, 'purchases.payment-reverse')).toHaveLength(1);
  });

  it('un pago rechazado no deja registro', async () => {
    const purchase = await coilPurchase();
    // 1 000 kg × S/ 4 con IGV son S/ 4 720: S/ 5 000 excede el saldo.
    expect(await rejection(purchases.addPayment(admin, purchase.id, payment('5000')))).toBe(400);
    expect(await auditsOf('purchases', purchase.id, 'purchases.payment')).toHaveLength(0);
  });

  it('si el registro de auditoría falla, el pago no se confirma', async () => {
    const purchase = await coilPurchase();
    const spy = jest.spyOn(audit, 'write').mockRejectedValueOnce(new Error('auditoría caída'));
    await expect(purchases.addPayment(admin, purchase.id, payment('100'))).rejects.toThrow(
      'auditoría caída',
    );
    spy.mockRestore();
    expect(await prisma.supplierPayment.count({ where: { purchaseId: purchase.id } })).toBe(0);
  });
});

describe('cc50 (D-638) — costo de importación, en las dos compras', () => {
  it('la compra de bobinas que lo recibe tiene su registro; la del servicio, su recepción', async () => {
    const coils = await coilPurchase();
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);

    const landed = await auditsOf('purchases', coils.id, 'purchases.landed-cost');
    expect(landed).toHaveLength(1);
    expect(landed[0]?.after).toMatchObject({
      document: `${coils.series}-${coils.number}`,
      servicePurchaseId: freight.id,
      serviceDocument: `${freight.series}-${freight.number}`,
      serviceKind: 'FREIGHT',
      amountPen: '100.0000',
      coils: 1,
    });
    const received = await auditsOf('purchases', freight.id, 'purchases.receive');
    expect(received).toHaveLength(1);
    expect(received[0]?.after).toMatchObject({
      landedCost: {
        amountPen: '100.0000',
        imputed: true,
        relatedDocument: `${coils.series}-${coils.number}`,
      },
    });
  });

  it('anular el servicio deja la reversa en la compra de bobinas', async () => {
    const coils = await coilPurchase();
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);
    await purchases.cancel(admin, freight.id, { reason: 'Flete equivocado' });
    const reversed = await auditsOf('purchases', coils.id, 'purchases.landed-cost-reverse');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.before).toMatchObject({ amountPen: '100.0000', coils: 1 });
    expect(reversed[0]?.after).toMatchObject({ servicePurchaseId: freight.id });
    expect(reversed[0]?.reason).toBe('Flete equivocado');
  });

  it('si el registro de la recepción falla, el costo y su registro se deshacen', async () => {
    const coils = await coilPurchase();
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    // `purchases.receive` se escribe después de `purchases.landed-cost`.
    const spy = failAudit('purchases.receive');
    try {
      await expect(purchases.receive(admin, freight.id)).rejects.toThrow('auditoría caída');
    } finally {
      spy.mockRestore();
    }
    expect(await auditsOf('purchases', coils.id, 'purchases.landed-cost')).toHaveLength(0);
    const after = await prisma.purchase.findUniqueOrThrow({ where: { id: freight.id } });
    expect(after.status).toBe('DRAFT');
    expect(
      await prisma.inventoryMovement.count({ where: { refType: 'PURCHASE', refId: freight.id } }),
    ).toBe(0);
  });

  it('si la recepción del servicio falla, ninguna compra queda con registro', async () => {
    const coils = await coilPurchase(false);
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    expect(await rejection(purchases.receive(admin, freight.id))).toBe(400);
    expect(await auditsOf('purchases', coils.id, 'purchases.landed-cost')).toHaveLength(0);
    expect(await auditsOf('purchases', freight.id, 'purchases.receive')).toHaveLength(0);
  });
});

describe('cc50 (D-638) — factura del corte, en el «Historial» de la orden de corte', () => {
  async function sentOrder(): Promise<string> {
    const purchase = await coilPurchase();
    const mother = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    const order = await cutting.send(
      admin,
      createCuttingOrderSchema.parse({
        supplierId: cutterId,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [{ widthMm: '600.00', stripsCount: 2 }],
            expectedKerfLossMm: '20.00',
          },
        ],
      }),
    );
    return order.id;
  }

  it('vincular la factura deja un registro en la orden de corte', async () => {
    const orderId = await sentOrder();
    const invoice = await service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId });
    const linked = await auditsOf('cutting_orders', orderId, 'cutting.invoice-linked');
    expect(linked).toHaveLength(1);
    expect(linked[0]?.after).toMatchObject({
      purchaseId: invoice.id,
      document: `${invoice.series}-${invoice.number}`,
      supplierId: cutterId,
      subtotal: '100.0000',
      currency: 'PEN',
    });
  });

  it('si el registro de la factura falla, la compra no se crea', async () => {
    const orderId = await sentOrder();
    const number = digits(8);
    const spy = failAudit('cutting.invoice-linked');
    try {
      await expect(
        service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId, number }),
      ).rejects.toThrow('auditoría caída');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.purchase.count({ where: { relatedCuttingOrderId: orderId } })).toBe(0);
  });

  it('una factura que no se puede vincular no deja registro', async () => {
    const orderId = await sentOrder();
    await cutting.cancel(admin, orderId, cancelCuttingOrderSchema.parse({ reason: 'No se cortó' }));
    expect(
      await rejection(service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId })),
    ).toBe(400);
    expect(await auditsOf('cutting_orders', orderId, 'cutting.invoice-linked')).toHaveLength(0);
  });
});

describe('cc50 (D-638) — lote del importador, con su tipo propio', () => {
  const document = (number: string) => ({
    key: `cc50-${number}`,
    type: 'Gasto',
    businessLine: 'Servicios',
    docType: 'Factura',
    series: 'F003',
    number,
    issueDate: businessToday(),
    supplierRuc,
    currency: 'PEN',
    paymentTerms: 'Contado',
    igvRate: '18',
    lines: [{ rowNumber: 2, description: 'Luz', qty: '1', unit: 'NIU', unitPrice: '100' }],
  });

  it('confirmar y deshacer dejan su resumen en el lote; cada compra lleva el lote', async () => {
    const result = await imports.confirm(
      admin,
      confirmPurchaseImportSchema.parse({
        documents: [document(`9${digits(7)}`), document(`9${digits(7)}`)],
        fileName: 'compras-cc50.xlsx',
      }),
    );
    const { batchId } = result;
    const created = await auditsOf('purchase_import_batches', batchId, 'imports.purchases');
    expect(created).toHaveLength(1);
    expect(created[0]?.after).toMatchObject({ batchId, purchases: 2 });
    // El tipo `purchases` ya no carga el id del lote.
    expect(await prisma.auditLog.count({ where: { entity: 'purchases', entityId: batchId } })).toBe(
      0,
    );
    for (const p of result.purchases) {
      const rows = await auditsOf('purchases', p.id, 'purchases.create');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.after).toMatchObject({ importBatchId: batchId });
    }

    await imports.undo(admin, batchId, 'Archivo equivocado');
    const undone = await auditsOf('purchase_import_batches', batchId, 'imports.purchases.undo');
    expect(undone).toHaveLength(1);
    expect(undone[0]?.after).toMatchObject({ batchId, reason: 'Archivo equivocado' });
    for (const p of result.purchases) {
      expect(await auditsOf('purchases', p.id, 'purchases.cancel')).toHaveLength(1);
    }
  });

  it('si el resumen del lote falla, ninguna compra del lote queda', async () => {
    const number = `9${digits(7)}`;
    const spy = failAudit('imports.purchases');
    try {
      await expect(
        imports.confirm(
          admin,
          confirmPurchaseImportSchema.parse({ documents: [document(number)] }),
        ),
      ).rejects.toThrow('auditoría caída');
    } finally {
      spy.mockRestore();
    }
    const created = await prisma.purchase.findMany({
      where: { supplierId, series: 'F003', number },
      select: { id: true },
    });
    expect(created).toHaveLength(0);
  });

  it('un lote que no entra no deja resumen', async () => {
    const before = await prisma.auditLog.count({
      where: { entity: 'purchase_import_batches', action: 'imports.purchases' },
    });
    // Una cantidad que no es número: la validación lo rechaza antes de abrir la transacción.
    const good = document(`9${digits(7)}`);
    const bad = { ...good, lines: good.lines.map((l) => ({ ...l, qty: 'mucho' })) };
    expect(
      await rejection(
        imports.confirm(admin, confirmPurchaseImportSchema.parse({ documents: [bad] })),
      ),
    ).toBeGreaterThanOrEqual(400);
    expect(
      await prisma.auditLog.count({
        where: { entity: 'purchase_import_batches', action: 'imports.purchases' },
      }),
    ).toBe(before);
  });
});

describe('cc51 (D-639) — anular la factura del corte, en el «Historial» de la orden de corte', () => {
  /** Una orden de corte con sus dos flejes ya recibidos (990 kg). */
  async function receivedOrder(): Promise<string> {
    const purchase = await coilPurchase();
    const mother = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
    const order = await cutting.send(
      admin,
      createCuttingOrderSchema.parse({
        supplierId: cutterId,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [{ widthMm: '600.00', stripsCount: 2 }],
            expectedKerfLossMm: '20.00',
          },
        ],
      }),
    );
    await cutting.receive(
      admin,
      order.id,
      mother.id,
      receiveCuttingOrderCoilSchema.parse({
        receivedWidthsMm: [{ widthMm: '600.00', stripsCount: 2 }],
        receivedWeightKg: '990',
        kerfLossMm: '20',
      }),
    );
    return order.id;
  }

  it('anular la factura recibida deja un registro en la orden de corte, con lo que se quitó a los flejes', async () => {
    const orderId = await receivedOrder();
    const invoice = await service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId });
    await purchases.receive(admin, invoice.id);
    await purchases.cancel(admin, invoice.id, { reason: 'Factura duplicada' });
    const cancelled = await auditsOf('cutting_orders', orderId, 'cutting.invoice-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.before).toMatchObject({
      purchaseId: invoice.id,
      document: `${invoice.series}-${invoice.number}`,
      supplierId: cutterId,
    });
    expect(cancelled[0]?.after).toEqual({ amountPen: '100.0000', strips: 2 });
    expect(cancelled[0]?.reason).toBe('Factura duplicada');
  });

  it('anular la factura en borrador también lo dice, sin monto', async () => {
    const orderId = await receivedOrder();
    const invoice = await service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId });
    await purchases.cancel(admin, invoice.id, { reason: 'No era de este corte' });
    const cancelled = await auditsOf('cutting_orders', orderId, 'cutting.invoice-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.after).toEqual({ amountPen: '0.0000', strips: 0 });
  });

  it('si el registro de la orden de corte falla, la anulación entera se deshace', async () => {
    const orderId = await receivedOrder();
    const invoice = await service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId });
    await purchases.receive(admin, invoice.id);
    const before = await prisma.inventoryMovement.count({ where: { refId: invoice.id } });
    const spy = failAudit('cutting.invoice-cancelled');
    try {
      await expect(
        purchases.cancel(admin, invoice.id, { reason: 'Factura duplicada' }),
      ).rejects.toThrow('auditoría caída');
    } finally {
      spy.mockRestore();
    }
    const after = await prisma.purchase.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe('RECEIVED');
    expect(await prisma.inventoryMovement.count({ where: { refId: invoice.id } })).toBe(before);
    expect(await auditsOf('purchases', invoice.id, 'purchases.cancel')).toHaveLength(0);
    expect(await auditsOf('cutting_orders', orderId, 'cutting.invoice-cancelled')).toHaveLength(0);
  });

  it('una anulación rechazada no deja registro', async () => {
    const orderId = await receivedOrder();
    const invoice = await service({ serviceKind: 'CUTTING', relatedCuttingOrderId: orderId });
    await purchases.cancel(admin, invoice.id, { reason: 'Primera' });
    expect(await rejection(purchases.cancel(admin, invoice.id, { reason: 'Otra vez' }))).toBe(400);
    expect(await auditsOf('cutting_orders', orderId, 'cutting.invoice-cancelled')).toHaveLength(1);
  });

  it('anular un flete recibido no escribe en ninguna orden de corte', async () => {
    const coils = await coilPurchase();
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);
    const before = await prisma.auditLog.count({ where: { action: 'cutting.invoice-cancelled' } });
    await purchases.cancel(admin, freight.id, { reason: 'Prueba' });
    expect(await prisma.auditLog.count({ where: { action: 'cutting.invoice-cancelled' } })).toBe(
      before,
    );
    expect(await auditsOf('purchases', coils.id, 'purchases.landed-cost-reverse')).toHaveLength(1);
  });
});

describe('cc58 (D-686, D-10 de audit-01): el flete que llega después de consumir', () => {
  const inventory = () => moduleRef.get(InventoryService);

  /** Saca `kg` de la única bobina de la compra, hoy (una venta cualquiera). */
  async function consume(purchaseId: string, kg: string) {
    const coil = await prisma.coil.findFirstOrThrow({ where: { purchaseId } });
    const out = await prisma.$transaction((tx) =>
      inventory().record(tx, {
        businessLineId: coil.businessLineId,
        itemType: 'COIL',
        itemId: coil.id,
        type: 'OUT',
        qty: kg,
        unit: 'KGM',
        refType: 'SALE',
        actorId: admin.id,
      }),
    );
    if (!out) throw new Error('sin salida');
    return { coil, out };
  }

  /** Costo efectivo de una fila: el grabado más (o menos, en una salida) sus recosteos. */
  async function effective(id: bigint): Promise<string> {
    const m = await prisma.inventoryMovement.findUniqueOrThrow({ where: { id } });
    const adj = await prisma.inventoryMovement.aggregate({
      where: { recostOfId: id },
      _sum: { totalCost: true },
    });
    const extra = Number(adj._sum.totalCost?.toString() ?? '0');
    const total = Number(m.totalCost.toString());
    return (m.type === 'OUT' ? total - extra : total + extra).toFixed(4);
  }

  async function entryOf(coilId: string) {
    return prisma.inventoryMovement.findFirstOrThrow({
      where: { itemId: coilId, type: 'IN', recostOfId: null },
    });
  }

  it('se suma a la entrada y lo que ya salió se lleva su parte; al anularlo, vuelve todo', async () => {
    const coils = await coilPurchase();
    const { coil, out } = await consume(coils.id, '400');
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);

    const entry = await entryOf(coil.id);
    // 1 000 kg a S/ 4 más S/ 100 de flete: la entrada vale 4 100; la salida de 400 kg, 1 640.
    expect([await effective(entry.id), await effective(out.id)]).toEqual([
      '4100.0000',
      '1640.0000',
    ]);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId: coil.id } });
    expect([balance.qty.toString(), balance.avgCost.toString()]).toEqual(['600', '4.1']);
    expect(
      (await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).unitCostPerKg.toString(),
    ).toBe('4.1');
    // Ningún ADJUST suelto sobre el saldo de hoy (el D-043 de antes): todo va por recosteo.
    expect(
      await prisma.inventoryMovement.count({
        where: { itemId: coil.id, type: 'ADJUST', recostOfId: null },
      }),
    ).toBe(0);

    // La compra de bobinas no se anula por debajo del flete.
    expect(await rejection(purchases.cancel(admin, coils.id, { reason: 'prueba' }))).toBe(400);

    await purchases.cancel(admin, freight.id, { reason: 'Flete equivocado' });
    expect([await effective(entry.id), await effective(out.id)]).toEqual([
      '4000.0000',
      '1600.0000',
    ]);
    const after = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId: coil.id } });
    expect(after.avgCost.toString()).toBe('4');
    expect(
      (await prisma.coil.findUniqueOrThrow({ where: { id: coil.id } })).unitCostPerKg.toString(),
    ).toBe('4');
  });

  it('anular la bobina se lleva el flete; después el flete se anula sin restar dos veces (P1-2)', async () => {
    const coils = await coilPurchase();
    const coil = await prisma.coil.findFirstOrThrow({ where: { purchaseId: coils.id } });
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);
    await moduleRef.get(CoilOperationsService).cancel(admin, coil.id, { reason: 'bobina errada' });
    // La reversa salió al costo efectivo (4 100): el saldo queda en cero, sin valor.
    const gone = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId: coil.id } });
    expect(gone.qty.toString()).toBe('0');
    await purchases.cancel(admin, freight.id, { reason: 'Flete de una bobina anulada' });
    expect(
      await prisma.inventoryMovement.count({
        where: { itemId: coil.id, notes: { startsWith: 'Anulación: ' } },
      }),
    ).toBe(0);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: freight.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('sin consumo, la compra de bobinas tampoco se anula con el flete vivo; anulado el flete, sí', async () => {
    const coils = await coilPurchase();
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);
    await expect(purchases.cancel(admin, coils.id, { reason: 'prueba' })).rejects.toThrow(
      'anúlalo primero',
    );
    await purchases.cancel(admin, freight.id, { reason: 'Flete equivocado' });
    await purchases.cancel(admin, coils.id, { reason: 'prueba' });
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: coils.id } })).status).toBe(
      'CANCELLED',
    );
  });

  it('una bobina ya consumida entera también lo recibe (antes se perdía)', async () => {
    const coils = await coilPurchase();
    const { coil, out } = await consume(coils.id, '1000');
    const freight = await service({ serviceKind: 'FREIGHT', relatedPurchaseId: coils.id });
    await purchases.receive(admin, freight.id);
    expect(await effective(out.id)).toBe('4100.0000');
    const received = await auditsOf('purchases', freight.id, 'purchases.receive');
    expect(received[0]?.after).toMatchObject({
      landedCost: { imputed: true, amountPen: '100.0000' },
    });
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId: coil.id } });
    expect(balance.qty.toString()).toBe('0');
  });
});
