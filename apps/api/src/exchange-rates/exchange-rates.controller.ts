import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import {
  getExchangeRateQuerySchema,
  Role,
  upsertManualExchangeRateSchema,
  type ExchangeRateDto,
  type GetExchangeRateQuery,
  type UpsertManualExchangeRateInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ExchangeRatesService } from './exchange-rates.service';

/** D-029: tipo de cambio. Lectura para todos, edición manual solo ADMINISTRADOR. */
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly exchangeRates: ExchangeRatesService) {}

  @Get()
  findAll(): Promise<ExchangeRateDto[]> {
    return this.exchangeRates.findAll();
  }

  @Get('lookup')
  lookup(
    @Query(new ZodValidationPipe(getExchangeRateQuerySchema)) query: GetExchangeRateQuery,
  ): Promise<ExchangeRateDto> {
    return this.exchangeRates.getRate(query.date, query.currency);
  }

  @Put('manual')
  @Roles(Role.ADMINISTRADOR)
  setManual(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(upsertManualExchangeRateSchema))
    body: UpsertManualExchangeRateInput,
  ): Promise<ExchangeRateDto> {
    return this.exchangeRates.setManual(actor, body);
  }
}
