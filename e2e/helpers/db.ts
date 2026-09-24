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
    if (id === undefined)
      throw new Error('No existe la línea de negocio trading en la base de pruebas');
    return id;
  } finally {
    await db.$disconnect();
  }
}

/**
 * RF-S4b: deja un producto con el SKU de **antes** de D-252 (`BOB{acabado}{espesor}`), que es
 * como están los de producción hasta que corra la normalización. Desde D-252 el alta de la
 * bobina ya crea el canónico, así que el estado viejo solo se reproduce acá.
 */
export async function setProductSkuForTest(productId: string, sku: string): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "products" SET "sku" = $1 WHERE "id" = $2::uuid`,
      sku,
      productId,
    );
  } finally {
    await db.$disconnect();
  }
}

/**
 * RF-S4b: deja la línea 1 de una cotización como quedó COT-000002 en producción — enganchada a
 * un producto (el `BOB…` suelto) que reserva su propio saldo, y con los importes recalculados
 * desde un unitario de cuatro decimales —. Es el estado que el barrido tiene que encontrar y
 * corregir; ninguna ruta del API lo puede producir ya (D-254/D-255).
 */
export async function breakQuotationLineForTest(
  quotationId: string,
  line: {
    productId: string;
    unitPricePen: string;
    subtotalPen: string;
    igvPen: string;
    totalPen: string;
  },
): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "quotation_items"
       SET "product_id" = $2::uuid, "reserve_item_type" = 'PRODUCT', "reserve_item_id" = $2::uuid,
           "reserve_unit" = 'KGM', "unit_price_pen" = $3::numeric, "subtotal_pen" = $4::numeric,
           "igv_pen" = $5::numeric, "total_pen" = $6::numeric
       WHERE "quotation_id" = $1::uuid AND "line_number" = 1`,
      quotationId,
      line.productId,
      line.unitPricePen,
      line.subtotalPen,
      line.igvPen,
      line.totalPen,
    );
    await db.$executeRawUnsafe(
      `UPDATE "quotations" SET "subtotal_pen" = $2::numeric, "igv_pen" = $3::numeric, "total_pen" = $4::numeric
       WHERE "id" = $1::uuid`,
      quotationId,
      line.subtotalPen,
      line.igvPen,
      line.totalPen,
    );
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

/**
 * D-256 (aclaración, revisión cruzada RF-S4b): deja una cotización a cargo de otro usuario.
 * El importador la crea con el ADMINISTRADOR que importó como vendedor, y para probar que un
 * VENDEDOR que edita un documento importado queda sujeto al piso hace falta que ese vendedor
 * pueda abrirla (D-238). Ninguna ruta del API reasigna una cotización: por eso va por acá.
 */
export async function setQuotationSellerForTest(
  quotationId: string,
  userId: string,
): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "quotations" SET "seller_id" = $1::uuid WHERE "id" = $2::uuid`,
      userId,
      quotationId,
    );
  } finally {
    await db.$disconnect();
  }
}

/**
 * D-256 (3): la marca `Factura externa:` la pone solo el importador (al confirmar, pasa de la
 * cotización al pedido), y el API ya no la acepta tipeada. Un spec que necesita un pedido con
 * esa marca sin recorrer el importador entero la escribe acá, contra la base de pruebas.
 */
export async function setSalesOrderNotesForTest(orderId: string, notes: string): Promise<void> {
  const db = testDatabaseClient();
  try {
    await db.$executeRawUnsafe(
      `UPDATE "sales_orders" SET "notes" = $1 WHERE "id" = $2::uuid`,
      notes,
      orderId,
    );
  } finally {
    await db.$disconnect();
  }
}
