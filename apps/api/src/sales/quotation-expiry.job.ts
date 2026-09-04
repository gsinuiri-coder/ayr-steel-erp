import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { QuotationsService } from './quotations.service';

/** Nombre de la cola en pg-boss. Estable: cambiarlo deja la programación anterior huérfana. */
export const QUOTATION_EXPIRY_QUEUE = 'quotations.expire';

/**
 * Vencimiento diario de cotizaciones (D-069). Primer uso real de pg-boss en el proyecto
 * (D-006): hasta Fase 4 la cola solo arrancaba.
 *
 * Corre a las 05:00 UTC, que es medianoche en Lima (UTC-5), así que una cotización válida
 * "hasta el 10" sigue confirmable durante todo el día 10 hora local.
 *
 * El job **no es la regla**, es la puesta al día de la lista: `confirm()` revalida la
 * vigencia por su cuenta. Hace falta porque el API vive en Cloud Run con escalado a cero
 * (§3.6) y una instancia dormida no ejecuta ningún cron — por eso el mismo trabajo se puede
 * disparar a mano desde `POST /sales/quotations/expire`.
 */
@Injectable()
export class QuotationExpiryJob implements OnModuleInit {
  private readonly logger = new Logger(QuotationExpiryJob.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly quotations: QuotationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.JOBS_ENABLED) return;
    try {
      const boss = this.jobs.instance;
      await boss.createQueue(QUOTATION_EXPIRY_QUEUE);
      await boss.work(QUOTATION_EXPIRY_QUEUE, async () => {
        const expired = await this.quotations.expireDue(null);
        this.logger.log(`Job de vencimiento: ${expired} cotizaciones marcadas vencidas`);
      });
      await boss.schedule(QUOTATION_EXPIRY_QUEUE, '0 5 * * *', undefined, { tz: 'UTC' });
      this.logger.log('Job diario de vencimiento de cotizaciones programado (05:00 UTC)');
    } catch (err) {
      // Mismo criterio que `JobsService`: la cola no tumba el API. Sin el job, la lista
      // muestra el estado con un día de retraso y `confirm()` sigue siendo correcto.
      this.logger.error('No se pudo programar el vencimiento de cotizaciones', err);
    }
  }
}
