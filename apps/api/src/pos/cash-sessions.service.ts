import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CashSessionStatus, PosSaleStatus, Prisma } from '@prisma/client';
import {
  Decimal,
  POS_PAYMENT_METHODS,
  Role,
  cashSessionCode,
  expectedCash,
  toDecimal,
  totalsByMethod,
  toFixedString,
  type CashSessionDto,
  type CashSessionQuery,
  type CloseCashSessionInput,
  type OpenCashSessionInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Turnos de caja del punto de venta (RF-60; D-101).
 *
 * El turno existe por una sola razón: **nada más en el sistema sabe a qué caja entró un
 * cobro**. `customer_payments` (D-075) guarda cuánto y con qué medio; el turno guarda
 * dónde y cuándo, que es lo que permite arquear.
 *
 * Tres reglas, y las tres viven acá:
 *
 * 1. **Un turno abierto por usuario.** Lo garantiza la base con `open_user_id` único
 *    (D-101); este servicio lo comprueba antes para dar un mensaje en vez de un 500.
 * 2. **El arqueo es solo del efectivo.** Una venta con tarjeta o Yape no pone billetes en
 *    el cajón; sumarla al esperado haría que toda caja con tarjetas cerrara con faltante.
 * 3. **El esperado se congela al cerrar.** Si se recalculara, una anulación posterior
 *    cambiaría el número contra el que el cajero ya firmó.
 */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Abre el turno del usuario que llama. Nadie abre la caja de otro. */
  async open(actor: RequestUser, input: OpenCashSessionInput): Promise<CashSessionDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      // Lock sobre el usuario, no sobre la tabla: dos aperturas simultáneas del mismo
      // cajero se serializan y la segunda ve la primera. El índice único de la base es la
      // red de abajo, no el primer control.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${actor.id}::uuid FOR UPDATE`;
      const open = await tx.cashSession.findFirst({
        where: { userId: actor.id, status: CashSessionStatus.OPEN },
        select: { seq: true },
      });
      if (open) {
        throw new ConflictException(
          `Ya tienes la caja ${cashSessionCode(open.seq)} abierta: ciérrala antes de abrir otra`,
        );
      }

      const created = await tx.cashSession.create({
        data: {
          userId: actor.id,
          openUserId: actor.id,
          status: CashSessionStatus.OPEN,
          openingAmountPen: toFixedString(input.openingAmountPen, 'MONEY'),
          openingNotes: input.notes ?? null,
        },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'pos.cash-session.open',
        entity: 'cash_sessions',
        entityId: created.id,
        after: {
          code: cashSessionCode(created.seq),
          openingAmountPen: created.openingAmountPen.toFixed(4),
        },
      });
      return created.id;
    });
    return this.findOne(actor, id);
  }

  /**
   * Cierra el turno con arqueo (D-101).
   *
   * **La diferencia la calcula el API**, con el esperado que sale de las ventas del turno:
   * dejar entrar el esperado por el body sería dejar que quien cuenta elija también contra
   * qué se lo compara.
   *
   * Una diferencia distinta de cero exige motivo **y rol de ADMINISTRADOR** (D-101): cuadrar
   * es del cajero, aceptar un faltante es una decisión de quien responde por el dinero.
   */
  async close(
    actor: RequestUser,
    id: string,
    input: CloseCashSessionInput,
  ): Promise<CashSessionDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "cash_sessions" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const session = await tx.cashSession.findUnique({
        where: { id },
        include: { sales: { select: { method: true, totalPen: true, status: true } } },
      });
      if (!session) throw new NotFoundException('Caja no encontrada');
      if (session.status !== CashSessionStatus.CLOSED) {
        // El dueño del turno o un administrador. Un vendedor no cierra la caja de otro:
        // el arqueo lo firma quien contó los billetes.
        if (session.userId !== actor.id && actor.role !== Role.ADMINISTRADOR) {
          throw new ForbiddenException('Esa caja es de otro usuario: solo su dueño la cierra');
        }
      } else {
        throw new ConflictException('La caja ya está cerrada');
      }

      const expected = expectedCash(
        session.openingAmountPen.toString(),
        session.sales.map((s) => ({
          method: s.method,
          totalPen: s.totalPen.toString(),
          status: s.status,
        })),
      );
      const counted = toDecimal(input.countedCashPen);
      const difference = counted.minus(expected);

      if (!difference.isZero()) {
        if (!input.notes) {
          throw new BadRequestException(
            `El arqueo no cuadra por S/ ${difference.toFixed(2)} (esperado S/ ${expected.toFixed(2)}, contado S/ ${counted.toFixed(2)}): escribe el motivo de la diferencia`,
          );
        }
        if (actor.role !== Role.ADMINISTRADOR) {
          throw new ForbiddenException(
            `El arqueo no cuadra por S/ ${difference.toFixed(2)}: un administrador tiene que cerrar la caja con diferencia`,
          );
        }
      }

      await tx.cashSession.update({
        where: { id },
        data: {
          status: CashSessionStatus.CLOSED,
          // El índice único de "un turno abierto por usuario" se libera acá y en ningún
          // otro lado (D-101).
          openUserId: null,
          expectedCashPen: toFixedString(expected, 'MONEY'),
          countedCashPen: toFixedString(counted, 'MONEY'),
          differencePen: toFixedString(difference, 'MONEY'),
          closingNotes: input.notes ?? null,
          closedAt: new Date(),
          closedById: actor.id,
        },
      });

      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'pos.cash-session.close',
        entity: 'cash_sessions',
        entityId: id,
        before: { status: CashSessionStatus.OPEN },
        after: {
          code: cashSessionCode(session.seq),
          expectedCashPen: toFixedString(expected, 'MONEY'),
          countedCashPen: toFixedString(counted, 'MONEY'),
          differencePen: toFixedString(difference, 'MONEY'),
          reason: input.notes ?? null,
        },
      });
    });
    return this.findOne(actor, id);
  }

  /** El turno abierto del usuario, o null. Es lo primero que `/pos` pregunta. */
  async current(actor: RequestUser): Promise<CashSessionDto | null> {
    const row = await this.prisma.cashSession.findFirst({
      where: { userId: actor.id, status: CashSessionStatus.OPEN },
      select: { id: true },
    });
    return row === null ? null : this.findOne(actor, row.id);
  }

  /**
   * Turnos visibles para quien pregunta.
   *
   * Un vendedor solo ve los suyos: el arqueo de otro cajero es información de caja ajena.
   * Un administrador ve los de todos **solo si lo pide** (`mine=false`); por defecto también
   * ve los suyos, y esa asimetría es deliberada. La pantalla de caja busca "mi turno
   * abierto", y devolverle al administrador el turno abierto **más reciente de cualquier
   * cajero** le hacía contar billetes contra el esperado ajeno y cerrar la caja de otro sin
   * ninguna señal en pantalla. El listado completo sigue disponible, rotulado con su dueño.
   */
  async findAll(actor: RequestUser, query: CashSessionQuery): Promise<CashSessionDto[]> {
    const seesAll = actor.role === Role.ADMINISTRADOR && !query.mine;
    const userId = seesAll ? query.userId : actor.id;
    const rows = await this.prisma.cashSession.findMany({
      where: { status: query.status, userId },
      include: {
        user: { select: { name: true } },
        sales: { select: { method: true, totalPen: true, status: true } },
      },
      orderBy: { openedAt: 'desc' },
      take: 200,
    });
    const closedByNames = await this.actorNames(rows.map((r) => r.closedById));
    return rows.map((r) => this.toDto(r, closedByNames));
  }

  async findOne(actor: RequestUser, id: string): Promise<CashSessionDto> {
    const row = await this.prisma.cashSession.findUnique({
      where: { id },
      include: {
        user: { select: { name: true } },
        sales: { select: { method: true, totalPen: true, status: true } },
      },
    });
    if (!row) throw new NotFoundException('Caja no encontrada');
    if (actor.role !== Role.ADMINISTRADOR && row.userId !== actor.id) {
      throw new ForbiddenException('Esa caja es de otro usuario');
    }
    const names = await this.actorNames([row.closedById]);
    return this.toDto(row, names);
  }

  /**
   * El turno abierto del usuario **bloqueado dentro de la transacción de una venta**.
   *
   * Se bloquea la fila del turno y no solo se lee: es lo que serializa dos ventas del mismo
   * cajero, que en un mostrador con dos pestañas abiertas es un caso real y no teórico.
   */
  async lockOpenSession(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
  ): Promise<{ id: string; seq: number }> {
    const rows = await tx.$queryRaw<{ id: string; seq: number }[]>`
      SELECT "id", "seq" FROM "cash_sessions"
      WHERE "user_id" = ${actor.id}::uuid AND "status" = 'OPEN'
      FOR UPDATE
    `;
    const session = rows[0];
    if (!session) {
      throw new BadRequestException(
        'No tienes una caja abierta: abre tu turno antes de vender en mostrador',
      );
    }
    return session;
  }

  private async actorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i): i is string => i !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(
    row: Prisma.CashSessionGetPayload<{
      include: {
        user: { select: { name: true } };
        sales: { select: { method: true; totalPen: true; status: true } };
      };
    }>,
    closedByNames: Map<string, string>,
  ): CashSessionDto {
    const sales = row.sales.map((s) => ({
      method: s.method,
      totalPen: s.totalPen.toString(),
      status: s.status,
    }));
    const live = sales.filter((s) => s.status === PosSaleStatus.ACTIVE);

    // En un turno abierto el esperado es el de **ahora**; en uno cerrado es el que se
    // arqueó, congelado (D-101). Recalcularlo sobre un turno cerrado haría que una
    // anulación posterior moviera el número contra el que el cajero firmó.
    const expected =
      row.status === CashSessionStatus.CLOSED && row.expectedCashPen !== null
        ? toDecimal(row.expectedCashPen.toString())
        : expectedCash(row.openingAmountPen.toString(), sales);

    // La suma por medio sale de `@ayr/shared` y no de una segunda implementación acá: es la
    // misma razón por la que el esperado usa `expectedCash` — dos cuentas del mismo dinero
    // terminan divergiendo en el centavo que hace que una caja no cuadre.
    const byMethod = totalsByMethod(sales);
    const totals = POS_PAYMENT_METHODS.map((method) => ({
      method,
      saleCount: live.filter((s) => s.method === method).length,
      totalPen: toFixedString(byMethod[method], 'MONEY'),
    }));

    return {
      id: row.id,
      code: cashSessionCode(row.seq),
      status: row.status,
      userId: row.userId,
      userName: row.user.name,
      openingAmountPen: row.openingAmountPen.toFixed(4),
      openedAt: row.openedAt.toISOString(),
      openingNotes: row.openingNotes,
      expectedCashPen: toFixedString(expected, 'MONEY'),
      countedCashPen: row.countedCashPen?.toFixed(4) ?? null,
      differencePen: row.differencePen?.toFixed(4) ?? null,
      closingNotes: row.closingNotes,
      closedAt: row.closedAt?.toISOString() ?? null,
      closedByName: row.closedById === null ? null : (closedByNames.get(row.closedById) ?? null),
      totals,
      saleCount: live.length,
      voidedCount: sales.length - live.length,
      totalPen: toFixedString(
        live.reduce((acc, s) => acc.plus(toDecimal(s.totalPen)), new Decimal(0)),
        'MONEY',
      ),
    };
  }
}
