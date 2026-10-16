import { runApiCli } from './run-api-cli.mjs';

// cc56 (C2, D-669): corrige el costo de la entrada de una bobina ya vendida por el recosteo por fecha.
// Dry-run por defecto; la vista previa queda en local-data/cc56/ (fuera del repo).
runApiCli({
  compiled: 'dist-cli/prisma/fix-coil-entry-cost-cli.js',
  what: 'recostea la entrada de una bobina y su venta (ajustes de kardex con recost_of_id)',
});
