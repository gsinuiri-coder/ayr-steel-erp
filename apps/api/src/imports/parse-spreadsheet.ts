import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

/** Lee un xlsx/csv y devuelve sus filas como objetos {encabezado: valor}, sin encabezado. */
export function parseSpreadsheet(buffer: Buffer): Record<string, unknown>[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
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
