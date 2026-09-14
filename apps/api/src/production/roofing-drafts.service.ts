import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  type Prisma,
} from '@prisma/client';
import {
  MAX_ORDER_REPORTS,
  piecesMeters,
  productionOrderCode,
  toDecimal,
  toFixedString,
  type CommitRoofingDraftsInput,
  type PieceLike,
  type ProductionOrderDto,
  type RoofingReportDraftDto,
  type RoofingReportDraftInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { claimIdempotencyKey } from '../common/idempotency';
import { OperationDateService } from '../common/operation-date.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RawMaterialShortfall } from '../sales/raw-material';
import { assertKind, lockOrder } from './production-shared';
import { ProductionService } from './production.service';
import {
  checkDraftRows,
  DRAFT_INCLUDE,
  toDraftDto,
  type DraftCheckState,
  type DraftRow,
  type DraftRowLike,
} from './roofing-drafts';
import { RoofingProductionService } from './roofing-production.service';

/**
 * D-191 (F8-S3/M3) — el borrador de reportes de una orden de coberturas.
 *
 * El patrón es el del importador de cotizaciones: filas staged editables y **ejecutar todo en
 * una transacción**. El alcance es **por orden**: cada OP tiene su borrador y su commit
 * independiente, así que una hoja de ocho órdenes no vuelve a cero porque la séptima tenga un
 * número mal tipeado (el motivo por el que D-155 retiró la tanda de D-147).
 *
 * El borrador vive en la base y no en la pantalla porque sobrevive un refresh y un corte de
 * luz, que es lo que pasa en una planta. **No mueve kardex ni reservas**: esas dos cosas solo
 * las mueve `RoofingProductionService.reportInTx`, que es lo que el commit llama fila por fila.
 */
/**
 * Filas por borrador. Cada una es un `reportInTx` completo (kardex, promesa, agregado) dentro de
 * la **misma** transacción del commit; contra Neon, doscientas (`MAX_ORDER_REPORTS`) podían
 * pasar el tiempo de la cadena HTTP (Vercel, Cloud Run) con la transacción todavía corriendo.
 * Cincuenta es una hoja de planta holgada.
 */
export const MAX_DRAFT_ROWS = 50;

@Injectable()
export class RoofingDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly production: ProductionService,
    private readonly roofing: RoofingProductionService,
    private readonly operationDate: OperationDateService,
  ) {}

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async list(orderId: string): Promise<RoofingReportDraftDto[]> {
    const rows = await this.prisma.productionReportDraft.findMany({
      where: { productionOrderId: orderId },
      include: DRAFT_INCLUDE,
      orderBy: { seq: 'asc' },
    });
    return rows.map(toDraftDto);
  }

  // -------------------------------------------------------------------------
  // Ingresar, editar, quitar — validación inmediata
  // -------------------------------------------------------------------------

  async add(
    actor: RequestUser,
    orderId: string,
    input: RoofingReportDraftInput,
  ): Promise<RoofingReportDraftDto[]> {
    await this.prisma.$transaction(
      async (tx) => {
        // El lock de la orden va primero: serializa los reintentos del mismo envío antes de
        // reclamar la clave, igual que en el commit.
        const state = await this.loadState(tx, orderId);
        // D-182 (F8-S4/M0): un doble click en «Agregar al borrador» no agrega dos filas. El
        // alcance lleva la orden, por el mismo motivo que el del commit.
        const claim = await claimIdempotencyKey(
          tx,
          `roofing-drafts-add:${orderId}`,
          input.idempotencyKey,
        );
        if (!claim.claimed) return;
        const existing = await this.drafts(tx, orderId);
        this.assertRoomForReports(state.liveReports, existing.length + 1);
        if (existing.length >= MAX_DRAFT_ROWS) {
          throw new BadRequestException(
            `El borrador admite hasta ${MAX_DRAFT_ROWS} filas: ejecútalo antes de seguir cargando`,
          );
        }
        const candidate = { coilId: input.coilId, pieces: input.pieces };
        const coilId = this.validate(state, [...existing.map(toRowLike), candidate], 'new');
        await tx.productionReportDraft.create({
          data: {
            productionOrderId: orderId,
            coilId,
            consumedKg:
              input.consumedKg === undefined ? null : toFixedString(input.consumedKg, 'KG'),
            notes: input.notes ?? null,
            createdById: actor.id,
            pieces: { create: toPieceRows(input.pieces) },
          },
        });
      },
      { timeout: 30_000 },
    );
    return this.list(orderId);
  }

  async update(
    orderId: string,
    draftId: string,
    input: RoofingReportDraftInput,
  ): Promise<RoofingReportDraftDto[]> {
    await this.prisma.$transaction(
      async (tx) => {
        const state = await this.loadState(tx, orderId);
        const existing = await this.drafts(tx, orderId);
        const index = existing.findIndex((d) => d.id === draftId);
        if (index < 0) throw new NotFoundException('Esa fila no está en el borrador de la orden');
        const rows = existing.map(toRowLike);
        rows[index] = { coilId: input.coilId, pieces: input.pieces };
        const coilId = this.validate(state, rows, index);
        await tx.productionReportDraftPiece.deleteMany({ where: { draftId } });
        await tx.productionReportDraft.update({
          where: { id: draftId },
          data: {
            coilId,
            consumedKg:
              input.consumedKg === undefined ? null : toFixedString(input.consumedKg, 'KG'),
            notes: input.notes ?? null,
            pieces: { create: toPieceRows(input.pieces) },
          },
        });
      },
      { timeout: 30_000 },
    );
    return this.list(orderId);
  }

  async remove(orderId: string, draftId: string): Promise<RoofingReportDraftDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      assertKind(order, ProductionOrderKind.ROOFING);
      const deleted = await tx.productionReportDraft.deleteMany({
        where: { id: draftId, productionOrderId: orderId },
      });
      if (deleted.count === 0) {
        throw new NotFoundException('Esa fila no está en el borrador de la orden');
      }
    });
    return this.list(orderId);
  }

  // -------------------------------------------------------------------------
  // Ejecutar — todo o nada
  // -------------------------------------------------------------------------

  /**
   * Convierte el borrador entero en reportes, en orden, en **una** transacción. Antes de
   * mover un gramo revalida todas las filas contra el estado de ahora (el plan, las bobinas
   * montadas y los reportes pudieron cambiar desde que se ingresaron); si una no pasa, nada
   * entra y el error nombra la fila. Si la validación pasa pero el reporte de una fila falla
   * adentro (el guardrail de fechas, la invariante del agregado), la transacción se deshace
   * igual y el mensaje también lleva el número de fila.
   *
   * `close` cierra la orden en la misma transacción después de los reportes: es el «Guardar y
   * cerrar» de D-159 aplicado al borrador. Con el borrador vacío solo tiene sentido cerrando.
   */
  async commit(
    actor: RequestUser,
    orderId: string,
    input: CommitRoofingDraftsInput,
  ): Promise<ProductionOrderDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    const warnings: RawMaterialShortfall[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        // D-182: un doble click en «Ejecutar» no ejecuta el borrador dos veces. Alcance propio:
        // el efecto es el de N reportes (y quizá un cierre), no el de uno.
        // El alcance lleva la orden: la misma clave reusada en otra orden no es un reintento, y
        // devolverle un 200 que no ejecutó nada sería mentirle.
        const claim = await claimIdempotencyKey(
          tx,
          `roofing-drafts-commit:${orderId}`,
          input.idempotencyKey,
        );
        if (!claim.claimed) return;

        const state = await this.loadState(tx, orderId);
        const drafts = await this.drafts(tx, orderId);
        if (drafts.length === 0 && input.close !== true) {
          throw new BadRequestException(
            'El borrador de la orden está vacío: agrega lo que salió antes de ejecutarlo',
          );
        }
        this.assertRoomForReports(state.liveReports, drafts.length);
        this.validate(state, drafts.map(toRowLike), 'all');

        for (const [index, draft] of drafts.entries()) {
          try {
            warnings.push(
              ...(await this.roofing.reportInTx(
                tx,
                actor,
                orderId,
                {
                  coilId: draft.coilId,
                  pieces: draft.pieces.map((p) => ({
                    lengthMm: p.lengthMm.toFixed(2),
                    qty: p.qty,
                  })),
                  ...(draft.consumedKg === null ? {} : { consumedKg: draft.consumedKg.toFixed(3) }),
                  ...(draft.notes === null ? {} : { notes: draft.notes }),
                  confirmBackdate: input.confirmBackdate,
                },
                operationDate,
              )),
            );
          } catch (err) {
            throw withRowNumber(err, index + 1);
          }
        }

        await tx.productionReportDraft.deleteMany({ where: { productionOrderId: orderId } });

        if (input.close === true) {
          await this.roofing.closeInTx(
            tx,
            actor,
            orderId,
            {
              consumedKg: input.closeConsumedKg,
              reason: input.closeReason,
              confirmBackdate: input.confirmBackdate,
            },
            operationDate,
            warnings,
          );
        }

        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'production.roofing.drafts-commit',
          entity: 'production_orders',
          entityId: orderId,
          after: {
            code: productionOrderCode(state.orderSeq),
            rows: drafts.length,
            meters: drafts
              .reduce((acc, d) => acc.plus(piecesMeters(d.pieces.map(toPieceLike))), toDecimal('0'))
              .toFixed(3),
            closed: input.close === true,
            operationDate,
          },
        });
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    return this.roofing.withWarnings(await this.production.findOne(orderId), warnings);
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  /** Bloquea la orden y lee todo lo que la validación del borrador necesita. */
  private async loadState(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<DraftCheckState & { liveReports: number }> {
    const order = await lockOrder(tx, orderId);
    assertKind(order, ProductionOrderKind.ROOFING);
    if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        order.status === ProductionOrderStatus.DRAFT
          ? 'La orden todavía no tiene bobina montada: monta el material antes de reportar'
          : `La orden está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}: no admite reportes`,
      );
    }
    const [product, plan, reports, consumptions] = await Promise.all([
      tx.product.findUniqueOrThrow({
        where: { id: order.productId },
        select: { sku: true, lengthMm: true },
      }),
      tx.productionOrderItem.findMany({
        where: { productionOrderId: orderId },
        orderBy: { lineNumber: 'asc' },
        select: { lengthMm: true, qty: true },
      }),
      tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { piecesDetail: { select: { lengthMm: true, qty: true } } },
      }),
      tx.productionOrderConsumption.findMany({
        where: { productionOrderId: orderId, releasedAt: null },
        orderBy: { createdAt: 'asc' },
        include: {
          coil: {
            select: {
              code: true,
              widthMm: true,
              thicknessMm: true,
              finish: { select: { densityFactor: true } },
            },
          },
        },
      }),
    ]);
    return {
      orderSeq: order.seq,
      productSku: product.sku,
      fixedLengthMm: product.lengthMm === null ? null : product.lengthMm.toFixed(2),
      planPieces: plan.map(toPieceLike),
      reportedMeters: piecesMeters(reports.flatMap((r) => r.piecesDetail.map(toPieceLike))),
      liveReports: reports.length,
      coils: consumptions.map((c) => ({
        coilId: c.coilId,
        coilCode: c.coil.code,
        remainingKg: toDecimal(c.assignedKg.toString()).minus(toDecimal(c.consumedKg.toString())),
        geometry: {
          widthMm: c.coil.widthMm.toFixed(2),
          thicknessMm: c.coil.thicknessMm.toFixed(2),
          densityFactor: c.coil.finish.densityFactor.toFixed(4),
        },
      })),
    };
  }

  private drafts(tx: Prisma.TransactionClient, orderId: string): Promise<DraftRow[]> {
    return tx.productionReportDraft.findMany({
      where: { productionOrderId: orderId },
      include: DRAFT_INCLUDE,
      orderBy: { seq: 'asc' },
    });
  }

  /** Cada fila del borrador es un reporte: el tope de reportes vigentes vale para todas. */
  private assertRoomForReports(liveReports: number, draftRows: number): void {
    if (liveReports + draftRows > MAX_ORDER_REPORTS) {
      throw new BadRequestException(
        `La orden admite hasta ${MAX_ORDER_REPORTS} reportes vigentes y ya tiene ${liveReports}: ` +
          'ejecuta o reduce el borrador, o ciérrala y abre otra',
      );
    }
  }

  /**
   * Corre `checkDraftRows` y traduce su error. `focus` dice qué fila se está tocando: al
   * ingresar o editar, si la que falla es **esa**, el mensaje va sin número (es la que el
   * usuario tiene en la mano); si falla otra, la nombra — el estado cambió por debajo. Devuelve
   * la bobina resuelta de la fila en foco.
   */
  private validate(
    state: DraftCheckState,
    rows: readonly DraftRowLike[],
    focus: 'new' | 'all' | number,
  ): string {
    const result = checkDraftRows(state, rows);
    const focusIndex = focus === 'new' ? rows.length - 1 : focus === 'all' ? -1 : focus;
    if (!result.ok) {
      throw new BadRequestException(
        result.rowNumber - 1 === focusIndex
          ? result.message
          : `Fila ${result.rowNumber}: ${result.message}`,
      );
    }
    return focusIndex < 0 ? '' : (result.rows[focusIndex]?.coil.coilId ?? '');
  }
}

function toPieceLike(row: { lengthMm: Prisma.Decimal; qty: number }): PieceLike {
  return { lengthMm: row.lengthMm.toFixed(2), qty: row.qty };
}

function toRowLike(draft: DraftRow): DraftRowLike {
  return { coilId: draft.coilId, pieces: draft.pieces.map(toPieceLike) };
}

function toPieceRows(pieces: readonly { lengthMm: string; qty: number }[]) {
  return pieces.map((p, i) => ({
    lineNumber: i + 1,
    lengthMm: toFixedString(p.lengthMm, 'MM'),
    qty: p.qty,
  }));
}

/**
 * El error de una fila al ejecutar, con su número adelante. Conserva la forma de la respuesta
 * —en particular el `code` de `BACKDATE_OUT_OF_ORDER`, del que la pantalla depende para abrir
 * el diálogo de retro-fecha (D-124)— y solo antepone «Fila N:» al mensaje.
 */
export function withRowNumber(err: unknown, rowNumber: number): unknown {
  if (!(err instanceof HttpException)) return err;
  const response = err.getResponse();
  const prefix = `Fila ${rowNumber}: `;
  if (typeof response === 'string') {
    return new HttpException(prefix + response, err.getStatus());
  }
  const body = response as { message?: unknown };
  const message = Array.isArray(body.message)
    ? body.message.map((m) => prefix + String(m))
    : prefix + (typeof body.message === 'string' ? body.message : err.message);
  return new HttpException({ ...body, message }, err.getStatus());
}
