import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems } from '../helpers/api';
import { createColor, createRoofingFinish, purgeRoofingTrail } from '../helpers/roofing';

/**
 * F8-S6a/M1 — CLI de carga de inventario inicial (D-206, excepción única a D-150).
 *
 * No hay ruta HTTP que probar (a propósito: D-206 condición 2, es de arranque y no un camino de
 * ingreso más). Este archivo corre el CLI de verdad, como wrapper de producción
 * (`scripts/import-initial-inventory.mjs --branch local-e2e`), contra la misma base que la
 * suite ya vació y sembró, y verifica el resultado por las rutas de lectura normales —
 * exactamente lo que alguien que abre la app vería.
 *
 * Cada corrida compila el CLI con `tsc` real (`tsconfig.cli.json`), así que estos casos tardan
 * más que un test de API común; están en su propio archivo para no arrastrar esa demora a otros.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea bobinas de verdad contra la base de pruebas: nunca contra producción (D-126).',
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
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: res.status ?? 1, stdout: `${res.stdout}\n${res.stderr}` };
}

function writeCsv(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'inventario-inicial-'));
  const path = join(dir, 'inventario.csv');
  writeFileSync(
    path,
    [
      'CÓDIGO BOBINA,ACABADO,COLOR,ESPESOR (MM),ANCHO (MM),KILOS INICIALES,COSTO UNITARIO (S/KG SIN IGV),MONEDA,TIPO DE CAMBIO,FACTURA DE REFERENCIA,FECHA DE REFERENCIA',
      ...rows,
    ].join('\n'),
    'utf8',
  );
  return path;
}

interface CoilRow {
  id: string;
  code: string;
  externalCode: string | null;
  colorId: string | null;
  finishId: string;
}

interface MovementRow {
  refType: string;
  type: string;
  notes: string | null;
}

test.describe('F8-S6a/M1 — carga de inventario inicial (D-206)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('dry-run no escribe nada; execute crea la bobina con su kardex IMPORT y el color del acabado', async () => {
    const color = await createColor(api, '#2a6f97');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const externalCode = `E2E-INI-${Date.now()}`;
    const csvPath = writeCsv([
      `${externalCode},${finish.code},${color.name},0.35,1000,1500.000,4.2000,PEN,,F001-999,2026-01-05`,
    ]);

    try {
      const dry = runCli(csvPath);
      expect(dry.status, dry.stdout).toBe(0);
      expect(dry.stdout).toContain('Dry-run limpio');

      const beforeDry = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`);
      expect(beforeDry, 'el dry-run no puede haber creado nada').toHaveLength(0);

      const exec = runCli(csvPath, ['--execute']);
      expect(exec.status, exec.stdout).toBe(0);
      expect(exec.stdout).toContain('1 bobina(s) creada(s)');

      const created = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`);
      expect(created).toHaveLength(1);
      const coil = created[0]!;
      expect(coil.externalCode).toBe(externalCode);
      // D-203: el color de la bobina sale del acabado, igual que por cualquier otra vía.
      expect(coil.colorId).toBe(color.id);

      const movements = await getItems<MovementRow>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${coil.id}`,
      );
      const opening = movements.find((m) => m.type === 'IN');
      expect(opening?.refType).toBe('IMPORT');
      expect(opening?.notes).toContain('Saldo inicial de inventario');
      expect(opening?.notes).toContain('F001-999');
    } finally {
      const leftover = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`).catch(
        () => [],
      );
      await purgeRoofingTrail(api, {
        finishId: finish.id,
        colorId: color.id,
        coilIds: leftover.map((c) => c.id),
      });
    }
  });

  test('todo o nada: una fila inválida no deja pasar ninguna, ni siquiera las que estaban bien', async () => {
    const color = await createColor(api, '#9c3061');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const validCode = `E2E-INI-OK-${Date.now()}`;
    const csvPath = writeCsv([
      `${validCode},${finish.code},${color.name},0.35,1000,1200.000,4.0000,PEN,,,`,
      // Acabado inexistente: la segunda fila tiene que tumbar el archivo entero.
      `E2E-INI-BAD-${Date.now()},NOEXISTE123,,0.35,1000,1200.000,4.0000,PEN,,,`,
    ]);

    try {
      const exec = runCli(csvPath, ['--execute']);
      expect(exec.status).toBe(1);
      expect(exec.stdout).toContain('No se importó nada');
      expect(exec.stdout).toContain('NOEXISTE123');

      const coils = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`);
      expect(coils, 'la fila válida no debía entrar: el archivo completo se rechaza').toHaveLength(
        0,
      );
    } finally {
      await purgeRoofingTrail(api, { finishId: finish.id, colorId: color.id });
    }
  });

  test('el código de bobina duplicado en la base rechaza la fila (la herramienta nunca actualiza una existente)', async () => {
    const color = await createColor(api, '#4c7a3f');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const externalCode = `E2E-INI-DUP-${Date.now()}`;
    const csvPath = writeCsv([
      `${externalCode},${finish.code},${color.name},0.35,1000,1200.000,4.0000,PEN,,,`,
    ]);

    try {
      const first = runCli(csvPath, ['--execute']);
      expect(first.status, first.stdout).toBe(0);

      const second = runCli(csvPath, ['--execute']);
      expect(second.status).toBe(1);
      expect(second.stdout).toContain('ya existe una bobina con este código');

      const coils = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`);
      expect(coils, 'la segunda corrida no debía crear una segunda bobina').toHaveLength(1);
    } finally {
      const leftover = await getItems<CoilRow>(api, `/api/coils?finishId=${finish.id}`).catch(
        () => [],
      );
      await purgeRoofingTrail(api, {
        finishId: finish.id,
        colorId: color.id,
        coilIds: leftover.map((c) => c.id),
      });
    }
  });
});
