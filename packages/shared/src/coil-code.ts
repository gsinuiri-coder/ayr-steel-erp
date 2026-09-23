import { Decimal, toDecimal, toFixedString, type DecimalInput } from './decimal';

/**
 * Códigos derivados de una bobina. Viven en `@ayr/shared` porque el API los genera
 * y el web los muestra/previsualiza; una sola definición evita que diverjan.
 *
 * - RF-13 `code`:    `{supplierCode}-{finishCode}-{thicknessMm}-{weightKg}-{correlativo}`
 * - RF-14 `typeKey`: `{finishCode}-{thicknessMm}` (agrupa ignorando el ancho)
 * - D-037 `sku`:     `BOB{finishCode}{thicknessMm}` (uno por `typeKey`)
 *
 * **El guion es un separador, no un carácter a borrar (D-168).** Un código de acabado real
 * lleva guiones adentro —`ALZ-ROJO-3002`— y por ahí se coló la única forma de que dos
 * funciones que dicen calcular el mismo SKU devuelvan cosas distintas: `coilSku` conservaba
 * los guiones del acabado (`BOBALZ-ROJO-30020.45`, que es lo que el catálogo dio de alta) y
 * `coilSkuFromTypeKey` los borraba todos (`BOBALZROJO30020.45`, que es lo que la venta
 * directa buscaba y no encontraba nunca). El síntoma era «no existe el producto de venta
 * directa» sobre una bobina que sí tenía su producto.
 *
 * Por eso hay **una sola** función que arma el SKU (`coilSku`) y la otra parte el `typeKey`
 * por su **último** guion —el que separa el espesor— y la llama.
 */

/** Normaliza un código de acabado o proveedor para usarlo dentro de un código compuesto. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Espesor con la escala mm fija (2 decimales, D-003): `0.5` → `"0.50"`. */
export function formatThickness(thicknessMm: DecimalInput): string {
  return toFixedString(thicknessMm, 'MM');
}

/**
 * Peso en kilos enteros para el segmento de peso de RF-13. El código es una etiqueta
 * física legible; los kilos exactos viven en `coils.weightKg` con escala 3, y la
 * unicidad la garantiza el correlativo, no este segmento.
 */
export function formatCodeWeight(weightKg: DecimalInput): string {
  return toDecimal(weightKg).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

/** RF-14: clave de tipo de bobina, agrupa por acabado y espesor ignorando el ancho. */
export function coilTypeKey(finishCode: string, thicknessMm: DecimalInput): string {
  return `${normalizeCode(finishCode)}-${formatThickness(thicknessMm)}`;
}

/**
 * D-037: SKU del producto de `trading` con el que se vende la bobina sin transformar.
 *
 * **La única fuente del SKU de una bobina.** Todo lo que necesite este código pasa por acá,
 * incluida `coilSkuFromTypeKey`: mientras hubo dos cuentas, una generaba el producto y la
 * otra lo buscaba, y con un acabado con guiones no coincidían (D-168).
 */
export function coilSku(finishCode: string, thicknessMm: DecimalInput): string {
  return `BOB${normalizeCode(finishCode)}${formatThickness(thicknessMm)}`;
}

/**
 * D-037: el mismo SKU, partiendo del `typeKey` ya calculado.
 *
 * Parte por el **último** guion, que es el separador que `coilTypeKey` puso entre el acabado
 * y el espesor; los anteriores son parte del código de acabado y se conservan. Es el mismo
 * criterio que `describeTypeKey` usa para leerlo en el inventario valorizado.
 *
 * Sin `typeKey` reconocible —sin guion, con el guion al principio, o con algo que no es un
 * número donde va el espesor— devuelve el prefijo sobre la cadena entera en vez de inventar
 * un espesor o reventar: el llamador va a buscar un producto que no existe y lo va a
 * reportar nombrando el SKU, que es mejor que un 500 sin nombre.
 */
export function coilSkuFromTypeKey(typeKey: string): string {
  const separator = typeKey.lastIndexOf('-');
  const thickness = typeKey.slice(separator + 1);
  if (separator <= 0 || !/^\d+(\.\d+)?$/.test(thickness)) {
    return `BOB${normalizeCode(typeKey)}`;
  }
  return coilSku(typeKey.slice(0, separator), thickness);
}

// ---------------------------------------------------------------------------
// D-252 (RF-S4b): el SKU canónico de venta de una bobina y el normalizador único
// ---------------------------------------------------------------------------
//
// Regla del dueño: `BOB` + espesor + color comercial o tipo. `BOB038ROJO`.
//
// - Espesor: mm × 100, **siempre tres dígitos** (0.30 → 030, 0.38 → 038, 0.45 → 045).
// - Color: el color comercial del catálogo en mayúsculas, sin tildes ni espacios. **El RAL nunca
//   separa colores**: `ROJO` (3002) y `ROJO-3020` («rojo tráfico») son `ROJO`. Sin color va el
//   tipo del acabado (`NATURAL`, `GALVANIZADO`).
// - El ancho no entra: es atributo de la bobina física, y 1200 y 1220 comparten SKU.
//
// Reemplaza a `coilSku` (D-037/D-168) como SKU **de venta**; `coilSku` queda solo para reconocer
// los productos creados con la forma vieja durante la transición (D-253).
//
// El normalizador vive acá, junto a D-168 y no en un archivo nuevo, porque es la misma pregunta
// —«qué SKU nombra a esta bobina»— y dos lugares que la respondan vuelven a divergir.

/** Los tipos de acabado, tal como los nombra el enum `FinishKind` de la base. */
export type CoilFinishKind = 'NATURAL' | 'PREPINTADO' | 'GALVANIZADO';

/** Prefijo de todo SKU de venta de bobina. */
export const COIL_SKU_PREFIX = 'BOB';

// U+0300..U+036F: marcas diacríticas combinantes que deja `normalize('NFD')`.
const DIACRITICS = new RegExp(`[̀-ͯ]`, 'g');

/** Mayúsculas, sin tildes y sin nada que no sea letra o dígito. */
function skuToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** D-252: `0.38` → `038`. El espesor vive con escala mm 2, así que × 100 es siempre entero. */
export function coilThicknessToken(thicknessMm: DecimalInput): string {
  const hundredths = toDecimal(thicknessMm).times(100);
  if (!hundredths.isInteger() || hundredths.lte(0) || hundredths.gte(1000)) {
    throw new Error(`Espesor fuera de la regla del SKU de bobina: ${String(thicknessMm)} mm`);
  }
  return hundredths.toFixed(0).padStart(3, '0');
}

/**
 * D-252: el color comercial a partir del **código** del color del catálogo.
 *
 * Se lee el código y no el nombre porque el nombre es para la pantalla —`Rojo tráfico`— y el
 * código ya es la forma corta. Lo que se le quita es el sufijo RAL (`ROJO-3020` → `ROJO`) y
 * cualquier signo; lo que queda es el color comercial. Distintos RAL del mismo color comercial
 * comparten SKU (AGENTS.md §7): en venta el RAL no separa nada. La producción sigue
 * emparejando por el `colorId` exacto (D-085), que esta función no toca.
 */
export function commercialColorToken(colorCode: string): string {
  return skuToken(colorCode.trim().replace(/[-\s]*(RAL)?[-\s]*\d{3,4}$/i, ''));
}

/** D-252: el token de color o tipo de un acabado. Una prepintada lleva color siempre (D-203). */
export function coilSkuAttribute(finish: {
  kind: CoilFinishKind;
  colorCode: string | null;
}): string {
  if (finish.kind === 'PREPINTADO') {
    if (finish.colorCode === null) {
      throw new Error('Un acabado prepintado sin color no tiene SKU de bobina (D-203)');
    }
    return commercialColorToken(finish.colorCode);
  }
  return finish.kind;
}

/** D-252: el SKU canónico de venta de una bobina, desde su acabado y su espesor. */
export function canonicalCoilSku(
  finish: { kind: CoilFinishKind; colorCode: string | null },
  thicknessMm: DecimalInput,
): string {
  return `${COIL_SKU_PREFIX}${coilThicknessToken(thicknessMm)}${coilSkuAttribute(finish)}`;
}

/** Cómo escribe el origen un tipo sin color. Todo lo demás tiene que ser un token del catálogo. */
const KIND_SYNONYMS: Readonly<Record<string, string>> = {
  GALV: 'GALVANIZADO',
  GALVANIZADA: 'GALVANIZADO',
  GALVANIZADO: 'GALVANIZADO',
  NATURAL: 'NATURAL',
};

export type CoilSkuParse =
  | { ok: true; sku: string; thicknessMm: string; attribute: string; from: 'code' | 'description' }
  | { ok: false; reason: string };

/** El token del origen, contra lo que el catálogo conoce. `null` si no mapea. */
function knownAttribute(raw: string, known: ReadonlySet<string>): string | null {
  const token = skuToken(raw);
  const kind = KIND_SYNONYMS[token];
  if (kind !== undefined) return known.has(kind) ? kind : null;
  return known.has(token) ? token : null;
}

/** `38` → `0.38`, `038` → `0.38`, `0.38` → `0.38`. `null` si no es un espesor legible. */
function thicknessOf(raw: string): string | null {
  const value = raw.replace(',', '.');
  if (/^\d\.\d{1,2}$/.test(value)) return toDecimal(value).toFixed(2);
  // Dos o tres dígitos son centésimas de mm; uno solo no dice si son décimas o centésimas.
  if (/^\d{2,3}$/.test(value)) return toDecimal(value).div(100).toFixed(2);
  return null;
}

function fromCode(code: string, known: ReadonlySet<string>): CoilSkuParse {
  const compact = code.replace(/\s+/g, '').toUpperCase();
  const match = /^BOB(\d\.\d{1,2}|\d+)([A-Z][A-Z0-9]*)$/.exec(compact);
  if (!match)
    return { ok: false, reason: `${code.trim()} no tiene la forma BOB + espesor + color` };
  const [, rawThickness = '', rawAttribute = ''] = match;
  const thicknessMm = thicknessOf(rawThickness);
  if (thicknessMm === null) {
    return { ok: false, reason: `${code.trim()}: el espesor «${rawThickness}» no se puede leer` };
  }
  const attribute = knownAttribute(rawAttribute, known);
  if (attribute === null) {
    return {
      ok: false,
      reason: `${code.trim()}: «${rawAttribute}» no es un color ni un tipo del catálogo`,
    };
  }
  return {
    ok: true,
    sku: `${COIL_SKU_PREFIX}${coilThicknessToken(thicknessMm)}${attribute}`,
    thicknessMm,
    attribute,
    from: 'code',
  };
}

function fromDescription(description: string, known: ReadonlySet<string>): CoilSkuParse {
  const text = description.normalize('NFD').replace(DIACRITICS, '').toUpperCase();
  if (!/\bBOBINA\b/.test(text)) {
    return { ok: false, reason: 'La descripción no es de una bobina' };
  }
  // El primer número con decimales es el espesor; el ancho (1220) y el RAL (3020) son enteros.
  const thickness = /\b(\d[.,]\d{1,2})\b/.exec(text);
  const thicknessMm = thickness?.[1] === undefined ? null : thicknessOf(thickness[1]);
  if (thicknessMm === null) {
    return { ok: false, reason: 'La descripción no trae un espesor legible' };
  }
  const attributes = new Set(
    text
      .split(/[^A-Z0-9]+/)
      .map((word) => knownAttribute(word, known))
      .filter((a): a is string => a !== null),
  );
  if (attributes.size !== 1) {
    return {
      ok: false,
      reason:
        attributes.size === 0
          ? 'La descripción no nombra un color ni un tipo del catálogo'
          : `La descripción nombra más de un color o tipo: ${[...attributes].join(', ')}`,
    };
  }
  const [attribute = ''] = [...attributes];
  return {
    ok: true,
    sku: `${COIL_SKU_PREFIX}${coilThicknessToken(thicknessMm)}${attribute}`,
    thicknessMm,
    attribute,
    from: 'description',
  };
}

/**
 * D-252: **el normalizador único.** Interpreta un código de bobina del origen —`BOB38ROJO`,
 * `BOB038ROJO`, `BOB0.38ROJO`— y, como respaldo, la descripción de la línea («BOBINA ALUZINC ROJO
 * 0.38 X 1220 RAL 3020»), y devuelve el SKU canónico.
 *
 * `known` son los tokens que el catálogo conoce —los colores comerciales y los tipos sin color—:
 * un color que el catálogo no tiene **no se inventa** (regla dura 10), la línea queda para
 * revisión con el motivo. El código manda sobre la descripción cuando los dos se interpretan.
 */
export function normalizeCoilSku(
  input: { code?: string | null; description?: string | null },
  known: ReadonlySet<string>,
): CoilSkuParse {
  const code = input.code?.trim() ?? '';
  const byCode = code === '' ? null : fromCode(code, known);
  if (byCode?.ok === true) return byCode;
  const description = input.description?.trim() ?? '';
  if (description !== '') {
    const byDescription = fromDescription(description, known);
    if (byDescription.ok) return byDescription;
    if (byCode === null) return byDescription;
  }
  return byCode ?? { ok: false, reason: 'La línea no trae código ni descripción de bobina' };
}

/** RF-13: código único de una bobina concreta. `sequence` es el correlativo del proveedor. */
export function coilCode(input: {
  supplierCode: string;
  finishCode: string;
  thicknessMm: DecimalInput;
  weightKg: DecimalInput;
  sequence: number;
}): string {
  return [
    normalizeCode(input.supplierCode),
    normalizeCode(input.finishCode),
    formatThickness(input.thicknessMm),
    formatCodeWeight(input.weightKg),
    String(input.sequence),
  ].join('-');
}

/** Nombre legible del producto de catálogo que representa una bobina vendible (D-037). */
export function coilProductName(finishName: string, thicknessMm: DecimalInput): string {
  return `Bobina ${finishName} ${formatThickness(thicknessMm)} mm`;
}
