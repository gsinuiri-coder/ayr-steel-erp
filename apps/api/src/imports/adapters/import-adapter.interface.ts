import type { Prisma } from '@prisma/client';
import type { ImportEntity } from '@ayr/shared';

export interface ImportColumn {
  /** Clave interna, usada como campo de `ImportRow.data` (inglés, D-003 idioma de código). */
  key: string;
  /** Encabezado esperado en la planilla (español, coincide con la UI). */
  header: string;
  required: boolean;
}

export interface RowValidation {
  /** Fila normalizada: mismas claves que `columns[].key`, valores ya listos para persistir. */
  data: Record<string, unknown>;
  errors: string[];
  /**
   * Lo que hay que saber antes de confirmar pero **no** impide confirmar (RF-72: "esta
   * fila va a archivar la versión anterior de F001-00000123"). Un error bloquea; un aviso
   * describe una consecuencia que el usuario tiene que poder ver venir.
   */
  warnings?: string[];
}

/** Errores y avisos que una validación de grupo agrega a una fila. */
export interface RowIssues {
  errors: string[];
  warnings: string[];
}

/**
 * Lo que comparten los dos tipos de adaptador: qué columnas espera la planilla y cómo se
 * valida **una** fila por su cuenta.
 */
interface BaseImportAdapter {
  entity: ImportEntity;
  columns: ImportColumn[];
  validateRow(raw: Record<string, unknown>): Promise<RowValidation>;
  /**
   * Clave de unicidad de una fila ya normalizada (p. ej. línea+SKU), para detectar
   * duplicados dentro del propio archivo (dos filas válidas contra la DB pero iguales
   * entre sí). `undefined` si la fila no tiene datos suficientes para calcularla.
   */
  dedupeKey(data: Record<string, unknown>): string | undefined;
}

/**
 * Adaptador de importación fila a fila (RF-52, RF-12): **una fila es una entidad**. Es el
 * caso de productos, clientes y bobinas.
 */
export interface RowImportAdapter extends BaseImportAdapter {
  /** Crea la entidad real dentro de la transacción de confirmación. Devuelve su id. */
  createEntity(
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>,
    actorId: string,
  ): Promise<string>;
}

/** Una fila del grupo tal como la ve `validateGroup`: ya normalizada y con sus errores. */
export interface GroupRow {
  data: Record<string, unknown>;
  errors: string[];
}

/**
 * Adaptador cuyas filas se **agrupan** (RF-71, D-107): N filas de la planilla forman una
 * sola entidad, y la planilla repite la cabecera en cada una. Es el caso del comprobante,
 * que tiene tantas filas como líneas.
 *
 * Aparece porque un comprobante no se puede validar línea por línea: que sus líneas sumen
 * su propio total, o que le falte una, solo se ve mirando el grupo entero. Y no se puede
 * crear a medias: o entran todas sus líneas o no entra el documento.
 */
export interface GroupedImportAdapter extends BaseImportAdapter {
  /**
   * Clave del grupo al que pertenece la fila ya normalizada (para el comprobante, su
   * número). `undefined` cuando a la fila le falta el dato con el que se agrupa: esas
   * filas no forman grupo y quedan inválidas por su propia validación.
   */
  groupKey(data: Record<string, unknown>): string | undefined;
  /**
   * Errores y avisos que **solo se ven mirando el grupo entero**. Devuelve, en el mismo
   * orden que recibió, lo que hay que agregarle a cada fila. Recibe los errores propios de
   * cada fila porque una línea rota invalida al documento completo, no solo a su renglón.
   */
  validateGroup(rows: GroupRow[]): Promise<RowIssues[]>;
  /** Crea la entidad del grupo entero, en una transacción. Devuelve su id. */
  createGroup(
    tx: Prisma.TransactionClient,
    rows: Record<string, unknown>[],
    actorId: string,
  ): Promise<string>;
}

export type ImportAdapter = RowImportAdapter | GroupedImportAdapter;

export function isGroupedAdapter(adapter: ImportAdapter): adapter is GroupedImportAdapter {
  return 'groupKey' in adapter;
}

/** Normaliza un encabezado para comparar: sin tildes, minúsculas, sin espacios extra. */
// U+0300..U+036F: marcas diacríticas combinantes que deja `normalize('NFD')` (tildes, diéresis).
const COMBINING_DIACRITICS = new RegExp(`[\\u0300-\\u036f]`, 'g');

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().normalize('NFD').replace(COMBINING_DIACRITICS, '');
}

/** Busca un valor en la fila cruda del xlsx/csv por encabezado, tolerante a tildes/mayúsculas. */
export function pickRawValue(raw: Record<string, unknown>, header: string): unknown {
  const target = normalizeHeader(header);
  for (const [key, value] of Object.entries(raw)) {
    if (normalizeHeader(key) === target) return value;
  }
  return undefined;
}

export function rawToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (value instanceof Date) return toCalendarDate(value);
  return '';
}

/**
 * Una celda de fecha es un **día calendario**, no un instante: `2026-09-05` en la planilla
 * tiene que salir `2026-09-05` en cualquier máquina.
 *
 * Por eso se formatea con las partes locales y no con `toISOString()`: SheetJS construye la
 * fecha en hora local (`cellDates`), así que en una zona al este de Greenwich el ISO caía en
 * el día anterior y el comprobante entraba fechado un día antes. En Cloud Run —UTC— las dos
 * formas coinciden, que es justo lo que habría hecho que el defecto no apareciera nunca en
 * producción y sí en la máquina de alguien.
 */
function toCalendarDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/**
 * Lee una columna de una fila cruda, sea de la planilla recién subida (claves =
 * encabezados en español) o de una fila ya normalizada que el usuario edita en el
 * preview (claves = `column.key` en inglés, D-003).
 */
export function getField(raw: Record<string, unknown>, column: ImportColumn): string {
  const byHeader = pickRawValue(raw, column.header);
  if (byHeader !== undefined) return rawToString(byHeader);
  return rawToString(raw[column.key]);
}
