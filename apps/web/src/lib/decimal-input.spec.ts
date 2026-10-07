import { describe, expect, it } from 'vitest';
import { normalizeDecimalInput } from './decimal-input';

/** cc31: la coma decimal se acepta en todos los campos numéricos (ESPEC §6). */
describe('campo numérico', () => {
  it('una coma sola es la coma decimal', () => {
    expect(normalizeDecimalInput('12,5')).toBe('12.5');
    expect(normalizeDecimalInput('0,125')).toBe('0.125');
  });

  it('«1,500» es ambiguo y queda como está: la validación pide el punto', () => {
    expect(normalizeDecimalInput('1,500')).toBe('1,500');
    expect(normalizeDecimalInput('5,000')).toBe('5,000');
    expect(normalizeDecimalInput('12,500')).toBe('12,500');
    expect(normalizeDecimalInput('1,5000')).toBe('1.5000');
  });

  it('con punto o varias comas, las comas son miles', () => {
    expect(normalizeDecimalInput('4,027.44')).toBe('4027.44');
    expect(normalizeDecimalInput('1,500,000')).toBe('1500000');
  });

  it('quita espacios y no toca lo que ya está bien ni lo que no es número', () => {
    expect(normalizeDecimalInput(' 15 ')).toBe('15');
    expect(normalizeDecimalInput('15.250')).toBe('15.250');
    expect(normalizeDecimalInput('abc')).toBe('abc');
    expect(normalizeDecimalInput('1.2.3')).toBe('1.2.3');
    expect(normalizeDecimalInput('')).toBe('');
  });
});
