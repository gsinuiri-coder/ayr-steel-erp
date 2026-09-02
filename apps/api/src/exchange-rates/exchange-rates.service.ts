import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Currency, type ExchangeRate } from '@prisma/client';
import { toFixedString, type ExchangeRateDto } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

interface ApisNetPeResponse {
  compra: number;
  venta: number;
}

/**
 * Tipo de cambio del día (D-029/P-06). PEN es la moneda base (no requiere TC).
 * Para otras monedas: caché en `exchange_rates` → apis.net.pe → último TC conocido
 * (fallback manual, RF-90..). El token vacío (bloqueo B-02) salta directo al fallback.
 */
@Injectable()
export class ExchangeRatesService {
  private readonly logger = new Logger(ExchangeRatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getRate(date: string, currency: Currency): Promise<ExchangeRateDto> {
    if (currency === Currency.PEN) {
      return {
        id: '00000000-0000-0000-0000-000000000000',
        date,
        currency,
        buy: '1.0000',
        sell: '1.0000',
        source: 'MANUAL',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const cached = await this.prisma.exchangeRate.findUnique({
      where: { date_currency: { date: new Date(date), currency } },
    });
    if (cached) return toDto(cached);

    if (this.env.APIS_NET_PE_TOKEN) {
      try {
        const fetched = await this.fetchFromApisNetPe(date);
        const saved = await this.prisma.exchangeRate.create({
          data: {
            date: new Date(date),
            currency,
            buy: fetched.buy,
            sell: fetched.sell,
            source: 'API',
          },
        });
        return toDto(saved);
      } catch (err) {
        this.logger.warn(`apis.net.pe no respondió para ${date}: ${String(err)}`);
      }
    }

    const lastKnown = await this.prisma.exchangeRate.findFirst({
      where: { currency },
      orderBy: { date: 'desc' },
    });
    if (lastKnown) return toDto(lastKnown);
    throw new NotFoundException(
      'No hay tipo de cambio disponible para esa moneda; regístralo manualmente',
    );
  }

  async findAll(): Promise<ExchangeRateDto[]> {
    const rates = await this.prisma.exchangeRate.findMany({
      orderBy: { date: 'desc' },
      take: 365,
    });
    return rates.map(toDto);
  }

  /** RF-90..: alta/edición manual (ADMIN) cuando la API externa falla o hay que corregir el TC. */
  async setManual(
    actor: RequestUser,
    input: { date: string; currency: Currency; buy: string; sell: string },
  ): Promise<ExchangeRateDto> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const upserted = await tx.exchangeRate.upsert({
        where: { date_currency: { date: new Date(input.date), currency: input.currency } },
        create: {
          date: new Date(input.date),
          currency: input.currency,
          buy: input.buy,
          sell: input.sell,
          source: 'MANUAL',
        },
        update: { buy: input.buy, sell: input.sell, source: 'MANUAL' },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'exchange-rates.manual-set',
        entity: 'exchange_rates',
        entityId: upserted.id,
        after: { date: input.date, currency: input.currency, buy: input.buy, sell: input.sell },
      });
      return upserted;
    });
    return toDto(saved);
  }

  private async fetchFromApisNetPe(date: string): Promise<{ buy: string; sell: string }> {
    const res = await fetch(`https://api.apis.net.pe/v1/tipo-cambio-sunat?fecha=${date}`, {
      headers: { Authorization: `Bearer ${this.env.APIS_NET_PE_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`apis.net.pe respondió ${res.status}`);
    const body = (await res.json()) as ApisNetPeResponse;
    return {
      buy: toFixedString(String(body.compra), 'RATE'),
      sell: toFixedString(String(body.venta), 'RATE'),
    };
  }
}

function toDto(r: ExchangeRate): ExchangeRateDto {
  return {
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    currency: r.currency,
    buy: r.buy.toFixed(4),
    sell: r.sell.toFixed(4),
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
