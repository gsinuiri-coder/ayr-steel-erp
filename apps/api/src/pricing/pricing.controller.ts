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

/**
 * D-032: márgenes por línea. **Solo ADMINISTRADOR**, también la lectura (cc55, D-664, C-05 de
 * audit-01): con el margen mínimo y el precio mínimo del panel de stock se despeja el costo, y
 * la web solo lo pide desde Configuración → Márgenes.
 */
@Controller('pricing')
@Roles(Role.ADMINISTRADOR)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  findAll(): Promise<PricingSettingDto[]> {
    return this.pricing.findAll();
  }

  @Patch(':businessLineId')
  update(
    @CurrentUser() actor: RequestUser,
    @Param('businessLineId', ParseUUIDPipe) businessLineId: string,
    @Body(new ZodValidationPipe(updatePricingSettingSchema)) body: UpdatePricingSettingInput,
  ): Promise<PricingSettingDto> {
    return this.pricing.updateByBusinessLineId(actor, businessLineId, body);
  }
}
