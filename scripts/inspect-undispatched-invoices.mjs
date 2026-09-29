import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/inspect-undispatched-invoices-cli.js',
  what: 'inspecciona comprobantes sin despacho (solo lectura)',
});
