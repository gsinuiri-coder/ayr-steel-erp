// Purga de cotizaciones anuladas elegidas por el dueño (D-350). Dry-run por defecto.
//
// Uso:
//   pnpm purge:cancelled-quotations --numbers COT-000012,COT-000015 [--branch local|local-e2e|dev|demo|production]
//   pnpm purge:cancelled-quotations --numbers COT-000012 --branch demo --execute
//   pnpm purge:cancelled-quotations --numbers … --branch production --confirm-production   (dry-run)
//
// La lógica vive en `apps/api/src/sales/quotation-purge.ts`. No borra PDFs de R2: el informe
// lista sus claves como huérfanas.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/purge-cancelled-quotations-cli.js',
  what: 'borra físicamente las cotizaciones anuladas pedidas',
});
