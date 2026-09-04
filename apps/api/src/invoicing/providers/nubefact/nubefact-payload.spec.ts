import { CreditNoteReason, DocType, FiscalDocType, TransferMode } from '@ayr/shared';
import type {
  IssueDispatchNoteCommand,
  IssueDocumentCommand,
} from '../../ports/electronic-invoicing.port';
import {
  buildDispatchNotePayload,
  buildInvoicePayload,
  buildVoidPayload,
} from './nubefact-payload';

/**
 * El payload que sale hacia el PSE (D-071).
 *
 * Es el único contrato de este proyecto con un tercero, y probarlo sin red es la forma
 * barata de que un rechazo por forma se vea acá y no con un correlativo ya gastado
 * (D-072). Lo que se verifica es la **traducción**: que los códigos de catálogo sean los
 * de SUNAT y que la rama de transporte de la guía sea la que corresponde a su modalidad.
 */

function invoiceCommand(overrides: Partial<IssueDocumentCommand> = {}): IssueDocumentCommand {
  return {
    docType: FiscalDocType.FACTURA,
    series: 'F001',
    correlative: 12,
    issueDate: '2026-09-04',
    dueDate: null,
    customer: {
      docType: DocType.RUC,
      docNumber: '20100000001',
      name: 'Cliente SAC',
      address: 'Av. Industrial 100',
      email: 'cliente@test.pe',
    },
    igvRatePct: '18.0000',
    subtotalPen: '1000.0000',
    igvPen: '180.0000',
    totalPen: '1180.0000',
    lines: [
      {
        code: 'PERF-90',
        description: 'Perfil 90',
        unit: 'NIU',
        qty: '100.000',
        unitPricePen: '10.0000',
        subtotalPen: '1000.0000',
        igvPen: '180.0000',
        totalPen: '1180.0000',
      },
    ],
    notes: null,
    affects: null,
    detraction: null,
    ...overrides,
  };
}

function dispatchCommand(
  overrides: Partial<IssueDispatchNoteCommand> = {},
): IssueDispatchNoteCommand {
  return {
    series: 'T001',
    correlative: 5,
    issueDate: '2026-09-04',
    transferDate: '2026-09-04',
    customer: {
      docType: DocType.RUC,
      docNumber: '20100000001',
      name: 'Cliente SAC',
      address: 'Av. Industrial 100',
      email: null,
    },
    originAddress: 'Almacén central',
    destinationAddress: 'Obra San Isidro',
    originUbigeo: '150101',
    destinationUbigeo: '150131',
    transferMode: TransferMode.PRIVATE,
    totalWeightKg: '450.000',
    packageCount: 3,
    vehicle: { plate: 'ABC-123' },
    driver: {
      givenNames: 'Juan Carlos',
      familyNames: 'Pérez Gómez',
      docType: DocType.DNI,
      docNumber: '40404040',
      license: 'Q40404040',
    },
    carrier: null,
    lines: [{ code: 'PERF-90', description: 'Perfil 90', unit: 'NIU', qty: '100.000' }],
    notes: null,
    relatedDocument: null,
    ...overrides,
  };
}

describe('buildInvoicePayload', () => {
  it('traduce una factura con los códigos de catálogo de SUNAT', () => {
    const payload = buildInvoicePayload(invoiceCommand());
    expect(payload.operacion).toBe('generar_comprobante');
    expect(payload.tipo_de_comprobante).toBe(1);
    expect(payload.serie).toBe('F001');
    expect(payload.numero).toBe(12);
    // Catálogo 06: 6 = RUC.
    expect(payload.cliente_tipo_de_documento).toBe('6');
    // Catálogo 02: 1 = PEN. Todo el dominio comercial va en soles (D-064).
    expect(payload.moneda).toBe(1);
    expect(payload.total).toBe(1180);
  });

  it('el precio con IGV se calcula en Decimal y no arrastra basura binaria (D-003)', () => {
    // 11.86 × 1.18 en `number` da 13.994799999999998, y el PSE valida la coherencia entre
    // el valor unitario, el precio unitario y los totales: ese residuo es un rechazo con
    // el correlativo ya gastado.
    const payload = buildInvoicePayload(
      invoiceCommand({
        lines: [
          {
            code: 'PERF-90',
            description: 'Perfil 90',
            unit: 'NIU',
            qty: '1.000',
            unitPricePen: '11.8600',
            subtotalPen: '11.8600',
            igvPen: '2.1348',
            totalPen: '13.9948',
          },
        ],
      }),
    );
    const [item] = payload.items as Record<string, unknown>[];
    expect(item?.precio_unitario).toBe(13.9948);
  });

  it('una boleta a público en general viaja sin tipo de documento (D-077)', () => {
    const payload = buildInvoicePayload(
      invoiceCommand({
        docType: FiscalDocType.BOLETA,
        customer: {
          docType: null,
          docNumber: '00000000',
          name: 'PÚBLICO EN GENERAL',
          address: null,
          email: null,
        },
      }),
    );
    expect(payload.tipo_de_comprobante).toBe(2);
    // "-" es "VARIOS — ventas menores a S/ 700 y otros" del catálogo 06: es lo que
    // corresponde, y no un DNI inventado que SUNAT tomaría por una persona real.
    expect(payload.cliente_tipo_de_documento).toBe('-');
  });

  it('la nota de crédito declara qué documento modifica y con qué motivo (catálogo 09)', () => {
    const payload = buildInvoicePayload(
      invoiceCommand({
        docType: FiscalDocType.NOTA_CREDITO,
        series: 'FC01',
        affects: {
          docType: FiscalDocType.FACTURA,
          series: 'F001',
          correlative: 12,
          reason: CreditNoteReason.DEVOLUCION_ITEM,
        },
      }),
    );
    expect(payload.tipo_de_comprobante).toBe(3);
    expect(payload.tipo_de_nota_de_credito).toBe(7);
    expect(payload.documento_que_se_modifica_tipo).toBe(1);
    expect(payload.documento_que_se_modifica_serie).toBe('F001');
    expect(payload.documento_que_se_modifica_numero).toBe(12);
  });

  it('sin nota de crédito no manda los campos del documento afectado', () => {
    const payload = buildInvoicePayload(invoiceCommand());
    expect(payload).not.toHaveProperty('tipo_de_nota_de_credito');
    expect(payload).not.toHaveProperty('documento_que_se_modifica_tipo');
  });

  it('la detracción viaja tal cual, sin que el sistema la calcule (D-075)', () => {
    const payload = buildInvoicePayload(
      invoiceCommand({ detraction: { code: '027', pct: '12.00', amountPen: '141.6000' } }),
    );
    expect(payload.detraccion).toBe(true);
    expect(payload.detraccion_tipo).toBe('027');
    expect(payload.detraccion_total).toBe(141.6);
  });
});

describe('buildDispatchNotePayload (D-078)', () => {
  it('el traslado privado lleva vehículo y conductor, y ningún transportista', () => {
    const payload = buildDispatchNotePayload(dispatchCommand());
    expect(payload.operacion).toBe('generar_guia');
    // Catálogo 18: 02 = transporte privado.
    expect(payload.tipo_de_transporte).toBe('02');
    // El PSE espera la placa bajo el prefijo del transportista, incluso en traslado
    // privado: en `vehiculo_placa` la ignoraba en silencio y rechazaba por placa vacía.
    expect(payload.transportista_placa_numero).toBe('ABC-123');
    expect(payload.conductor_documento_tipo).toBe('1');
    expect(payload.conductor_numero_licencia).toBe('Q40404040');
    // Nombres y apellidos por separado: el PSE rechaza la guía sin los apellidos, y
    // partir un nombre completo por espacios se equivoca con "Juan Carlos Pérez Gómez".
    expect(payload.conductor_nombres).toBe('Juan Carlos');
    expect(payload.conductor_apellidos).toBe('Pérez Gómez');
    expect(payload).not.toHaveProperty('transportista_documento_numero');
  });

  it('el traslado público lleva transportista, y ningún conductor', () => {
    const payload = buildDispatchNotePayload(
      dispatchCommand({
        transferMode: TransferMode.PUBLIC,
        vehicle: null,
        driver: null,
        carrier: { docNumber: '20500000002', name: 'Transportes SAC' },
      }),
    );
    expect(payload.tipo_de_transporte).toBe('01');
    expect(payload.transportista_documento_numero).toBe('20500000002');
    expect(payload.transportista_denominacion).toBe('Transportes SAC');
    expect(payload).not.toHaveProperty('transportista_placa_numero');
    expect(payload).not.toHaveProperty('conductor_apellidos');
  });

  it('manda el ubigeo de partida y de llegada, que SUNAT exige', () => {
    const payload = buildDispatchNotePayload(dispatchCommand());
    expect(payload.punto_de_partida_ubigeo).toBe('150101');
    expect(payload.punto_de_llegada_ubigeo).toBe('150131');
  });

  it('las líneas de la guía no llevan importes', () => {
    const payload = buildDispatchNotePayload(dispatchCommand());
    const [item] = payload.items as Record<string, unknown>[];
    expect(item).toEqual({
      unidad_de_medida: 'NIU',
      codigo: 'PERF-90',
      descripcion: 'Perfil 90',
      cantidad: 100,
    });
  });

  it('referencia el comprobante que respalda el traslado cuando ya existe', () => {
    const payload = buildDispatchNotePayload(
      dispatchCommand({
        relatedDocument: { docType: FiscalDocType.FACTURA, series: 'F001', correlative: 12 },
      }),
    );
    expect(payload.documento_relacionado_serie).toBe('F001');
    expect(payload.documento_relacionado_numero).toBe(12);
  });
});

describe('buildVoidPayload', () => {
  it('identifica el comprobante a dar de baja y lleva el motivo', () => {
    const payload = buildVoidPayload({
      docType: FiscalDocType.FACTURA,
      series: 'F001',
      correlative: 12,
      reason: 'Error en el cliente',
    });
    expect(payload).toEqual({
      operacion: 'generar_anulacion',
      tipo_de_comprobante: 1,
      serie: 'F001',
      numero: 12,
      motivo: 'Error en el cliente',
    });
  });
});
