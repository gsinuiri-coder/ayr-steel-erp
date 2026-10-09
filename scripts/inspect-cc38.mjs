import { runApiCli } from './run-api-cli.mjs';

// cc38: diagnóstico de solo lectura de las órdenes abiertas contra su plan (D-573, D-574). Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc38-cli.js',
  what: 'diagnostica las órdenes abiertas contra su plan de cc38 (solo lectura)',
});
