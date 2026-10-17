import { runApiCli } from './run-api-cli.mjs';

// cc57 (E-05 de audit-01): saldos guardados contra el kardex. Solo lectura, sin execute.
runApiCli({
  compiled: 'dist-cli/prisma/check-balances-cli.js',
  what: 'concilia inventory_balances contra el kardex (solo lectura)',
});
