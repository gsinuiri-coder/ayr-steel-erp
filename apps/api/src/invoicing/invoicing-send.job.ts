import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { InvoicingService } from './invoicing.service';

/** Nombre de la cola en pg-boss. Estable: cambiarlo deja la programación anterior huérfana. */
export const INVOICING_SEND_QUEUE = 'invoicing.send-pending';

/**
 * Reintento de envíos al PSE (D-073). Segunda cola del proyecto, después del vencimiento
 * de cotizaciones (D-069), y construida con la misma advertencia en mente:
 *
 * **el job no es la regla.** El camino normal es el intento inline de
 * `InvoicingService.send`, que ocurre en la misma petición y deja el documento aceptado o
 * rechazado antes de contestarle al usuario. Este trabajo existe para lo que ese intento
 * no pudo: el PSE caído, el timeout, la contingencia manual.
 *
 * Corre cada 15 minutos **y también al arrancar**, que es la parte que importa: el API
 * vive en Cloud Run con escalado a cero (§3.6), así que una instancia dormida no ejecuta
 * ningún cron y lo que quedó pendiente de la noche se recupera recién cuando alguien
 * vuelve a entrar. `POST /invoicing/send-pending` hace lo mismo bajo demanda.
 */
@Injectable()
export class InvoicingSendJob implements OnModuleInit {
  private readonly logger = new Logger(InvoicingSendJob.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly invoicing: InvoicingService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.JOBS_ENABLED) return;
    try {
      const boss = this.jobs.instance;
      await boss.createQueue(INVOICING_SEND_QUEUE);
      await boss.work(INVOICING_SEND_QUEUE, async () => {
        const sent = await this.invoicing.sendPending();
        if (sent > 0) this.logger.log(`Reintento de envío al PSE: ${sent} documentos`);
      });
      await boss.schedule(INVOICING_SEND_QUEUE, '*/15 * * * *', undefined, { tz: 'UTC' });
      this.logger.log('Job de reintento de envío al PSE programado (cada 15 minutos)');

      // El barrido de arranque: recupera lo que quedó mientras la instancia estuvo caída.
      // Va suelto y con su propio `catch` para no demorar el arranque del API ni tumbarlo
      // si el PSE está fuera, que es justo el caso en el que hay algo que recuperar.
      void this.invoicing
        .sendPending()
        .then((sent) => {
          if (sent > 0) this.logger.log(`Barrido de arranque: ${sent} documentos reintentados`);
        })
        .catch((err: unknown) => {
          this.logger.error('El barrido de arranque falló', err);
        });
    } catch (err) {
      // Mismo criterio que `JobsService` y que D-069: la cola no tumba el API. Sin el job,
      // los pendientes se reintentan a mano desde la pantalla o por el endpoint.
      this.logger.error('No se pudo programar el reintento de envío al PSE', err);
    }
  }
}
