// Re-fechado de los despachos «a la fecha del comprobante» de un comprobante cuya emisión ya
// se corrigió (D-288). Dry-run por defecto.
//
// Uso:
//   pnpm dispatch:redate --number FFA1-00001386 [--branch local|local-e2e|dev|demo|production]
//   pnpm dispatch:redate --number FFA1-00001386 --execute --branch production --confirm-production
//
// La lógica vive en `apps/api/src/invoicing/invoice-dispatch.service.ts` (`redateInTx`).
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/dispatch-redate-cli.js',
  what: 'revierte despachos y los vuelve a registrar a la fecha de emisión del comprobante',
});
