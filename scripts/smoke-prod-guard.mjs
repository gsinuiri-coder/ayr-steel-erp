// A la URL del smoke se le manda el usuario y la contraseña del admin efímero de **producción**
// (`scripts/smoke-prod.mjs`). Un argumento copiado de un chat o un dedo que resbala no puede
// terminar en un host cualquiera. Vive aparte para poder probarlo: `smoke-prod.mjs` corre al
// importarse.

/**
 * Los hosts del web de production: el dominio propio (AGENTS.md §1) y el de Vercel. Se comparan
 * exactos: antes valía cualquier `*.vercel.app` —que cualquiera puede desplegar— y cualquier
 * host con la palabra `ayr`.
 */
export const PRODUCTION_WEB_HOSTS = ['v2.mareliac.pe', 'ayr-steel-erp-web.vercel.app'];

export function isAllowedSmokeBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && PRODUCTION_WEB_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}
