import { MAX_AUDIT_JSON_CHARS, sanitizeAuditJson } from './audit-redact';

/**
 * D-218/RF-S2: la segunda red contra un secreto que un llamador futuro meta por descuido en
 * `before`/`after` de `audit_log` — el visor de M3 lo va a mostrar a cualquier ADMINISTRADOR.
 */
describe('sanitizeAuditJson (D-218)', () => {
  it('null y undefined pasan igual', () => {
    expect(sanitizeAuditJson(null)).toBeNull();
    expect(sanitizeAuditJson(undefined)).toBeUndefined();
  });

  it('redacta claves que parecen un secreto, sin tocar el resto del objeto', () => {
    const out = sanitizeAuditJson({
      email: 'admin@ayr.test',
      passwordHash: '$argon2id$v=19$...',
      refreshToken: 'abc123',
      apiSecret: 'shh',
      name: 'Admin',
    });
    expect(out).toEqual({
      email: 'admin@ayr.test',
      passwordHash: '[redactado]',
      refreshToken: '[redactado]',
      apiSecret: '[redactado]',
      name: 'Admin',
    });
  });

  it('redacta dentro de objetos anidados y de arrays', () => {
    const out = sanitizeAuditJson({
      items: [{ token: 'x', qty: 1 }, { qty: 2 }],
      session: { nested: { password: 'y' } },
    });
    expect(out).toEqual({
      items: [{ token: '[redactado]', qty: 1 }, { qty: 2 }],
      session: { nested: { password: '[redactado]' } },
    });
  });

  it('un objeto que sigue siendo enorme después de redactar se reemplaza entero, no se corta a la mitad', () => {
    const huge = { blob: 'x'.repeat(MAX_AUDIT_JSON_CHARS + 1) };
    const out = sanitizeAuditJson(huge) as { truncated: boolean };
    expect(out.truncated).toBe(true);
  });
});
