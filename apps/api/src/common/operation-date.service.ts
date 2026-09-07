import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { businessToday, operationDateSchema, Role, toDateOnly } from '@ayr/shared';
import { ENV, type Env } from '../config/env';
import type { RequestUser } from '../auth/auth.types';

/**
 * Fecha de operación (D-124). Un único punto por el que pasa toda retrofecha del sistema:
 * quién la puede poner, hasta dónde llega y qué advertencia se dispara cuando el hecho
 * retrofechado cae antes de lo que el ítem ya tiene registrado.
 *
 * Vive en `ConfigModule`, que es `@Global`, para que cualquier servicio la pueda inyectar
 * sin cablear un módulo más: el campo aparece en una docena de operaciones de cinco
 * módulos distintos y una copia de la validación en cada uno es exactamente la clase de
 * divergencia que D-088 y D-097 ya costaron una vez.
 */
@Injectable()
export class OperationDateService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Piso configurable de la carga histórica (`HISTORICAL_LOAD_START`). */
  get historicalLoadStart(): string {
    return this.env.HISTORICAL_LOAD_START;
  }

  /**
   * Resuelve la fecha de operación de una escritura.
   *
   * Sin campo → **hoy en Lima**: el flujo normal de todos los días no cambia en nada y
   * ningún formulario está obligado a mandarla. Con campo → solo ADMINISTRADOR, no futura
   * y no anterior al piso. Devuelve `YYYY-MM-DD`.
   */
  resolve(actor: Pick<RequestUser, 'role'>, requested?: string | null): string {
    const today = businessToday();
    if (requested === undefined || requested === null || requested === today) return today;

    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException('Solo un administrador puede cambiar la fecha de operación');
    }
    if (requested > today) {
      throw new BadRequestException(
        `La fecha de operación no puede ser futura (hoy es ${today} en Lima)`,
      );
    }
    if (requested < this.historicalLoadStart) {
      throw new BadRequestException(
        `La fecha de operación no puede ser anterior al ${this.historicalLoadStart}, ` +
          'que es el inicio de la carga histórica',
      );
    }
    return requested;
  }

  /**
   * Valida una fecha de operación **sin** control de rol: solo formato y rango.
   *
   * Es para el importador de planillas (RF-52), cuyo controlador entero ya está cerrado a
   * ADMINISTRADOR: repetir ahí el chequeo de rol no agregaría nada, y en cambio validar el
   * rango fila por fila sí, porque una planilla con un año mal tipeado tiene que caerse en
   * la previsualización y no después de confirmarla.
   */
  resolveHistorical(requested: string): string {
    const today = businessToday();
    if (!operationDateSchema.safeParse(requested).success) {
      throw new BadRequestException(`Fecha de operación inválida: "${requested}" (usa YYYY-MM-DD)`);
    }
    if (requested > today) {
      throw new BadRequestException(
        `La fecha de operación no puede ser futura (hoy es ${today} en Lima)`,
      );
    }
    if (requested < this.historicalLoadStart) {
      throw new BadRequestException(
        `La fecha de operación no puede ser anterior al ${this.historicalLoadStart}, ` +
          'que es el inicio de la carga histórica',
      );
    }
    return requested;
  }

  /**
   * Fecha de emisión de un comprobante electrónico (D-133).
   *
   * `assertIssueDateWindow` (D-072) valida la ventana de SUNAT —hasta
   * `MAX_BACKDATED_ISSUE_DAYS` días de atraso, nunca futura— y lo hace en el schema, que
   * no conoce el rol. Esa ventana sigue valiendo: es la que el PSE acepta. Lo que falta es
   * **quién** la puede usar: en los primeros días de un mes, siete días de atraso alcanzan
   * para cruzar al mes anterior, y mover un hecho de mes es privilegio de ADMINISTRADOR
   * desde D-124. Sin esto, un VENDEDOR podía fechar una factura en el mes cerrado.
   *
   * Es deliberadamente un **estrechamiento** de lo que ya existía y no una regla nueva de
   * emisión: la ventana de SUNAT no se toca, solo se le pone el mismo control de rol que
   * tiene cualquier otro hecho fechado del sistema.
   */
  assertIssueDate(actor: Pick<RequestUser, 'role'>, issueDate: string): string {
    const today = businessToday();
    if (issueDate === today) return issueDate;
    if (actor.role !== Role.ADMINISTRADOR) {
      throw new ForbiddenException(
        `Solo un administrador puede emitir con una fecha distinta de hoy (${today} en Lima)`,
      );
    }
    // Las mismas cotas que cualquier otra retrofecha (D-124). La ventana de SUNAT la
    // sigue poniendo el schema, y es más estrecha que el piso histórico.
    if (issueDate > today) {
      throw new BadRequestException(
        `La fecha de emisión no puede ser futura (hoy es ${today} en Lima)`,
      );
    }
    if (issueDate < this.historicalLoadStart) {
      throw new BadRequestException(
        `La fecha de emisión no puede ser anterior al ${this.historicalLoadStart}, ` +
          'que es el inicio de la carga histórica',
      );
    }
    return issueDate;
  }

  /** Igual que {@link resolve} pero devolviendo el `Date` que espera una columna `DATE`. */
  resolveAsDate(actor: Pick<RequestUser, 'role'>, requested?: string | null): Date {
    return toDateOnly(this.resolve(actor, requested));
  }
}
