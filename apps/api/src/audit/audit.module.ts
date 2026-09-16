import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditQueryService],
  exports: [AuditService],
})
export class AuditModule {}
