import { NextResponse, type NextRequest } from 'next/server';

const REFRESH_COOKIE = 'ayr_refresh';
const ACCESS_COOKIE = 'ayr_access';
const PUBLIC_PATHS = ['/login'];
/**
 * D-636: abiertas con o sin sesión. `/version` no va en `PUBLIC_PATHS` porque esas, con sesión,
 * redirigen al inicio.
 */
const OPEN_PATHS = ['/version'];

/**
 * Redirección rápida por presencia de cookie. La validación real la hace el API
 * en cada request (`SessionProvider` redirige a /login si /auth/me falla).
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.includes(pathname)) return NextResponse.next();
  const hasSession = req.cookies.has(REFRESH_COOKIE) || req.cookies.has(ACCESS_COOKIE);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!hasSession && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
    return NextResponse.redirect(url);
  }
  if (hasSession && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Excluye /api (proxy al API), estáticos e imágenes.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*[.](?:svg|png|jpg|ico)).*)'],
};
