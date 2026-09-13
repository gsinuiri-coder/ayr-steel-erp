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
