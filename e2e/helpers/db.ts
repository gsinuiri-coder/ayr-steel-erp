import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Acceso directo a la base **de pruebas**, para lo único que el API no puede hacer por diseño:
 * adelantar el reloj.
 *
 * D-185: una reserva temporal vence a días hábiles y no hay endpoint para acortarla — ni debe
 * haberlo. Para probar la expiración perezosa de punta a punta hay que mover `expires_at` al
 * pasado, y eso se hace acá, contra la base que la suite ya resetea en cada corrida.
 *
 * Nunca contra producción: con `E2E_BASE_URL` (la suite apuntando a una URL externa) lanza.
 */
interface RawClient {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $disconnect: () => Promise<void>;
}

function testDatabaseClient(): RawClient {
  if (process.env.E2E_BASE_URL) {
    throw new Error('El acceso directo a la base es solo para la base de pruebas (D-126)');
  }
  // `@prisma/client` es dependencia del API, no de la raíz: se resuelve desde ahí.
  const require = createRequire(join(process.cwd(), 'apps/api/package.json'));
  const { PrismaClient } = require('@prisma/client') as {
    PrismaClient: new () => RawClient;
  };
  return new PrismaClient();
}

/** Deja vencidas —sin marcarlas— las reservas temporales vigentes de una cotización. */
export async function expireTemporaryReservationsNow(quotationId: string): Promise<number> {
  const db = testDatabaseClient();
  try {
    return await db.$executeRawUnsafe(
      `UPDATE "quotation_reservations" SET "expires_at" = now() - interval '1 minute'
       WHERE "quotation_id" = $1::uuid AND "status" = 'ACTIVE'`,
      quotationId,
    );
  } finally {
    await db.$disconnect();
  }
}

/**
 * Deja sin vencimiento una cotización, como si la hubiera traído el importador (D-157). No hay
 * `POST`/`PUT` que exprese `validUntil: null`: el body de un `createQuotationSchema` siempre
 * trae `validityDays` (con su valor por defecto), y por diseño esa es la única forma de crearla
 * — el importador nace `null` **por código**, no por HTTP. Para probar la edición de una
 * cotización así (sin depender del importador entero, con su CSV y su previsualización) se
 * arma una normal y se la deja sin vencimiento acá, directo contra la base de pruebas.
 */
export async function clearQuotationValidity(quotationId: string): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "quotations" SET "valid_until" = NULL WHERE "id" = $1::uuid`,
      quotationId,
    );
  } finally {
    await db.$disconnect();
  }
}

/**
 * Intenta un `UPDATE`/`DELETE` directo sobre una fila real de `audit_log` (RF-95/RF-S2-CIERRE):
 * lo único que el API no puede hacer por diseño (no hay ruta que lo permita) y que necesita
 * verificarse contra la base real, no con un mock — el trigger `audit_log_no_update_delete`
 * (migración `20260902170000`) es lo que de verdad lo impide, y un mock de Prisma no lo tiene.
 * Cada llamada abre y cierra su propia conexión (mismo patrón que el resto del archivo);
 * ambas rechazan con el error de Postgres si el trigger sigue vigente, cosa que el spec afirma.
 */
export async function updateAuditLogRow(id: string, reason: string): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "audit_log" SET "reason" = $1 WHERE "id" = $2::bigint`,
      reason,
      id,
    );
  } finally {
    await db.$disconnect();
  }
}

/**
 * RF-S4b: un producto `BOB…` **suelto** en la línea de reventa, como el `BOB38AZUL` que
 * producción tiene cargado a mano desde antes de D-252 (sin saldo y sin ninguna bobina detrás).
 * Desde D-257 el catálogo ya no deja darlo de alta por el API, así que el dato heredado solo se
 * puede reproducir acá, contra la base de pruebas.
 */
export async function insertLegacyCoilProduct(sku: string, name: string): Promise<string> {
  const db = testDatabaseClient() as RawClient & {
    $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
  };
  try {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "products" ("id", "business_line_id", "sku", "name", "unit", "source", "is_active", "created_at", "updated_at")
       SELECT gen_random_uuid(), bl."id", $1, $2, 'KGM', 'PURCHASED', true, now(), now()
       FROM "business_lines" bl WHERE bl."code" = 'trading'
       RETURNING "id"::text AS "id"`,
      sku,
      name,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('No existe la línea de negocio trading en la base de pruebas');
    return id;
  } finally {
    await db.$disconnect();
  }
}

export async function deleteAuditLogRow(id: string): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "id" = $1::bigint`, id);
  } finally {
    await db.$disconnect();
  }
}
