import { Global, Module } from '@nestjs/common';
import { OperationDateService } from '../common/operation-date.service';
import { ENV, loadEnv } from './env';

@Global()
@Module({
  // `OperationDateService` (D-124) vive acá y no en un módulo propio porque solo depende de
  // `ENV` y lo necesitan servicios de cinco módulos distintos: siendo global, ninguno tiene
  // que importar nada para retrofechar bien.
  providers: [{ provide: ENV, useFactory: () => loadEnv() }, OperationDateService],
  exports: [ENV, OperationDateService],
})
export class ConfigModule {}
