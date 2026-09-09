import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { DocType, Prisma, QuotationStatus } from '@prisma/client';
import {
  Decimal,
  defaultRoofingPlan,
  importDocTypeOf,
  EXTERNAL_INVOICE_NOTES_PREFIX,
  MAX_PADRON_LOOKUPS,
  MAX_QUOTATION_IMPORT_ROWS,
  PADRON_LOOKUP_CONCURRENCY,
  QUOTATION_IMPORT_COLUMNS,
  QUOTATION_IMPORT_REQUIRED_COLUMNS,
  QUOTATION_IMPORT_UNITS,
  quotationCode,
  toDecimal,
  toFixedString,
  type ImportQuotationsInput,
  type QuotationImportIssueDto,
  type QuotationImportPadronDto,
  type QuotationImportPreviewDto,
  type QuotationImportResultDto,
  type QuotationImportRowDto,
  type QuotationImportRowInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { DocumentLookupService } from '../customers/document-lookup.service';
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
    private readonly customers: CustomersService,
    private readonly padron: DocumentLookupService,
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
        OR: keys.map((k) => ({ notes: { contains: `${EXTERNAL_INVOICE_NOTES_PREFIX}${k}` } })),
      },
      select: { notes: true },
    });
    const importedKeys = new Set(
      already.flatMap((q) =>
        keys.filter((k) => q.notes?.includes(`${EXTERNAL_INVOICE_NOTES_PREFIX}${k}`) === true),
      ),
    );

    // D-158: los documentos del papel que el maestro **no** tiene se consultan contra el
    // padrón, una vez cada uno. No crea nada: lo que devuelve es el nombre real que la
    // pantalla muestra en el badge "Nuevo — se creará desde padrón", para que quien revisa
    // decida sobre un dato verificado y no sobre la razón social del Excel.
    // Solo los que **faltan**: un documento con dos clientes activos (`unique: false`) no se
    // resuelve dando de alta un tercero, se resuelve eligiendo cuál de los dos es.
    const padron = await this.lookupPadron(docNumbers.filter((d) => byDoc.get(d) === undefined));

    const rows = raw.map((r, i) => this.toPreviewRow(r, i + 1, byDoc, bySku, importedKeys, padron));
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
    padronByDoc: ReadonlyMap<string, QuotationImportPadronDto>,
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
    // D-158: el padrón solo cuenta cuando el maestro no tiene a nadie con ese documento.
    const padron = (docNumber === null ? undefined : padronByDoc.get(docNumber)) ?? null;
    if (!customer && padron === null) {
      issues.push({
        field: 'customer',
        severity: 'error',
        message:
          customerMatch?.unique === false
            ? 'Hay más de un cliente activo con ese documento: elige cuál es.'
            : rawCustomer
              ? 'No hay ningún cliente activo con ese documento y el padrón no lo devolvió: elige uno o créalo con el botón de al lado.'
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
      padron,
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
  // D-158 — el padrón
  // -------------------------------------------------------------------------

  /**
   * Consulta el padrón por cada documento que el maestro no tiene, con tope y en paralelo
   * acotado. **Nunca lanza**: `DocumentLookupService` devuelve `found: false` cuando el token
   * no está configurado, cuando la API no responde o cuando el documento no existe, y esa
   * fila queda con su error de siempre.
   */
  private async lookupPadron(
    docNumbers: readonly string[],
  ): Promise<Map<string, QuotationImportPadronDto>> {
    const found = new Map<string, QuotationImportPadronDto>();
    // Un CE no está en ningún padrón consultable, y un número que no es ni RUC ni DNI no se
    // consulta: gastaría cuota para recibir un 404.
    const targets = docNumbers
      .map((docNumber) => ({ docNumber, docType: importDocTypeOf(docNumber) }))
      .filter((t): t is { docNumber: string; docType: 'RUC' | 'DNI' } => t.docType !== null)
      .slice(0, MAX_PADRON_LOOKUPS);
    if (targets.length === 0) return found;

    let next = 0;
    const workers = Array.from(
      { length: Math.min(PADRON_LOOKUP_CONCURRENCY, targets.length) },
      async () => {
        for (let i = next++; i < targets.length; i = next++) {
          const target = targets[i];
          if (!target) continue;
          const result = await this.padron.lookup(DocType[target.docType], target.docNumber);
          // **Nada se compone acá.** Si el padrón no devolvió nombre, no hay alta: inventar
          // uno con la razón social del Excel es la creación silenciosa que D-152 prohibió.
          if (!result.found || result.name === null) continue;
          found.set(target.docNumber, {
            docType: target.docType,
            docNumber: target.docNumber,
            name: result.name,
            address: result.address,
          });
        }
      },
    );
    await Promise.all(workers);
    return found;
  }

  /**
   * Da de alta los clientes que el archivo pidió crear desde el padrón (D-158).
   *
   * **Vuelve a consultar el padrón**, y el nombre que guarda es el que el padrón devuelve —no
   * el que trajo el navegador, que ni siquiera viaja—. Es lo que separa esta excepción de la
   * creación silenciosa de D-138: quién decide es una persona que vio el badge en el preview,
   * y qué se escribe lo decide SUNAT. Si el padrón no responde ahora, **no se importa nada**:
   * el archivo entero vuelve con el motivo, que es lo mismo que hace cualquier otro fallo.
   *
   * Las altas van **dentro** de la transacción del archivo, así que un documento que no entra
   * no deja clientes sueltos en el maestro.
   */
  private async resolvePadronRefs(
    refs: readonly { docType: 'RUC' | 'DNI'; docNumber: string }[],
  ): Promise<Map<string, QuotationImportPadronDto>> {
    // **Fuera de la transacción a propósito.** Son hasta 48 llamadas de 5 s cada una contra
    // un tercero; hacerlas con la transacción abierta retiene una conexión del pool durante
    // toda esa espera, y el archivo entero se juega contra el `timeout` de Prisma en vez de
    // contra sus propias reglas.
    const unique = new Map(refs.map((r) => [r.docNumber, r]));
    // El tope vive en `lookupPadron`, así que por encima de él los documentos sobrantes **no
    // se consultan**: sin este corte el archivo moría diciendo "el padrón no devolvió los
    // datos de X", que le atribuye al padrón un límite que es nuestro y manda a dar de alta a
    // mano un cliente que la consulta habría encontrado.
    if (unique.size > MAX_PADRON_LOOKUPS) {
      throw new BadRequestException(
        `El archivo pide crear ${String(unique.size)} clientes desde el padrón y el máximo por importación es ${String(MAX_PADRON_LOOKUPS)}: ` +
          'da de alta algunos en el maestro o parte el archivo',
      );
    }
    const found = await this.lookupPadron([...unique.keys()]);
    for (const [docNumber, ref] of unique) {
      if (!found.has(docNumber)) {
        throw new BadRequestException(
          `El padrón no devolvió los datos de ${ref.docType} ${docNumber}: da de alta ese cliente a mano y vuelve a importar`,
        );
      }
    }
    return found;
  }

  private async createFromPadron(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    resolved: ReadonlyMap<string, QuotationImportPadronDto>,
  ): Promise<{ byDoc: Map<string, string>; names: string[] }> {
    const byDoc = new Map<string, string>();
    const names: string[] = [];
    for (const [docNumber, data] of resolved) {
      // **Se busca por el par único de la tabla, `(doc_type, doc_number)`, sin filtrar por
      // activo.** Filtrar por `isActive` acá era mirar por una puerta distinta de la que
      // valida Postgres: un cliente **desactivado** con ese RUC no aparecía ni en el preview
      // (que solo trae activos) ni en esta búsqueda, el padrón sí lo devolvía, y el alta
      // chocaba contra el índice único con un `P2002` que nadie traduce —esto corre antes del
      // bucle de savepoints, o sea fuera del `try` que atribuye errores por documento—, así
      // que el archivo entero volvía como un 500 de Prisma.
      const existing = await tx.customer.findUnique({
        where: { docType_docNumber: { docType: DocType[data.docType], docNumber } },
        select: { id: true, name: true, isActive: true },
      });
      if (existing) {
        // Reactivarlo por su cuenta sería devolver al maestro a alguien que un administrador
        // dio de baja, y en silencio: se dice y se corta.
        if (!existing.isActive) {
          throw new BadRequestException(
            `${data.docType} ${docNumber} (${existing.name}) ya existe en el maestro pero está desactivado: reactívalo o elige otro cliente para ese comprobante`,
          );
        }
        byDoc.set(docNumber, existing.id);
        continue;
      }
      try {
        const created = await this.customers.createInTx(tx, actor, {
          docType: DocType[data.docType],
          docNumber,
          name: data.name,
          address: data.address,
          email: null,
          phone: null,
          // Al contado: los días de crédito son una condición comercial que el padrón no dice
          // y que el importador no puede adivinar (D-076).
          creditDays: 0,
        });
        byDoc.set(docNumber, created.id);
        names.push(`${docNumber} — ${data.name}`);
      } catch (err) {
        // Dos importaciones simultáneas con el mismo RUC nuevo: la lectura de arriba no
        // encontró nada en ninguna de las dos y el índice único rechaza a la segunda. Sin
        // esto, ese `P2002` sube sin traducir —estamos fuera del bucle de savepoints, que es
        // el único lugar que atribuye errores a un documento— y el archivo vuelve como 500.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002')
          throw err;
        throw new BadRequestException(
          `${data.docType} ${docNumber} se dio de alta mientras se importaba este archivo: vuelve a subirlo y esa fila se resolverá sola`,
        );
      }
    }
    return { byDoc, names };
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
    // D-158: el padrón se consulta **antes** de abrir la transacción, y si falta uno solo no
    // se importa nada. Es el mismo todo-o-nada del archivo: quien revisó 141 filas no puede
    // descubrir de a un cliente por intento que el padrón está caído.
    // Solo las filas que **no** tienen cliente elegido: el schema ya rechaza las que traen los
    // dos, y el `customerId === null` de acá es la segunda cerradura sobre lo mismo — dar de
    // alta al cliente del padrón de una fila que terminó usando otro deja en el maestro un
    // registro que nadie pidió.
    const resolvedPadron = await this.resolvePadronRefs(
      input.rows.flatMap((r) => (r.customerId === null && r.newCustomer ? [r.newCustomer] : [])),
    );

    return this.prisma.$transaction(
      async (tx) => {
        const failures: Record<string, string[]> = {};
        const codes: string[] = [];
        const { byDoc: padronCustomers, names: createdCustomers } = await this.createFromPadron(
          tx,
          actor,
          resolvedPadron,
        );
        const customerIdOf = (row: QuotationImportRowInput): string | null =>
          row.customerId ??
          (row.newCustomer ? (padronCustomers.get(row.newCustomer.docNumber) ?? null) : null);

        for (const [index, [documentKey, rows]] of [...groups.entries()].entries()) {
          const savepoint = `cotizacion_${String(index)}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            const first = rows[0];
            if (!first) throw new BadRequestException('Documento sin líneas');
            const customerId = customerIdOf(first);
            if (customerId === null) {
              throw new BadRequestException(
                'Este documento no tiene cliente: elígelo o créalo antes de importar.',
              );
            }
            if (rows.some((r) => customerIdOf(r) !== customerId)) {
              throw new BadRequestException(
                'Las líneas de este documento apuntan a clientes distintos: una cotización es de un solo cliente.',
              );
            }
            if (rows.some((r) => r.issueDate !== first.issueDate)) {
              throw new BadRequestException(
                'Las líneas de este documento traen fechas de emisión distintas.',
              );
            }

            const id = await this.quotations.createInTx(
              tx,
              actor,
              {
                customerId,
                issueDate: first.issueDate,
                // D-157: **sin vencimiento**. Una cotización importada nace de un comprobante
                // que ya se vendió: no hay vigencia que respetar, y las dos alternativas eran
                // peores — inventar una fecha, o darle los 7 días por defecto sobre una emisión
                // de agosto y crear 71 cotizaciones que nacen vencidas y que ninguna validación
                // deja confirmar.
                validityDays: null,
                // D-152: el número del comprobante externo viaja a las observaciones con un
                // formato reconocible, para que la venta que se registre después pueda decir de
                // qué papel salió sin que haga falta una columna nueva en el modelo.
                notes: `${EXTERNAL_INVOICE_NOTES_PREFIX}${documentKey}`,
                items: rows.map((r) => ({
                  productId: r.productId,
                  qty: r.qty,
                  unitPricePen: r.unitPricePen,
                  ...(r.description ? { description: r.description } : {}),
                  ...(r.pieces ? { pieces: r.pieces } : {}),
                })),
              },
              {
                // D-163: **sin piso de precio**. Estos documentos ya se vendieron, a los
                // precios a los que se vendieron; el margen mínimo de hoy es una política
                // comercial hacia adelante y aplicarla hacia atrás dejaría agosto sin cargar.
                // Es la misma razón por la que la cotización importada no vence (D-157): lo que
                // entra por acá es un hecho consumado, no una oferta.
                enforcePriceFloor: false,
              },
            );
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

        return { quotations: groups.size, rows: input.rows.length, codes, createdCustomers };
      },
      // Hasta `MAX_QUOTATION_IMPORT_ROWS` líneas repartidas en sus documentos, cada uno con su
      // alta completa. Es el presupuesto de una carga mensual entera, no el de un formulario.
      { timeout: 300_000, maxWait: 20_000 },
    );
  }
}

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
