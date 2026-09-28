import { describe, expect, it } from 'vitest';
import type { PurchaseImportDocumentDto } from '@ayr/shared';
import {
  documentStatus,
  errorsOf,
  lineEditPatch,
  lineShape,
  mergeChoices,
  newSuppliersOf,
  toDocumentInput,
  warningsOf,
  type ReviewDocument,
} from './purchase-import';

/** D-351 — la lógica pura de la pantalla del importador de compras. */

function dto(over: Partial<PurchaseImportDocumentDto> = {}): PurchaseImportDocumentDto {
  return {
    key: 'k-1',
    type: 'Bobinas',
    businessLine: 'Drywall',
    docType: 'Factura',
    series: 'F001',
    number: '1',
    issueDate: '2026-09-20',
    supplierRuc: '20100000001',
    supplierId: 'sup-1',
    newSupplierCode: null,
    currency: 'PEN',
    exchangeRate: '',
    paymentTerms: 'Contado',
    creditDays: '',
    serviceKind: '',
    igvRate: '',
    notes: '',
    documentTotal: '',
    confirmedNotInitialLoad: false,
    supplierLabel: 'Aceros (20100000001)',
    newSupplier: null,
    resolvedExchangeRate: { rate: '1.0000', source: 'MANUAL' },
    subtotal: '10.00',
    igv: '1.80',
    total: '11.80',
    initialLoadMatch: null,
    issues: [],
    lines: [
      {
        rowNumber: 2,
        sku: '',
        productId: 'p-resuelto',
        productLabel: null,
        description: '',
        qty: '1',
        unit: '',
        unitPrice: '10',
        lineAmount: '72.03',
        finishCode: 'GALV',
        finishId: 'f-resuelto',
        finishLabel: null,
        color: '',
        thicknessMm: '0.45',
        widthMm: '120',
        externalCode: '',
        subtotal: '10.00',
        issues: [],
      },
    ],
    ...over,
  };
}

describe('toDocumentInput / mergeChoices', () => {
  it('solo lo elegido a mano viaja como id; lo resuelto por texto se vuelve a resolver', () => {
    const review = only(mergeChoices([dto()], []));
    const input = toDocumentInput(review);
    expect(input.supplierId).toBeNull();
    expect(input.lines[0]?.productId).toBeNull();
    expect(input.lines[0]?.finishId).toBeNull();
    expect(input.lines[0]).not.toHaveProperty('issues');
  });

  it('lo elegido sobrevive a la revalidación', () => {
    const chosen: ReviewDocument = {
      ...dto(),
      chosenSupplierId: 'sup-9',
      lines: dto().lines.map((l) => ({ ...l, chosenFinishId: 'f-9', chosenProductId: null })),
    };
    const merged = only(mergeChoices([dto()], [chosen]));
    expect(merged.chosenSupplierId).toBe('sup-9');
    expect(merged.lines[0]?.chosenFinishId).toBe('f-9');
    const input = toDocumentInput(merged);
    expect(input.supplierId).toBe('sup-9');
    expect(input.lines[0]?.finishId).toBe('f-9');
  });

  it('el código del proveedor nuevo viaja solo si hay proveedor nuevo', () => {
    expect(
      toDocumentInput(only(mergeChoices([dto({ newSupplierCode: 'ACE' })], []))).newSupplierCode,
    ).toBeNull();
    const withNew = dto({
      newSupplierCode: 'NUE',
      newSupplier: { name: 'Nuevo', suggestedCode: 'NUE' },
    });
    expect(toDocumentInput(only(mergeChoices([withNew], []))).newSupplierCode).toBe('NUE');
  });
});

describe('estado del comprobante', () => {
  it('sin errores: lista; solo el doble conteo: pide confirmar; otros: cuántos', () => {
    expect(documentStatus(dto())).toEqual({ label: 'Lista', tone: 'ok' });
    const initialLoad = dto({
      issues: [{ severity: 'error', field: 'initialLoad', message: 'x' }],
    });
    expect(documentStatus(initialLoad).tone).toBe('confirm');
    const two = dto({
      issues: [
        { severity: 'error', field: 'issueDate', message: 'a' },
        { severity: 'warning', field: 'exchangeRate', message: 'b' },
      ],
      lines: [
        {
          ...only(dto().lines),
          issues: [{ severity: 'error', field: 'lines.0.qty', message: 'c' }],
        },
      ],
    });
    expect(documentStatus(two)).toEqual({ label: '2 cosas por resolver', tone: 'error' });
    expect(errorsOf(two)).toHaveLength(2);
    expect(warningsOf(two)).toHaveLength(1);
  });

  it('forma de la tabla por tipo', () => {
    expect(lineShape('Bobinas')).toBe('COIL');
    expect(lineShape('producto terminado')).toBe('FINISHED_GOOD');
    expect(lineShape('Gasto')).toBe('OTHER');
    expect(lineShape('???')).toBe('OTHER');
  });

  it('proveedores nuevos, uno por RUC', () => {
    const n = dto({
      newSupplier: { name: 'Nuevo SAC', suggestedCode: 'NUE' },
      newSupplierCode: 'NUE',
    });
    expect(newSuppliersOf([n, { ...n, key: 'k-2' }, dto()])).toEqual(['Nuevo SAC (NUE)']);
  });
});

function only<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) throw new Error('lista vacía');
  return first;
}

describe('D-359 — el importe del papel en el preview', () => {
  it('viaja al revalidar y al confirmar', () => {
    const input = toDocumentInput(only(mergeChoices([dto()], [])));
    expect(input.lines[0]?.lineAmount).toBe('72.03');
  });

  it('editar la cantidad o el precio vacía el importe (la fila se recalcula); otro campo no', () => {
    const priced = { unitPrice: '0.144068' };
    expect(lineEditPatch(priced, 'qty', '600')).toEqual({ qty: '600', lineAmount: '' });
    expect(lineEditPatch(priced, 'unitPrice', '0.15')).toEqual({
      unitPrice: '0.15',
      lineAmount: '',
    });
    expect(lineEditPatch(priced, 'description', 'Tornillo')).toEqual({ description: 'Tornillo' });
    expect(lineEditPatch(priced, 'lineAmount', '72.03')).toEqual({ lineAmount: '72.03' });
  });

  it('una fila con solo importe conserva el importe al cambiar la cantidad', () => {
    expect(lineEditPatch({ unitPrice: '' }, 'qty', '600')).toEqual({ qty: '600' });
  });
});
