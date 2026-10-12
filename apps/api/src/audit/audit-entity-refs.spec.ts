import { AUDIT_ENTITY_TYPES } from '@ayr/shared';
import {
  entityDisplay,
  refKey,
  resolveEntityRefs,
  searchEntityIds,
  SEARCH_IDS_PER_TYPE,
  storedCode,
} from './audit-entity-refs';
import { likePattern } from './audit-query.service';

/**
 * cc48 (D-633, D-634): el código legible de la auditoría se resuelve al leer, por lotes —una
 * consulta por tipo de entidad presente en la página, nunca una por fila—, y el buscar resuelve el
 * código a ids por tipo.
 */

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Lo que `findMany` recibe en estas pruebas. */
interface FindArgs {
  where?: { id?: { in: string[] } } & Record<string, unknown>;
  select?: unknown;
  orderBy?: unknown;
  take?: number;
}

function prismaWith(tables: Record<string, Record<string, unknown>[]>) {
  const calls: Record<string, jest.Mock<Promise<Record<string, unknown>[]>, [FindArgs]>> = {};
  const prisma: Record<string, { findMany: (typeof calls)[string] }> = {};
  for (const [model, rows] of Object.entries(tables)) {
    const findMany = jest.fn((args: FindArgs) =>
      Promise.resolve(
        args.where?.id?.in ? rows.filter((r) => args.where!.id!.in.includes(r.id as string)) : rows,
      ),
    );
    calls[model] = findMany;
    prisma[model] = { findMany };
  }
  return { prisma: prisma as never, calls };
}

describe('resolveEntityRefs — una consulta por tipo, nunca por fila', () => {
  it('agrupa los ids por tipo, sin repetir, y arma el código y el enlace', async () => {
    const { prisma, calls } = prismaWith({
      salesOrder: [
        { id: U(1), seq: 31 },
        { id: U(2), seq: 7 },
      ],
      coil: [{ id: U(3), code: 'DEMACE-GALV-0.45-2500-106' }],
      customer: [{ id: U(4), name: 'Cliente Demo', docNumber: '99999901' }],
    });
    const refs = await resolveEntityRefs(prisma, [
      { entityType: 'sales_orders', entityId: U(1) },
      { entityType: 'sales_orders', entityId: U(2) },
      { entityType: 'sales_orders', entityId: U(1) },
      { entityType: 'coils', entityId: U(3) },
      { entityType: 'customers', entityId: U(4) },
      { entityType: 'sales_settings', entityId: '1' },
      { entityType: 'users', entityId: null },
    ]);
    expect(calls.salesOrder).toHaveBeenCalledTimes(1);
    expect(calls.salesOrder!.mock.calls[0]![0].where?.id?.in).toEqual([U(1), U(2)]);
    expect(calls.coil).toHaveBeenCalledTimes(1);
    expect(calls.customer).toHaveBeenCalledTimes(1);
    expect(refs.get(refKey('sales_orders', U(1)))).toEqual({
      code: 'PED-000031',
      href: `/pedidos/${U(1)}`,
    });
    expect(refs.get(refKey('coils', U(3)))?.href).toBe(`/bobinas/${U(3)}`);
    expect(refs.get(refKey('customers', U(4)))).toEqual({
      code: 'Cliente Demo',
      href: '/clientes?search=99999901',
    });
    // Un tipo fijo (la configuración) no consulta.
    expect(refs.get(refKey('sales_settings', '1'))?.code).toBe('Configuración de ventas');
  });

  it('un id sin forma de UUID no llega a la base', async () => {
    const { prisma, calls } = prismaWith({ coil: [] });
    await resolveEntityRefs(prisma, [{ entityType: 'coils', entityId: 'no-es-uuid' }]);
    expect(calls.coil).not.toHaveBeenCalled();
  });
});

describe('entityDisplay — lo que muestra la fila', () => {
  const event = (over: Partial<Parameters<typeof entityDisplay>[0]> = {}) => ({
    entityType: 'coils',
    entityId: U(9),
    before: null,
    after: null,
    ...over,
  });

  it('la entidad viva: su código y su enlace', () => {
    const refs = new Map([[refKey('coils', U(9)), { code: 'B-1', href: `/bobinas/${U(9)}` }]]);
    expect(entityDisplay(event(), refs)).toEqual({
      entityCode: 'B-1',
      entityHref: `/bobinas/${U(9)}`,
      entityDeleted: false,
    });
  });

  it('borrada sin nada guardado: «Eliminado» y los 8 primeros del id, sin enlace', () => {
    expect(entityDisplay(event(), new Map())).toEqual({
      entityCode: `Eliminado · ${U(9).slice(0, 8)}`,
      entityHref: null,
      entityDeleted: true,
    });
  });

  it('borrada con el código en su detalle: ese código, marcada como borrada', () => {
    const shown = entityDisplay(event({ before: { code: 'B-VIEJA', weightKg: '10' } }), new Map());
    expect(shown).toEqual({ entityCode: 'B-VIEJA', entityHref: null, entityDeleted: true });
  });

  it('sin entidad, nada; un tipo desconocido muestra su id sin decir que se borró', () => {
    expect(entityDisplay(event({ entityId: null }), new Map()).entityCode).toBeNull();
    expect(entityDisplay(event({ entityType: 'otra_cosa' }), new Map())).toEqual({
      entityCode: U(9),
      entityHref: null,
      entityDeleted: false,
    });
  });

  it('storedCode prefiere `after` y salta los vacíos', () => {
    expect(storedCode({ name: 'Antes' }, { name: 'Después' })).toBe('Después');
    expect(storedCode({ sku: 'SKU-1' }, { sku: '  ' })).toBe('SKU-1');
    expect(storedCode({ weightKg: '1' }, null)).toBeNull();
  });
});

describe('searchEntityIds — el buscar por código legible', () => {
  it('un correlativo va directo a su tipo, con o sin ceros y guion', async () => {
    for (const text of ['PED-000031', 'ped31', 'Ped-31']) {
      const { prisma, calls } = prismaWith({ salesOrder: [{ id: U(1) }], coil: [] });
      const found = await searchEntityIds(prisma, text);
      expect(calls.salesOrder!.mock.calls[0]![0]).toEqual({
        where: { seq: 31 },
        select: { id: true },
      });
      expect(calls.coil).not.toHaveBeenCalled();
      expect(found.refs.get('sales_orders')).toEqual([U(1)]);
    }
  });

  it('un correlativo que no existe no deja una lista vacía (que rompería el SQL del buscar)', async () => {
    const { prisma } = prismaWith({ salesOrder: [] });
    const found = await searchEntityIds(prisma, 'PED-999999');
    expect(found.refs.size).toBe(0);
    expect(found.capped).toBe(false);
  });

  it('más coincidencias que el tope: corta en el tope, en orden fijo, y lo avisa', async () => {
    const many = Array.from({ length: SEARCH_IDS_PER_TYPE + 1 }, (_, i) => ({ id: U(i + 1) }));
    const { prisma } = prismaWith({
      coil: many,
      product: [],
      customer: [],
      supplier: [],
      fiscalDocument: [],
      purchase: [],
      user: [],
    });
    const found = await searchEntityIds(prisma, 'demo');
    expect(found.refs.get('coils')).toHaveLength(SEARCH_IDS_PER_TYPE);
    expect(found.capped).toBe(true);
  });

  it('otro texto busca «contiene» en códigos y nombres, una consulta por tipo y con tope', async () => {
    const tables = {
      coil: [{ id: U(1) }],
      product: [],
      customer: [{ id: U(2) }],
      supplier: [],
      fiscalDocument: [],
      purchase: [],
      user: [],
    };
    const { prisma, calls } = prismaWith(tables);
    const found = await searchEntityIds(prisma, ' demo ');
    for (const model of Object.keys(tables)) expect(calls[model]).toHaveBeenCalledTimes(1);
    expect(calls.coil!.mock.calls[0]![0]).toEqual({
      where: { code: { contains: 'demo', mode: 'insensitive' } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: SEARCH_IDS_PER_TYPE + 1,
    });
    expect([...found.refs.keys()].sort()).toEqual(['coils', 'customers']);
    expect(found.capped).toBe(false);
  });
});

describe('likePattern — el buscar es texto, no comodines', () => {
  it('escapa % _ y la barra invertida', () => {
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('c\\d')).toBe('%c\\\\d%');
  });
});

describe('resolveEntityRefs — todos los tipos de la auditoría tienen código', () => {
  /** Una fila con todo lo que algún resolver lee, para cualquier modelo. */
  const row = (id: string) => ({
    id,
    seq: 7,
    code: 'COD-1',
    name: 'Nombre',
    sku: 'SKU-1',
    number: '00000012',
    series: 'F001',
    docNumber: '20123456789',
    date: new Date('2026-10-01T00:00:00Z'),
    operationDate: new Date('2026-10-02T00:00:00Z'),
    parentCoilId: U(90),
    parentCoil: { code: 'B-MADRE' },
    documentId: U(91),
    document: { number: 'F001-00000012' },
    supplier: { name: 'Proveedor' },
    businessLine: { code: 'drywall' },
    product: { sku: 'SKU-PROD' },
    salesOrderId: U(92),
    salesOrder: { seq: 31 },
    user: { name: 'Usuario' },
    fiscalDocumentId: U(93),
  });
  const anyModel = {
    findMany: jest.fn((args: FindArgs) => Promise.resolve((args.where?.id?.in ?? []).map(row))),
  };
  const prisma = new Proxy({}, { get: () => anyModel }) as never;

  it.each(AUDIT_ENTITY_TYPES)('%s', async (entityType) => {
    const refs = await resolveEntityRefs(prisma, [{ entityType, entityId: U(1) }]);
    const found = refs.get(refKey(entityType, U(1)));
    expect(found?.code).toBeTruthy();
    expect(found?.code).not.toMatch(/undefined|null/);
    if (found?.href) expect(found.href).toMatch(/^\/[a-z]/);
  });
});
