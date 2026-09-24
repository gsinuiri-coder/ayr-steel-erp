// P1-3 de la revisión del delta RF-S4b: rotar la contraseña del rol de una rama de Neon después
// de resetearla.
//
// Por qué: el reset de una rama hija **le devuelve a los roles la contraseña del padre** (salvo
// que el padre sea una rama protegida, que production no es). Cada `db-reset-dev.mjs --branch
// demo` dejaba a `demo` con la contraseña de production, y `pnpm env:demo` la escribía en
// `.env.demo`: compartir ese archivo para una UAT era entregar una llave de production.
//
// Por la API de Neon, porque `neonctl` (4.x) no tiene `roles reset-password`. La credencial
// (`NEON_API_KEY`) viaja solo por el entorno del proceso o por `.env.setup`, nunca por argv; de
// las respuestas no se lee ni se imprime ninguna contraseña, y los errores dicen el estado HTTP,
// nunca el cuerpo. La verificación compara hashes en memoria.
import { createHash, timingSafeEqual } from 'node:crypto';

export const NEON_API = 'https://console.neon.tech/api/v2';

/**
 * La API key de Neon: primero el entorno, después `.env.setup`. `null` si no está en ninguno.
 * @param {Record<string, string | undefined>} env
 * @param {() => Record<string, string>} readSetup
 */
export function resolveNeonApiKey(env, readSetup) {
  const fromEnv = env.NEON_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readSetup().NEON_API_KEY?.trim();
    return fromFile || null;
  } catch {
    return null;
  }
}

export const MISSING_KEY_MESSAGE =
  'Falta NEON_API_KEY (en el entorno o en .env.setup). Sin ella no se puede rotar la contraseña\n' +
  'del rol después del reset, y la rama quedaría con la de production: no se resetea nada.';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

/**
 * Llama a la API reintentando mientras la rama esté bloqueada por una operación en curso (423),
 * que es lo normal justo después de un reset. Nunca incluye el cuerpo en el error.
 */
async function call(fetchImpl, sleep, { method, url, apiKey, what, attempts, delayMs }) {
  for (let i = 1; ; i += 1) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (res.status === 423 && i < attempts) {
      await sleep(delayMs);
      continue;
    }
    if (!res.ok) throw new Error(`${what}: la API de Neon respondió HTTP ${res.status}.`);
    // El error de un JSON roto cita un fragmento del cuerpo, y el cuerpo trae la contraseña:
    // se reemplaza por un mensaje fijo (autorrevisión del PR #16, P2-D).
    try {
      return await res.json();
    } catch {
      throw new Error(`${what}: la API de Neon devolvió una respuesta ilegible.`);
    }
  }
}

/**
 * Rota la contraseña de `role` en la rama `branchId` y verifica, sin imprimir nada, que la
 * contraseña nueva es distinta de la que tenía (la heredada de production).
 *
 * @returns {Promise<void>} lanza si la rotación no se aplicó.
 */
export async function rotateRolePassword({
  apiKey,
  projectId,
  branchId,
  role = 'neondb_owner',
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 30,
  delayMs = 2000,
}) {
  const base = `${NEON_API}/projects/${projectId}/branches/${branchId}/roles/${role}`;
  const common = { apiKey, attempts, delayMs };
  const reveal = async (what) => {
    const body = await call(fetchImpl, sleep, {
      ...common,
      method: 'GET',
      url: `${base}/reveal_password`,
      what,
    });
    if (typeof body?.password !== 'string' || body.password === '') {
      throw new Error(`${what}: la API de Neon no devolvió la contraseña del rol.`);
    }
    return sha256(body.password);
  };

  const before = await reveal('Leer la contraseña heredada');
  // De la respuesta no se lee nada: trae la contraseña nueva.
  await call(fetchImpl, sleep, {
    ...common,
    method: 'POST',
    url: `${base}/reset_password`,
    what: 'Rotar la contraseña',
  });
  const after = await reveal('Leer la contraseña rotada');
  if (timingSafeEqual(before, after)) {
    throw new Error(
      'La rotación no se aplicó: la contraseña sigue siendo la heredada de production.',
    );
  }
}
