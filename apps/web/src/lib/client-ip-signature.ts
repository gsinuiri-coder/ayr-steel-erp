import { createHmac } from 'node:crypto';

/**
 * cc59 (D-692): la IP real del cliente que el proxy de la web le pasa al API, firmada con el secreto
 * compartido (`AYR_CLIENT_IP_SECRET`). Solo en el servidor (el route handler de `/api/*`). El
 * formato lo verifica `apps/api/src/auth/client-ip.ts`; los dos prueban el mismo vector.
 */
export const CLIENT_IP_HEADERS = ['x-ayr-client-ip', 'x-ayr-client-ip-ts', 'x-ayr-client-ip-sig'];

export function signClientIp(secret: string, ip: string, ts: string): string {
  return createHmac('sha256', secret).update(`${ip}.${ts}`).digest('base64url');
}

/**
 * La IP que da Vercel: `x-real-ip`, o el primer valor de `x-forwarded-for`. Vercel sobrescribe las
 * dos en su borde, así que el navegador no las puede falsear.
 */
export function clientIpOf(headers: Headers): string | null {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!first) return null;
  return first;
}

/**
 * Prepara las cabeceras hacia el API: **siempre** borra las de la IP que haya mandado el navegador
 * (el proxy reenvía todo) y, en el login y con secreto, pone la IP real con su firma.
 */
export function applyClientIpHeaders(
  out: Headers,
  incoming: Headers,
  path: string,
  secret: string | undefined,
  now: number,
): void {
  for (const h of CLIENT_IP_HEADERS) out.delete(h);
  if (path !== 'auth/login' || !secret) return;
  const ip = clientIpOf(incoming);
  if (!ip) return;
  const ts = String(now);
  out.set('x-ayr-client-ip', ip);
  out.set('x-ayr-client-ip-ts', ts);
  out.set('x-ayr-client-ip-sig', signClientIp(secret, ip, ts));
}
