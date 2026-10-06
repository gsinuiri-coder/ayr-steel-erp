import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { demoEnvPlan } from './demo-env-path.mjs';

// cc28: el .env.demo del checkout principal, también desde un worktree (ver demo-env-path.mjs).
const main = resolve('/repos/ayr-steel-erp');
const worktree = resolve('/repos/ayr-cc28');

test('desde el checkout principal usa y puede generar su propio .env.demo', () => {
  const plan = demoEnvPlan({ root: main, mainRoot: main });
  assert.equal(plan.path, resolve(main, '.env.demo'));
  assert.equal(plan.inWorktree, false);
  assert.equal(plan.canGenerate, true);
});

test('desde un worktree lee el del checkout principal y nunca genera', () => {
  const plan = demoEnvPlan({ root: worktree, mainRoot: main });
  assert.equal(plan.path, resolve(main, '.env.demo'));
  assert.equal(plan.inWorktree, true);
  assert.equal(plan.canGenerate, false);
  assert.match(plan.howToFix, /pnpm env:demo/);
  // SM-6 (cc28): la ayuda de env:demo no recorta nada; dice dónde y cómo generarlo.
  assert.match(plan.generateHint, new RegExp(main.replace(/\\/g, '\\\\')));
  assert.match(plan.generateHint, /AYR_ENV_DEMO/);
});

test('AYR_ENV_DEMO manda sobre la ruta por defecto', () => {
  const other = resolve('/secretos/demo.env');
  const plan = demoEnvPlan({ root: worktree, mainRoot: main, env: { AYR_ENV_DEMO: other } });
  assert.equal(plan.path, other);
  assert.equal(plan.canGenerate, false);
});

test('un AYR_ENV_DEMO relativo se lee desde el checkout principal (A-10)', () => {
  const plan = demoEnvPlan({ root: worktree, mainRoot: main, env: { AYR_ENV_DEMO: 'demo.env' } });
  assert.equal(plan.path, resolve(main, 'demo.env'));
});

test('ni con AYR_ENV_DEMO se genera un .env.demo dentro de un worktree', () => {
  const plan = demoEnvPlan({
    root: worktree,
    mainRoot: main,
    env: { AYR_ENV_DEMO: resolve(worktree, '.env.demo') },
  });
  assert.equal(plan.canGenerate, false);
});

test('los tres scripts de demo resuelven la ruta con demoEnvPlan, no con ROOT', () => {
  for (const file of ['dev-demo.mjs', 'db-demo.mjs', 'env-demo.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /demoEnvPlan\(/, `${file} no usa demoEnvPlan`);
    assert.doesNotMatch(
      source,
      /resolve\(ROOT, '\.env\.demo'\)/,
      `${file} sigue con ROOT/.env.demo`,
    );
  }
});
