import { BadRequestException } from '@nestjs/common';
import { InventoryItemType, type BusinessLineCode, type Prisma } from '@prisma/client';
import {
  isImportedQuotation,
  normalizeCoilSku,
  paperCoilWeightCheck,
  toFixedString,
  type ConfirmCoilChoiceDto,
} from '@ayr/shared';
import {
  coilPoolFor,
  coilSaleProductsByCoil,
  isCoilSaleProduct,
  knownCoilAttributes,
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
  /**
   * D-385 (A): el espesor y el color **del papel**, con la tolerancia de espesor de coberturas.
   * Las candidatas salen de acá, aunque sean de otro SKU que el producto de la línea.
   */
  pool: CoilPoolKey & { toleranceMm: string };
}

/** Lo mínimo de una línea guardada para saber de qué papel salió. */
export interface PaperCoilLineRef {
  description: string;
  reserveItemType: InventoryItemType;
  reserveItemId: string;
  product: { sku: string; name: string; businessLine: { code: BusinessLineCode } };
}

/**
 * D-385 (A): el pool **del papel** de una línea de bobina importada. La descripción de la línea es
 * el texto del papel («BOBINA ALUZINC AZUL 0.30 X 1200 RAL 5002»): si el normalizador lo
 * interpreta, manda; si no (una descripción editada), el pool del producto o de la bobina de la
 * línea. La tolerancia de espesor se mide desde ahí.
 */
export async function paperPoolOfLine(
  tx: Prisma.TransactionClient,
  line: PaperCoilLineRef,
  known: ReadonlySet<string>,
): Promise<CoilPoolKey | null> {
  const parsed = normalizeCoilSku({ description: line.description }, known);
  if (parsed.ok) {
    return { sku: parsed.sku, thicknessMm: parsed.thicknessMm, attribute: parsed.attribute };
  }
  return lineCoilPool(tx, line);
}

export async function unassignedPaperCoilLines(
  tx: Prisma.TransactionClient,
  quotation: { id: string; notes: string | null },
  toleranceMm: string,
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
  const coilRows = rows.filter((row) => isCoilSaleProduct(row.product));
  if (coilRows.length === 0) return [];
  const known = await knownCoilAttributes(tx);
  const out: UnassignedPaperCoilLine[] = [];
  for (const row of coilRows) {
    const pool = await paperPoolOfLine(tx, row, known);
    if (pool === null) continue;
    out.push({
      itemId: row.id,
      lineNumber: row.lineNumber,
      productSku: row.product.sku,
      paperKg: toFixedString(row.qty.toString(), 'KG'),
      pool: { ...pool, toleranceMm },
    });
  }
  return out;
}

/**
 * Las bobinas libres del mismo color con espesor dentro de la tolerancia del papel —abiertas,
 * sin reserva viva de otro documento, sin montar en una OP y sin otra cotización abierta que las
 * venda (`coilPoolFor`)—, **con cualquier saldo**, con su producto de venta y marcadas según caigan
 * o no en la tolerancia de los kilos del papel. Una bobina sin producto de venta no se ofrece.
 */
export async function paperCoilChoices(
  tx: Prisma.TransactionClient,
  line: UnassignedPaperCoilLine,
  quotationId: string,
  /** El pedido que se está creando: su propia reserva no le quita la bobina (re-chequeo). */
  exceptSalesOrderId?: string,
): Promise<ConfirmCoilChoiceDto[]> {
  const pool = await coilPoolFor(tx, line.pool, '0.000', {
    exceptQuotationIds: [quotationId],
    ...(exceptSalesOrderId ? { exceptSalesOrderIds: [exceptSalesOrderId] } : {}),
  });
  const products = await coilSaleProductsByCoil(
    tx,
    pool.candidates.map((c) => c.coilId),
  );
  return pool.candidates.flatMap((c) => {
    const product = products.get(c.coilId);
    if (!product) return [];
    return [
      {
        coilId: c.coilId,
        code: c.code,
        widthMm: c.widthMm,
        balanceKg: c.balanceKg,
        thicknessMm: c.thicknessMm,
        productSku: product.sku,
        withinTolerance: paperCoilWeightCheck(line.paperKg, c.balanceKg).ok,
      },
    ];
  });
}

/** El motivo por el que la línea no se puede confirmar con ninguna bobina, o `null`. */
export function paperCoilBlocker(
  line: UnassignedPaperCoilLine,
  choices: readonly ConfirmCoilChoiceDto[],
): string | null {
  const at = `Línea ${String(line.lineNumber)} (${line.productSku})`;
  // D-385 (A): «de BOB030AZUL ±0.02 mm»: el papel y la tolerancia de espesor.
  const pool = `${line.pool.sku} ±${line.pool.toleranceMm} mm`;
  if (choices.length === 0) {
    return `${at}: sin bobina asignada y no hay ninguna bobina libre de ${pool}. Recibe la compra de la bobina y vuelve a confirmar.`;
  }
  if (!choices.some((c) => c.withinTolerance)) {
    const range = paperCoilWeightCheck(line.paperKg, '0');
    return `${at}: ninguna bobina libre de ${pool} pesa lo del papel (${line.paperKg} kg, entre ${range.minKg} y ${range.maxKg} kg): ${choices
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
 * D-385: valida la bobina que se eligió para cada línea sin bobina asignada. Toda línea así
 * necesita una; ninguna otra línea acepta una. La bobina tiene que estar libre en el pool de la
 * línea y su saldo dentro de la tolerancia de los kilos del papel.
 *
 * **No toma locks.** `confirm` la llama dos veces: antes de crear el pedido, para armar sus
 * líneas, y otra vez después de `createReservations` —que bloquea la unión de bobinas en orden de
 * id, el único orden que no se cruza con otra confirmación (autorrevisión cc17, P2-1)— con
 * `exceptSalesOrderId` para no contarse la reserva recién hecha. Si la segunda lectura no da lo
 * mismo que la primera, algo cambió en el medio y se rechaza.
 */
export async function resolvePaperCoilAssignments(
  tx: Prisma.TransactionClient,
  quotation: { id: string; notes: string | null },
  requested: readonly { lineNumber: number; saleCoilId: string }[],
  options: { toleranceMm: string; exceptSalesOrderId?: string },
): Promise<PaperCoilAssignment[]> {
  const lines = await unassignedPaperCoilLines(tx, quotation, options.toleranceMm);
  const byLine = new Map(lines.map((l) => [l.lineNumber, l]));
  for (const r of requested) {
    if (!byLine.has(r.lineNumber)) {
      throw new BadRequestException(
        `Línea ${String(r.lineNumber)}: no es una línea de bobina sin bobina asignada; no se le elige bobina al confirmar`,
      );
    }
  }
  if (lines.length === 0) return [];
  if (new Set(requested.map((r) => r.saleCoilId)).size < requested.length) {
    throw new BadRequestException('La misma bobina no puede atender dos líneas');
  }

  const out: PaperCoilAssignment[] = [];
  for (const line of lines) {
    const choice = requested.find((r) => r.lineNumber === line.lineNumber);
    const choices = await paperCoilChoices(tx, line, quotation.id, options.exceptSalesOrderId);
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
        `${at}: esa bobina no está libre para ${line.pool.sku} (abierta, del mismo color, con espesor dentro de ±${line.pool.toleranceMm} mm, sin reserva, sin OP y sin otra cotización abierta)`,
      );
    }
    const check = paperCoilWeightCheck(line.paperKg, chosen.balanceKg);
    if (!check.ok) {
      throw new BadRequestException(
        `${at}: ${chosen.code} tiene ${chosen.balanceKg} kg y el papel dice ${line.paperKg} kg. Fuera de la tolerancia: el saldo tiene que estar entre ${check.minKg} y ${check.maxKg} kg.`,
      );
    }
    // D-385 (A): la línea toma el producto de la bobina elegida (`BOB028AZUL`), aunque el papel
    // diga otro SKU dentro de la tolerancia; descripción, kilos e importe siguen siendo del papel.
    const product = (await coilSaleProductsByCoil(tx, [chosen.coilId])).get(chosen.coilId);
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
