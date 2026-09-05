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
    const options = { cellDates: true } as const;
    workbook = isZip(buffer)
      ? XLSX.read(buffer, { type: 'buffer', ...options })
      : XLSX.read(buffer.toString('utf8'), { type: 'string', ...options });
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
