import {
  documentBalance,
  FiscalDocType,
  FiscalDocumentStatus,
  VOID_WINDOW_DAYS,
  voidPathFor,
} from '@ayr/shared';
import { dueDateFor, isStalled, pendingQty, proratedWeightKg } from './invoicing-math';

/**
 * Reglas de calendario y de saldo de Fase 5b (D-072..D-075).
 *
 * Lo que se prueba acá es lo que se puede equivocar **en silencio**: un vencimiento que
 * cae un día antes, un saldo que no baja con la nota de crédito, un plazo de baja que
 * deja pasar una factura vieja. Ninguno de esos errores rompe nada visible hasta que
 * alguien reclama por un cobro o SUNAT rechaza una comunicación.
 */

describe('dueDateFor (D-075)', () => {
  it('al contado no hay vencimiento', () => {
    expect(dueDateFor('2026-09-04', 0)).toBeNull();
  });

  it('suma los días de crédito del cliente', () => {
    expect(dueDateFor('2026-09-04', 30)).toBe('2026-10-04');
  });

  it('cruza el fin de mes y el fin de año sin corrimiento', () => {
    expect(dueDateFor('2026-01-31', 1)).toBe('2026-02-01');
    expect(dueDateFor('2026-12-30', 5)).toBe('2027-01-04');
  });

  it('un crédito negativo se trata como contado, no como fecha hacia atrás', () => {
    expect(dueDateFor('2026-09-04', -10)).toBeNull();
  });
});

describe('voidPathFor (D-072)', () => {
  it('una factura del día se da de baja', () => {
    expect(voidPathFor(FiscalDocType.FACTURA, '2026-09-04', '2026-09-04')).toBe('VOID');
  });

  it('la factura sigue dentro del plazo el último día', () => {
    expect(voidPathFor(FiscalDocType.FACTURA, '2026-09-01', '2026-09-08')).toBe('VOID');
    expect(VOID_WINDOW_DAYS).toBe(7);
  });

  it('pasado el plazo, la única salida es la nota de crédito', () => {
    expect(voidPathFor(FiscalDocType.FACTURA, '2026-09-01', '2026-09-09')).toBe('CREDIT_NOTE');
  });

  it('una boleta va siempre por nota de crédito: su baja es por resumen diario', () => {
    expect(voidPathFor(FiscalDocType.BOLETA, '2026-09-04', '2026-09-04')).toBe('CREDIT_NOTE');
  });
});

describe('documentBalance (D-075)', () => {
  const base = {
    status: FiscalDocumentStatus.ACCEPTED,
    totalPen: '1180.0000',
    paidPen: '0',
    creditedPen: '0',
  };

  it('sin cobros ni notas, el saldo es el total', () => {
    expect(documentBalance(base)).toBe('1180.0000');
  });

  it('el cobro parcial baja el saldo', () => {
    expect(documentBalance({ ...base, paidPen: '500.0000' })).toBe('680.0000');
  });

  it('la nota de crédito ajusta el saldo igual que un cobro', () => {
    expect(documentBalance({ ...base, creditedPen: '180.0000' })).toBe('1000.0000');
  });

  it('cobro más nota de crédito pueden dejarlo en cero', () => {
    expect(documentBalance({ ...base, paidPen: '1000.0000', creditedPen: '180.0000' })).toBe(
      '0.0000',
    );
  });

  it('nunca queda negativo, aunque lo acreditado supere lo que falta', () => {
    expect(documentBalance({ ...base, paidPen: '1180.0000', creditedPen: '100.0000' })).toBe(
      '0.0000',
    );
  });

  it('un comprobante anulado o rechazado no debe nada', () => {
    expect(documentBalance({ ...base, status: FiscalDocumentStatus.VOIDED })).toBe('0.0000');
    expect(documentBalance({ ...base, status: FiscalDocumentStatus.REJECTED })).toBe('0.0000');
  });
});

describe('isStalled (D-073)', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');

  it('un borrador nunca está estancado: no hay nada que medir', () => {
    expect(isStalled(null, 6, now)).toBe(false);
  });

  it('recién emitido no lo está', () => {
    expect(isStalled(new Date('2026-09-04T11:00:00.000Z'), 6, now)).toBe(false);
  });

  it('pasado el umbral, sí', () => {
    expect(isStalled(new Date('2026-09-04T05:00:00.000Z'), 6, now)).toBe(true);
  });
});

describe('pendingQty y proratedWeightKg (D-074)', () => {
  it('lo pendiente es lo pedido menos lo hecho', () => {
    expect(pendingQty('10.000', '4.000').toFixed(3)).toBe('6.000');
  });

  it('nunca devuelve negativo: un despacho de más deja el pendiente en cero', () => {
    expect(pendingQty('10.000', '12.000').toFixed(3)).toBe('0.000');
  });

  it('el peso de un despacho parcial va en proporción a la reserva de la línea', () => {
    expect(proratedWeightKg('25.000', '100.000', '400.000').toFixed(3)).toBe('100.000');
  });

  it('una línea sin cantidad pedida no reparte peso en vez de dividir por cero', () => {
    expect(proratedWeightKg('5.000', '0', '400.000').toFixed(3)).toBe('0.000');
  });
});
