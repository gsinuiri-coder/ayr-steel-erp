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
}

/**
 * Adaptador de importación (RF-52, base reutilizable de RF-12/RF-71): cada entidad
 * importable define sus columnas, cómo validar una fila y cómo crear el registro real.
 */
export interface ImportAdapter {
  entity: ImportEntity;
  columns: ImportColumn[];
  validateRow(raw: Record<string, unknown>): Promise<RowValidation>;
  /** Crea la entidad real dentro de la transacción de confirmación. Devuelve su id. */
  createEntity(
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>,
    actorId: string,
  ): Promise<string>;
  /**
   * Clave de unicidad de una fila ya normalizada (p. ej. línea+SKU), para detectar
   * duplicados dentro del propio archivo (dos filas válidas contra la DB pero iguales
   * entre sí). `undefined` si la fila no tiene datos suficientes para calcularla.
   */
  dedupeKey(data: Record<string, unknown>): string | undefined;
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
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return '';
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
