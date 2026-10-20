import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * cc63 (D-701): el cierre de una OP con fecha atrasada lleva el acuse de retrofecha del usuario
 * (`confirmBackdate`) hasta su ajuste de costo (`applyCloseAdjustment` → `adjustCost`). Sin él, el
 * ajuste volvía a preguntar y rechazaba un cierre ya confirmado cuando el producto tenía movimientos
 * posteriores: una carga atrasada quedaba trabada sin forma de seguir.
 */
const FILES = ['roofing-production.service.ts', 'production.service.ts'];

describe('cc63 (D-701): el cierre atrasado no pierde el acuse de retrofecha', () => {
  it.each(FILES)('%s pasa confirmBackdate en cada applyCloseAdjustment', (file) => {
    const text = readFileSync(join(__dirname, file), 'utf8');
    const calls = text.split('applyCloseAdjustment(tx,').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const body = call.slice(0, call.indexOf('});'));
      expect(body).toContain('confirmBackdate: input.confirmBackdate');
    }
  });
});

describe('cc63 (D-701, autorrevisión): el corte tercerizado recibido tarde tampoco pierde el acuse', () => {
  it('purchases.service.ts pasa confirmBackdate al ajuste de los flejes', () => {
    const text = readFileSync(join(__dirname, '../purchases/purchases.service.ts'), 'utf8');
    const fn = text.slice(text.indexOf('private async applyCuttingOrderCost('));
    const adjust = fn.slice(fn.indexOf('this.inventory.adjustCost('));
    expect(adjust.slice(0, adjust.indexOf('});'))).toContain('confirmBackdate,');
    expect(text).toMatch(
      /applyCuttingOrderCost\(\s*tx,\s*purchase,\s*actor,\s*operationDate,\s*input\.confirmBackdate,/,
    );
  });
});
