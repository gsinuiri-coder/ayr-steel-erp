import {
  CREDIT_NOTE_REASON_SUNAT_CODE,
  DocType,
  FiscalDocType,
  TRANSFER_MODE_SUNAT_CODE,
  TransferMode,
  UNITS,
  toDecimal,
  type CreditNoteReason,
} from '@ayr/shared';
import type {
  IssueDispatchNoteCommand,
  IssueDocumentCommand,
  PartyRef,
  QueryDocumentCommand,
  VoidDocumentCommand,
} from '../../ports/electronic-invoicing.port';

/**
 * Traducción del dominio al vocabulario de Nubefact (D-071).
 *
 * **Todo lo que sabe de Nubefact este proyecto está acá y en `nubefact.provider.ts`.**
 * Es una función pura a propósito: se puede probar el payload completo sin red, que es la
 * única forma barata de verificar un contrato con un tercero.
 *
 * Los códigos numéricos son de los catálogos de SUNAT; lo que es propio de Nubefact es
 * **cómo se llaman los campos** y qué valores usa para el tipo de comprobante. Contrastado
 * contra la documentación pública de la API y contra clientes conocidos
 * (`neohunter/NubeFact`); el detalle de la guía de remisión es el menos verificado de los
 * cuatro y es el primero que hay que mirar si el PSE rechaza por forma.
 */

/** Tipo de comprobante en la numeración de Nubefact (no es el catálogo 01 de SUNAT). */
const DOC_TYPE_CODE: Record<FiscalDocType, number> = {
  FACTURA: 1,
  BOLETA: 2,
  NOTA_CREDITO: 3,
  GUIA_REMISION_REMITENTE: 7,
};

/**
 * Catálogo 06 de SUNAT. `-` es "VARIOS — ventas menores a S/ 700 y otros": es el que
 * corresponde a la boleta a público en general (D-077), y por eso el puerto admite
 * `docType: null` en vez de forzar un DNI inventado.
 */
const CUSTOMER_DOC_CODE: Record<DocType, string> = {
  DNI: '1',
  CE: '4',
  RUC: '6',
};

/** Catálogo 06 para el conductor de una guía: ahí sí siempre hay un documento real. */
const DRIVER_DOC_CODE: Record<DocType, string> = CUSTOMER_DOC_CODE;

/** Catálogo 17: tipo de operación. `1` = venta interna, el único caso de v1. */
const SUNAT_TRANSACTION_SALE = 1;

/** Catálogo 02: moneda. `1` = PEN. Todo el dominio comercial va en soles (D-064). */
const CURRENCY_PEN = 1;

/**
 * Catálogo 07: afectación del IGV por línea. `1` = gravado, operación onerosa. Todas las
 * líneas de v1 son gravadas; exoneradas e inafectas entran cuando el catálogo las pida.
 */
const IGV_TYPE_TAXED = 1;

/** Catálogo 20: motivo de traslado. `01` = venta, que es de donde nace todo despacho. */
const TRANSFER_REASON_SALE = '01';

/**
 * Catálogo 18: modalidad de traslado. Sale de `@ayr/shared` y no de una tabla local
 * porque es de SUNAT, no del proveedor: el web muestra el mismo código.
 */
const TRANSFER_MODE_CODE = TRANSFER_MODE_SUNAT_CODE;

/**
 * Códigos del catálogo 03 de SUNAT que el proyecto usa (`Unit` en `@ayr/shared`).
 *
 * `products.unit` es **texto libre** en el maestro —hay productos cargados por planilla con
 * unidades fuera del catálogo— y ese valor viaja tal cual al PSE, que lo rechaza. Antes de
 * mandarlo se normaliza, y lo que no se reconoce cae a `NIU` (unidad), que es lo que menos
 * miente sobre una cantidad contable.
 */
const SUNAT_UNITS = new Set<string>(UNITS);

function unitCode(unit: string): string {
  const normalized = unit.trim().toUpperCase();
  return SUNAT_UNITS.has(normalized) ? normalized : 'NIU';
}

function customerDocCode(party: PartyRef): string {
  return party.docType === null ? '-' : CUSTOMER_DOC_CODE[party.docType];
}

/** Los campos del receptor, iguales en comprobante y en guía. */
function customerFields(party: PartyRef): Record<string, unknown> {
  return {
    cliente_tipo_de_documento: customerDocCode(party),
    cliente_numero_de_documento: party.docNumber,
    cliente_denominacion: party.name,
    cliente_direccion: party.address ?? '',
    cliente_email: party.email ?? '',
  };
}

function creditNoteCode(reason: CreditNoteReason): number {
  return Number(CREDIT_NOTE_REASON_SUNAT_CODE[reason]);
}

/**
 * Payload de `generar_comprobante`.
 *
 * Los totales van **calculados por nosotros**, no delegados al PSE: la aritmética de una
 * línea ya está definida una sola vez en `@ayr/shared` (`salesLineTotals`) y es la misma
 * que vio el vendedor en pantalla y la que quedó guardada. Dejar que el proveedor los
 * recalcule abriría la posibilidad de que el papel diga un número y la base otro.
 */
export function buildInvoicePayload(command: IssueDocumentCommand): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    operacion: 'generar_comprobante',
    tipo_de_comprobante: DOC_TYPE_CODE[command.docType],
    serie: command.series,
    numero: command.correlative,
    sunat_transaction: SUNAT_TRANSACTION_SALE,
    ...customerFields(command.customer),
    fecha_de_emision: command.issueDate,
    fecha_de_vencimiento: command.dueDate ?? '',
    moneda: CURRENCY_PEN,
    porcentaje_de_igv: Number(command.igvRatePct),
    total_gravada: Number(command.subtotalPen),
    total_igv: Number(command.igvPen),
    total: Number(command.totalPen),
    observaciones: command.notes ?? '',
    // El PSE envía a SUNAT en la misma llamada: es lo que hace que una emisión tenga una
    // respuesta útil (aceptada o rechazada) y no solo un acuse de recibo.
    enviar_automaticamente_a_la_sunat: true,
    enviar_automaticamente_al_cliente: false,
    formato_de_pdf: 'A4',
    items: command.lines.map((line) => ({
      unidad_de_medida: unitCode(line.unit),
      codigo: line.code ?? '',
      descripcion: line.description,
      cantidad: Number(line.qty),
      valor_unitario: Number(line.unitPricePen),
      // Con IGV, calculado en Decimal y recién después convertido (D-003): en `number`,
      // 11.86 × 1.18 daba 13.994799999999998 y el PSE valida coherencia entre el valor
      // unitario, el precio unitario y los totales.
      precio_unitario: Number(
        toDecimal(line.unitPricePen)
          .times(toDecimal(command.igvRatePct).div(100).plus(1))
          .toFixed(4),
      ),
      subtotal: Number(line.subtotalPen),
      tipo_de_igv: IGV_TYPE_TAXED,
      igv: Number(line.igvPen),
      total: Number(line.totalPen),
      anticipo_regularizacion: false,
    })),
  };

  if (command.affects) {
    payload.tipo_de_nota_de_credito = creditNoteCode(command.affects.reason);
    payload.documento_que_se_modifica_tipo = DOC_TYPE_CODE[command.affects.docType];
    payload.documento_que_se_modifica_serie = command.affects.series;
    payload.documento_que_se_modifica_numero = command.affects.correlative;
  }

  if (command.detraction) {
    payload.detraccion = true;
    payload.detraccion_tipo = command.detraction.code;
    payload.detraccion_porcentaje = Number(command.detraction.pct);
    payload.detraccion_total = Number(command.detraction.amountPen);
  }

  return payload;
}

/**
 * Payload de `generar_guia` (D-078). La rama de transporte es lo único que cambia entre
 * las dos modalidades; el resto del documento es idéntico.
 */
export function buildDispatchNotePayload(
  command: IssueDispatchNoteCommand,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    operacion: 'generar_guia',
    tipo_de_comprobante: DOC_TYPE_CODE[FiscalDocType.GUIA_REMISION_REMITENTE],
    serie: command.series,
    numero: command.correlative,
    ...customerFields(command.customer),
    fecha_de_emision: command.issueDate,
    fecha_de_inicio_de_traslado: command.transferDate,
    motivo_de_traslado: TRANSFER_REASON_SALE,
    peso_bruto_total: Number(command.totalWeightKg),
    peso_bruto_unidad_de_medida: 'KGM',
    numero_de_bultos: command.packageCount ?? 0,
    tipo_de_transporte: TRANSFER_MODE_CODE[command.transferMode],
    punto_de_partida_ubigeo: command.originUbigeo,
    punto_de_partida_direccion: command.originAddress,
    punto_de_llegada_ubigeo: command.destinationUbigeo,
    punto_de_llegada_direccion: command.destinationAddress,
    observaciones: command.notes ?? '',
    enviar_automaticamente_a_la_sunat: true,
    items: command.lines.map((line) => ({
      unidad_de_medida: unitCode(line.unit),
      codigo: line.code ?? '',
      descripcion: line.description,
      cantidad: Number(line.qty),
    })),
  };

  if (command.transferMode === TransferMode.PRIVATE) {
    // El `CHECK` de `dispatches` ya garantiza que estén los seis campos; el `?? ''` es
    // defensa en profundidad, no una alternativa real.
    //
    // **Los nombres de estos campos los dictó el propio PSE al rechazar la primera guía**:
    // pedía `transportista_placa_numero` (no `vehiculo_placa`, que ignoraba en silencio) y
    // los apellidos del conductor por separado. En traslado privado el transportista es la
    // propia empresa, y por eso la placa viaja igual bajo el prefijo `transportista_`.
    payload.conductor_documento_tipo = command.driver
      ? DRIVER_DOC_CODE[command.driver.docType]
      : '';
    payload.conductor_documento_numero = command.driver?.docNumber ?? '';
    payload.conductor_nombre = command.driver?.givenNames ?? '';
    payload.conductor_nombres = command.driver?.givenNames ?? '';
    payload.conductor_apellidos = command.driver?.familyNames ?? '';
    payload.conductor_numero_licencia = command.driver?.license ?? '';
    payload.transportista_placa_numero = command.vehicle?.plate ?? '';
  } else {
    payload.transportista_documento_tipo = CUSTOMER_DOC_CODE[DocType.RUC];
    payload.transportista_documento_numero = command.carrier?.docNumber ?? '';
    payload.transportista_denominacion = command.carrier?.name ?? '';
  }

  if (command.relatedDocument) {
    payload.documento_relacionado_tipo = DOC_TYPE_CODE[command.relatedDocument.docType];
    payload.documento_relacionado_serie = command.relatedDocument.series;
    payload.documento_relacionado_numero = command.relatedDocument.correlative;
  }

  return payload;
}

/**
 * Payload de consulta. **La guía tiene su propia operación**: el propio proveedor lo dice
 * en la respuesta de emisión ("usa la operación 'consultar_guia' para obtener el PDF o el
 * CDR"), y preguntarle por ella como si fuera un comprobante no devuelve su estado.
 */
export function buildQueryPayload(command: QueryDocumentCommand): Record<string, unknown> {
  const isDispatchNote = command.docType === FiscalDocType.GUIA_REMISION_REMITENTE;
  return {
    operacion: isDispatchNote ? 'consultar_guia' : 'consultar_comprobante',
    tipo_de_comprobante: DOC_TYPE_CODE[command.docType],
    serie: command.series,
    numero: command.correlative,
  };
}

/**
 * Payload de `consultar_anulacion`: el estado de la **baja**, no el del comprobante.
 *
 * Preguntar por el comprobante para saber si la baja entró da siempre "aceptado" —el
 * documento con baja en trámite es justamente uno que SUNAT aceptó—, así que esta consulta
 * tiene que ser la suya.
 */
export function buildVoidQueryPayload(command: QueryDocumentCommand): Record<string, unknown> {
  // Una guía no tiene "anulación" que consultar en el proveedor: su estado —incluido el de
  // haber sido dada de baja desde el panel— sale de `consultar_guia`, la misma operación
  // que su consulta normal.
  if (command.docType === FiscalDocType.GUIA_REMISION_REMITENTE) {
    return buildQueryPayload(command);
  }
  return {
    operacion: 'consultar_anulacion',
    tipo_de_comprobante: DOC_TYPE_CODE[command.docType],
    serie: command.series,
    numero: command.correlative,
  };
}

/** Payload de `generar_anulacion` (comunicación de baja). */
export function buildVoidPayload(command: VoidDocumentCommand): Record<string, unknown> {
  return {
    operacion: 'generar_anulacion',
    tipo_de_comprobante: DOC_TYPE_CODE[command.docType],
    serie: command.series,
    numero: command.correlative,
    motivo: command.reason,
  };
}
