// Reporter de Playwright que anota, por test, duración y round-trips a la base (F8-R1).
//
// Lee los contadores de `scripts/latency-proxy.mjs --stats-port` al empezar y al terminar cada
// test. La lectura es **sincrónica** (curl) a propósito: los hooks `onTestBegin`/`onTestEnd`
// no se esperan, y una lectura asíncrona podría caer en el test siguiente.
//
// Escribe una línea JSON por test en E2E_ROUNDTRIPS_OUT:
//   { file, title, status, durationMs, roundTrips, retry }
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const STATS_URL = process.env.E2E_ROUNDTRIPS_STATS_URL ?? 'http://127.0.0.1:5499/';

function readStats() {
  try {
    const out = execFileSync('curl', ['-s', '-m', '5', STATS_URL], { encoding: 'utf8' });
    const s = JSON.parse(out);
    return s.syncs + s.simpleQueries;
  } catch {
    return null;
  }
}

export default class RoundTripsReporter {
  constructor() {
    this.out = process.env.E2E_ROUNDTRIPS_OUT;
    this.begin = new Map();
    if (this.out) writeFileSync(this.out, '');
  }

  onTestBegin(test, result) {
    this.begin.set(`${test.id}#${result.retry}`, readStats());
  }

  onTestEnd(test, result) {
    const key = `${test.id}#${result.retry}`;
    const start = this.begin.get(key);
    const end = readStats();
    const line = {
      file: test.location.file.replace(/\\/g, '/').split('/e2e/tests/')[1] ?? test.location.file,
      title: test.titlePath().slice(2).join(' › '),
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      roundTrips: start === null || end === null ? null : end - start,
    };
    if (this.out) appendFileSync(this.out, `${JSON.stringify(line)}\n`);
  }

  printsToStdio() {
    return false;
  }
}
