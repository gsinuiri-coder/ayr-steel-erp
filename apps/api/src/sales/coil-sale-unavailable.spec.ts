import { Role } from '@prisma/client';
import { unavailableCoilReason } from './coil-sale-unavailable';

/**
 * D-282 — por qué una bobina con saldo no se ofrece para venderla entera. Lo que se fija: el
 * orden de los motivos (montada, pedido, cotización) y que a un VENDEDOR no se le nombra el
 * documento de otro vendedor (D-267/D-275).
 */

const ADMIN = { id: 'admin', role: Role.ADMINISTRADOR };
const ANA = { id: 'ana', role: Role.VENDEDOR };

describe('unavailableCoilReason', () => {
  it('montada en una OP manda sobre cualquier reserva', () => {
    expect(
      unavailableCoilReason(
        { mounted: true, firm: [{ seq: 3, sellerId: 'ana' }], temporary: [] },
        ADMIN,
      ),
    ).toBe('montada en una OP');
  });

  it('una reserva firme nombra el pedido de menor número que quien lee puede ver', () => {
    const firm = [
      { seq: 12, sellerId: 'ana' },
      { seq: 7, sellerId: 'beto' },
    ];
    expect(unavailableCoilReason({ mounted: false, firm, temporary: [] }, ADMIN)).toBe(
      'reservada por PED-000007',
    );
    expect(unavailableCoilReason({ mounted: false, firm, temporary: [] }, ANA)).toBe(
      'reservada por PED-000012',
    );
  });

  it('a un VENDEDOR no se le nombra el pedido de otro vendedor ni uno sin vendedor', () => {
    expect(
      unavailableCoilReason(
        {
          mounted: false,
          firm: [
            { seq: 7, sellerId: 'beto' },
            { seq: 8, sellerId: null },
          ],
          temporary: [],
        },
        ANA,
      ),
    ).toBe('reservada por un pedido');
  });

  it('la reserva temporal nombra la cotización propia y oculta la ajena', () => {
    const temporary = [{ seq: 2, sellerId: 'beto' }];
    expect(unavailableCoilReason({ mounted: false, firm: [], temporary }, ADMIN)).toBe(
      'atada a COT-000002 (reserva temporal)',
    );
    expect(unavailableCoilReason({ mounted: false, firm: [], temporary }, ANA)).toBe(
      'no disponible',
    );
    expect(
      unavailableCoilReason(
        { mounted: false, firm: [], temporary: [{ seq: 5, sellerId: 'ana' }] },
        ANA,
      ),
    ).toBe('atada a COT-000005 (reserva temporal)');
  });

  it('D-310: una cotización que la vende entera sin reservarla dice «atada a COT-…» como el pool', () => {
    const tied = [{ seq: 2, sellerId: 'beto' }];
    expect(unavailableCoilReason({ mounted: false, firm: [], temporary: [], tied }, ADMIN)).toBe(
      'atada a COT-000002',
    );
    expect(unavailableCoilReason({ mounted: false, firm: [], temporary: [], tied }, ANA)).toBe(
      'no disponible',
    );
    // La montada y la reserva firme siguen mandando sobre la cotización.
    expect(unavailableCoilReason({ mounted: true, firm: [], temporary: [], tied }, ADMIN)).toBe(
      'montada en una OP',
    );
  });

  it('sin titular conocido, un motivo genérico', () => {
    expect(unavailableCoilReason({ mounted: false, firm: [], temporary: [] }, ADMIN)).toBe(
      'sin saldo libre',
    );
  });
});
