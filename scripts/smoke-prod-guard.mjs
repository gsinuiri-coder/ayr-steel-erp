// A la URL del smoke se le manda el usuario y la contraseña del admin efímero de **producción**
// (`scripts/smoke-prod.mjs`). Un argumento copiado de un chat o un dedo que resbala no puede
// terminar en un host cualquiera. Vive aparte para poder probarlo: `smoke-prod.mjs` corre al
// importarse.

/** El dominio propio del web de production (AGENTS.md §1). Se compara exacto, no por sufijo. */
export const PRODUCTION_WEB_HOSTS = ['v2.mareliac.pe'];

export function isAllowedSmokeBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return false;
    return (
      PRODUCTION_WEB_HOSTS.includes(url.hostname) ||
      /(^|\.)vercel\.app$|(^|\.)ayr\b/.test(url.hostname)
    );
  } catch {
    return false;
  }
}
