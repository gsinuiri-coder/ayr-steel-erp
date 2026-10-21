import { runApiCli } from './run-api-cli.mjs';

// cc64 (D-705, D-706): el cargador de la carga atrasada. Primer argumento: «ejecutar» o «revertir».
// Dry-run por defecto; el informe queda en local-data/carga-atrasada/ (fuera del repo).
runApiCli({
  compiled: 'dist-cli/prisma/backdated-load-run-cli.js',
  what: 'carga (o revierte) operaciones atrasadas por los servicios de dominio',
  pathFlags: new Set(['--archivo']),
});
