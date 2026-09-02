import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV, type Env } from '../config/env';

/**
 * Cola de trabajos sobre Postgres (D-006). En Fase 0 solo arranca y expone `instance`.
 * Usa DIRECT_URL (sin pooler) porque pg-boss mantiene conexiones de mantenimiento.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.JOBS_ENABLED) {
      this.logger.log('pg-boss deshabilitado (JOBS_ENABLED=false)');
      return;
    }
    try {
      const boss = new PgBoss({
        connectionString: this.env.DIRECT_URL,
        schema: 'pgboss',
        max: 2,
      });
      boss.on('error', (err: unknown) => {
        this.logger.error('pg-boss error', err);
      });
      await boss.start();
      this.boss = boss;
      this.logger.log('pg-boss iniciado');
    } catch (err) {
      // No tumbamos el API por la cola: se registra y se reintenta en el siguiente arranque.
      this.logger.error('No se pudo iniciar pg-boss', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) await this.boss.stop({ graceful: true, timeout: 5000 });
  }

  get instance(): PgBoss {
    if (!this.boss) throw new Error('pg-boss no está iniciado');
    return this.boss;
  }
}
