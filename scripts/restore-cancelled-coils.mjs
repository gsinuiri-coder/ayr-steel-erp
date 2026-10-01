import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/restore-cancelled-coils-cli.js',
  what: 'restaura bobinas anuladas de compra (D-375) y su entrada de kardex',
});
