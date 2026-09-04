import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CoilStatus, InventoryItemType, type Prisma } from '@prisma/client';
import {
  describePieces,
  piecesMeters,
  salesLineTotals,
  toDecimal,
  toFixedString,
  Unit,
  type RoofingPieceDto,
  type SalesItemDto,
  type SalesItemInput,
} from '@ayr/shared';

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
 * El destino de la reserva se decide acá, una sola vez:
 *
 * - con `reserveFromCoilId`, la línea promete **kilos de esa bobina**. Es el caso de una
 *   cobertura que se fabrica contra el pedido: su producto terminado no tiene stock que
 *   reservar y lo que hay que proteger es la materia prima;
 * - sin él, la línea promete **el propio producto**, en su unidad de venta. Es el caso de
 *   un perfil de drywall, de un producto de trading y —desde D-083— también el de una
 *   cobertura que sale de stock, sea una plancha de catálogo o el sobrante de una corrida
 *   anterior.
 *
 * **Desde D-083 el segundo caso ya no se rechaza en una línea con cotización obligatoria.**
 * Antes se cortaba acá con el argumento de que reservar un producto terminado inexistente
 * fallaría igual al confirmar; el argumento dejó de valer cuando la producción de coberturas
 * empezó a dejar metros y planchas en stock, que son perfectamente vendibles. Quien decide
 * ahora es el disponible real, en `createReservations`, con un mensaje que dice cuánto hay.
 *
 * D-083 además distingue las dos formas de línea por la **unidad del producto**: `MTR` es
 * una cobertura a medida y su línea es compuesta (subítems `{cantidad, largo}` cuya suma en
 * metros **es** la cantidad de la línea); cualquier otra unidad es una línea simple.
 */
export async function resolveSalesLines(
  tx: Prisma.TransactionClient,
  businessLineId: string,
  items: SalesItemInput[],
): Promise<ResolvedSalesLine[]> {
  const productIds = [...new Set(items.map((i) => i.productId))];
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
    },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  const coilIds = [
    ...new Set(items.flatMap((i) => (i.reserveFromCoilId ? [i.reserveFromCoilId] : []))),
  ];
  const coils =
    coilIds.length === 0
      ? []
      : await tx.coil.findMany({
          where: { id: { in: coilIds } },
          select: { id: true, code: true, status: true, businessLineId: true },
        });
  const coilById = new Map(coils.map((c) => [c.id, c]));

  return items.map((item, index) => {
    const lineNumber = index + 1;
    const at = `Línea ${lineNumber}`;
    const product = productById.get(item.productId);
    if (!product) throw new NotFoundException(`${at}: producto no encontrado`);
    if (!product.isActive) {
      throw new BadRequestException(`${at}: el producto ${product.sku} está desactivado`);
    }
    if (product.businessLineId !== businessLineId) {
      throw new BadRequestException(
        `${at}: el producto ${product.sku} es de otra línea de negocio`,
      );
    }

    const listPricePen = product.listPricePen === null ? null : product.listPricePen.toFixed(4);
    const unitPricePen = item.unitPricePen ?? listPricePen;
    if (unitPricePen === null) {
      throw new BadRequestException(
        `${at}: el producto ${product.sku} no tiene precio de lista; escribe el precio en la línea`,
      );
    }

    // D-083: la forma de la línea la fija la unidad del producto, no un flag del input.
    // Sin este par de chequeos, una cobertura a medida podría cotizarse sin largos —y la OP
    // no tendría plan de corte que copiar— o un perfil podría llegar con largos que nada
    // en el sistema volvería a mirar.
    const madeToMeasure = product.unit === Unit.MTR;
    if (madeToMeasure && item.pieces === undefined) {
      throw new BadRequestException(
        `${at}: ${product.sku} se vende por metro lineal: detalla cuántas planchas de cada largo lleva la línea`,
      );
    }
    if (!madeToMeasure && item.pieces !== undefined) {
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
    if (madeToMeasure && !piecesMeters(pieces).equals(toDecimal(item.qty))) {
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

    if (item.reserveFromCoilId !== undefined && item.reserveKg !== undefined) {
      const coil = coilById.get(item.reserveFromCoilId);
      if (!coil) throw new NotFoundException(`${at}: bobina a reservar no encontrada`);
      if (coil.status !== CoilStatus.OPEN) {
        throw new BadRequestException(
          `${at}: ${coil.code} no está disponible (${coil.status}); solo se reserva material de una bobina abierta`,
        );
      }
      if (coil.businessLineId !== businessLineId) {
        throw new BadRequestException(`${at}: ${coil.code} es de otra línea de negocio`);
      }
      reserveItemType = InventoryItemType.COIL;
      reserveItemId = coil.id;
      reserveQty = item.reserveKg;
      reserveUnit = Unit.KGM;
      reserveItemLabel = coil.code;
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
    product: { sku: string; name: string };
  },
  reserveItemLabel: string,
): SalesItemDto {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    productSku: row.product.sku,
    productName: row.product.name,
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
