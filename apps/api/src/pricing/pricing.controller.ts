import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  Role,
  updatePricingSettingSchema,
  type PricingSettingDto,
  type UpdatePricingSettingInput,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PricingService } from './pricing.service';

/** D-032: márgenes por línea. Lectura para todos, edición solo ADMINISTRADOR. */
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  findAll(): Promise<PricingSettingDto[]> {
    return this.pricing.findAll();
  }

  @Patch(':businessLineId')
  @Roles(Role.ADMINISTRADOR)
  update(
    @CurrentUser() actor: RequestUser,
    @Param('businessLineId', ParseUUIDPipe) businessLineId: string,
    @Body(new ZodValidationPipe(updatePricingSettingSchema)) body: UpdatePricingSettingInput,
  ): Promise<PricingSettingDto> {
    return this.pricing.updateByBusinessLineId(actor, businessLineId, body);
  }
}
