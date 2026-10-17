import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  closeRoofingOrderSchema,
  createCustomerSchema,
  createDispatchSchema,
  createFinishSchema,
  createInvoiceSchema,
  createProductSchema,
  createPurchaseSchema,
  createQuotationSchema,
  createSupplierSchema,
  mountRoofingCoilSchema,
  registerCreditNoteSchema,
  reportRoofingPiecesSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CatalogService } from '../catalog/catalog.service';
import { CustomersService } from '../customers/customers.service';
import { FinishesService } from '../finishes/finishes.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { InvoicingService } from '../invoicing/invoicing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { PurchasesService } from '../purchases/purchases.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { DocumentProfitabilityService } from './document-profitability.service';
import { SalesMarginService } from './sales-margin.service';

/**
 * cc55 (D-667) — **un solo costo para lo fabricado contra pedido**, contra una base real.
 *
 * Dos pedidos del mismo SKU a medida, fabricados con bobinas de distinto precio (S/ 5 y S/ 9 el
 * kilo). Las dos OP entran al mismo saldo del SKU, así que el promedio con el que sale el despacho
 * del primero mezcla las dos corridas (el caso 10a de audit-01, FFA1-00001360). «Ventas y margen» y
 * la rentabilidad del comprobante tienen que dar el mismo costo, y ese costo es el de su OP.
 */
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(10 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let admin: RequestUser;
let roofingLineId = '';
let supplierId = '';
let customerId = '';
let finishId = '';
let colorId = '';
let correlative = Math.floor(Math.random() * 50_000) + 120_000;
const TODAY = businessToday();

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');
const m = (meters: number, qty: number) => ({ lengthMm: (meters * 1000).toFixed(2), qty });

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
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
  roofingLineId = (
    await prisma.businessLine.findUniqueOrThrow({ where: { code: 'METALLIC_ROOFING' } })
  ).id;
  colorId = (await prisma.color.findUniqueOrThrow({ where: { code: 'VERDE' } })).id;
  supplierId = (
    await moduleRef.get(SuppliersService).create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor cc55 costo',
        creditDays: 0,
      }),
    )
  ).id;
  customerId = (
    await moduleRef.get(CustomersService).create(
      admin,
      createCustomerSchema.parse({
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Cliente cc55 costo',
        creditDays: 0,
      }),
    )
  ).id;
  finishId = (
    await moduleRef.get(FinishesService).create(
      admin,
      createFinishSchema.parse({
        code: `C${letters(5)}`,
        name: 'Acabado cc55',
        densityFactor: '8',
        kind: 'PREPINTADO',
        colorId,
        businessLine: 'metallic-roofing',
      }),
    )
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

async function coil(unitPrice: string): Promise<string> {
  const purchases = moduleRef.get(PurchasesService);
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number: digits(8),
      issueDate: TODAY,
      currency: 'PEN',
      paymentTerms: 'CONTADO',
      businessLine: 'metallic-roofing',
      type: 'COIL',
      items: [
        {
          description: 'Bobina cc55',
          qty: '500',
          unit: 'KGM',
          unitPrice,
          finishId,
          widthMm: '1000',
          thicknessMm: '0.75',
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return (await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } })).id;
}

interface Made {
  orderId: string;
  itemId: string;
  opId: string;
}

/** Un pedido de 12 m del producto, fabricado entero con una bobina del precio dado y cerrado. */
async function made(productId: string, coilPrice: string, scrapKg = 0): Promise<Made> {
  const coilId = await coil(coilPrice);
  const quotation = await moduleRef.get(QuotationsService).create(
    admin,
    createQuotationSchema.parse({
      customerId,
      issueDate: TODAY,
      items: [{ productId, unitPricePen: '60', qty: '12.000', pieces: [m(6, 2)] }],
    }),
  );
  const order = await moduleRef.get(SalesOrdersService).confirm(admin, quotation.id, {});
  const raw = order.reservations.find((r) => r.itemType === 'RAW_MATERIAL');
  if (!raw?.productionOrderId) throw new Error('La confirmación no dejó la OP');
  const roofing = moduleRef.get(RoofingProductionService);
  await roofing.mountCoil(admin, raw.productionOrderId, mountRoofingCoilSchema.parse({ coilId }));
  await roofing.report(
    admin,
    raw.productionOrderId,
    reportRoofingPiecesSchema.parse({ coilId, pieces: [m(6, 2)] }),
  );
  if (scrapKg > 0) {
    const reports = await prisma.productionReport.findMany({
      where: { productionOrderId: raw.productionOrderId },
      select: { theoreticalKg: true },
    });
    const theoretical = reports.reduce((acc, r) => acc + Number(r.theoreticalKg), 0);
    await roofing.close(
      admin,
      raw.productionOrderId,
      closeRoofingOrderSchema.parse({
        consumedKg: (theoretical + scrapKg).toFixed(3),
        reason: 'despunte cc57',
      }),
    );
  } else {
    await roofing.close(admin, raw.productionOrderId, closeRoofingOrderSchema.parse({}));
  }
  return { orderId: order.id, itemId: order.items[0]?.id ?? '', opId: raw.productionOrderId };
}

/** Despacha el pedido entero y lo factura (manual) declarando ese despacho. */
async function invoiced(s: Made): Promise<string> {
  const dispatch = await moduleRef.get(DispatchesService).create(
    admin,
    createDispatchSchema.parse({
      salesOrderId: s.orderId,
      dispatchDate: TODAY,
      originAddress: 'Almacén cc55',
      destinationAddress: 'Cliente cc55',
      originUbigeo: '150101',
      destinationUbigeo: '150101',
      transferMode: 'PICKUP',
      items: [{ salesOrderItemId: s.itemId, qty: '12.000' }],
    }),
  );
  const invoicing = moduleRef.get(InvoicingService);
  const draft = await invoicing.create(
    admin,
    createInvoiceSchema.parse({
      docType: 'FACTURA',
      customerId,
      salesOrderId: s.orderId,
      issueDate: TODAY,
      dispatchId: dispatch.id,
      items: [{ salesOrderItemId: s.itemId, qty: '12.000' }],
    }),
  );
  const invoice = await invoicing.registerManual(admin, draft.id, {
    series: 'F955',
    correlative: (correlative += 1),
  });
  return invoice.id;
}

describe('cc55 (D-667): el costo de una cobertura a medida es el de su OP, en los dos reportes', () => {
  it('Ventas y margen y la rentabilidad del comprobante dan el mismo costo, y no es el promedio', async () => {
    const productId = (
      await moduleRef.get(CatalogService).create(
        admin,
        createProductSchema.parse({
          businessLineId: roofingLineId,
          sku: `E-CC55${letters(6)}`,
          name: 'Cobertura cc55 a medida',
          unit: 'MTR',
          source: 'MANUFACTURED',
          listPricePen: '30',
          finishId,
          colorId,
          thicknessMm: '0.75',
          widthMm: '1000',
          roofingKind: 'A_MEDIDA',
        }),
      )
    ).id;
    // Las dos corridas entran al mismo SKU antes de despachar la primera: su despacho sale al
    // promedio de las dos.
    // cc57 (E-15): la corrida barata cierra con despunte (5 kg más que lo teórico).
    const cheap = await made(productId, '5', 5);
    const dear = await made(productId, '9');
    const invoiceId = await invoiced(cheap);

    const op = await prisma.productionOrder.findUniqueOrThrow({ where: { id: cheap.opId } });
    const opCost = op.totalCostPen?.toFixed(4);
    const dispatchOut = await prisma.inventoryMovement.findFirstOrThrow({
      where: { refType: 'SALE', itemId: productId, type: 'OUT' },
      orderBy: { id: 'desc' },
    });
    // La base vieja de «Ventas y margen»: el promedio de las dos corridas, más caro que la OP.
    expect(dispatchOut.totalCost.toFixed(4)).not.toBe(opCost);

    const profit = await moduleRef.get(DocumentProfitabilityService).profitability(invoiceId);
    const margin = await moduleRef.get(SalesMarginService).salesMargin({ from: TODAY, to: TODAY });
    const doc = margin.orders.flatMap((o) => o.documents).find((d) => d.id === invoiceId);
    expect(doc?.costPen).toBe(profit.total.costPen);
    expect(profit.total.costPen).toBe(opCost);
    // El pedido entero va por el mismo costo (un solo comprobante).
    const row = margin.orders.find((o) => o.salesOrderId === cheap.orderId);
    expect(row?.costPen).toBe(opCost);
    expect(row?.costStatus).toBe('COMPLETO');
    // cc57 (E-15 de audit-01): «Material de OPs» es el de la OP, despunte incluido (la corrida
    // barata cerró con despunte: sin él la prueba no distinguiría).
    expect(Number(op.scrapKg ?? 0)).toBeGreaterThan(0);
    expect(row?.opMaterialCostPen).toBe(op.materialCostPen?.toFixed(4));
    // La otra corrida no se despachó: no tiene comprobante en el reporte.
    expect(margin.orders.some((o) => o.salesOrderId === dear.orderId)).toBe(false);
  });
});

describe('cc57 (E-02 de audit-01): la NC de devolución de una cobertura, en los dos reportes', () => {
  it('Ventas y margen y la rentabilidad de la NC restan el mismo costo (D-667: el de la OP)', async () => {
    const productId = (
      await moduleRef.get(CatalogService).create(
        admin,
        createProductSchema.parse({
          businessLineId: roofingLineId,
          sku: `E-CC57${letters(6)}`,
          name: 'Cobertura cc57 a medida',
          unit: 'MTR',
          source: 'MANUFACTURED',
          listPricePen: '30',
          finishId,
          colorId,
          thicknessMm: '0.75',
          widthMm: '1000',
          roofingKind: 'A_MEDIDA',
        }),
      )
    ).id;
    const cheap = await made(productId, '5');
    await made(productId, '9');
    const invoiceId = await invoiced(cheap);
    const invoicing = moduleRef.get(InvoicingService);
    const invoiceItem = await prisma.fiscalDocumentItem.findFirstOrThrow({
      where: { documentId: invoiceId },
    });
    const note = await invoicing.registerCreditNote(
      admin,
      invoiceId,
      registerCreditNoteSchema.parse({
        reason: 'DEVOLUCION_ITEM',
        issueDate: TODAY,
        series: 'FC57',
        correlative: (correlative += 1),
        items: [{ affectedItemId: invoiceItem.id, qty: '6.000' }],
      }),
    );
    const returned = await prisma.salesReturnItem.aggregate({
      where: { salesReturn: { creditNoteId: note.id } },
      _sum: { totalCost: true },
    });
    const devCost = returned._sum.totalCost?.toFixed(4);
    const profit = await moduleRef.get(DocumentProfitabilityService).profitability(note.id);
    const margin = await moduleRef.get(SalesMarginService).salesMargin({ from: TODAY, to: TODAY });
    const doc = margin.orders.flatMap((o) => o.documents).find((d) => d.id === note.id);
    // Lo que acreditan los dos (D-667): la parte de la OP de lo devuelto, no el costo con que
    // reingresó la DEV- (el promedio del despacho, que mezcla las dos corridas).
    expect(profit.total.costPen).toBe('-181.8000');
    expect(devCost).not.toBe('181.8000');
    expect(doc?.costPen).toBe(profit.total.costPen);
  });
});
