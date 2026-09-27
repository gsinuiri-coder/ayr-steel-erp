import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessLineCode,
  FinishKind as PrismaFinishKind,
  Prisma,
  type Color,
  type Product,
} from '@prisma/client';
import {
  ACCESSORY_SKU_PREFIX,
  BusinessLine as SharedLineCode,
  canonicalAccessorySku,
  Decimal,
  drywallPieceWeightCheck,
  isPlausiblePieceLength,
  MAX_PAGE_SIZE,
  money,
  PIECE_LENGTH_RANGE_LABEL,
  rankSearchMatches,
  ROOFING_KIND_UNIT,
  RoofingProductKind,
  salePriceFromValue,
  theoreticalKgPerSellingUnit,
  toDecimal,
  toFixedString,
  type CreateProductInput,
  type FinishKind,
  type PriceListFloorDto,
  type PriceListFloorSummaryDto,
  type ProductDto,
  type ProductListPriceChangeDto,
  type UpdateProductInput,
  COIL_SKU_PREFIX,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { isCoilSaleProduct, openCoilCodesInPool } from '../sales/coil-sale-product';
import { ColorsService } from '../colors/colors.service';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import { computePriceFloorOutcomes, computePriceFloors } from '../sales/price-floor';
import {
  FLOOR_COST_SELECT,
  isDrywallProfile,
  productFloorCost,
  staticNoFloorReason,
  stripSkuNoFloorReason,
} from '../sales/price-floor-cost';
import {
  PRICE_FLOOR_UNUSED_TOLERANCE_MM,
  priceListValueChanged,
  recordPriceListChange,
} from './price-list-changes';

/** Mismo criterio que `SEARCH_CANDIDATE_POOL` de `CustomersService` (RF-S3/M1). */
const SEARCH_CANDIDATE_POOL = 100;

const DRYWALL_NO_FINISH_MESSAGE =
  'Drywall no lleva acabado en el SKU: su fleje es siempre galvanizado (D-344)';

/** Catálogo de productos por línea (RF-50). Mutaciones solo ADMINISTRADOR. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly colors: ColorsService,
  ) {}

  async findAll(businessLineId?: string): Promise<ProductDto[]> {
    const products = await this.prisma.product.findMany({
      where: businessLineId ? { businessLineId } : undefined,
      include: PRODUCT_RELATIONS,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    const galvDensity = await this.galvanizedDensity();
    return products.map((p) => toDto(p, galvDensity));
  }

  /**
   * RF-S3/M1: el selector de producto (con stock, D-188) ya no filtra en el navegador sobre
   * el catálogo entero cargado una vez (D-119) — ese catálogo sigue existiendo para lo que sí
   * lo necesita (precio/unidad de las líneas ya elegidas), esto es solo para poblar el picker.
   * `businessLine` es el código compartido (`@ayr/shared`), como ya lo maneja el formulario de
   * ventas — se traduce una sola vez acá, no en cada llamador.
   */
  async search(q?: string, businessLine?: SharedLineCode): Promise<ProductDto[]> {
    const needle = q ?? '';
    const candidates = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(businessLine ? { businessLine: { code: toPrismaLineCode(businessLine) } } : {}),
        OR: [
          { sku: { contains: needle, mode: 'insensitive' } },
          { name: { contains: needle, mode: 'insensitive' } },
        ],
      },
      include: PRODUCT_RELATIONS,
      orderBy: { name: 'asc' },
      take: SEARCH_CANDIDATE_POOL,
    });
    const galvDensity = await this.galvanizedDensity();
    return rankSearchMatches(candidates, needle, (p) => [p.sku, p.name]).map((p) =>
      toDto(p, galvDensity),
    );
  }

  /**
   * D-122: el acabado del producto, comprobado contra el maestro. Mismo criterio que el
   * color (D-085): un id inexistente da un 404 claro y uno **desactivado** se rechaza, para
   * que el catálogo no sea la puerta trasera por la que entra un acabado dado de baja al
   * filtro de bobina y al kilo teórico. Trae también lo que hace falta para comprobar la
   * coherencia con la línea y el color del producto (`assertFinishCoherence`).
   */
  private async resolveActiveFinish(
    finishId: string | null | undefined,
  ): Promise<FinishRef | null> {
    if (finishId === null || finishId === undefined || finishId === '') return null;
    const finish = await this.prisma.finish.findUnique({
      where: { id: finishId },
      select: {
        id: true,
        code: true,
        isActive: true,
        kind: true,
        colorId: true,
        businessLineId: true,
      },
    });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    if (!finish.isActive) throw new BadRequestException('El acabado está desactivado');
    return finish;
  }

  /**
   * Huecos de catálogo heredados de F8-S4 (D-203): un producto con acabado de otra línea
   * nunca aparecía en el filtro de esa línea, y uno cuyo color no coincidía con el de su
   * acabado no encontraba jamás una bobina que montar (D-086 compara `product.colorId`
   * contra `coil.colorId`, y este último sale del acabado desde D-203/M2). Un acabado sin
   * mapear (`kind` null, anterior a D-203) todavía no tiene de dónde sacar esa verdad, así
   * que no se comprueba hasta que se complete — mismo criterio que sus triggers en la base.
   */
  private assertFinishCoherence(
    businessLineId: string,
    colorId: string | null,
    finish: FinishRef | null,
  ): void {
    if (finish === null) return;
    if (finish.businessLineId !== null && finish.businessLineId !== businessLineId) {
      throw new BadRequestException(
        `El acabado ${finish.code} es de otra línea: un acabado pertenece a una sola línea`,
      );
    }
    if (finish.kind !== null && finish.colorId !== colorId) {
      throw new BadRequestException(
        `El color del producto no coincide con el del acabado ${finish.code}: ninguna bobina ` +
          'de ese acabado va a encontrar match nunca (D-086). Iguala el color del producto al del acabado.',
      );
    }
  }

  /**
   * D-344: la densidad del acabado **galvanizado** activo, de la que sale el peso teórico de una
   * pieza de drywall para el aviso de kg/pieza. Drywall tiene un solo acabado (galvanizado) y el
   * SKU ya no lo guarda; si hubiera más de uno, se toma el más antiguo. `null` si no existe.
   */
  private async galvanizedDensity(): Promise<Prisma.Decimal | null> {
    const finish = await this.prisma.finish.findFirst({
      where: {
        kind: PrismaFinishKind.GALVANIZADO,
        isActive: true,
        businessLine: { code: BusinessLineCode.DRYWALL },
      },
      orderBy: { createdAt: 'asc' },
      select: { densityFactor: true },
    });
    return finish?.densityFactor ?? null;
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_RELATIONS,
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return toDto(product, await this.galvanizedDensity());
  }

  async create(actor: RequestUser, input: CreateProductInput): Promise<ProductDto> {
    const line = await this.prisma.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new BadRequestException('Línea de negocio inválida');
    // D-257 (RF-S4b): el SKU de una bobina **se genera** desde espesor + color comercial o tipo al
    // dar de alta la bobina (D-252); no se tipea. Un `BOB…` suelto es exactamente lo que produjo
    // COT-000002: un producto sin saldo ni bobinas detrás que el importador tomó por la bobina.
    if (input.sku.toUpperCase().startsWith(COIL_SKU_PREFIX)) {
      throw new BadRequestException(
        `Los SKU ${COIL_SKU_PREFIX}… son de bobina y se generan solos al dar de alta la bobina (espesor + color o tipo, D-252): no se crean a mano`,
      );
    }
    if (line.code === BusinessLineCode.DRYWALL && input.finishId !== null) {
      throw new BadRequestException(DRYWALL_NO_FINISH_MESSAGE);
    }
    const colorId = await this.colors.resolveActive(input.colorId);
    const finish = await this.resolveActiveFinish(input.finishId);
    const roofingKind = input.roofingKind ?? null;
    assertStructuredFields(line.code, { ...input, roofingKind, finishId: finish?.id ?? null });
    this.assertFinishCoherence(input.businessLineId, colorId, finish);
    await this.assertAccessorySku(input.sku, roofingKind, colorId, input.thicknessMm, line.code);

    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            businessLineId: input.businessLineId,
            sku: input.sku,
            name: input.name,
            unit: input.unit,
            source: input.source,
            listPricePen: input.listPricePen,
            colorId,
            finishId: finish?.id ?? null,
            thicknessMm: input.thicknessMm,
            widthMm: input.widthMm,
            lengthMm: input.lengthMm,
            pieceWeightKg: input.pieceWeightKg,
            roofingKind,
          },
          include: PRODUCT_RELATIONS,
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'catalog.create',
          entity: 'products',
          entityId: created.id,
          after: auditView(created),
        });
        // D-217/M1a: un producto nuevo con precio de lista ya de entrada también es un
        // cambio de precio — `beforeValuePen` null lo distingue de una edición posterior.
        if (created.listPricePen !== null) {
          await recordPriceListChange(tx, {
            productId: created.id,
            beforeValuePen: null,
            afterValuePen: created.listPricePen,
            changedById: actor.id,
            origin: 'INLINE',
          });
        }
        return created;
      });
      return toDto(product, await this.galvanizedDensity());
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un producto con ese SKU en esta línea');
      }
      throw err;
    }
  }

  /**
   * D-343: el SKU de un accesorio **es** `ACCES` + espesor de 3 dígitos + color comercial
   * (`ACCES030ROJO`), y solo un accesorio lo lleva. Se comprueba contra el color y el espesor del
   * propio producto —los mismos tokens que el SKU de bobina, D-252— y no se acepta otro: el SKU
   * es lo que el vendedor lee para saber qué material es, y uno que dijera `ACCES030ROJO` sobre un
   * producto azul de 0.45 mentiría en cada cotización.
   */
  private async assertAccessorySku(
    sku: string,
    roofingKind: RoofingProductKind | null,
    colorId: string | null,
    thicknessMm: string | null,
    lineCode: BusinessLineCode,
  ): Promise<void> {
    // El prefijo es reservado **solo en coberturas**: en otra línea (drywall, trading) un SKU
    // como `ACCESORIO-…` sigue siendo un SKU cualquiera.
    const startsAccessory =
      lineCode === BusinessLineCode.METALLIC_ROOFING &&
      sku.toUpperCase().startsWith(ACCESSORY_SKU_PREFIX);
    if (roofingKind !== RoofingProductKind.ACCESORIO) {
      if (startsAccessory) {
        throw new BadRequestException(
          `Los SKU ${ACCESSORY_SKU_PREFIX}… son de accesorios de coberturas: crea el producto con el subtipo «Accesorio» o usa otro SKU`,
        );
      }
      return;
    }
    if (colorId === null) {
      throw new BadRequestException(
        'Un accesorio necesita su color: de él sale el SKU y el color de la bobina con que se fabrica',
      );
    }
    if (thicknessMm === null) {
      throw new BadRequestException('El espesor del accesorio es obligatorio');
    }
    const color = await this.prisma.color.findUnique({
      where: { id: colorId },
      select: { code: true },
    });
    let expected: string;
    try {
      expected = canonicalAccessorySku(thicknessMm, color?.code ?? '');
    } catch {
      // El token del SKU exige centésimas enteras entre 0.01 y 9.99 mm: sin esto, un espesor fuera
      // de la regla salía como un 500 y no como un error que dice qué corregir.
      throw new BadRequestException(
        'El espesor de un accesorio va en centésimas de milímetro, entre 0.01 y 9.99 mm: de él sale su SKU',
      );
    }
    if (sku.toUpperCase() !== expected) {
      throw new BadRequestException(
        `El SKU de un accesorio se forma con su espesor y su color: para este producto es ${expected}`,
      );
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateProductInput): Promise<ProductDto> {
    const before = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_RELATIONS,
    });
    if (!before) throw new NotFoundException('Producto no encontrado');
    // D-253: un producto unido a otro no se reactiva —el CHECK de la base lo rechazaría con un
    // 500 sin explicación—: su historia sigue acá, pero lo que se vende es el principal.
    if (input.isActive === true && before.mergedIntoId !== null) {
      throw new BadRequestException(
        `${before.sku} está unido a otro producto (D-253): no se reactiva, se vende el principal`,
      );
    }

    // D-257 (aclaración): un producto de venta de bobina no se desactiva mientras su pool tenga
    // bobinas abiertas con saldo. Es compartido por todas ellas (D-252): apagarlo las deja sin
    // producto de venta, y la venta rebota con «no existe el producto de venta directa».
    if (input.isActive === false && before.isActive && isCoilSaleProduct(before)) {
      const open = await openCoilCodesInPool(this.prisma, before);
      if (open.length > 0) {
        const shown = open.slice(0, 3).join(', ');
        throw new BadRequestException(
          `${before.sku} es el producto de venta de ${String(open.length)} bobina(s) con saldo (${shown}${open.length > 3 ? '…' : ''}): ciérralas o véndelas antes de desactivarlo`,
        );
      }
    }

    // D-127: corregir el subtipo **obliga** a mover la unidad (son el mismo hecho).
    const changesRoofingKind =
      input.roofingKind !== undefined && input.roofingKind !== before.roofingKind;
    // D-343: el SKU de un accesorio refleja su espesor y su color, y el SKU no se edita. Cambiar
    // cualquiera de los dos —o pasar de/hacia accesorio— dejaría un SKU que miente: se crea otro.
    if (before.roofingKind === RoofingProductKind.ACCESORIO || input.roofingKind === 'ACCESORIO') {
      const changesColor = input.colorId !== undefined && input.colorId !== before.colorId;
      const changesThickness =
        input.thicknessMm !== undefined &&
        (before.thicknessMm === null ||
          !toDecimal(input.thicknessMm ?? '0').equals(before.thicknessMm.toString()));
      if (changesRoofingKind || changesColor || changesThickness) {
        throw new BadRequestException(
          `El SKU ${before.sku} refleja el espesor y el color del accesorio, y el subtipo no cambia: para otro espesor u otro color crea otro accesorio`,
        );
      }
    }
    if (before.businessLine.code === BusinessLineCode.DRYWALL) {
      // D-344: drywall no lleva acabado en el SKU (es siempre galvanizado).
      if (input.finishId !== undefined && input.finishId !== null) {
        throw new BadRequestException(DRYWALL_NO_FINISH_MESSAGE);
      }
      // D-055/D-059/D-344 (antes lo bloqueaba «la receta viva»): lo que decide qué fleje consume un
      // perfil y cómo se cuenta —unidad, origen, espesor y ancho del fleje— no se cambia por debajo
      // de una orden de producción en curso: sus flejes ya se montaron contra los valores de antes.
      const changesUnit = input.unit !== undefined && input.unit !== before.unit;
      const changesSource = input.source !== undefined && input.source !== before.source;
      const changesStrip =
        decimalChanged(input.thicknessMm, before.thicknessMm) ||
        decimalChanged(input.widthMm, before.widthMm);
      if (changesUnit || changesSource || changesStrip) {
        await this.assertNoLiveRoofingOrders(
          id,
          'la unidad, el origen, el espesor o el ancho del fleje',
        );
      }
    }

    // D-118: solo se revalida cuando el propio pedido toca uno de los campos
    // estructurados — un `isActive` suelto no debería exigir completar el catálogo
    // histórico que nació antes de esta fase.
    // D-127: el subtipo y la unidad entran a la misma revalidación. Cambiar de PLANCHA a
    // A MEDIDA cambia qué campos son obligatorios (el largo deja de serlo) y cambia la rama
    // de la confirmación, así que no puede pasar sin volver a comprobar la forma entera.
    const roofingKind =
      input.roofingKind !== undefined ? (input.roofingKind ?? null) : before.roofingKind;
    const touchesStructured =
      input.thicknessMm !== undefined ||
      input.widthMm !== undefined ||
      input.lengthMm !== undefined ||
      input.pieceWeightKg !== undefined ||
      input.roofingKind !== undefined ||
      input.finishId !== undefined ||
      input.unit !== undefined;
    if (touchesStructured) {
      assertStructuredFields(before.businessLine.code, {
        roofingKind,
        unit: input.unit ?? before.unit,
        finishId: input.finishId !== undefined ? input.finishId : before.finishId,
        thicknessMm:
          input.thicknessMm !== undefined
            ? input.thicknessMm
            : decimalOrNull(before.thicknessMm, 'MM'),
        widthMm: input.widthMm !== undefined ? input.widthMm : decimalOrNull(before.widthMm, 'MM'),
        lengthMm:
          input.lengthMm !== undefined ? input.lengthMm : decimalOrNull(before.lengthMm, 'MM'),
        pieceWeightKg:
          input.pieceWeightKg !== undefined
            ? input.pieceWeightKg
            : decimalOrNull(before.pieceWeightKg, 'KG'),
      });
    }

    const data: Prisma.ProductUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.unit !== undefined) data.unit = input.unit;
    if (input.source !== undefined) data.source = input.source;
    // D-068: `null` es un valor legítimo (quitar el precio de lista), así que no se puede
    // usar el truco de `?? undefined` que sirve para el resto de campos.
    if (input.listPricePen !== undefined) data.listPricePen = input.listPricePen;
    if (input.thicknessMm !== undefined) data.thicknessMm = input.thicknessMm;
    if (input.widthMm !== undefined) data.widthMm = input.widthMm;
    if (input.lengthMm !== undefined) data.lengthMm = input.lengthMm;
    if (input.pieceWeightKg !== undefined) data.pieceWeightKg = input.pieceWeightKg;
    if (input.roofingKind !== undefined) data.roofingKind = input.roofingKind;
    // D-085: cambiar el color de un producto con receta viva movería el filtro de bobina
    // (D-086) por debajo de las órdenes en curso, que montaron el rollo contra el color
    // anterior. Mismo criterio que la unidad y el origen, unas líneas más arriba.
    let finalColorId = before.colorId;
    if (input.colorId !== undefined) {
      const changesColor = input.colorId !== before.colorId;
      if (changesColor) {
        await this.assertNoLiveRoofingOrders(id);
        const resolved = await this.colors.resolveActive(input.colorId);
        data.color = resolved === null ? { disconnect: true } : { connect: { id: resolved } };
        finalColorId = resolved;
      }
    }
    // D-122: el acabado del producto es lo que fija la densidad con la que se convierten
    // metros en kilos. Cambiarlo con una OP de coberturas viva reescribiría el kilo teórico
    // a mitad de corrida — el mismo motivo por el que el color está bloqueado arriba.
    let finalFinish: FinishRef | null = before.finish;
    if (input.finishId !== undefined && input.finishId !== before.finishId) {
      await this.assertNoLiveRoofingOrders(id);
      const resolved = await this.resolveActiveFinish(input.finishId);
      data.finish = resolved === null ? { disconnect: true } : { connect: { id: resolved.id } };
      finalFinish = resolved;
    }
    // Huecos de catálogo de F8-S4 (D-203): tocar cualquiera de los dos vuelve a comprobar el
    // par completo, porque cambiar solo uno puede romper la coherencia con el otro que no se
    // tocó.
    if (input.colorId !== undefined || input.finishId !== undefined) {
      this.assertFinishCoherence(before.businessLineId, finalColorId, finalFinish);
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;

    // D-217/M1a: se compara **antes de escribir**, con `Decimal` y no con el string tal
    // como llegó — «7.5» y «7.5000» no son un cambio, y `data.listPricePen` puede venir
    // sin tocar (`undefined`, no entra acá) o como `null` (quitar el precio).
    const listPriceTouched = input.listPricePen !== undefined;
    const listPriceChanged =
      listPriceTouched &&
      priceListValueChanged(before.listPricePen, data.listPricePen as string | null);

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data,
        include: PRODUCT_RELATIONS,
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'catalog.update',
        entity: 'products',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      if (listPriceChanged) {
        await recordPriceListChange(tx, {
          productId: id,
          beforeValuePen: before.listPricePen,
          afterValuePen: updated.listPricePen,
          changedById: actor.id,
          origin: 'INLINE',
        });
      }
      return updated;
    });
    return toDto(after, await this.galvanizedDensity());
  }

  /** Órdenes de coberturas vivas de este producto: las que el cambio de color rompería. */
  private async assertNoLiveRoofingOrders(productId: string, what = 'el color'): Promise<void> {
    const live = await this.prisma.productionOrder.count({
      where: { productId, status: { in: ['DRAFT', 'IN_PROGRESS'] } },
    });
    if (live > 0) {
      throw new BadRequestException(
        `El producto tiene ${live} orden(es) de producción en curso: ciérralas o anúlalas antes de cambiar ${what}`,
      );
    }
  }

  /**
   * D-217/M1b: el piso de D-163 para **este** producto, calculado por la misma función que
   * lo aplica al vender (`computePriceFloors`) — para que el catálogo no pueda mostrar un
   * mínimo distinto del que después rechaza una cotización. `null` sin costo en el kardex
   * (sin costo no hay piso) o sin margen mínimo configurado para la línea.
   */
  async priceFloor(id: string): Promise<PriceListFloorDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { sku: true, unit: true, ...FLOOR_COST_SELECT },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    // D-342/D-344: un perfil de drywall sin espesor, ancho o peso en el SKU no tiene piso, y se
    // dice por qué.
    const floorCost = productFloorCost(product);
    if ('noFloorReason' in floorCost) {
      return { minPricePen: null, priceUnitLabel: null, noFloorReason: floorCost.noFloorReason };
    }
    const outcomes = await this.prisma.$transaction((tx) =>
      computePriceFloorOutcomes(
        tx,
        [
          {
            at: product.id,
            sku: product.sku,
            businessLineId: product.businessLineId,
            basis: { kind: 'UNIT', unitLabel: product.unit },
            // Solo lo lee `assertPriceFloor` para comparar y rechazar; acá solo se **lee**
            // el piso, así que el valor propuesto no importa.
            unitValuePen: '0',
            cost: floorCost.cost,
          },
        ],
        PRICE_FLOOR_UNUSED_TOLERANCE_MM,
      ),
    );
    const outcome = outcomes.get(product.id);
    if (outcome !== undefined && 'minValuePen' in outcome) {
      return {
        minPricePen: outcome.minPricePen,
        priceUnitLabel: outcome.priceUnitLabel,
        noFloorReason: null,
      };
    }
    // D-344: sin piso en un perfil con SKU completo es porque no hay flejes compatibles con costo
    // o porque la línea no tiene margen configurado: dos avisos distintos (antes eran uno solo).
    return {
      minPricePen: null,
      priceUnitLabel: null,
      noFloorReason:
        floorCost.cost.kind === 'STRIP_SKU' && outcome !== undefined
          ? stripSkuNoFloorReason(outcome.missing)
          : null,
    };
  }

  /**
   * RF-S3/M4 (sacrificable, D-224): cuántos SKU activos con precio de lista cargado quedan
   * por debajo del piso de D-163 — el insumo para el card del Panel. Misma cuenta que
   * `computePriceFloors` usa para el rechazo al vender y para `priceFloor(id)` de un SKU
   * suelto (D-150: nunca una lógica paralela), batcheada sobre **todo** el catálogo: dos
   * consultas para traer productos y margen mínimo por línea, más las que
   * `computePriceFloors` ya batchea internamente para el costo (nunca una por SKU).
   */
  async findPriceListFloorSummary(): Promise<PriceListFloorSummaryDto> {
    const products = await this.prisma.product.findMany({
      where: { isActive: true, listPricePen: { not: null } },
      select: {
        sku: true,
        name: true,
        unit: true,
        listPricePen: true,
        ...FLOOR_COST_SELECT,
      },
      orderBy: { sku: 'asc' },
    });
    if (products.length === 0) {
      return { totalWithListPrice: 0, withoutFloor: 0, belowFloor: [] };
    }

    // D-342/D-344: un perfil de drywall sin espesor, ancho o peso en el SKU no entra a
    // `computePriceFloors` y cae en «sin piso», igual que un SKU sin costo (D-163).
    const candidates = products.flatMap((p) => {
      const floorCost = productFloorCost(p);
      return 'cost' in floorCost
        ? [
            {
              at: p.id,
              sku: p.sku,
              businessLineId: p.businessLineId,
              basis: { kind: 'UNIT' as const, unitLabel: p.unit },
              // Solo se lee el piso, nunca se rechaza nada acá: el valor propuesto no importa.
              unitValuePen: '0',
              cost: floorCost.cost,
            },
          ]
        : [];
    });
    const floors = await this.prisma.$transaction((tx) =>
      computePriceFloors(tx, candidates, PRICE_FLOOR_UNUSED_TOLERANCE_MM),
    );

    let withoutFloor = 0;
    const belowFloor: (PriceListFloorSummaryDto['belowFloor'][number] & { gapPct: Decimal })[] = [];
    for (const p of products) {
      const floor = floors.get(p.id);
      // `computePriceFloors` no pone entrada para un SKU sin costo en el kardex o sin
      // margen mínimo configurado (D-163: sin piso no hay infractor que avisar).
      if (!floor) {
        withoutFloor += 1;
        continue;
      }
      const listValuePen = toDecimal(p.listPricePen?.toString() ?? '0');
      const minValuePen = toDecimal(floor.minValuePen);
      if (listValuePen.gte(minValuePen)) continue;
      belowFloor.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        listPricePen: toFixedString(money(salePriceFromValue(listValuePen)), 'MONEY'),
        minPricePen: floor.minPricePen,
        priceUnitLabel: floor.priceUnitLabel,
        // De más lejos del piso a menos (D-224/check:price-floor): es el orden en el que
        // conviene mirarlos, y no depende de una consulta más — es aritmética sobre lo ya
        // traído.
        gapPct: minValuePen.lte(0)
          ? new Decimal(0)
          : listValuePen.minus(minValuePen).div(minValuePen).times(100),
      });
    }
    belowFloor.sort((a, b) => a.gapPct.comparedTo(b.gapPct));

    return {
      totalWithListPrice: products.length,
      withoutFloor,
      belowFloor: belowFloor.map(({ gapPct: _gapPct, ...rest }) => rest),
    };
  }

  /** Historial de `listPricePen` (D-217/M1). Sin `productId`, todo el catálogo. */
  async findPriceListChanges(productId?: string): Promise<ProductListPriceChangeDto[]> {
    const rows = await this.prisma.productListPriceChange.findMany({
      where: productId ? { productId } : undefined,
      orderBy: { changedAt: 'desc' },
      // Mismo tope que cualquier otro listado del repo (D-113); sin `productId` es "los
      // últimos cambios de todo el catálogo", no un reporte histórico completo.
      take: MAX_PAGE_SIZE,
    });
    if (rows.length === 0) return [];
    const [products, users] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.productId))] } },
        select: { id: true, sku: true, name: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.changedById))] } },
        select: { id: true, name: true },
      }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      sku: productById.get(r.productId)?.sku ?? '',
      productName: productById.get(r.productId)?.name ?? '',
      beforeValuePen: r.beforeValuePen === null ? null : r.beforeValuePen.toFixed(4),
      afterValuePen: r.afterValuePen === null ? null : r.afterValuePen.toFixed(4),
      changedById: r.changedById,
      changedByName: nameById.get(r.changedById) ?? '—',
      changedAt: r.changedAt.toISOString(),
      origin: r.origin,
      batchId: r.batchId,
      revertsBatchId: r.revertsBatchId,
    }));
  }
}

/**
 * D-118 (Fase 7e, B): Metallic Roofing exige espesor y ancho estructurados (SKU); Drywall
 * exige ancho, largo y peso de la pieza terminada. El resto del catálogo no los usa —igual
 * que el color (D-085), no se restringe si vienen, solo si faltan donde hacen falta.
 */
function assertStructuredFields(
  lineCode: BusinessLineCode,
  fields: {
    thicknessMm: string | null;
    widthMm: string | null;
    lengthMm: string | null;
    pieceWeightKg: string | null;
    roofingKind: RoofingProductKind | null;
    unit: string | null;
    finishId: string | null;
  },
): void {
  if (lineCode === BusinessLineCode.METALLIC_ROOFING) {
    if (fields.thicknessMm === null) {
      throw new BadRequestException('El espesor del SKU es obligatorio en Metallic Roofing');
    }
    // D-122: la densidad con la que se convierten metros en kilos sale del acabado del
    // **producto**. Hasta D-122 salía de la receta, y por eso una cobertura no se podía
    // cotizar sin tener una; ahora la receta no existe y el dato tiene que estar acá.
    if (fields.finishId === null) {
      throw new BadRequestException(
        'El acabado del SKU es obligatorio en Metallic Roofing: de él sale la densidad con la que se calculan los kilos',
      );
    }
    if (fields.widthMm === null) {
      throw new BadRequestException('El ancho del SKU es obligatorio en Metallic Roofing');
    }
    // D-127: el subtipo es obligatorio y explícito. Deducirlo de la unidad es exactamente lo
    // que dejó una cotización a medida pidiendo stock de producto terminado al confirmarse.
    if (fields.roofingKind === null) {
      throw new BadRequestException(
        'Indica el subtipo de la cobertura: plancha de catálogo o a medida',
      );
    }
    // Subtipo y unidad son el mismo hecho dicho dos veces, y todo el resto del sistema
    // (ventas, producción, despacho) ya lee la unidad. Que difieran reabriría la ambigüedad
    // por el otro lado; el mismo CHECK está en la base.
    // Lo que importa —y lo que el CHECK de la base sostiene— es que **a medida** se mida en
    // metros lineales: de ahí salen los subítems de largo y el cálculo de kilos teóricos. Una
    // plancha se mide en lo que la empresa venda (unidades, casi siempre), y exigirle `NIU`
    // acá dejaría sin poder editarse a cualquier producto legado con otra unidad.
    const expectedUnit = ROOFING_KIND_UNIT[fields.roofingKind];
    // D-343: el accesorio también se mide en metros lineales (de bobina): la unidad SUNAT, el
    // kardex y el despacho son los del metro. Lo que lo distingue —que no lleva largos— es del
    // subtipo, no de la unidad.
    const measuredInMeters =
      fields.roofingKind === RoofingProductKind.A_MEDIDA ||
      fields.roofingKind === RoofingProductKind.ACCESORIO;
    const unitOk = measuredInMeters ? fields.unit === expectedUnit : fields.unit !== 'MTR';
    if (!unitOk) {
      throw new BadRequestException(
        fields.roofingKind === RoofingProductKind.ACCESORIO
          ? 'Un accesorio se mide en metros lineales (MTR)'
          : fields.roofingKind === RoofingProductKind.A_MEDIDA
            ? 'Una cobertura a medida se mide en metros lineales (MTR)'
            : 'Una plancha de catálogo no se mide en metros lineales: eso es una cobertura a medida',
      );
    }
    // El largo solo lo lleva la plancha: es su largo fijo. Una cobertura a medida no tiene
    // largo propio — lo traen los subítems de cada línea de venta (D-083).
    if (fields.roofingKind === RoofingProductKind.PLANCHA && fields.lengthMm === null) {
      throw new BadRequestException('El largo de la plancha es obligatorio');
    }
    // D-166: y tiene que ser un largo **posible**, el mismo rango que el plan de corte ya
    // exigía a cada largo tipeado a mano. El campo pide milímetros y el resto de la pantalla
    // de coberturas trabaja en metros, así que "3" por 3 000 entraba sin que nada avisara — y
    // de ahí salía una cotización mil veces más barata (D-161 multiplica por este número).
    if (
      fields.roofingKind === RoofingProductKind.PLANCHA &&
      fields.lengthMm !== null &&
      !isPlausiblePieceLength(fields.lengthMm)
    ) {
      throw new BadRequestException(
        `El largo de la plancha tiene que estar entre ${PIECE_LENGTH_RANGE_LABEL}: ` +
          `${toDecimal(fields.lengthMm).toFixed(2)} mm son ` +
          `${toDecimal(fields.lengthMm).div(1000).toFixed(3)} m. El campo va en **milímetros** ` +
          '(una plancha de 3 metros son 3000).',
      );
    }
    if (fields.roofingKind === RoofingProductKind.A_MEDIDA && fields.lengthMm !== null) {
      throw new BadRequestException(
        'Una cobertura a medida no lleva largo fijo: el largo va en los subítems de cada línea',
      );
    }
    if (fields.roofingKind === RoofingProductKind.ACCESORIO && fields.lengthMm !== null) {
      throw new BadRequestException(
        'Un accesorio no lleva largo: se vende por metros lineales de bobina, sin detalle de largos',
      );
    }
  } else if (fields.roofingKind !== null) {
    throw new BadRequestException('El subtipo de cobertura solo aplica a Metallic Roofing');
  }
  if (lineCode === BusinessLineCode.DRYWALL) {
    // D-344 (corrige la lectura de D-118): en drywall `thicknessMm` y `widthMm` son los del
    // **fleje** —su espesor y su ancho de desarrollo—, con los que se busca el fleje compatible.
    // El acabado no se guarda: es siempre galvanizado.
    if (fields.thicknessMm === null) {
      throw new BadRequestException('El espesor del fleje es obligatorio en Drywall');
    }
    if (fields.widthMm === null) {
      throw new BadRequestException('El ancho del fleje (desarrollo) es obligatorio en Drywall');
    }
    if (fields.lengthMm === null) {
      throw new BadRequestException('El largo de la pieza terminada es obligatorio en Drywall');
    }
    if (fields.pieceWeightKg === null) {
      throw new BadRequestException('El peso de la pieza terminada es obligatorio en Drywall');
    }
  }
}

/**
 * ¿El fleje que una OP viva ya montó dejaría de significar lo mismo? `undefined` (no se toca) y
 * cargar un dato que faltaba (`stored` null, `incoming` con valor) no cuentan como cambio: lo que
 * hay que impedir es mover o borrar el dato que una orden en curso ya usó, no completar el
 * catálogo de un perfil al que todavía le falta.
 */
function decimalChanged(
  incoming: string | null | undefined,
  stored: Prisma.Decimal | null,
): boolean {
  if (incoming === undefined || stored === null) return false;
  if (incoming === null) return true;
  return !toDecimal(incoming).equals(stored.toString());
}

function decimalOrNull(value: Prisma.Decimal | null, scale: 'MM' | 'KG'): string | null {
  if (value === null) return null;
  return scale === 'MM' ? value.toFixed(2) : value.toFixed(3);
}

const PRODUCT_RELATIONS = {
  businessLine: { select: { code: true } },
  color: true,
  // D-122: la densidad sale del acabado **del producto** y el largo fijo, del propio SKU.
  // Hasta acá los dos venían de la receta, y eso obligaba a una cobertura a tener una.
  // `kind`/`colorId`/`businessLineId` son los que `assertFinishCoherence` necesita cuando
  // se toca un solo lado del par color/acabado y el otro se queda como estaba.
  finish: {
    select: {
      id: true,
      code: true,
      name: true,
      densityFactor: true,
      kind: true,
      colorId: true,
      businessLineId: true,
    },
  },
} satisfies Prisma.ProductInclude;

/** Lo que `assertFinishCoherence` necesita de un acabado: identidad, tipo, color y línea. */
interface FinishRef {
  id: string;
  code: string;
  kind: FinishKind | null;
  colorId: string | null;
  businessLineId: string | null;
}

type WithLineCode = Product & {
  businessLine: { code: BusinessLineCode };
  color: Color | null;
  finish: (FinishRef & { name: string; densityFactor: Prisma.Decimal }) | null;
};

/**
 * D-118: kg teórico por unidad de venta de una cobertura, derivado de espesor × ancho ×
 * densidad del acabado (RF-25). `null` si falta el espesor, el ancho o la receta activa
 * (sin receta viva no hay acabado del que sacar la densidad — una receta desactivada no
 * cuenta, mismo criterio que `resolveSalesLines`/`duplicate` usan para "tiene receta").
 * Drywall nunca lo calcula — declara el peso directo (`pieceWeightKg`) porque su sección
 * no es un prisma simple.
 */
function theoreticalKgPerUnit(p: WithLineCode): string | null {
  return (
    theoreticalKgPerSellingUnit({
      unit: p.unit,
      thicknessMm: p.thicknessMm?.toFixed(2) ?? null,
      widthMm: p.widthMm?.toFixed(2) ?? null,
      lengthMm: p.lengthMm?.toFixed(2) ?? null,
      densityFactor: p.finish?.densityFactor.toFixed(4) ?? null,
    })?.toFixed(3) ?? null
  );
}

/**
 * D-344: aviso del peso declarado de un perfil de drywall contra el teórico. La densidad sale del
 * acabado **galvanizado** activo (drywall tiene un solo acabado y el SKU ya no lo guarda). `null`
 * si no es un perfil, si falta un dato de la cuenta o si no hay un acabado galvanizado del que
 * sacar la densidad.
 */
function pieceWeightCheckOf(p: WithLineCode, galvDensity: Prisma.Decimal | null) {
  if (!isDrywallProfile(p) || galvDensity === null) return null;
  return drywallPieceWeightCheck({
    widthMm: p.widthMm?.toFixed(2) ?? null,
    lengthMm: p.lengthMm?.toFixed(2) ?? null,
    thicknessMm: p.thicknessMm?.toFixed(2) ?? null,
    pieceWeightKg: p.pieceWeightKg?.toFixed(3) ?? null,
    densityFactor: galvDensity.toFixed(4),
  });
}

function toDto(p: WithLineCode, galvDensity: Prisma.Decimal | null): ProductDto {
  return {
    id: p.id,
    businessLineId: p.businessLineId,
    businessLineCode: toSharedLineCode(p.businessLine.code),
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    listPricePen: p.listPricePen === null ? null : p.listPricePen.toFixed(4),
    colorId: p.colorId,
    colorCode: p.color?.code ?? null,
    colorName: p.color?.name ?? null,
    colorHex: p.color?.hexColor ?? null,
    finishId: p.finishId,
    finishCode: p.finish?.code ?? null,
    finishName: p.finish?.name ?? null,
    densityFactor: p.finish?.densityFactor.toFixed(4) ?? null,
    thicknessMm: p.thicknessMm === null ? null : p.thicknessMm.toFixed(2),
    widthMm: p.widthMm === null ? null : p.widthMm.toFixed(2),
    lengthMm: p.lengthMm === null ? null : p.lengthMm.toFixed(2),
    pieceWeightKg: p.pieceWeightKg === null ? null : p.pieceWeightKg.toFixed(3),
    roofingKind: p.roofingKind,
    theoreticalKgPerUnit: theoreticalKgPerUnit(p),
    isActive: p.isActive,
    source: p.source,
    // D-342/D-344: solo el motivo que se sabe sin mirar saldos; el de flejes y margen lo dice el piso.
    noFloorReason: staticNoFloorReason(p),
    pieceWeightCheck: pieceWeightCheckOf(p, galvDensity),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function auditView(p: Product): Prisma.InputJsonObject {
  return {
    businessLineId: p.businessLineId,
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    source: p.source,
    listPricePen: p.listPricePen === null ? null : p.listPricePen.toFixed(4),
    colorId: p.colorId,
    finishId: p.finishId,
    thicknessMm: p.thicknessMm === null ? null : p.thicknessMm.toFixed(2),
    widthMm: p.widthMm === null ? null : p.widthMm.toFixed(2),
    lengthMm: p.lengthMm === null ? null : p.lengthMm.toFixed(2),
    pieceWeightKg: p.pieceWeightKg === null ? null : p.pieceWeightKg.toFixed(3),
    isActive: p.isActive,
  };
}
