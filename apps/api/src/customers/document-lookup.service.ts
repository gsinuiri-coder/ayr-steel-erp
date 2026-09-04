import { Inject, Injectable, Logger } from '@nestjs/common';
import { DocType } from '@prisma/client';
import type { DocumentLookupDto } from '@ayr/shared';
import { ENV, type Env } from '../config/env';

interface RucResponse {
  razonSocial?: string;
  nombre?: string;
  direccion?: string;
  estado?: string;
}

interface DniResponse {
  nombre?: string;
  nombres?: string;
  apellidoPaterno?: string;
  apellidoMaterno?: string;
}

/**
 * Consulta de RUC/DNI contra apis.net.pe (D-067), el **mismo proveedor** que ya sirve el
 * tipo de cambio SUNAT (D-029): un solo token, un solo servicio del que depender.
 *
 * Es una comodidad, no un requisito: si el token no está configurado, si la API no
 * responde o si el documento no existe, se devuelve `found: false` con el motivo y el
 * formulario sigue aceptando la captura manual. Nunca lanza — un maestro de clientes que
 * no se puede dar de alta porque un tercero está caído no es una opción.
 */
@Injectable()
export class DocumentLookupService {
  private readonly logger = new Logger(DocumentLookupService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async lookup(docType: DocType, docNumber: string): Promise<DocumentLookupDto> {
    const base: DocumentLookupDto = {
      found: false,
      docType,
      docNumber,
      name: null,
      address: null,
      reason: 'NOT_FOUND',
    };

    // El carné de extranjería no está en ningún padrón público consultable: se captura a mano.
    if (docType === DocType.CE) return { ...base, reason: 'NOT_FOUND' };
    if (!this.env.APIS_NET_PE_TOKEN) return { ...base, reason: 'NOT_CONFIGURED' };

    const path =
      docType === DocType.RUC
        ? `v1/ruc?numero=${encodeURIComponent(docNumber)}`
        : `v1/dni?numero=${encodeURIComponent(docNumber)}`;

    try {
      const res = await fetch(`https://api.apis.net.pe/${path}`, {
        headers: { Authorization: `Bearer ${this.env.APIS_NET_PE_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404 || res.status === 422) return { ...base, reason: 'NOT_FOUND' };
      if (!res.ok) {
        this.logger.warn(`apis.net.pe ${path} respondió ${res.status}`);
        return { ...base, reason: 'UNAVAILABLE' };
      }

      if (docType === DocType.RUC) {
        const body = (await res.json()) as RucResponse;
        const name = body.razonSocial ?? body.nombre ?? null;
        if (!name) return { ...base, reason: 'NOT_FOUND' };
        return {
          ...base,
          found: true,
          reason: 'OK',
          name: name.trim().slice(0, 160),
          address: body.direccion ? body.direccion.trim().slice(0, 240) : null,
        };
      }

      const body = (await res.json()) as DniResponse;
      const name =
        body.nombre ??
        [body.nombres, body.apellidoPaterno, body.apellidoMaterno]
          .filter((p): p is string => Boolean(p))
          .join(' ');
      if (!name) return { ...base, reason: 'NOT_FOUND' };
      return { ...base, found: true, reason: 'OK', name: name.trim().slice(0, 160) };
    } catch (err) {
      // Timeout, DNS, TLS: todo lo que no sea una respuesta del servicio es "no disponible".
      this.logger.warn(`apis.net.pe ${path} no respondió: ${String(err)}`);
      return { ...base, reason: 'UNAVAILABLE' };
    }
  }
}
