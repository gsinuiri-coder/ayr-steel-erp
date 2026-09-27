import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DocType,
  InventoryRefType,
  Prisma,
  PurchaseStatus,
  type ExchangeRateSource,
} from '@prisma/client';
import {
  businessToday,
  currencyOf,
  MAX_PADRON_LOOKUPS,
  PADRON_LOOKUP_CONCURRENCY,
  Role,
  suggestSupplierCode,
  type ConfirmPurchaseImportInput,
  type PurchaseImportDocumentDto,
  type PurchaseImportDocumentInput,
  type PurchaseImportIssueDto,
  type PurchaseImportPreviewDto,
  type PurchaseImportResultDto,
  type PurchaseImportUndoResultDto,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toSharedLineCode } from '../common/business-line-code';
import { claimIdempotencyKey } from '../common/idempotency';
import { OperationDateService } from '../common/operation-date.service';
import { DocumentLookupService } from '../customers/document-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { parseSpreadsheet } from './parse-spreadsheet';
import { parsePurchaseRows } from './purchase-import-parse';
import {
  livePurchaseKey,
  validateDocument,
  type FinishRef,
  type ProductRef,
  type PurchaseImportContext,
  type SupplierRef,
  type ValidatedDocument,
} from './purchase-import-validate';
import { initialLoadReferencesOf } from './purchase-import-initial-load';

/**
 * **Importador masivo de compras (D-351): excepción explícita y acotada a D-150.**
 *
 * Mismo esquema que el de cotizaciones (D-152): `preview` lee el archivo y no guarda nada;
 * `validate` revisa lo editado en pantalla con la misma regla; `confirm` crea cada compra **en
 * BORRADOR** por `PurchasesService.createInTx` —hereda sus validaciones, no las copia—, con un
 * `SAVEPOINT` por comprobante, todo o nada, e idempotente (D-182). Recibir (lo que crea bobinas y
 * mueve el kardex) sigue siendo el paso aparte de siempre. El proveedor que falta se crea desde
 * el padrón, a la vista y en la misma transacción (D-158); el acabado y el producto no se crean
 * nunca desde acá.
 */
/** Scope de la clave de idempotencia de la confirmación (D-182). */
const IDEMPOTENCY_SCOPE = 'purchase-import:confirm';

@Injectable()
export class PurchaseImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchases: PurchasesService,
    private readonly suppliers: SuppliersService,
    private readonly padron: DocumentLookupService,
    private readonly operationDate: OperationDateService,
    private readonly audit: AuditService,
  ) {}

  async preview(fileName: string, buffer: Buffer): Promise<PurchaseImportPreviewDto> {
    const parsed = parsePurchaseRows(parseSpreadsheet(buffer));
    const { documents, notices } = await this.validate(parsed.documents, parsed.headerConflicts);
    return { fileName, rows: parsed.rows, documents, notices };
  }

  /**
   * La regla entera sobre comprobantes ya armados (los del archivo, o los que el usuario editó).
   * `fileIssues` son los avisos que solo el archivo sabe (filas que no repiten la cabecera).
   */
  async validate(
    documents: readonly PurchaseImportDocumentInput[],
    fileIssues: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<{ documents: PurchaseImportDocumentDto[]; notices: string[] }> {
    const { ctx, notices } = await this.loadContext(documents);
    const validated = this.validateAll(documents, ctx, fileIssues);
    return { documents: validated.map((v) => v.dto), notices };
  }

  private validateAll(
    documents: readonly PurchaseImportDocumentInput[],
    ctx: PurchaseImportContext,
    fileIssues: ReadonlyMap<string, readonly string[]> = new Map(),
  ): ValidatedDocument[] {
    // El código sugerido de un proveedor nuevo (decisión del dueño, D-351): uno por RUC, el mismo
    // en todos sus comprobantes, que no choque con los del maestro ni con los de otro RUC nuevo.
    const taken = new Set(ctx.takenSupplierCodes);
    const suggested = new Map<string, string>();
    return documents.map((doc) => {
      let withCode = doc;
      const extra: PurchaseImportIssueDto[] = (fileIssues.get(doc.key) ?? []).map((message) => ({
        severity: 'warning',
        field: 'document',
        message,
      }));
      const name = doc.supplierId === null ? ctx.padron.get(doc.supplierRuc) : undefined;
      if (name !== undefined && !ctx.suppliersByRuc.has(doc.supplierRuc)) {
        // El primer comprobante del RUC fija el código; los siguientes lo heredan.
        // Mismas reglas que el alta (`supplierCodeSchema`: sin espacios, en mayúsculas).
        let code = suggested.get(doc.supplierRuc) ?? doc.newSupplierCode?.trim().toUpperCase();
        if (code === undefined || code === '') code = suggestSupplierCode(name, taken);
        if (!suggested.has(doc.supplierRuc)) {
          const upper = code.toUpperCase();
          if ([...suggested.values()].some((c) => c.toUpperCase() === upper)) {
            extra.push({
              severity: 'error',
              field: 'newSupplierCode',
              message: `El código ${upper} ya se eligió para otro proveedor nuevo de este archivo`,
            });
          }
          suggested.set(doc.supplierRuc, code);
          taken.add(upper);
        }
        withCode = { ...doc, newSupplierCode: code };
      }
      return validateDocument(withCode, ctx, extra);
    });
  }

  // -------------------------------------------------------------------------
  // El contexto: una consulta por tabla para el archivo entero
  // -------------------------------------------------------------------------

  private async loadContext(
    documents: readonly PurchaseImportDocumentInput[],
  ): Promise<{ ctx: PurchaseImportContext; notices: string[] }> {
    const notices: string[] = [];
    const rucs = [...new Set(documents.map((d) => d.supplierRuc).filter((r) => r !== ''))];
    const chosenSupplierIds = documents.flatMap((d) => (d.supplierId ? [d.supplierId] : []));
    const skus = [
      ...new Set(documents.flatMap((d) => d.lines.map((l) => l.sku.toUpperCase()).filter(Boolean))),
    ];
    const productIds = documents.flatMap((d) =>
      d.lines.flatMap((l) => (l.productId ? [l.productId] : [])),
    );
    const finishCodes = [
      ...new Set(
        documents.flatMap((d) => d.lines.map((l) => l.finishCode.toUpperCase()).filter(Boolean)),
      ),
    ];
    const finishIds = documents.flatMap((d) =>
      d.lines.flatMap((l) => (l.finishId ? [l.finishId] : [])),
    );

    const [suppliers, codes, products, finishes, references, firstLoad] = await Promise.all([
      this.prisma.supplier.findMany({
        where: {
          OR: [
            { docType: DocType.RUC, docNumber: { in: rucs } },
            { id: { in: chosenSupplierIds } },
          ],
        },
        select: {
          id: true,
          name: true,
          code: true,
          docNumber: true,
          isActive: true,
          docType: true,
        },
      }),
      this.prisma.supplier.findMany({ select: { code: true } }),
      this.prisma.product.findMany({
        where: {
          OR: [{ sku: { in: skus, mode: 'insensitive' } }, { id: { in: productIds } }],
        },
        select: {
          id: true,
          sku: true,
          name: true,
          unit: true,
          isActive: true,
          businessLine: { select: { code: true } },
        },
      }),
      this.prisma.finish.findMany({
        where: {
          OR: [{ code: { in: finishCodes, mode: 'insensitive' } }, { id: { in: finishIds } }],
        },
        select: {
          id: true,
          code: true,
          name: true,
          kind: true,
          isActive: true,
          businessLine: { select: { code: true } },
          color: { select: { code: true, name: true } },
        },
      }),
      initialLoadReferencesOf(this.prisma),
      this.prisma.inventoryMovement.findFirst({
        where: { refType: InventoryRefType.IMPORT },
        orderBy: { operationDate: 'asc' },
        select: { operationDate: true },
      }),
    ]);

    const supplierRefs: (SupplierRef & { isRuc: boolean })[] = suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      docNumber: s.docNumber,
      isActive: s.isActive,
      isRuc: s.docType === DocType.RUC,
    }));
    const suppliersByRuc = new Map(
      supplierRefs.filter((s) => s.isRuc).map((s) => [s.docNumber, s] as const),
    );
    const suppliersById = new Map(supplierRefs.map((s) => [s.id, s]));

    const productRefs: ProductRef[] = products.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      isActive: p.isActive,
      businessLine: toSharedLineCode(p.businessLine.code),
    }));
    const productsBySku = new Map<string, ProductRef[]>();
    for (const p of productRefs) {
      const key = p.sku.toUpperCase();
      productsBySku.set(key, [...(productsBySku.get(key) ?? []), p]);
    }
    const finishRefs: FinishRef[] = finishes.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      kind: f.kind,
      isActive: f.isActive,
      businessLine: toSharedLineCode(f.businessLine.code),
      color: f.color,
    }));

    // Compras vivas de los proveedores conocidos, con el mismo número (D-132).
    const knownIds = supplierRefs.map((s) => s.id);
    const live = await this.prisma.purchase.findMany({
      where: {
        supplierId: { in: knownIds },
        status: { not: PurchaseStatus.CANCELLED },
      },
      select: {
        supplierId: true,
        docType: true,
        series: true,
        number: true,
        issueDate: true,
        status: true,
      },
    });
    const livePurchases = new Map(
      live.map((p) => [
        livePurchaseKey(p.supplierId, p.docType, p.series, p.number),
        { issueDate: p.issueDate.toISOString().slice(0, 10), status: p.status },
      ]),
    );

    // Padrón (D-158): solo los RUC que el maestro no tiene y ningún comprobante resolvió eligiendo
    // otro proveedor. Tope y concurrencia de siempre; nunca lanza.
    const unknown = rucs.filter(
      (ruc) =>
        !suppliersByRuc.has(ruc) &&
        /^\d{11}$/.test(ruc) &&
        documents.some((d) => d.supplierRuc === ruc && d.supplierId === null),
    );
    if (unknown.length > MAX_PADRON_LOOKUPS) {
      notices.push(
        `El archivo trae ${String(unknown.length)} RUC que el maestro no tiene; se consultaron los primeros ${String(MAX_PADRON_LOOKUPS)} en el padrón`,
      );
    }
    const padron = await this.lookupPadron(unknown.slice(0, MAX_PADRON_LOOKUPS));

    // TC SUNAT de cada fecha de emisión de los comprobantes en dólares sin TC (D-042, D-029).
    const sunatDates = [
      ...new Set(
        documents
          .filter(
            (d) =>
              currencyOf(d.currency) === 'USD' &&
              d.exchangeRate === '' &&
              /^\d{4}-\d{2}-\d{2}$/.test(d.issueDate),
          )
          .map((d) => d.issueDate),
      ),
    ];
    const sunatRates = new Map<string, { rate: string; source: string } | null>();
    for (const date of sunatDates) {
      try {
        const r = await this.purchases.resolveExchangeRate({ issueDate: date, currency: 'USD' });
        sunatRates.set(date, { rate: r.rate.toFixed(4), source: r.source });
      } catch {
        sunatRates.set(date, null);
      }
    }

    // Un comprobante que el archivo repite con otra cabecera (misma clave, otro armado).
    const seen = new Map<string, number>();
    for (const d of documents) seen.set(d.key, (seen.get(d.key) ?? 0) + 1);
    const repeatedKeys = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));

    return {
      notices,
      ctx: {
        today: businessToday(),
        historicalLoadStart: this.operationDate.historicalLoadStart,
        suppliersByRuc,
        suppliersById,
        padron,
        takenSupplierCodes: new Set(codes.map((c) => c.code.toUpperCase())),
        productsBySku,
        productsById: new Map(productRefs.map((p) => [p.id, p])),
        finishesByCode: new Map(finishRefs.map((f) => [f.code.toUpperCase(), f])),
        finishesById: new Map(finishRefs.map((f) => [f.id, f])),
        livePurchases,
        initialLoadReferences: references,
        initialLoadDate: firstLoad ? firstLoad.operationDate.toISOString().slice(0, 10) : null,
        sunatRates,
        repeatedKeys,
      },
    };
  }

  /** Mismo patrón que el importador de cotizaciones (D-158): tope, concurrencia, nunca lanza. */
  private async lookupPadron(rucs: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let next = 0;
    const workers = Array.from(
      { length: Math.min(PADRON_LOOKUP_CONCURRENCY, rucs.length) },
      async () => {
        for (let i = next++; i < rucs.length; i = next++) {
          const ruc = rucs[i];
          if (ruc === undefined) continue;
          const result = await this.padron.lookup(DocType.RUC, ruc);
          // Nada se compone: sin nombre del padrón no hay alta (D-152).
          if (result.found && result.name !== null) found.set(ruc, result.name);
        }
      },
    );
    await Promise.all(workers);
    return found;
  }

  // -------------------------------------------------------------------------
  // Confirmar: una transacción, un SAVEPOINT por comprobante, todo o nada
  // -------------------------------------------------------------------------

  async confirm(
    actor: RequestUser,
    input: ConfirmPurchaseImportInput,
  ): Promise<PurchaseImportResultDto> {
    // D-182 (autorrevisión, P1): un reintento con la misma clave de un envío que **sí** entró
    // tiene que devolver ese lote **antes** de validar — si no, cada comprobante ya se ve como
    // «Ya registrada» y el usuario pierde el lote (y su «Deshacer lote»).
    if (input.idempotencyKey !== undefined) {
      const seen = await this.prisma.idempotencyKey.findUnique({
        where: { key: input.idempotencyKey },
      });
      if (seen?.scope === IDEMPOTENCY_SCOPE)
        return this.batchResult(this.prisma, seen.resourceId, []);
    }
    // Todo lo que va a un tercero (padrón, SUNAT) se resuelve **antes** de abrir la transacción.
    const { ctx } = await this.loadContext(input.documents);
    const validated = this.validateAll(input.documents, ctx);
    const failures: Record<string, string[]> = {};
    for (const v of validated) {
      const errors = [
        ...v.dto.issues.filter((i) => i.severity === 'error'),
        ...v.dto.lines.flatMap((l) => l.issues.filter((i) => i.severity === 'error')),
      ];
      if (errors.length > 0) failures[v.dto.key] = errors.map((e) => e.message);
    }
    if (Object.keys(failures).length > 0) throw notImported(failures, validated.length);

    return this.prisma.$transaction(
      async (tx) => {
        const claim = await claimIdempotencyKey(tx, IDEMPOTENCY_SCOPE, input.idempotencyKey);
        if (!claim.claimed) return this.batchResult(tx, claim.resourceId, []);
        const batchId = claim.resourceId;

        const created = await this.createSuppliers(tx, actor, validated, ctx);
        const errors: Record<string, string[]> = {};
        for (const [index, v] of validated.entries()) {
          if (v.input === null) continue;
          const supplierId = v.input.supplierId || created.byRuc.get(v.dto.supplierRuc);
          const savepoint = `compra_${String(index)}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
          try {
            if (!supplierId) throw new BadRequestException('El comprobante no tiene proveedor');
            const rate = v.dto.resolvedExchangeRate;
            if (rate === null) throw new BadRequestException('Sin tipo de cambio');
            await this.purchases.createInTx(
              tx,
              actor,
              { ...v.input, supplierId },
              { rate: new Prisma.Decimal(rate.rate), source: rate.source as ExchangeRateSource },
              { importBatchId: batchId, externalCodes: v.externalCodes },
            );
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (err) {
            // Un error que no es de dominio corta en el acto: la transacción quedó abortada.
            if (!(err instanceof HttpException)) throw err;
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            errors[v.dto.key] = [messageOf(err)];
          }
        }
        if (Object.keys(errors).length > 0) throw notImported(errors, validated.length);

        // D-352: quién marcó «Es otra compra» y en qué comprobante, en la auditoría del lote.
        const overrides = validated
          .filter((v) => v.dto.initialLoadMatch !== null && v.dto.confirmedNotInitialLoad)
          .map((v) => ({
            document: `${v.dto.series.toUpperCase()}-${v.dto.number}`,
            supplierRuc: v.dto.supplierRuc,
            reference: v.dto.initialLoadMatch?.reference ?? '',
            confirmedById: actor.id,
          }));
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'imports.purchases',
          entity: 'purchases',
          entityId: batchId,
          after: {
            batchId,
            fileName: input.fileName,
            purchases: validated.length,
            createdSuppliers: created.names,
            notInitialLoadConfirmations: overrides,
          },
        });
        return this.batchResult(tx, batchId, created.names);
      },
      // Hasta mil líneas repartidas en sus comprobantes, cada uno con su alta completa.
      { timeout: 300_000, maxWait: 20_000 },
    );
  }

  /**
   * Los proveedores nuevos del archivo, desde el padrón (D-158) y con el código que quedó en
   * pantalla (decisión del dueño, D-351). El nombre lo pone el padrón, nunca el navegador.
   */
  private async createSuppliers(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    validated: readonly ValidatedDocument[],
    ctx: PurchaseImportContext,
  ): Promise<{ byRuc: Map<string, string>; names: string[] }> {
    const byRuc = new Map<string, string>();
    const names: string[] = [];
    for (const v of validated) {
      const ruc = v.dto.supplierRuc;
      if (v.dto.newSupplier === null || byRuc.has(ruc)) continue;
      const name = ctx.padron.get(ruc);
      const code = v.dto.newSupplierCode;
      if (name === undefined || code === null) continue;
      try {
        const supplier = await this.suppliers.createInTx(tx, actor, {
          code,
          docType: DocType.RUC,
          docNumber: ruc,
          name,
          address: null,
          email: null,
          phone: null,
          // Al contado: los días de crédito del proveedor son una condición comercial que el
          // padrón no dice (el de cada compra sí viaja en el archivo).
          creditDays: 0,
          providesCuttingService: false,
        });
        byRuc.set(ruc, supplier.id);
        names.push(`${ruc} — ${name} (${code})`);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `El RUC ${ruc} o el código ${code} se dio de alta mientras se importaba: vuelve a validar el archivo`,
          );
        }
        throw err;
      }
    }
    return { byRuc, names };
  }

  private async batchResult(
    tx: Prisma.TransactionClient,
    batchId: string,
    createdSuppliers: string[],
  ): Promise<PurchaseImportResultDto> {
    const purchases = await tx.purchase.findMany({
      where: { importBatchId: batchId },
      select: { id: true, series: true, number: true, supplier: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      batchId,
      purchases: purchases.map((p) => ({
        id: p.id,
        document: `${p.series}-${p.number}`,
        supplier: p.supplier.name,
      })),
      createdSuppliers,
    };
  }

  // -------------------------------------------------------------------------
  // Deshacer un lote
  // -------------------------------------------------------------------------

  /**
   * Anula **por el servicio** (`PurchasesService.cancel`, cada una en su transacción) las compras
   * del lote que sigan en BORRADOR y sin pagos. Las recibidas, las pagadas y las ya anuladas se
   * nombran y no se tocan. Solo ADMINISTRADOR: anular una compra ya lo es.
   */
  async undo(
    actor: RequestUser,
    batchId: string,
    reason: string,
  ): Promise<PurchaseImportUndoResultDto> {
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException('Solo un administrador puede deshacer un lote de compras');
    }
    const purchases = await this.prisma.purchase.findMany({
      where: { importBatchId: batchId },
      select: {
        id: true,
        series: true,
        number: true,
        status: true,
        payments: { where: { reversedAt: null }, select: { id: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (purchases.length === 0) throw new NotFoundException('Ese lote no tiene compras');
    const cancelled: string[] = [];
    const kept: { document: string; reason: string }[] = [];
    for (const p of purchases) {
      const document = `${p.series}-${p.number}`;
      if (p.status === PurchaseStatus.CANCELLED) {
        kept.push({ document, reason: 'ya estaba anulada' });
      } else if (p.status === PurchaseStatus.RECEIVED) {
        kept.push({ document, reason: 'ya se recibió: anúlala desde la compra si corresponde' });
      } else if (p.payments.length > 0) {
        kept.push({ document, reason: 'tiene pagos registrados' });
      } else {
        try {
          await this.purchases.cancel(
            actor,
            p.id,
            {
              // La anulación lleva el motivo del usuario (como toda anulación) y dice de qué lote.
              reason: `${reason} (lote ${batchId.slice(0, 8)})`.slice(0, 240),
            },
            { onlyDraft: true },
          );
          cancelled.push(document);
        } catch (err) {
          if (!(err instanceof HttpException)) throw err;
          kept.push({ document, reason: messageOf(err) });
        }
      }
    }
    // D-219: la auditoría de dominio va en una transacción real, aunque sea la única escritura.
    await this.prisma.$transaction((tx) =>
      this.audit.write(tx, {
        actorId: actor.id,
        action: 'imports.purchases.undo',
        entity: 'purchases',
        entityId: batchId,
        after: { batchId, reason, cancelled, kept },
      }),
    );
    return { batchId, cancelled, kept };
  }
}

function messageOf(err: HttpException): string {
  const response = err.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : err.message;
}

function notImported(failures: Record<string, string[]>, total: number): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message:
      `${String(Object.keys(failures).length)} de ${String(total)} comprobantes no entraron: ` +
      'no se importó ninguno, corrígelos y vuelve a enviar',
    errors: failures,
  });
}
