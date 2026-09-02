import { NextResponse, type NextRequest } from 'next/server';

/**
 * Proxy same-origin hacia el API (D-015): el navegador solo habla con `/api/*`,
 * así las cookies httpOnly del API son first-party en el dominio del web.
 *
 * Se implementa como Route Handler (fetch server-side) en vez de `rewrites()` de
 * next.config.ts porque Vercel bloquea los rewrites declarativos hacia el dominio
 * por defecto de Cloud Run con `DNS_HOSTNAME_RESOLVED_PRIVATE` (falso positivo de
 * su protección SSRF contra las IPs de Google Frontend). Un fetch normal no pasa
 * por ese chequeo.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const HOP_BY_HOP_REQUEST_HEADERS = ['host', 'content-length', 'connection'];
const HOP_BY_HOP_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
];

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  const target = `${API_URL}/${path.join('/')}${req.nextUrl.search}`;

  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP_REQUEST_HEADERS) headers.delete(h);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });

  const responseHeaders = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP_RESPONSE_HEADERS) responseHeaders.delete(h);

  // `Headers` estándar colapsa varios Set-Cookie en uno solo separado por coma;
  // `getSetCookie()` (undici) preserva cada cookie por separado.
  const setCookies = upstream.headers.getSetCookie();
  if (setCookies.length > 0) {
    responseHeaders.delete('set-cookie');
    for (const cookie of setCookies) responseHeaders.append('set-cookie', cookie);
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handle(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const { path } = await params;
  return proxy(req, path);
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
