import { NextResponse } from 'next/server';
import { buildInfo } from '@/lib/build-info';

/**
 * D-636: qué commit está publicado. Público y sin caché: lo consulta `smoke:prod` hasta que
 * coincida con `main`. Solo el sha y la fecha del build; nada del negocio ni secretos.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  // Las dos referencias van literales: Next las reemplaza en el build con lo que fijó
  // `next.config.ts#env`. Leídas de otra forma (`process.env[x]`) quedarían vacías.
  const info = buildInfo({
    AYR_BUILD_SHA: process.env.AYR_BUILD_SHA,
    AYR_BUILT_AT: process.env.AYR_BUILT_AT,
  });
  return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store' } });
}
