import {
  Decimal,
  detailsLengths,
  isAccessory,
  piecesCount,
  piecesMeters,
  toDecimal,
  type PieceLike,
  type QtyChangeKind,
  type SalesOrderItemQtyRowDto,
} from '@ayr/shared';

/**
 * cc45 (D-603, D-604): la aritmética de «Cambiar cantidad» con producción registrada, sin base
 * de datos. El servicio (`SalesOrderEditsService.updateItemQty`) lee los hechos bajo los locks y
 * decide con estas funciones; la vista previa corre el mismo servicio y deshace.
 */

/** Cómo se mide la cantidad de la línea: por largo, en planchas, en metros o en su unidad. */
export function qtyKindOf(
  product: { unit: string; roofingKind: string | null; lengthMm: string | null },
  produced: boolean,
): QtyChangeKind {
  if (isAccessory(product)) return 'METERS';
  if (detailsLengths(product)) return 'PIECES';
  if (produced && product.lengthMm !== null) return 'UNITS';
  return 'QTY';
}

/** Largos sumados por largo (mm con dos decimales), sin los que quedan en cero. */
export function piecesByLength(pieces: readonly PieceLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pieces) {
    const key = toDecimal(p.lengthMm).toFixed(2);
    out.set(key, (out.get(key) ?? 0) + p.qty);
  }
  for (const [key, qty] of out) if (qty === 0) out.delete(key);
  return out;
}

function sortedPieces(byLength: Map<string, number>): PieceLike[] {
  return [...byLength]
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => toDecimal(b).comparedTo(toDecimal(a)))
    .map(([lengthMm, qty]) => ({ lengthMm, qty }));
}

/**
 * Las filas del diálogo: cada largo del pedido y cada largo registrado (planta puede haber
 * registrado un largo que el pedido no tenía, D-084), de mayor a menor.
 */
export function lengthRows(
  ordered: readonly PieceLike[],
  registered: readonly PieceLike[],
): SalesOrderItemQtyRowDto[] {
  const o = piecesByLength(ordered);
  const r = piecesByLength(registered);
  const keys = [...new Set([...o.keys(), ...r.keys()])].sort((a, b) =>
    toDecimal(b).comparedTo(toDecimal(a)),
  );
  return keys.map((lengthMm) => ({
    lengthMm,
    ordered: o.get(lengthMm) ?? 0,
    registered: r.get(lengthMm) ?? 0,
  }));
}

/** Metros en pantalla: `6.00 m` desde `6000.00`. */
export function lengthLabel(lengthMm: string): string {
  return `${toDecimal(lengthMm).div(1000).toFixed(2)} m`;
}

/**
 * Los pisos de D-603: por largo (a medida), nunca por debajo de lo registrado ni de lo
 * despachado. Devuelve el rechazo o `null`.
 */
export function qtyFloorViolation(input: {
  kind: QtyChangeKind;
  unitLabel: string;
  qty: Decimal;
  pieces: readonly PieceLike[];
  registeredPieces: readonly PieceLike[];
  registeredQty: Decimal;
  dispatchedQty: Decimal;
}): string | null {
  if (input.kind === 'PIECES') {
    const next = piecesByLength(input.pieces);
    for (const [lengthMm, registered] of piecesByLength(input.registeredPieces)) {
      const wanted = next.get(lengthMm) ?? 0;
      if (wanted < registered) {
        return `El largo ${lengthLabel(lengthMm)} no puede bajar de ${String(registered)} planchas: ya están registradas`;
      }
    }
  }
  if (input.qty.lt(input.registeredQty)) {
    return `La cantidad no puede bajar de ${input.registeredQty.toFixed(3)} ${input.unitLabel}: ya están registrados`;
  }
  if (input.qty.lt(input.dispatchedQty)) {
    return `La cantidad no puede bajar de ${input.dispatchedQty.toFixed(3)} ${input.unitLabel}: ya se despacharon`;
  }
  return null;
}

/**
 * Lo que cada largo todavía tiene que fabricar: lo nuevo menos lo ya registrado (`minus`), por
 * largo y sin negativos. Con `minus` = lo registrado por las órdenes cerradas es el plan de la
 * orden viva (D-604: el plan sigue a la cantidad nueva); con todo lo registrado, el de una orden
 * nueva por la diferencia.
 */
export function piecesMinus(next: readonly PieceLike[], minus: readonly PieceLike[]): PieceLike[] {
  const out = piecesByLength(next);
  for (const [lengthMm, qty] of piecesByLength(minus)) {
    if (out.has(lengthMm)) out.set(lengthMm, Math.max(0, (out.get(lengthMm) ?? 0) - qty));
  }
  return sortedPieces(out);
}

/** Planchas y metros de una lista de largos, para el resumen. */
export function piecesSummary(pieces: readonly PieceLike[]): { count: number; meters: Decimal } {
  return { count: piecesCount(pieces), meters: piecesMeters(pieces) };
}

/**
 * Cómo se reparte un cambio de la promesa en kilos (o en la unidad de la reserva) entre la fila
 * de reserva y su faltante (D-341). Bajar descuenta primero lo que nunca se reservó (el faltante)
 * y después lo reservado; nunca deja negativos. Subir lo decide la puerta de confirmar.
 */
export function releaseSplit(input: { delta: Decimal; qty: Decimal; shortfall: Decimal }): {
  qty: Decimal;
  shortfall: Decimal;
  released: Decimal;
} {
  const down = input.delta.negated();
  const fromShortfall = Decimal.min(input.shortfall, down);
  const fromQty = Decimal.min(input.qty, down.minus(fromShortfall));
  return {
    qty: input.qty.minus(fromQty),
    shortfall: input.shortfall.minus(fromShortfall),
    released: fromQty,
  };
}

/** Los mismos largos con las mismas planchas, sin importar el orden. */
export function samePieces(a: readonly PieceLike[], b: readonly PieceLike[]): boolean {
  const x = piecesByLength(a);
  const y = piecesByLength(b);
  return x.size === y.size && [...x].every(([lengthMm, qty]) => y.get(lengthMm) === qty);
}
