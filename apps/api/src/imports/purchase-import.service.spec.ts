import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role, type PurchaseImportDocumentInput } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { OperationDateService } from '../common/operation-date.service';
import type { DocumentLookupService } from '../customers/document-lookup.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PurchasesService } from '../purchases/purchases.service';
import type { SuppliersService } from '../suppliers/suppliers.service';
import { PurchaseImportService } from './purchase-import.service';

/**
 * D-351 — confirmar el importador de compras: todo o nada con un SAVEPOINT por comprobante,
 * idempotente (D-182), proveedor nuevo desde el padrón en la misma transacción, la marca «Es otra
 * compra» en la auditoría del lote (D-352), y deshacer el lote por el servicio.
 */

const ADMIN = { id: 'u-admin', role: Role.ADMINISTRADOR } as never;
const SUPERVISOR = { id: 'u-sup', role: Role.SUPERVISOR_PLANTA } as never;
const KNOWN = {
  id: 'sup-1',
  name: 'Aceros SAC',
  code: 'ACE',
  docNumber: '20100000001',
  isActive: true,
  docType: 'RUC',
};

function document(over: Partial<PurchaseImportDocumentInput> = {}): PurchaseImportDocumentInput {
  return {
    key: `k-${over.number ?? '1'}`,
    type: 'Gasto',
    businessLine: 'Servicios',
    docType: 'Factura',
    series: 'F001',
    number: '1',
    issueDate: '2026-09-20',
    supplierRuc: KNOWN.docNumber,
    supplierId: null,
    newSupplierCode: null,
    currency: 'PEN',
    exchangeRate: '',
    paymentTerms: 'Contado',
    creditDays: '',
    serviceKind: '',
    igvRate: '18',
    notes: '',
    documentTotal: '',
    confirmedNotInitialLoad: false,
    lines: [
      {
        rowNumber: 2,
        sku: '',
        productId: null,
        description: 'Luz',
        qty: '1',
        unit: 'NIU',
        unitPrice: '100',
        lineAmount: '',
        finishCode: '',
        finishId: null,
        color: '',
        thicknessMm: '',
        widthMm: '',
        externalCode: '',
      },
    ],
    ...over,
  };
}

function setup(
  opts: {
    claimed?: boolean;
    padron?: Record<string, string>;
    references?: { notes: string; code: string }[];
  } = {},
) {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue(opts.claimed === false ? [] : [{ resource_id: 'x' }]),
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue({
        scope: 'purchase-import:confirm',
        resourceId: '11111111-1111-1111-1111-111111111111',
      }),
    },
    purchase: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'pu-1', series: 'F001', number: '1', supplier: { name: 'Aceros SAC' } },
        ]),
    },
  };
  const prisma = {
    supplier: {
      findMany: jest.fn(({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve(Object.keys(select).length === 1 ? [{ code: 'ACE' }] : [KNOWN]),
      ),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    finish: { findMany: jest.fn().mockResolvedValue([]) },
    coil: { findMany: jest.fn().mockResolvedValue(opts.references ?? []) },
    inventoryMovement: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    purchase: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.claimed === false
            ? [{ id: 'pu-1', series: 'F001', number: '1', supplier: { name: 'Aceros SAC' } }]
            : [],
        ),
    },
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue(
        opts.claimed === false
          ? {
              scope: 'purchase-import:confirm',
              resourceId: '11111111-1111-1111-1111-111111111111',
            }
          : null,
      ),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const purchases = {
    resolveExchangeRate: jest.fn(),
    createInTx: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    cancel: jest.fn().mockResolvedValue({}),
  };
  const suppliers = { createInTx: jest.fn().mockResolvedValue({ id: 'sup-new' }) };
  const padron = {
    lookup: jest.fn((_type: string, ruc: string) =>
      Promise.resolve(
        opts.padron?.[ruc] ? { found: true, name: opts.padron[ruc] } : { found: false, name: null },
      ),
    ),
  };
  const audit = {
    write: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PurchaseImportService(
    prisma as unknown as PrismaService,
    purchases as unknown as PurchasesService,
    suppliers as unknown as SuppliersService,
    padron as unknown as DocumentLookupService,
    { historicalLoadStart: '2026-08-01' } as OperationDateService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, purchases, suppliers, audit };
}

describe('PurchaseImportService.confirm (D-351)', () => {
  it('crea cada compra por createInTx, en BORRADOR, con el lote y un SAVEPOINT por comprobante', async () => {
    const s = setup();
    const result = await s.service.confirm(ADMIN, {
      documents: [document(), document({ number: '2' })],
      fileName: 'compras.xlsx',
      idempotencyKey: 'clave-1',
    });
    expect(s.purchases.createInTx).toHaveBeenCalledTimes(2);
    const [, actor, input, exchange, options] = s.purchases.createInTx.mock.calls[0] as unknown[];
    expect(actor).toBe(ADMIN);
    expect(input).toMatchObject({ supplierId: 'sup-1', type: 'EXPENSE', number: '1' });
    expect(exchange).toMatchObject({ source: 'MANUAL' });
    expect((options as { importBatchId: string }).importBatchId).toBe(result.batchId);
    const raw = (s.tx.$executeRawUnsafe.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(raw).toEqual([
      'SAVEPOINT compra_0',
      'RELEASE SAVEPOINT compra_0',
      'SAVEPOINT compra_1',
      'RELEASE SAVEPOINT compra_1',
    ]);
    expect(s.audit.write).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({
        action: 'imports.purchases',
        entityId: result.batchId,
        after: expect.objectContaining({ purchases: 2, fileName: 'compras.xlsx' }),
      }),
    );
  });

  it('todo o nada: un comprobante que el servicio rechaza revierte a su savepoint y no entra ninguno', async () => {
    const s = setup();
    s.purchases.createInTx
      .mockResolvedValueOnce({ id: 'pu-1' })
      .mockRejectedValueOnce(new ConflictException('Ese comprobante ya está registrado'));
    const err = s.service.confirm(ADMIN, {
      documents: [document(), document({ number: '2' })],
      fileName: '',
      idempotencyKey: 'clave-2',
    });
    await expect(err).rejects.toBeInstanceOf(BadRequestException);
    await expect(err).rejects.toMatchObject({
      response: { errors: { 'k-2': ['Ese comprobante ya está registrado'] } },
    });
    expect(s.tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT compra_1');
    expect(s.audit.write).not.toHaveBeenCalled();
  });

  it('con errores de validación no abre la transacción', async () => {
    const s = setup();
    await expect(
      s.service.confirm(ADMIN, {
        documents: [document({ issueDate: '2030-01-01' })],
        fileName: '',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ response: { errors: { 'k-1': [expect.stringMatching(/futura/)] } } });
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('idempotencia (D-182): la misma clave devuelve el lote ya creado sin crear nada', async () => {
    const s = setup({ claimed: false });
    const result = await s.service.confirm(ADMIN, {
      documents: [document()],
      fileName: '',
      idempotencyKey: 'repetida',
    });
    expect(result.batchId).toBe('11111111-1111-1111-1111-111111111111');
    expect(s.purchases.createInTx).not.toHaveBeenCalled();
    // Autorrevisión (P1): el reintento no vuelve a validar — si validara, las compras que ya
    // creó el primer envío se verían como «Ya registrada» y el lote se perdería.
    expect(s.prisma.supplier.findMany).not.toHaveBeenCalled();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(result.purchases).toEqual([{ id: 'pu-1', document: 'F001-1', supplier: 'Aceros SAC' }]);
  });

  it('proveedor nuevo desde el padrón: el nombre del padrón y el código elegido, en la misma transacción', async () => {
    const s = setup({ padron: { '20999999999': 'NUEVO PROVEEDOR SAC' } });
    await s.service.confirm(SUPERVISOR, {
      documents: [document({ supplierRuc: '20999999999', newSupplierCode: 'npr' })],
      fileName: '',
      idempotencyKey: 'k-new',
    });
    expect(s.suppliers.createInTx).toHaveBeenCalledWith(
      s.tx,
      SUPERVISOR,
      expect.objectContaining({
        code: 'NPR',
        docNumber: '20999999999',
        name: 'NUEVO PROVEEDOR SAC',
      }),
    );
    expect((s.purchases.createInTx.mock.calls as unknown as unknown[][])[0]?.[2]).toMatchObject({
      supplierId: 'sup-new',
    });
  });

  it('D-352: la marca «Es otra compra» entra y queda en la auditoría del lote con el usuario', async () => {
    const s = setup({
      references: [
        { code: 'BOB-9', notes: 'Saldo inicial de inventario · factura ref: F001-0001 ·' },
      ],
    });
    await expect(
      s.service.confirm(ADMIN, { documents: [document()], fileName: '', idempotencyKey: 'a' }),
    ).rejects.toMatchObject({
      response: { errors: { 'k-1': [expect.stringMatching(/¿Es otra compra\?/)] } },
    });

    await s.service.confirm(ADMIN, {
      documents: [document({ confirmedNotInitialLoad: true })],
      fileName: '',
      idempotencyKey: 'b',
    });
    expect(s.audit.write).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({
        after: expect.objectContaining({
          notInitialLoadConfirmations: [
            {
              document: 'F001-1',
              supplierRuc: '20100000001',
              reference: 'F001-1',
              confirmedById: 'u-admin',
            },
          ],
        }),
      }),
    );
  });

  it('un error que no es de dominio corta en el acto (la transacción quedó abortada)', async () => {
    const s = setup();
    s.purchases.createInTx.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('x', { code: 'P1', clientVersion: 'x' }),
    );
    await expect(
      s.service.confirm(ADMIN, { documents: [document()], fileName: '', idempotencyKey: 'c' }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe('PurchaseImportService.undo (D-351)', () => {
  it('anula por el servicio las que siguen en borrador sin pagos; nombra las demás', async () => {
    const s = setup();
    s.prisma.purchase.findMany.mockResolvedValue([
      { id: 'a', series: 'F001', number: '1', status: 'DRAFT', payments: [] },
      { id: 'b', series: 'F001', number: '2', status: 'RECEIVED', payments: [] },
      { id: 'c', series: 'F001', number: '3', status: 'DRAFT', payments: [{ id: 'pay' }] },
      { id: 'd', series: 'F001', number: '4', status: 'CANCELLED', payments: [] },
    ]);
    const result = await s.service.undo(
      ADMIN,
      '22222222-2222-2222-2222-222222222222',
      'Archivo equivocado',
    );
    expect(s.purchases.cancel).toHaveBeenCalledTimes(1);
    expect(s.purchases.cancel).toHaveBeenCalledWith(
      ADMIN,
      'a',
      {
        reason: 'Archivo equivocado (lote 22222222)',
      },
      { onlyDraft: true },
    );
    expect(result.cancelled).toEqual(['F001-1']);
    expect(result.kept).toEqual([
      { document: 'F001-2', reason: 'ya se recibió: anúlala desde la compra si corresponde' },
      { document: 'F001-3', reason: 'tiene pagos registrados' },
      { document: 'F001-4', reason: 'ya estaba anulada' },
    ]);
    expect(s.audit.write).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({ action: 'imports.purchases.undo' }),
    );
  });

  it('solo ADMINISTRADOR; un lote vacío es 404', async () => {
    const s = setup();
    await expect(s.service.undo(SUPERVISOR, 'x', 'motivo')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    s.prisma.purchase.findMany.mockResolvedValue([]);
    await expect(s.service.undo(ADMIN, 'x', 'motivo')).rejects.toThrow(/no tiene compras/);
  });
});

describe('PurchaseImportService.preview (D-351)', () => {
  it('lee el archivo, valida y no escribe nada', async () => {
    const s = setup();
    const csv = [
      'TIPO DE COMPRA,LÍNEA DE NEGOCIO,TIPO DE COMPROBANTE,SERIE-NÚMERO,FECHA DE EMISIÓN,RUC PROVEEDOR,MONEDA,CONDICIÓN DE PAGO,DESCRIPCIÓN,CANTIDAD,PRECIO UNITARIO SIN IGV',
      'Gasto,Servicios,Factura,F001-1,20/09/2026,20100000001,PEN,Contado,Luz,1,100',
    ].join('\n');
    const preview = await s.service.preview('compras.csv', Buffer.from(csv, 'utf8'));
    expect(preview.documents).toHaveLength(1);
    expect(preview.documents[0]).toMatchObject({
      supplierId: 'sup-1',
      total: '118.00',
      issues: [],
    });
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cc34: avisa si el mismo comprobante aparece dos veces en el archivo, con y sin ceros', async () => {
    const s = setup();
    const csv = [
      'TIPO DE COMPRA,LÍNEA DE NEGOCIO,TIPO DE COMPROBANTE,SERIE-NÚMERO,FECHA DE EMISIÓN,RUC PROVEEDOR,MONEDA,CONDICIÓN DE PAGO,DESCRIPCIÓN,CANTIDAD,PRECIO UNITARIO SIN IGV',
      'Gasto,Servicios,Factura,F001-00012,20/09/2026,20100000001,PEN,Contado,Luz,1,100',
      'Gasto,Servicios,Factura,F001-12,20/09/2026,20100000001,PEN,Contado,Agua,1,50',
      'Gasto,Servicios,Factura,F001-13,20/09/2026,20100000001,PEN,Contado,Gas,1,20',
    ].join('\n');
    const preview = await s.service.preview('compras.csv', Buffer.from(csv, 'utf8'));
    expect(preview.documents).toHaveLength(3);
    const [zeros, plain, other] = preview.documents;
    expect(zeros!.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        field: 'document',
        message: expect.stringContaining('también como F001-12'),
      }),
    ]);
    expect(plain!.issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining('también como F001-00012') }),
    ]);
    expect(other!.issues).toEqual([]);
  });
});
