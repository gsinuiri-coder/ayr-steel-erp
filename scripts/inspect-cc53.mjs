import { runApiCli } from './run-api-cli.mjs';

// cc53 (D-652): ítems cuyo kardex queda en negativo en alguna fecha. Solo lectura, sin execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc53-cli.js',
  what: 'lista los saldos negativos por fecha del kardex (solo lectura)',
});
