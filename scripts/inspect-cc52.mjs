import { runApiCli } from './run-api-cli.mjs';

// cc52: diagnóstico de solo lectura del kardex en sus vistas Promedio y PEPS. Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc52-cli.js',
  what: 'compara las vistas Promedio y PEPS del kardex (solo lectura)',
});
