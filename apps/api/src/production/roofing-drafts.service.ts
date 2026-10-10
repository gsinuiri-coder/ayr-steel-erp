import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductionOrderKind,
  ProductionOrderStatus,
  ProductionReportStatus,
  type Prisma,
} from '@prisma/client';
import {
  isAccessory,
  MAX_ORDER_REPORTS,
  piecesMeters,
  productionOrderCode,
  toDecimal,
  toFixedString,
  type CommitRoofingDraftsInput,
  type PieceLike,
  type PlantClosePreviewDto,
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
import { COMMIT_PREVIEW_TIMEOUT_MS, previewPlantClose } from './close-preview';
import { assertKind, lockOrder } from './production-shared';
import { ProductionService } from './production.service';
import {
  checkDraftRows,
  DRAFT_INCLUDE,
  draftCoilStates,
  draftDtos,
  draftRowLike,
  mathPieces,
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
    const [rows, order] = await Promise.all([
      this.prisma.productionReportDraft.findMany({
        where: { productionOrderId: orderId },
        include: DRAFT_INCLUDE,
        orderBy: { seq: 'asc' },
      }),
      this.prisma.productionOrder.findUnique({
        where: { id: orderId },
        select: { seq: true, productId: true, reservationId: true, status: true },
      }),
    ]);
    // D-388: con la orden en curso, cada fila sale con su marca de «fuera de tolerancia». Es una
    // lectura sin bloqueo: el veredicto que mueve kardex es el del commit, que revalida todo.
    if (rows.length === 0 || order?.status !== ProductionOrderStatus.IN_PROGRESS) {
      return rows.map((draft, index) => toDraftDto(draft, index));
    }
    return draftDtos(await this.readState(this.prisma, order, orderId), rows);
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
        const coilId = this.validate(
          state,
          [...existing.map(draftRowLike), inputRowLike(input)],
          'new',
        );
        await tx.productionReportDraft.create({
          data: { productionOrderId: orderId, coilId, createdById: actor.id, ...rowData(input) },
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
        const rows = existing.map(draftRowLike);
        rows[index] = inputRowLike(input);
        const coilId = this.validate(state, rows, index);
        await tx.productionReportDraftPiece.deleteMany({ where: { draftId } });
        await tx.productionReportDraft.update({
          where: { id: draftId },
          data: { coilId, ...rowData(input) },
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

        await this.commitInTx(tx, actor, orderId, input, operationDate, warnings);
      },
      { timeout: 120_000, maxWait: 15_000 },
    );

    return this.roofing.withWarnings(await this.production.findOne(orderId), warnings);
  }

  /**
   * cc27 (UX26-03, D-453): lo que `commit` haría con este mismo cuerpo, sin hacerlo. Corre
   * `commitInTx` en una transacción que se deshace (`previewPlantClose`); la clave de
   * idempotencia no se reclama, así que la ejecución real que sigue la usa normalmente.
   */
  async previewCommit(
    actor: RequestUser,
    orderId: string,
    input: CommitRoofingDraftsInput,
  ): Promise<PlantClosePreviewDto> {
    const operationDate = this.operationDate.resolve(actor, input.operationDate);
    return previewPlantClose(
      this.prisma,
      orderId,
      (tx, warnings) => this.commitInTx(tx, actor, orderId, input, operationDate, warnings),
      COMMIT_PREVIEW_TIMEOUT_MS,
    );
  }

  /**
   * El cuerpo de `commit` sin la clave de idempotencia, **dentro de la transacción del
   * llamador** (patrón `*InTx`, D-099). cc27 (D-453): la vista previa de «Ejecutar y cerrar» lo
   * corre en una transacción que se deshace, así que el resumen sale de este mismo código.
   */
  async commitInTx(
    tx: Prisma.TransactionClient,
    actor: RequestUser,
    orderId: string,
    input: CommitRoofingDraftsInput,
    operationDate: string,
    warnings: RawMaterialShortfall[],
  ): Promise<void> {
    // cc30: confirmar los borradores reporta (y quizá cierra): pedido → OP antes que nada.
    const state = await this.loadState(tx, orderId, { parent: true });
    const drafts = await this.drafts(tx, orderId);
    if (drafts.length === 0 && input.close !== true) {
      throw new BadRequestException(
        'El borrador de la orden está vacío: agrega lo que salió antes de ejecutarlo',
      );
    }
    this.assertRoomForReports(state.liveReports, drafts.length);
    this.validate(state, drafts.map(draftRowLike), 'all');

    // D-388/D-389: la casilla viaja por fila al ejecutar. Una fila que la
    // necesita y no la trae se rechaza adentro de `reportInTx` con su código y su número de
    // fila; una casilla de más (la fila ya entra en el 1 %) no deja rastro.
    const overrides = new Map(
      (input.toleranceOverrides ?? []).map(({ draftId, ...override }) => [draftId, override]),
    );

    for (const [index, draft] of drafts.entries()) {
      const toleranceOverride = overrides.get(draft.id);
      const meters = draft.meters ?? null;
      const piecesCount = draft.piecesCount ?? null;
      try {
        warnings.push(
          ...(await this.roofing.reportInTx(
            tx,
            actor,
            orderId,
            {
              coilId: draft.coilId,
              // cc41 (D-591): una fila de accesorio es su parte por metros (D-343), sin largos.
              ...(meters === null
                ? {
                    pieces: draft.pieces.map((p) => ({
                      lengthMm: p.lengthMm.toFixed(2),
                      qty: p.qty,
                    })),
                  }
                : {
                    meters: meters.toFixed(3),
                    ...(piecesCount === null ? {} : { piecesCount }),
                  }),
              ...(draft.consumedKg === null ? {} : { consumedKg: draft.consumedKg.toFixed(3) }),
              ...(draft.notes === null ? {} : { notes: draft.notes }),
              ...(toleranceOverride === undefined ? {} : { toleranceOverride }),
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
          .reduce((acc, d) => acc.plus(piecesMeters(mathPieces(draftRowLike(d)))), toDecimal('0'))
          .toFixed(3),
        closed: input.close === true,
        operationDate,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  /** Bloquea la orden y lee todo lo que la validación del borrador necesita. */
  private async loadState(
    tx: Prisma.TransactionClient,
    orderId: string,
    lockOptions: Parameters<typeof lockOrder>[2] = {},
  ): Promise<DraftCheckState & { liveReports: number }> {
    const order = await lockOrder(tx, orderId, lockOptions);
    assertKind(order, ProductionOrderKind.ROOFING);
    if (order.status !== ProductionOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        order.status === ProductionOrderStatus.DRAFT
          ? 'La orden todavía no tiene bobina montada: monta el material antes de reportar'
          : `La orden está ${order.status === ProductionOrderStatus.CLOSED ? 'cerrada' : 'anulada'}: no admite reportes`,
      );
    }
    return this.readState(tx, order, orderId);
  }

  /** Lo que la validación del borrador lee de la orden, sin bloquear nada. */
  private async readState(
    tx: Prisma.TransactionClient,
    order: { seq: number; productId: string; reservationId: string | null },
    orderId: string,
  ): Promise<DraftCheckState & { liveReports: number }> {
    const [product, plan, reports, consumptions] = await Promise.all([
      tx.product.findUniqueOrThrow({
        where: { id: order.productId },
        select: { sku: true, lengthMm: true, roofingKind: true },
      }),
      tx.productionOrderItem.findMany({
        where: { productionOrderId: orderId },
        orderBy: { lineNumber: 'asc' },
        select: { lengthMm: true, qty: true },
      }),
      tx.productionReport.findMany({
        where: { productionOrderId: orderId, status: ProductionReportStatus.ACTIVE },
        select: { metersM: true, piecesDetail: { select: { lengthMm: true, qty: true } } },
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
    const accessory = isAccessory(product);
    // cc41 (D-591): el plan de un accesorio son los metros de su línea del pedido (D-343). Una
    // consulta más, solo en un accesorio con pedido.
    const line =
      accessory && order.reservationId !== null
        ? await tx.reservation.findUnique({
            where: { id: order.reservationId },
            select: { salesOrderItem: { select: { qty: true } } },
          })
        : null;
    return {
      orderSeq: order.seq,
      productSku: product.sku,
      fixedLengthMm: product.lengthMm === null ? null : product.lengthMm.toFixed(2),
      planPieces: plan.map(toPieceLike),
      // Un accesorio no deja largos: sus metros de bobina están en `meters_m` (D-343). La misma
      // suma que `reportInTx` y `batchOrders`.
      reportedMeters: accessory
        ? reports.reduce(
            (acc, r) => (r.metersM === null ? acc : acc.plus(toDecimal(r.metersM.toString()))),
            toDecimal('0'),
          )
        : piecesMeters(reports.flatMap((r) => r.piecesDetail.map(toPieceLike))),
      liveReports: reports.length,
      coils: draftCoilStates(consumptions),
      accessory: accessory
        ? {
            orderedMeters: line === null ? null : toDecimal(line.salesOrderItem.qty.toString()),
          }
        : null,
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

/** Lo que se escribe del ingreso en la fila: largos en coberturas, metros en un accesorio. */
function rowData(input: RoofingReportDraftInput) {
  return {
    consumedKg: input.consumedKg === undefined ? null : toFixedString(input.consumedKg, 'KG'),
    // cc41 (D-591): los metros de bobina del accesorio y sus piezas informativas (D-343).
    meters: input.meters === undefined ? null : toFixedString(input.meters, 'KG'),
    piecesCount: input.piecesCount ?? null,
    notes: input.notes ?? null,
    pieces: { create: toPieceRows(input.pieces ?? []) },
  };
}

/** Una fila del ingreso, en la forma que valida `checkDraftRows`. */
function inputRowLike(input: RoofingReportDraftInput): DraftRowLike {
  return {
    coilId: input.coilId,
    pieces: input.pieces ?? [],
    meters: input.meters ?? null,
    consumedKg: input.consumedKg ?? null,
  };
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
