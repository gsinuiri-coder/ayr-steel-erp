import { runApiCli } from './run-api-cli.mjs';

// cc53 (D-651): corrección única del recosteo por fecha de los SKU afectados. Dry-run por defecto;
// la vista previa queda en local-data/cc53/ (fuera del repo).
runApiCli({
  compiled: 'dist-cli/prisma/recost-historic-cli.js',
  what: 'recostea por fecha la historia de los SKU afectados (ajustes de kardex «Recosteo histórico cc53»)',
});
