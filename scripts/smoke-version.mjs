// D-636: ¿qué commit está publicado? La web lo dice en `/version` y la API en `/api/health`
// (`sha`). `smoke:prod` espera a que coincidan con el commit esperado antes de probar nada:
// verificar la web por la caché de `/login` (cc48) no decía qué build respondía.
//
// Vive aparte para poder probarlo: `smoke-prod.mjs` corre al importarse.

/** Tope de espera hasta que el despliegue publique el commit esperado. */
export const VERSION_TIMEOUT_MS = 10 * 60 * 1000;
export const VERSION_INTERVAL_MS = 15 * 1000;

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Un sha corto (el label `git-sha` tiene 8) y uno largo (Vercel publica los 40) son el mismo
 * commit si uno es prefijo del otro. «dev», vacío o algo que no es un sha nunca coincide.
 */
export function shaMatches(expected, published) {
  const a = String(expected ?? '')
    .trim()
    .toLowerCase();
  const b = String(published ?? '')
    .trim()
    .toLowerCase();
  if (!SHA.test(a) || !SHA.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** El sha de `--expect-sha <sha>` (o `--expect-api-sha`) si viene; si no, `null`. */
export function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const value = String(argv[i + 1] ?? '')
    .trim()
    .toLowerCase();
  if (!SHA.test(value)) {
    throw new Error(`${flag} necesita un sha de 7 a 40 caracteres hexadecimales`);
  }
  return value;
}

/**
 * Consulta `readSha` hasta que coincida con `expected` o se pase el tope. Un error de red o un
 * HTTP no 200 cuenta como «todavía no» (un despliegue puede responder mal mientras cambia).
 * Devuelve `{ ok, published, attempts, error }`: `published` es el último sha leído.
 */
export async function waitForSha({
  expected,
  readSha,
  timeoutMs = VERSION_TIMEOUT_MS,
  intervalMs = VERSION_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onAttempt = () => {},
}) {
  const deadline = now() + timeoutMs;
  let published = null;
  let error = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      published = await readSha();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (shaMatches(expected, published)) return { ok: true, published, attempts, error: null };
    onAttempt({ attempts, published, error });
    if (now() + intervalMs > deadline) return { ok: false, published, attempts, error };
    await sleep(intervalMs);
  }
}

/** El mensaje de la falla: dónde, sha esperado y sha publicado. */
export function mismatchMessage({ where, expected, published, error, timeoutMs }) {
  const minutes = Math.round(timeoutMs / 60000);
  return (
    `${where}: después de ${minutes} min sigue sin publicar el commit esperado. ` +
    `Esperado ${expected}, publicado ${published ?? '(sin respuesta)'}` +
    (error ? ` (último error: ${error})` : '')
  );
}

/** Lee un JSON sin caché y devuelve `body[field]` si es texto. */
export async function fetchShaField(fetchImpl, url, field) {
  const res = await fetchImpl(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return typeof body?.[field] === 'string' ? body[field] : null;
}
