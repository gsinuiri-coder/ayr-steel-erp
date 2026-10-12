import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function request(path: string, withSession: boolean): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    headers: withSession ? { cookie: 'ayr_refresh=x' } : {},
  });
}

/** `NextResponse.next()` no redirige: no lleva `location`. */
const redirectOf = (path: string, withSession: boolean) =>
  middleware(request(path, withSession)).headers.get('location');

describe('middleware (D-636)', () => {
  it('/version queda abierta con y sin sesión', () => {
    expect(redirectOf('/version', false)).toBeNull();
    expect(redirectOf('/version', true)).toBeNull();
  });

  it('solo la ruta exacta: /version/x y /versionx siguen cerradas sin sesión', () => {
    expect(redirectOf('/version/x', false)).toContain('/login');
    expect(redirectOf('/versionx', false)).toContain('/login');
  });

  it('/login con sesión sigue llevando al inicio', () => {
    expect(redirectOf('/login', true)).toBe('http://localhost:3001/');
  });
});
