import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  BusinessLineCode,
  CoilKind,
  CoilStatus,
  InventoryItemType,
  InventoryStrategy,
  ReservationStatus,
  type Prisma,
} from '@prisma/client';
import {
  coilSkuFromTypeKey,
  describePieces,
  kgPerMeter,
  piecesMeters,
  rawMaterialLabel,
  RoofingProductKind,
  salesLineTotals,
  toDecimal,
  toFixedString,
  Unit,
  type Decimal,
  type RoofingPieceDto,
  type SalesItemDto,
  type SalesItemInput,
} from '@ayr/shared';
import { toSharedLineCode } from '../common/business-line-code';
import { resolveRawMaterialSpec, type RawMaterialSpecRef } from './raw-material';

/**
 * Resolución de las líneas de una cotización o de un pedido (D-065, D-068).
 *
 * Cotización y pedido comparten exactamente la misma forma de línea —el pedido es una
 * copia congelada de la cotización, o de un alta directa— así que la validación, el precio
 * y el destino de la reserva se resuelven una sola vez acá y las dos tablas guardan el
 * mismo resultado. Si divergieran, un pedido directo podría admitir líneas que una
 * cotización rechaza, que es justo el agujero por el que se esquivaría RF-31.
 */

/** Una línea ya validada, lista para persistir en `quotation_items` o `sales_order_items`. */
export interface ResolvedSalesLine {
  lineNumber: number;
  productId: string;
  /**
   * D-119: línea de negocio comercial de esta línea (la del producto, siempre — en una
   * venta de bobina es la del SKU `trading`, D-037). Un documento puede mezclar líneas de
   * distintas líneas de negocio; esto es lo que cada una declara ser la suya, para el
   * chequeo de `quotationRequired` de un pedido directo y para mostrarla agrupada.
   */
  businessLineId: string;
  description: string;
  qty: string;
  unit: string;
  listPricePen: string | null;
  unitPricePen: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  reserveItemType: InventoryItemType;
  reserveItemId: string;
  reserveQty: string;
  reserveUnit: string;
  /** D-083: los largos de una línea compuesta. Vacío en una línea simple. */
  pieces: RoofingPieceDto[];
  /** Solo para armar el DTO; no se persiste (sale del join con el producto o la bobina). */
  productSku: string;
  productName: string;
  reserveItemLabel: string;
}

/**
 * Valida y normaliza las líneas contra el maestro.
 *
 * El destino de la reserva se decide acá, una sola vez, y desde D-134 lo decide **el
 * producto**, no el formulario:
 *
 * - una cobertura **a medida** (`roofingKind = A_MEDIDA`) promete **kilos del agregado de
 *   materia prima compatible**: misma línea, mismo color, espesor de la receta ±
 *   tolerancia. Su producto terminado no existe hasta que planta lo rola, así que lo que
 *   hay que proteger es la bobina — pero *cuál* bobina es una decisión de planta al montar
 *   la OP (D-086), no del vendedor al cotizar;
 * - una **venta de bobina entera** (RF-73, `saleCoilId`) promete esa bobina, y ahí apuntar
 *   al rollo es lo correcto: lo que se vende es ese rollo;
 * - cualquier otra línea promete **el propio producto**, en su unidad de venta. Es el caso
 *   de un perfil de drywall, de un producto de trading y —desde D-083— también el de una
 *   cobertura que sale de stock, sea una plancha de catálogo o el sobrante de una corrida
 *   anterior.
 *
 * **`reserveFromCoilId` desapareció** (D-134). Era la forma de que el vendedor eligiera el
 * rollo a mano, y el dueño la encontró en producción pidiéndole justo la decisión que no le
 * toca. No queda ninguna ruta —ni de API ni de formulario— para comprometer una bobina
 * concreta desde una cotización.
 *
 * **Desde D-083 la cobertura que sale de stock ya no se rechaza en una línea con cotización
 * obligatoria.** Antes se cortaba acá con el argumento de que reservar un producto terminado
 * inexistente fallaría igual al confirmar; el argumento dejó de valer cuando la producción de
 * coberturas empezó a dejar metros y planchas en stock, que son perfectamente vendibles. Quien
 * decide ahora es el disponible real, en `createReservations`, con un mensaje que dice cuánto
 * hay.
 *
 * D-083 además distingue las dos formas de línea por la **unidad del producto**: `MTR` es
 * una cobertura a medida y su línea es compuesta (subítems `{cantidad, largo}` cuya suma en
 * metros **es** la cantidad de la línea); cualquier otra unidad es una línea simple.
 *
 * **D-119 (Fase 7e): sin `businessLineId` de documento.** Antes cada línea se validaba
 * contra una única línea de negocio compartida por todo el documento; ahora cada línea
 * lleva la suya (la de su producto) y no se exige que coincidan entre sí. La regla física
 * que sí sigue valiendo —una cobertura no rola con fleje de drywall— la sostiene ahora el
 * agregado, que se construye con la línea de negocio **del producto** y por eso no puede
 * nombrar material de otra.
 */
export async function resolveSalesLines(
  tx: Prisma.TransactionClient,
  items: SalesItemInput[],
): Promise<ResolvedSalesLine[]> {
  const productIds = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      isActive: true,
      businessLineId: true,
      listPricePen: true,
      // D-127: el subtipo decide la rama de la reserva. La geometría y la densidad del
      // acabado son lo que convierte metros lineales en kilos de bobina.
      roofingKind: true,
      thicknessMm: true,
      widthMm: true,
      colorId: true,
      color: { select: { name: true } },
      finish: { select: { densityFactor: true } },
      businessLine: { select: { inventoryStrategy: true } },
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  // D-134: el agregado de materia prima de cada producto a medida. Se resuelve **antes** del
  // `.map` porque crear la spec es asíncrono y el mapa que arma las líneas no lo es; y se
  // resuelve por producto y no por línea porque dos líneas del mismo SKU prometen contra el
  // mismo agregado — que es justamente lo que hace que la invariante las sume.
  const specByProductId = new Map<string, RawMaterialSpecRef>();
  for (const product of products) {
    if (!isMadeToMeasure(product)) continue;
    if (product.thicknessMm === null || product.finish === null) continue;
    specByProductId.set(
      product.id,
      await resolveRawMaterialSpec(tx, {
        businessLineId: product.businessLineId,
        colorId: product.colorId,
        thicknessMm: product.thicknessMm.toFixed(2),
      }),
    );
  }

  // D-116: venta de bobina completa (RF-73). Se resuelve aparte porque el producto no lo
  // manda el formulario (es el SKU `trading` de D-037, uno por `typeKey`) y la cantidad no
  // la decide el vendedor (es el saldo vivo, nunca lo que venga en `item.qty`).
  const saleCoilById = await resolveSaleCoils(tx, items);

  return items.map((item, index) => {
    const lineNumber = index + 1;
    const at = `Línea ${lineNumber}`;

    if (item.saleCoilId !== undefined) {
      const sale = saleCoilById.get(item.saleCoilId);
      if (!sale) throw new NotFoundException(`${at}: bobina a vender no encontrada`);
      const unitPricePen = item.unitPricePen;
      if (unitPricePen === undefined) {
        throw new BadRequestException(
          `${at}: la venta de una bobina es a precio negociado, escribe el precio por kg`,
        );
      }
      const totals = salesLineTotals({ qty: sale.qty, unitPricePen });
      const description = item.description ?? `Bobina ${sale.coilCode} × ${sale.qty} kg`;
      return {
        lineNumber,
        productId: sale.productId,
        businessLineId: sale.productBusinessLineId,
        description,
        qty: sale.qty,
        unit: Unit.KGM,
        listPricePen: null,
        unitPricePen,
        subtotalPen: toFixedString(totals.subtotal, 'MONEY'),
        igvPen: toFixedString(totals.igv, 'MONEY'),
        totalPen: toFixedString(totals.total, 'MONEY'),
        reserveItemType: InventoryItemType.COIL,
        reserveItemId: sale.coilId,
        reserveQty: sale.qty,
        reserveUnit: Unit.KGM,
        pieces: [],
        productSku: sale.productSku,
        productName: sale.productName,
        reserveItemLabel: sale.coilCode,
      };
    }

    // Garantizado por el `superRefine` del schema (productId o saleCoilId, nunca ninguno);
    // se repite acá porque el pedido directo también llama a `resolveSalesLines`.
    if (item.productId === undefined) throw new NotFoundException(`${at}: producto no encontrado`);
    const product = productById.get(item.productId);
    if (!product) throw new NotFoundException(`${at}: producto no encontrado`);
    if (!product.isActive) {
      throw new BadRequestException(`${at}: el producto ${product.sku} está desactivado`);
    }
    if (product.businessLine.inventoryStrategy === InventoryStrategy.NOOP) {
      throw new BadRequestException(
        `${at}: el producto ${product.sku} es de una línea sin inventario: no se cotiza`,
      );
    }

    const listPricePen = product.listPricePen === null ? null : product.listPricePen.toFixed(4);
    const unitPricePen = item.unitPricePen ?? listPricePen;
    if (unitPricePen === null) {
      throw new BadRequestException(
        `${at}: el producto ${product.sku} no tiene precio de lista; escribe el precio en la línea`,
      );
    }

    // **Dos preguntas distintas, y hay que no confundirlas** (lo aprendí confundiéndolas:
    // ver D-130 y el guardrail del mostrador que se cayó en CI).
    //
    // (a) ¿Esta línea se vende por metro lineal? La decide la **unidad**, como desde D-083, y
    //     vale para cualquier línea de negocio: un producto en `MTR` necesita sus subítems de
    //     largo, sea una cobertura o cualquier otra cosa que se venda por metro. De esto
    //     depende también que el mostrador la rechace (D-098).
    // (b) ¿Se fabrica contra pedido a partir de materia prima? La decide el **subtipo**
    //     (D-127), y es una pregunta exclusiva de Metallic Roofing. De esto depende la rama
    //     de la reserva, más abajo.
    //
    // Haber respondido (a) con el subtipo dejó de exigir subítems a todo producto en `MTR`
    // fuera de coberturas — y con eso el mostrador pasó a poder vender material a medida.
    const sellsByLength = product.unit === Unit.MTR;
    const madeToMeasure = isMadeToMeasure(product);
    if (sellsByLength && item.pieces === undefined) {
      throw new BadRequestException(
        `${at}: ${product.sku} se vende por metro lineal: detalla cuántas planchas de cada largo lleva la línea`,
      );
    }
    if (!sellsByLength && item.pieces !== undefined) {
      throw new BadRequestException(
        `${at}: ${product.sku} no se vende a medida (se mide en ${product.unit}): quita el detalle de largos`,
      );
    }

    const pieces: RoofingPieceDto[] = (item.pieces ?? []).map((piece, i) => ({
      lineNumber: i + 1,
      lengthMm: toFixedString(piece.lengthMm, 'MM'),
      qty: piece.qty,
    }));
    // Redundante con el `superRefine` del schema, y a propósito: el pedido directo y la
    // edición de cotización pasan por acá con las mismas líneas, y esta es la única puerta
    // por la que las dos entran a la base.
    //
    // Se comprueba contra los largos que **vinieron**, no contra su ausencia: con
    // Una línea a medida siempre trae su desglose (D-083), y sumar una
    // lista vacía habría dado cero metros contra los quince de la línea — el mismo rechazo
    // que la excepción existe para evitar, por la puerta de al lado.
    if (
      item.pieces !== undefined &&
      sellsByLength &&
      !piecesMeters(pieces).equals(toDecimal(item.qty))
    ) {
      throw new BadRequestException(
        `${at}: los largos suman ${piecesMeters(pieces).toFixed(3)} m y la línea dice ${toDecimal(item.qty).toFixed(3)}`,
      );
    }

    const totals = salesLineTotals({ qty: item.qty, unitPricePen });

    let reserveItemType: InventoryItemType;
    let reserveItemId: string;
    let reserveQty: string;
    let reserveUnit: string;
    let reserveItemLabel: string;

    if (madeToMeasure) {
      // **La reserva genérica (D-134).** Una cobertura a medida no se atiende con stock de
      // producto terminado: ese producto no existe hasta que planta lo rola. Lo que la línea
      // promete son los **kilos de materia prima** que esos metros van a consumir —
      // `ml × espesor × ancho × densidad del acabado`, la misma aritmética que usa el
      // reporte de piezas (D-047)— contra el **agregado** de bobinas compatibles, no contra
      // una bobina concreta.
      //
      // Que sea el agregado y no un rollo es lo que permite cotizar meses antes de producir:
      // el color y el espesor los sabe el vendedor, y son estables; qué rollo los va a dar lo
      // decide planta al montar la OP (D-086), y entre una cosa y la otra pueden pasar
      // semanas en las que ese rollo se cierra, se parte o se vende.
      //
      // La cotización guarda exactamente lo mismo que el pedido, y eso también es nuevo:
      // antes guardaba "el producto y los metros" como intención y recién al confirmar
      // aparecían los kilos. Ahora el vendedor ve desde la cotización los kilos que va a
      // comprometer, que es el número contra el que se le va a decir que sí o que no.
      const spec = specByProductId.get(product.id);
      if (!spec) {
        throw new BadRequestException(
          `${at}: ${product.sku} se fabrica a medida pero le falta el espesor o el acabado en el catálogo: sin ellos no se sabe qué material necesita ni cuánto pesa`,
        );
      }
      reserveItemType = InventoryItemType.RAW_MATERIAL;
      reserveItemId = spec.id;
      reserveQty = toFixedString(theoreticalKgForMeters(product, item.qty, at), 'KG');
      reserveUnit = Unit.KGM;
      reserveItemLabel = rawMaterialLabel({
        thicknessMm: spec.thicknessMm,
        colorName: product.color?.name ?? null,
      });
    } else {
      reserveItemType = InventoryItemType.PRODUCT;
      reserveItemId = product.id;
      reserveQty = toFixedString(toDecimal(item.qty), 'KG');
      reserveUnit = product.unit;
      reserveItemLabel = product.sku;
    }

    return {
      lineNumber,
      productId: product.id,
      businessLineId: product.businessLineId,
      // D-083: los largos viajan en la descripción porque es lo que el cliente lee en la
      // cotización y en el comprobante — vende metros, pero recibe planchas.
      description:
        item.description ??
        (pieces.length > 0 ? `${product.name} (${describePieces(pieces)})` : product.name),
      qty: item.qty,
      unit: product.unit,
      listPricePen,
      unitPricePen,
      subtotalPen: toFixedString(totals.subtotal, 'MONEY'),
      igvPen: toFixedString(totals.igv, 'MONEY'),
      totalPen: toFixedString(totals.total, 'MONEY'),
      reserveItemType,
      reserveItemId,
      reserveQty,
      reserveUnit,
      pieces,
      productSku: product.sku,
      productName: product.name,
      reserveItemLabel,
    };
  });
}

/** Lo que hace falta para armar una línea de venta de bobina completa (D-116). */
interface SaleCoilResolution {
  coilId: string;
  coilCode: string;
  productId: string;
  productSku: string;
  productName: string;
  productBusinessLineId: string;
  /** Saldo vivo (físico menos reservado) al momento de resolver la línea, en kg. */
  qty: string;
}

/**
 * Resuelve las líneas `saleCoilId` de la tanda: cada una vende el saldo **completo y
 * actual** de esa bobina (decisión del dueño, D-116) contra el SKU `trading` que D-037
 * crea al dar de alta la bobina — nunca lo que el formulario mande en `qty`, para que "toda
 * la bobina" no dependa de que el web haya leído el saldo un segundo antes.
 */
async function resolveSaleCoils(
  tx: Prisma.TransactionClient,
  items: SalesItemInput[],
): Promise<Map<string, SaleCoilResolution>> {
  const coilIds = [...new Set(items.flatMap((i) => (i.saleCoilId ? [i.saleCoilId] : [])))];
  const result = new Map<string, SaleCoilResolution>();
  if (coilIds.length === 0) return result;

  const coils = await tx.coil.findMany({
    where: { id: { in: coilIds } },
    select: { id: true, code: true, kind: true, status: true, typeKey: true },
  });
  const coilById = new Map(coils.map((c) => [c.id, c]));

  const trading = await tx.businessLine.findUnique({ where: { code: BusinessLineCode.TRADING } });
  const skus = [...new Set(coils.map((c) => coilSkuFromTypeKey(c.typeKey)))];
  const products =
    trading && skus.length > 0
      ? await tx.product.findMany({
          where: { businessLineId: trading.id, sku: { in: skus } },
          select: { id: true, sku: true, name: true, businessLineId: true },
        })
      : [];
  const productBySku = new Map(products.map((p) => [p.sku, p]));

  const [balances, reserved] = await Promise.all([
    tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: { in: coilIds } },
      select: { itemId: true, qty: true },
    }),
    tx.reservation.groupBy({
      by: ['itemId'],
      where: {
        status: ReservationStatus.ACTIVE,
        itemType: InventoryItemType.COIL,
        itemId: { in: coilIds },
      },
      _sum: { qty: true },
    }),
  ]);
  const qtyById = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
  const reservedById = new Map(
    reserved.map((r) => [r.itemId, toDecimal((r._sum.qty ?? 0).toString())]),
  );

  for (const coilId of coilIds) {
    const coil = coilById.get(coilId);
    if (!coil) continue; // El `.map` principal lo reporta como "no encontrada".
    if (coil.kind !== CoilKind.COIL) {
      throw new BadRequestException(`${coil.code}: solo se vende una bobina completa, no un fleje`);
    }
    if (coil.status !== CoilStatus.OPEN && coil.status !== CoilStatus.CLOSED) {
      throw new BadRequestException(
        `${coil.code} no está disponible (${coil.status}): solo se vende una bobina abierta o cerrada`,
      );
    }
    const sku = coilSkuFromTypeKey(coil.typeKey);
    const product = productBySku.get(sku);
    if (!product) {
      throw new NotFoundException(`${coil.code}: no existe el producto de venta directa (${sku})`);
    }
    const physical = qtyById.get(coilId) ?? toDecimal('0');
    const alreadyReserved = reservedById.get(coilId) ?? toDecimal('0');
    const available = physical.minus(alreadyReserved);
    if (available.lte(0)) {
      throw new BadRequestException(`${coil.code} no tiene saldo disponible para vender`);
    }
    result.set(coilId, {
      coilId,
      coilCode: coil.code,
      productId: product.id,
      productSku: product.sku,
      productName: product.name,
      productBusinessLineId: product.businessLineId,
      qty: toFixedString(available, 'KG'),
    });
  }
  return result;
}

/** Totales del documento: Σ subtotales + Σ IGV, nunca Σ de totales ya redondeados. */
export function documentTotals(lines: ResolvedSalesLine[]): {
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
} {
  const subtotal = lines.reduce((acc, l) => acc.plus(toDecimal(l.subtotalPen)), toDecimal('0'));
  const igv = lines.reduce((acc, l) => acc.plus(toDecimal(l.igvPen)), toDecimal('0'));
  return {
    subtotalPen: toFixedString(subtotal, 'MONEY'),
    igvPen: toFixedString(igv, 'MONEY'),
    totalPen: toFixedString(subtotal.plus(igv), 'MONEY'),
  };
}

/** Fila persistida (cotización o pedido) → DTO de línea. Las dos tablas tienen la misma forma. */
export function toSalesItemDto(
  row: {
    id: string;
    lineNumber: number;
    productId: string;
    description: string;
    qty: Prisma.Decimal;
    unit: string;
    listPricePen: Prisma.Decimal | null;
    unitPricePen: Prisma.Decimal;
    subtotalPen: Prisma.Decimal;
    igvPen: Prisma.Decimal;
    totalPen: Prisma.Decimal;
    reserveItemType: InventoryItemType;
    reserveItemId: string;
    reserveQty: Prisma.Decimal;
    reserveUnit: string;
    pieces?: { lineNumber: number; lengthMm: Prisma.Decimal; qty: number }[];
    product: { sku: string; name: string; businessLine: { code: BusinessLineCode } };
  },
  reserveItemLabel: string,
): SalesItemDto {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    productSku: row.product.sku,
    productName: row.product.name,
    businessLine: toSharedLineCode(row.product.businessLine.code),
    description: row.description,
    qty: row.qty.toFixed(3),
    unit: row.unit,
    listPricePen: row.listPricePen === null ? null : row.listPricePen.toFixed(4),
    unitPricePen: row.unitPricePen.toFixed(4),
    subtotalPen: row.subtotalPen.toFixed(4),
    igvPen: row.igvPen.toFixed(4),
    totalPen: row.totalPen.toFixed(4),
    pieces: (row.pieces ?? [])
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((p) => ({ lineNumber: p.lineNumber, lengthMm: p.lengthMm.toFixed(2), qty: p.qty })),
    reserveItemType: row.reserveItemType,
    reserveItemId: row.reserveItemId,
    reserveItemLabel,
    reserveQty: row.reserveQty.toFixed(3),
    reserveUnit: row.reserveUnit,
  };
}

// ---------------------------------------------------------------------------
// D-127 — la materia prima de una línea a medida
// ---------------------------------------------------------------------------

/** Lo mínimo del producto que hace falta para decidir la rama y calcular los kilos. */
interface RoofingProductLike {
  id: string;
  sku: string;
  colorId: string | null;
  businessLineId: string;
  thicknessMm: Prisma.Decimal | null;
  widthMm: Prisma.Decimal | null;
  roofingKind: RoofingProductKind | null;
  color: { name: string } | null;
  finish: { densityFactor: Prisma.Decimal } | null;
}

/** Lo que `PrismaService`/`tx` tiene que traer de un producto para poder resolverlo acá. */
export const ROOFING_PRODUCT_SELECT = {
  id: true,
  sku: true,
  colorId: true,
  businessLineId: true,
  thicknessMm: true,
  widthMm: true,
  roofingKind: true,
  color: { select: { name: true } },
  // D-122: el acabado —y con él la densidad— es del producto. Mientras salió de la receta
  // hubo **dos** fuentes para el mismo espesor: la spec del agregado se construía con
  // `bom.inputThicknessMm` y el filtro de la OP comparaba contra `product.thicknessMm`. En
  // cuanto las dos columnas difirieran, el pedido prometía kilos de un agregado que planta
  // no puede montar, y con eso caía la premisa entera de D-134.
  finish: { select: { densityFactor: true } },
} satisfies Prisma.ProductSelect;

/**
 * D-127: ¿esta línea se fabrica a medida?
 *
 * Es el **subtipo declarado**, no la unidad ni el largo. Se aísla en una función para que la
 * pregunta se responda igual en todos lados: mientras estuvo desperdigada como
 * `unit === MTR`, la confirmación y el catálogo podían no coincidir, y de hecho no coincidían.
 */
export function isMadeToMeasure(product: { roofingKind: RoofingProductKind | null }): boolean {
  return product.roofingKind === RoofingProductKind.A_MEDIDA;
}

/**
 * Kilos de bobina que consumen `meters` metros lineales de una cobertura a medida:
 * `ml × espesor × ancho × densityFactor`. Misma aritmética que el reporte de piezas (D-047)
 * y que el kg teórico del catálogo (D-118), vía `kgPerMeter` de `@ayr/shared`.
 *
 * La densidad sale del acabado de la receta activa: es la fuente que D-122 va a mover a
 * `products.finishId`.
 */
export function theoreticalKgForMeters(
  product: RoofingProductLike,
  meters: string,
  at: string,
): Decimal {
  if (product.thicknessMm === null || product.widthMm === null) {
    throw new BadRequestException(
      `${at}: ${product.sku} no tiene espesor y ancho en el catálogo: complétalos antes de cotizarlo a medida`,
    );
  }
  if (product.finish === null) {
    throw new BadRequestException(
      `${at}: ${product.sku} no tiene acabado en el catálogo: sin él no se sabe con qué densidad convertir metros en kilos`,
    );
  }
  return kgPerMeter({
    widthMm: product.widthMm.toFixed(2),
    thicknessMm: product.thicknessMm.toFixed(2),
    densityFactor: product.finish.densityFactor.toFixed(4),
  }).times(toDecimal(meters));
}

/**
 * D-122: el espesor con el que se arma el agregado de una cobertura.
 *
 * Es el del **SKU**, y tiene que ser exactamente el mismo que compara `roofingCoilWhere` al
 * ofrecer y al montar la bobina. Mientras la spec salía de la receta y el filtro del
 * producto, eran dos columnas editables por separado: bastaba con que una se corrigiera
 * para que el pedido prometiera kilos de un agregado que planta no puede montar.
 */
export function roofingSpecThicknessMm(product: RoofingProductLike, at: string): string {
  if (product.thicknessMm === null) {
    throw new BadRequestException(
      `${at}: ${product.sku} no tiene espesor en el catálogo: complétalo antes de cotizarlo a medida`,
    );
  }
  return product.thicknessMm.toFixed(2);
}
