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
  buildVoidQueryPayload,
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

/**
 * Tope del cuerpo que se lee del PSE. Mismo criterio que `DocumentLookupService` con
 * apis.net.pe: la respuesta de un tercero se archiva entera en `provider_response`, y sin
 * tope un cuerpo enorme agota la memoria de la instancia o revienta el `jsonb` **después**
 * de que el correlativo ya se gastó.
 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Códigos HTTP que **no** son culpa del contenido del documento y por lo tanto se
 * reintentan (D-073).
 *
 * 401 y 403 están acá y esa es la corrección que más importa: un token vencido marcaba
 * cada comprobante como `REJECTED` y quemaba su correlativo, obligando a corregir y
 * reemitir uno por uno por un problema de credenciales que no tiene nada que ver con lo
 * que dice el documento.
 */
const RETRYABLE_HTTP_STATUS = new Set([401, 403, 408, 429]);

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

  /**
   * Los archivos firmados salen del mismo host que atiende la API. Si el proveedor
   * empezara a servirlos desde un CDN propio, acá es donde se agrega —y sigue siendo una
   * lista explícita, no "lo que diga la respuesta".
   */
  get fileHost(): string | null {
    try {
      return this.url ? new URL(this.url).host : null;
    } catch {
      return null;
    }
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

  queryVoidStatus(command: QueryDocumentCommand): Promise<ProviderResult> {
    return this.post(buildVoidQueryPayload(command), { voidQuery: true });
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
  private async post(
    payload: Record<string, unknown>,
    options: { voidQuery?: boolean } = {},
  ): Promise<ProviderResult> {
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
      if (text.length > MAX_BODY_BYTES) {
        // No se parsea ni se archiva entero: solo la cabeza, para poder diagnosticarlo.
        body = { oversizedBody: text.slice(0, 2000), bytes: text.length };
      } else {
        try {
          body = text ? (JSON.parse(text) as unknown) : {};
        } catch {
          // Un cuerpo que no es JSON es casi siempre una página de error del borde (proxy,
          // mantenimiento). Se archiva como texto para poder diagnosticarlo después.
          body = { nonJsonBody: text.slice(0, 2000) };
        }
      }
    } catch (err) {
      // Red caída, DNS, timeout: no sabemos qué pasó del otro lado. `ERROR`, y se reintenta.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Fallo de transporte contra el PSE: ${message}`);
      // Al usuario le llega una **clase** de error, no el texto crudo: un
      // `Failed to parse URL from …` incluiría la URL de la cuenta del PSE, que es un
      // identificador semisecreto, y `lastSendError` se muestra en pantalla. El detalle
      // completo queda en `provider_response`, que no sale del servidor.
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      return this.errorResult(
        isTimeout ? 'TIMEOUT' : 'TRANSPORT',
        isTimeout
          ? 'El PSE no respondió a tiempo'
          : 'No se pudo contactar al PSE (problema de red o del proveedor)',
        { transportError: message },
      );
    }

    const data = (body ?? {}) as NubefactResponse;

    // El proveedor contesta 200 con `errors` adentro tanto como 4xx con el mismo campo.
    const errorMessage = Array.isArray(data.errors) ? data.errors.join('; ') : data.errors;
    if (errorMessage) {
      // **La distinción que importa** (ver `ProviderOutcome`): un 5xx es del proveedor y se
      // reintenta; un 4xx con mensaje es el contenido del documento y no va a mejorar por
      // insistir. Un correlativo ya gastado por un rechazo no se recupera reintentando.
      const retryable = response.status >= 500 || RETRYABLE_HTTP_STATUS.has(response.status);
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

    // **El orden importa.** Para una consulta de baja, el veredicto es el de la
    // anulación y **solo** ese: caer a `aceptada_por_sunat` daría siempre "aceptado",
    // porque un documento con baja en trámite es uno que SUNAT ya había aceptado.
    const accepted = options.voidQuery
      ? data.anulacion_aceptada_por_sunat
      : (data.aceptada_por_sunat ?? data.anulacion_aceptada_por_sunat);
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
