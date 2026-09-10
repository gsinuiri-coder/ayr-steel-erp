import { expect, type APIRequestContext } from '@playwright/test';

/**
 * El importador masivo de cotizaciones (D-152, D-157, D-158, D-169) visto desde afuera: armar
 * el archivo, previsualizarlo y confirmarlo.
 *
 * Vive acá y no dentro de un spec porque desde D-169 hay **dos** frentes que lo ejercitan —el
 * importe exacto del comprobante y la venta de una línea sin inventario— y las dos tienen que
 * mandar exactamente el mismo archivo que manda la pantalla. `import-cotizaciones.spec.ts`
 * conserva su copia local, más vieja que este helper.
 *
 * Se usa CSV y no xlsx a propósito, por el mismo motivo que el spec original: el endpoint
 * acepta los dos y `parseSpreadsheet` trata el csv como texto UTF-8, así que el archivo se arma
 * sin depender de ninguna librería.
 */

const HEADERS = [
  'F. EMISIÓN',
  'TIPO COMPROBANTE',
  'SERIE - NÚMERO',
  'CLIENTE',
  'MONEDA',
  'TIPOCAMBIO',
  'DOCUMENTO AJUSTADO',
  'CÓDIGO PRODUCTO',
  'NOMBRE PRODUCTO',
  'UNIDAD MEDIDA',
  'CANTIDAD',
  'VALOR DE VENTA',
] as const;

export interface SheetRow {
  issueDate: string;
  docType: string;
  documentKey: string;
  customer: string;
  currency?: string;
  exchangeRate?: string;
  adjusted?: string;
  sku: string;
  productName: string;
  unit: string;
  qty: string;
  /** «VALOR DE VENTA»: el **importe** de la línea, sin IGV. Es el dato que D-169 copia. */
  netAmount: string;
}

export function csvOf(rows: readonly SheetRow[]): string {
  const body = rows.map((r) =>
    [
      r.issueDate,
      r.docType,
      r.documentKey,
      r.customer,
      r.currency ?? 'Soles',
      r.exchangeRate ?? '',
      r.adjusted ?? '',
      r.sku,
      r.productName,
      r.unit,
      r.qty,
      r.netAmount,
    ].join(','),
  );
  return [HEADERS.join(','), ...body].join('\n');
}

export interface PreviewRow {
  rowNumber: number;
  documentKey: string;
  issueDate: string;
  customerId: string | null;
  productId: string | null;
  qty: string;
  unitPricePen: string;
  /** D-169: el importe del papel, ya en soles y sin IGV. Cadena vacía si la fila no lo pudo leer. */
  netAmountPen: string;
  rawSku: string;
  needsPieces: boolean;
  pieces?: { lengthMm: string; qty: number }[];
  description?: string;
  issues: { field: string; severity: 'error' | 'warning'; message: string }[];
  excludedReason: string | null;
}

export interface PreviewDto {
  fileName: string;
  rows: PreviewRow[];
  quotations: number;
  excluded: number;
  withIssues: number;
}

export async function previewImport(
  api: APIRequestContext,
  rows: readonly SheetRow[],
): Promise<PreviewDto> {
  const res = await api.post('/api/imports/quotations/preview', {
    multipart: {
      file: { name: 'ventas.csv', mimeType: 'text/csv', buffer: Buffer.from(csvOf(rows), 'utf8') },
    },
  });
  expect(res.ok(), `la previsualización falló: ${await res.text()}`).toBe(true);
  return (await res.json()) as PreviewDto;
}

/**
 * Lo que el navegador manda de vuelta por una fila que **no se tocó**: incluye el importe del
 * papel (D-169). Una fila editada viaja por `toEditedInput`, sin él.
 */
export function toInput(row: PreviewRow): Record<string, unknown> {
  return {
    rowNumber: row.rowNumber,
    documentKey: row.documentKey,
    issueDate: row.issueDate,
    customerId: row.customerId,
    productId: row.productId,
    qty: row.qty,
    unitPricePen: row.unitPricePen,
    ...(row.netAmountPen ? { netAmountPen: row.netAmountPen } : {}),
    ...(row.pieces ? { pieces: row.pieces } : {}),
  };
}

/**
 * D-169: la fila cuya cantidad o cuyo precio el usuario corrigió en el preview viaja **sin**
 * importe. Mandarlo igual haría que corregir un precio no cambiara el importe, y el rechazo por
 * tolerancia culparía al archivo de una diferencia que introdujo la corrección.
 */
export function toEditedInput(
  row: PreviewRow,
  edits: { qty?: string; unitPricePen?: string },
): Record<string, unknown> {
  const { netAmountPen: _dropped, ...rest } = toInput(row) as Record<string, unknown>;
  return { ...rest, ...edits };
}

export interface ImportResultDto {
  quotations: number;
  rows: number;
  codes: string[];
}

export async function commitImport(
  api: APIRequestContext,
  rows: readonly Record<string, unknown>[],
): Promise<ImportResultDto> {
  const res = await api.post('/api/imports/quotations', { data: { rows } });
  expect(res.ok(), `la importación falló: ${await res.text()}`).toBe(true);
  return (await res.json()) as ImportResultDto;
}

/** La confirmación que **debe** rebotar: devuelve el cuerpo crudo para leer `errors` por documento. */
export async function commitExpectingError(
  api: APIRequestContext,
  rows: readonly Record<string, unknown>[],
): Promise<{ status: number; body: string }> {
  const res = await api.post('/api/imports/quotations', { data: { rows } });
  expect(res.ok(), `la importación debía rebotar y devolvió ${res.status()}`).toBe(false);
  return { status: res.status(), body: await res.text() };
}

/** `20601234567 - RAZÓN SOCIAL`: el formato de la columna CLIENTE. Sin comas, que parten el CSV. */
export function customerCell(customer: { docNumber: string; name: string }): string {
  return `${customer.docNumber} - ${customer.name.replace(/,/g, ' ')}`;
}

/** Un número de comprobante único dentro de la corrida. */
export function documentKey(prefix = 'FFA1'): string {
  return `${prefix}-${String(Math.floor(Math.random() * 900000) + 100000)}`;
}
