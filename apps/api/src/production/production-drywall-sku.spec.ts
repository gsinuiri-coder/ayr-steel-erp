import { BadRequestException } from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  FinishKind,
  Prisma,
  ProductSource,
  ProductionOrderKind,
  ProductionOrderStatus,
} from '@prisma/client';
import { type OperationDateService } from '../common/operation-date.service';
import type { AuditService } from '../audit/audit.service';
import type { CoilsService } from '../coils/coils.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ProductionService } from './production.service';

/**
 * D-344 — la orden de producción de drywall sin receta: el fleje que sirve lo dice el SKU del
 * perfil (galvanizado + espesor exacto + ancho exacto). Se prueba de punta a punta lo que ya no
 * pasa por una receta: abrir la orden, montar un fleje y ofrecer los flejes de `/planta`.
 */

const D = (v: string) => new Prisma.Decimal(v);
const ADMIN = { id: 'u-1', role: 'ADMINISTRADOR' } as never;
const BL = 'bl-drywall';

function product(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    sku: 'OMEGA045',
    isActive: true,
    source: ProductSource.MANUFACTURED,
    unit: 'NIU',
    businessLineId: BL,
    businessLine: { id: BL, code: BusinessLineCode.DRYWALL },
    thicknessMm: D('0.45'),
    widthMm: D('115.00'),
    pieceWeightKg: D('1.220'),
    ...over,
  };
}

function build() {
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const coils = { lockCoil: jest.fn() };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'o-1' }]),
    productionOrder: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'o-1', seq: 12, targetPieces: 50, reservationId: null }),
      findUniqueOrThrow: jest.fn(),
    },
    product: { findUniqueOrThrow: jest.fn() },
    finish: { findUnique: jest.fn() },
  };
  const prisma = {
    product: { findUnique: jest.fn() },
    coil: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  const operationDate = { resolve: jest.fn().mockReturnValue('2026-09-27') };
  const service = new ProductionService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    {} as InventoryService,
    coils as unknown as CoilsService,
    operationDate as unknown as OperationDateService,
  );
  // `findOne` arma el DTO entero y no es lo que se prueba acá.
  jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'o-1' } as never);
  return { service, prisma, tx, audit, coils };
}

describe('ProductionService.create — drywall sin receta (D-344)', () => {
  it('abre la orden desde el SKU, sin receta: no lleva bomId y la auditoría dice qué fleje consume', async () => {
    const { service, prisma, tx, audit } = build();
    prisma.product.findUnique.mockResolvedValue(product());
    await service.create(ADMIN, { productId: 'p-1', targetPieces: 50 });

    const data = (tx.productionOrder.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).toMatchObject({
      kind: ProductionOrderKind.DRYWALL,
      productId: 'p-1',
      status: ProductionOrderStatus.DRAFT,
    });
    expect(data).not.toHaveProperty('bomId');
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'production.create',
        after: expect.objectContaining({
          strip: { thicknessMm: '0.45', widthMm: '115.00' },
        }) as unknown,
      }),
    );
  });

  it.each([
    ['espesor', { thicknessMm: null }, /no tiene espesor en el SKU/],
    ['ancho del fleje', { widthMm: null }, /no tiene ancho del fleje en el SKU/],
    ['peso por pieza', { pieceWeightKg: null }, /no tiene peso por pieza/],
  ])(
    'sin %s en el SKU no se abre la orden, con un mensaje que dice qué cargar',
    async (_n, over, msg) => {
      const { service, prisma, tx } = build();
      prisma.product.findUnique.mockResolvedValue(product(over));
      await expect(service.create(ADMIN, { productId: 'p-1' })).rejects.toThrow(msg);
      expect(tx.productionOrder.create).not.toHaveBeenCalled();
    },
  );

  it('un perfil comprado o medido en kilos no se produce: lo que la receta exigía, ahora lo exige la orden (D-055/D-059)', async () => {
    const { service, prisma, tx } = build();
    prisma.product.findUnique.mockResolvedValueOnce(product({ source: ProductSource.PURCHASED }));
    await expect(service.create(ADMIN, { productId: 'p-1' } as never)).rejects.toThrow(
      /no es un producto fabricado/,
    );
    prisma.product.findUnique.mockResolvedValueOnce(product({ unit: 'KGM' }));
    await expect(service.create(ADMIN, { productId: 'p-1' } as never)).rejects.toThrow(
      /se debe medir en unidades \(NIU\)/,
    );
    expect(tx.productionOrder.create).not.toHaveBeenCalled();
  });

  it('un producto que no es de drywall sigue rechazándose por esta ruta', async () => {
    const { service, prisma } = build();
    prisma.product.findUnique.mockResolvedValue(
      product({ businessLine: { id: 'bl-2', code: BusinessLineCode.METALLIC_ROOFING } }),
    );
    await expect(service.create(ADMIN, { productId: 'p-1' })).rejects.toThrow(
      /produce perfiles de Drywall/,
    );
  });
});

describe('ProductionService.consume — el fleje compatible sale del SKU (D-344)', () => {
  const order = () => ({
    id: 'o-1',
    seq: 12,
    kind: ProductionOrderKind.DRYWALL,
    status: ProductionOrderStatus.DRAFT,
    businessLineId: BL,
    productId: 'p-1',
    notes: null,
    closedAt: null,
    reservationId: null,
  });
  const strip = (over: Record<string, unknown> = {}) => ({
    id: 'c-1',
    code: 'FLEJE-1',
    kind: CoilKind.STRIP,
    status: CoilStatus.OPEN,
    businessLineId: BL,
    finishId: 'fin-galv',
    thicknessMm: D('0.45'),
    widthMm: D('115.00'),
    ...over,
  });

  function setup(coil: ReturnType<typeof strip>, finishKind: FinishKind | null) {
    const ctx = build();
    ctx.tx.productionOrder.findUniqueOrThrow.mockResolvedValue(order());
    ctx.tx.product.findUniqueOrThrow.mockResolvedValue(product());
    ctx.coils.lockCoil.mockResolvedValue(coil);
    ctx.tx.finish.findUnique.mockResolvedValue(finishKind === null ? null : { kind: finishKind });
    return ctx;
  }
  const consume = (s: ProductionService) => s.consume(ADMIN, 'o-1', { coilId: 'c-1' });

  it('un fleje con otro ancho se rechaza y el mensaje nombra los tres datos', async () => {
    const { service } = setup(strip({ widthMm: D('120.00') }), FinishKind.GALVANIZADO);
    const error = await consume(service).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const message = (error as BadRequestException).message;
    expect(message).toContain('FLEJE-1 no es compatible con el perfil');
    expect(message).toContain('galvanizado');
    expect(message).toContain('0.45 mm de espesor');
    expect(message).toContain('115.00 mm de ancho');
  });

  it('el espesor es exacto: 0.46 no es 0.45 (drywall no usa la tolerancia de coberturas)', async () => {
    const { service } = setup(strip({ thicknessMm: D('0.46') }), FinishKind.GALVANIZADO);
    await expect(consume(service)).rejects.toThrow(/no es compatible con el perfil/);
  });

  it('un fleje de otro acabado (no galvanizado) se rechaza', async () => {
    const { service } = setup(strip(), FinishKind.NATURAL);
    await expect(consume(service)).rejects.toThrow(/fleje de acabado galvanizado/);
  });

  it('un fleje sin acabado resoluble tampoco pasa', async () => {
    const { service } = setup(strip(), null);
    await expect(consume(service)).rejects.toThrow(/no es compatible con el perfil/);
  });

  it('galvanizado, espesor y ancho iguales: la compatibilidad pasa y sigue con las demás guardas', async () => {
    const { service, tx } = setup(strip(), FinishKind.GALVANIZADO);
    // La primera guarda posterior a la compatibilidad consulta reservas por el lock: si llega
    // hasta acá, el fleje fue aceptado.
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'o-1' }])
      .mockRejectedValueOnce(new Error('siguiente guarda'));
    await expect(consume(service)).rejects.toThrow('siguiente guarda');
  });

  it('un perfil sin espesor en el SKU no puede recibir flejes: no se sabe cuál sirve', async () => {
    const ctx = setup(strip(), FinishKind.GALVANIZADO);
    ctx.tx.product.findUniqueOrThrow.mockResolvedValue(product({ thicknessMm: null }));
    await expect(consume(ctx.service)).rejects.toThrow(/no tiene espesor en el SKU/);
    expect(ctx.coils.lockCoil).not.toHaveBeenCalled();
  });

  it('un perfil sin ancho del fleje en el SKU tampoco', async () => {
    const ctx = setup(strip(), FinishKind.GALVANIZADO);
    ctx.tx.product.findUniqueOrThrow.mockResolvedValue(product({ widthMm: null }));
    await expect(consume(ctx.service)).rejects.toThrow(/no tiene ancho del fleje en el SKU/);
  });
});

describe('ProductionService.stripOptions — flejes que ofrece /planta (D-344)', () => {
  it('pide flejes abiertos, galvanizados y de espesor y ancho exactos del SKU, y calcula las piezas con el peso del SKU', async () => {
    const { service, prisma } = build();
    prisma.product.findUnique.mockResolvedValue(product());
    prisma.coil.findMany.mockResolvedValue([
      {
        id: 'c-1',
        code: 'FLEJE-1',
        widthMm: D('115.00'),
        thicknessMm: D('0.45'),
        finish: { code: 'GALV' },
        parentCoil: null,
      },
    ]);
    prisma.inventoryBalance.findMany.mockResolvedValue([{ itemId: 'c-1', qty: D('122.000') }]);
    // Sin asignaciones vivas: `findLiveStripAssignments` consulta la tabla de consumos.
    (prisma as unknown as Record<string, unknown>).productionOrderConsumption = {
      findMany: jest.fn().mockResolvedValue([]),
    };

    const options = await service.stripOptions('p-1');

    expect(prisma.coil.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: CoilKind.STRIP,
          status: CoilStatus.OPEN,
          businessLineId: BL,
          finish: { kind: FinishKind.GALVANIZADO },
          thicknessMm: '0.45',
          widthMm: '115.00',
        },
      }),
    );
    // 122 kg ÷ 1.220 kg por pieza = 100 piezas.
    expect(options).toEqual([expect.objectContaining({ coilId: 'c-1', estimatedPieces: 100 })]);
  });

  it('un producto que no existe da 404 y uno sin espesor o ancho da un error que dice qué cargar', async () => {
    const { service, prisma } = build();
    prisma.product.findUnique.mockResolvedValueOnce(null);
    await expect(service.stripOptions('nada')).rejects.toThrow(/Producto no encontrado/);
    prisma.product.findUnique.mockResolvedValueOnce(product({ thicknessMm: null }));
    await expect(service.stripOptions('p-1')).rejects.toThrow(/no tiene espesor en el SKU/);
    prisma.product.findUnique.mockResolvedValueOnce(product({ widthMm: null }));
    await expect(service.stripOptions('p-1')).rejects.toThrow(/no tiene ancho del fleje en el SKU/);
  });
});
