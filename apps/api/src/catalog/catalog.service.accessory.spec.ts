import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BusinessLineCode,
  ProductSource,
  QuotationStatus,
  RoofingProductKind,
} from '@prisma/client';
import {
  Decimal,
  canonicalAccessorySku,
  reportAndCloseRoofingSchema,
  reportRoofingPiecesSchema,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ColorsService } from '../colors/colors.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService } from './catalog.service';

/**
 * D-343 — el catálogo de un accesorio: el SKU **es** `ACCES` + espesor de 3 dígitos + color
 * comercial, se mide en metros lineales (`MTR`), no lleva largo, y su espesor, color y subtipo no
 * cambian (el SKU los refleja y el SKU no se edita).
 */

const ACTOR = { id: 'u-1' } as never;
const STOP = new Error('llegó a la transacción');
const COLOR_ID = 'color-rojo';
const FINISH_ID = 'finish-rojo';

const baseInput = {
  businessLineId: 'bl-roofing',
  sku: 'ACCES030ROJO',
  name: 'Accesorio 0.30 rojo',
  unit: 'MTR',
  source: ProductSource.MANUFACTURED,
  finishId: FINISH_ID,
  colorId: COLOR_ID,
  thicknessMm: '0.30',
  widthMm: '1220.00',
  lengthMm: null,
  pieceWeightKg: null,
  roofingKind: RoofingProductKind.ACCESORIO,
  listPricePen: null,
};

function stored(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'p-acc',
    businessLineId: 'bl-roofing',
    businessLine: { code: BusinessLineCode.METALLIC_ROOFING },
    sku: 'ACCES030ROJO',
    name: 'Accesorio 0.30 rojo',
    unit: 'MTR',
    listPricePen: null,
    colorId: COLOR_ID,
    color: null,
    finishId: FINISH_ID,
    finish: null,
    thicknessMm: new Decimal('0.30'),
    widthMm: new Decimal('1220.00'),
    lengthMm: null,
    pieceWeightKg: null,
    roofingKind: RoofingProductKind.ACCESORIO,
    isActive: true,
    mergedIntoId: null,
    source: ProductSource.MANUFACTURED,
    bom: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

describe('CatalogService — el accesorio (D-343)', () => {
  let service: CatalogService;
  const prisma = {
    businessLine: { findUnique: jest.fn() },
    finish: { findUnique: jest.fn() },
    color: { findUnique: jest.fn() },
    product: { findUnique: jest.fn() },
    productBom: { findFirst: jest.fn() },
    productionOrder: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  const colors = { resolveActive: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.businessLine.findUnique.mockResolvedValue({
      id: 'bl-roofing',
      code: BusinessLineCode.METALLIC_ROOFING,
    });
    prisma.finish.findUnique.mockResolvedValue({
      id: FINISH_ID,
      code: 'PREP-ROJO',
      isActive: true,
      kind: 'PREPINTADO',
      colorId: COLOR_ID,
      businessLineId: 'bl-roofing',
    });
    prisma.color.findUnique.mockResolvedValue({ code: 'ROJO-3020' });
    prisma.productBom.findFirst.mockResolvedValue(null);
    colors.resolveActive.mockResolvedValue(COLOR_ID);
    prisma.$transaction.mockRejectedValue(STOP);
    const moduleRef = await Test.createTestingModule({
      providers: [
        CatalogService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn() } },
        { provide: ColorsService, useValue: colors },
      ],
    }).compile();
    service = moduleRef.get(CatalogService);
  });

  describe('alta', () => {
    it('el SKU canónico pasa todas las validaciones y llega a la transacción', async () => {
      await expect(service.create(ACTOR, baseInput as never)).rejects.toBe(STOP);
    });

    it('el mismo SKU escrito en minúsculas también es el canónico', async () => {
      await expect(service.create(ACTOR, { ...baseInput, sku: 'acces030rojo' })).rejects.toBe(STOP);
    });

    it('un SKU que no refleja su espesor y su color se rechaza diciendo cuál es el correcto', async () => {
      await expect(service.create(ACTOR, { ...baseInput, sku: 'ACCES045AZUL' })).rejects.toThrow(
        /para este producto es ACCES030ROJO/,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un accesorio necesita color: de él salen el SKU y la bobina con que se fabrica', async () => {
      // Con un acabado sin mapear (anterior a D-203) el color del producto no se deriva de él; sin
      // color, el accesorio no tiene de dónde sacar el token de su SKU.
      colors.resolveActive.mockResolvedValue(null);
      prisma.finish.findUnique.mockResolvedValue({
        id: FINISH_ID,
        code: 'PREP-LEGADO',
        isActive: true,
        kind: null,
        colorId: null,
        businessLineId: 'bl-roofing',
      });
      await expect(service.create(ACTOR, { ...baseInput, colorId: null })).rejects.toThrow(
        /necesita su color/,
      );
    });

    it('se mide en metros lineales, como una cobertura a medida', async () => {
      await expect(service.create(ACTOR, { ...baseInput, unit: 'KGM' })).rejects.toThrow(
        /Un accesorio se mide en metros lineales \(MTR\)/,
      );
    });

    it('no lleva largo: se vende por metros de bobina', async () => {
      await expect(service.create(ACTOR, { ...baseInput, lengthMm: '6000.00' })).rejects.toThrow(
        /Un accesorio no lleva largo/,
      );
    });

    it('el espesor, el ancho y el acabado siguen siendo obligatorios (los necesita el kilo por metro)', async () => {
      await expect(service.create(ACTOR, { ...baseInput, thicknessMm: null })).rejects.toThrow(
        /espesor/,
      );
      await expect(service.create(ACTOR, { ...baseInput, widthMm: null })).rejects.toThrow(/ancho/);
    });

    it('el prefijo ACCES es de accesorios: otro subtipo no puede usarlo', async () => {
      await expect(
        service.create(ACTOR, {
          ...baseInput,
          sku: 'ACCES030ROJO',
          roofingKind: RoofingProductKind.A_MEDIDA,
        }),
      ).rejects.toThrow(/Los SKU ACCES… son de accesorios/);
    });

    it('una cobertura a medida normal sigue dándose de alta como siempre', async () => {
      await expect(
        service.create(ACTOR, {
          ...baseInput,
          sku: 'COB030ROJO',
          roofingKind: RoofingProductKind.A_MEDIDA,
        }),
      ).rejects.toBe(STOP);
    });
  });

  describe('edición', () => {
    beforeEach(() => {
      prisma.product.findUnique.mockResolvedValue(stored());
    });

    it('lo que no toca esos tres campos se edita normal (nombre, precio de lista)', async () => {
      await expect(
        service.update(ACTOR, 'p-acc', {
          name: 'Cumbrera 0.30 roja',
          thicknessMm: '0.30',
        }),
      ).rejects.toBe(STOP);
    });

    it('M5: editar solo el nombre y el precio, sin mandar espesor, color ni subtipo, no rebota', async () => {
      // El caso real (D-343/M5): el diálogo dejó de reenviar los campos que no se tocaron —antes
      // los mandaba siempre con el mismo valor, y cualquier edición rebotaba igual.
      await expect(
        service.update(ACTOR, 'p-acc', {
          name: 'Cumbrera 0.30 roja',
          listPricePen: '35.0000',
        }),
      ).rejects.toBe(STOP);
    });
  });

  /**
   * D-348 — subtipo, espesor y color de un accesorio cambian si el producto no tiene uso real.
   * Las cotizaciones anuladas o vencidas no cuentan; una viva, un pedido o el kardex sí.
   */
  describe('edición de la estructura sin uso real (D-348)', () => {
    interface Usage {
      quotations?: { seq: number; status: QuotationStatus }[];
      orders?: number[];
      movements?: number;
    }
    let usage: Usage;
    const update = jest.fn();
    const queryRaw = jest.fn();

    /** Aplica el filtro `quotation.status.notIn` que manda el código, como lo haría la base. */
    function live(where: { quotation?: { status: { notIn: QuotationStatus[] } } }) {
      return (usage.quotations ?? []).filter(
        (q) => !(where.quotation?.status.notIn ?? []).includes(q.status),
      );
    }

    beforeEach(() => {
      usage = {};
      update.mockReset().mockRejectedValue(STOP);
      queryRaw.mockReset().mockResolvedValue([]);
      prisma.product.findUnique.mockResolvedValue(stored());
      prisma.color.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({ code: where.id === 'color-azul' ? 'AZUL' : 'ROJO-3020' }),
      );
      colors.resolveActive.mockImplementation((id: string | null) => Promise.resolve(id));
      prisma.finish.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve({
          id: where.id,
          code: where.id,
          isActive: true,
          kind: 'PREPINTADO',
          colorId: where.id === 'finish-azul' ? 'color-azul' : COLOR_ID,
          businessLineId: 'bl-roofing',
        }),
      );
      const count = (n = 0) => jest.fn().mockResolvedValue(n);
      const tx = {
        $queryRaw: queryRaw,
        inventoryMovement: { count: count(usage.movements) },
        inventoryBalance: { count: count() },
        purchaseItem: { count: count() },
        salesOrderItem: { findMany: jest.fn() },
        fiscalDocumentItem: { count: count() },
        dispatchItem: { count: count() },
        productionOrder: { count: count() },
        reservation: { count: count() },
        quotationItem: { findMany: jest.fn() },
        quotationReservation: { count: count() },
        product: { update },
      };
      tx.inventoryMovement.count.mockImplementation(() => Promise.resolve(usage.movements ?? 0));
      tx.salesOrderItem.findMany.mockImplementation(() =>
        Promise.resolve((usage.orders ?? []).map((seq) => ({ salesOrder: { seq } }))),
      );
      tx.quotationItem.findMany.mockImplementation(({ where }) =>
        Promise.resolve(live(where).map((q) => ({ quotation: { seq: q.seq } }))),
      );
      prisma.$transaction.mockImplementation((fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    });

    it('solo con cotizaciones anuladas o vencidas: el espesor cambia junto con su SKU', async () => {
      usage.quotations = [
        { seq: 3, status: QuotationStatus.CANCELLED },
        { seq: 4, status: QuotationStatus.EXPIRED },
      ];
      await expect(
        service.update(ACTOR, 'p-acc', { thicknessMm: '0.45', sku: 'ACCES045ROJO' }),
      ).rejects.toBe(STOP);
      // Revalidó bajo lock dentro de la transacción y llegó a escribir el SKU nuevo.
      expect(queryRaw).toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sku: 'ACCES045ROJO', thicknessMm: '0.45' }),
        }),
      );
    });

    it('el color cambia si no hay uso real, con el SKU del color nuevo', async () => {
      await expect(
        service.update(ACTOR, 'p-acc', {
          colorId: 'color-azul',
          finishId: 'finish-azul',
          sku: 'ACCES030AZUL',
        }),
      ).rejects.toBe(STOP);
    });

    it('con una cotización emitida viva rebota nombrándola', async () => {
      usage.quotations = [
        { seq: 3, status: QuotationStatus.CANCELLED },
        { seq: 5, status: QuotationStatus.EMITTED },
      ];
      const err = service.update(ACTOR, 'p-acc', { thicknessMm: '0.45', sku: 'ACCES045ROJO' });
      await expect(err).rejects.toBeInstanceOf(ConflictException);
      await expect(err).rejects.toThrow(/cotización\(es\) vigente\(s\) COT-000005/);
      await expect(err).rejects.toThrow(/Crea otro producto y desactiva este/);
      expect(update).not.toHaveBeenCalled();
    });

    it('con un pedido rebota nombrándolo', async () => {
      usage.orders = [12];
      await expect(
        service.update(ACTOR, 'p-acc', { thicknessMm: '0.45', sku: 'ACCES045ROJO' }),
      ).rejects.toThrow(/pedido\(s\) PED-000012/);
    });

    it('con kardex rebota con el conteo', async () => {
      usage.movements = 2;
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.A_MEDIDA, sku: 'COB030' }),
      ).rejects.toThrow(/2 movimiento\(s\) de kardex/);
    });

    it('cambiar el espesor sin corregir el SKU es un error del campo SKU', async () => {
      const err = service.update(ACTOR, 'p-acc', { thicknessMm: '0.45' });
      await expect(err).rejects.toBeInstanceOf(BadRequestException);
      await expect(err).rejects.toMatchObject({
        response: { errors: { sku: [expect.stringMatching(/es ACCES045ROJO/)] } },
      });
    });

    it('pasar a accesorio con un SKU fuera del patrón es error de campo; con el canónico entra', async () => {
      prisma.product.findUnique.mockResolvedValue(
        stored({ roofingKind: RoofingProductKind.A_MEDIDA, sku: 'COB030ROJO' }),
      );
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.ACCESORIO }),
      ).rejects.toMatchObject({
        response: { errors: { sku: [expect.stringMatching(/es ACCES030ROJO/)] } },
      });
      await expect(
        service.update(ACTOR, 'p-acc', {
          roofingKind: RoofingProductKind.ACCESORIO,
          sku: 'ACCES030ROJO',
        }),
      ).rejects.toBe(STOP);
    });

    it('pasar a accesorio valida la unidad como en el alta (metros lineales)', async () => {
      prisma.product.findUnique.mockResolvedValue(
        stored({
          roofingKind: RoofingProductKind.PLANCHA,
          unit: 'NIU',
          lengthMm: new Decimal('3000.00'),
          sku: 'PL030ROJO',
        }),
      );
      await expect(
        service.update(ACTOR, 'p-acc', {
          roofingKind: RoofingProductKind.ACCESORIO,
          sku: 'ACCES030ROJO',
          lengthMm: null,
        }),
      ).rejects.toThrow(/Un accesorio se mide en metros lineales/);
    });

    it('dejar de ser accesorio obliga a salir del prefijo ACCES', async () => {
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.A_MEDIDA }),
      ).rejects.toMatchObject({
        response: { errors: { sku: [expect.stringMatching(/Los SKU ACCES… son de accesorios/)] } },
      });
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.A_MEDIDA, sku: 'COB030' }),
      ).rejects.toBe(STOP);
    });

    it('el SKU no se edita suelto, sin cambiar la estructura de un accesorio', async () => {
      await expect(service.update(ACTOR, 'p-acc', { sku: 'OTRO' })).rejects.toMatchObject({
        response: { errors: { sku: [expect.stringMatching(/El SKU no se edita/)] } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

describe('SKU canónico del accesorio y forma del reporte (D-343)', () => {
  it('ACCES + espesor de 3 dígitos + color comercial, con los tokens del SKU de bobina', () => {
    expect(canonicalAccessorySku('0.30', 'ROJO-3020')).toBe('ACCES030ROJO');
    expect(canonicalAccessorySku('0.45', 'Azul')).toBe('ACCES045AZUL');
    // El RAL no separa nada en venta (AGENTS §7): distintos RAL del mismo color comparten SKU.
    expect(canonicalAccessorySku('0.30', 'ROJO-3002')).toBe(
      canonicalAccessorySku('0.30', 'ROJO-3020'),
    );
    // Un espesor fuera de la regla del SKU no genera un SKU inventado.
    expect(() => canonicalAccessorySku('0.305', 'ROJO')).toThrow();
  });

  it.each([
    ['largos', { pieces: [{ lengthMm: '6000', qty: 2 }] }, true],
    ['metros de un accesorio', { meters: '25.000' }, true],
    ['metros con piezas informativas', { meters: '25.000', piecesCount: 4 }, true],
    ['los dos a la vez', { pieces: [{ lengthMm: '6000', qty: 2 }], meters: '25.000' }, false],
    ['ninguno de los dos', {}, false],
    [
      'piezas informativas sin metros',
      { pieces: [{ lengthMm: '6000', qty: 1 }], piecesCount: 4 },
      false,
    ],
  ] as const)('el cuerpo del reporte con %s', (_name, body, ok) => {
    expect(reportRoofingPiecesSchema.safeParse(body).success).toBe(ok);
    expect(reportAndCloseRoofingSchema.safeParse(body).success).toBe(ok);
  });
});
