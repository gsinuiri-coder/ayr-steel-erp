import {
  auditActionLabel,
  auditActionOptions,
  auditChangedKeys,
  auditDetailText,
  auditEntityTypeLabel,
  auditFieldLabel,
  auditFieldValueLabel,
  auditTextSearchApplies,
  auditValueText,
  isPriceListValueField,
} from '@ayr/shared';

describe('auditFieldLabel', () => {
  it('traduce las claves conocidas de los tres changelogs dedicados', () => {
    expect(auditFieldLabel('valuePen')).toBe('Precio de lista');
    expect(auditFieldLabel('listPricePen')).toBe('Precio de lista');
    expect(auditFieldLabel('lineNumber')).toBe('Línea');
    expect(auditFieldLabel('unitValuePen')).toBe('Precio unitario (sin IGV)');
    expect(auditFieldLabel('valuePerMeterPen')).toBe('Precio por metro (sin IGV)');
    expect(auditFieldLabel('origin')).toBe('Origen');
    expect(auditFieldLabel('batchId')).toBe('Lote');
    expect(auditFieldLabel('revertsBatchId')).toBe('Revierte al lote');
    expect(auditFieldLabel('issueDate')).toBe('Fecha de emisión');
    expect(auditFieldLabel('dueDate')).toBe('Fecha de vencimiento');
    expect(auditFieldLabel('reason')).toBe('Motivo');
  });

  it('nunca deja una clave nueva sin leer: la separa en palabras en vez de mostrarla pegada', () => {
    expect(auditFieldLabel('someBrandNewFieldPen')).toBe('Some brand new field pen');
    expect(auditFieldLabel('snake_case_field')).toBe('Snake case field');
  });
});

describe('auditFieldValueLabel', () => {
  it('traduce los valores conocidos de origin', () => {
    expect(auditFieldValueLabel('origin', 'INLINE')).toBe('Edición en catálogo');
    expect(auditFieldValueLabel('origin', 'IMPORT')).toBe('Carga masiva');
  });

  it('devuelve null para un valor sin traducción conocida', () => {
    expect(auditFieldValueLabel('origin', 'ALGO_NUEVO')).toBeNull();
    expect(auditFieldValueLabel('batchId', 'abc123')).toBeNull();
    expect(auditFieldValueLabel('origin', null)).toBeNull();
  });
});

describe('isPriceListValueField', () => {
  it('reconoce el precio de lista en su changelog dedicado', () => {
    expect(
      isPriceListValueField('product_list_price_change', 'product_list_price_change', 'valuePen'),
    ).toBe(true);
  });

  it('reconoce el precio de lista dentro del before/after de catalog.update', () => {
    expect(isPriceListValueField('audit_log', 'catalog.update', 'listPricePen')).toBe(true);
  });

  it('no confunde otros campos de catalog.update con el precio de lista', () => {
    expect(isPriceListValueField('audit_log', 'catalog.update', 'name')).toBe(false);
    expect(isPriceListValueField('audit_log', 'catalog.create', 'listPricePen')).toBe(false);
  });

  it('no confunde valuePen de otra fuente con el precio de lista', () => {
    expect(isPriceListValueField('sales_price_change', 'sales_price_change', 'valuePen')).toBe(
      false,
    );
  });
});

/** cc48: los rótulos y el detalle viven en `@ayr/shared` y los usan la pantalla y el Excel. */
describe('auditActionLabel, auditEntityTypeLabel y auditActionOptions (cc48)', () => {
  it('rotula las acciones conocidas y las de los changelogs; lo desconocido se lee igual', () => {
    expect(auditActionLabel('auth.login', 'audit_log')).toBe('Inicio de sesión');
    expect(auditActionLabel('sales_price_change', 'sales_price_change')).toBe(
      'Cambio de precio de línea',
    );
    expect(auditActionLabel('algo.nuevo-raro', 'audit_log')).toBe('Algo nuevo raro');
    expect(auditEntityTypeLabel('coils')).toBe('Bobinas');
    expect(auditEntityTypeLabel('otra_cosa')).toBe('Otra cosa');
  });

  it('las opciones del filtro «Acción»: sin repetir, ordenadas por rótulo, con los changelogs', () => {
    const options = auditActionOptions();
    const values = options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('product_list_price_change');
    const labels = options.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'es')));
  });
});

describe('auditDetailText (cc48, el detalle del Excel)', () => {
  const base = { source: 'audit_log', action: 'coils.update' };
  it('un renglón por campo que cambió, con «antes → después»', () => {
    expect(
      auditDetailText({
        ...base,
        before: { status: 'OPEN', weightKg: '1' },
        after: { status: 'CLOSED', weightKg: '1' },
      }),
    ).toBe('Estado: Vigente → Terminada');
    expect(
      auditDetailText({
        ...base,
        before: null,
        after: { origin: 'IMPORT', n: 3, ok: true, x: { a: 1 } },
      }),
    ).toBe('Origen: Carga masiva\nN: 3\nOk: Sí\nX: {"a":1}');
    expect(auditDetailText({ ...base, before: { reason: null }, after: null })).toBe('Motivo: —');
    expect(auditDetailText({ ...base, before: null, after: null })).toBe('Sin detalle registrado.');
  });

  it('el precio de lista, con IGV y 2 decimales; vacío, una raya', () => {
    const price = { source: 'product_list_price_change', action: 'product_list_price_change' };
    expect(auditValueText({ ...price, before: null, after: null }, 'valuePen', '100.0000')).toBe(
      'S/ 118.00',
    );
    expect(auditValueText({ ...price, before: null, after: null }, 'valuePen', null)).toBe('—');
    expect(
      auditChangedKeys({ ...price, before: { valuePen: '1' }, after: { valuePen: '1' } }),
    ).toEqual([]);
  });
});

describe('auditTextSearchApplies (cc48, regla del dueño)', () => {
  const today = '2026-10-12';
  it('sin fechas: sí, salvo el historial de un documento (12 meses)', () => {
    expect(auditTextSearchApplies(undefined, undefined, today)).toBe(true);
    expect(auditTextSearchApplies('', '', today, true)).toBe(false);
  });
  it('con fechas: hasta 31 días', () => {
    expect(auditTextSearchApplies('2026-09-11', undefined, today)).toBe(true);
    expect(auditTextSearchApplies('2026-09-10', undefined, today)).toBe(false);
    expect(auditTextSearchApplies('2026-01-01', '2026-01-31', today)).toBe(true);
  });
});
