import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { executeColorRetirement, planColorRetirement } from './color-retirement';

// `write` solo usa la transacción que recibe: el cliente del constructor no se toca.
const audit = new AuditService(null as never);

/**
 * D-274: retirar un color sin uso junto con sus specs sobrantes. La regla que se prueba es la
 * que protege los datos reales: **con una sola referencia, nada se toca**. El plan dice qué
 * haría y por qué no; la ejecución vuelve a planear dentro de su transacción y se niega igual.
 */

interface Counts {
  products?: number;
  coils?: number;
  finishes?: number;
  purchaseItems?: number;
  quotationLines?: number;
  salesOrderLines?: number;
  reservations?: number;
  temporaryReservations?: number;
}

const COLOR = { id: 'color-natural', code: 'NATURAL', name: 'NATURAL', isActive: true };
const SPECS = [
  { id: 'spec-030', businessLineId: 'roof', thicknessMm: new Prisma.Decimal('0.30') },
  { id: 'spec-040', businessLineId: 'roof', thicknessMm: new Prisma.Decimal('0.40') },
];

function fakeTx(counts: Counts = {}, color: typeof COLOR | null = COLOR) {
  const n = (v: number | undefined) => jest.fn().mockResolvedValue(v ?? 0);
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    color: {
      findUnique: jest.fn().mockResolvedValue(color),
      update: jest.fn().mockResolvedValue({ ...COLOR, isActive: false }),
    },
    rawMaterialSpec: {
      findMany: jest.fn().mockResolvedValue(SPECS),
      deleteMany: jest.fn().mockResolvedValue({ count: SPECS.length }),
    },
    product: { count: n(counts.products) },
    coil: { count: n(counts.coils) },
    finish: { count: n(counts.finishes) },
    purchaseItem: { count: n(counts.purchaseItems) },
    quotationItem: { count: n(counts.quotationLines) },
    salesOrderItem: { count: n(counts.salesOrderLines) },
    reservation: { count: n(counts.reservations) },
    quotationReservation: { count: n(counts.temporaryReservations) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

type Tx = Parameters<typeof planColorRetirement>[0];

describe('planColorRetirement (D-274)', () => {
  it('sin referencias: desactiva el color y borra sus specs, sin paradas', async () => {
    const plan = await planColorRetirement(fakeTx() as unknown as Tx, 'NATURAL');
    expect(plan.stops).toEqual([]);
    expect(plan.color?.code).toBe('NATURAL');
    expect(plan.specs.map((s) => [s.id, s.thicknessMm])).toEqual([
      ['spec-030', '0.30'],
      ['spec-040', '0.40'],
    ]);
  });

  it.each<[string, Counts]>([
    ['un producto', { products: 1 }],
    ['una bobina', { coils: 1 }],
    ['un acabado', { finishes: 1 }],
    ['una línea de compra', { purchaseItems: 1 }],
    ['una línea de cotización sobre la spec', { quotationLines: 1 }],
    ['una línea de pedido sobre la spec', { salesOrderLines: 1 }],
    ['una reserva firme sobre la spec', { reservations: 1 }],
    ['una reserva temporal sobre la spec', { temporaryReservations: 1 }],
  ])('con %s, para', async (_label, counts) => {
    const plan = await planColorRetirement(fakeTx(counts) as unknown as Tx, 'NATURAL');
    expect(plan.stops).toHaveLength(1);
  });

  it('un color que no existe es una parada, no un error silencioso', async () => {
    const plan = await planColorRetirement(fakeTx({}, null) as unknown as Tx, 'NATURAL');
    expect(plan.stops).toEqual(['No existe el color NATURAL']);
  });
});

describe('executeColorRetirement (D-274)', () => {
  it('borra las specs, desactiva el color y audita cada paso', async () => {
    const tx = fakeTx();
    const result = await executeColorRetirement(tx as unknown as Tx, audit, 'admin-1', 'NATURAL');

    expect(result.specs).toHaveLength(2);
    // Bloquea el color antes de volver a contar: nadie lo usa entre el plan y la escritura.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.rawMaterialSpec.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['spec-030', 'spec-040'] }, colorId: 'color-natural' },
    });
    expect(tx.color.update).toHaveBeenCalledWith({
      where: { id: 'color-natural' },
      data: { isActive: false },
    });
    const actions = tx.auditLog.create.mock.calls.map(
      (c: [{ data: { action: string } }]) => c[0].data.action,
    );
    expect(actions).toEqual([
      'raw_material_specs.delete',
      'raw_material_specs.delete',
      'colors.retire',
    ]);
  });

  it('se niega si aparece una referencia, y no escribe nada', async () => {
    const tx = fakeTx({ quotationLines: 1 });
    await expect(
      executeColorRetirement(tx as unknown as Tx, audit, 'admin-1', 'NATURAL'),
    ).rejects.toThrow('línea');
    expect(tx.rawMaterialSpec.deleteMany).not.toHaveBeenCalled();
    expect(tx.color.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('un color ya inactivo y sin specs no tiene nada que hacer', async () => {
    const tx = fakeTx({}, { ...COLOR, isActive: false });
    tx.rawMaterialSpec.findMany.mockResolvedValue([]);
    await expect(
      executeColorRetirement(tx as unknown as Tx, audit, 'admin-1', 'NATURAL'),
    ).rejects.toThrow('nada que hacer');
  });
});
