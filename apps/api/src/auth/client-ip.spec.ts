import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIG_HEADER,
  CLIENT_IP_TS_HEADER,
  ipBucket,
  loginIpKey,
  signClientIp,
  verifyClientIp,
} from './client-ip';

/** cc59 (D-692): la IP del cliente firmada por la web. */
const SECRET = 'secreto-de-prueba-0123456789abcdef0123456789';
const NOW = 1_760_000_000_000;

const signed = (ip: string, ts: number, secret = SECRET) => ({
  [CLIENT_IP_HEADER]: ip,
  [CLIENT_IP_TS_HEADER]: String(ts),
  [CLIENT_IP_SIG_HEADER]: signClientIp(secret, ip, String(ts)),
});

describe('verifyClientIp', () => {
  it('firma válida y reciente: cree la IP', () => {
    expect(verifyClientIp(signed('190.42.1.7', NOW - 5_000), SECRET, NOW)).toEqual({
      ok: true,
      ip: '190.42.1.7',
    });
    expect(verifyClientIp(signed('2800:200::1', NOW), SECRET, NOW)).toEqual({
      ok: true,
      ip: '2800:200::1',
    });
  });

  it('firma inválida: con otro secreto o con la IP cambiada', () => {
    expect(
      verifyClientIp(
        signed('190.42.1.7', NOW, 'otro-secreto-xxxxxxxxxxxxxxxxxxxxxxxx'),
        SECRET,
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    const forged = { ...signed('190.42.1.7', NOW), [CLIENT_IP_HEADER]: '10.0.0.1' };
    expect(verifyClientIp(forged, SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('vencida: más de 60 s, hacia atrás o hacia adelante', () => {
    expect(verifyClientIp(signed('190.42.1.7', NOW - 61_000), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyClientIp(signed('190.42.1.7', NOW + 61_000), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('ausente, incompleta o sin secreto: no cree nada', () => {
    expect(verifyClientIp({}, SECRET, NOW)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyClientIp({ [CLIENT_IP_HEADER]: '190.42.1.7' }, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyClientIp({ ...signed('no-es-ip', NOW) }, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyClientIp(signed('190.42.1.7', NOW), undefined, NOW)).toEqual({
      ok: false,
      reason: 'no-secret',
    });
  });

  it('el vector que también prueba la web (mismo formato de firma)', () => {
    expect(signClientIp('k', '1.2.3.4', '1760000000000')).toBe(
      'GnmF5uxJ161SC8yqdMAvnK6IXNqKR8rVo_eMDtbyFfE',
    );
  });
});

describe('ipBucket', () => {
  it('IPv4 entera; IPv6 por su /64; IPv4 mapeada como IPv4', () => {
    expect(ipBucket('190.42.1.7')).toBe('190.42.1.7');
    expect(ipBucket('2800:200:e840:1f2a:1:2:3:4')).toBe('2800:200:e840:1f2a::/64');
    expect(ipBucket('2800:0200::1')).toBe('2800:200:0:0::/64');
    expect(ipBucket('::ffff:190.42.1.7')).toBe('190.42.1.7');
    // Dos direcciones del mismo /64 cuentan juntas.
    expect(loginIpKey(SECRET, '2800:200:e840:1f2a::a')).toBe(
      loginIpKey(SECRET, '2800:200:e840:1f2a:ffff::1'),
    );
  });

  // cc65 (SEC-03 de audit-02): toda escritura de la IPv4 mapeada es la IPv4.
  it.each([
    '::ffff:102:304',
    '::FFFF:1.2.3.4',
    '0:0:0:0:0:ffff:1.2.3.4',
    '0000:0000:0000:0000:0000:ffff:0102:0304',
  ])('%s es 1.2.3.4', (form) => {
    expect(ipBucket(form)).toBe('1.2.3.4');
  });

  it('::1 no comparte clave con una IPv4 mapeada', () => {
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(loginIpKey(SECRET, '::1')).not.toBe(loginIpKey(SECRET, '::ffff:102:304'));
  });

  it('una IPv6 con IPv4 incrustada fuera del rango mapeado sigue por su /64', () => {
    expect(ipBucket('2800:200::1.2.3.4')).toBe('2800:200:0:0::/64');
  });
});

describe('loginIpKey', () => {
  it('dos IP no se mezclan, no deja la IP en claro y cabe en entity_id', () => {
    const a = loginIpKey(SECRET, '190.42.1.7');
    const b = loginIpKey(SECRET, '190.42.1.8');
    expect(a).not.toBe(b);
    expect(a).not.toContain('190.42');
    expect(a).toHaveLength(43);
    // Con otro secreto (rotado), la misma IP da otra clave.
    expect(loginIpKey('otro-secreto-xxxxxxxxxxxxxxxxxxxxxxxx', '190.42.1.7')).not.toBe(a);
  });
});
