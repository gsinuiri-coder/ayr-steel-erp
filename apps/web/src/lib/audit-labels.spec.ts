import { describe, expect, it } from 'vitest';
import { auditFieldLabel, auditFieldValueLabel, isPriceListValueField } from './audit-labels';

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
