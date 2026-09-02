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
    workbook = isZip(buffer)
      ? XLSX.read(buffer, { type: 'buffer' })
      : XLSX.read(buffer.toString('utf8'), { type: 'string' });
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
