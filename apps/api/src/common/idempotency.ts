import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export interface IdempotencyClaim {
  /**
   * `true`: nadie más reclamó esta clave todavía — seguir con el efecto de negocio.
   * `false`: ya se procesó este mismo intento; `resourceId` es el que dejó esa primera
   * vez. El llamador no debe repetir ningún efecto (kardex, correlativo, cobro).
   */
  claimed: boolean;
  resourceId: string;
}

/**
 * Reclama una clave de idempotencia (D-182, F8-S1/M2) dentro de la transacción de
 * negocio, para las **creaciones repetibles**: un reporte de producción o un cobro son
 * eventos legítimos si se repiten, pero un mismo intento de submit (doble click,
 * reintento de red) no debe crear dos.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` y no un `create` con `try/catch` de `P2002`: dentro
 * de una transacción interactiva un error de Postgres la deja **abortada** — ver
 * `resolveRawMaterialSpec` — así que el llamador no podría seguir usando `tx` para leer
 * al ganador. La sentencia sin excepción resuelve la carrera y, si perdemos, Postgres ya
 * bloqueó y esperó a que la fila ganadora exista antes de devolver el control: el
 * `findUnique` que sigue nunca ve un hueco.
 *
 * Sin `idempotencyKey` (un caller que no lo manda, como hoy el mostrador al abrir su
 * propia transacción) siempre `claimed: true`: el guardrail es opt-in, nunca un requisito
 * nuevo para quien no lo pide.
 */
export async function claimIdempotencyKey(
  tx: Prisma.TransactionClient,
  scope: string,
  idempotencyKey: string | undefined,
): Promise<IdempotencyClaim> {
  if (idempotencyKey === undefined) return { claimed: true, resourceId: randomUUID() };

  const resourceId = randomUUID();
  const inserted = await tx.$queryRaw<{ resource_id: string }[]>`
    INSERT INTO "idempotency_keys" ("key", "scope", "resource_id")
    VALUES (${idempotencyKey}, ${scope}, ${resourceId}::uuid)
    ON CONFLICT ("key") DO NOTHING
    RETURNING "resource_id"
  `;
  if (inserted.length > 0) return { claimed: true, resourceId };

  const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
  // La clave ya existe pero de otro scope: dos endpoints no deberían compartir clave con un
  // cliente que genera un UUID nuevo por intento, pero si pasa no es el mismo envío — se
  // trata como si no hubiera clave, en vez de fingir un reintento que no es.
  if (existing?.scope !== scope) return { claimed: true, resourceId: randomUUID() };
  return { claimed: false, resourceId: existing.resourceId };
}
