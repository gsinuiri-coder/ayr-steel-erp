import { expect, test } from '@playwright/test';
import { adminApi, createUser, getJson } from '../helpers/api';
import { deleteAuditLogRow, updateAuditLogRow } from '../helpers/db';

/**
 * RF-95/RF-S2-CIERRE (M1) — `audit_log` es inmutable a nivel de base, no solo por diseño del
 * API. El trigger `audit_log_no_update_delete` (migración `20260902170000`) es lo único que
 * de verdad lo garantiza; un mock de Prisma nunca lo ejercita, así que esto corre contra una
 * fila real, con acceso directo a la base de pruebas (`e2e/helpers/db.ts`, nunca producción).
 *
 * Dispara una acción sensible real (alta de usuario) para tener una fila real y reciente de
 * `audit_log`, la ubica vía `GET /audit` (mismo endpoint que usa el visor) y la ataca por
 * fuera del API.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Acceso directo a la base: nunca contra producción (D-126).');

test.describe('audit_log es inmutable en la base (RF-95)', () => {
  test('UPDATE y DELETE sobre una fila real fallan por el trigger, no por el API', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const created = await createUser(api, 'VENDEDOR');

    const params = new URLSearchParams({
      entityType: 'users',
      entityId: created.id,
      pageSize: '5',
    });
    const page = await getJson<{ items: { id: string; source: string }[] }>(
      api,
      `/api/audit?${params.toString()}`,
    );
    const row = page.items.find((i) => i.source === 'audit_log');
    expect(row, 'el alta de usuario tiene que haber dejado una fila en audit_log').toBeDefined();

    await expect(updateAuditLogRow(row!.id, 'intento de edición E2E')).rejects.toThrow(/inmutable/);
    await expect(deleteAuditLogRow(row!.id)).rejects.toThrow(/inmutable/);

    // La fila sigue intacta: ningún intento la tocó.
    const after = await getJson<{ items: { id: string }[] }>(
      api,
      `/api/audit?${params.toString()}`,
    );
    expect(after.items.some((i) => i.id === row!.id)).toBe(true);
  });
});
