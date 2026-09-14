// Compara dos corridas de `scripts/e2e-latency.mjs` por spec y por test (F8-R1).
//
// Uso: node scripts/e2e-latency-compare.mjs <antes.jsonl> <despues.jsonl> [--top 15] [--tests]
// Imprime una tabla Markdown: tests, minutos y round-trips de cada lado y el delta absoluto,
// ordenada por el delta de minutos. Los specs que existen de un solo lado aparecen con «—».
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const topIdx = process.argv.indexOf('--top');
const top = topIdx > -1 ? Number(process.argv[topIdx + 1]) : 15;
const byTest = process.argv.includes('--tests');

function load(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function aggregate(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = byTest ? r.title : r.file;
    const acc = map.get(key) ?? { n: 0, ms: 0, rt: 0 };
    acc.n += 1;
    acc.ms += r.durationMs;
    acc.rt += r.roundTrips ?? 0;
    map.set(key, acc);
  }
  return map;
}

const before = aggregate(load(beforePath));
const after = aggregate(load(afterPath));
const keys = new Set([...before.keys(), ...after.keys()]);
const min = (ms) => (ms / 60000).toFixed(1);

const rows = [...keys].map((k) => {
  const b = before.get(k);
  const a = after.get(k);
  return { k, b, a, dMs: (a?.ms ?? 0) - (b?.ms ?? 0), dRt: (a?.rt ?? 0) - (b?.rt ?? 0) };
});
rows.sort((x, y) => y.dMs - x.dMs);

const total = (m) =>
  [...m.values()].reduce((acc, v) => ({ n: acc.n + v.n, ms: acc.ms + v.ms, rt: acc.rt + v.rt }), {
    n: 0,
    ms: 0,
    rt: 0,
  });
const tb = total(before);
const ta = total(after);
console.log(
  `Total: antes ${tb.n} tests, ${min(tb.ms)} min, ${tb.rt} RT · después ${ta.n} tests, ${min(ta.ms)} min, ${ta.rt} RT · ${(ta.ms / tb.ms).toFixed(2)}×`,
);
console.log('');
console.log(
  `| ${byTest ? 'Test' : 'Spec'} | Tests antes | Min antes | RT antes | Tests después | Min después | RT después | Δ min | Δ RT |`,
);
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows.slice(0, top)) {
  const cell = (v, f) => (v ? f(v) : '—');
  console.log(
    `| ${r.k} | ${cell(r.b, (v) => v.n)} | ${cell(r.b, (v) => min(v.ms))} | ${cell(r.b, (v) => v.rt)} | ${cell(r.a, (v) => v.n)} | ${cell(r.a, (v) => min(v.ms))} | ${cell(r.a, (v) => v.rt)} | ${min(r.dMs)} | ${r.dRt} |`,
  );
}
