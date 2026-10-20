import { runApiCli } from './run-api-cli.mjs';

// cc63: revisión previa de una carga atrasada (solo lectura; sin --execute). El informe queda en
// local-data/carga-atrasada/ (fuera del repo). `--plantilla <salida.xlsx>` escribe la plantilla.
runApiCli({
  compiled: 'dist-cli/prisma/backdated-load-review-cli.js',
  what: 'nada (es de solo lectura)',
  pathFlags: new Set(['--archivo', '--plantilla']),
});
