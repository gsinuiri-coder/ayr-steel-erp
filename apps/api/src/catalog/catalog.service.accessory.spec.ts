import { Test } from '@nestjs/testing';
import { BusinessLineCode, ProductSource, RoofingProductKind } from '@prisma/client';
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

    it('cambiar el espesor de un accesorio es un 400: el SKU lo refleja', async () => {
      await expect(service.update(ACTOR, 'p-acc', { thicknessMm: '0.45' })).rejects.toThrow(
        /refleja el espesor y el color del accesorio/,
      );
    });

    it('cambiar el color de un accesorio es un 400', async () => {
      await expect(service.update(ACTOR, 'p-acc', { colorId: 'color-azul' })).rejects.toThrow(
        /refleja el espesor y el color/,
      );
    });

    it('cambiar el subtipo desde o hacia accesorio es un 400', async () => {
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.A_MEDIDA }),
      ).rejects.toThrow(/refleja el espesor y el color/);
      prisma.product.findUnique.mockResolvedValue(
        stored({ roofingKind: RoofingProductKind.PLANCHA, unit: 'NIU', sku: 'PL030ROJO' }),
      );
      await expect(
        service.update(ACTOR, 'p-acc', { roofingKind: RoofingProductKind.ACCESORIO }),
      ).rejects.toThrow(/refleja el espesor y el color/);
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
