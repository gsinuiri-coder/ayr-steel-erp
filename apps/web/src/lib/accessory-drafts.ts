import { toDecimal, type RoofingReportDraftDto } from '@ayr/shared';
import { EMPTY_ACCESSORY_EDIT, typedMeters, type AccessoryEdit } from './accessory-blocks';
import type { DraftContent } from './block-drafts';

/**
 * cc41 (D-591, reemplaza D-559) — **el bloque de accesorio en el borrador de la orden.** Lo que
 * se escribe en un bloque se guarda en el servidor (D-191) como una fila con bobina, metros de
 * bobina, piezas informativas y kg, igual que los largos de coberturas. Esta es la parte pura:
 * qué se manda, cómo se lee lo guardado y la transición desde lo que D-559 dejó en el navegador.
 */

/**
 * Lo que un bloque manda al borrador (`null`: el bloque quedó vacío y su fila se borra), o el
 * motivo por el que todavía no se puede guardar. Los motivos son los de `accessoryBlock`.
 */
export function accessoryDraftContent(
  edit: AccessoryEdit,
): { ok: true; content: DraftContent } | { ok: false; reason: string } {
  const meters = edit.meters.trim();
  const pieces = edit.pieces.trim();
  const kg = edit.consumedKg.trim();
  if (meters === '' && pieces === '' && kg === '') return { ok: true, content: null };
  const parsed = typedMeters(meters);
  if (parsed === null) {
    return {
      ok: false,
      reason:
        meters === ''
          ? 'Escribe los metros de esta bobina antes de sus piezas o sus kilos.'
          : 'Los metros van con hasta tres decimales y mayores a cero.',
    };
  }
  if (pieces !== '' && !(/^\d+$/.test(pieces) && Number(pieces) > 0)) {
    return { ok: false, reason: 'Las piezas son un entero mayor a cero.' };
  }
  if (kg !== '' && (!/^\d+(\.\d{1,3})?$/.test(kg) || toDecimal(kg).lte(0))) {
    return { ok: false, reason: 'Los kilos van con hasta tres decimales y mayores a cero.' };
  }
  return {
    ok: true,
    content: {
      meters: parsed.toFixed(3),
      ...(pieces === '' ? {} : { piecesCount: Number(pieces) }),
      ...(kg === '' ? {} : { consumedKg: toDecimal(kg).toFixed(3) }),
    },
  };
}

/** Metros de lo escrito en un bloque (cero si todavía no se pueden contar). */
export function accessoryEditMeters(edit: AccessoryEdit | undefined): string {
  return typedMeters(edit?.meters ?? '')?.toFixed(3) ?? '0';
}

/**
 * Lo guardado de una bobina, como se escribe en su bloque. Un borrador con dos filas de la misma
 * bobina se suma (D-548: al guardar queda una). Los números van sin ceros de más («7», no «7.000»).
 */
export function accessoryEditFromDrafts(
  rows: readonly RoofingReportDraftDto[],
): AccessoryEdit | null {
  if (rows.length === 0) return null;
  const meters = rows.reduce((acc, d) => acc.plus(d.meters), toDecimal('0'));
  const counted = rows.filter((d) => (d.piecesCount ?? null) !== null);
  const declared = rows.filter((d) => d.consumedKg !== null);
  return {
    meters: meters.toString(),
    pieces:
      counted.length === 0 ? '' : String(counted.reduce((acc, d) => acc + (d.piecesCount ?? 0), 0)),
    consumedKg:
      declared.length === 0
        ? ''
        : declared.reduce((acc, d) => acc.plus(d.consumedKg ?? '0'), toDecimal('0')).toString(),
  };
}

// ---------------------------------------------------------------------------
// La transición desde D-559 (lo escrito en el navegador)
// ---------------------------------------------------------------------------

/** La clave en la que D-559 guardaba lo escrito de cada orden de accesorio. */
export const LEGACY_ACCESSORY_PREFIX = 'ayr:cc35:accesorio:';

type LegacyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Lo que D-559 guardaba por bobina: lo escrito, más la clave y la marca del parte ya mandado. */
interface LegacyAccessoryEdit extends Partial<AccessoryEdit> {
  key?: string;
  sent?: boolean;
}

export interface LegacyUploadResult {
  /** Bobinas cuyo bloque se subió al borrador. */
  uploaded: string[];
  /** La bobina cuyo guardado se rechazó (la transición se detiene ahí), o `null`. */
  failed: string | null;
  /**
   * Bobinas cuyo parte de D-559 pudo haber entrado sin que llegara la respuesta (el bloque tenía
   * clave y no la marca `sent`, y la bobina ya tiene algo registrado): no se suben, porque subirlas
   * podría registrar dos veces lo mismo. La pantalla lo avisa para que se revise.
   */
  doubtful: string[];
}

/**
 * Marca de una transición empezada: la clave ya no es de D-559 sino lo que falta subir. Con ella,
 * «gana el servidor» se decide **por bobina** (las que ya tienen fila en el borrador no se suben),
 * porque las filas del servidor pueden ser las que esta misma transición subió.
 */
const IN_PROGRESS = '_cc41EnCurso';

/**
 * Sube **una vez** al borrador del servidor lo que D-559 dejó escrito en este navegador para una
 * orden, y borra la clave local:
 *
 * - si el servidor ya tiene borrador de esa orden, **gana el servidor**: la clave local se borra
 *   sin subir nada (otro equipo ya escribió);
 * - si no, sube los bloques en el orden de montaje y borra la clave. Un bloque ya registrado
 *   (`sent`) no se sube: su parte ya está en la orden. Uno de una bobina que ya no está montada,
 *   o vacío, tampoco. Uno cuyo parte se mandó sin respuesta, con la bobina ya con algo registrado,
 *   tampoco (`doubtful`);
 * - antes de subir, la clave queda marcada como transición empezada y con lo que falta; si un
 *   guardado se rechaza (o la pantalla se cierra a mitad), se detiene ahí y la clave conserva ese
 *   bloque y los siguientes. La vez siguiente se reintentan solo las bobinas que todavía no tienen
 *   fila en el servidor.
 *
 * `save` guarda un bloque en el borrador y dice si salió bien (en la pantalla, el `put` de
 * `useBlockDrafts`, que deja el error en el bloque). Sin almacenamiento, no hace nada.
 */
export async function uploadLegacyAccessoryEdits(input: {
  storage: LegacyStorage | null;
  orderId: string;
  /** Las bobinas montadas, en orden de montaje. */
  coilIds: readonly string[];
  /** Las bobinas que ya tienen fila en el borrador del servidor. */
  serverCoilIds: readonly string[];
  /** Las bobinas con algo ya registrado en la orden. */
  registeredCoilIds: readonly string[];
  save: (coilId: string, edit: AccessoryEdit) => Promise<boolean>;
}): Promise<LegacyUploadResult> {
  const { storage, orderId } = input;
  const none: LegacyUploadResult = { uploaded: [], failed: null, doubtful: [] };
  if (storage === null) return none;
  const storageKey = LEGACY_ACCESSORY_PREFIX + orderId;
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return none;
  }
  if (raw === null) return none;
  const remove = () => {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Sin almacenamiento escribible: no queda nada que hacer.
    }
  };
  const write = (left: Record<string, AccessoryEdit>) => {
    try {
      storage.setItem(storageKey, JSON.stringify({ ...left, [IN_PROGRESS]: true }));
    } catch {
      // Sin almacenamiento escribible: lo que falta queda en la pantalla, con su error.
    }
  };
  let stored: Record<string, LegacyAccessoryEdit | boolean>;
  try {
    const parsed: unknown = JSON.parse(raw);
    stored =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, LegacyAccessoryEdit>)
        : {};
  } catch {
    remove();
    return none;
  }
  const resuming = stored[IN_PROGRESS] === true;
  if (!resuming && input.serverCoilIds.length > 0) {
    remove();
    return none;
  }

  const doubtful: string[] = [];
  const pending = input.coilIds.flatMap((coilId) => {
    const legacy = stored[coilId];
    if (typeof legacy !== 'object' || legacy.sent === true) return [];
    if (resuming && input.serverCoilIds.includes(coilId)) return [];
    const edit: AccessoryEdit = {
      ...EMPTY_ACCESSORY_EDIT,
      meters: typeof legacy.meters === 'string' ? legacy.meters : '',
      pieces: typeof legacy.pieces === 'string' ? legacy.pieces : '',
      consumedKg: typeof legacy.consumedKg === 'string' ? legacy.consumedKg : '',
    };
    const content = accessoryDraftContent(edit);
    // Vacío no se sube; mal escrito sí, para que el bloque muestre el motivo y no se pierda.
    if (content.ok && content.content === null) return [];
    // D-559 ponía la clave al mandar el parte y `sent` al recibir la respuesta: con clave y sin
    // `sent`, el parte pudo entrar. Si la bobina ya tiene algo registrado, no se sube a ciegas.
    if (typeof legacy.key === 'string' && input.registeredCoilIds.includes(coilId)) {
      doubtful.push(coilId);
      return [];
    }
    return [{ coilId, edit }];
  });

  const uploaded: string[] = [];
  const leftFrom = (index: number) =>
    Object.fromEntries(pending.slice(index).map((p) => [p.coilId, p.edit]));
  for (const [index, { coilId, edit }] of pending.entries()) {
    write(leftFrom(index));
    if (!(await input.save(coilId, edit))) {
      return { uploaded, failed: coilId, doubtful };
    }
    uploaded.push(coilId);
  }
  remove();
  return { uploaded, failed: null, doubtful };
}

/** Si este navegador tiene algo de D-559 para la orden (sin leerlo ni tocarlo). */
export function hasLegacyAccessoryEdits(storage: LegacyStorage | null, orderId: string): boolean {
  try {
    return storage !== null && storage.getItem(LEGACY_ACCESSORY_PREFIX + orderId) !== null;
  } catch {
    return false;
  }
}
