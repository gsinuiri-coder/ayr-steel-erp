import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { Role } from '@ayr/shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';

@Controller('sales/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Roles(Role.VENDEDOR, Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  async getDashboard(@CurrentUser() actor: RequestUser) {
    return this.dashboard.getSellerDashboard(actor);
  }
}
