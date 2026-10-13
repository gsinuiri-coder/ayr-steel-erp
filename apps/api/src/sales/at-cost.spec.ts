import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { atCostReasonText } from '@ayr/shared';
import { assertAtCostActor, atCostAuditEntries, changedAtCostLines } from './at-cost';
import type { ResolvedSalesLine } from './sales-lines';

/** cc51 (D-641): quién marca una línea a costo y qué queda en la auditoría. */
function line(over: Partial<ResolvedSalesLine> = {}): ResolvedSalesLine {
  return {
    lineNumber: 1,
    productId: 'p-1',
    businessLineId: 'bl-1',
    description: 'Producto',
    qty: '2.000',
    unit: 'NIU',
    listPricePen: null,
    unitPricePen: '20.0000',
    valuePerMeterPen: null,
    piecesHint: null,
    subtotalPen: '40.0000',
    igvPen: '7.2000',
    totalPen: '47.2000',
    reserveItemType: 'PRODUCT',
    reserveItemId: 'p-1',
    reserveQty: '2.000',
    reserveUnit: 'NIU',
    pieces: [],
    productSku: 'SKU-1',
    productName: 'Producto',
    reserveItemLabel: 'SKU-1',
    atCostReason: 'LIQUIDACION',
    atCostNote: null,
    atCostFloor: { costPen: '20.0000', minPricePen: '23.60', priceUnitLabel: 'und' },
    ...over,
  };
}
const stored = (over: Partial<ResolvedSalesLine> = {}) => {
  const l = line(over);
  return {
    productId: l.productId,
    qty: l.qty,
    unitPricePen: l.unitPricePen,
    valuePerMeterPen: l.valuePerMeterPen,
    atCostReason: l.atCostReason,
    atCostNote: l.atCostNote,
  };
};
const ADMIN = { role: Role.ADMINISTRADOR };
const SELLER = { role: Role.VENDEDOR };

describe('changedAtCostLines', () => {
  it('una línea normal nunca cuenta', () => {
    expect(changedAtCostLines([line({ atCostReason: null })], [])).toHaveLength(0);
  });
  it('igual a una guardada no cuenta; cambiada en precio, cantidad, producto o motivo, sí', () => {
    expect(changedAtCostLines([line()], [stored()])).toHaveLength(0);
    expect(changedAtCostLines([line({ unitPricePen: '20.1000' })], [stored()])).toHaveLength(1);
    expect(changedAtCostLines([line({ qty: '3.000' })], [stored()])).toHaveLength(1);
    expect(changedAtCostLines([line({ productId: 'p-2' })], [stored()])).toHaveLength(1);
    expect(changedAtCostLines([line({ atCostReason: 'FRECUENTE' })], [stored()])).toHaveLength(1);
    expect(
      changedAtCostLines(
        [line({ atCostReason: 'OTRO', atCostNote: 'b' })],
        [stored({ atCostReason: 'OTRO', atCostNote: 'a' })],
      ),
    ).toHaveLength(1);
    expect(changedAtCostLines([line({ valuePerMeterPen: '5.0000' })], [stored()])).toHaveLength(1);
  });
  it('los decimales se comparan como número, no como texto', () => {
    expect(changedAtCostLines([line({ qty: '2' })], [stored()])).toHaveLength(0);
  });
  it('cada línea guardada empareja una sola vez: duplicar una línea a costo es una nueva', () => {
    expect(changedAtCostLines([line(), line({ lineNumber: 2 })], [stored()])).toHaveLength(1);
  });
  it('una guardada normal no hace pasar una marcada', () => {
    expect(changedAtCostLines([line()], [stored({ atCostReason: null })])).toHaveLength(1);
  });
});

describe('assertAtCostActor', () => {
  it('el ADMINISTRADOR siempre', () => {
    expect(() => assertAtCostActor(ADMIN, [line()], [])).not.toThrow();
  });
  it('otro rol: 403 si marca o cambia; pasa si la línea queda igual o no hay marcas', () => {
    expect(() => assertAtCostActor(SELLER, [line()], [])).toThrow(ForbiddenException);
    expect(() => assertAtCostActor(SELLER, [line()], [stored()])).not.toThrow();
    expect(() => assertAtCostActor(SELLER, [line({ atCostReason: null })], [])).not.toThrow();
    expect(() => assertAtCostActor({ role: Role.SUPERVISOR_PLANTA }, [line()], [])).toThrow(
      'Solo un administrador puede vender a costo',
    );
  });
});

describe('atCostAuditEntries', () => {
  it('un registro por línea nueva o cambiada, con el costo de ese momento y el motivo', () => {
    const entries = atCostAuditEntries(
      'u-1',
      'q-1',
      [line(), line({ lineNumber: 2, atCostReason: null })],
      [],
    );
    expect(entries).toEqual([
      {
        actorId: 'u-1',
        action: 'sales.quotation.line-at-cost',
        entity: 'quotations',
        entityId: 'q-1',
        after: {
          lineNumber: 1,
          sku: 'SKU-1',
          unitValuePen: '20.0000',
          costPen: '20.0000',
          atCostPricePen: '23.60',
          priceUnit: 'und',
          atCostReason: 'LIQUIDACION',
        },
        reason: 'Liquidación de stock',
      },
    ]);
  });
  it('una plancha lleva su valor por metro; «Otro», su texto; sin piso, costo nulo', () => {
    const [entry] = atCostAuditEntries(
      'u-1',
      'q-1',
      [
        line({
          valuePerMeterPen: '5.0000',
          atCostReason: 'OTRO',
          atCostNote: 'Obra social',
          atCostFloor: null,
        }),
      ],
      [],
    );
    expect(entry?.after).toMatchObject({
      valuePerMeterPen: '5.0000',
      atCostNote: 'Obra social',
      costPen: null,
      atCostPricePen: null,
    });
    expect(entry?.reason).toBe('Otro: Obra social');
  });
  it('lo que quedó igual no se vuelve a registrar', () => {
    expect(atCostAuditEntries('u-1', 'q-1', [line()], [stored()])).toEqual([]);
  });
});

describe('atCostReasonText', () => {
  it('rótulo, texto de «Otro», nada', () => {
    expect(atCostReasonText('FRECUENTE', null)).toBe('Cliente frecuente');
    expect(atCostReasonText('OTRO', null)).toBe('Otro');
    expect(atCostReasonText(null, null)).toBeNull();
    expect(atCostReasonText('RARO', null)).toBe('RARO');
  });
});
