import {
  documentBalance,
  FiscalDocType,
  FiscalDocumentStatus,
  payableBalance,
  salesTotals,
  sumLineTotals,
  toDecimal,
  VOID_WINDOW_DAYS,
  voidPathFor,
} from '@ayr/shared';
import { dueDateFor, isStalled, pendingQty, proratedQty } from './invoicing-math';

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

  it('una guía se da de baja sin plazo: no existe nota de crédito sobre una guía', () => {
    expect(voidPathFor(FiscalDocType.GUIA_REMISION_REMITENTE, '2020-01-01', '2026-09-04')).toBe(
      'VOID',
    );
  });

  it('una nota de crédito se da de baja dentro del plazo', () => {
    expect(voidPathFor(FiscalDocType.NOTA_CREDITO, '2026-09-01', '2026-09-04')).toBe('VOID');
  });

  it('pasado el plazo, una nota de crédito ya no se puede deshacer', () => {
    // No existe una nota de crédito sobre una nota de crédito, así que ofrecer ese camino
    // sería mandar al usuario a un callejón. Decir que no hay ninguno es más útil.
    expect(voidPathFor(FiscalDocType.NOTA_CREDITO, '2026-09-01', '2026-09-20')).toBe('NONE');
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

  it('un importado anulado por dentro tampoco debe nada (D-110)', () => {
    // Es la mitad que hace útil a la anulación de M-4: sin esto el comprobante quedaba
    // marcado y su deuda seguía en pie, que es exactamente el agujero que vino a tapar.
    expect(documentBalance({ ...base, status: FiscalDocumentStatus.ANNULLED })).toBe('0.0000');
  });

  it('anular no borra lo ya cobrado: el saldo es cero, el cobro se revierte aparte', () => {
    // Y por eso el servicio bloquea la anulación mientras haya un cobro vigente: si no,
    // este cero escondería dinero recibido contra un comprobante que dejó de existir.
    expect(
      documentBalance({
        ...base,
        status: FiscalDocumentStatus.ANNULLED,
        paidPen: '500.0000',
      }),
    ).toBe('0.0000');
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

describe('pendingQty y proratedQty (D-074)', () => {
  it('lo pendiente es lo pedido menos lo hecho', () => {
    expect(pendingQty('10.000', '4.000').toFixed(3)).toBe('6.000');
  });

  it('nunca devuelve negativo: un despacho de más deja el pendiente en cero', () => {
    expect(pendingQty('10.000', '12.000').toFixed(3)).toBe('0.000');
  });

  it('un despacho parcial se lleva la parte proporcional de la reserva', () => {
    expect(proratedQty('25.000', '100.000', '400.000').toFixed(3)).toBe('100.000');
  });

  it('cuando la reserva está en la misma unidad que la venta, es la misma cifra', () => {
    // Perfiles y trading: el ítem reservado es el propio producto. Es el caso en el que el
    // error de usar la cantidad de venta pasaba desapercibido.
    expect(proratedQty('30.000', '100.000', '100.000').toFixed(3)).toBe('30.000');
  });

  it('una cobertura se vende por pieza y sale en kilos de la bobina', () => {
    // 40 de 200 piezas contra una reserva de 1000 kg: salen 200 kg, no 40.
    expect(proratedQty('40.000', '200.000', '1000.000').toFixed(3)).toBe('200.000');
  });

  it('una línea sin cantidad pedida no reparte nada en vez de dividir por cero', () => {
    expect(proratedQty('5.000', '0', '400.000').toFixed(3)).toBe('0.000');
  });
});

/**
 * D-169 — el rechazo por céntimos de la cobranza, que es donde el defecto del importador
 * terminaba saliendo a la superficie.
 *
 * Un comprobante cuyo total lleva cola de diezmilésimas (S/ 117.9999) no se podía cobrar con
 * los S/ 118.00 que el cliente de verdad transfiere: el saldo se comparaba con cuatro
 * decimales y el mensaje lo mostraba con dos, así que el error decía «excede el saldo
 * pendiente (S/ 118.00)» sobre un cobro de S/ 118.00. Dos cifras idénticas en pantalla y un
 * 400 que nadie podía resolver.
 */
describe('payableBalance (D-169)', () => {
  it('un saldo con cola de diezmilésimas se cobra hasta el céntimo de arriba', () => {
    expect(payableBalance('117.9999').toFixed(2)).toBe('118.00');
    expect(payableBalance('117.9901').toFixed(2)).toBe('118.00');
  });

  it('un saldo exacto no se infla', () => {
    expect(payableBalance('118.0000').toFixed(2)).toBe('118.00');
    expect(payableBalance('0.0000').toFixed(2)).toBe('0.00');
  });

  it('redondea hacia arriba y no al más cercano: de menos volvería a no cerrar', () => {
    // Con HALF_UP, 117.9949 daría 117.99 y la factura del papel (118.00) seguiría sin poder
    // cobrarse entera. Lo que se admite de más es siempre menos de un céntimo.
    expect(payableBalance('117.9949').toFixed(2)).toBe('118.00');
  });

  it('lo que se admite de más nunca llega a un céntimo', () => {
    for (const balance of ['117.9999', '117.9901', '0.0001', '5000.4444']) {
      expect(payableBalance(balance).minus(toDecimal(balance)).lt('0.01')).toBe(true);
    }
  });

  it('el sobrepago menor a un céntimo lo absorbe el saldo, que nunca es negativo', () => {
    expect(
      documentBalance({
        status: 'ACCEPTED',
        totalPen: '117.9999',
        paidPen: '118.0000',
        creditedPen: '0',
      }),
    ).toBe('0.0000');
  });
});

/**
 * D-169 — **la cabecera suma sus líneas; no las recalcula.**
 *
 * El defecto que la escritura de los E2E encontró: `resolveLines` copiaba el importe del papel
 * en la línea y, un renglón más abajo, la cabecera lo volvía a derivar de `cantidad × unitario`.
 * La cuenta por cobrar sale del total de la cabecera, así que el saldo quedaba unos céntimos por
 * debajo del comprobante y cobrar el importe real se rechazaba por exceso — el mismo daño que
 * D-169 vino a cerrar, una pantalla más adelante. Pasaba desapercibido porque el total
 * recalculado se ve «más limpio» que el correcto.
 */
describe('sumLineTotals (D-169)', () => {
  it('suma los importes que las líneas ya tienen, aunque no sean cantidad × unitario', () => {
    // 3 500 kg por S/ 4 179.13: el unitario derivado (1.1940) devuelve 4 179.00 al multiplicar.
    const totals = sumLineTotals([{ subtotalPen: '4179.1300', igvPen: '752.2434' }]);
    expect(totals.subtotal.toFixed(4)).toBe('4179.1300');
    expect(totals.total.toFixed(4)).toBe('4931.3734');
    // Lo que hacía la cabecera antes, y por trece céntimos de menos:
    expect(salesTotals([{ qty: '3500.000', unitPricePen: '1.1940' }]).subtotal.toFixed(4)).toBe(
      '4179.0000',
    );
  });

  it('suma subtotales e IGV por separado, nunca totales ya redondeados', () => {
    // El mismo criterio que `documentTotals` en ventas: sumar totales de línea arrastra el
    // redondeo del IGV de cada una.
    const totals = sumLineTotals([
      { subtotalPen: '0.0100', igvPen: '0.0018' },
      { subtotalPen: '0.0100', igvPen: '0.0018' },
    ]);
    expect(totals.subtotal.toFixed(4)).toBe('0.0200');
    expect(totals.igv.toFixed(4)).toBe('0.0036');
  });

  it('un documento sin líneas da cero y no NaN', () => {
    expect(sumLineTotals([]).total.toFixed(4)).toBe('0.0000');
  });
});
