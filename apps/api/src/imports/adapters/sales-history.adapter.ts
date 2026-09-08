import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DocType,
  FiscalDocType,
  InventoryItemType,
  PaymentTerms,
  Prisma,
  ProductionOrderStatus,
  ReservationStatus,
  SalesOrderStatus,
} from '@prisma/client';
import {
  businessToday,
  decimalStringSchema,
  fiscalDocumentNumber,
  ImportEntity,
  ImportFulfillment,
  MAX_SALES_ITEMS,
  MAX_VALUE,
  piecesMeters,
  salesLineTotals,
  salesOrderCode,
  toDecimal,
  toFixedString,
  Unit,
  type RoofingPieceDto,
} from '@ayr/shared';
import type { RequestUser } from '../../auth/auth.types';
import { OperationDateService } from '../../common/operation-date.service';
import { ENV, type Env } from '../../config/env';
import { DocumentLookupService } from '../../customers/document-lookup.service';
import {
  asText,
  SALES_HISTORY_TOTAL_TOLERANCE_PEN,
  salesHistoryTotalMismatch,
} from '../fiscal-import-math';
import {
  FiscalImportService,
  type ImportedDocumentLine,
} from '../../invoicing/fiscal-import.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RoofingProductionService } from '../../production/roofing-production.service';
import { roofingToleranceMm } from '../../production/roofing-coil-match';
import {
  isMadeToMeasure,
  ROOFING_PRODUCT_SELECT,
  roofingSpecThicknessMm,
  theoreticalKgForMeters,
} from '../../sales/sales-lines';
import {
  findRawMaterialSpec,
  rawMaterialAvailability,
  rawMaterialSpecLabels,
} from '../../sales/raw-material';
import { SalesOrdersService } from '../../sales/sales-orders.service';
import {
  getField,
  type GroupedImportAdapter,
  type GroupRow,
  type ImportColumn,
  type RowIssues,
  type RowValidation,
} from './import-adapter.interface';

/**
 * Las columnas **tal como las exporta el sistema de facturación del dueño** (D-138).
 *
 * Es el mismo hecho que importa `FISCAL_DOCUMENTS` (RF-71) leído de otro archivo: aquel
 * espera la planilla canónica del ERP —tipo, serie y correlativo en columnas separadas, el
 * cliente por número de documento, el precio unitario sin IGV—, y este lee el export real,
 * que trae `SERIE - NÚMERO` en un solo campo, el cliente como texto y los importes por
 * línea ya sumados. Hacer que uno se disfrazara del otro obligaba a retipear el archivo,
 * que es justo el trabajo que la importación viene a ahorrar.
 *
 * Las columnas que **no se usan** están declaradas igual, y a propósito: así aparecen en el
 * preview y el usuario ve que se leyeron y se descartaron, en vez de preguntarse si el
 * sistema las entendió mal.
 */
const COLUMNS = {
  issueDate: { key: 'issueDate', header: 'F. EMISIÓN', required: true },
  docTypeText: { key: 'docTypeText', header: 'TIPO COMPROBANTE', required: true },
  documentNumber: { key: 'documentNumber', header: 'SERIE - NÚMERO', required: true },
  customerText: { key: 'customerText', header: 'CLIENTE', required: true },
  adjustedDocument: { key: 'adjustedDocument', header: 'DOCUMENTO AJUSTADO', required: false },
  productCode: { key: 'productCode', header: 'CÓDIGO PRODUCTO', required: false },
  productName: { key: 'productName', header: 'NOMBRE PRODUCTO', required: true },
  unit: { key: 'unit', header: 'UNIDAD MEDIDA', required: false },
  qty: { key: 'qty', header: 'CANTIDAD', required: true },
  discountPen: { key: 'discountPen', header: 'DESCUENTO TOTAL', required: false },
  netPen: { key: 'netPen', header: 'VALOR DE VENTA', required: true },
  igvPen: { key: 'igvPen', header: 'IGV', required: false },
  grossPen: { key: 'grossPen', header: 'PRECIO DE VENTA', required: true },
  /** Corrección del preview: el SKU al que se mapea la línea. No viene en el archivo. */
  sku: { key: 'sku', header: 'SKU', required: false },
  /**
   * D-141: el toggle del **documento**. No viene en el archivo y no puede venir: el export
   * dice qué se vendió, no qué falta entregar. `ENTREGADO` por defecto, que es lo que es
   * casi todo un histórico.
   */
  fulfillment: { key: 'fulfillment', header: 'ENTREGA', required: false },
  /**
   * D-141: los largos de una línea a medida, para un documento **pendiente**. Tampoco viene
   * en el archivo —ningún export de facturación desglosa las planchas— y por eso es
   * opcional: sin él la línea entra igual y el plan de corte lo arma planta (D-084).
   * Formato `largo(m) x cantidad`, separados por coma: `3.60x4, 5.00x2`.
   */
  piecesText: { key: 'piecesText', header: 'LARGOS', required: false },
} satisfies Record<string, ImportColumn>;

/**
 * Columnas que el archivo trae y esta importación **ignora a propósito** (D-138). Se listan
 * acá y no se leen en ningún lado; están escritas para que "por qué no importó la sede" sea
 * una pregunta con respuesta en el código y no una omisión.
 *
 * - `SEDE`, `VENDEDOR`: el ERP no modela sucursales ni comisiones todavía.
 * - `ESTADO COMPROBANTE`: se aceptan todas (decisión del dueño); una baja ante SUNAT se
 *   registra después con la ruta de D-110, que sí deja rastro.
 * - `MONEDA`, `TIPOCAMBIO`: todo el export ya viene en soles, que es la moneda única del
 *   ciclo de venta (D-064).
 * - `SERIE PRODUCTO`, `LOTE PRODUCTO`, `F. VENCIMIENTO LOTE`, `CÓDIGO HOMOLOGACIÓN`,
 *   `ALMACÉN`, `CATEGORÍA`, `CARACTERÍSTICAS`: no tienen destino en el modelo.
 */
export const IGNORED_SALES_COLUMNS = [
  'SEDE',
  'VENDEDOR',
  'ESTADO COMPROBANTE',
  'MONEDA',
  'TIPOCAMBIO',
  'SERIE PRODUCTO',
  'LOTE PRODUCTO',
  'F. VENCIMIENTO LOTE',
  'CÓDIGO HOMOLOGACIÓN',
  'ALMACÉN',
  'CATEGORÍA',
  'CARACTERÍSTICAS',
];

const qtySchema = decimalStringSchema('KG', { positive: true, max: MAX_VALUE.KG });
const moneySchema = decimalStringSchema('MONEY', { max: MAX_VALUE.MONEY });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_RE = /^[A-Z][A-Z0-9]{3}$/;
const DEFAULT_UNIT = 'NIU';

/**
 * D-142: el export real trae la unidad en **nombre largo** ("METRO LINEAL", "KILOGRAMO"),
 * no en el código UN/EDI que usa el catálogo (`Unit`, `@ayr/shared`). Sin este mapeo, una
 * línea de METRO LINEAL entraba como unidad literal `"METRO LINEAL"`, distinta de la `MTR`
 * del producto, y el aviso de descalce (`validatePendingLine`) disparaba en el 100% de las
 * líneas de coberturas en vez de solo en las que de verdad difieren.
 *
 * Solo cubre las cuatro formas que trae el export real (D-142); una unidad que no está acá
 * se deja tal cual la trajo el archivo, mayúscula y recortada — sigue sin bloquear nada, es
 * un dato más para que el usuario vea el descalce y decida.
 */
const UNIT_ALIASES: Record<string, string> = {
  'METRO LINEAL': Unit.MTR,
  METRO: Unit.MTR,
  KILOGRAMO: Unit.KGM,
  KILOGRAMOS: Unit.KGM,
  UNIDAD: Unit.NIU,
  UNIDADES: Unit.NIU,
  TONELADA: Unit.TNE,
  TONELADAS: Unit.TNE,
};

/** Normaliza la unidad del export al código que usa el catálogo (D-142). */
export function normalizeUnit(raw: string): string {
  const text = raw.toUpperCase().trim();
  return (UNIT_ALIASES[text] ?? text).slice(0, 20);
}
/**
 * Tolerancia del cuadre de **una sola línea** (neto + IGV vs. precio de venta), en soles.
 * El cuadre del **documento** entero usa `SALES_HISTORY_TOTAL_TOLERANCE_PEN` (D-142) — son
 * dos comprobaciones distintas y no hay ninguna del lado de la confirmación que dependa de
 * esta, así que no hace falta que compartan constante.
 */
const LINE_TOTAL_TOLERANCE_PEN = '0.10';
/** Cuánto vive una consulta de padrón en la caché del proceso. */
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const LOOKUP_CACHE_MAX = 500;

interface CachedLookup {
  name: string | null;
  address: string | null;
  at: number;
}

/**
 * Carga histórica de ventas desde el export real del negocio (D-138).
 *
 * Comparte con RF-71 todo lo que importa —el documento nace `IMPORTED` y `ACCEPTED`, con su
 * cuenta por cobrar, sin tocar el PSE, y reimportarlo archiva la versión anterior (D-109)—
 * porque el hecho es el mismo y lo crea el mismo servicio. Lo que cambia es la lectura del
 * archivo, y ahí hay tres decisiones que valen la pena:
 *
 * 1. **`DOCUMENTO AJUSTADO` con valor deja la fila fuera, con el motivo escrito.** Es una
 *    nota de crédito, y una NC importada necesita saber a qué comprobante afecta y con qué
 *    motivo del catálogo 09 — dos cosas que este export no trae. Adivinarlas es peor que no
 *    importarlas: una NC mal apuntada descuadra la cobranza del comprobante equivocado.
 * 2. **El cliente se auto-crea, el SKU no.** Un cliente que falta se resuelve solo (RUC +
 *    padrón, con el mismo fallback que las bobinas): equivocarse en su dirección no rompe
 *    nada. Un SKU inventado, en cambio, entra al catálogo con unidad y línea de negocio
 *    adivinadas y desde ahí ensucia stock, precios y kilos teóricos — así que el preview
 *    pide mapearlo o crearlo a mano.
 * 3. **El precio unitario sale de `VALOR DE VENTA / CANTIDAD`.** Es el neto sin IGV que el
 *    ERP guarda, y ya trae aplicado el descuento; `DESCUENTO TOTAL` viaja a las notas para
 *    que el número del papel no se pierda.
 */
@Injectable()
export class SalesHistoryImportAdapter implements GroupedImportAdapter {
  entity = ImportEntity.SALES_HISTORY;
  columns = Object.values(COLUMNS);
  private readonly logger = new Logger(SalesHistoryImportAdapter.name);
  private readonly lookupCache = new Map<string, CachedLookup>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscalImport: FiscalImportService,
    private readonly lookup: DocumentLookupService,
    private readonly operationDate: OperationDateService,
    private readonly orders: SalesOrdersService,
    private readonly roofing: RoofingProductionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async validateRow(raw: Record<string, unknown>): Promise<RowValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const data: Record<string, unknown> = {};

    // --- el documento --------------------------------------------------------
    const issueDate = normalizeDate(getField(raw, COLUMNS.issueDate));
    data.issueDate = issueDate;
    // Regla dura 10: **todo** hecho fechado pasa por `OperationDateService`. El importador
    // de bobinas ya lo hacía y este no: una forma válida pero imposible (`2026-02-30`) o una
    // fecha futura entraban intactas hasta `FiscalImportService`, y salían como un
    // comprobante aceptado con su cuenta por cobrar fechada donde nadie la busca.
    try {
      this.operationDate.resolveHistorical(issueDate);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Fecha de emisión inválida');
    }

    const docTypeText = getField(raw, COLUMNS.docTypeText);
    data.docTypeText = docTypeText;
    const docType = parseDocType(docTypeText);
    data.docType = docType;
    if (docType === null) {
      errors.push(`Tipo de comprobante desconocido: "${docTypeText}"`);
    }

    const documentNumber = getField(raw, COLUMNS.documentNumber);
    data.documentNumber = documentNumber;
    const parsedNumber = parseSeriesNumber(documentNumber);
    data.series = parsedNumber?.series ?? '';
    data.correlative = parsedNumber?.correlative ?? null;
    if (!parsedNumber) {
      errors.push(
        `No se pudo leer serie y número de "${documentNumber}" (se espera algo como F001-00000123)`,
      );
    }

    // --- documento ajustado: fuera de v1, con el motivo a la vista ------------
    // D-138: el corte por tipo va **antes** que el de la columna. Una fila que dice ser
    // nota de crédito con `DOCUMENTO AJUSTADO` vacío pasaba el otro chequeo y entraba como
    // una NC suelta, aceptada, con cuenta por cobrar **positiva** y sin comprobante
    // afectado ni motivo del catálogo 09 — exactamente lo que la decisión dice evitar.
    if (docType === FiscalDocType.NOTA_CREDITO) {
      errors.push(
        'Las notas de crédito no entran por esta importación: necesitan a qué comprobante afectan y con qué motivo, y el archivo no los trae',
      );
    }
    const adjustedDocument = getField(raw, COLUMNS.adjustedDocument);
    data.adjustedDocument = adjustedDocument;
    if (adjustedDocument) {
      errors.push(
        `Esta línea ajusta al comprobante ${adjustedDocument}: las notas de crédito no entran por esta importación (impórtalas después o emítelas desde el sistema)`,
      );
    }

    // --- el cliente -----------------------------------------------------------
    const customerText = getField(raw, COLUMNS.customerText);
    data.customerText = customerText;
    const identified = parseCustomer(customerText);
    data.customerDocType = identified?.docType ?? null;
    data.customerDocNumber = identified?.docNumber ?? '';
    data.customerName = identified?.name ?? customerText;
    data.customerId = null;
    data.customerNeedsReview = false;
    if (!identified) {
      errors.push(
        `No se pudo identificar al cliente en "${customerText}": hace falta su RUC (11 dígitos) o su DNI (8)`,
      );
    } else {
      const existing = await this.prisma.customer.findFirst({
        where: { docType: identified.docType, docNumber: identified.docNumber },
        select: { id: true, name: true, isActive: true },
      });
      if (existing) {
        if (!existing.isActive) {
          errors.push(`El cliente ${identified.docNumber} (${existing.name}) está desactivado`);
        }
        data.customerId = existing.id;
        data.customerName = existing.name;
      } else {
        const padron = await this.lookupName(identified.docType, identified.docNumber);
        if (padron === null) {
          if (!identified.name) {
            errors.push(
              `El cliente ${identified.docNumber} no existe y el padrón no respondió: escribe su nombre`,
            );
          }
          data.customerNeedsReview = true;
          warnings.push(
            `Se creará el cliente ${identified.docNumber} con el nombre del archivo y quedará marcado "por completar": el padrón no respondió`,
          );
        } else {
          data.customerName = padron;
          warnings.push(`Se creará el cliente ${identified.docNumber} — ${padron}`);
        }
      }
      if (docType === FiscalDocType.FACTURA && identified.docType !== DocType.RUC) {
        errors.push(
          `Una factura va a un cliente con RUC y ${identified.docNumber} es ${identified.docType}`,
        );
      }
    }

    // --- la línea -------------------------------------------------------------
    const productCode = getField(raw, COLUMNS.productCode);
    const productName = getField(raw, COLUMNS.productName);
    data.productCode = productCode;
    data.productName = productName;
    if (!productName) errors.push('El nombre del producto es obligatorio');

    const unitRaw = getField(raw, COLUMNS.unit);
    const unit = unitRaw ? normalizeUnit(unitRaw) : DEFAULT_UNIT;
    data.unit = unit;

    const qty = parseAmount(raw, COLUMNS.qty, qtySchema, 'La cantidad', errors);
    data.qty = qty;
    const netPen = parseAmount(raw, COLUMNS.netPen, moneySchema, 'El valor de venta', errors);
    data.netPen = netPen;
    const igvPen = parseAmount(raw, COLUMNS.igvPen, moneySchema, 'El IGV', errors);
    data.igvPen = igvPen;
    const grossPen = parseAmount(raw, COLUMNS.grossPen, moneySchema, 'El precio de venta', errors);
    data.grossPen = grossPen;
    const discountPen = parseAmount(raw, COLUMNS.discountPen, moneySchema, 'El descuento', errors);
    data.discountPen = discountPen;

    // El precio unitario que guarda el ERP es el **neto sin IGV** por unidad. Sale de
    // dividir y no de una columna porque el export no la trae, y con descuento por línea
    // el precio de lista no serviría: lo que se cobró es el neto.
    if (qty !== undefined && netPen !== undefined) {
      data.unitPricePen = toFixedString(toDecimal(netPen).div(toDecimal(qty)), 'MONEY');
    }

    // Cuadre de la propia línea: valor + IGV = precio de venta. Es un aviso, no un error:
    // el importe que manda es el del documento, y una línea descuadrada por redondeo del
    // propio export no puede impedir cargar la venta — pero tiene que verse.
    if (netPen !== undefined && igvPen !== undefined && grossPen !== undefined) {
      const expected = toDecimal(netPen).plus(igvPen);
      if (expected.minus(grossPen).abs().gt(LINE_TOTAL_TOLERANCE_PEN)) {
        warnings.push(
          `La línea no cuadra: valor ${netPen} + IGV ${igvPen} = ${expected.toFixed(2)} y el precio de venta dice ${grossPen}`,
        );
      }
    }

    // --- el toggle del documento (D-141) -------------------------------------
    const fulfillment = parseFulfillment(getField(raw, COLUMNS.fulfillment));
    data.fulfillment = fulfillment;

    // Lo que el preview corrigió para el SKU manda sobre lo que diga el archivo.
    const pickedSku = getField(raw, COLUMNS.sku).toUpperCase();
    data.sku = pickedSku || productCode.toUpperCase();
    data.productId = null;
    data.madeToMeasure = false;
    data.rawMaterialKg = null;
    data.rawSpecKey = null;
    data.rawAvailableKg = null;
    data.catalogAvailableQty = null;
    data.piecesText = getField(raw, COLUMNS.piecesText);
    data.pieces = [];
    if (data.sku) {
      const product = await this.prisma.product.findFirst({
        where: { sku: data.sku as string },
        select: { ...ROOFING_PRODUCT_SELECT, name: true, unit: true, isActive: true },
      });
      if (product) {
        data.productId = product.id;
        if (!product.isActive) {
          warnings.push(`El producto ${product.sku} está desactivado; la línea entra igual`);
        }
        // D-141: todo lo que sigue solo importa si el documento va a crear un pedido
        // **vivo**. Una cáscara es un espejo del comprobante y no promete nada, así que
        // preguntarle al catálogo por su material sería trabajo sin destino.
        if (fulfillment === ImportFulfillment.PENDING && qty !== undefined) {
          await this.validatePendingLine({ product, qty, unit }, data, errors, warnings);
        }
      } else {
        errors.push(
          `No existe el producto "${data.sku as string}": elige uno del catálogo o créalo antes de importar`,
        );
      }
    } else {
      errors.push(
        `La línea "${productName}" no trae código de producto: elige un SKU del catálogo o créalo`,
      );
    }

    data.description = productName.slice(0, 240);

    return { data, errors, warnings };
  }

  /**
   * D-141: lo que hay que comprobar **solo** cuando el documento se marca como pendiente.
   *
   * El pedido vivo recorre el flujo normal, así que tiene que poder recorrerlo: la reserva
   * que va a crear se comprueba contra el disponible real acá, en la previsualización, y no
   * recién al confirmar. La diferencia es toda para el usuario — un error en el preview se
   * arregla desmarcando ese documento; el mismo error al confirmar tira abajo el documento
   * entero y hay que volver a subir el archivo.
   *
   * **El veredicto de acá no reemplaza al de la confirmación.** Dos documentos del mismo
   * lote pueden prometer contra el mismo agregado y cada uno verse alcanzable por separado;
   * quien decide de verdad es `createReservations`, bajo el lock de las bobinas. Acá se
   * atrapa lo que se puede atrapar antes.
   */
  private async validatePendingLine(
    line: {
      product: Prisma.ProductGetPayload<{
        select: typeof ROOFING_PRODUCT_SELECT & { name: true; unit: true; isActive: true };
      }>;
      qty: string;
      unit: string;
    },
    data: Record<string, unknown>,
    errors: string[],
    warnings: string[],
  ): Promise<void> {
    const { product, qty } = line;

    // La unidad del ERP manda sobre la del archivo: es la que el pedido y el kardex van a
    // usar. Cuando difieren hay que decirlo, porque la cantidad se interpreta en la del
    // catálogo y "12" pasa a querer decir doce metros donde el papel decía doce unidades.
    if (line.unit !== product.unit) {
      warnings.push(
        `El archivo trae la cantidad en ${line.unit} y ${product.sku} se mide en ${product.unit}: ` +
          `el pedido pendiente va a reservar ${qty} ${product.unit}`,
      );
    }

    if (!isMadeToMeasure(product)) {
      // Plancha de catálogo o cualquier otro SKU: la línea promete **producto terminado**
      // (D-054/D-127) y eso exige que el stock exista hoy. D-140 es explícito en que una
      // plancha no se fabrica contra el pedido, así que no hay nada que la importación
      // pueda crear para cubrir el faltante — y crear una OP a stock por su cuenta sería
      // inventarle al dueño una corrida que él no pidió.
      const available = await this.productAvailableQty(product.id);
      // D-142: el disponible de **hoy**, tal cual lo vio esta validación — al CLI le sirve
      // tanto si la línea entra (para no volver a leerlo) como si no (es la base de la OP a
      // stock consolidada, que suma el déficit de todos los documentos `pendientes` sin
      // volver a golpear la base). No decide nada por su cuenta: es un dato, no una reserva.
      data.catalogAvailableQty = available.toFixed(3);
      if (toDecimal(qty).gt(available)) {
        errors.push(
          `${product.sku} tiene ${available.toFixed(3)} ${product.unit} disponibles y esta línea ` +
            `pendiente necesita ${toDecimal(qty).toFixed(3)}: impórtalo como ENTREGADO, o produce ` +
            'a stock y vuelve a subir el archivo. Una plancha de catálogo nunca se fabrica ' +
            'contra el pedido (D-140).',
        );
      }
      return;
    }

    // --- cobertura a medida: reserva genérica de materia prima (D-134) --------
    data.madeToMeasure = true;
    let kg: string;
    let thicknessMm: string;
    try {
      kg = toFixedString(theoreticalKgForMeters(product, qty, `El producto ${product.sku}`), 'KG');
      thicknessMm = roofingSpecThicknessMm(product, `El producto ${product.sku}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'No se pudo calcular el material');
      return;
    }
    data.rawMaterialKg = kg;

    // `findRawMaterialSpec` y no `resolveRawMaterialSpec`: validar es una lectura y no puede
    // crear la fila del agregado. La spec "virtual" que devuelve cuando todavía no existe da
    // el mismo disponible, que es la verdad — nadie pudo prometer contra un agregado que no
    // existe.
    const spec = await findRawMaterialSpec(this.prisma, {
      businessLineId: product.businessLineId,
      colorId: product.colorId,
      thicknessMm,
    });
    data.rawSpecKey = `${spec.businessLineId}|${spec.colorId ?? ''}|${spec.thicknessMm}`;
    const availability = await rawMaterialAvailability(
      this.prisma,
      spec,
      roofingToleranceMm(this.env),
    );
    data.rawAvailableKg = availability.available.toFixed(3);
    const label =
      (await rawMaterialSpecLabels(this.prisma, [spec.id])).get(spec.id) ??
      `bobina ${thicknessMm} mm`;
    data.rawMaterialLabel = label;

    if (toDecimal(kg).gt(availability.available)) {
      const mounted = availability.mountedKg.gt(0)
        ? ` y ${availability.mountedKg.toFixed(3)} kg montados en ${availability.mountedOrderCodes.join(', ')}`
        : '';
      errors.push(
        `${label} tiene ${availability.available.toFixed(3)} kg disponibles${mounted} y esta línea ` +
          `pendiente necesita ${toDecimal(kg).toFixed(3)}: impórtalo como ENTREGADO, o carga las ` +
          'bobinas que faltan y vuelve a subir el archivo.',
      );
      return;
    }
    warnings.push(
      `Pendiente: reserva ${toDecimal(kg).toFixed(3)} kg de ${label} ` +
        `(hay ${availability.available.toFixed(3)}) y crea la orden de producción en cola, sin bobina montada`,
    );

    // Los largos son opcionales (ver la columna): con ellos el plan de corte de la OP nace
    // completo, sin ellos nace vacío y lo llena planta antes de rolar (D-084).
    const piecesText = data.piecesText as string;
    if (piecesText) {
      const parsed = parsePieces(piecesText);
      if (!parsed) {
        errors.push(
          `No se pudieron leer los largos de "${piecesText}": se espera "largo x cantidad" en metros, ` +
            'separados por coma (por ejemplo "3.60x4, 5.00x2")',
        );
        return;
      }
      const meters = piecesMeters(parsed);
      if (!meters.equals(toDecimal(qty))) {
        errors.push(
          `Los largos suman ${meters.toFixed(3)} m y la línea dice ${toDecimal(qty).toFixed(3)}`,
        );
        return;
      }
      data.pieces = parsed;
    } else {
      warnings.push(
        'Sin detalle de largos: la orden nace con el plan de corte vacío y planta lo completa antes de rolar',
      );
    }
  }

  /**
   * Disponible de un producto terminado: físico menos lo reservado vivo. Es la misma cuenta
   * que hace `InventoryService.lockAvailability` al confirmar, **sin el lock**: acá es una
   * lectura de previsualización y bloquear saldos por cada fila de un archivo de cientos
   * habría serializado la validación entera contra el kardex.
   */
  private async productAvailableQty(productId: string): Promise<ReturnType<typeof toDecimal>> {
    const [balance, reserved] = await Promise.all([
      this.prisma.inventoryBalance.findFirst({
        where: { itemType: InventoryItemType.PRODUCT, itemId: productId },
        select: { qty: true },
      }),
      this.prisma.reservation.aggregate({
        where: {
          itemType: InventoryItemType.PRODUCT,
          itemId: productId,
          status: ReservationStatus.ACTIVE,
        },
        _sum: { qty: true },
      }),
    ]);
    const physical = toDecimal((balance?.qty ?? 0).toString());
    return physical.minus(toDecimal((reserved._sum.qty ?? 0).toString()));
  }

  /**
   * El documento al que pertenece la fila: su serie y su número (D-107). El export repite
   * la cabecera en cada línea, así que agrupar por ahí es lo que reconstruye el comprobante.
   */
  groupKey(data: Record<string, unknown>): string | undefined {
    const series = data.series as string | undefined;
    const correlative = data.correlative as number | null | undefined;
    if (!series || correlative === null || correlative === undefined) return undefined;
    return fiscalDocumentNumber(series, correlative);
  }

  /**
   * Una fila del archivo es una línea, y el duplicado que hay que detectar es **la misma
   * línea dos veces en el mismo documento**: mismo comprobante, mismo SKU, misma cantidad y
   * mismo importe. Dos líneas del mismo SKU con cantidades distintas son legítimas (dos
   * precios, dos descuentos) y no se tocan.
   */
  dedupeKey(data: Record<string, unknown>): string | undefined {
    const group = this.groupKey(data);
    if (!group) return undefined;
    return [group, data.sku, data.qty, data.netPen].join('|');
  }

  /** Lo que solo se ve mirando el comprobante entero (D-107). */
  async validateGroup(rows: GroupRow[]): Promise<RowIssues[]> {
    const issues: RowIssues[] = rows.map(() => ({ errors: [], warnings: [] }));
    const head = rows[0];
    if (!head) return issues;

    if (rows.length > MAX_SALES_ITEMS) {
      for (const issue of issues) {
        issue.errors.push(
          `El comprobante tiene ${rows.length} líneas y el máximo es ${MAX_SALES_ITEMS}`,
        );
      }
    }

    // La cabecera tiene que decir lo mismo en todas las líneas: el export la repite, y una
    // discrepancia significa que dos comprobantes distintos comparten número o que el
    // archivo se editó a mano.
    for (const [key, label] of HEADER_FIELDS) {
      const values = new Set(rows.map((r) => asText(r.data[key])));
      if (values.size > 1) {
        for (const issue of issues) {
          issue.errors.push(`Las líneas de este comprobante no coinciden en ${label}`);
        }
      }
    }

    // El total del documento es la suma de sus líneas: el export no trae una columna de
    // total por comprobante, así que no hay contra qué contrastarla más que consigo misma.
    // Lo que sí se comprueba es que el neto + IGV de todas las líneas dé el bruto de todas,
    // con la misma tolerancia que `resolveTotals` va a exigir al confirmar (D-142) — para
    // que este aviso no calle algo que la confirmación va a rechazar de verdad.
    const sum = (key: string): ReturnType<typeof toDecimal> =>
      rows.reduce((acc, r) => acc.plus(toDecimal((r.data[key] as string) || '0')), toDecimal('0'));
    const net = sum('netPen');
    const igv = sum('igvPen');
    const gross = sum('grossPen');
    const mismatch = salesHistoryTotalMismatch(net.toString(), igv.toString(), gross.toString());
    if (mismatch) {
      for (const issue of issues) {
        issue.warnings.push(
          `El comprobante no cuadra: valor ${net.toFixed(2)} + IGV ${igv.toFixed(2)} = ${net
            .plus(igv)
            .toFixed(2)} y los precios de venta suman ${gross.toFixed(2)}`,
        );
      }
    }

    // D-141: el toggle es del **documento**. Las filas no pueden discrepar, y si discrepan
    // hay que decirlo en vez de elegir una por el usuario: media venta entregada y media
    // pendiente no es un estado que este modelo pueda representar.
    const fulfillments = new Set(rows.map((r) => asText(r.data.fulfillment)));
    if (fulfillments.size > 1) {
      for (const issue of issues) {
        issue.errors.push(
          'Las líneas de este comprobante no coinciden en si está entregado o pendiente: ' +
            'marca el documento entero de una sola forma',
        );
      }
    }
    const pending = asText(head.data.fulfillment) === ImportFulfillment.PENDING;

    // D-141: dos líneas del mismo comprobante que prometen contra el **mismo agregado** se
    // suman. Es la misma regla que D-134 defiende en la cotización —una cobertura y un
    // caballete del mismo color y espesor salen del mismo rollo— y acá se puede comprobar
    // antes de confirmar porque cada fila ya trae su disponible.
    if (pending) {
      const bySpec = new Map<string, { needed: ReturnType<typeof toDecimal>; rows: number[] }>();
      rows.forEach((r, i) => {
        const key = asText(r.data.rawSpecKey);
        if (!key) return;
        const bucket = bySpec.get(key) ?? { needed: toDecimal('0'), rows: [] };
        bucket.needed = bucket.needed.plus(toDecimal(asText(r.data.rawMaterialKg) || '0'));
        bucket.rows.push(i);
        bySpec.set(key, bucket);
      });
      for (const bucket of bySpec.values()) {
        const first = bucket.rows[0];
        if (first === undefined || bucket.rows.length < 2) continue;
        const available = toDecimal(asText(rows[first]?.data.rawAvailableKg) || '0');
        if (bucket.needed.lte(available)) continue;
        const label = asText(rows[first]?.data.rawMaterialLabel) || 'la materia prima';
        for (const i of bucket.rows) {
          issues[i]?.errors.push(
            `Las líneas de este comprobante que salen de ${label} suman ${bucket.needed.toFixed(3)} kg ` +
              `y hay ${available.toFixed(3)} disponibles: impórtalo como ENTREGADO, o carga las bobinas que faltan.`,
          );
        }
      }
    }

    // D-109: reimportar archiva la versión anterior. No bloquea, pero el usuario tiene que
    // poder verlo venir: es el mismo aviso que da RF-72 y por el mismo motivo.
    //
    // D-141 le agrega la mitad que sí bloquea: si el comprobante anterior dejó un pedido
    // **vivo** —con material prometido o con una orden de producción encima—, reimportarlo
    // no es archivar historia, es tirar abajo una promesa que nadie devolvería. Se rechaza
    // acá con el motivo, y el mismo guardrail vuelve a correr al confirmar
    // (`archiveImportedOrderInTx`), que es el que de verdad manda.
    const number = this.groupKey(head.data);
    if (number) {
      const previous = await this.prisma.fiscalDocument.findFirst({
        where: { number, archivedAt: null },
        select: { id: true, salesOrderId: true },
      });
      if (previous) {
        const blocked = previous.salesOrderId
          ? await this.describeLiveOrderEffects(previous.salesOrderId)
          : null;
        for (const issue of issues) {
          if (blocked) issue.errors.push(blocked);
          else {
            issue.warnings.push(
              `Ya existe ${number}: esta importación archiva la versión anterior y su pedido`,
            );
          }
        }
      }
    }
    return issues;
  }

  /**
   * D-141: qué tiene vivo el pedido de un comprobante que se va a reimportar, o `null` si no
   * tiene nada y se puede archivar.
   *
   * Cuenta lo mismo que `archiveImportedOrderInTx` y devuelve el mensaje ya escrito: es una
   * duplicación deliberada de la **lectura**, no de la regla — el guardrail que decide vive
   * en `sales` y corre dentro de la transacción. Esto solo existe para que el usuario lo vea
   * en la previsualización en vez de descubrirlo cuando el lote ya se cayó.
   */
  private async describeLiveOrderEffects(salesOrderId: string): Promise<string | null> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { seq: true, status: true },
    });
    if (!order || order.status === SalesOrderStatus.CANCELLED) return null;
    const [reservations, productionOrders, dispatches] = await Promise.all([
      this.prisma.reservation.count({
        where: { salesOrderId, status: ReservationStatus.ACTIVE },
      }),
      this.prisma.productionOrder.count({
        where: {
          reservation: { salesOrderId },
          status: { in: [ProductionOrderStatus.DRAFT, ProductionOrderStatus.IN_PROGRESS] },
        },
      }),
      this.prisma.dispatch.count({ where: { salesOrderId } }),
    ]);
    const detail = [
      reservations > 0 ? `${reservations} reserva(s) activa(s)` : null,
      productionOrders > 0 ? `${productionOrders} orden(es) de producción viva(s)` : null,
      dispatches > 0 ? `${dispatches} despacho(s)` : null,
    ].filter((d): d is string => d !== null);
    if (detail.length === 0) return null;
    return (
      `Este comprobante ya tiene un pedido vivo (${salesOrderCode(order.seq)}) con ${detail.join(', ')}: ` +
      'no se puede reimportar. Libera o anula ese pedido primero — reimportar archivaría ' +
      'material prometido y producción en curso sin devolver nada.'
    );
  }

  /**
   * El comprobante **y su pedido**, en una sola transacción (D-141).
   *
   * El orden no es intercambiable y cada paso está donde está por un motivo:
   *
   * 1. **El lock del número, primero.** Es el mismo `pg_advisory_xact_lock` que toma
   *    `FiscalImportService` al archivar; tomarlo acá arriba hace que la lectura del
   *    comprobante anterior y el archivado de su pedido ocurran bajo el mismo lock, en vez
   *    de dejar una ventana en la que dos importaciones simultáneas del mismo número lean
   *    cada una un pedido que la otra está por anular. Un lock de transacción se puede
   *    tomar dos veces: `importDocumentInTx` lo vuelve a pedir y no se traba consigo mismo.
   * 2. **El pedido anterior se archiva antes de crear nada.** Si tiene efectos, lanza con el
   *    motivo y no se crea ni el pedido nuevo ni el comprobante.
   * 3. **El pedido, antes que el comprobante**, porque el comprobante lo referencia y sus
   *    líneas apuntan a las del pedido.
   * 4. **Las órdenes de producción, al final**, cuando las reservas ya existen: la OP nace
   *    de una reserva, no de una línea.
   *
   * Devuelve el id del **comprobante**, no el del pedido: es lo que `import_rows` guarda como
   * `created_entity_id` desde RF-71 y lo que el preview usa para decir qué se creó.
   */
  async createGroup(
    tx: Prisma.TransactionClient,
    rows: Record<string, unknown>[],
    actorId: string,
  ): Promise<string> {
    const head = rows[0];
    if (!head) throw new Error('El comprobante no tiene líneas');
    const missingProduct = rows.find((row) => typeof row.productId !== 'string');
    if (missingProduct) {
      throw new BadRequestException(
        `La línea "${asText(missingProduct.productName)}" no tiene SKU: elige uno del catálogo antes de confirmar`,
      );
    }
    // El adaptador solo recibe el id del actor (así es la interfaz desde RF-52) y los tres
    // servicios que se llaman acá solo leen `id` — para auditar y para firmar lo que crean.
    const actor = { id: actorId } as RequestUser;
    const number = fiscalDocumentNumber(head.series as string, head.correlative as number);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${number})::bigint)`;
    const previous = await tx.fiscalDocument.findFirst({
      where: { number, archivedAt: null },
      select: { salesOrderId: true },
    });
    if (previous?.salesOrderId) {
      await this.orders.archiveImportedOrderInTx(
        tx,
        actor,
        previous.salesOrderId,
        `Reimportación del comprobante ${number}`,
      );
    }

    const customerId =
      (head.customerId as string | null) ??
      (await this.ensureCustomer(tx, {
        docType: head.customerDocType as DocType,
        docNumber: head.customerDocNumber as string,
        name: head.customerName as string,
        needsReview: head.customerNeedsReview === true,
      }));

    const lines: ImportedDocumentLine[] = rows.map((row) => ({
      productId: (row.productId as string | null) ?? null,
      description: row.description as string,
      qty: row.qty as string,
      unit: (row.unit as string) || DEFAULT_UNIT,
      unitPricePen: row.unitPricePen as string,
    }));

    const totalPen = rows
      .reduce((acc, row) => acc.plus(toDecimal((row.grossPen as string) || '0')), toDecimal('0'))
      .toFixed(4);

    const discount = rows.reduce(
      (acc, row) => acc.plus(toDecimal((row.discountPen as string) || '0')),
      toDecimal('0'),
    );

    const pending = (head.fulfillment as string) === ImportFulfillment.PENDING;
    const salesOrderId = pending
      ? await this.createPendingOrder(tx, actor, { head, rows, customerId, number })
      : await this.createShellOrder(tx, actor, { head, rows, customerId, number });

    // Las líneas del pedido, en el mismo orden en que se crearon: `lineNumber` es 1..n y
    // coincide con el índice de `rows`, así que el enlace línea a línea es directo.
    const orderItems = await tx.salesOrderItem.findMany({
      where: { salesOrderId },
      orderBy: { lineNumber: 'asc' },
      select: { id: true, lineNumber: true },
    });
    const orderItemByLine = new Map(orderItems.map((i) => [i.lineNumber, i.id]));

    const documentId = await this.fiscalImport.importDocumentInTx(
      tx,
      {
        docType: head.docType as FiscalDocType,
        series: head.series as string,
        correlative: head.correlative as number,
        issueDate: head.issueDate as string,
        customerId,
        // El export no dice si fue contado o crédito. Entra como **cuenta por cobrar**
        // (decisión del dueño): un cobro ya hecho se registra después y deja rastro; una
        // venta que nace cobrada y no lo estaba no se descubre nunca.
        paymentTerms: PaymentTerms.CREDITO,
        dueDate: null,
        affectedDocumentId: null,
        creditNoteReason: null,
        notes: discount.gt(0) ? `Descuento del comprobante: S/ ${discount.toFixed(2)}` : null,
        totalPen,
        // D-142: la tolerancia de "no cuadra" de esta importación, no la de RF-71 — ver
        // `SALES_HISTORY_TOTAL_TOLERANCE_PEN`.
        totalTolerancePen: SALES_HISTORY_TOTAL_TOLERANCE_PEN,
        // D-141: el enlace bidireccional. El documento apunta al pedido y cada una de sus
        // líneas a la del pedido que factura.
        salesOrderId,
        lines: lines.map((line, i) => ({
          ...line,
          salesOrderItemId: orderItemByLine.get(i + 1) ?? null,
        })),
      },
      actorId,
    );

    if (pending) await this.createQueuedOrders(tx, actor, salesOrderId, number);
    return documentId;
  }

  /**
   * D-141 (a): el pedido **cáscara** de una venta ya entregada. Líneas espejo, estado
   * terminal, cero efectos — la garantía la comprueba el propio `sales` al terminar.
   */
  private async createShellOrder(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: {
      head: Record<string, unknown>;
      rows: Record<string, unknown>[];
      customerId: string;
      number: string;
    },
  ): Promise<string> {
    return this.orders.createImportedShellInTx(tx, actor, {
      customerId: input.customerId,
      issueDate: input.head.issueDate as string,
      notes: `Importado del comprobante ${input.number} (ya entregado)`,
      lines: input.rows.map((row, i) => {
        const qty = (row.qty as string) ?? '0';
        const unitPricePen = (row.unitPricePen as string) ?? '0';
        const totals = salesLineTotals({ qty, unitPricePen });
        return {
          lineNumber: i + 1,
          productId: row.productId as string,
          description: row.description as string,
          qty,
          unit: (row.unit as string) || DEFAULT_UNIT,
          unitPricePen,
          subtotalPen: toFixedString(totals.subtotal, 'MONEY'),
          igvPen: toFixedString(totals.igv, 'MONEY'),
          totalPen: toFixedString(totals.total, 'MONEY'),
        };
      }),
    });
  }

  /**
   * D-141 (b): el pedido **vivo** de una venta facturada y no entregada. Entra por el mismo
   * `createDirectInTx` que un pedido normal —y por eso crea reservas y comprueba la
   * invariante—, con la única excepción documentada en `CreateDirectOptions.imported`.
   *
   * La cantidad y el precio salen del comprobante; el resto (la unidad, el destino de la
   * reserva, los kilos teóricos) lo resuelve el catálogo, igual que en cualquier pedido.
   */
  private async createPendingOrder(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    input: {
      head: Record<string, unknown>;
      rows: Record<string, unknown>[];
      customerId: string;
      number: string;
    },
  ): Promise<string> {
    return this.orders.createDirectInTx(
      tx,
      actor,
      {
        customerId: input.customerId,
        issueDate: input.head.issueDate as string,
        notes: `Importado del comprobante ${input.number} (pendiente de entrega)`,
        items: input.rows.map((row) => {
          const pieces = (row.pieces as RoofingPieceDto[] | undefined) ?? [];
          return {
            productId: row.productId as string,
            qty: row.qty as string,
            unitPricePen: row.unitPricePen as string,
            description: (row.description as string).slice(0, 240),
            ...(pieces.length > 0 ? { pieces } : {}),
          };
        }),
      },
      { imported: true },
    );
  }

  /**
   * D-141 (b): una OP **en cola** por cada línea a medida del pedido pendiente.
   *
   * Nace de la reserva genérica que `createDirectInTx` acaba de crear —no de la línea— y
   * **sin bobina montada**: cuál rollo del agregado cumple la promesa lo decide planta al
   * montar (D-086), que es la razón entera por la que D-134 sacó esa decisión de la
   * cotización. Una línea de catálogo no genera nada acá: su reserva es de producto
   * terminado y una plancha no se fabrica contra el pedido (D-140).
   *
   * La fecha de operación es **hoy**: la corrida arranca ahora, aunque el comprobante sea de
   * hace un mes. Retrofecharla al comprobante haría aparecer producción en un mes en el que
   * la roladora no giró.
   */
  private async createQueuedOrders(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    salesOrderId: string,
    number: string,
  ): Promise<void> {
    const reservations = await tx.reservation.findMany({
      where: {
        salesOrderId,
        itemType: InventoryItemType.RAW_MATERIAL,
        status: ReservationStatus.ACTIVE,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const reservation of reservations) {
      await this.roofing.createFromReservationInTx(tx, actor, {
        reservationId: reservation.id,
        operationDate: businessToday(),
        notes: `Del comprobante importado ${number}`,
      });
    }
  }

  /** Encuentra o crea el cliente dentro de la transacción del comprobante (ver D-137). */
  private async ensureCustomer(
    tx: Prisma.TransactionClient,
    input: { docType: DocType; docNumber: string; name: string; needsReview: boolean },
  ): Promise<string> {
    const existing = await tx.customer.findFirst({
      where: { docType: input.docType, docNumber: input.docNumber },
      select: { id: true },
    });
    if (existing) return existing.id;
    try {
      const created = await tx.customer.create({
        data: {
          docType: input.docType,
          docNumber: input.docNumber,
          name: (input.name || `${input.docType} ${input.docNumber}`).slice(0, 160),
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
      const raced = await tx.customer.findFirst({
        where: { docType: input.docType, docNumber: input.docNumber },
        select: { id: true },
      });
      if (raced) return raced.id;
      throw new Error(`No se pudo crear el cliente ${input.docNumber}`);
    }
  }

  private async lookupName(docType: DocType, docNumber: string): Promise<string | null> {
    const key = `${docType}:${docNumber}`;
    const cached = this.lookupCache.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.name;
    const result = await this.lookup.lookup(docType, docNumber);
    const name = result.found ? result.name : null;
    if (this.lookupCache.size >= LOOKUP_CACHE_MAX) {
      const oldest = this.lookupCache.keys().next();
      if (!oldest.done) this.lookupCache.delete(oldest.value);
    }
    this.lookupCache.set(key, { name, address: result.address, at: Date.now() });
    if (name === null && result.reason === 'UNAVAILABLE') {
      this.logger.warn('El padrón no respondió para un cliente de la importación de ventas');
    }
    return name;
  }
}

/** Los campos que describen al documento y tienen que decir lo mismo en cada línea. */
const HEADER_FIELDS: [string, string][] = [
  ['issueDate', 'la fecha de emisión'],
  ['docType', 'el tipo de comprobante'],
  ['customerDocNumber', 'el cliente'],
];

/**
 * `F001 - 00000123`, `F001-123`, `F001 00000123`: todas las formas en las que un export
 * escribe el mismo número. Devuelve `undefined` cuando no hay una serie de cuatro
 * caracteres y un correlativo — **nunca adivina**.
 */
export function parseSeriesNumber(
  value: string,
): { series: string; correlative: number } | undefined {
  // Los separadores van como **alternativas** y no como tres cuantificadores de espacio
  // solapados: aquella forma probaba todas las particiones del bloque de espacios al
  // fallar, y una celda de relleno tardaba segundos en resolverse. Acá cada alternativa
  // consume el separador de una sola manera.
  const match = /^\s*([A-Za-z][A-Za-z0-9]{3})(?:\s*[-–—]\s*|\s+)(\d{1,8})\s*$/.exec(value.trim());
  if (!match) return undefined;
  const series = (match[1] ?? '').toUpperCase();
  const correlative = Number(match[2]);
  if (!SERIES_RE.test(series) || !Number.isInteger(correlative) || correlative <= 0) {
    return undefined;
  }
  return { series, correlative };
}

/**
 * D-141: el toggle del documento, tal como lo deja la previsualización.
 *
 * **Lo que no se entiende es `DELIVERED`, no un error.** El valor lo escribe el propio
 * preview (un desplegable con dos opciones), así que una celda rara solo puede venir de un
 * archivo que trajo una columna `ENTREGA` por su cuenta — y ahí el default correcto es el
 * conservador: un pedido cáscara no toca el inventario, así que equivocarse hacia ese lado
 * no compromete material de nadie. Se aceptan además las dos palabras en español, que es lo
 * que alguien escribiría a mano.
 */
export function parseFulfillment(value: string): ImportFulfillment {
  const text = value
    .trim()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toUpperCase();
  if (text === ImportFulfillment.PENDING || text === 'PENDIENTE') return ImportFulfillment.PENDING;
  return ImportFulfillment.DELIVERED;
}

/**
 * D-141: los largos de una línea a medida, escritos a mano en la previsualización.
 *
 * Formato `largo x cantidad` en **metros**, separados por coma o punto y coma:
 * `3.60x4, 5.00x2`. Devuelve `undefined` cuando no se entiende — **nunca adivina**, por el
 * mismo criterio que `parseSeriesNumber`: un largo mal leído se convierte en planchas que
 * planta corta mal.
 *
 * El largo se guarda en milímetros, que es la escala de `sales_order_item_pieces`.
 */
export function parsePieces(value: string): RoofingPieceDto[] | undefined {
  const parts = value
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const pieces: RoofingPieceDto[] = [];
  for (const [i, part] of parts.entries()) {
    const match = /^(\d{1,3}(?:[.,]\d{1,3})?)\s*[xX*]\s*(\d{1,4})$/.exec(part);
    if (!match) return undefined;
    const meters = toDecimal((match[1] ?? '').replace(',', '.'));
    const qty = Number(match[2]);
    if (meters.lte(0) || !Number.isInteger(qty) || qty <= 0) return undefined;
    pieces.push({
      lineNumber: i + 1,
      lengthMm: toFixedString(meters.times(1000), 'MM'),
      qty,
    });
  }
  return pieces;
}

/**
 * El tipo de comprobante del export, que viene en prosa (`FACTURA ELECTRONICA`, `BOLETA DE
 * VENTA`). Se reconoce por la primera palabra significativa; lo que no se reconoce **no**
 * se asume factura.
 */
export function parseDocType(value: string): FiscalDocType | null {
  const text = value
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toUpperCase();
  if (text.includes('FACTURA')) return FiscalDocType.FACTURA;
  if (text.includes('BOLETA')) return FiscalDocType.BOLETA;
  if (text.includes('GUIA')) return FiscalDocType.GUIA_REMISION_REMITENTE;
  if (text.includes('CREDITO')) return FiscalDocType.NOTA_CREDITO;
  return null;
}

/**
 * El cliente del export, que viene como texto libre con el documento adentro
 * (`20512345678 - ACEROS DEL SUR SAC`, `ACEROS DEL SUR SAC 20512345678`).
 *
 * Se busca un RUC de 11 dígitos o un DNI de 8 en cualquier parte de la cadena y el resto es
 * el nombre. Sin documento no hay cliente: crear uno "por nombre" duplicaría al mismo
 * cliente una vez por cada forma de escribirlo, y la cuenta por cobrar quedaría repartida
 * entre todas.
 */
export function parseCustomer(
  value: string,
): { docType: DocType; docNumber: string; name: string } | undefined {
  const ruc = /(?<!\d)(\d{11})(?!\d)/.exec(value);
  const dni = ruc ? null : /(?<!\d)(\d{8})(?!\d)/.exec(value);
  const match = ruc ?? dni;
  if (!match) return undefined;
  const docNumber = match[1] ?? '';
  // D-142 (hallazgo con el archivo real): el separador va **antes** del nombre
  // ("20606364335 - PROYECTOS...") y ahí sí puede traer un punto ("20606364335. ACEROS...").
  // Al final, en cambio, un punto no es separador — es la propia razón social ("...S.A.C."),
  // y una clase de recorte simétrica se lo comía: el nombre creado quedaba "...S.A.C" a
  // secas. Por eso el punto solo se recorta del lado izquierdo.
  const name = value
    .replace(docNumber, '')
    .replace(/^[\s\-–—:.]+|[\s\-–—:]+$/g, '')
    .trim()
    .slice(0, 160);
  return { docType: ruc ? DocType.RUC : DocType.DNI, docNumber, name };
}

/**
 * Una fecha de celda, en el formato que salga: SheetJS con `cellDates` ya entrega
 * `YYYY-MM-DD` (D-108), pero un csv puede traer `05/09/2026`.
 */
export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (DATE_RE.test(trimmed)) return trimmed;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${(month ?? '').padStart(2, '0')}-${(day ?? '').padStart(2, '0')}`;
  }
  return trimmed;
}

/** Lee un importe de la fila, tolerando separadores de miles y espacios. */
function parseAmount(
  raw: Record<string, unknown>,
  column: ImportColumn,
  schema: ReturnType<typeof decimalStringSchema>,
  label: string,
  errors: string[],
): string | undefined {
  const value = normalizeDecimal(getField(raw, column));
  if (!value) {
    if (column.required) errors.push(`${label} es obligatorio`);
    return column.required ? undefined : '0';
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    errors.push(`${label}: ${parsed.error.issues[0]?.message ?? 'valor inválido'}`);
    return undefined;
  }
  return parsed.data;
}

/**
 * Un número de celda, tolerando cómo lo escriba cada export.
 *
 * Borrar todas las comas a ciegas es lo que no se puede hacer: `0,45` se convertía en
 * `045` y entraba como 45 mm de espesor o S/ 45 de costo, **sin error y sin aviso**. La
 * coma es separador de miles solo cuando además hay un punto decimal; si es la única, es
 * el separador decimal.
 */
export function normalizeDecimal(raw: string): string {
  const value = raw.replace(/\s/g, '');
  if (value.includes('.')) return value.replace(/,/g, '');
  const commas = (value.match(/,/g) ?? []).length;
  if (commas === 1) return value.replace(',', '.');
  return value.replace(/,/g, '');
}
