/**
 * Seed: crea (o actualiza) el usuario ADMINISTRADOR inicial desde
 * ADMIN_EMAIL / ADMIN_PASSWORD con `mustChangePassword = true`. Si el usuario ya existe solo
 * asegura rol y estado; con SEED_ADMIN_FOR_TESTS=1 (pruebas) también restablece la contraseña y quita el cambio obligatorio.
 * Lee variables de process.env (cargar .env antes con dotenv o el entorno de CI).
 */
import 'dotenv/config';
import {
  BusinessLineCode,
  DocType,
  FiscalDocType,
  InventoryStrategy,
  PrismaClient,
  Role,
} from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Las cinco líneas de negocio (§2.2). `services` es la única `NOOP` (sin kardex).
 *
 * `quotationRequired` viaja acá y no solo en su migración (D-065), y **no es redundante**: esa
 * migración es un `UPDATE` sobre las filas que existían, así que en una base recién reseteada
 * —el E2E local y la rama `ci` en cada corrida— las líneas las crea este seed y nacían todas
 * con el `false` por defecto. Con eso, `metallic-roofing` dejaba de exigir cotización y RF-31
 * quedaba apagado justo donde se lo prueba: el caso "el pedido directo se rechaza en coberturas"
 * fallaba con un 201, y el guardrail parecía roto cuando lo que faltaba era el dato.
 */
const BUSINESS_LINES: {
  code: BusinessLineCode;
  name: string;
  inventoryStrategy: InventoryStrategy;
  quotationRequired?: boolean;
}[] = [
  { code: BusinessLineCode.DRYWALL, name: 'Drywall', inventoryStrategy: InventoryStrategy.STOCK },
  {
    code: BusinessLineCode.METALLIC_ROOFING,
    name: 'Metallic Roofing',
    inventoryStrategy: InventoryStrategy.STOCK,
    // D-065: coberturas no admite pedido directo, siempre pasa por cotización (RF-31).
    quotationRequired: true,
  },
  {
    code: BusinessLineCode.ROOFING,
    name: 'Roofing (UPVC)',
    inventoryStrategy: InventoryStrategy.STOCK,
  },
  { code: BusinessLineCode.TRADING, name: 'Trading', inventoryStrategy: InventoryStrategy.STOCK },
  { code: BusinessLineCode.SERVICES, name: 'Services', inventoryStrategy: InventoryStrategy.NOOP },
];

/** Margen inicial por línea (D-032): 20% sugerido, 10% mínimo. El ADMINISTRADOR lo ajusta luego. */
const DEFAULT_MARGIN_PCT = '20.0000';
const DEFAULT_MIN_MARGIN_PCT = '10.0000';

async function seedBusinessLinesAndPricing(): Promise<void> {
  for (const line of BUSINESS_LINES) {
    const businessLine = await prisma.businessLine.upsert({
      where: { code: line.code },
      create: { ...line, quotationRequired: line.quotationRequired ?? false },
      update: {
        name: line.name,
        inventoryStrategy: line.inventoryStrategy,
        // Solo se fuerza donde el dato es una regla del dominio: en una base que ya existe, el
        // resto lo administra el dueño desde la UI y el seed no tiene por qué pisarlo.
        ...(line.quotationRequired === true ? { quotationRequired: true } : {}),
      },
    });
    await prisma.pricingSetting.upsert({
      where: { businessLineId: businessLine.id },
      create: {
        businessLineId: businessLine.id,
        marginPct: DEFAULT_MARGIN_PCT,
        minMarginPct: DEFAULT_MIN_MARGIN_PCT,
      },
      update: {},
    });
  }
  console.warn(`Seed listo: ${BUSINESS_LINES.length} líneas de negocio y sus márgenes por defecto`);
}

/**
 * Los datos iniciales que **sembró una migración** y que el seed tiene que saber reponer.
 *
 * Son tres —el cliente genérico (D-077), las series fiscales (D-072) y la fila de
 * configuración de facturación (D-073)— y las tres las creó la migración de la Fase 5b.
 *
 * **Por qué se mudan acá.** Una migración corre **una vez**: describe un cambio de esquema y,
 * de paso, dejó unas filas. Eso alcanzó mientras la base de pruebas conservaba esas filas
 * entre corridas; el día que el reset pasó a vaciarlas —para que los maestros dejaran de
 * acumularse y de producir 409 al azar— se fueron con todo lo demás y nada las repuso. El
 * síntoma no se parecía a su causa: «la migración de 5b siembra el cliente "público en
 * general"» en un test de importación, y «No hay una serie activa para emitir FACTURA» en
 * diez casos repartidos por cinco archivos que no hablan de series.
 *
 * El seed responde otra pregunta —**qué necesita esta base para ser usable**, la misma que ya
 * responden las líneas de negocio y sus márgenes— y corre siempre, así que es su lugar. Todo
 * es idempotente: contra una base que ya los tiene (producción, demo) no hace nada.
 *
 * **La regla, para lo que venga:** un dato inicial que una migración inserta tiene que estar
 * también acá, o desaparece en el primer reset y reaparece como un fallo lejos de su causa.
 */

/** D-072: las series del punto de emisión. La NC hereda la del tipo que afecta. */
const FISCAL_SERIES: {
  docType: FiscalDocType;
  series: string;
  affectedDocType: FiscalDocType | null;
}[] = [
  { docType: FiscalDocType.FACTURA, series: 'F001', affectedDocType: null },
  { docType: FiscalDocType.BOLETA, series: 'B001', affectedDocType: null },
  { docType: FiscalDocType.NOTA_CREDITO, series: 'FC01', affectedDocType: FiscalDocType.FACTURA },
  { docType: FiscalDocType.NOTA_CREDITO, series: 'BC01', affectedDocType: FiscalDocType.BOLETA },
  { docType: FiscalDocType.GUIA_REMISION_REMITENTE, series: 'T001', affectedDocType: null },
];

async function seedInvoicing(): Promise<void> {
  for (const serie of FISCAL_SERIES) {
    await prisma.fiscalSeries.upsert({
      where: { series: serie.series },
      create: { ...serie, correlative: 0, isActive: true },
      // **No se pisa nada de una serie que ya existe.** El correlativo es un hecho fiscal —
      // dice cuántos comprobantes salieron— y `isActive` lo administra el dueño desde la
      // pantalla de series. El seed las crea si faltan y no opina sobre las que están.
      update: {},
    });
  }
  // D-073: fila única de configuración. Nace con el PSE en línea y la alerta en 6 horas.
  const settings = await prisma.invoicingSetting.findFirst({ select: { id: true } });
  if (!settings) {
    await prisma.invoicingSetting.create({ data: { providerOffline: false, alertAfterHours: 6 } });
  }
  console.warn(`Seed listo: ${FISCAL_SERIES.length} series fiscales y la configuración del PSE`);
}

/**
 * D-077: el cliente **«público en general»**, el receptor de toda boleta sin identificar.
 * Ver el bloque de arriba para por qué vive acá y no solo en su migración.
 */
const GENERIC_CUSTOMER_NAME = 'PÚBLICO EN GENERAL';

async function seedGenericCustomer(): Promise<void> {
  const existing = await prisma.customer.findUnique({
    where: { docType_docNumber: { docType: DocType.DNI, docNumber: '00000000' } },
    select: { id: true, name: true, isSystem: true },
  });

  if (!existing) {
    await prisma.customer.create({
      data: {
        docType: DocType.DNI,
        docNumber: '00000000',
        name: GENERIC_CUSTOMER_NAME,
        creditDays: 0,
        isSystem: true,
        isActive: true,
      },
    });
    console.warn('Seed listo: cliente «público en general» (D-077)');
    return;
  }

  // **La marca no se fuerza sobre una fila que ya existe con otro nombre**, y esa es la
  // diferencia con la migración, que corría una vez sobre una base que no podía tenerla.
  // Este seed corre en **cada** `pnpm db:prod`, y el DNI `00000000` es exactamente el relleno
  // que alguien escribe cuando importa un cliente sin documento. Marcarlo `isSystem` lo
  // volvería inmutable (`CustomersService` no lo deja editar ni dar de baja) y —peor— el
  // mostrador lo resolvería como «público en general»: sus boletas saldrían sin identificar al
  // receptor, que es un problema fiscal y no de datos.
  if (existing.name !== GENERIC_CUSTOMER_NAME) {
    console.warn(
      `Seed: el DNI 00000000 ya lo tiene «${existing.name}», que NO es el cliente genérico. ` +
        'No se toca. Si el mostrador lo necesita, hay que liberar ese documento a mano (D-077).',
    );
    return;
  }
  if (!existing.isSystem) {
    await prisma.customer.update({ where: { id: existing.id }, data: { isSystem: true } });
  }
  console.warn('Seed listo: cliente «público en general» (D-077)');
}

async function main(): Promise<void> {
  await seedBusinessLinesAndPricing();
  await seedGenericCustomer();
  await seedInvoicing();

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Faltan ADMIN_EMAIL o ADMIN_PASSWORD en el entorno');
  }

  // En pruebas (E2E/CI) el admin entra sin cambio de contraseña obligatorio; ese flujo se prueba con usuarios nuevos.
  const forTests = process.env.SEED_ADMIN_FOR_TESTS === '1';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Administrador',
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: !forTests,
    },
    update: {
      role: Role.ADMINISTRADOR,
      active: true,
      ...(forTests ? { passwordHash, mustChangePassword: false } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: null,
      action: 'seed.admin',
      entity: 'users',
      entityId: admin.id,
      after: { email: admin.email, role: admin.role },
    },
  });

  console.warn(`Seed listo: administrador ${admin.email}`);
}

main()
  .catch((err: unknown) => {
    console.error('Error en seed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
