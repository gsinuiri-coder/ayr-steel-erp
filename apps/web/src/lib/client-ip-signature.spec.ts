import { describe, expect, it } from 'vitest';
import { applyClientIpHeaders, clientIpOf, signClientIp } from './client-ip-signature';

/** cc59 (D-692): la firma de la IP del cliente en el proxy de la web. */
describe('client-ip-signature', () => {
  it('el mismo vector que verifica el API', () => {
    expect(signClientIp('k', '1.2.3.4', '1760000000000')).toBe(
      'GnmF5uxJ161SC8yqdMAvnK6IXNqKR8rVo_eMDtbyFfE',
    );
  });

  it('toma x-real-ip, o el primer valor de x-forwarded-for', () => {
    expect(clientIpOf(new Headers({ 'x-real-ip': '190.42.1.7' }))).toBe('190.42.1.7');
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '190.42.1.8, 10.0.0.1' }))).toBe(
      '190.42.1.8',
    );
    expect(clientIpOf(new Headers())).toBeNull();
  });

  it('con secreto firma la IP en toda petición; borra siempre lo que haya mandado el navegador', () => {
    const incoming = new Headers({ 'x-real-ip': '190.42.1.7', 'x-ayr-client-ip': '1.1.1.1' });
    const out = new Headers(incoming);
    applyClientIpHeaders(out, incoming, 'secreto', 1_760_000_000_000);
    expect(out.get('x-ayr-client-ip')).toBe('190.42.1.7');
    expect(out.get('x-ayr-client-ip-ts')).toBe('1760000000000');
    expect(out.get('x-ayr-client-ip-sig')).toBe(
      signClientIp('secreto', '190.42.1.7', '1760000000000'),
    );

    // Sin secreto, nada: y la copia del navegador tampoco pasa.
    const other = new Headers(incoming);
    applyClientIpHeaders(other, incoming, undefined, 1_760_000_000_000);
    expect(other.get('x-ayr-client-ip')).toBeNull();
    expect(other.get('x-ayr-client-ip-sig')).toBeNull();
  });
});
