import { runApiCli } from './run-api-cli.mjs';

// cc63 (RC-01): completa los recosteos por fecha que superaron el tope y quedaron pendientes.
// Dry-run por defecto; la vista previa queda en local-data/recosteo-pendientes/ (fuera del repo).
runApiCli({
  compiled: 'dist-cli/prisma/recost-pending-cli.js',
  what: 'recostea desde su primera fila los ítems con recosteo pendiente (ajustes de kardex)',
});
