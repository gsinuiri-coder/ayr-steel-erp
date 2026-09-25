import { Role } from '@prisma/client';
import { fiscalDocumentQuerySchema, LIVE_DOCUMENT_STATUSES } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { fiscalDocumentListWhere } from './fiscal-document-where';

// D-297: el alcance del vendedor y la búsqueda no compiten por `where.OR`.
const vendor = { id: 'seller-a', role: Role.VENDEDOR } as RequestUser;
const admin = { id: 'admin-1', role: Role.ADMINISTRADOR } as RequestUser;

function where(query: Record<string, unknown>, actor: RequestUser | undefined) {
  return fiscalDocumentListWhere(
    fiscalDocumentQuerySchema.parse(query),
    actor,
    LIVE_DOCUMENT_STATUSES,
  );
}

const scopeOr = [
  { createdById: 'seller-a' },
  { salesOrder: { sellerId: 'seller-a' } },
  { dispatch: { salesOrder: { sellerId: 'seller-a' } } },
];

describe('fiscalDocumentListWhere', () => {
  it('un vendedor sin búsqueda: solo su alcance', () => {
    const w = where({}, vendor);
    expect(w.AND).toEqual([{ OR: scopeOr }]);
    expect(w.OR).toBeUndefined();
  });

  it('un vendedor que busca: el alcance Y la búsqueda, cada uno en su OR (nunca uno pisa al otro)', () => {
    const w = where({ search: 'Cliente ajeno' }, vendor);
    expect(w.OR).toBeUndefined();
    const and = w.AND as { OR: unknown[] }[];
    expect(and).toHaveLength(2);
    expect(and[0]).toEqual({ OR: scopeOr });
    // La segunda alternativa es la búsqueda: número, nombre o documento del cliente.
    expect(and[1]?.OR).toHaveLength(3);
    expect(JSON.stringify(and[1])).toContain('Cliente ajeno');
    // La condición de alcance sigue estando, tal cual, después de agregar la búsqueda.
    expect(JSON.stringify(w)).toContain('"sellerId":"seller-a"');
  });

  it('el administrador que busca: solo la búsqueda, sin alcance', () => {
    const w = where({ search: 'FFA1-1' }, admin);
    const and = w.AND as { OR: unknown[] }[];
    expect(and).toHaveLength(1);
    expect(JSON.stringify(and[0])).toContain('FFA1-1');
    expect(JSON.stringify(w)).not.toContain('sellerId');
  });

  it('sin actor (uso interno) y sin búsqueda: sin AND', () => {
    expect(where({}, undefined).AND).toBeUndefined();
  });

  it('pendingOnly sigue acotando estado y tipo, y conserva el alcance del vendedor', () => {
    const w = where({ pendingOnly: 'true', search: 'x' }, vendor);
    expect(w.status).toEqual({ in: [...LIVE_DOCUMENT_STATUSES] });
    expect(w.docType).toEqual({ in: ['FACTURA', 'BOLETA'] });
    expect((w.AND as unknown[]).length).toBe(2);
  });
});
