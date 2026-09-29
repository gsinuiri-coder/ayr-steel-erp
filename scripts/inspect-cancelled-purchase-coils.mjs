import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/inspect-cancelled-purchase-coils-cli.js',
  what: 'inspecciona bobinas de compra anuladas (solo lectura)',
});
