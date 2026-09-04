import { Injectable } from '@nestjs/common';
import {
  ElectronicInvoicingProvider,
  type ProviderResult,
} from '../ports/electronic-invoicing.port';

/**
 * Proveedor que no habla con nadie (D-071/D-073).
 *
 * Se ata cuando no hay credenciales del PSE configuradas, y también es lo que responde
 * cuando el ADMINISTRADOR levanta el interruptor de contingencia manual.
 *
 * **No es un caso degenerado, es la ruta de contingencia.** Devuelve `ERROR`, que es
 * exactamente lo que devuelve un PSE caído, así que un entorno sin credenciales ejercita
 * el mismo camino que una caída real: el documento toma su correlativo, queda en
 * `ISSUED`, habilita el despacho y el job lo sigue reintentando. Un proveedor que
 * fingiera aceptar sería peor que ninguno: dejaría comprobantes marcados como aceptados
 * por SUNAT que SUNAT nunca vio.
 */
@Injectable()
export class NullInvoicingProvider extends ElectronicInvoicingProvider {
  readonly name = 'sin proveedor';
  readonly configured = false;
  readonly fileHost = null;

  constructor(
    private readonly reason = 'El proveedor de facturación electrónica no está configurado',
  ) {
    super();
  }

  private result(): Promise<ProviderResult> {
    return Promise.resolve({
      outcome: 'ERROR',
      ticket: null,
      sunatHash: null,
      pdfUrl: null,
      xmlUrl: null,
      cdrUrl: null,
      code: 'PROVIDER_UNAVAILABLE',
      message: this.reason,
      raw: { provider: this.name, reason: this.reason },
    });
  }

  issueDocument(): Promise<ProviderResult> {
    return this.result();
  }

  issueDispatchNote(): Promise<ProviderResult> {
    return this.result();
  }

  queryStatus(): Promise<ProviderResult> {
    return this.result();
  }

  queryVoidStatus(): Promise<ProviderResult> {
    return this.result();
  }

  voidDocument(): Promise<ProviderResult> {
    return this.result();
  }
}
