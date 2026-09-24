import { MAX_LINE_DESCRIPTION } from '@ayr/shared';

export { MAX_LINE_DESCRIPTION };

/**
 * D-283: la descripción editable de una línea de cotización o pedido. Arranca con el nombre del
 * producto; si nadie la toca no viaja y la arma el API como siempre (nombre + largos, D-083).
 * Editada, viaja lo tipeado y los largos se siguen agregando solos al final, porque son lo que
 * el cliente lee en el comprobante para saber qué planchas le llegan.
 */
export interface DescriptionDraft {
  description: string;
  descriptionEdited: boolean;
  /**
   * Lo guardado no trae el sufijo de largos que arma el API (el texto del papel importado,
   * D-152): mientras nadie lo toque se reenvía tal cual, sin agregarle largos. Editarlo lo apaga.
   */
  descriptionVerbatim?: boolean;
}

function piecesSuffix(piecesText: string): string {
  return piecesText === '' ? '' : ` (${piecesText})`;
}

/** Lo guardado, separado de los largos que el API le agregó, y si difiere del nombre. */
export function descriptionFromStored(
  stored: string,
  productName: string,
  piecesText: string,
): DescriptionDraft {
  const suffix = piecesSuffix(piecesText);
  const hasSuffix = suffix !== '' && stored.endsWith(suffix);
  const base = hasSuffix ? stored.slice(0, -suffix.length) : stored;
  if (base === productName) return { description: base, descriptionEdited: false };
  // Con largos y sin su sufijo: no lo escribió este formulario. Se conserva tal cual.
  if (suffix !== '' && !hasSuffix) {
    return { description: stored, descriptionEdited: true, descriptionVerbatim: true };
  }
  return { description: base, descriptionEdited: true };
}

/**
 * Lo que viaja en `description`: `undefined` si la línea usa la descripción por defecto, o el
 * texto editado con los largos. Se rechaza si pasa del tope de la columna.
 */
export function descriptionToSend(
  draft: DescriptionDraft,
  productName: string | null,
  piecesText: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const base = draft.description.trim();
  if (draft.descriptionVerbatim === true && base !== '') {
    return { ok: true, value: base.slice(0, MAX_LINE_DESCRIPTION) };
  }
  if (!draft.descriptionEdited || base === '' || base === productName) {
    return { ok: true, value: undefined };
  }
  const full = `${base}${piecesSuffix(piecesText)}`;
  if (full.length > MAX_LINE_DESCRIPTION) {
    return {
      ok: false,
      reason: `la descripción tiene ${full.length} caracteres${piecesText === '' ? '' : ' con los largos'}; el máximo es ${MAX_LINE_DESCRIPTION}`,
    };
  }
  return { ok: true, value: full };
}
