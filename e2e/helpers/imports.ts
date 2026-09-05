import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Andamiaje de la importación masiva (RF-52) y, en particular, de la entidad
 * `FISCAL_DOCUMENTS` de la Fase 7c (RF-71, RF-72; D-105..D-109).
 *
 * Mismo criterio que `helpers/invoicing.ts`: la planilla, la subida y las tres llamadas del
 * ciclo —previsualizar, corregir, confirmar— viven acá para que el spec de flujo y el de
 * bordes armen **el mismo** archivo y lo lean igual.
 */

// ---------------------------------------------------------------------------
// DTOs mínimos del importador que consumen los tests
// ---------------------------------------------------------------------------

export type ImportRowStatus = 'VALID' | 'INVALID' | 'CONFIRMED';

export interface ImportRowDto {
  id: string;
  rowNumber: number;
  data: Record<string, unknown>;
  errors: string[] | null;
  /** RF-72: lo que hay que ver antes de confirmar y no bloquea la confirmación. */
  warnings: string[] | null;
  status: ImportRowStatus;
  createdEntityId: string | null;
}

export interface ImportBatchDto {
  id: string;
  entity: string;
  fileName: string;
  status: 'PARSED' | 'CONFIRMED';
  rows: ImportRowDto[];
}

// ---------------------------------------------------------------------------
// La planilla
// ---------------------------------------------------------------------------

/**
 * Encabezados de `FISCAL_DOCUMENTS`, en el mismo orden que `COLUMNS` del adaptador. Se
 * escriben acá **tal como los ve el usuario** (con tildes) a propósito: si alguien los
 * cambia en el API sin actualizar la UI, el test tiene que notarlo.
 */
export const FISCAL_IMPORT_HEADERS = [
  'Tipo (FACTURA/BOLETA/NOTA_CREDITO)',
  'Serie',
  'Correlativo',
  'Fecha de emisión',
  'Cliente (RUC/DNI)',
  'Condición de pago (CONTADO/CREDITO)',
  'Fecha de vencimiento',
  'Total del comprobante',
  'Documento afectado (NC)',
  'Motivo de la NC',
  'Notas',
  'SKU',
  'Descripción',
  'Cantidad',
  'Unidad',
  'Precio unitario sin IGV',
] as const;

export type FiscalImportHeader = (typeof FISCAL_IMPORT_HEADERS)[number];
/** Una fila de la planilla: encabezado → valor, todo texto, como en una hoja de cálculo. */
export type SheetRow = Record<string, string>;

/** Una línea del comprobante dentro de la planilla. */
export interface ImportedLineSpec {
  description?: string;
  qty: string;
  unitPricePen: string;
  unit?: string;
  sku?: string;
}

/** Un comprobante entero tal como se escribe en la planilla (cabecera + sus líneas). */
export interface ImportedDocSpec {
  docType?: 'FACTURA' | 'BOLETA' | 'NOTA_CREDITO';
  series: string;
  correlative: number | string;
  issueDate?: string;
  customerDocNumber: string;
  paymentTerms?: 'CONTADO' | 'CREDITO';
  dueDate?: string;
  /** El total **declarado** por el papel. Se escribe a mano: que cuadre es lo que se prueba. */
  totalPen: string;
  affectedNumber?: string;
  creditNoteReason?: string;
  notes?: string;
  lines: ImportedLineSpec[];
}

/**
 * Expande un comprobante a sus filas de planilla: **una fila por línea**, con la cabecera
 * repetida en todas (RF-71). Devolver filas sueltas y no el archivo permite que un test
 * rompa una sola celda —dos fechas de emisión distintas, un precio mal escrito— sin
 * duplicar el resto de la planilla.
 */
export function fiscalDocumentRows(spec: ImportedDocSpec): SheetRow[] {
  return spec.lines.map((line, i) => ({
    'Tipo (FACTURA/BOLETA/NOTA_CREDITO)': spec.docType ?? 'FACTURA',
    Serie: spec.series,
    Correlativo: String(spec.correlative),
    'Fecha de emisión': spec.issueDate ?? today(),
    'Cliente (RUC/DNI)': spec.customerDocNumber,
    'Condición de pago (CONTADO/CREDITO)': spec.paymentTerms ?? 'CONTADO',
    'Fecha de vencimiento': spec.dueDate ?? '',
    'Total del comprobante': spec.totalPen,
    'Documento afectado (NC)': spec.affectedNumber ?? '',
    'Motivo de la NC': spec.creditNoteReason ?? '',
    // Marca E2E en las notas: es lo que hace que la purga reconozca el documento aunque
    // salga a nombre de un cliente que ya existía (mismo criterio que la boleta de D-077).
    Notas: spec.notes ?? 'E2E importación de comprobantes',
    SKU: line.sku ?? '',
    Descripción: line.description ?? `E2E línea importada ${i + 1}`,
    Cantidad: line.qty,
    Unidad: line.unit ?? 'NIU',
    'Precio unitario sin IGV': line.unitPricePen,
  }));
}

export interface SpreadsheetFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface XlsxModule {
  utils: {
    aoa_to_sheet(rows: string[][]): unknown;
    book_new(): unknown;
    book_append_sheet(workbook: unknown, sheet: unknown, name: string): void;
  };
  write(workbook: unknown, options: { type: 'buffer'; bookType: 'xlsx' }): Buffer;
}

/**
 * El mismo `xlsx` que usa el API para leer la planilla, tomado de `apps/api` en vez de
 * agregarse como dependencia del repo raíz: escribir el archivo con otra librería habría
 * dejado la duda de si un fallo es del importador o del generador.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require(resolve(__dirname, '../../apps/api/node_modules/xlsx')) as XlsxModule;

/**
 * Convierte filas en un `.xlsx` con **todas las celdas de texto**.
 *
 * Que sean de texto no es un detalle de comodidad: hoy es la única forma de que una fecha
 * llegue al importador como `AAAA-MM-DD`. `parseSpreadsheet` lee el archivo sin
 * `cellDates`, así que una celda de fecha de Excel —y cualquier fecha de un `.csv`— llega
 * como el número de serie de la hoja (`2026-09-05` → `46270`) y el adaptador la rechaza
 * por formato. Está pinneado en `fase7c-bordes.spec.ts` («una planilla csv con la fecha…»),
 * que es el test que se pone verde el día que se arregle.
 */
export function spreadsheetOf(
  rows: SheetRow[],
  headers: readonly string[] = FISCAL_IMPORT_HEADERS,
  name = 'comprobantes.xlsx',
): SpreadsheetFile {
  const aoa: string[][] = [
    [...headers],
    ...rows.map((row) => headers.map((header) => row[header] ?? '')),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Hoja1');
  return {
    name,
    mimeType: XLSX_MIME,
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
  };
}

/** La misma planilla en `.csv`, que es como sale de cualquier sistema de facturación. */
export function csvOf(
  rows: SheetRow[],
  headers: readonly string[] = FISCAL_IMPORT_HEADERS,
  name = 'comprobantes.csv',
): SpreadsheetFile {
  const line = (cells: string[]): string =>
    cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
  const csv = [
    line([...headers]),
    ...rows.map((row) => line(headers.map((h) => row[h] ?? ''))),
  ].join('\n');
  return { name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') };
}

// ---------------------------------------------------------------------------
// Las tres llamadas del ciclo: previsualizar, corregir, confirmar
// ---------------------------------------------------------------------------

/** `POST /imports` (multipart). Devuelve el lote con sus filas, errores y avisos. */
export async function uploadImport(
  api: APIRequestContext,
  entity: string,
  file: SpreadsheetFile,
): Promise<ImportBatchDto> {
  const res = await api.post('/api/imports', {
    multipart: {
      entity,
      file: { name: file.name, mimeType: file.mimeType, buffer: file.buffer },
    },
  });
  if (!res.ok()) throw new Error(`POST /imports falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as ImportBatchDto;
}

/** Previsualiza un comprobante ya emitido: sube la planilla y **no** confirma nada. */
export function previewFiscalImport(
  api: APIRequestContext,
  rows: SheetRow[],
): Promise<ImportBatchDto> {
  return uploadImport(api, 'FISCAL_DOCUMENTS', spreadsheetOf(rows));
}

export async function getImportBatch(api: APIRequestContext, id: string): Promise<ImportBatchDto> {
  const res = await api.get(`/api/imports/${id}`);
  if (!res.ok()) throw new Error(`GET /imports/${id} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as ImportBatchDto;
}

/** `PATCH /imports/:id/rows/:rowId`: corrige una fila en la previsualización. */
export async function patchImportRow(
  api: APIRequestContext,
  batchId: string,
  rowId: string,
  data: Record<string, unknown>,
): Promise<ImportRowDto> {
  const res = await api.patch(`/api/imports/${batchId}/rows/${rowId}`, { data: { data } });
  if (!res.ok()) {
    throw new Error(
      `PATCH /imports/${batchId}/rows/${rowId} falló: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ImportRowDto;
}

export async function confirmImport(
  api: APIRequestContext,
  batchId: string,
): Promise<ImportBatchDto> {
  const res = await api.post(`/api/imports/${batchId}/confirm`);
  if (!res.ok()) {
    throw new Error(`POST /imports/${batchId}/confirm falló: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as ImportBatchDto;
}

// ---------------------------------------------------------------------------
// Lecturas cómodas sobre el lote
// ---------------------------------------------------------------------------

/** Todos los errores del lote en una sola lista: lo que el usuario ve en rojo. */
export function batchErrors(batch: ImportBatchDto): string[] {
  return batch.rows.flatMap((r) => r.errors ?? []);
}

/** Todos los avisos del lote: lo que el usuario ve en ámbar y no bloquea (RF-72). */
export function batchWarnings(batch: ImportBatchDto): string[] {
  return batch.rows.flatMap((r) => r.warnings ?? []);
}

export function rowStatuses(batch: ImportBatchDto): ImportRowStatus[] {
  return batch.rows.map((r) => r.status);
}

/** El id de la entidad creada por un lote agrupado: el comprobante, uno por grupo. */
export function createdEntityIds(batch: ImportBatchDto): string[] {
  return [...new Set(batch.rows.map((r) => r.createdEntityId).filter((id): id is string => !!id))];
}

// ---------------------------------------------------------------------------
// Numeración de prueba
// ---------------------------------------------------------------------------

const SERIES_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Serie de prueba para importar: `Z` + tres alfanuméricos al azar, que es el formato de
 * SUNAT. Empieza por `Z` —ninguna serie real usa esa letra— y **no existe** antes del
 * test, así que el importador la crea inactiva (D-106) y no empuja el correlativo de
 * ninguna serie con la que la empresa emita de verdad.
 */
export function importSeriesCode(): string {
  let out = 'Z';
  for (let i = 0; i < 3; i += 1) {
    out += SERIES_ALPHABET[Math.floor(Math.random() * SERIES_ALPHABET.length)];
  }
  return out;
}

/** Correlativo de prueba, alto y al azar: dos corridas no chocan por el mismo número. */
export function importCorrelative(): number {
  return 1000 + Math.floor(Math.random() * 89_000);
}

/** `ZQ7X`, `123` → `ZQ7X-00000123`. Mismo formato que `fiscalDocumentNumber` del API. */
export function documentNumber(series: string, correlative: number | string): string {
  return `${series}-${String(correlative).padStart(8, '0')}`;
}

/** Hoy en Lima, en `AAAA-MM-DD` (la fecha de negocio, no la de UTC). */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** `today()` desplazado N días; negativo hacia atrás. */
export function daysFromToday(days: number): string {
  const d = new Date(`${today()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Atajo: importar un comprobante y devolver el que quedó creado
// ---------------------------------------------------------------------------

export interface ImportedDocumentResult {
  batch: ImportBatchDto;
  documentId: string;
  number: string;
}

/**
 * Sube, comprueba que la previsualización no traiga errores y confirma. Es el andamiaje de
 * los tests que necesitan **tener** un comprobante importado para probar otra cosa —cobrarlo,
 * acreditarlo, reimportarlo—; el camino feliz completo se prueba por la UI, no con esto.
 */
export async function importDocument(
  api: APIRequestContext,
  spec: ImportedDocSpec,
): Promise<ImportedDocumentResult> {
  const rows = fiscalDocumentRows(spec);
  const preview = await previewFiscalImport(api, rows);
  expect(batchErrors(preview), 'la planilla de andamiaje tiene que entrar limpia').toEqual([]);
  const confirmed = await confirmImport(api, preview.id);
  const ids = createdEntityIds(confirmed);
  expect(ids, 'el grupo entero se confirma como un solo comprobante').toHaveLength(1);
  return {
    batch: confirmed,
    documentId: ids[0]!,
    number: documentNumber(spec.series, spec.correlative),
  };
}

// ---------------------------------------------------------------------------
// La reversa: anulación interna de un importado (Sesión M-4, D-110)
// ---------------------------------------------------------------------------

/**
 * `POST /invoicing/documents/:id/annul`: anula **por dentro** un comprobante importado.
 *
 * Devuelve la respuesta cruda y no el DTO a propósito. Media suite de M-4 se trata de
 * códigos —400 sobre un emitido acá, 409 sobre uno ya anulado, 403 para un vendedor— y un
 * helper que lanzara al no ser 2xx obligaría a cada uno de esos casos a envolverse en un
 * `try`, que es donde se pierde el código real.
 *
 * Vive acá, junto a la importación, por lo mismo que el servicio del API: la anulación
 * interna es la vuelta de RF-71 y solo tiene sentido sobre lo que RF-71 creó.
 */
export function annulImported(
  api: APIRequestContext,
  documentId: string,
  reason = 'Anulación interna de prueba E2E',
): Promise<APIResponse> {
  return api.post(`/api/invoicing/documents/${documentId}/annul`, { data: { reason } });
}

/**
 * Limpieza de `finally`: deja en cero lo que la suite importó.
 *
 * Antes de M-4 esto no se podía escribir —un importado no tenía camino de vuelta (D-105) y
 * la única opción era dejarlo vivo—, así que es la primera purga real de la Fase 7c. Revierte
 * primero los cobros vigentes, porque son el guardrail que bloquea la anulación, y nunca
 * lanza: un fallo limpiando no puede convertir un test verde en rojo.
 *
 * Lo que **no** deshace, porque no se puede: la serie `Z…` que la importación creó inactiva
 * (D-106) no tiene borrado, y la fila anulada se conserva a propósito (append-only, RF-95).
 */
export async function annulImportedTrail(
  api: APIRequestContext,
  documentIds: readonly string[],
  reason = 'Limpieza de prueba E2E',
): Promise<void> {
  for (const documentId of documentIds) {
    const document = await api
      .get(`/api/invoicing/documents/${documentId}`)
      .then((r) =>
        r.ok()
          ? (r.json() as Promise<{ payments: { id: string; reversedAt: string | null }[] }>)
          : null,
      )
      .catch(() => null);
    for (const payment of (document?.payments ?? []).filter((p) => p.reversedAt === null)) {
      await api
        .post(`/api/invoicing/documents/${documentId}/payments/${payment.id}/reverse`, {
          data: { reason },
        })
        .catch(() => undefined);
    }
    await annulImported(api, documentId, reason).catch(() => undefined);
  }
}
