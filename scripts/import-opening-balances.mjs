import { runApiCli } from './run-api-cli.mjs';

// cc56 (D-668): saldos iniciales de cobranzas y pagos a proveedor. Dry-run por defecto; la vista
// previa y las plantillas quedan en local-data/cc56/ (fuera del repo: traen datos reales).
runApiCli({
  compiled: 'dist-cli/prisma/import-opening-balances-cli.js',
  what: 'registra los cobros y pagos de saldos iniciales (un lote auditado, que se puede deshacer)',
  pathFlags: new Set(['--cobranzas', '--pagos', '--out']),
});
