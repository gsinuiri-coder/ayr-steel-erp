import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, type Prisma } from '@prisma/client';
import {
  isImportedQuotation,
  paperCoilWeightCheck,
  toFixedString,
  type ConfirmCoilChoiceDto,
} from '@ayr/shared';
import {
  COIL_SALE_IDENTITY_SELECT,
  coilPoolFor,
  coilSaleSkus,
  findCoilSaleProducts,
  isCoilSaleProduct,
  lineCoilPool,
  type CoilPoolKey,
} from './coil-sale-product';

/**
 * D-385: la línea de bobina **sin bobina asignada** de una cotización importada. El importador
 * la deja así cuando ninguna bobina libre del pool tenía los kilos del papel: la cotización nace
 * emitida con los kilos y el importe del papel, y la bobina se elige **al confirmar**.
 *
 * Solo en cotizaciones importadas: una manual (o el duplicado de D-322) sigue como antes —se
 * edita y se elige la bobina con «Bobina completa (venta directa)»—, porque fuera del papel la
 * venta de bobina vende el saldo y no unos kilos fijados.
 */
export interface UnassignedPaperCoilLine {
  itemId: string;
  lineNumber: number;
  productSku: string;
  /** Los kilos del papel, a escala de kilos. */
  paperKg: string;
  pool: CoilPoolKey;
}

export async function unassignedPaperCoilLines(
  tx: Prisma.TransactionClient,
  quotation: { id: string; notes: string | null },
): Promise<UnassignedPaperCoilLine[]> {
  if (!isImportedQuotation(quotation.notes)) return [];
  const rows = await tx.quotationItem.findMany({
    where: { quotationId: quotation.id, reserveItemType: { not: InventoryItemType.COIL } },
    select: {
      id: true,
      lineNumber: true,
      qty: true,
      description: true,
      reserveItemType: true,
      reserveItemId: true,
      product: { select: { sku: true, name: true, businessLine: { select: { code: true } } } },
    },
    orderBy: { lineNumber: 'asc' },
  });
  const out: UnassignedPaperCoilLine[] = [];
  for (const row of rows) {
    if (!isCoilSaleProduct(row.product)) continue;
    const pool = await lineCoilPool(tx, row);
    if (pool === null) continue;
    out.push({
      itemId: row.id,
      lineNumber: row.lineNumber,
      productSku: row.product.sku,
      paperKg: toFixedString(row.qty.toString(), 'KG'),
      pool,
    });
  }
  return out;
}

/**
 * Las bobinas libres del pool de la línea —abiertas, sin reserva viva de otro documento, sin
 * montar en una OP y sin otra cotización abierta que las venda (`coilPoolFor`)—, **con cualquier
 * saldo**, marcadas según caigan o no en la tolerancia de los kilos del papel.
 */
export async function paperCoilChoices(
  tx: Prisma.TransactionClient,
  line: UnassignedPaperCoilLine,
  quotationId: string,
): Promise<ConfirmCoilChoiceDto[]> {
  const pool = await coilPoolFor(tx, line.pool, '0.000', { exceptQuotationIds: [quotationId] });
  return pool.candidates.map((c) => ({
    coilId: c.coilId,
    code: c.code,
    widthMm: c.widthMm,
    balanceKg: c.balanceKg,
    withinTolerance: paperCoilWeightCheck(line.paperKg, c.balanceKg).ok,
  }));
}

/** El motivo por el que la línea no se puede confirmar con ninguna bobina, o `null`. */
export function paperCoilBlocker(
  line: UnassignedPaperCoilLine,
  choices: readonly ConfirmCoilChoiceDto[],
): string | null {
  const at = `Línea ${String(line.lineNumber)} (${line.productSku})`;
  if (choices.length === 0) {
    return `${at}: sin bobina asignada y no hay ninguna bobina libre de ${line.productSku}. Recibe la compra de la bobina y vuelve a confirmar.`;
  }
  if (!choices.some((c) => c.withinTolerance)) {
    const range = paperCoilWeightCheck(line.paperKg, '0');
    return `${at}: ninguna bobina libre de ${line.productSku} pesa lo del papel (${line.paperKg} kg, entre ${range.minKg} y ${range.maxKg} kg): ${choices
      .map((c) => `${c.code} tiene ${c.balanceKg} kg`)
      .join(', ')}.`;
  }
  return null;
}

/** Lo que confirmar escribe en una línea a la que se le eligió bobina. */
export interface PaperCoilAssignment {
  lineNumber: number;
  itemId: string;
  coilId: string;
  coilCode: string;
  productId: string;
  paperKg: string;
  /** Lo que se reserva: el saldo entero de la bobina (la venta la cierra, D-385). */
  balanceKg: string;
}

/**
 * D-385: valida, **bajo el lock de las bobinas**, la bobina que se eligió para cada línea sin
 * bobina asignada. Toda línea así necesita una; ninguna otra línea acepta una. La bobina tiene
 * que estar libre en el pool de la línea y su saldo dentro de la tolerancia de los kilos del
 * papel. La doble promesa contra otro pedido la corta igual `createReservations`, que vuelve a
 * bloquear la bobina y comprueba el disponible.
 */
export async function resolvePaperCoilAssignments(
  tx: Prisma.TransactionClient,
  quotation: { id: string; notes: string | null },
  requested: readonly { lineNumber: number; saleCoilId: string }[],
): Promise<PaperCoilAssignment[]> {
  const lines = await unassignedPaperCoilLines(tx, quotation);
  const byLine = new Map(lines.map((l) => [l.lineNumber, l]));
  for (const r of requested) {
    if (!byLine.has(r.lineNumber)) {
      throw new BadRequestException(
        `Línea ${String(r.lineNumber)}: no es una línea de bobina sin bobina asignada; no se le elige bobina al confirmar`,
      );
    }
  }
  if (lines.length === 0) return [];

  // Las bobinas, en orden de id y antes que los saldos: el mismo orden de locks que
  // `createReservations` y el despacho.
  const coilIds = [...new Set(requested.map((r) => r.saleCoilId))].sort();
  if (coilIds.length > 0) {
    await tx.$queryRaw`
      SELECT "id" FROM "coils" WHERE "id" = ANY(${coilIds}::uuid[]) ORDER BY "id" FOR UPDATE
    `;
  }
  if (coilIds.length < requested.length) {
    throw new BadRequestException('La misma bobina no puede atender dos líneas');
  }

  const out: PaperCoilAssignment[] = [];
  for (const line of lines) {
    const choice = requested.find((r) => r.lineNumber === line.lineNumber);
    const choices = await paperCoilChoices(tx, line, quotation.id);
    if (!choice) {
      throw new BadRequestException(
        paperCoilBlocker(line, choices) ??
          `Línea ${String(line.lineNumber)} (${line.productSku}): sin bobina asignada. Elige la bobina al confirmar.`,
      );
    }
    const chosen = choices.find((c) => c.coilId === choice.saleCoilId);
    const at = `Línea ${String(line.lineNumber)}`;
    if (!chosen) {
      throw new BadRequestException(
        `${at}: esa bobina no está libre en el pool de ${line.productSku} (abierta, del mismo espesor y color, sin reserva, sin OP y sin otra cotización abierta)`,
      );
    }
    const check = paperCoilWeightCheck(line.paperKg, chosen.balanceKg);
    if (!check.ok) {
      throw new BadRequestException(
        `${at}: ${chosen.code} tiene ${chosen.balanceKg} kg y el papel dice ${line.paperKg} kg. Fuera de la tolerancia: el saldo tiene que estar entre ${check.minKg} y ${check.maxKg} kg.`,
      );
    }
    const coil = await tx.coil.findUniqueOrThrow({
      where: { id: chosen.coilId },
      select: COIL_SALE_IDENTITY_SELECT,
    });
    const product = (await findCoilSaleProducts(tx, [coil])).get(coilSaleSkus(coil).canonical);
    if (!product) {
      throw new BadRequestException(`${at}: ${chosen.code} no tiene producto de venta de bobina`);
    }
    out.push({
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      coilId: chosen.coilId,
      coilCode: chosen.code,
      productId: product.id,
      paperKg: line.paperKg,
      balanceKg: chosen.balanceKg,
    });
  }
  return out;
}
