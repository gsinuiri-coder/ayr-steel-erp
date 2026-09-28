import {
  purchaseTypeOf,
  type PurchaseImportDocumentDto,
  type PurchaseImportDocumentInput,
  type PurchaseImportIssueDto,
  type PurchaseImportLineInput,
} from '@ayr/shared';

/**
 * Lógica pura de la pantalla del importador de compras (D-351): qué se manda al servidor, qué
 * bloquea y cómo se resume cada comprobante. La regla de negocio la decide el API (`/validate`);
 * esto solo arma y lee lo que va y vuelve.
 */

/** El comprobante tal como lo revisa el usuario: lo que se reenvía a `/validate` y a confirmar. */
export function toDocumentInput(doc: ReviewDocument): PurchaseImportDocumentInput {
  return {
    key: doc.key,
    type: doc.type,
    businessLine: doc.businessLine,
    docType: doc.docType,
    series: doc.series,
    number: doc.number,
    issueDate: doc.issueDate,
    supplierRuc: doc.supplierRuc,
    // El proveedor resuelto por RUC no viaja como elegido: así un RUC corregido se vuelve a resolver.
    supplierId: doc.chosenSupplierId ?? null,
    newSupplierCode: doc.newSupplier === null ? null : doc.newSupplierCode,
    currency: doc.currency,
    exchangeRate: doc.exchangeRate,
    paymentTerms: doc.paymentTerms,
    creditDays: doc.creditDays,
    serviceKind: doc.serviceKind,
    igvRate: doc.igvRate,
    notes: doc.notes,
    documentTotal: doc.documentTotal,
    confirmedNotInitialLoad: doc.confirmedNotInitialLoad,
    lines: doc.lines.map((l): PurchaseImportLineInput => ({
      rowNumber: l.rowNumber,
      sku: l.sku,
      productId: l.chosenProductId ?? null,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unitPrice,
      lineAmount: l.lineAmount,
      finishCode: l.finishCode,
      finishId: l.chosenFinishId ?? null,
      color: l.color,
      thicknessMm: l.thicknessMm,
      widthMm: l.widthMm,
      externalCode: l.externalCode,
    })),
  };
}

/**
 * Lo que la pantalla guarda de un comprobante: el DTO del servidor más lo que el usuario **eligió**
 * a mano (proveedor, producto, acabado). Se separa de lo resuelto por el servidor para que al
 * reenviar solo viaje como id lo elegido, y lo demás se vuelva a resolver por su texto.
 */
export type ReviewLine = PurchaseImportDocumentDto['lines'][number] & {
  chosenProductId?: string | null;
  chosenFinishId?: string | null;
};

export type ReviewDocument = Omit<PurchaseImportDocumentDto, 'lines'> & {
  chosenSupplierId?: string | null;
  lines: ReviewLine[];
};

/** Vuelve a pegar lo elegido a mano sobre la respuesta de `/validate`. */
export function mergeChoices(
  fresh: readonly PurchaseImportDocumentDto[],
  previous: readonly ReviewDocument[],
): ReviewDocument[] {
  const byKey = new Map(previous.map((d) => [d.key, d]));
  return fresh.map((doc) => {
    const before = byKey.get(doc.key);
    return {
      ...doc,
      chosenSupplierId: before?.chosenSupplierId ?? null,
      lines: doc.lines.map((line, i) => ({
        ...line,
        chosenProductId: before?.lines[i]?.chosenProductId ?? null,
        chosenFinishId: before?.lines[i]?.chosenFinishId ?? null,
      })),
    };
  });
}

export function errorsOf(doc: PurchaseImportDocumentDto): PurchaseImportIssueDto[] {
  return [
    ...doc.issues.filter((i) => i.severity === 'error'),
    ...doc.lines.flatMap((l) => l.issues.filter((i) => i.severity === 'error')),
  ];
}

export function warningsOf(doc: PurchaseImportDocumentDto): PurchaseImportIssueDto[] {
  return doc.issues.filter((i) => i.severity === 'warning');
}

/** El estado del comprobante en la cabecera del acordeón. */
export function documentStatus(doc: PurchaseImportDocumentDto): {
  label: string;
  tone: 'ok' | 'error' | 'confirm';
} {
  const errors = errorsOf(doc);
  if (errors.length === 0) return { label: 'Lista', tone: 'ok' };
  if (errors.every((e) => e.field === 'initialLoad')) {
    return { label: 'Confirmar «Es otra compra»', tone: 'confirm' };
  }
  return {
    label:
      errors.length === 1 ? '1 cosa por resolver' : `${String(errors.length)} cosas por resolver`,
    tone: 'error',
  };
}

/** Las cuatro formas de la tabla de líneas, según el tipo de compra de la cabecera. */
export function lineShape(type: string): 'COIL' | 'FINISHED_GOOD' | 'OTHER' {
  const kind = purchaseTypeOf(type);
  if (kind === 'COIL') return 'COIL';
  if (kind === 'FINISHED_GOOD') return 'FINISHED_GOOD';
  return 'OTHER';
}

/** Los mensajes de un campo de línea (`lines.<i>.<campo>`), para pintarlos bajo la celda. */
export function lineIssues(
  doc: PurchaseImportDocumentDto,
  index: number,
): PurchaseImportIssueDto[] {
  return doc.lines[index]?.issues ?? [];
}

/** Proveedores que se crearán desde el padrón, uno por RUC. */
export function newSuppliersOf(docs: readonly PurchaseImportDocumentDto[]): string[] {
  const byRuc = new Map<string, string>();
  for (const d of docs) {
    if (d.newSupplier !== null)
      byRuc.set(d.supplierRuc, `${d.newSupplier.name} (${d.newSupplierCode ?? ''})`);
  }
  return [...byRuc.values()];
}

/**
 * D-359 (mismo criterio que D-169 en cotizaciones): editar la cantidad o el precio de una fila en el
 * preview la recalcula desde cantidad × precio, así que su importe del papel **se vacía** —se ve en
 * la columna— en vez de quedar mandando sobre números que ya no son los del papel. Una fila que solo
 * trae importe (sin precio) no tiene con qué recalcularse: editar su cantidad conserva el importe y el
 * unitario se vuelve a derivar. Cualquier otro campo se edita tal cual.
 */
export function lineEditPatch(
  line: Pick<ReviewLine, 'unitPrice'>,
  field: 'qty' | 'unitPrice' | 'lineAmount' | (string & {}),
  value: string,
): Partial<ReviewLine> {
  const recalculates = field === 'unitPrice' || (field === 'qty' && line.unitPrice.trim() !== '');
  return recalculates ? { [field]: value, lineAmount: '' } : { [field]: value };
}
