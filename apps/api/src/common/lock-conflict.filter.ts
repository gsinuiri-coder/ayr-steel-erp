import { ArgumentsHost, Catch, ConflictException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';

/** D-386: lo que ve el usuario cuando Postgres aborta su operación por otra que usaba lo mismo. */
export const LOCK_CONFLICT_MESSAGE =
  'Otra operación estaba usando este inventario. Vuelve a intentarlo.';

/**
 * Los dos códigos de Postgres que significan «otra transacción usaba lo mismo y abortamos la
 * tuya»: `40P01` (deadlock detectado) y `40001` (fallo de serialización). Prisma los entrega de
 * tres maneras, según por dónde pasó la sentencia:
 *
 * - `P2034` («Transaction failed due to a write conflict or a deadlock»), en una consulta del
 *   cliente tipado;
 * - `P2010` («Raw query failed») con `meta.code` = `40P01`/`40001`, en `$queryRaw`/`$executeRaw`
 *   —que es por donde pasan casi todos los bloqueos de fila (D-386)—;
 * - un error desconocido cuyo mensaje trae el código o el texto de Postgres.
 */
export function isLockConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') return true;
    const meta = error.meta as { code?: unknown } | undefined;
    if (error.code === 'P2010' && (meta?.code === '40P01' || meta?.code === '40001')) return true;
    return mentionsLockConflict(error.message);
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return mentionsLockConflict(error.message);
  }
  return false;
}

function mentionsLockConflict(message: string): boolean {
  return /\b40P01\b|\b40001\b|deadlock detected|could not serialize access/i.test(message);
}

/**
 * D-386 (M3b): un deadlock o un fallo de serialización sale como **409 con un mensaje en
 * español**, no como el 500 opaco de Nest. Es un rechazo legítimo —la base deshizo la
 * transacción entera, no quedó nada a medias— y la salida es volver a intentarlo. **Sin
 * reintento automático**: decidirlo es del usuario, que ve qué cambió (decisión del dueño).
 *
 * Todo lo demás sigue por el filtro de siempre (`BaseExceptionFilter`), sin cambios.
 */
@Catch()
export class LockConflictFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(LockConflictFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && isLockConflict(exception)) {
      // Se registra para poder medir cuántos quedan: el orden único de D-386 debería dejarlos
      // en cero entre las operaciones que lo respetan.
      this.logger.warn(
        `Conflicto de bloqueo abortado por Postgres: ${(exception as Error).message.slice(0, 300)}`,
      );
      super.catch(new ConflictException(LOCK_CONFLICT_MESSAGE), host);
      return;
    }
    super.catch(exception, host);
  }
}
