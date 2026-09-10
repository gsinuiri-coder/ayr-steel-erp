// Corre **solo** los casos E2E que necesitan una aceptación real del PSE (etiqueta `@pse`).
//
// Están fuera de la corrida por defecto porque dependen de un recurso externo con cupo: la
// cuenta demo de Nubefact admite 50 comprobantes y, llena, esos casos fallan todos con «No
// puedes enviar mas de 50 documentos en en una cuenta DEMO». Doce rojos que no son una
// regresión vuelven ilegible a la suite entera. Ver `playwright.config.ts` y `docs/ENTORNOS.md`.
//
// Antes de correrlo hay que **vaciar los comprobantes de la cuenta demo** en el panel de
// Nubefact; si no, va a fallar por lo mismo de siempre.
//
// El flag va por entorno y no por `--grep` porque un `--grep` de la línea de comandos pisa a
// `grep` pero no a `grepInvert`, que es lo que excluye estos casos por defecto.
//
// Uso: pnpm e2e:pse [<archivo o patrón>]
//
// Se admite un patrón de archivo, no un `--grep`: con `E2E_PSE=1` la config pone `grep: /@pse/`
// y un `--grep` de la línea de comandos lo **pisa**, así que `pnpm e2e:pse --grep foo` terminaba
// corriendo casos que no son `@pse` — justo lo contrario de lo que el comando promete.
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const passthrough = process.argv.slice(2);
if (passthrough.some((arg) => arg.startsWith('--grep'))) {
  console.error(
    'pnpm e2e:pse no admite --grep: pisaría el filtro @pse y correría otros casos.\n' +
      'Para acotar, pasá un patrón de archivo (pnpm e2e:pse fase5b).',
  );
  process.exit(1);
}

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'playwright', 'test', ...passthrough],
  {
    cwd: ROOT,
    env: { ...process.env, E2E_PSE: '1' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);
process.exit(res.status ?? 1);
