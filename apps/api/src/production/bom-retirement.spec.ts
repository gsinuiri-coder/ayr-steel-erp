import { AuditActorKind, type Prisma } from '@prisma/client';
import { findActiveBoms, retireActiveBoms } from './bom-retirement';

/**
 * D-344 — la retirada de recetas: se desactivan por el servicio de dominio, con una fila de
 * auditoría por receta, y repetirla no hace nada.
 */

const D = (v: string) => ({ toFixed: () => v });

function bom(id: string, sku: string) {
  return {
    id,
    productId: `p-${id}`,
    kind: 'DRYWALL',
    inputThicknessMm: D('0.45'),
    inputWidthMm: D('115.00'),
    product: { sku },
  };
}

function build(active: ReturnType<typeof bom>[]) {
  let remaining = [...active];
  const tx = {
    productBom: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(remaining)),
      updateMany: jest.fn().mockImplementation((args: { where: { id: string } }) => {
        const had = remaining.some((b) => b.id === args.where.id);
        remaining = remaining.filter((b) => b.id !== args.where.id);
        return Promise.resolve({ count: had ? 1 : 0 });
      }),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, audit };
}

describe('findActiveBoms', () => {
  it('lista las recetas activas con su SKU y sus datos, sin escribir', async () => {
    const { tx, raw } = build([bom('1', 'OMEGA045')]);
    await expect(findActiveBoms(tx)).resolves.toEqual([
      {
        id: '1',
        productId: 'p-1',
        productSku: 'OMEGA045',
        kind: 'DRYWALL',
        inputThicknessMm: '0.45',
        inputWidthMm: '115.00',
      },
    ]);
    expect(raw.productBom.updateMany).not.toHaveBeenCalled();
  });

  it('una receta sin ancho de fleje se lista con «null»', async () => {
    const { tx } = build([{ ...bom('1', 'COB'), inputWidthMm: null } as never]);
    const [row] = await findActiveBoms(tx);
    expect(row?.inputWidthMm).toBeNull();
  });
});

describe('retireActiveBoms', () => {
  it('desactiva cada receta activa y deja una fila de auditoría de sistema por cada una', async () => {
    const { tx, raw, audit } = build([bom('1', 'OMEGA045'), bom('2', 'R39GALV045')]);
    const result = await retireActiveBoms(tx, audit);

    expect(result).toEqual({ retired: 2, skus: ['OMEGA045', 'R39GALV045'] });
    expect(raw.productBom.updateMany).toHaveBeenCalledWith({
      where: { id: '1', isActive: true },
      data: { isActive: false },
    });
    expect(audit.write).toHaveBeenCalledTimes(2);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorId: null,
        actorKind: AuditActorKind.SYSTEM,
        action: 'production.bom.retire',
        entity: 'product_boms',
        entityId: '1',
        before: expect.objectContaining({ sku: 'OMEGA045', isActive: true }) as unknown,
        after: { isActive: false },
      }),
    );
  });

  it('es idempotente: sin recetas activas no escribe nada', async () => {
    const { tx, raw, audit } = build([]);
    await expect(retireActiveBoms(tx, audit)).resolves.toEqual({ retired: 0, skus: [] });
    expect(raw.productBom.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('si otra sesión ya la desactivó entre la lectura y la escritura, no audita un cambio que no hizo ni la cuenta como propia', async () => {
    const { tx, raw, audit } = build([bom('1', 'OMEGA045')]);
    raw.productBom.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(retireActiveBoms(tx, audit)).resolves.toEqual({ retired: 0, skus: [] });
    expect(audit.write).not.toHaveBeenCalled();
  });
});
