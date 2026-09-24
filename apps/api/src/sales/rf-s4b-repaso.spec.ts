import { BadRequestException } from '@nestjs/common';
import { BusinessLineCode, FinishKind, InventoryItemType, Prisma } from '@prisma/client';
import { Role, stripImportMarker } from '@ayr/shared';
import { QuotationsService } from './quotations.service';
import { SalesOrdersService } from './sales-orders.service';

/**
 * Repaso del delta de RF-S4b (`docs/revision/rf-s4b-repaso.md`): D-256 (3) —el texto de las
 * observaciones nunca otorga permisos— en **todas** las entradas, y los pools de bobina que una
 * cotización ya tiene, que es contra lo que la edición valida una bobina nueva (D-254).
 */

const ADMIN = { id: 'u-1', role: Role.ADMINISTRADOR } as never;
const MARKER = 'Factura externa: F001-1349';

describe('D-256 (3): la marca «Factura externa:» la pone solo el importador', () => {
  it('el alta de cotización por HTTP la rechaza, antes de abrir la transacción', async () => {
    const $transaction = jest.fn();
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, { prisma: { $transaction } });
    await expect(
      svc.create(ADMIN, {
        customerId: 'c-1',
        issueDate: '2026-09-24',
        validityDays: 7,
        notes: `  ${MARKER}`,
        items: [],
      }),
    ).rejects.toThrow(/esa marca la pone el importador/);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('la edición la rechaza en una cotización que no la tenía, y la acepta en una importada', async () => {
    const run = async (currentNotes: string | null) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'q-1',
            seq: 9,
            status: 'EMITTED',
            valid_until: null,
            created_by_id: 'u-1',
            seller_id: 'u-1',
            notes: currentNotes,
          },
        ]),
        customer: { findUnique: jest.fn().mockRejectedValue(new Error('siguió de largo')) },
      };
      const svc = Object.create(QuotationsService.prototype) as QuotationsService;
      Object.assign(svc, {
        prisma: { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
      });
      return svc.update(ADMIN, 'q-1', {
        customerId: 'c-1',
        issueDate: '2026-09-24',
        validityDays: 7,
        notes: MARKER,
        items: [],
      });
    };
    await expect(run(null)).rejects.toBeInstanceOf(BadRequestException);
    // En una importada la marca ya estaba: se deja pasar y la edición sigue (hasta el cliente).
    await expect(run(MARKER)).rejects.toThrow('siguió de largo');
  });

  it('el alta de pedido directo la rechaza (antes entraba sin pasar por el importador)', async () => {
    const $transaction = jest.fn();
    const svc = Object.create(SalesOrdersService.prototype) as SalesOrdersService;
    Object.assign(svc, { prisma: { $transaction } });
    await expect(
      svc.createDirect(ADMIN, {
        customerId: 'c-1',
        issueDate: '2026-09-24',
        notes: MARKER,
        items: [],
      }),
    ).rejects.toThrow(/esa marca la pone el importador/);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('el duplicado de una importada nace sin la marca y conserva el resto de las observaciones', () => {
    expect(stripImportMarker(`${MARKER}\nEntregar en obra`)).toBe('Entregar en obra');
    expect(stripImportMarker(MARKER)).toBeNull();
    expect(stripImportMarker('Sin marca')).toBe('Sin marca');
    expect(stripImportMarker(null)).toBeNull();
  });
});

describe('QuotationsService — lo que la cotización ya vende (D-254 en la edición)', () => {
  const D = (v: string) => new Prisma.Decimal(v);
  const trading = { code: BusinessLineCode.TRADING };
  const rows = [
    // Una línea que ya vende una bobina: su pool sale de la bobina.
    {
      description: 'Bobina',
      reserveItemType: InventoryItemType.COIL,
      reserveItemId: 'c-1',
      product: { sku: 'BOB038AZUL', name: 'Bobina azul', businessLine: trading },
    },
    // Una enganchada al `BOB…` suelto (COT-000002): su pool sale del producto.
    {
      description: 'BOBINA ALUZINC ROJO 0.45',
      reserveItemType: InventoryItemType.PRODUCT,
      reserveItemId: 'p-2',
      product: { sku: 'BOB45ROJO', name: 'Suelto rojo', businessLine: trading },
    },
    // Una común: no aporta pool.
    {
      description: 'Plancha',
      reserveItemType: InventoryItemType.PRODUCT,
      reserveItemId: 'p-3',
      product: { sku: 'PLA-X', name: 'Plancha', businessLine: { code: BusinessLineCode.ROOFING } },
    },
  ];
  const tx = {
    quotationItem: {
      findMany: jest.fn(({ where }: { where: { reserveItemType?: InventoryItemType } }) =>
        Promise.resolve(
          where.reserveItemType === undefined
            ? rows
            : rows.filter((r) => r.reserveItemType === where.reserveItemType),
        ),
      ),
    },
    coil: {
      findUnique: jest.fn().mockResolvedValue({
        thicknessMm: D('0.38'),
        finish: { code: 'ALZ-AZUL-5002', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } },
      }),
    },
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }, { code: 'ROJO' }]) },
  };
  const svc = Object.create(QuotationsService.prototype) as {
    storedCoilPools: (tx: unknown, id: string) => Promise<Set<string>>;
    storedCoilIds: (tx: unknown, id: string) => Promise<Set<string>>;
  };

  it('los pools son el de la bobina vendida y el del BOB… suelto; la línea común no aporta', async () => {
    expect([...(await svc.storedCoilPools(tx, 'q-1'))].sort()).toEqual([
      'BOB038AZUL',
      'BOB045ROJO',
    ]);
  });

  it('las bobinas ya vendidas son solo las de las líneas de bobina', async () => {
    expect([...(await svc.storedCoilIds(tx, 'q-1'))]).toEqual(['c-1']);
  });
});
