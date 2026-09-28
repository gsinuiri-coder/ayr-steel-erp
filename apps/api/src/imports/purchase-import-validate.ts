import {
  businessLineOf,
  createPurchaseSchema,
  COIL_BUSINESS_LINES,
  comparableDocument,
  commercialColorToken,
  currencyOf,
  Decimal,
  cents,
  money,
  MAX_PURCHASE_IMPORT_LINES,
  MAX_VALUE,
  newSupplierCodeSchema,
  importRoundingTolerance,
  normalizeDecimal,
  normalizeIgvRate,
  paymentTermsOf,
  purchaseDocTypeOf,
  purchaseTypeOf,
  serviceKindOf,
  toDecimal,
  UNITS,
  type BusinessLine,
  type CreatePurchaseInput,
  type PurchaseImportDocumentDto,
  type PurchaseImportDocumentInput,
  type PurchaseImportIssueDto,
  type PurchaseImportLineDto,
  type PurchaseImportLineInput,
  type Unit,
} from '@ayr/shared';

/**
 * **Validación de un comprobante del importador de compras (D-351/D-352), sin tocar la base.**
 *
 * Todo lo que necesita del maestro llega precargado en `PurchaseImportContext` (una consulta por
 * tabla para el archivo entero), así que esta función es pura: la usa el preview, la revalidación
 * después de editar y la confirmación —la misma regla en los tres, nunca una copia—. Lo que no
 * decide acá lo decide `PurchasesService.createInTx` al confirmar (hereda, no copia: D-150).
 */

export interface SupplierRef {
  id: string;
  name: string;
  code: string;
  docNumber: string;
  isActive: boolean;
}

export interface ProductRef {
  id: string;
  sku: string;
  name: string;
  unit: string;
  businessLine: BusinessLine;
  isActive: boolean;
}

export interface FinishRef {
  id: string;
  code: string;
  name: string;
  kind: string | null;
  isActive: boolean;
  businessLine: BusinessLine | null;
  color: { code: string; name: string } | null;
}

export interface LivePurchaseRef {
  issueDate: string;
  status: string;
}

export interface PurchaseImportContext {
  today: string;
  historicalLoadStart: string;
  suppliersByRuc: ReadonlyMap<string, SupplierRef>;
  suppliersById: ReadonlyMap<string, SupplierRef>;
  /** Padrón (D-158): RUC que el maestro no tiene → razón social. */
  padron: ReadonlyMap<string, string>;
  takenSupplierCodes: ReadonlySet<string>;
  productsBySku: ReadonlyMap<string, readonly ProductRef[]>;
  productsById: ReadonlyMap<string, ProductRef>;
  finishesByCode: ReadonlyMap<string, FinishRef>;
  finishesById: ReadonlyMap<string, FinishRef>;
  /** `supplierId|docType|series|number` de las compras vivas (D-132). */
  livePurchases: ReadonlyMap<string, LivePurchaseRef>;
  /** D-352: forma comparable de cada factura de referencia de la carga inicial → qué entró con ella. */
  initialLoadReferences: ReadonlyMap<string, readonly string[]>;
  /** El día más antiguo de la carga inicial, o `null` si no hubo. */
  initialLoadDate: string | null;
  /** TC SUNAT por fecha de emisión, para los comprobantes en dólares que no traen uno. */
  sunatRates: ReadonlyMap<string, { rate: string; source: string } | null>;
  /** Comprobantes repetidos dentro del mismo archivo (misma clave). */
  repeatedKeys: ReadonlySet<string>;
}

export interface ValidatedDocument {
  dto: PurchaseImportDocumentDto;
  /** El alta lista para `createInTx`, o `null` si el comprobante tiene errores. */
  input: CreatePurchaseInput | null;
  externalCodes: (string | null)[];
  /**
   * D-359: los importes del papel por línea (sin IGV y su IGV, en la moneda del comprobante), en el
   * orden de `input.items`. `createInTx` los guarda tal cual en vez de recalcularlos del unitario.
   */
  amounts: { subtotal: string; igv: string }[];
}

/** La clave con la que se busca una compra viva: la misma tupla del índice único parcial (D-132). */
export function livePurchaseKey(
  supplierId: string,
  docType: string,
  series: string,
  number: string,
): string {
  // El número sin ceros a la izquierda: `F001-00012` y `F001-12` son el mismo papel del proveedor
  // (autorrevisión, P2), aunque el índice único de D-132 los compare como texto.
  return `${supplierId}|${docType}|${series.toUpperCase()}|${number.replace(/^0+(?=\d)/, '')}`;
}

const DEFAULT_IGV = '18';

export function validateDocument(
  doc: PurchaseImportDocumentInput,
  ctx: PurchaseImportContext,
  extraIssues: readonly PurchaseImportIssueDto[] = [],
): ValidatedDocument {
  const issues: PurchaseImportIssueDto[] = [...extraIssues];
  const error = (field: string, message: string) =>
    issues.push({ severity: 'error', field, message });
  const warning = (field: string, message: string) =>
    issues.push({ severity: 'warning', field, message });

  if (ctx.repeatedKeys.has(doc.key)) {
    error('document', 'Este comprobante aparece dos veces en el archivo con cabeceras distintas');
  }

  // --- Cabecera ---
  const type = purchaseTypeOf(doc.type);
  if (type === null)
    error(
      'type',
      `«${doc.type}» no es un tipo de compra (bobinas, producto terminado, servicio o gasto)`,
    );
  const businessLine = businessLineOf(doc.businessLine);
  if (businessLine === null)
    error('businessLine', `«${doc.businessLine}» no es una línea de negocio`);
  if (type === 'COIL' && businessLine !== null && !COIL_BUSINESS_LINES.includes(businessLine)) {
    error('businessLine', 'Solo Drywall y Coberturas Aluzinc compran bobinas');
  }
  const docType = purchaseDocTypeOf(doc.docType);
  if (docType === null) {
    error(
      'docType',
      `«${doc.docType}» no se importa: solo factura o boleta (una nota necesita el comprobante que ajusta)`,
    );
  }
  if (!/^[A-Z0-9]{1,10}$/.test(doc.series.toUpperCase()) || !/^\d{1,20}$/.test(doc.number)) {
    error(
      'document',
      `«${doc.series}${doc.number ? `-${doc.number}` : ''}» no es una serie-número (ej.: F001-00012345)`,
    );
  }

  const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(doc.issueDate) ? doc.issueDate : null;
  if (issueDate === null) {
    error('issueDate', `«${doc.issueDate}» no es una fecha: usa DD/MM/AAAA`);
  } else if (issueDate > ctx.today) {
    error('issueDate', `La fecha de emisión no puede ser futura (hoy es ${ctx.today} en Lima)`);
  } else if (issueDate < ctx.historicalLoadStart) {
    error(
      'issueDate',
      `La fecha de emisión no puede ser anterior al ${ctx.historicalLoadStart}, inicio de la carga histórica`,
    );
  } else if (ctx.initialLoadDate !== null && issueDate < ctx.initialLoadDate) {
    // D-352: aviso simple, no bloquea — la historia previa a la carga inicial está fuera del
    // sistema (D-150), pero una compra de antes puede haber llegado después.
    warning(
      'issueDate',
      `Emitida antes de la carga inicial del inventario (${ctx.initialLoadDate}): lo comprado antes de esa fecha ya debería estar en el saldo inicial`,
    );
  }

  // Proveedor: el elegido, o el del RUC, o el padrón (D-158).
  let supplier: SupplierRef | null = null;
  let newSupplier: PurchaseImportDocumentDto['newSupplier'] = null;
  if (doc.supplierId !== null) {
    supplier = ctx.suppliersById.get(doc.supplierId) ?? null;
    if (supplier === null) error('supplier', 'El proveedor elegido no existe');
  } else {
    supplier = ctx.suppliersByRuc.get(doc.supplierRuc) ?? null;
    if (supplier === null) {
      const padronName = ctx.padron.get(doc.supplierRuc);
      if (!/^\d{11}$/.test(doc.supplierRuc)) {
        error('supplier', `«${doc.supplierRuc}» no es un RUC: elige el proveedor o créalo`);
      } else if (padronName === undefined) {
        error(
          'supplier',
          `El RUC ${doc.supplierRuc} no está en el maestro ni lo devolvió el padrón: créalo con el alta de proveedor`,
        );
      } else {
        const suggestedCode = doc.newSupplierCode ?? '';
        newSupplier = { name: padronName, suggestedCode };
        const parsed = newSupplierCodeSchema.safeParse(suggestedCode);
        if (!parsed.success) {
          error(
            'newSupplierCode',
            parsed.error.issues[0]?.message ?? 'Código de proveedor inválido',
          );
        } else if (ctx.takenSupplierCodes.has(parsed.data)) {
          error('newSupplierCode', `El código ${parsed.data} ya es de otro proveedor`);
        }
      }
    }
  }
  if (supplier !== null && !supplier.isActive) {
    error('supplier', `El proveedor ${supplier.name} está desactivado: reactívalo o elige otro`);
  }

  // D-132: el mismo papel ya registrado en una compra viva.
  if (supplier !== null && docType !== null) {
    const live = ctx.livePurchases.get(
      livePurchaseKey(supplier.id, docType, doc.series, doc.number),
    );
    if (live) {
      error(
        'document',
        `Ya registrada: compra ${doc.series.toUpperCase()}-${doc.number} de ${supplier.name}, emitida el ${live.issueDate} (${live.status === 'DRAFT' ? 'borrador' : 'recibida'})`,
      );
    }
  }

  // D-352: la factura de referencia de la carga inicial.
  const initialLoad = ctx.initialLoadReferences.get(
    comparableDocument(`${doc.series}-${doc.number}`),
  );
  const initialLoadMatch =
    initialLoad === undefined
      ? null
      : { reference: `${doc.series.toUpperCase()}-${doc.number}`, items: [...initialLoad] };
  if (initialLoadMatch !== null && !doc.confirmedNotInitialLoad) {
    const shown = initialLoadMatch.items.slice(0, 5).join(', ');
    error(
      'initialLoad',
      `Coincide con la factura de referencia de la carga inicial (bobinas/SKU: ${shown}${initialLoadMatch.items.length > 5 ? '…' : ''}); la carga no guardó el proveedor. ¿Es otra compra? Márcalo para poder confirmarlo.`,
    );
  }

  const currency = currencyOf(doc.currency);
  if (currency === null) error('currency', `«${doc.currency}» no es una moneda (PEN o USD)`);
  let exchangeRate: string | undefined;
  let resolvedExchangeRate: PurchaseImportDocumentDto['resolvedExchangeRate'] = null;
  if (currency === 'PEN') {
    resolvedExchangeRate = { rate: '1.0000', source: 'MANUAL' };
    if (doc.exchangeRate !== '')
      warning('exchangeRate', 'Una compra en soles no lleva tipo de cambio: se ignora');
  } else if (currency === 'USD') {
    if (doc.exchangeRate !== '') {
      const rate = normalizeDecimal(doc.exchangeRate);
      if (rate === null || toDecimal(rate).lte(0) || toDecimal(rate).gt(MAX_VALUE.RATE)) {
        error('exchangeRate', `«${doc.exchangeRate}» no es un tipo de cambio`);
      } else {
        exchangeRate = toDecimal(rate).toFixed(4);
        resolvedExchangeRate = { rate: exchangeRate, source: 'MANUAL' };
      }
    } else if (issueDate !== null) {
      // D-042: en dólares el TC es obligatorio; sin él, el de SUNAT de la fecha de emisión, a
      // la vista antes de confirmar (complemento del dueño a la decisión 5).
      const sunat = ctx.sunatRates.get(issueDate) ?? null;
      if (sunat === null) {
        error('exchangeRate', `No hay tipo de cambio SUNAT para el ${issueDate}: escríbelo`);
      } else {
        resolvedExchangeRate = sunat;
        warning(
          'exchangeRate',
          `Sin tipo de cambio en el archivo: se usará el de SUNAT del ${issueDate} (${sunat.rate})`,
        );
      }
    }
  }

  const paymentTerms = paymentTermsOf(doc.paymentTerms);
  if (paymentTerms === null)
    error('paymentTerms', `«${doc.paymentTerms}» no es una condición de pago (contado o crédito)`);
  let creditDays: number | undefined;
  if (paymentTerms === 'CREDITO') {
    creditDays = /^\d{1,3}$/.test(doc.creditDays) ? Number(doc.creditDays) : undefined;
    if (creditDays === undefined || creditDays <= 0 || creditDays > 365) {
      error('creditDays', 'Una compra al crédito necesita sus días de crédito (1 a 365)');
    }
  }

  let serviceKind: ReturnType<typeof serviceKindOf> = null;
  if (type === 'SERVICE') {
    serviceKind = serviceKindOf(doc.serviceKind);
    if (serviceKind === null) {
      error('serviceKind', 'Indica el tipo de servicio (corte, flete, aduanas, seguro u otro)');
    } else {
      warning(
        'serviceKind',
        'El servicio entra sin vincular a una compra de bobinas ni a una orden de corte: el prorrateo de costo se liga después desde la compra',
      );
    }
  }

  // D-359: `18`, `18%` y `0.18` (una celda con formato de porcentaje) son la misma tasa.
  const igvText = doc.igvRate === '' ? DEFAULT_IGV : (normalizeIgvRate(doc.igvRate) ?? '');
  const igvRate = igvText === '' ? null : toDecimal(igvText);
  if (igvRate === null || igvRate.gt(100))
    error('igvRate', `«${doc.igvRate}» no es una tasa de IGV (0 a 100)`);

  // --- Líneas ---
  if (doc.lines.length > MAX_PURCHASE_IMPORT_LINES) {
    error('lines', `Una compra admite hasta ${String(MAX_PURCHASE_IMPORT_LINES)} líneas`);
  }
  const lines = doc.lines.map((line, index) =>
    validateLine(line, index, { type, businessLine }, ctx),
  );

  // Totales con `Decimal` (D-003), en la moneda del comprobante (D-359).
  const lineSubtotals = lines.map((l) => l.subtotal);
  const allPriced = lineSubtotals.every((s): s is Decimal => s !== null) && igvRate !== null;
  let amounts: LineAmounts[] = [];
  if (allPriced) {
    const fileTotal = doc.documentTotal === '' ? null : normalizeDecimal(doc.documentTotal);
    if (doc.documentTotal !== '' && fileTotal === null) {
      warning('documentTotal', `«${doc.documentTotal}» no es un importe: no se comparó`);
    }
    const paper = paperAmounts({
      subtotals: lineSubtotals,
      igvRate,
      qtys: lines.map((l) => l.qty ?? '0'),
      documentTotal: fileTotal,
    });
    amounts = paper.amounts;
    if (paper.mismatch !== null) {
      error(
        'documentTotal',
        `El total del archivo con IGV (${paper.mismatch.file}) no cuadra con el recalculado con IGV (${paper.mismatch.computed}): diferencia ${paper.mismatch.diff}`,
      );
    }
  }
  const subtotal = allPriced ? sumOf(amounts.map((a) => a.subtotal)) : null;
  const igv = allPriced ? sumOf(amounts.map((a) => a.igv)) : null;
  const total = subtotal !== null && igv !== null ? subtotal.plus(igv) : null;

  const lineErrors = lines.some((l) => l.dto.issues.some((i) => i.severity === 'error'));
  const hasErrors = issues.some((i) => i.severity === 'error') || lineErrors;
  const dto: PurchaseImportDocumentDto = {
    ...doc,
    lines: lines.map((l) => l.dto),
    supplierId: supplier?.id ?? null,
    supplierLabel: supplier ? `${supplier.name} (${supplier.docNumber})` : null,
    newSupplier,
    resolvedExchangeRate,
    subtotal: subtotal?.toFixed(2) ?? null,
    igv: igv?.toFixed(2) ?? null,
    total: total?.toFixed(2) ?? null,
    initialLoadMatch,
    issues,
  };
  if (
    hasErrors ||
    type === null ||
    businessLine === null ||
    docType === null ||
    issueDate === null ||
    currency === null ||
    paymentTerms === null ||
    igvRate === null
  ) {
    return { dto, input: null, externalCodes: [], amounts: [] };
  }
  const input: CreatePurchaseInput = {
    // Un proveedor nuevo todavía no tiene id: lo pone la confirmación después de crearlo.
    supplierId: supplier?.id ?? '',
    businessLine,
    type,
    docType,
    series: doc.series.toUpperCase(),
    number: doc.number,
    issueDate,
    currency,
    ...(exchangeRate === undefined ? {} : { exchangeRate }),
    igvRate: igvRate.toFixed(4),
    paymentTerms,
    ...(creditDays === undefined ? {} : { creditDays }),
    ...(serviceKind === null ? {} : { serviceKind }),
    ...(doc.notes === '' ? {} : { notes: doc.notes }),
    items: lines.map((l) => {
      if (l.item === null) throw new Error('línea sin validar');
      return l.item;
    }),
  };
  // D-351 (autorrevisión, P1): el alta armada pasa además por **el mismo schema que el
  // formulario** (`createPurchaseSchema`): un valor que el redondeo deja en cero (0,0004 kg), un
  // número fuera de rango o un texto demasiado largo no llegan a la base. Lo que el schema rechaza
  // se vuelve error del campo que lo trajo. Un proveedor nuevo todavía no tiene id: se prueba con
  // uno de relleno, que la confirmación reemplaza por el del proveedor creado.
  const parsed = createPurchaseSchema.safeParse({
    ...input,
    // Los ids ya los resolvió el maestro (arriba): acá solo se prueban los **valores**.
    supplierId: PLACEHOLDER_ID,
    items: input.items.map((item) => ({
      ...item,
      ...(item.productId ? { productId: PLACEHOLDER_ID } : {}),
      ...(item.finishId ? { finishId: PLACEHOLDER_ID } : {}),
    })),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, index, field] = issue.path;
      if (head === 'items' && typeof index === 'number') {
        const line = dto.lines[index];
        const at = line && line.rowNumber > 0 ? `Fila ${String(line.rowNumber)}: ` : '';
        line?.issues.push({
          severity: 'error',
          field: `lines.${String(index)}.${String(field ?? 'line')}`,
          message: `${at}${issue.message}`,
        });
      } else {
        dto.issues.push({
          severity: 'error',
          field: String(head ?? 'document'),
          message: issue.message,
        });
      }
    }
    return { dto, input: null, externalCodes: [], amounts: [] };
  }
  return {
    dto,
    input,
    externalCodes: lines.map((l) => l.externalCode),
    amounts: amounts.map((a) => ({
      subtotal: a.subtotal.toFixed(4),
      igv: a.igv.toFixed(4),
    })),
  };
}

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

interface ValidatedLine {
  dto: PurchaseImportLineDto;
  subtotal: Decimal | null;
  qty: string | null;
  item: CreatePurchaseInput['items'][number] | null;
  externalCode: string | null;
}

function validateLine(
  line: PurchaseImportLineInput,
  index: number,
  header: { type: ReturnType<typeof purchaseTypeOf>; businessLine: BusinessLine | null },
  ctx: PurchaseImportContext,
): ValidatedLine {
  const issues: PurchaseImportIssueDto[] = [];
  const at = line.rowNumber > 0 ? `Fila ${String(line.rowNumber)}: ` : '';
  const error = (field: string, message: string) =>
    issues.push({
      severity: 'error',
      field: `lines.${String(index)}.${field}`,
      message: `${at}${message}`,
    });

  const qty = normalizeDecimal(line.qty);
  if (qty === null || toDecimal(qty).lte(0)) {
    error(
      'qty',
      header.type === 'COIL'
        ? 'Los kilos de la bobina son obligatorios (columna KG)'
        : 'La cantidad es obligatoria y mayor que cero',
    );
  }
  // D-359: el importe sin IGV de la línea, si el papel lo trae, manda; si no, el precio unitario con
  // **todos** sus decimales. Uno de los dos tiene que venir.
  const unitPrice = normalizeDecimal(line.unitPrice);
  const lineAmount = normalizeDecimal(line.lineAmount);
  if (line.lineAmount !== '' && (lineAmount === null || toDecimal(lineAmount).lte(0))) {
    error('lineAmount', 'El importe sin IGV de la línea tiene que ser un número mayor que cero');
  } else if (lineAmount === null && (unitPrice === null || toDecimal(unitPrice).lte(0))) {
    error(
      'unitPrice',
      'El precio unitario sin IGV es obligatorio y mayor que cero (o el importe sin IGV de la línea)',
    );
  }

  let product: ProductRef | null = null;
  let finish: FinishRef | null = null;
  let unit: Unit | null = null;
  let description = line.description;
  const thickness = normalizeDecimal(line.thicknessMm);
  const width = normalizeDecimal(line.widthMm);

  if (header.type === 'FINISHED_GOOD') {
    product = resolveProduct(line, header.businessLine, ctx, error);
    unit = unitOf(line.unit, product?.unit ?? null, error);
    if (description === '' && product !== null) description = product.name;
  } else if (header.type === 'COIL') {
    finish = resolveFinish(line, header.businessLine, ctx, error);
    if (thickness === null || toDecimal(thickness).lte(0))
      error('thicknessMm', 'El espesor en mm es obligatorio en una bobina');
    if (width === null || toDecimal(width).lte(0))
      error('widthMm', 'El ancho en mm es obligatorio en una bobina');
    if (line.unit !== '' && line.unit.toUpperCase() !== 'KGM' && line.unit.toUpperCase() !== 'KG') {
      error('unit', 'Las bobinas se compran por kilo (KGM)');
    }
    unit = 'KGM';
    if (line.sku !== '' || line.productId !== null)
      error('sku', 'Una bobina no lleva SKU: se identifica por acabado, espesor y ancho');
    if (description === '' && finish !== null && thickness !== null && width !== null) {
      description = `Bobina ${finish.name} ${toDecimal(thickness).toFixed(2)} mm × ${toDecimal(width).toFixed(2)} mm`;
    }
  } else if (header.type === 'SERVICE' || header.type === 'EXPENSE') {
    if (description === '') error('description', 'Un servicio o un gasto necesita su descripción');
    if (line.sku !== '' || line.productId !== null)
      error('sku', 'Un servicio o un gasto no lleva SKU');
    unit = unitOf(line.unit, 'NIU', error);
  }
  if (header.type !== 'COIL' && (line.finishCode !== '' || line.finishId !== null)) {
    error('finishCode', 'Solo una compra de bobinas lleva acabado');
  }

  const priced = lineSubtotalOf(qty, unitPrice, lineAmount);
  const subtotal = priced?.subtotal ?? null;
  // Con los dos datos, el importe manda; pero un precio que no se parece al importe es otra columna
  // pegada donde no iba (el precio con IGV en la de sin IGV): error de la línea, con las dos cifras.
  if (priced !== null && lineAmount !== null && unitPrice !== null && qty !== null) {
    const fromPrice = money(toDecimal(qty).times(unitPrice));
    if (fromPrice.minus(priced.subtotal).abs().gt(priceTolerance(qty, unitPrice))) {
      error(
        'lineAmount',
        `El importe sin IGV (${priced.subtotal.toFixed(2)}) no cuadra con cantidad × precio (${fromPrice.toFixed(2)})`,
      );
    }
  }
  // Topes de las columnas (`MAX_VALUE`): un número fuera de rango es error de la fila y no un 500
  // por desborde al grabar (autorrevisión, P1).
  if (qty !== null && toDecimal(qty).gt(MAX_VALUE.KG))
    error('qty', 'La cantidad está fuera de rango');
  if (subtotal?.gt(MAX_VALUE.MONEY) === true) {
    error('unitPrice', 'El precio o el importe de la línea están fuera de rango');
  }
  if (thickness !== null && toDecimal(thickness).gt(MAX_VALUE.THICKNESS_MM)) {
    error('thicknessMm', 'El espesor está fuera de rango');
  }
  if (width !== null && toDecimal(width).gt(MAX_VALUE.WIDTH_MM))
    error('widthMm', 'El ancho está fuera de rango');
  const dto: PurchaseImportLineDto = {
    ...line,
    description,
    productId: product?.id ?? null,
    productLabel: product ? `${product.sku} — ${product.name}` : null,
    finishId: finish?.id ?? null,
    finishLabel: finish ? `${finish.code} — ${finish.name}` : null,
    subtotal: subtotal?.toFixed(2) ?? null,
    issues,
  };
  if (issues.length > 0 || qty === null || priced === null || unit === null) {
    return { dto, subtotal, qty, item: null, externalCode: null };
  }
  const item: CreatePurchaseInput['items'][number] = {
    description: description.slice(0, 240),
    qty: toDecimal(qty).toFixed(3),
    unit,
    // D-359: cuatro decimales solo para mostrar (D-255); el importe guardado es `subtotal`.
    unitPrice: priced.unitPrice.toFixed(4),
    ...(product ? { productId: product.id } : {}),
    ...(finish ? { finishId: finish.id } : {}),
    ...(header.type === 'COIL' && thickness !== null
      ? { thicknessMm: toDecimal(thickness).toFixed(2) }
      : {}),
    ...(header.type === 'COIL' && width !== null ? { widthMm: toDecimal(width).toFixed(2) } : {}),
  };
  return {
    dto,
    subtotal,
    qty,
    item,
    externalCode: header.type === 'COIL' && line.externalCode !== '' ? line.externalCode : null,
  };
}

/**
 * D-359: el importe sin IGV de una línea y el unitario que se muestra. El importe del papel, si
 * viene, **es** el subtotal; si no, cantidad × precio con todos los decimales del precio. Los dos, en
 * céntimos: es la escala del papel (`cents`). El unitario se deriva del importe: nunca al revés (D-255).
 */
export function lineSubtotalOf(
  qty: string | null,
  unitPrice: string | null,
  lineAmount: string | null,
): { subtotal: Decimal; unitPrice: Decimal } | null {
  if (qty === null || toDecimal(qty).lte(0)) return null;
  const q = toDecimal(toDecimal(qty).toFixed(3));
  if (lineAmount !== null && toDecimal(lineAmount).gt(0)) {
    const subtotal = cents(lineAmount);
    return { subtotal, unitPrice: money(subtotal.div(q)) };
  }
  if (unitPrice === null || toDecimal(unitPrice).lte(0)) return null;
  return { subtotal: cents(q.times(unitPrice)), unitPrice: money(unitPrice) };
}

/**
 * D-359 (autorrevisión, P1): cuánto puede separarse `cantidad × precio` del importe sin que el precio
 * sea de otra columna. El precio escrito con **d** decimales ya viene redondeado a media unidad de su
 * último decimal, así que la cota es `cantidad × 0,5 × 10^-d` (0.98 en 4 520 kg explica hasta S/ 22.60),
 * y nunca menos que la de D-169. El precio con IGV en la columna sin IGV (un 18 % de más) sigue fuera.
 */
function priceTolerance(qty: string, unitPrice: string): Decimal {
  const decimals = unitPrice.split('.')[1]?.length ?? 0;
  const perUnit = new Decimal(5).times(new Decimal(10).pow(-(decimals + 1)));
  return Decimal.max(importRoundingTolerance([qty]), toDecimal(qty).times(perUnit));
}

export interface LineAmounts {
  subtotal: Decimal;
  igv: Decimal;
}

/**
 * D-359 (mismo criterio que D-169/D-255): **el total del comprobante del archivo es con IGV y
 * manda.** El IGV de cada línea se calcula en céntimos (`cents(subtotal × tasa)`) y
 * el total recalculado se compara con el del papel. Si la diferencia entra en la tolerancia de
 * redondeo de D-169 (`importRoundingTolerance`), se absorbe en el IGV de la **última línea** —el
 * IGV del papel es la resta total − valor— y la compra queda con el total exacto del papel; el
 * valor sin IGV (la base del costo) no se toca. En un comprobante sin IGV (tasa 0, exonerado) no
 * hay IGV donde absorberlo: va al valor de la última línea. Si la diferencia es mayor, `mismatch`
 * trae las dos cifras con IGV para el error. El ajuste no se guarda: se deriva de lo guardado.
 */
export function paperAmounts(input: {
  subtotals: readonly Decimal[];
  igvRate: Decimal;
  qtys: readonly string[];
  documentTotal: string | null;
}): { amounts: LineAmounts[]; mismatch: { file: string; computed: string; diff: string } | null } {
  const rate = input.igvRate.div(100);
  const amounts = input.subtotals.map((subtotal) => ({
    subtotal,
    igv: cents(subtotal.times(rate)),
  }));
  if (input.documentTotal === null || amounts.length === 0) return { amounts, mismatch: null };
  const computed = sumOf(amounts.map((a) => a.subtotal.plus(a.igv)));
  const file = cents(input.documentTotal);
  const diff = file.minus(computed);
  if (diff.isZero()) return { amounts, mismatch: null };
  const tolerance = importRoundingTolerance([...input.qtys]);
  const last = amounts[amounts.length - 1];
  const absorbed =
    last === undefined
      ? null
      : input.igvRate.isZero()
        ? { subtotal: last.subtotal.plus(diff), igv: last.igv }
        : { subtotal: last.subtotal, igv: last.igv.plus(diff) };
  if (
    diff.abs().gt(tolerance) ||
    absorbed === null ||
    absorbed.subtotal.lte(0) ||
    absorbed.igv.isNegative()
  ) {
    return {
      amounts,
      mismatch: { file: file.toFixed(2), computed: computed.toFixed(2), diff: diff.toFixed(2) },
    };
  }
  return { amounts: [...amounts.slice(0, -1), absorbed], mismatch: null };
}

function sumOf(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}

/**
 * ¿El color que escribió la planilla es el del acabado? Por el color comercial (`Rojo` es el de
 * `ROJO-3020`, AGENTS §7), salvo que la planilla traiga un RAL: entonces tiene que ser ese RAL,
 * porque la bobina sí se empareja por el color exacto (D-085) y un RAL distinto es otra bobina.
 */
export function colorMatches(written: string, color: { code: string; name: string }): boolean {
  const token = commercialColorToken(written);
  const sameCommercial =
    token === commercialColorToken(color.code) || token === commercialColorToken(color.name);
  const ral = /(\d{3,4})\s*$/.exec(written.trim())?.[1];
  if (ral !== undefined) {
    // «3020» solo, o «Rojo 3020»: el RAL tiene que ser el del acabado, y el nombre (si vino) también.
    return (
      new RegExp(`${ral}$`).test(color.code.replace(/\s/g, '')) && (token === '' || sameCommercial)
    );
  }
  return token !== '' && sameCommercial;
}

function unitOf(
  raw: string,
  fallback: string | null,
  error: (field: string, message: string) => void,
): Unit | null {
  const value = (raw === '' ? (fallback ?? '') : raw).toUpperCase();
  const alias: Record<string, string> = {
    KG: 'KGM',
    UND: 'NIU',
    UNIDAD: 'NIU',
    M: 'MTR',
    METRO: 'MTR',
  };
  const unit = alias[value] ?? value;
  if ((UNITS as readonly string[]).includes(unit)) return unit as Unit;
  error('unit', `«${raw || '(vacía)'}» no es una unidad (${UNITS.join(', ')})`);
  return null;
}

/**
 * El SKU se resuelve **por la línea de la cabecera**: el mismo SKU puede existir en dos líneas
 * (el índice único es por línea), y la compra es de una sola. Si el SKU solo existe en otra
 * línea, es error de campo (complemento del dueño a la decisión 5).
 */
function resolveProduct(
  line: PurchaseImportLineInput,
  businessLine: BusinessLine | null,
  ctx: PurchaseImportContext,
  error: (field: string, message: string) => void,
): ProductRef | null {
  if (line.productId !== null) {
    const chosen = ctx.productsById.get(line.productId) ?? null;
    if (chosen === null) {
      error('sku', 'El producto elegido no existe');
      return null;
    }
    return checkProduct(chosen, businessLine, error);
  }
  if (line.sku === '') {
    error('sku', 'El SKU del producto es obligatorio en una compra de producto terminado');
    return null;
  }
  const candidates = ctx.productsBySku.get(line.sku.toUpperCase()) ?? [];
  if (candidates.length === 0) {
    error('sku', `El SKU ${line.sku} no está en el catálogo: créalo o elige otro`);
    return null;
  }
  const inLine = candidates.filter((p) => p.businessLine === businessLine);
  if (inLine.length === 1 && inLine[0]) return checkProduct(inLine[0], businessLine, error);
  if (inLine.length === 0) {
    error(
      'sku',
      `El SKU ${line.sku} es de otra línea (${[...new Set(candidates.map((p) => p.businessLine))].join(', ')}), no de la de la compra`,
    );
    return null;
  }
  error('sku', `El SKU ${line.sku} es ambiguo: elige el producto`);
  return null;
}

function checkProduct(
  product: ProductRef,
  businessLine: BusinessLine | null,
  error: (field: string, message: string) => void,
): ProductRef | null {
  if (!product.isActive) {
    error('sku', `El producto ${product.sku} está desactivado`);
    return null;
  }
  if (businessLine !== null && product.businessLine !== businessLine) {
    error(
      'sku',
      `El producto ${product.sku} es de otra línea (${product.businessLine}), no de la de la compra`,
    );
    return null;
  }
  return product;
}

/**
 * El acabado se resuelve por código, sin alta (D-203 exige tipo, color y línea completos). Su
 * línea tiene que ser la de la cabecera, y si el archivo trae un color que contradice al del
 * acabado es error: el color de la bobina sale del acabado, no de la planilla.
 */
function resolveFinish(
  line: PurchaseImportLineInput,
  businessLine: BusinessLine | null,
  ctx: PurchaseImportContext,
  error: (field: string, message: string) => void,
): FinishRef | null {
  const finish =
    line.finishId !== null
      ? (ctx.finishesById.get(line.finishId) ?? null)
      : line.finishCode === ''
        ? null
        : (ctx.finishesByCode.get(line.finishCode.toUpperCase()) ?? null);
  if (finish === null) {
    error(
      'finishCode',
      line.finishCode === '' && line.finishId === null
        ? 'El código de acabado es obligatorio en una bobina'
        : `El acabado ${line.finishCode} no existe: elige uno del maestro`,
    );
    return null;
  }
  if (!finish.isActive) {
    error('finishCode', `El acabado ${finish.code} está desactivado`);
    return null;
  }
  if (finish.kind === null) {
    error(
      'finishCode',
      `El acabado ${finish.code} no tiene tipo ni línea: complétalo en Acabados antes de comprar con él`,
    );
    return null;
  }
  if (businessLine !== null && finish.businessLine !== businessLine) {
    error('finishCode', `El acabado ${finish.code} es de otra línea, no de la de la compra`);
    return null;
  }
  if (line.color !== '') {
    if (finish.color === null) {
      error('color', `El acabado ${finish.code} no lleva color, y el archivo dice «${line.color}»`);
      return null;
    }
    const sameColor = colorMatches(line.color, finish.color);
    if (!sameColor) {
      error(
        'color',
        `El color «${line.color}» contradice al acabado ${finish.code} (${finish.color.name}): el color sale del acabado`,
      );
      return null;
    }
  }
  return finish;
}
