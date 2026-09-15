import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi } from '../helpers/api';
import {
  balanceOf,
  createCatalogProduct,
  movementsOf,
  optionalBalanceOf,
} from '../helpers/production';
import { createSellableProduct } from '../helpers/sales';

/**
 * F8-S6a2/M1 — extensión de la carga de inventario inicial (D-206) a productos por unidades:
 * cobertura UPVC y reventa. Mismo CLI que la carga de bobinas (`--kind products`), mismo
 * servicio de dominio (`InventoryService.record`, sin SQL directo), mismas cuatro condiciones
 * de la excepción a D-150.
 *
 * Igual que `inventario-inicial-f8s6a.spec.ts`: no hay ruta HTTP que probar (D-206 condición 2),
 * así que este archivo corre el CLI real contra la base que la suite ya vació y sembró, y
 * verifica por las rutas de lectura normales.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea stock de verdad contra la base de pruebas: nunca contra producción (D-126).',
);
test.describe.configure({ timeout: 240_000 });

const REPO_ROOT = resolve(__dirname, '../..');

interface CliResult {
  status: number;
  stdout: string;
}

function runCli(filePath: string, extraArgs: string[] = []): CliResult {
  const res = spawnSync(
    'node',
    [
      'scripts/import-initial-inventory.mjs',
      '--file',
      filePath,
      '--branch',
      'local-e2e',
      '--kind',
      'products',
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: res.status ?? 1, stdout: `${res.stdout}\n${res.stderr}` };
}

function writeCsv(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'inventario-inicial-productos-'));
  const path = join(dir, 'inventario-productos.csv');
  writeFileSync(
    path,
    [
      'SKU PRODUCTO,UNIDADES,COSTO UNITARIO (SIN IGV),MONEDA,TIPO DE CAMBIO,FACTURA DE REFERENCIA,FECHA DE REFERENCIA',
      ...rows,
    ].join('\n'),
    'utf8',
  );
  return path;
}

test.describe('F8-S6a2/M1 — carga de inventario inicial de productos (D-206, extensión)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('dry-run no escribe nada; execute crea el stock con su kardex IMPORT', async () => {
    const product = await createSellableProduct(api, { lineCode: 'roofing', unit: 'NIU' });
    const csvPath = writeCsv([`${product.sku},50,120.5000,PEN,,F001-999,2026-01-05`]);

    try {
      const dry = runCli(csvPath);
      expect(dry.status, dry.stdout).toBe(0);
      expect(dry.stdout).toContain('Dry-run limpio');

      const beforeDry = await optionalBalanceOf(api, 'PRODUCT', product.id);
      expect(beforeDry, 'el dry-run no puede haber creado saldo').toBeNull();

      const exec = runCli(csvPath, ['--execute']);
      expect(exec.status, exec.stdout).toBe(0);
      expect(exec.stdout).toContain('1 línea(s) de producto creada(s)');

      const balance = await balanceOf(api, 'PRODUCT', product.id);
      expect(balance.qty).toBe('50.000');
      expect(balance.avgCost).toBe('120.5000');

      const movements = await movementsOf(api, 'PRODUCT', product.id);
      const opening = movements.find((m) => m.type === 'IN');
      expect(opening?.refType).toBe('IMPORT');
      expect(opening?.notes).toContain('Saldo inicial de inventario');
      expect(opening?.notes).toContain('F001-999');
    } finally {
      await api.patch(`/api/catalog/${product.id}`, { data: { isActive: false } }).catch(() => {});
    }
  });

  test('todo o nada: SKU inexistente y producto fabricado tumban el archivo entero', async () => {
    const good = await createSellableProduct(api, { lineCode: 'trading', unit: 'NIU' });
    // Producto fabricado (MANUFACTURED) **dentro** de una línea compra-reventa: aísla el
    // guardrail de `source`, distinto del de línea de negocio (probado por el SKU inexistente
    // de abajo, que ni siquiera llega a resolver una línea).
    const manufactured = await createCatalogProduct(api, {
      lineCode: 'roofing',
      source: 'MANUFACTURED',
    });
    const csvPath = writeCsv([
      `${good.sku},10,80.0000,PEN,,,`,
      'SKU-NO-EXISTE-E2E,10,80.0000,PEN,,,',
      `${manufactured.sku},10,80.0000,PEN,,,`,
    ]);

    try {
      const exec = runCli(csvPath, ['--execute']);
      expect(exec.status).toBe(1);
      expect(exec.stdout).toContain('No se importó nada');
      expect(exec.stdout).toContain('SKU-NO-EXISTE-E2E');
      expect(exec.stdout).toContain('fabricado');

      const balance = await optionalBalanceOf(api, 'PRODUCT', good.id);
      expect(balance, 'la línea válida no debía entrar: el archivo completo se rechaza').toBeNull();
    } finally {
      await api.patch(`/api/catalog/${good.id}`, { data: { isActive: false } }).catch(() => {});
      await api
        .patch(`/api/catalog/${manufactured.id}`, { data: { isActive: false } })
        .catch(() => {});
    }
  });

  test('un producto que ya tiene kardex rechaza la fila (la herramienta nunca actualiza stock existente)', async () => {
    const product = await createSellableProduct(api, { lineCode: 'roofing', unit: 'NIU' });
    const csvPath = writeCsv([`${product.sku},20,90.0000,PEN,,,`]);

    try {
      const first = runCli(csvPath, ['--execute']);
      expect(first.status, first.stdout).toBe(0);

      const second = runCli(csvPath, ['--execute']);
      expect(second.status).toBe(1);
      expect(second.stdout).toContain('ya tiene movimientos de kardex');

      const balance = await balanceOf(api, 'PRODUCT', product.id);
      expect(balance.qty, 'la segunda corrida no debía sumar más stock').toBe('20.000');
    } finally {
      await api.patch(`/api/catalog/${product.id}`, { data: { isActive: false } }).catch(() => {});
    }
  });
});
