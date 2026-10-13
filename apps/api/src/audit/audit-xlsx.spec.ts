import * as XLSX from 'xlsx';
import { Role, type AuditEventDto } from '@ayr/shared';
import { auditXlsx, limaDateTime } from './audit-xlsx';

/** cc48 (D-634): el Excel de la auditoría dice lo que dice la pantalla, con el código legible. */

const event = (over: Partial<AuditEventDto> = {}): AuditEventDto => ({
  id: '1',
  source: 'audit_log',
  occurredAt: '2026-10-12T14:05:09.000Z',
  actorId: '00000000-0000-4000-8000-000000000001',
  actorName: 'Administrador',
  actorKind: 'USER',
  action: 'sales.order.cancel',
  entityType: 'sales_orders',
  entityId: '00000000-0000-4000-8000-000000000031',
  entityCode: 'PED-000031',
  entityHref: '/pedidos/00000000-0000-4000-8000-000000000031',
  entityDeleted: false,
  before: { status: 'CONFIRMED' },
  after: { status: 'CANCELLED' },
  reason: 'El cliente lo pidió',
  ...over,
});

function grid(rows: AuditEventDto[]): unknown[][] {
  const file = auditXlsx(rows, Role.ADMINISTRADOR, '2026-10-12');
  const book = XLSX.read(file.buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['Auditoría']!, { header: 1 });
}

describe('auditXlsx (cc48, D-634)', () => {
  it('la hora va en Lima (UTC−5)', () => {
    expect(limaDateTime('2026-10-12T14:05:09.000Z')).toBe('2026-10-12 09:05:09');
    expect(limaDateTime('2026-10-12T02:00:00.000Z')).toBe('2026-10-11 21:00:00');
  });

  it('una fila por evento, con el código legible, el id completo, el motivo y el detalle', () => {
    const g = grid([event()]);
    const header = g[0] as string[];
    const row = g[1]!;
    const at = (h: string) => row[header.indexOf(h)];
    expect(at('Entidad')).toBe('PED-000031');
    expect(at('Id')).toBe('00000000-0000-4000-8000-000000000031');
    expect(at('Usuario')).toBe('Administrador');
    expect(at('Motivo')).toBe('El cliente lo pidió');
    expect(at('Detalle')).toBe('Estado: Confirmado → Anulado');
    expect(g.at(-1)?.[0]).toBe('Total (1 evento)');
  });

  it('una entidad borrada lo dice; el sistema figura como «Sistema»', () => {
    const g = grid([
      event({
        entityCode: 'Eliminado · 00000000',
        entityHref: null,
        entityDeleted: true,
        actorKind: 'SYSTEM',
        actorId: null,
        actorName: null,
        before: null,
        after: null,
      }),
    ]);
    const header = g[0] as string[];
    // «Eliminado · …» ya lo dice: sin repetirlo.
    expect(g[1]![header.indexOf('Entidad')]).toBe('Eliminado · 00000000');
    expect(g[1]![header.indexOf('Usuario')]).toBe('Sistema');
    expect(g[1]![header.indexOf('Detalle')]).toBe('Sin detalle registrado.');
  });

  it('un código guardado de una entidad borrada lleva la marca', () => {
    const g = grid([event({ entityCode: 'B-VIEJA', entityHref: null, entityDeleted: true })]);
    const header = g[0] as string[];
    expect(g[1]![header.indexOf('Entidad')]).toBe('B-VIEJA (eliminado)');
  });

  it('el precio de lista se muestra con IGV y 2 decimales, como en la pantalla', () => {
    const g = grid([
      event({
        source: 'product_list_price_change',
        action: 'product_list_price_change',
        before: { valuePen: '100.0000' },
        after: { valuePen: '110.0000' },
      }),
    ]);
    const header = g[0] as string[];
    expect(g[1]![header.indexOf('Detalle')]).toBe('Precio de lista: S/ 118.00 → S/ 129.80');
  });
});
