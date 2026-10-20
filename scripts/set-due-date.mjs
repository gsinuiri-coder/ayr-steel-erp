import { runApiCli } from './run-api-cli.mjs';

// cc61 (D-699): pone el vencimiento de un comprobante al crédito por el servicio de dominio.
// Dry-run por defecto; la vista previa queda en local-data/cc61/ (fuera del repo).
runApiCli({
  compiled: 'dist-cli/prisma/set-due-date-cli.js',
  what: 'cambia el vencimiento de un comprobante al crédito (con su auditoría)',
});
