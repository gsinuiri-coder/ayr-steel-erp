import { Injectable, Logger } from '@nestjs/common';
import { CoilStatus, DocType, InventoryStrategy, Prisma } from '@prisma/client';
import {
  CoilAdjustDate,
  CoilImportMode,
  businessToday,
  COIL_BUSINESS_LINES,
  Currency,
  decimalStringSchema,
  ImportEntity,
  toDecimal,
  toFixedString,
  type ImportOptions,
} from '@ayr/shared';
import { CoilsService } from '../../coils/coils.service';
import { toPrismaLineCode } from '../../common/business-line-code';
import { OperationDateService } from '../../common/operation-date.service';
import { DocumentLookupService } from '../../customers/document-lookup.service';
import { InventoryService } from '../../inventory/inventory.service';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeDate, normalizeDecimal } from './sales-history.adapter';
import {
  getField,
  type ImportColumn,
  type RowImportAdapter,
  type RowValidation,
} from './import-adapter.interface';

/**
 * Las columnas **tal como vienen** en el Excel del dueño (D-137).
 *
 * No es la planilla canónica de RF-12 con otros nombres: es otro archivo, con otros datos
 * (RUC en vez de código de proveedor, número de factura, valorización, stock actual) y sin
 * algunos que aquella exige (la línea de negocio, que acá es una opción del lote).
 *
 * Las dos últimas —`finishCode` y `colorCode`— **no existen en el Excel**: son los campos
 * con los que el preview corrige un acabado que no mapeó. `getField` las lee del dato ya
 * normalizado cuando el encabezado no está, que es exactamente para lo que existe.
 */
const COLUMNS = {
  finishText: { key: 'finishText', header: 'Acabado', required: true },
  supplierRuc: { key: 'supplierRuc', header: 'Ruc', required: true },
  supplierName: { key: 'supplierName', header: 'Proveedor', required: true },
  invoiceNumber: { key: 'invoiceNumber', header: 'Factura N°', required: false },
  purchaseDate: { key: 'purchaseDate', header: 'Fecha de Compra', required: true },
  thicknessMm: { key: 'thicknessMm', header: 'Espesor (mm)', required: true },
  widthMm: { key: 'widthMm', header: 'Ancho Maestro (mm)', required: true },
  weightKg: { key: 'weightKg', header: 'Peso Compra (Kg)', required: true },
  stockKg: { key: 'stockKg', header: 'Stock Actual (Kg)', required: true },
  unitCostPerKg: { key: 'unitCostPerKg', header: 'Costo Unitario (S/ por Kg)', required: true },
  valuationPen: { key: 'valuationPen', header: 'Valorización Total (S/)', required: false },
  originalCurrency: { key: 'originalCurrency', header: 'Moneda Original', required: false },
  originalRate: { key: 'originalRate', header: 'Tipo de Cambio', required: false },
  status: { key: 'status', header: 'Estado', required: false },
  observations: { key: 'observations', header: 'Observaciones', required: false },
  finishCode: { key: 'finishCode', header: 'Acabado (código)', required: false },
  colorCode: { key: 'colorCode', header: 'Color (código)', required: false },
} satisfies Record<string, ImportColumn>;

const kgSchema = decimalStringSchema('KG', { positive: true });
const kgOrZeroSchema = decimalStringSchema('KG');
const mmSchema = decimalStringSchema('MM', { positive: true });
const moneySchema = decimalStringSchema('MONEY', { positive: true });
const moneyOrZeroSchema = decimalStringSchema('MONEY');

/**
 * Tolerancia de la comprobación `Peso × Costo ≈ Valorización`, en soles.
 *
 * No es cero porque el Excel redondea las tres columnas por su cuenta y una bobina de
 * 6.000 kg arrastra centavos de diferencia sin que nada esté mal. Un error de tipeo real
 * —un dígito de más, una coma corrida— se sale de esto por varios órdenes de magnitud.
 */
const VALUATION_TOLERANCE_PEN = '1.00';

/** Cuánto vive una consulta de RUC en la caché del proceso. */
const LOOKUP_TTL_MS = 10 * 60 * 1000;
/** Tope de la caché: un archivo grande no puede hacer crecer la memoria sin límite. */
const LOOKUP_CACHE_MAX = 500;

/** Una fila de maestro tal como la necesita el mapeo del acabado. */
interface MasterRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

/** Cuánto viven los maestros en la caché del proceso. Una importación entera dura menos. */
const MASTERS_TTL_MS = 30 * 1000;

interface CachedLookup {
  name: string | null;
  address: string | null;
  at: number;
}

/**
 * Carga histórica de bobinas desde el Excel real del negocio (D-137).
 *
 * Tres cosas lo separan del importador canónico de RF-12, y las tres salen de que este
 * archivo lo escribió el negocio y no el sistema:
 *
 * 1. **El proveedor viene por RUC, y puede no existir.** Se crea solo, consultando el
 *    padrón; si el padrón no responde, se crea igual con el nombre del Excel y queda
 *    marcado "por completar". Una importación que se traba porque un tercero está caído no
 *    es una opción: la carga de la historia del negocio no puede depender de eso.
 * 2. **El acabado es texto libre.** Se intenta mapear contra el maestro (código, nombre, y
 *    nombre + color en el mismo campo, que es como suele venir en coberturas prepintadas);
 *    lo que no mapea **no se inventa**: la fila queda inválida y el preview ofrece elegir o
 *    crear. Auto-crear un acabado en silencio le pone un factor de densidad inventado a
 *    todo lo que se role con él.
 * 3. **Hay dos pesos y ninguna historia entre ellos.** El de compra y el que queda hoy. Qué
 *    hacer con la diferencia es la opción `mode` del lote (D-137).
 */
@Injectable()
export class CoilsHistoryImportAdapter implements RowImportAdapter {
  entity = ImportEntity.COILS_HISTORY;
  columns = Object.values(COLUMNS);
  private readonly logger = new Logger(CoilsHistoryImportAdapter.name);
  /** RUC → padrón, para no consultar el mismo proveedor una vez por fila. */
  private readonly lookupCache = new Map<string, CachedLookup>();
  /** Acabados y colores, para no releerlos enteros una vez por fila. */
  private mastersCache: {
    value: { finishes: MasterRow[]; colors: MasterRow[] };
    at: number;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly coils: CoilsService,
    private readonly inventory: InventoryService,
    private readonly operationDate: OperationDateService,
    private readonly lookup: DocumentLookupService,
  ) {}

  async validateRow(raw: Record<string, unknown>, options?: ImportOptions): Promise<RowValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // --- línea de negocio (opción del lote, no del archivo) -------------------
    const businessLine = options?.businessLine ?? null;
    let businessLineId: string | undefined;
    if (businessLine === null || !COIL_BUSINESS_LINES.includes(businessLine)) {
      errors.push('Elige la línea de negocio de las bobinas antes de importar el archivo');
    } else {
      const line = await this.prisma.businessLine.findUnique({
        where: { code: toPrismaLineCode(businessLine) },
      });
      if (!line || line.inventoryStrategy === InventoryStrategy.NOOP) {
        errors.push(`La línea "${businessLine}" no lleva inventario`);
      } else {
        businessLineId = line.id;
      }
    }

    // --- proveedor por RUC ----------------------------------------------------
    const supplierRuc = getField(raw, COLUMNS.supplierRuc).replace(/\D/g, '');
    const supplierNameRaw = getField(raw, COLUMNS.supplierName);
    let supplierId: string | null = null;
    let supplierCode: string | null = null;
    let supplierName = supplierNameRaw;
    let supplierNeedsReview = false;
    let supplierAction: 'EXISTING' | 'CREATE' = 'EXISTING';

    if (supplierRuc.length !== 11) {
      errors.push(`RUC inválido: "${getField(raw, COLUMNS.supplierRuc)}" (deben ser 11 dígitos)`);
    } else {
      const existing = await this.prisma.supplier.findFirst({
        where: { docType: DocType.RUC, docNumber: supplierRuc },
        select: { id: true, code: true, name: true, isActive: true },
      });
      if (existing) {
        if (!existing.isActive) {
          errors.push(`El proveedor ${supplierRuc} (${existing.name}) está desactivado`);
        }
        supplierId = existing.id;
        supplierCode = existing.code;
        supplierName = existing.name;
      } else {
        supplierAction = 'CREATE';
        const padron = await this.lookupSupplierName(supplierRuc);
        if (padron === null) {
          if (!supplierNameRaw) {
            errors.push(
              `El proveedor ${supplierRuc} no existe y el padrón no respondió: escribe su razón social`,
            );
          }
          supplierNeedsReview = true;
          warnings.push(
            `Se creará el proveedor ${supplierRuc} con el nombre del archivo y quedará marcado "por completar": el padrón de SUNAT no respondió`,
          );
        } else {
          supplierName = padron;
          warnings.push(`Se creará el proveedor ${supplierRuc} — ${padron}`);
        }
      }
    }

    // --- acabado y color ------------------------------------------------------
    const finishText = getField(raw, COLUMNS.finishText);
    const resolved = await this.resolveFinishAndColor(raw, finishText);
    if (resolved.error) errors.push(resolved.error);

    // --- geometría, pesos y costo --------------------------------------------
    const thicknessMm = parseField(raw, COLUMNS.thicknessMm, mmSchema, 'El espesor', errors);
    const widthMm = parseField(raw, COLUMNS.widthMm, mmSchema, 'El ancho maestro', errors);
    const weightKg = parseField(raw, COLUMNS.weightKg, kgSchema, 'El peso de compra', errors);
    const stockKg = parseField(raw, COLUMNS.stockKg, kgOrZeroSchema, 'El stock actual', errors);
    const unitCostPerKg = parseField(
      raw,
      COLUMNS.unitCostPerKg,
      moneySchema,
      'El costo unitario',
      errors,
    );
    const valuationPen = parseField(
      raw,
      COLUMNS.valuationPen,
      moneyOrZeroSchema,
      'La valorización',
      errors,
    );

    // El stock que queda no puede ser mayor que lo que se compró: no hay forma de que una
    // bobina tenga hoy más kilos de los que entraron, y con `mode = ADJUST` eso además
    // pediría una salida negativa.
    if (weightKg !== undefined && stockKg !== undefined && toDecimal(stockKg).gt(weightKg)) {
      errors.push(
        `El stock actual (${stockKg} kg) es mayor que el peso de compra (${weightKg} kg)`,
      );
    }

    // Peso × Costo ≈ Valorización. Es un **aviso** y no un error: la fila se puede importar
    // igual (los tres números entran tal cual, y el que manda para el kardex es el costo),
    // pero nadie tiene que descubrir semanas después que la valorización del Excel no
    // cuadraba con sus propias columnas.
    if (weightKg !== undefined && unitCostPerKg !== undefined && valuationPen !== undefined) {
      const expected = toDecimal(weightKg).times(unitCostPerKg);
      const diff = expected.minus(valuationPen).abs();
      if (diff.gt(VALUATION_TOLERANCE_PEN)) {
        warnings.push(
          `La valorización del archivo (S/ ${toDecimal(valuationPen).toFixed(2)}) no coincide con peso × costo (S/ ${expected.toFixed(2)})`,
        );
      }
    }

    // --- fecha de compra ------------------------------------------------------
    // Una celda de fecha de xlsx llega ya como `YYYY-MM-DD` (D-108); un csv puede traer
    // `05/09/2026`. Se normalizan las dos formas acá y no en el validador, que solo sabe
    // rechazar lo que no entiende.
    const purchaseDate = normalizeDate(getField(raw, COLUMNS.purchaseDate));
    let operationDate: string | undefined;
    if (!purchaseDate) {
      errors.push('La fecha de compra es obligatoria');
    } else {
      try {
        operationDate = this.operationDate.resolveHistorical(purchaseDate);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Fecha de compra inválida');
      }
    }

    // --- estado ---------------------------------------------------------------
    const status = parseStatus(getField(raw, COLUMNS.status), errors);

    // --- lo que no tiene destino propio, a las observaciones (decisión del dueño) ---
    const originalCurrency = getField(raw, COLUMNS.originalCurrency);
    const originalRate = getField(raw, COLUMNS.originalRate);
    const invoiceNumber = getField(raw, COLUMNS.invoiceNumber);
    const observations = getField(raw, COLUMNS.observations);

    return {
      data: {
        businessLineId,
        supplierRuc,
        supplierName,
        supplierId,
        supplierCode,
        supplierAction,
        supplierNeedsReview,
        finishText,
        finishCode: resolved.finishCode,
        finishId: resolved.finishId,
        colorCode: resolved.colorCode,
        colorId: resolved.colorId,
        invoiceNumber,
        purchaseDate,
        operationDate,
        thicknessMm,
        widthMm,
        weightKg,
        stockKg,
        unitCostPerKg,
        valuationPen,
        originalCurrency,
        originalRate,
        status,
        observations,
        notes: buildNotes({ invoiceNumber, originalCurrency, originalRate, observations }),
      },
      errors,
      warnings,
    };
  }

  /**
   * No hay clave natural (RF-12): dos bobinas idénticas del mismo proveedor son dos
   * bobinas distintas, cada una con su correlativo. Ni siquiera el número de factura sirve:
   * una factura trae varias bobinas.
   */
  dedupeKey(): string | undefined {
    return undefined;
  }

  async createEntity(
    tx: Prisma.TransactionClient,
    data: Record<string, unknown>,
    actorId: string,
    options?: ImportOptions,
  ): Promise<string> {
    const supplierId =
      (data.supplierId as string | null) ??
      (await this.ensureSupplier(tx, {
        docNumber: data.supplierRuc as string,
        name: data.supplierName as string,
        needsReview: data.supplierNeedsReview === true,
      }));

    const operationDate = data.operationDate as string;
    const weightKg = data.weightKg as string;
    const coil = await this.coils.create(tx, {
      businessLineId: data.businessLineId as string,
      supplierId,
      finishId: data.finishId as string,
      colorId: (data.colorId as string | null) ?? null,
      // Siempre entra el **peso de compra**, en los dos modos. Lo que cambia entre uno y
      // otro es si además sale la diferencia: una bobina que entra directamente con su
      // saldo de hoy perdería su propio costo total y su historia de compra.
      weightKg,
      widthMm: data.widthMm as string,
      thicknessMm: data.thicknessMm as string,
      // El costo del Excel ya está en soles (decisión del dueño): la moneda original y su
      // tipo de cambio viajan a las observaciones y no vuelven a entrar en ningún cálculo.
      currency: Currency.PEN,
      exchangeRate: '1.0000',
      unitCostPerKg: data.unitCostPerKg as string,
      status: data.status as CoilStatus,
      notes: (data.notes as string) || undefined,
      refType: 'IMPORT',
      actorId,
      operationDate,
    });

    // Modo ajuste: la diferencia entre lo que entró y lo que queda sale como una salida
    // retrofechada. Es un consumo real que ocurrió antes del sistema y del que no hay
    // registro; escribirlo como movimiento —y no como un saldo inicial distinto— lo deja
    // visible en el kardex de la bobina, que es donde alguien lo va a buscar.
    if (options?.mode === CoilImportMode.ADJUST) {
      const consumed = toDecimal(weightKg).minus(toDecimal(data.stockKg as string));
      if (consumed.gt(0)) {
        await this.inventory.record(tx, {
          businessLineId: data.businessLineId as string,
          itemType: 'COIL',
          itemId: coil.id,
          type: 'OUT',
          qty: toFixedString(consumed, 'KG'),
          unit: 'KGM',
          refType: 'IMPORT',
          notes: 'Consumo pre-sistema (carga histórica)',
          actorId,
          operationDate: adjustDate(operationDate, options.adjustDate),
        });
      }
    }
    return coil.id;
  }

  /**
   * Encuentra o crea el proveedor **dentro de la transacción de la fila**.
   *
   * Se resuelve acá y no en la validación porque diez filas del mismo RUC nuevo confirman
   * en diez transacciones distintas: la primera lo crea y las nueve siguientes lo
   * encuentran. El `P2002` que dos transacciones simultáneas pueden producir se resuelve
   * releyendo, que es la fila que queríamos.
   */
  private async ensureSupplier(
    tx: Prisma.TransactionClient,
    input: { docNumber: string; name: string; needsReview: boolean },
  ): Promise<string> {
    const existing = await tx.supplier.findFirst({
      where: { docType: DocType.RUC, docNumber: input.docNumber },
      select: { id: true },
    });
    if (existing) return existing.id;

    const code = await this.freeSupplierCode(tx, input.name || input.docNumber);
    try {
      const created = await tx.supplier.create({
        data: {
          code,
          docType: DocType.RUC,
          docNumber: input.docNumber,
          name: (input.name || `RUC ${input.docNumber}`).slice(0, 160),
          needsReview: input.needsReview,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Solo un choque de unicidad justifica releer: cualquier otra cosa —una conexión
      // caída, un CHECK violado— quedaría enmascarada como "otra transacción ganó la
      // carrera" y el usuario vería un mensaje que no describe lo que pasó.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      const raced = await tx.supplier.findFirst({
        where: { docType: DocType.RUC, docNumber: input.docNumber },
        select: { id: true },
      });
      if (raced) return raced.id;
      throw new Error(`No se pudo crear el proveedor ${input.docNumber}`);
    }
  }

  /**
   * Un código corto libre derivado del nombre (3-6 letras, RF-13). Es el primer segmento
   * del código de cada bobina, así que tiene que ser legible: `ACEROS DEL SUR` → `ACEROS`.
   */
  private async freeSupplierCode(tx: Prisma.TransactionClient, name: string): Promise<string> {
    // Solo letras: el código es el primer segmento del código de cada bobina (RF-13) y su
    // schema no admite ni espacios ni dígitos. Sin este filtro, "SIDER PERU" daba "SIDER "
    // (con espacio) y "3M PERU" daba "3M PER".
    const letters = name
      .normalize('NFD')
      .replace(COMBINING_DIACRITICS, '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    const base = (letters.slice(0, 6) || 'PROV').padEnd(3, 'X');
    // 27 intentos: el original y una letra por cada una del alfabeto. Más consultas no
    // producirían candidatos nuevos.
    for (let attempt = 0; attempt < 27; attempt += 1) {
      // El sufijo numérico no cabe (el código es solo letras), así que se desplaza por el
      // alfabeto: `ACEROS`, `ACEROA`, `ACEROB`…
      const candidate =
        attempt === 0
          ? base
          : `${base.slice(0, 5)}${String.fromCharCode(65 + ((attempt - 1) % 26))}`;
      const taken = await tx.supplier.findUnique({ where: { code: candidate } });
      if (!taken) return candidate;
    }
    throw new Error(`No se pudo generar un código corto libre para "${name}"`);
  }

  /**
   * El nombre que el padrón devuelve para un RUC, o `null` si no se pudo saber.
   *
   * `DocumentLookupService` nunca lanza (D-067): sin token, con la API caída o con un RUC
   * inexistente devuelve `found: false`. Acá eso es `null`, y `null` **no** es un error de
   * la fila: es la señal de que el proveedor se va a crear con lo que dice el Excel y va a
   * quedar marcado para revisar.
   */
  private async lookupSupplierName(ruc: string): Promise<string | null> {
    const cached = this.lookupCache.get(ruc);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.name;

    const result = await this.lookup.lookup(DocType.RUC, ruc);
    const name = result.found ? result.name : null;
    if (this.lookupCache.size >= LOOKUP_CACHE_MAX) {
      const oldest = this.lookupCache.keys().next();
      if (!oldest.done) this.lookupCache.delete(oldest.value);
    }
    this.lookupCache.set(ruc, { name, address: result.address, at: Date.now() });
    if (name === null && result.reason === 'UNAVAILABLE') {
      this.logger.warn(`El padrón no respondió para un RUC de la importación de bobinas`);
    }
    return name;
  }

  /**
   * Los dos maestros contra los que se mapea el acabado, cacheados por unos segundos.
   *
   * `validateRow` corre **una vez por fila**, así que sin caché una planilla de 2.000 filas
   * pedía los dos maestros enteros 4.000 veces. No cambian durante una importación: el TTL
   * corto es lo que hace que una edición del maestro entre medio se vea igual, sin tener que
   * pasar estado por una interfaz que no lo tiene.
   */
  private async masters(): Promise<{ finishes: MasterRow[]; colors: MasterRow[] }> {
    const now = Date.now();
    if (this.mastersCache && now - this.mastersCache.at < MASTERS_TTL_MS) {
      return this.mastersCache.value;
    }
    const [finishes, colors] = await Promise.all([
      this.prisma.finish.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
      this.prisma.color.findMany({ select: { id: true, code: true, name: true, isActive: true } }),
    ]);
    const value = { finishes, colors };
    this.mastersCache = { value, at: now };
    return value;
  }

  /**
   * Mapea el texto de "Acabado" contra el maestro, y de paso contra el de colores.
   *
   * Tres intentos, en orden, y ninguno inventa nada:
   *
   * 1. lo que el preview ya corrigió (`finishCode`/`colorCode`), que siempre gana;
   * 2. el texto entero como código o como nombre de un acabado;
   * 3. el texto como "acabado + color" —`ALUZINC ROJO`—, que es como suele venir en una
   *    planilla de coberturas prepintadas: se le quita el nombre de un color conocido y se
   *    reintenta con lo que queda.
   *
   * Si nada mapea, devuelve el error y **no** crea nada. Un acabado auto-creado le pone un
   * factor de densidad inventado a cada kilo teórico que se calcule con él.
   */
  private async resolveFinishAndColor(
    raw: Record<string, unknown>,
    finishText: string,
  ): Promise<{
    finishCode: string;
    finishId?: string;
    colorCode: string;
    colorId: string | null;
    error?: string;
  }> {
    const { finishes, colors } = await this.masters();

    // 1. La corrección del preview manda.
    const pickedFinish = getField(raw, COLUMNS.finishCode).toUpperCase();
    const pickedColor = getField(raw, COLUMNS.colorCode).toUpperCase();
    if (pickedFinish) {
      const finish = finishes.find((f) => f.code.toUpperCase() === pickedFinish);
      if (!finish) {
        return {
          finishCode: pickedFinish,
          colorCode: pickedColor,
          colorId: null,
          error: `No existe el acabado "${pickedFinish}"`,
        };
      }
      if (!finish.isActive) {
        return {
          finishCode: pickedFinish,
          colorCode: pickedColor,
          colorId: null,
          error: `El acabado "${pickedFinish}" está desactivado`,
        };
      }
      const color = pickedColor ? colors.find((c) => c.code.toUpperCase() === pickedColor) : null;
      if (pickedColor && !color) {
        return {
          finishCode: finish.code,
          finishId: finish.id,
          colorCode: pickedColor,
          colorId: null,
          error: `No existe el color "${pickedColor}"`,
        };
      }
      if (color && !color.isActive) {
        return {
          finishCode: finish.code,
          finishId: finish.id,
          colorCode: pickedColor,
          colorId: null,
          error: `El color "${pickedColor}" está desactivado`,
        };
      }
      return {
        finishCode: finish.code,
        finishId: finish.id,
        colorCode: color?.code ?? '',
        colorId: color?.id ?? null,
      };
    }

    if (!finishText) {
      return { finishCode: '', colorCode: '', colorId: null, error: 'El acabado es obligatorio' };
    }

    const needle = normalize(finishText);
    // 2. El texto entero.
    const direct = finishes.find(
      (f) => normalize(f.code) === needle || normalize(f.name) === needle,
    );
    if (direct?.isActive) {
      return { finishCode: direct.code, finishId: direct.id, colorCode: '', colorId: null };
    }

    // 3. "acabado + color" en el mismo campo.
    const color = colors
      .filter((c) => c.isActive)
      .find((c) => needle.endsWith(` ${normalize(c.name)}`) || needle === normalize(c.name));
    if (color) {
      const rest = needle.replace(new RegExp(`\\s*${escapeRegExp(normalize(color.name))}$`), '');
      const finish = finishes.find(
        (f) => f.isActive && (normalize(f.code) === rest || normalize(f.name) === rest),
      );
      if (finish) {
        return {
          finishCode: finish.code,
          finishId: finish.id,
          colorCode: color.code,
          colorId: color.id,
        };
      }
    }

    return {
      finishCode: '',
      colorCode: '',
      colorId: null,
      error: `El acabado "${finishText}" no está en el maestro: elige uno de la lista o créalo`,
    };
  }
}

// U+0300..U+036F: las marcas diacríticas combinantes que deja `normalize('NFD')`.
const COMBINING_DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Sin tildes, en minúsculas y con los espacios colapsados, para comparar texto libre. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Abierta"/"Cerrada" del Excel → `OPEN`/`CLOSED`. También acepta los valores del sistema,
 * porque una planilla ya corregida a mano puede traerlos. Vacío = `CLOSED` (D-116: una
 * bobina nace cerrada salvo que alguien diga lo contrario).
 */
function parseStatus(raw: string, errors: string[]): CoilStatus {
  const value = normalize(raw);
  if (!value) return CoilStatus.CLOSED;
  if (value.startsWith('abiert') || value === 'open') return CoilStatus.OPEN;
  if (value.startsWith('cerrad') || value === 'closed') return CoilStatus.CLOSED;
  errors.push(`Estado desconocido: "${raw}" (se espera Abierta o Cerrada)`);
  return CoilStatus.CLOSED;
}

/**
 * Las observaciones de la bobina: todo lo del Excel que **no tiene destino propio** en el
 * modelo, junto y legible.
 *
 * Es la decisión del dueño para esta carga: sin campos nuevos. El número de factura entra
 * acá y no como una compra formal porque la carga histórica no reconstruye compras — las
 * nuevas sí van por Fase 2 —, así que crear un comprobante de compra por cada bobina
 * inventaría cuentas por pagar que ya se pagaron.
 */
function buildNotes(input: {
  invoiceNumber: string;
  originalCurrency: string;
  originalRate: string;
  observations: string;
}): string {
  const parts: string[] = [];
  if (input.invoiceNumber) parts.push(`Factura ${input.invoiceNumber}`);
  if (input.originalCurrency && input.originalCurrency.toUpperCase() !== Currency.PEN) {
    parts.push(
      input.originalRate
        ? `Moneda original ${input.originalCurrency} (TC ${input.originalRate})`
        : `Moneda original ${input.originalCurrency}`,
    );
  }
  if (input.observations) parts.push(input.observations);
  return parts.join(' · ').slice(0, 500);
}

/** Con qué fecha sale el consumo pre-sistema del modo ajuste (D-137). */
function adjustDate(purchaseDate: string, mode: CoilAdjustDate | undefined): string {
  if (mode !== CoilAdjustDate.MONTH_END) return purchaseDate;
  const [year, month] = purchaseDate.split('-').map(Number);
  if (!year || !month) return purchaseDate;
  // Día 0 del mes siguiente = último día de este mes, sin tablas ni años bisiestos a mano.
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  // D-124: ninguna fecha de operación puede ser futura. Una bobina comprada este mes tiene
  // su fin de mes por delante, y es lo que el enum ya prometía ("o hoy, si ese fin de mes
  // todavía no llegó").
  const today = businessToday();
  return end > today ? today : end;
}

/** Valida un campo decimal de la fila y acumula el error en español si no pasa. */
function parseField(
  raw: Record<string, unknown>,
  column: ImportColumn,
  schema: ReturnType<typeof decimalStringSchema>,
  label: string,
  errors: string[],
): string | undefined {
  const value = normalizeDecimal(getField(raw, column));
  if (!value) {
    if (column.required) errors.push(`${label} es obligatorio`);
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    errors.push(`${label}: ${parsed.error.issues[0]?.message ?? 'valor inválido'}`);
    return undefined;
  }
  return parsed.data;
}
