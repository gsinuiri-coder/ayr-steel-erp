import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/fix-purchase-received-dates-cli.js',
  what: 'corrige fechas recibidas de compras y sus entradas de kardex',
});
