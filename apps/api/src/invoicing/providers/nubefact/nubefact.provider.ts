import { Injectable, Logger } from '@nestjs/common';
import {
  ElectronicInvoicingProvider,
  type IssueDispatchNoteCommand,
  type IssueDocumentCommand,
  type ProviderResult,
  type QueryDocumentCommand,
  type VoidDocumentCommand,
} from '../../ports/electronic-invoicing.port';
import {
  buildDispatchNotePayload,
  buildInvoicePayload,
  buildQueryPayload,
  buildVoidPayload,
} from './nubefact-payload';

/**
 * Adaptador de Nubefact (D-071). Junto con `nubefact-payload.ts`, **el único lugar del
 * repositorio que sabe que existe este proveedor**.
 *
 * La API es un solo endpoint POST con la operación adentro del cuerpo: la URL identifica
 * a la cuenta (y con ella al emisor, que por eso no viaja en el payload) y el token va en
 * la cabecera `Authorization: Token token="…"`.
 */

/** Forma de la respuesta que este adaptador **interpreta**. Todo lo demás se archiva. */
interface NubefactResponse {
  errors?: string | string[];
  codigo_de_error?: string | number;
  aceptada_por_sunat?: boolean;
  sunat_description?: string;
  sunat_note?: string;
  sunat_responsecode?: string;
  sunat_soap_error?: string;
  codigo_hash?: string;
  enlace_del_pdf?: string;
  enlace_del_xml?: string;
  enlace_del_cdr?: string;
  sunat_ticket_numero?: string;
  anulacion_aceptada_por_sunat?: boolean;
}

/** Timeout de la llamada. Generoso: el PSE firma, envía a SUNAT y espera el CDR. */
const REQUEST_TIMEOUT_MS = 60_000;

@Injectable()
export class NubefactProvider extends ElectronicInvoicingProvider {
  readonly name = 'Nubefact';
  private readonly logger = new Logger(NubefactProvider.name);

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  get configured(): boolean {
    return this.url.length > 0 && this.token.length > 0;
  }

  issueDocument(command: IssueDocumentCommand): Promise<ProviderResult> {
    return this.post(buildInvoicePayload(command));
  }

  issueDispatchNote(command: IssueDispatchNoteCommand): Promise<ProviderResult> {
    return this.post(buildDispatchNotePayload(command));
  }

  queryStatus(command: QueryDocumentCommand): Promise<ProviderResult> {
    return this.post(buildQueryPayload(command));
  }

  voidDocument(command: VoidDocumentCommand): Promise<ProviderResult> {
    return this.post(buildVoidPayload(command));
  }

  /**
   * Una llamada al PSE, con el resultado ya traducido al vocabulario del puerto.
   *
   * **Nunca lanza.** Un `throw` acá subiría por el servicio hasta el usuario y convertiría
   * una caída del PSE en un 500 sobre una operación que, por D-073, tiene que seguir
   * adelante. Todo error de transporte sale como `ERROR`, que es lo que el job reintenta.
   */
  private async post(payload: Record<string, unknown>): Promise<ProviderResult> {
    if (!this.configured) {
      return this.errorResult(
        'PROVIDER_UNAVAILABLE',
        'El proveedor de facturación electrónica no está configurado',
        { payloadOperation: payload.operacion },
      );
    }

    let response: Response;
    let body: unknown;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          // El formato de la cabecera lo fija el proveedor: token entre comillas dobles.
          Authorization: `Token token="${this.token}"`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      try {
        body = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        // Un cuerpo que no es JSON es casi siempre una página de error del borde (proxy,
        // mantenimiento). Se archiva como texto para poder diagnosticarlo después.
        body = { nonJsonBody: text.slice(0, 2000) };
      }
    } catch (err) {
      // Red caída, DNS, timeout: no sabemos qué pasó del otro lado. `ERROR`, y se reintenta.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Fallo de transporte contra el PSE: ${message}`);
      return this.errorResult('TRANSPORT', `No se pudo contactar al PSE: ${message}`, {
        transportError: message,
      });
    }

    const data = (body ?? {}) as NubefactResponse;

    // El proveedor contesta 200 con `errors` adentro tanto como 4xx con el mismo campo.
    const errorMessage = Array.isArray(data.errors) ? data.errors.join('; ') : data.errors;
    if (errorMessage) {
      // **La distinción que importa** (ver `ProviderOutcome`): un 5xx es del proveedor y se
      // reintenta; un 4xx con mensaje es el contenido del documento y no va a mejorar por
      // insistir. Un correlativo ya gastado por un rechazo no se recupera reintentando.
      const retryable = response.status >= 500 || response.status === 429;
      return retryable
        ? this.errorResult(String(data.codigo_de_error ?? response.status), errorMessage, body)
        : {
            outcome: 'REJECTED',
            ticket: null,
            sunatHash: null,
            pdfUrl: null,
            xmlUrl: null,
            cdrUrl: null,
            code: String(data.codigo_de_error ?? response.status),
            message: errorMessage,
            raw: body,
          };
    }

    if (!response.ok) {
      return this.errorResult(String(response.status), `El PSE respondió ${response.status}`, body);
    }

    // Una baja contesta con su propio campo de aceptación y, a veces, solo con un ticket.
    const accepted = data.aceptada_por_sunat ?? data.anulacion_aceptada_por_sunat;
    const soapError = data.sunat_soap_error;

    if (accepted === false) {
      // SUNAT lo vio y lo rechazó: terminal. El detalle sale del CDR.
      return {
        outcome: 'REJECTED',
        ticket: data.sunat_ticket_numero ?? null,
        sunatHash: data.codigo_hash ?? null,
        pdfUrl: data.enlace_del_pdf ?? null,
        xmlUrl: data.enlace_del_xml ?? null,
        cdrUrl: data.enlace_del_cdr ?? null,
        code: data.sunat_responsecode ?? null,
        message: data.sunat_description ?? soapError ?? 'SUNAT rechazó el documento',
        raw: body,
      };
    }

    if (accepted === undefined) {
      // Aceptado por el PSE pero sin veredicto de SUNAT todavía: hay ticket y se consulta
      // después. Tratarlo como aceptado sería marcar como declarado algo que no lo está.
      return {
        outcome: 'PENDING',
        ticket: data.sunat_ticket_numero ?? null,
        sunatHash: data.codigo_hash ?? null,
        pdfUrl: data.enlace_del_pdf ?? null,
        xmlUrl: data.enlace_del_xml ?? null,
        cdrUrl: data.enlace_del_cdr ?? null,
        code: null,
        message: data.sunat_note ?? null,
        raw: body,
      };
    }

    return {
      outcome: 'ACCEPTED',
      ticket: data.sunat_ticket_numero ?? null,
      sunatHash: data.codigo_hash ?? null,
      pdfUrl: data.enlace_del_pdf ?? null,
      xmlUrl: data.enlace_del_xml ?? null,
      cdrUrl: data.enlace_del_cdr ?? null,
      code: data.sunat_responsecode ?? null,
      message: data.sunat_description ?? null,
      raw: body,
    };
  }

  private errorResult(code: string, message: string, raw: unknown): ProviderResult {
    return {
      outcome: 'ERROR',
      ticket: null,
      sunatHash: null,
      pdfUrl: null,
      xmlUrl: null,
      cdrUrl: null,
      code,
      message,
      raw,
    };
  }
}
