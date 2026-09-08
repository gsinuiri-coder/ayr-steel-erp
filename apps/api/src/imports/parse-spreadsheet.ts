import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

/** Firma ZIP ("PK"): así arranca un .xlsx real. Un .csv es texto plano. */
function isZip(buffer: Buffer): boolean {
  return buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/** Lee un xlsx/csv y devuelve sus filas como objetos {encabezado: valor}, sin encabezado. */
export function parseSpreadsheet(buffer: Buffer): Record<string, unknown>[] {
  let workbook: XLSX.WorkBook;
  try {
    // XLSX.read en modo 'buffer' asume el codepage por defecto (no UTF-8) para CSV,
    // lo que rompe encabezados con tildes ("Línea"). Un .csv es texto: se decodifica
    // como UTF-8 primero y se lee en modo 'string', que sí respeta el texto real.
    //
    // `cellDates` es obligatorio desde RF-71, la primera entidad importable con columna de
    // fecha: sin él, SheetJS entrega el **número de serie** de Excel —`2026-09-05` llegaba
    // como `46270`— y toda fila con fecha quedaba inválida por formato. No es exclusivo del
    // xlsx: el lector de csv también reconoce la fecha y la convierte.
    //
    // **En un csv, en cambio, no se coacciona nada** (`raw: true`, D-152). Un csv es texto y
    // SheetJS adivina el formato de sus fechas leyéndolas como M/D/Y: `03/08/2026` —que en el
    // archivo del negocio es el 3 de agosto— entraba como el 8 de marzo, sin error y sin
    // ninguna señal, y el comprobante terminaba en el mes equivocado. Un xlsx no tiene ese
    // problema porque su celda de fecha ya es una fecha; una de texto llega como texto y la
    // interpreta quien conoce el formato del archivo, que es el importador y no el lector.
    workbook = isZip(buffer)
      ? XLSX.read(buffer, { type: 'buffer', cellDates: true })
      : XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true });
  } catch {
    throw new BadRequestException('No se pudo leer el archivo; solo se aceptan xlsx o csv');
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new BadRequestException('El archivo no tiene hojas');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rows.length === 0) throw new BadRequestException('El archivo no tiene filas de datos');
  if (rows.length > 2000) throw new BadRequestException('Máximo 2000 filas por importación');
  return rows;
}

// ---------------------------------------------------------------------------
// Lectura de celdas por encabezado (D-150)
// ---------------------------------------------------------------------------
//
// Estas cuatro funciones venían de `adapters/import-adapter.interface.ts`, que se fue con el
// módulo de importaciones. Se conservan porque no son del importador viejo: son la parte
// aburrida y ya probada de leer una planilla que un humano llenó —encabezados con tilde o sin
// ella, mayúsculas cualesquiera, fechas que SheetJS devuelve como `Date`— y cualquier
// importador que venga después vuelve a necesitarlas exactamente igual.

/** Una columna esperada de la planilla: su clave interna y el encabezado que trae el archivo. */
export interface ImportColumn {
  /** Clave interna, usada como campo de la fila normalizada (inglés, D-003 idioma de código). */
  key: string;
  /** Encabezado esperado en la planilla (español, coincide con la UI). */
  header: string;
  required: boolean;
}

// U+0300..U+036F: marcas diacríticas combinantes que deja `normalize('NFD')` (tildes, diéresis).
const COMBINING_DIACRITICS = new RegExp(`[\u0300-\u036f]`, 'g');

/** Normaliza un encabezado para comparar: sin tildes, minúsculas, sin espacios extra. */
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
 * el día anterior y el documento entraba fechado un día antes. En Cloud Run —UTC— las dos
 * formas coinciden, que es justo lo que habría hecho que el defecto no apareciera nunca en
 * producción y sí en la máquina de alguien.
 */
function toCalendarDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/**
 * Tope de lo que se lee de una celda.
 *
 * Una celda de Excel admite 32 767 caracteres y ningún dato de estos archivos se acerca: el
 * más largo es una descripción de 240. Sin tope pasaban dos cosas, las dos medidas: una
 * expresión regular con cuantificadores de espacio solapados tardaba **segundos** por fila
 * sobre una celda de relleno —y un regex no se interrumpe, así que el API entero se queda sin
 * atender—, y el valor entero terminaba interpolado en el mensaje de error que vuelve al
 * cliente. Recortar acá y no en cada lector es lo que hace que ninguno pueda olvidarse: el
 * dato completo sigue estando en el archivo guardado en storage, que es donde corresponde.
 */
const MAX_CELL_CHARS = 512;

/**
 * Lee una columna de una fila cruda, sea de la planilla recién subida (claves = encabezados
 * en español) o de una fila ya normalizada que el usuario editó (claves = `column.key`).
 */
export function getField(raw: Record<string, unknown>, column: ImportColumn): string {
  const byHeader = pickRawValue(raw, column.header);
  const value = byHeader !== undefined ? rawToString(byHeader) : rawToString(raw[column.key]);
  return value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value;
}
