import { ProductionService } from './production.service';

// D-291: la bobina de cada reporte se deriva de las salidas `PRODUCTION` vivas del kardex.
type ReportCoils = (
  this: { prisma: unknown },
  ids: string[],
) => Promise<Map<string, { id: string; code: string; kg: string }[]>>;

const reportCoils = (ProductionService.prototype as unknown as { reportCoils: ReportCoils })
  .reportCoils;

function build(
  movements: { refId: string | null; itemId: string; qty: { toFixed: (n: number) => string } }[],
) {
  const prisma = {
    inventoryMovement: { findMany: jest.fn().mockResolvedValue(movements) },
    coil: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'c1', code: 'FLEJE-1' },
        { id: 'c2', code: 'FLEJE-2' },
      ]),
    },
  };
  return { prisma, run: (ids: string[]) => reportCoils.call({ prisma }, ids) };
}

const qty = (v: string) => ({ toFixed: () => v });

describe('ProductionService.reportCoils', () => {
  it('sin reportes no consulta nada', async () => {
    const { prisma, run } = build([]);
    expect((await run([])).size).toBe(0);
    expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
  });

  it('pide solo las salidas de bobina vivas (ni anuladas ni la anulación de otra) de esos reportes', async () => {
    const { prisma, run } = build([]);
    await run(['r1', 'r2']);
    expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          refType: 'PRODUCTION',
          refId: { in: ['r1', 'r2'] },
          itemType: 'COIL',
          type: 'OUT',
          reversalOfId: null,
          reversals: { none: {} },
        },
      }),
    );
    // Sin movimientos no hace la segunda consulta.
    expect(prisma.coil.findMany).not.toHaveBeenCalled();
  });

  it('agrupa por reporte: un fleje por reporte de coberturas, varios en drywall', async () => {
    const { run } = build([
      { refId: 'r1', itemId: 'c1', qty: qty('12.500') },
      { refId: 'r2', itemId: 'c1', qty: qty('3.000') },
      { refId: 'r2', itemId: 'c2', qty: qty('4.250') },
      { refId: null, itemId: 'c2', qty: qty('1.000') },
    ]);
    const byReport = await run(['r1', 'r2']);
    expect(byReport.get('r1')).toEqual([{ id: 'c1', code: 'FLEJE-1', kg: '12.500' }]);
    expect(byReport.get('r2')).toEqual([
      { id: 'c1', code: 'FLEJE-1', kg: '3.000' },
      { id: 'c2', code: 'FLEJE-2', kg: '4.250' },
    ]);
    // Un movimiento sin referencia no se le atribuye a ningún reporte.
    expect(byReport.size).toBe(2);
  });
});
