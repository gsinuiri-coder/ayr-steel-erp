import { Decimal, toDecimal, type PieceLike, type RoofingBatchCoilDto } from '@ayr/shared';
import { blockFigures, type BlockFigures } from './production-blocks';

/**
 * cc35 (ESPEC §2) — el modelo M de un **accesorio**: no tiene plan de corte. En cada bobina se
 * escriben directo los metros de bobina que salieron, hasta completar lo del pedido (D-343). Las
 * piezas son opcionales e informativas; los kilos salen de la bobina con su kg por metro.
 *
 * El borrador de reportes (D-191) guarda largos, no metros, así que un bloque de accesorio vive en
 * el navegador hasta registrarse (D-559).
 */

export interface AccessoryEdit {
  meters: string;
  pieces: string;
  consumedKg: string;
  /** D-182: la clave de idempotencia del parte de este bloque, mientras no se registre. */
  key?: string;
  /** Su parte ya respondió: no se vuelve a mandar (se suelta al releer la orden). */
  sent?: boolean;
}

export const EMPTY_ACCESSORY_EDIT: AccessoryEdit = { meters: '', pieces: '', consumedKg: '' };

const METERS_PATTERN = /^\d+(\.\d{1,3})?$/;

/** Los metros escritos, o `null` si están vacíos o mal escritos. */
export function typedMeters(raw: string): Decimal | null {
  const value = raw.trim();
  if (!METERS_PATTERN.test(value)) return null;
  const meters = toDecimal(value);
  return meters.gt(0) ? meters : null;
}

/** Los metros de bobina como una sola «pieza», para la misma cuenta de kilos que hace el API. */
export function metersAsPieces(meters: Decimal | null): PieceLike[] {
  return meters === null ? [] : [{ lengthMm: meters.times(1000).toFixed(2), qty: 1 }];
}

/** El último bloque se llena con lo que falta del pedido menos los otros bloques. */
export function accessoryFill(
  remainingMeters: string,
  others: readonly (Decimal | null)[],
): Decimal {
  const taken = others.reduce<Decimal>(
    (acc, m) => (m === null ? acc : acc.plus(m)),
    new Decimal(0),
  );
  return Decimal.max(toDecimal(remainingMeters).minus(taken), new Decimal(0));
}

export interface AccessoryBlockCheck {
  meters: Decimal | null;
  pieces: number | null;
  figures: BlockFigures;
  /** Lo que el bloque tiene mal escrito (y el API también rechazaría). */
  error: string | null;
}

export function accessoryBlock(
  coil: Pick<
    RoofingBatchCoilDto,
    'coilCode' | 'widthMm' | 'thicknessMm' | 'densityFactor' | 'remainingKg'
  >,
  edit: AccessoryEdit,
): AccessoryBlockCheck {
  const meters = typedMeters(edit.meters);
  const rawPieces = edit.pieces.trim();
  const pieces = /^\d+$/.test(rawPieces) && Number(rawPieces) > 0 ? Number(rawPieces) : null;
  const figures = blockFigures(
    coil,
    metersAsPieces(meters),
    meters === null ? '' : edit.consumedKg,
  );
  let error = figures.error;
  if (edit.meters.trim() !== '' && meters === null) {
    error = 'Los metros van con hasta tres decimales y mayores a cero.';
  } else if (rawPieces !== '' && pieces === null) {
    error = 'Las piezas son un entero mayor a cero.';
  } else if (meters === null && edit.consumedKg.trim() !== '') {
    error = 'Escribe los metros de esta bobina antes de sus kilos.';
  }
  return { meters, pieces, figures, error };
}
