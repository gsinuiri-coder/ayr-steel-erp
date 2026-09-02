import { request, type APIRequestContext } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Credenciales del admin: variables E2E_* o, en local, apps/api/.env. */
export function adminCredentials(): { email: string; password: string } {
  let email = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
  let password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    const envPath = resolve(__dirname, '../../apps/api/.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(ADMIN_EMAIL|ADMIN_PASSWORD)=(.*)$/);
        if (m?.[1] === 'ADMIN_EMAIL') email ??= m[2];
        if (m?.[1] === 'ADMIN_PASSWORD') password ??= m[2];
      }
    }
  }
  if (!email || !password) throw new Error('Faltan E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD');
  return { email, password };
}

/** Contexto de API autenticado como administrador (cookies httpOnly vía /api). */
export async function adminApi(baseURL: string): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL });
  const { email, password } = adminCredentials();
  const res = await api.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) throw new Error(`Login admin falló: ${res.status()} ${await res.text()}`);
  return api;
}

export interface CreatedUser {
  id: string;
  email: string;
  password: string;
  role: 'ADMINISTRADOR' | 'SUPERVISOR_PLANTA' | 'VENDEDOR';
}

/** Crea un usuario de prueba con correo único. */
export async function createUser(
  api: APIRequestContext,
  role: CreatedUser['role'],
  overrides: Partial<{ password: string; name: string }> = {},
): Promise<CreatedUser> {
  const email = `e2e-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@ayr.test`;
  const password = overrides.password ?? 'Temporal123!';
  const res = await api.post('/api/users', {
    data: { email, name: overrides.name ?? `Prueba ${role}`, role, password },
  });
  if (!res.ok()) throw new Error(`Crear usuario falló: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, email, password, role };
}
