import type { CreditNoteReason, DocType, FiscalDocType, TransferMode } from '@ayr/shared';

/**
 * Puerto del proveedor de facturación electrónica (D-071).
 *
 * **Este archivo es el contrato del dominio con cualquier PSE.** Todo lo que hay acá está
 * escrito en el vocabulario del negocio y de SUNAT —tipo de comprobante del catálogo 01,
 * motivo del catálogo 09, modalidad del catálogo 18—, nunca en el de un proveedor. Un
 * `grep` de "nubefact" fuera de `invoicing/providers/nubefact/` no debe devolver nada.
 *
 * Lo que se compra con esto no es portabilidad teórica: un PSE peruano se cambia (por
 * precio, por caída sostenida, por quiebra) y ese cambio no puede ser una migración de
 * base de datos. Sin el puerto, los nombres del proveedor se filtran a las columnas, a
 * los estados de la máquina y a los textos de la UI.
 *
 * La contraparte está en `ProviderResult.raw`: la respuesta cruda se **guarda** tal cual
 * (`fiscal_documents.provider_response`) y **no se lee nunca**. Guardar la evidencia y
 * depender de su forma son dos cosas distintas.
 */

/** Emisor y receptor con los datos que SUNAT exige en el comprobante. */
export interface PartyRef {
  docType: DocType | null;
  docNumber: string;
  name: string;
  address: string | null;
  email: string | null;
}

export interface DocumentLine {
  /** SKU o código interno. Null en una línea libre. */
  code: string | null;
  description: string;
  /** Unidad del catálogo 03 de SUNAT (`KGM`, `NIU`, `ZZ`…). */
  unit: string;
  /** Cantidad, ya con la escala de kilos (D-003). Siempre string. */
  qty: string;
  /** Precio unitario **sin IGV**, en soles, escala 4. */
  unitPricePen: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

/** Comprobante de pago a emitir: factura, boleta o nota de crédito. */
export interface IssueDocumentCommand {
  docType: FiscalDocType;
  series: string;
  correlative: number;
  issueDate: string;
  dueDate: string | null;
  customer: PartyRef;
  /** IGV en puntos porcentuales, como string (D-003). Hoy siempre `18.0000`. */
  igvRatePct: string;
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
  lines: DocumentLine[];
  notes: string | null;
  /** Solo en nota de crédito: qué documento modifica y por qué. */
  affects: {
    docType: FiscalDocType;
    series: string;
    correlative: number;
    reason: CreditNoteReason;
  } | null;
  /** Detracción informativa (D-075): viaja tal cual, sin cálculo. */
  detraction: { code: string; pct: string; amountPen: string } | null;
}

/** Guía de remisión remitente a emitir (D-078). No lleva importes. */
export interface IssueDispatchNoteCommand {
  series: string;
  correlative: number;
  issueDate: string;
  /** Fecha de inicio del traslado. */
  transferDate: string;
  customer: PartyRef;
  originAddress: string;
  destinationAddress: string;
  /** Ubigeo INEI de seis dígitos, obligatorio en la guía. */
  originUbigeo: string;
  destinationUbigeo: string;
  transferMode: TransferMode;
  totalWeightKg: string;
  packageCount: number | null;
  /** Traslado privado: vehículo y conductor propios. Null en el público. */
  vehicle: { plate: string } | null;
  driver: {
    name: string;
    docType: DocType;
    docNumber: string;
    license: string;
  } | null;
  /** Traslado público: el transportista tercero. Null en el privado. */
  carrier: { docNumber: string; name: string } | null;
  lines: { code: string | null; description: string; unit: string; qty: string }[];
  notes: string | null;
  /** Comprobante que respalda el traslado, si ya se emitió. */
  relatedDocument: { docType: FiscalDocType; series: string; correlative: number } | null;
}

/** Consulta del estado de un documento ya enviado. */
export interface QueryDocumentCommand {
  docType: FiscalDocType;
  series: string;
  correlative: number;
}

/** Comunicación de baja de un comprobante aceptado. */
export interface VoidDocumentCommand extends QueryDocumentCommand {
  reason: string;
}

/**
 * Cómo terminó una llamada al PSE, en términos del dominio.
 *
 * - `ACCEPTED` — SUNAT lo aceptó. Hay CDR.
 * - `REJECTED` — SUNAT o el PSE lo rechazaron por el **contenido**. Es terminal: se
 *   corrige y se reemite con correlativo nuevo (D-072). Reintentarlo no cambia nada.
 * - `PENDING` — aceptado por el PSE, todavía sin respuesta de SUNAT (un ticket). Se
 *   consulta después.
 * - `ERROR` — no se pudo saber: red caída, credenciales, 5xx, timeout. **Se reintenta**
 *   (D-073), y es la diferencia que hace que una caída del PSE no queme un correlativo.
 *
 * La distinción entre `REJECTED` y `ERROR` es la decisión más importante que toma un
 * adaptador: confundirlas hace que el job reintente para siempre algo que nunca va a
 * entrar, o que se descarte como definitivo un corte de red de treinta segundos.
 */
export type ProviderOutcome = 'ACCEPTED' | 'REJECTED' | 'PENDING' | 'ERROR';

export interface ProviderResult {
  outcome: ProviderOutcome;
  /** Ticket del PSE cuando la respuesta es `PENDING`. */
  ticket: string | null;
  /** Código hash del CDR (la constancia de recepción de SUNAT). */
  sunatHash: string | null;
  /** Enlaces a los archivos firmados. El servicio los descarga y los guarda en R2. */
  pdfUrl: string | null;
  xmlUrl: string | null;
  cdrUrl: string | null;
  /** Código y mensaje del rechazo o del error, ya legibles para el usuario. */
  code: string | null;
  message: string | null;
  /**
   * Respuesta cruda del proveedor. Se archiva sin interpretarla (D-071): **ninguna rama
   * de código del dominio la lee**. Está para soporte y para poder reconstruir qué
   * contestó el PSE ante una discrepancia con SUNAT.
   */
  raw: unknown;
}

/**
 * El puerto. Clase abstracta y no interfaz porque Nest inyecta por token en tiempo de
 * ejecución y una interfaz de TypeScript no existe ahí.
 */
export abstract class ElectronicInvoicingProvider {
  /** Nombre del proveedor, para mostrarlo en configuración y en los logs. */
  abstract readonly name: string;

  /** `false` cuando no hay credenciales: el envío falla como `ERROR` y el job reintenta. */
  abstract readonly configured: boolean;

  /**
   * Host del que se admiten los archivos firmados (PDF, XML, CDR).
   *
   * Los enlaces vienen dentro de la respuesta del proveedor, así que descargarlos sin
   * comprobar a dónde apuntan convertiría al API en un lector de cualquier dirección que
   * ese cuerpo diga. `null` cuando el proveedor no sirve archivos.
   */
  abstract readonly fileHost: string | null;

  abstract issueDocument(command: IssueDocumentCommand): Promise<ProviderResult>;

  abstract issueDispatchNote(command: IssueDispatchNoteCommand): Promise<ProviderResult>;

  abstract queryStatus(command: QueryDocumentCommand): Promise<ProviderResult>;

  /**
   * Estado de la **comunicación de baja**, que no es el del comprobante.
   *
   * Existe como método aparte porque confundirlos tiene una consecuencia concreta y fea:
   * un documento con baja en trámite es, por definición, un comprobante que SUNAT ya
   * aceptó, así que preguntar por el comprobante devuelve "aceptado" y llevaría a darlo
   * por anulado sin que SUNAT lo haya anulado — con la cuenta por cobrar desapareciendo
   * mientras el comprobante sigue vigente.
   *
   * `ACCEPTED` acá significa "la baja fue aceptada"; `REJECTED`, que SUNAT la rechazó y el
   * comprobante sigue vivo.
   */
  abstract queryVoidStatus(command: QueryDocumentCommand): Promise<ProviderResult>;

  abstract voidDocument(command: VoidDocumentCommand): Promise<ProviderResult>;
}

/** Token de inyección del puerto. `invoicing.module.ts` es el único que decide qué se ata. */
export const ELECTRONIC_INVOICING_PROVIDER = Symbol('ELECTRONIC_INVOICING_PROVIDER');
