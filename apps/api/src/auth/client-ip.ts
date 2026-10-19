import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * cc59 (D-692): **la IP real del cliente, firmada por la web.** El login pasa por el proxy de la web
 * en Vercel, así que el API ve la IP de salida de Vercel, la misma para toda la empresa. La web le
 * pasa la IP que Vercel le da (`x-real-ip`) en `x-ayr-client-ip`, con el instante en
 * `x-ayr-client-ip-ts` y una firma HMAC-SHA256 de `<ip>.<ts>` con `AYR_CLIENT_IP_SECRET` en
 * `x-ayr-client-ip-sig` (base64url). El API solo le cree si la firma coincide (en tiempo constante)
 * y tiene menos de 60 s. Si no, la ignora: nunca bloquea el login por eso.
 *
 * El formato lo repite `apps/web/src/lib/client-ip-signature.ts`; los dos prueban el mismo vector.
 */
export const CLIENT_IP_HEADER = 'x-ayr-client-ip';
export const CLIENT_IP_TS_HEADER = 'x-ayr-client-ip-ts';
export const CLIENT_IP_SIG_HEADER = 'x-ayr-client-ip-sig';
export const CLIENT_IP_MAX_AGE_MS = 60_000;

export type ClientIpCheck =
  | { ok: true; ip: string }
  | { ok: false; reason: 'no-secret' | 'absent' | 'malformed' | 'expired' | 'bad-signature' };

type Headers = Record<string, string | string[] | undefined>;

const one = (h: Headers, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function signClientIp(secret: string, ip: string, ts: string): string {
  return createHmac('sha256', secret).update(`${ip}.${ts}`).digest('base64url');
}

export function verifyClientIp(
  headers: Headers,
  secret: string | undefined,
  now: number,
): ClientIpCheck {
  const ip = one(headers, CLIENT_IP_HEADER);
  const ts = one(headers, CLIENT_IP_TS_HEADER);
  const sig = one(headers, CLIENT_IP_SIG_HEADER);
  if (!secret) return { ok: false, reason: 'no-secret' };
  if (ip === undefined && ts === undefined && sig === undefined) {
    return { ok: false, reason: 'absent' };
  }
  if (!ip || !ts || !sig || isIP(ip) === 0 || !/^\d{13}$/.test(ts)) {
    return { ok: false, reason: 'malformed' };
  }
  const age = now - Number(ts);
  if (age > CLIENT_IP_MAX_AGE_MS || age < -CLIENT_IP_MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }
  const expected = Buffer.from(signClientIp(secret, ip, ts));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, ip };
}

/**
 * cc59 (D-694): la clave con que se cuentan los intentos de una IP. Es un hash con el secreto, nunca
 * la IP en claro: queda en `audit_log` (solo inserciones) y, al rotar el secreto, deja de
 * corresponder a cualquier IP. 43 caracteres, cabe en `entity_id`.
 */
export function loginIpKey(secret: string, ip: string): string {
  return createHmac('sha256', secret)
    .update(`login-ip:${ipBucket(ip)}`)
    .digest('base64url');
}

/**
 * Lo que se cuenta junto: la IPv4 entera y, en IPv6, su /64 (revisión de cc59, P2): un cliente con
 * un /64 rota direcciones dentro de él sin costo. Una IPv4 mapeada (`::ffff:a.b.c.d`) es la IPv4.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
