import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { QuotationStatus } from '@prisma/client';
import {
  Decimal,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  defaultRoofingPlan,
  MAX_QUOTATION_IMPORT_ROWS,
  QUOTATION_IMPORT_COLUMNS,
  QUOTATION_IMPORT_REQUIRED_COLUMNS,
  QUOTATION_IMPORT_UNITS,
  quotationCode,
  toDecimal,
  toFixedString,
  type ImportQuotationsInput,
  type QuotationImportIssueDto,
  type QuotationImportPreviewDto,
  type QuotationImportResultDto,
  type QuotationImportRowDto,
  type QuotationImportRowInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { sellsByLength } from '../sales/sales-lines';
import { QuotationsService } from '../sales/quotations.service';
import { getField, parseSpreadsheet, type ImportColumn } from './parse-spreadsheet';

/**
 * Importador masivo de cotizaciones (D-152).
 *
 * Dos pasos y **ningún estado en la base entre uno y otro**: `preview` lee el archivo, resuelve
 * lo que puede contra el maestro y devuelve las filas; el navegador las muestra, las deja
 * editar y las manda de vuelta a `confirm`. No hay lote, ni filas persistidas, ni un archivo
 * guardado esperando confirmación — que es la mitad de la maquinaria que D-150 borró y la que
 * hacía falta mantener sincronizada con el dominio.
 *
 * `confirm` no escribe cotizaciones a mano: llama a `QuotationsService.createInTx`, la misma
 * que el formulario. Todo lo que el alta valida —producto activo, precio, subítems que suman
 * la cantidad de la línea— lo valida igual acá, porque es literalmente el mismo código.
 */
@Injectable()
export class QuotationImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotations: QuotationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Paso 1 — leer el archivo y resolver lo que se pueda
  // -------------------------------------------------------------------------

  async preview(fileName: string, buffer: Buffer): Promise<QuotationImportPreviewDto> {
    const raw = parseSpreadsheet(buffer);
    if (raw.length === 0) throw new BadRequestException('El archivo no tiene ninguna fila');
    if (raw.length > MAX_QUOTATION_IMPORT_ROWS) {
      throw new BadRequestException(
        `El archivo tiene ${String(raw.length)} filas y el máximo es ${String(MAX_QUOTATION_IMPORT_ROWS)}`,
      );
    }
    assertColumns(raw[0] ?? {});

    // Un solo viaje por maestro para todo el archivo: resolver cliente y producto fila por
    // fila serían 282 consultas para 141 líneas.
    const docNumbers = [...new Set(raw.map((r) => customerDocOf(field(r, 'customer'))))].filter(
      (v) => v !== null,
    );
    const skus = [...new Set(raw.map((r) => field(r, 'sku')))].filter((v) => v !== '');
    const [customers, products] = await Promise.all([
      this.prisma.customer.findMany({
        where: { docNumber: { in: docNumbers }, isActive: true },
        select: { id: true, docNumber: true, name: true },
      }),
      this.prisma.product.findMany({
        where: { sku: { in: skus }, isActive: true },
        select: { id: true, sku: true, name: true, unit: true, roofingKind: true },
      }),
    ]);
    // **Un SKU repetido no se resuelve solo.** El índice único del catálogo es
    // `(business_line_id, sku)`, así que el mismo código puede existir en dos líneas de
    // negocio; quedarse con el último del `Map` mapea la fila al producto equivocado —otra
    // línea, otro precio de lista, otra rama de reserva— y en silencio. Lo mismo con el
    // documento del cliente, cuyo par único es `(doc_type, doc_number)`.
    const bySku = uniqueBy(products, (p) => p.sku);
    const byDoc = uniqueBy(customers, (c) => c.docNumber);

    // **Aviso de reimportación.** Nada impide subir el mismo archivo dos veces, y el
    // resultado serían 71 cotizaciones duplicadas sin una sola señal. El dato para detectarlo
    // ya existe: la nota que el importador escribe. Es un aviso y no un error porque un
    // comprobante puede legítimamente re-cotizarse (el anterior quedó anulado, por ejemplo).
    const keys = [...new Set(raw.map((r) => field(r, 'documentKey')).filter((k) => k !== ''))];
    const already = await this.prisma.quotation.findMany({
      where: {
        status: { not: QuotationStatus.CANCELLED },
        OR: keys.map((k) => ({ notes: { contains: `${NOTES_PREFIX}${k}` } })),
      },
      select: { notes: true },
    });
    const importedKeys = new Set(
      already.flatMap((q) => keys.filter((k) => q.notes?.includes(`${NOTES_PREFIX}${k}`) === true)),
    );

    const rows = raw.map((r, i) => this.toPreviewRow(r, i + 1, byDoc, bySku, importedKeys));
    const importable = rows.filter((r) => r.excludedReason === null);
    return {
      fileName,
      rows,
      quotations: new Set(importable.map((r) => r.documentKey)).size,
      excluded: rows.length - importable.length,
      withIssues: importable.filter((r) => r.issues.length > 0).length,
    };
  }

  private toPreviewRow(
    raw: Record<string, unknown>,
    rowNumber: number,
    byDoc: Map<string, Match<{ id: string; docNumber: string; name: string }>>,
    bySku: Map<string, Match<{ id: string; sku: string; name: string; unit: string }>>,
    importedKeys: ReadonlySet<string>,
  ): QuotationImportRowDto {
    const rawCustomer = field(raw, 'customer');
    const rawSku = field(raw, 'sku');
    const issues: QuotationImportIssueDto[] = [];

    // Lo que no es una venta no entra, y se dice por qué en vez de desaparecer del preview.
    // Una nota de crédito no trae a qué comprobante afecta ni con qué motivo del catálogo 09
    // (misma razón que D-138), y una fila con documento ajustado ya es el reverso de otra.
    const docType = field(raw, 'docType');
    const adjusted = field(raw, 'adjustedDocument');
    const excludedReason =
      /nota/i.test(docType) || adjusted !== ''
        ? `${docType || 'La fila'} no se importa: es un ajuste de otro comprobante, y el archivo no dice a cuál ni por qué motivo.`
        : null;

    if (importedKeys.has(field(raw, 'documentKey'))) {
      issues.push({
        field: 'row',
        severity: 'warning',
        message:
          'Ya existe una cotización viva con este comprobante: importarlo otra vez la duplica.',
      });
    }

    const docNumber = customerDocOf(rawCustomer);
    const customerMatch = docNumber === null ? undefined : byDoc.get(docNumber);
    const customer = customerMatch?.unique === true ? customerMatch.value : null;
    if (!customer) {
      issues.push({
        field: 'customer',
        severity: 'error',
        message:
          customerMatch?.unique === false
            ? 'Hay más de un cliente activo con ese documento: elige cuál es.'
            : rawCustomer
              ? 'No hay ningún cliente activo con ese documento: créalo en el maestro y vuelve a subir el archivo.'
              : 'La fila no trae cliente.',
      });
    }

    const productMatch = bySku.get(rawSku);
    const product = productMatch?.unique === true ? productMatch.value : null;
    if (!product) {
      issues.push({
        field: 'product',
        severity: 'error',
        message:
          productMatch?.unique === false
            ? `El código ${rawSku} existe en más de una línea de negocio: elige el producto.`
            : rawSku
              ? `El SKU ${rawSku} no está en el catálogo: créalo en el maestro y vuelve a subir el archivo.`
              : 'La fila no trae código de producto.',
      });
    }

    const qty = parseAmount(field(raw, 'qty'));
    if (qty?.gt(0) !== true) {
      issues.push({
        field: 'qty',
        severity: 'error',
        message: 'La cantidad no es un número mayor a cero.',
      });
    }

    // El archivo no trae precio unitario: trae el valor de venta (sin IGV) de la línea. El
    // unitario sale de dividirlo entre la cantidad, con `Decimal` y a escala de dinero.
    const net = parseAmount(field(raw, 'netAmount'));
    const currency = field(raw, 'currency');
    const exchangeRate = parseAmount(field(raw, 'exchangeRate'));
    let unitPricePen: Decimal | null = null;
    if (net?.gt(0) !== true) {
      issues.push({
        field: 'unitPrice',
        severity: 'error',
        message: 'El valor de venta no es un número mayor a cero.',
      });
    } else if (qty?.gt(0) === true) {
      // Un documento en dólares se lleva a soles con **su propio** tipo de cambio, el que el
      // archivo trae: el kardex y las cotizaciones van en soles (D-042/D-064), y usar el TC de
      // hoy para una venta de agosto sería inventar una cifra que el papel ya fijó.
      const isForeign = /d[óo]lar/i.test(currency);
      if (isForeign && exchangeRate?.gt(0) !== true) {
        issues.push({
          field: 'unitPrice',
          severity: 'error',
          message: 'El documento está en dólares y la fila no trae tipo de cambio.',
        });
      } else {
        const netPen = isForeign && exchangeRate ? net.times(exchangeRate) : net;
        unitPricePen = netPen.div(qty);
      }
    }

    // **La unidad, no el subtipo.** Quien exige los largos es `sellsByLength` de
    // `sales-lines.ts` (`unit === 'MTR'`), y es la distinción exacta de D-131: preguntar por el
    // subtipo respondía otra cosa. Un SKU en `MTR` que no sea `A_MEDIDA` pasaba el preview sin
    // una sola marca, la pantalla ni siquiera dibujaba la celda del plan, y el archivo entero
    // moría en el confirm con "se vende por metro lineal" y sin forma de arreglarlo.
    const needsPieces = product !== null && sellsByLength(product);
    // El plan sale de la cantidad **ya redondeada**, que es la que viaja en la fila: el
    // archivo trae diez decimales y el alta exige que los largos sumen exactamente la cantidad
    // de la línea (D-083). Derivarlo del valor sin redondear dejaba las dos cifras separadas
    // por milésimas y el documento entero se caía en el confirm.
    const roundedQty = qty === null ? null : toDecimal(toFixedString(qty, 'KG'));
    let pieces: { lengthMm: string; qty: number }[] | undefined;
    if (needsPieces && roundedQty?.gt(0) === true) {
      const plan = defaultRoofingPlan(roundedQty);
      if (plan.ok === true) pieces = plan.pieces;
      else if (plan.ok === false) {
        issues.push({ field: 'pieces', severity: 'error', message: plan.reason });
      }
    }

    // Un aviso, no un error: la unidad del papel es informativa y la que manda es la del
    // producto. Que no coincidan casi siempre significa que el SKU se mapeó al producto
    // equivocado, y eso vale la pena verlo antes de crear 71 cotizaciones.
    const rawUnit = field(raw, 'unit');
    const expected = QUOTATION_IMPORT_UNITS[rawUnit.toUpperCase()];
    if (product && expected !== undefined && expected !== product.unit) {
      issues.push({
        field: 'product',
        // Aviso y no error: la unidad que manda es la del producto, y el API acepta la línea
        // igual. Lo que hay que ver antes de crear 71 cotizaciones es si el SKU se mapeó al
        // producto equivocado, no impedir la carga.
        severity: 'warning',
        message: `El archivo dice ${rawUnit} y ${product.sku} se vende en ${product.unit}: revisa que sea el producto correcto.`,
      });
    }

    return {
      rowNumber,
      documentKey: field(raw, 'documentKey'),
      issueDate: parseIssueDate(field(raw, 'issueDate')) ?? '',
      customerId: customer?.id ?? null,
      productId: product?.id ?? null,
      qty: roundedQty === null ? '' : toFixedString(roundedQty, 'KG'),
      unitPricePen: unitPricePen === null ? '' : toFixedString(unitPricePen, 'MONEY'),
      // El lector recorta a 512 y el schema del confirm topa en 240: sin este recorte, un
      // nombre largo tumbaba el archivo entero con un error de Zod que la pantalla no sabe
      // atribuir a ninguna fila.
      description: field(raw, 'productName').slice(0, 240) || undefined,
      pieces,
      rawCustomer,
      rawSku,
      rawProductName: field(raw, 'productName'),
      rawUnit,
      customerName: customer?.name ?? null,
      productSku: product?.sku ?? null,
      productName: product?.name ?? null,
      productUnit: product?.unit ?? null,
      needsPieces,
      currency,
      exchangeRate: exchangeRate === null ? null : toFixedString(exchangeRate, 'RATE'),
      issues: parseIssueDate(field(raw, 'issueDate'))
        ? issues
        : [
            ...issues,
            {
              field: 'row' as const,
              severity: 'error' as const,
              message: 'La fecha de emisión no se pudo leer.',
            },
          ],
      excludedReason,
    };
  }

  // -------------------------------------------------------------------------
  // Paso 2 — confirmar: una transacción, todo o nada
  // -------------------------------------------------------------------------

  /**
   * Crea una cotización **en borrador** por cada documento del archivo (D-152).
   *
   * Todo o nada, con un `SAVEPOINT` por documento y el error de cada uno: el mismo patrón que
   * la tanda de planta (D-147) y por el mismo motivo — quien revisó 141 filas necesita
   * corregirlas de una vez, y las escrituras que una cotización fallida alcanzó a hacer no
   * pueden ensuciar la validación de la siguiente.
   */
  async confirm(
    actor: RequestUser,
    input: ImportQuotationsInput,
  ): Promise<QuotationImportResultDto> {
    const groups = groupByDocument(input.rows);

    return this.prisma.$transaction(
      async (tx) => {
        const failures: Record<string, string[]> = {};
        const codes: string[] = [];

        for (const [index, [documentKey, rows]] of [...groups.entries()].entries()) {
          const savepoint = `cotizacion_${String(index)}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            const first = rows[0];
            if (!first) throw new BadRequestException('Documento sin líneas');
            const customerId = first.customerId;
            if (rows.some((r) => r.customerId !== customerId)) {
              throw new BadRequestException(
                'Las líneas de este documento apuntan a clientes distintos: una cotización es de un solo cliente.',
              );
            }
            if (rows.some((r) => r.issueDate !== first.issueDate)) {
              throw new BadRequestException(
                'Las líneas de este documento traen fechas de emisión distintas.',
              );
            }

            const id = await this.quotations.createInTx(tx, actor, {
              customerId,
              issueDate: first.issueDate,
              // El default del schema, explícito acá: `createInTx` recibe el input ya parseado y
              // los `.default()` de Zod no se aplican a un objeto construido a mano.
              validityDays: DEFAULT_QUOTATION_VALIDITY_DAYS,
              // D-152: el número del comprobante externo viaja a las observaciones con un
              // formato reconocible, para que la venta que se registre después pueda decir de
              // qué papel salió sin que haga falta una columna nueva en el modelo.
              notes: `${NOTES_PREFIX}${documentKey}`,
              items: rows.map((r) => ({
                productId: r.productId,
                qty: r.qty,
                unitPricePen: r.unitPricePen,
                ...(r.description ? { description: r.description } : {}),
                ...(r.pieces ? { pieces: r.pieces } : {}),
              })),
            });
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
            const created = await tx.quotation.findUniqueOrThrow({
              where: { id },
              select: { seq: true },
            });
            codes.push(quotationCode(created.seq));
          } catch (err) {
            // Un error que no es de dominio (deadlock, constraint) corta en el acto: la
            // transacción quedó abortada y seguir juntando errores sería inventarlos.
            if (!(err instanceof HttpException)) throw err;
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            failures[documentKey] = [messageOf(err)];
          }
        }

        if (Object.keys(failures).length > 0) {
          throw new BadRequestException({
            statusCode: 400,
            message:
              `${String(Object.keys(failures).length)} de ${String(groups.size)} documentos no entraron: ` +
              'no se importó ninguno, corrígelos y vuelve a enviar',
            errors: failures,
          });
        }

        return { quotations: groups.size, rows: input.rows.length, codes };
      },
      // Hasta `MAX_QUOTATION_IMPORT_ROWS` líneas repartidas en sus documentos, cada uno con su
      // alta completa. Es el presupuesto de una carga mensual entera, no el de un formulario.
      { timeout: 300_000, maxWait: 20_000 },
    );
  }
}

/**
 * El prefijo con el que el número del comprobante externo viaja a las observaciones. Está en
 * una constante porque se **escribe** al confirmar y se **busca** en el preview para avisar de
 * una reimportación: dos literales separados dejarían el aviso mudo sin que nadie lo note.
 */
const NOTES_PREFIX = 'Factura externa: ';

// ---------------------------------------------------------------------------
// Lectura del archivo
// ---------------------------------------------------------------------------

const COLUMNS: Record<keyof typeof QUOTATION_IMPORT_COLUMNS, ImportColumn> = Object.fromEntries(
  Object.entries(QUOTATION_IMPORT_COLUMNS).map(([key, header]) => [
    key,
    { key, header, required: QUOTATION_IMPORT_REQUIRED_COLUMNS.includes(header) },
  ]),
) as Record<keyof typeof QUOTATION_IMPORT_COLUMNS, ImportColumn>;

function field(raw: Record<string, unknown>, key: keyof typeof QUOTATION_IMPORT_COLUMNS): string {
  return getField(raw, COLUMNS[key]);
}

/** Corta antes de leer nada cuando el archivo no es este archivo. */
function assertColumns(first: Record<string, unknown>): void {
  const missing = Object.values(COLUMNS)
    .filter((c) => c.required && getField(first, c) === '' && !hasHeader(first, c.header))
    .map((c) => c.header);
  if (missing.length > 0) {
    throw new BadRequestException(
      `El archivo no tiene ${missing.length === 1 ? 'la columna' : 'las columnas'} ${missing.join(', ')}. ` +
        'Tiene que ser el export de ventas detalladas, sin cambiarle los encabezados.',
    );
  }
}

function hasHeader(raw: Record<string, unknown>, header: string): boolean {
  const target = header.trim().toLowerCase();
  return Object.keys(raw).some((k) => k.trim().toLowerCase() === target);
}

/**
 * `20606364335 - PROYECTOS R&B SERVICIOS GENERALES S.A.C.` → `20606364335`.
 *
 * El archivo mete documento y razón social en una sola celda. Se corta por el documento —11
 * dígitos de RUC u 8 de DNI— y **no** por la razón social: el nombre del papel y el del
 * maestro casi nunca coinciden carácter por carácter, y el documento sí es exacto.
 */
function customerDocOf(value: string): string | null {
  const match = /^(\d{8,11})\s*-/.exec(value.trim());
  return match?.[1] ?? null;
}

/** `03/08/2026` → `2026-08-03`. También acepta la fecha ya en ISO. */
function parseIssueDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return null;
  const [, day = '', month = '', year = ''] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // `2026-02-31` pasa el patrón y no existe: se comprueba contra el calendario real.
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * `81.9000000000` → `Decimal`, con `Decimal` y nunca con `number` (regla dura 1): estas
 * celdas son cantidades y dinero, y el archivo las trae con diez decimales.
 */
function parseAmount(value: string): Decimal | null {
  const trimmed = value.trim().replace(/\s/g, '');
  if (trimmed === '' || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    return toDecimal(trimmed);
  } catch {
    return null;
  }
}

/** Agrupa por `SERIE - NÚMERO` conservando el orden en que aparecen en el archivo. */
function groupByDocument(
  rows: readonly QuotationImportRowInput[],
): Map<string, QuotationImportRowInput[]> {
  const groups = new Map<string, QuotationImportRowInput[]>();
  for (const row of rows) {
    const key = row.documentKey.trim();
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/**
 * El texto que un error de dominio le deja al documento. El cuerpo de un `HttpException` de
 * Nest es una cadena o un objeto con `message`, y sin esto el mapa de fallas guardaba
 * `[object Object]` justo en el caso que la pantalla necesita leer.
 */
function messageOf(err: HttpException): string {
  const body: unknown = err.getResponse();
  if (typeof body === 'string') return body;
  if (body === null || typeof body !== 'object') return err.message;
  const message: unknown = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join(', ');
  return err.message;
}

/**
 * Indexa por clave **distinguiendo el duplicado de la ausencia**.
 *
 * Un `new Map(rows.map(r => [key(r), r]))` se queda con el último y no lo dice: la fila queda
 * resuelta al registro equivocado y nadie se entera. Acá un duplicado devuelve
 * `{ unique: false }`, que el preview convierte en un error de fila y obliga a elegir a mano.
 */
function uniqueBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, Match<T>> {
  const index = new Map<string, Match<T>>();
  for (const row of rows) {
    const k = key(row);
    index.set(k, index.has(k) ? { unique: false } : { unique: true, value: row });
  }
  return index;
}

type Match<T> = { unique: true; value: T } | { unique: false };
