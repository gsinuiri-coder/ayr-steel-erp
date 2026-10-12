import { describe, expect, it } from 'vitest';
import {
  AUDIT_URL_DEFAULTS,
  auditActiveFilterCount,
  auditDefaultPeriodLabel,
  auditParamsOf,
  auditSearchNotice,
} from './audit-url';

const url = (over: Partial<typeof AUDIT_URL_DEFAULTS> = {}) => ({ ...AUDIT_URL_DEFAULTS, ...over });

describe('cc48 (D-634): la auditoría en la URL', () => {
  it('sin nada puesto, ningún parámetro', () => {
    expect(auditParamsOf(url()).toString()).toBe('');
  });

  it('el buscar y los filtros viajan tal cual al API; el buscar, recortado', () => {
    const params = auditParamsOf(
      url({
        search: '  PED-000031  ',
        actorId: 'u-1',
        action: 'sales.order.cancel',
        from: '2026-10-01',
        to: '2026-10-12',
      }),
    );
    expect(params.get('search')).toBe('PED-000031');
    expect(params.get('actorId')).toBe('u-1');
    expect(params.get('action')).toBe('sales.order.cancel');
    expect(params.get('from')).toBe('2026-10-01');
    expect(params.get('to')).toBe('2026-10-12');
    expect(auditParamsOf(url({ search: 'x'.repeat(100) })).get('search')).toHaveLength(80);
  });

  it('el id de la entidad solo viaja con su tipo', () => {
    expect(auditParamsOf(url({ entityId: 'abc' })).has('entityId')).toBe(false);
    const withType = auditParamsOf(url({ entityType: 'sales_orders', entityId: 'abc' }));
    expect(withType.get('entityType')).toBe('sales_orders');
    expect(withType.get('entityId')).toBe('abc');
  });

  it('el contador de «Filtros» cuenta el periodo una vez', () => {
    expect(auditActiveFilterCount(url())).toBe(0);
    expect(auditActiveFilterCount(url({ from: '2026-10-01', to: '2026-10-12' }))).toBe(1);
    expect(auditActiveFilterCount(url({ entityType: 'coils', actorId: 'u', action: 'a' }))).toBe(3);
  });

  it('D-635: sin fechas, el historial de un documento dice 12 meses; el resto, 31 días', () => {
    expect(auditDefaultPeriodLabel(url())).toBe('Últimos 31 días');
    expect(auditDefaultPeriodLabel(url({ entityType: 'coils', entityId: 'x' }))).toBe(
      'Últimos 12 meses',
    );
    expect(auditDefaultPeriodLabel(url({ from: '2026-10-01' }))).toBeNull();
  });
});

describe('cc48 (D-634): el aviso del buscar con periodo largo', () => {
  const today = '2026-10-12';
  it('sin buscar o con 31 días o menos, sin aviso', () => {
    expect(auditSearchNotice(url(), today)).toBeNull();
    expect(auditSearchNotice(url({ search: 'demo' }), today)).toBeNull();
    expect(auditSearchNotice(url({ search: 'demo', from: '2026-09-11' }), today)).toBeNull();
  });

  it('con más de 31 días, avisa que solo busca por código', () => {
    expect(auditSearchNotice(url({ search: 'demo', from: '2026-09-10' }), today)).toMatch(
      /solo por código/,
    );
    expect(
      auditSearchNotice(url({ search: 'demo', from: '2026-01-01', to: '2026-01-31' }), today),
    ).toBeNull();
    // El historial de un documento sin fechas usa 12 meses.
    expect(
      auditSearchNotice(url({ search: 'demo', entityType: 'coils', entityId: 'x' }), today),
    ).toMatch(/solo por código/);
  });
});
