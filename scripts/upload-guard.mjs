// cc68 (D-726): lo que `gcloud run deploy --source .` sube a Cloud Build nunca lleva `local-data/`
// (datos del negocio, logs y capturas que viven fuera de git) ni un archivo de entorno (`.env*`).
// `.gcloudignore` los excluye; este guard lo **comprueba** antes de cada deploy con el listado de
// gcloud mismo (`gcloud meta list-files-for-upload`), así que una regla rota del ignore o una
// carpeta nueva no pasan en silencio. Nunca lee el contenido de ningún archivo: solo nombres.
import { run } from './lib.mjs';

/** Las rutas del listado que no pueden subir. Acepta separadores `/` y `\` (Windows). */
export function forbiddenUploadPaths(paths) {
  return paths
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .filter((p) => {
      const parts = p.split(/[\\/]/);
      return parts.includes('local-data') || parts.some((part) => /^\.env(\.|$)/.test(part));
    });
}

/** Lista lo que subiría `--source <dir>` y aborta si aparece algo prohibido. */
export function assertUploadIsClean(dir = '.') {
  const listing = run('gcloud', ['meta', 'list-files-for-upload', dir], { quiet: true });
  const bad = forbiddenUploadPaths(listing.split(/\r?\n/));
  if (bad.length > 0) {
    const shown = bad.slice(0, 5).join(', ');
    throw new Error(
      `El paquete del deploy incluiría ${String(bad.length)} archivo(s) que no pueden subir (${shown}${bad.length > 5 ? '…' : ''}). Revisa .gcloudignore (D-726).`,
    );
  }
}
