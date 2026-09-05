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

/** GET al API con el contexto ya autenticado; falla con el cuerpo real si no es 2xx. */
export async function getJson<T>(api: APIRequestContext, path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok()) throw new Error(`GET ${path} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** POST al API con el contexto ya autenticado; falla con el cuerpo real si no es 2xx. */
export async function postJson<T>(
  api: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await api.post(path, data === undefined ? undefined : { data });
  if (!res.ok()) throw new Error(`POST ${path} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Letras mayúsculas al azar: los códigos de proveedor (RF-13) no admiten dígitos. */
function randomLetters(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export interface CreatedSupplier {
  id: string;
  code: string;
  docNumber: string;
  name: string;
  isActive: boolean;
}

/**
 * Proveedor de prueba con código corto (RF-13) y RUC únicos. El código solo admite
 * 3-6 letras, así que la marca de prueba va en el nombre y en el prefijo `EE`.
 */
export async function createSupplier(
  api: APIRequestContext,
  overrides: Partial<{ code: string; docNumber: string; name: string }> = {},
): Promise<CreatedSupplier> {
  const code = overrides.code ?? `EE${randomLetters(4)}`;
  // Con solo `Date.now()` dos altas en el mismo milisegundo chocaban por RUC repetido, y
  // un escenario de esta suite crea tres proveedores seguidos: el sufijo aleatorio lo cierra.
  const docNumber =
    overrides.docNumber ??
    `20${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const name = overrides.name ?? `E2E Proveedor ${code}`;
  return postJson<CreatedSupplier>(api, '/api/suppliers', {
    code,
    docType: 'RUC',
    docNumber,
    name,
    creditDays: 0,
    providesCuttingService: false,
  });
}

export interface CreatedFinish {
  id: string;
  code: string;
  name: string;
}

/** Acabado de prueba con código único (entra en el código RF-13 de cada bobina). */
export async function createFinish(
  api: APIRequestContext,
  // `densityFactor` es override desde Fase 6: el kilo teórico de una cobertura sale de la
  // geometría de la bobina por ese factor (D-047), y una densidad redonda deja la aritmética
  // del test comprobable a ojo.
  overrides: Partial<{ code: string; name: string; densityFactor: string }> = {},
): Promise<CreatedFinish> {
  // Cuatro letras al azar chocaban de vez en cuando dentro de una misma corrida, y el 409
  // aparecía en un test que no tenía nada que ver con el acabado: el sufijo de reloj lo
  // vuelve único sin pasarse de los 20 caracteres que admite el código.
  const code = overrides.code ?? `E${randomLetters(3)}${String(Date.now()).slice(-6)}`;
  const finish = await postJson<CreatedFinish>(api, '/api/finishes', {
    code,
    name: overrides.name ?? `Acabado E2E ${code}`,
    densityFactor: overrides.densityFactor ?? '7.85',
  });
  return { id: finish.id, code: finish.code, name: finish.name };
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
