import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryItemType,
  Prisma,
  type InventoryMovement,
  type InventoryMovementType,
  type InventoryRefType,
} from '@prisma/client';
import {
  BACKDATE_OUT_OF_ORDER,
  businessToday,
  carriesInventory,
  Decimal,
  fromDateOnly,
  paginate,
  toDateOnly,
  toDecimal,
  toFixedString,
  toSkipTake,
  type BusinessLine,
  type InventoryBalanceDto,
  type InventoryMovementDto,
  type InventoryQuery,
  type InventorySummaryDto,
  type InventorySummaryRowDto,
  type PaginatedResult,
} from '@ayr/shared';
import { toPrismaLineCode, toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, type Env } from '../config/env';
import { roofingToleranceMm } from '../production/roofing-coil-match';
import {
  assertRawMaterialInvariant,
  findRawMaterialShortfalls,
  lockRawMaterialCoils,
  type RawMaterialShortfall,
} from '../sales/raw-material';
import { assertReservationInvariant, reservedQty } from '../sales/reservation-guard';

/**
 * D-134: los movimientos de un **partido**, que no se comprueban contra el agregado uno por
 * uno.
 *
 * Un partido es una salida de la madre y N entradas de las hijas dentro de la misma
 * transacción, y las hijas heredan línea, color y espesor: el neto sobre el agregado es
 * cero. Comprobar la salida por su cuenta lee un estado transitorio en el que el agregado
 * perdió todo el peso y las hijas todavía no existen, así que partir una bobina con
 * cualquier promesa viva encima se rechazaba con "la operación dejaría X kg libres" aunque
 * no cambiara nada. `CoilOperationsService` hace la comprobación **una vez, al final**,
 * cuando madre e hijas ya están en su estado definitivo.
 */
const SPLIT_REF_TYPES: InventoryRefType[] = ['SPLIT'];

/**
 * Entrada de `InventoryService.record`. `qty` siempre positiva: el sentido lo da `type`
 * (§3.2). `unitCost` solo aplica a las entradas; las salidas se valorizan al costo
 * promedio vigente (D-028, D-040).
 */
export interface RecordMovementInput {
  /**
   * D-134: la reserva que **esta misma salida viene a cumplir**, para que la invariante del
   * agregado no la cuente en su contra.
   *
   * Sin esto, un reporte de producción **parcial** se bloqueaba a sí mismo: la orden consume
   * 8 de los 32 kg prometidos, la promesa baja a 24, y la salida de esos 8 kg se comprueba
   * contra un agregado cuyo único rollo está montado en esta misma orden —así que no cuenta
   * como disponible (D-060)— contra los 24 kg que la propia orden todavía debe. El resultado
   * era 400 en el paso más normal de una corrida, y solo se salvaba quien reportara el 100 %
   * de lo reservado de una sola vez.
   *
   * Es la misma excepción que `mountCoil` y `assertNotReserved` ya aplican, y por el mismo
   * motivo: una promesa no puede bloquear a la operación que existe para cumplirla. Lo que
   * resta de ella sigue protegido por la custodia de la orden (D-060), no queda al aire.
   */
  exceptReservationIds?: string[];
  /**
   * D-154: el **pedido entero** cuya promesa no se cuenta en contra, no solo la reserva de
   * la línea. Un pedido de coberturas reserva una vez por línea y produce una OP por reserva,
   * así que la salida de kardex de la línea 1 se comprobaba contra la promesa viva de la
   * línea 2 —del mismo pedido— y se rechazaba nombrándolo. Ver `RawMaterialScope`.
   */
  exceptSalesOrderIds?: string[];
  /**
   * D-154: cuando el llamador pasa un arreglo, la invariante del agregado **no bloquea**:
   * los faltantes se empujan acá y quien llamó decide qué hacer con ellos. Lo usa producción
   * de coberturas, donde cortar la corrida por una promesa ajena solo lograba que el material
   * rolado quedara sin registrar. El resto del sistema no lo pasa y sigue recibiendo un 400.
   */
  rawMaterialWarnings?: RawMaterialShortfall[];
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  /** `ADJUST` no se emite por acá: mueve costo sin cantidad y tiene su propio método. */
  type: 'IN' | 'OUT';
  qty: string;
  unit: string;
  /** Obligatorio en `IN`. En `OUT` se ignora: manda el promedio ponderado vigente. */
  unitCost?: string;
  refType: InventoryRefType;
  refId?: string;
  /** Motivo escrito por el usuario (merma, ajuste). Se guarda tal cual en el kardex. */
  notes?: string;
  actorId: string;
  /**
   * D-124: día de negocio del movimiento (`YYYY-MM-DD`, Lima). Por defecto **hoy**, así que
   * el llamador que no retrofecha nada no cambia. Quien la manda ya la validó con
   * `OperationDateService.resolve` (rol, no futura, no anterior al piso): el kardex no
   * repite esa validación, la exige aguas arriba.
   */
  operationDate?: string;
  /**
   * D-124: acuse de la advertencia de retrofecha fuera de orden. Ver
   * {@link InventoryService.assertChronological}.
   */
  confirmBackdate?: boolean;
}

/**
 * Ajuste de **costo** sin cambio de cantidad (D-043, landed cost). `amountPen` es el
 * monto en soles que se suma al valor del saldo; puede ser negativo si se está
 * corrigiendo hacia abajo, pero el valor del saldo nunca queda por debajo de cero.
 */
export interface AdjustCostInput {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
  amountPen: string;
  refType: InventoryRefType;
  refId?: string;
  notes?: string;
  actorId: string;
  /** D-124: día de negocio del ajuste. Por defecto hoy. */
  operationDate?: string;
  /** D-124: acuse de la advertencia de retrofecha fuera de orden. */
  confirmBackdate?: boolean;
}

/** Saldo vigente de un ítem, ya en Decimal. */
interface BalanceRow {
  id: string;
  qty: Decimal;
  avgCost: Decimal;
  unit: string;
}

/** Coordenadas de un ítem en el kardex; lo mínimo para bloquear su saldo. */
interface ItemRef {
  businessLineId: string;
  itemType: InventoryItemType;
  itemId: string;
  unit: string;
}

/**
 * Kardex (§3.2, D-028). **Único escritor** de `inventory_movements` e
 * `inventory_balances`: ningún otro módulo toca esas tablas. El movimiento y el saldo
 * se escriben en la misma transacción que la operación que los origina, por eso
 * `record` exige el `tx` del llamador en vez de abrir el suyo.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Registra un movimiento y actualiza el saldo con promedio ponderado.
   * Devuelve `null` si la línea de negocio es `NOOP` (§2.2: `services` no lleva stock),
   * que es un no-op explícito, no un error.
   */
  async record(
    tx: Prisma.TransactionClient,
    input: RecordMovementInput,
  ): Promise<InventoryMovement | null> {
    const line = await tx.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    if (!carriesInventory(line)) return null;

    const qty = toDecimal(input.qty);
    if (!qty.isFinite() || qty.lte(0)) {
      throw new BadRequestException('La cantidad de un movimiento debe ser mayor a cero');
    }

    // D-134: **bobinas antes que saldos**, siempre. El guardrail del agregado bloquea las
    // bobinas compatibles para poder comprobar la invariante sin ventana de carrera, y
    // confirmar un pedido las bloquea primero; tomarlas acá después del saldo sería el
    // orden inverso y las dos operaciones se trabarían entre sí.
    if (input.itemType === InventoryItemType.COIL && input.type !== 'IN') {
      await lockRawMaterialCoils(tx, [input.itemId], roofingToleranceMm(this.env));
    }
    const balance = await this.lockBalance(tx, input);
    const operationDate = input.operationDate ?? businessToday();
    await this.assertChronological(tx, input, operationDate, input.confirmBackdate);

    if (balance.unit !== input.unit && !balance.qty.isZero()) {
      // Mezclar unidades en el mismo saldo (kilos con unidades) haría del promedio y del
      // valorizado un número sin significado.
      throw new BadRequestException(
        `El ítem ya tiene saldo en ${balance.unit}: no se puede mover en ${input.unit}`,
      );
    }

    let unitCost: Decimal;
    let newQty: Decimal;
    let newAvgCost: Decimal;

    if (input.type === 'IN') {
      if (input.unitCost === undefined) {
        throw new BadRequestException('Una entrada de inventario necesita su costo unitario');
      }
      unitCost = toDecimal(input.unitCost);
      if (unitCost.isNegative()) {
        throw new BadRequestException('El costo unitario no puede ser negativo');
      }
      newQty = balance.qty.plus(qty);
      // Promedio ponderado (D-028). Con saldo previo <= 0 el promedio anterior no
      // aporta información: el costo de la entrada pasa a ser el promedio.
      newAvgCost = balance.qty.lte(0)
        ? unitCost
        : balance.qty.times(balance.avgCost).plus(qty.times(unitCost)).div(newQty);
    } else {
      if (qty.gt(balance.qty)) {
        throw new BadRequestException(
          `Stock insuficiente: hay ${balance.qty.toFixed(3)} y se intentan retirar ${qty.toFixed(3)}`,
        );
      }
      // Una salida no cambia el costo promedio; sale valorizada al promedio vigente.
      unitCost = balance.avgCost;
      newQty = balance.qty.minus(qty);
      newAvgCost = balance.avgCost;
    }

    // D-066: `disponible ≥ reservado`. Acá y en `reverse` está el único punto por el que
    // pasa toda salida de stock del sistema (§3.2), y el saldo ya está bloqueado por
    // `lockBalance`, así que la comprobación no tiene ventana de carrera.
    await assertReservationInvariant(
      tx,
      { itemType: input.itemType, itemId: input.itemId },
      newQty,
      balance.qty,
    );

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        qty: toFixedString(newQty, 'KG'),
        avgCost: toFixedString(newAvgCost, 'MONEY'),
        unit: input.unit,
      },
    });

    // D-134: la mitad genérica de la misma invariante. Una cobertura a medida ya no promete
    // `esta` bobina sino **kilos del agregado compatible**, así que el chequeo por ítem de
    // arriba no ve nada cuando la merma cae sobre un rollo que ninguna reserva nombra — y sin
    // embargo el agregado puede quedar por debajo de lo prometido. Se comprueba después de
    // escribir el saldo, dentro de la misma transacción, para leer el estado resultante.
    if (
      input.itemType === InventoryItemType.COIL &&
      newQty.lt(balance.qty) &&
      !SPLIT_REF_TYPES.includes(input.refType)
    ) {
      const scope = {
        exceptReservationIds: input.exceptReservationIds,
        exceptSalesOrderIds: input.exceptSalesOrderIds,
      };
      const tolerance = roofingToleranceMm(this.env);
      if (input.rawMaterialWarnings) {
        input.rawMaterialWarnings.push(
          ...(await findRawMaterialShortfalls(tx, [input.itemId], tolerance, scope)),
        );
      } else {
        await assertRawMaterialInvariant(tx, [input.itemId], tolerance, scope);
      }
    }

    return tx.inventoryMovement.create({
      data: {
        businessLineId: input.businessLineId,
        itemType: input.itemType,
        itemId: input.itemId,
        type: input.type,
        qty: toFixedString(qty, 'KG'),
        unit: input.unit,
        unitCost: toFixedString(unitCost, 'MONEY'),
        totalCost: toFixedString(qty.times(unitCost), 'MONEY'),
        refType: input.refType,
        refId: input.refId ?? null,
        notes: input.notes ?? null,
        actorId: input.actorId,
        operationDate: toDateOnly(operationDate),
      },
    });
  }

  /**
   * Guardrail de orden cronológico (D-124).
   *
   * Vive acá, en el **único escritor** del kardex (§3.2), y no repartido por los diez
   * servicios que registran movimientos: ahí ninguno se lo puede saltear por olvido, que
   * es exactamente cómo D-088 se coló entre dos módulos que creían tener la regla puesta.
   *
   * Qué protege. El saldo corrido y el costo promedio se construyen en el orden en que los
   * movimientos se **grabaron**; la vista los muestra ordenados por fecha de operación
   * (D-124). Mientras la carga histórica vaya en orden cronológico las dos coinciden. Un
   * movimiento insertado por detrás de otros que el ítem ya tiene las separa: el kardex
   * pasa a mostrar, para ese día, un saldo que nunca fue el de ese día. Con producción
   * vacía no se construye un recálculo retroactivo del promedio ponderado —sería una
   * máquina entera para un caso que hoy no existe—; se corta con el detalle y se exige
   * confirmación explícita, y la regla escrita es que la carga histórica va en orden.
   *
   * Costo cero en el flujo normal: si la fecha es hoy no puede haber nada posterior
   * (retrofechar al futuro está prohibido), así que no se consulta nada.
   */
  private async assertChronological(
    tx: Prisma.TransactionClient,
    item: { itemType: InventoryItemType; itemId: string },
    operationDate: string,
    confirmed?: boolean,
  ): Promise<void> {
    if (confirmed || operationDate >= businessToday()) return;
    // El más reciente y el conteo, sin traerse el histórico del ítem a memoria: una carga
    // histórica sobre un ítem con miles de movimientos lo haría en cada llamada.
    const where = {
      itemType: item.itemType,
      itemId: item.itemId,
      operationDate: { gt: toDateOnly(operationDate) },
    };
    const newest = await tx.inventoryMovement.findFirst({
      where,
      orderBy: [{ operationDate: 'desc' }, { id: 'desc' }],
      select: { operationDate: true },
    });
    if (!newest) return;
    const laterCount = await tx.inventoryMovement.count({ where });

    const labels = await this.resolveItemLabels([item]);
    const label = labels.get(labelKey(item.itemType, item.itemId))?.code ?? item.itemId;
    throw new BadRequestException({
      code: BACKDATE_OUT_OF_ORDER,
      message:
        `La fecha ${operationDate} queda ANTES de ${laterCount} movimiento(s) que ${label} ya ` +
        `tiene registrados (el más reciente, del ${fromDateOnly(newest.operationDate)}). La carga ` +
        'histórica va en orden cronológico: registrá primero lo más antiguo.',
      statusCode: 400,
      error: 'Bad Request',
    });
  }

  /**
   * Ajuste de costo sin movimiento de cantidad (D-043). El movimiento guarda en `qty`
   * los kilos afectados —el `CHECK qty > 0` de la base sigue valiendo— y en `unitCost`
   * el delta por kilo, de modo que `totalCost` es exactamente el monto imputado.
   * Devuelve `null` en líneas `NOOP` y también cuando el ítem no tiene saldo: un costo
   * repartido sobre cero kilos no tiene dónde ir y reescribir el pasado no es opción.
   */
  async adjustCost(
    tx: Prisma.TransactionClient,
    input: AdjustCostInput,
  ): Promise<InventoryMovement | null> {
    const line = await tx.businessLine.findUnique({ where: { id: input.businessLineId } });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    if (!carriesInventory(line)) return null;

    const amount = toDecimal(input.amountPen);
    if (!amount.isFinite()) throw new BadRequestException('Monto de ajuste inválido');
    if (amount.isZero()) return null;

    const balance = await this.lockBalance(tx, input);
    if (balance.qty.lte(0)) return null;
    // D-124: un ajuste mueve valor con una fecha, así que también se ordena. Mismo guardrail.
    await this.assertChronological(
      tx,
      input,
      input.operationDate ?? businessToday(),
      input.confirmBackdate,
    );

    // El valor del saldo no puede quedar negativo: un ajuste a la baja mayor que el
    // valor en stock significaría que se está descontando costo que ya salió.
    const currentValue = balance.qty.times(balance.avgCost);
    const newValue = currentValue.plus(amount);
    if (newValue.isNegative()) {
      throw new BadRequestException(
        `El ajuste deja el inventario del ítem con valor negativo (${currentValue.toFixed(2)} en stock)`,
      );
    }
    const newAvgCost = newValue.div(balance.qty);

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: { avgCost: toFixedString(newAvgCost, 'MONEY'), unit: balance.unit },
    });

    return tx.inventoryMovement.create({
      data: {
        businessLineId: input.businessLineId,
        itemType: input.itemType,
        itemId: input.itemId,
        type: 'ADJUST',
        qty: toFixedString(balance.qty, 'KG'),
        unit: balance.unit,
        unitCost: toFixedString(amount.div(balance.qty), 'MONEY'),
        totalCost: toFixedString(amount, 'MONEY'),
        refType: input.refType,
        refId: input.refId ?? null,
        notes: input.notes ?? null,
        actorId: input.actorId,
        operationDate: toDateOnly(input.operationDate ?? businessToday()),
      },
    });
  }

  /**
   * Anula un movimiento emitiendo su inverso (§3.2: nunca `UPDATE` ni `DELETE`). El
   * inverso arrastra el **mismo valor** que el original, no el promedio del momento:
   * revertir un ingreso tiene que sacar del saldo exactamente el costo que metió, o
   * el promedio ponderado quedaría contaminado por la anulación.
   *
   * Idempotente: `inventory_movements.reversal_of_id` es único, así que dos reversas
   * simultáneas del mismo movimiento no pueden convivir; la segunda choca contra el
   * índice y se traduce a un 409 legible.
   *
   * D-124: la reversa tiene **fecha de operación propia** —por defecto hoy— y jamás hereda
   * la del original en silencio. Anular hoy una entrada de agosto es un hecho de hoy: si la
   * reversa se fechara en agosto, el saldo de agosto quedaría como si el material nunca
   * hubiera entrado, y el reporte de un mes ya cerrado cambiaría solo. Quien de verdad
   * quiera fecharla en agosto (porque la anulación también ocurrió ahí) la manda explícita,
   * y pasa por las mismas validaciones que cualquier otra retrofecha.
   */
  async reverse(
    tx: Prisma.TransactionClient,
    movementId: bigint,
    actorId: string,
    reason: string,
    operationDate?: string,
    confirmBackdate?: boolean,
  ): Promise<InventoryMovement> {
    const original = await tx.inventoryMovement.findUnique({ where: { id: movementId } });
    if (!original) throw new NotFoundException('Movimiento de kardex no encontrado');
    if (original.reversalOfId !== null) {
      throw new BadRequestException('Un movimiento de anulación no se puede volver a anular');
    }
    const existing = await tx.inventoryMovement.findFirst({
      where: { reversalOfId: movementId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Ese movimiento ya fue anulado');
    }

    const item: ItemRef = {
      businessLineId: original.businessLineId,
      itemType: original.itemType,
      itemId: original.itemId,
      unit: original.unit,
    };
    const balance = await this.lockBalance(tx, item);
    // D-124: una reversa retrofechada mete una salida (o una entrada) por detrás del saldo
    // corrido igual que cualquier otro movimiento, así que pasa por el mismo guardrail. Por
    // defecto la fecha es hoy y el chequeo ni consulta.
    await this.assertChronological(tx, item, operationDate ?? businessToday(), confirmBackdate);
    const origQty = toDecimal(original.qty.toString());
    const origValue = toDecimal(original.totalCost.toString());
    const currentValue = balance.qty.times(balance.avgCost);

    let type: InventoryMovementType;
    let qty: Decimal;
    let unitCost: Decimal;
    let totalCost: Decimal;
    let newQty: Decimal;
    let newValue: Decimal;

    if (original.type === 'IN') {
      if (origQty.gt(balance.qty)) {
        throw new BadRequestException(
          `No se puede anular el ingreso: quedan ${balance.qty.toFixed(3)} de los ${origQty.toFixed(3)} que ingresaron`,
        );
      }
      type = 'OUT';
      qty = origQty;
      unitCost = toDecimal(original.unitCost.toString());
      totalCost = origValue;
      newQty = balance.qty.minus(origQty);
      newValue = currentValue.minus(origValue);
    } else if (original.type === 'OUT') {
      type = 'IN';
      qty = origQty;
      unitCost = toDecimal(original.unitCost.toString());
      totalCost = origValue;
      newQty = balance.qty.plus(origQty);
      newValue = currentValue.plus(origValue);
    } else {
      // Un ADJUST solo movió valor. Su reversa saca la parte de ese valor que TODAVÍA
      // está en el saldo: el ajuste repartió `origValue` sobre `origQty` kilos, así que
      // si hoy quedan menos, lo que sigue adentro es la fracción proporcional. Sacar el
      // monto completo dejaría el promedio por debajo del costo real del stock que
      // sobrevive, y ese error viaja al precio sugerido (D-032) y al costeo (D-035).
      if (balance.qty.lte(0)) {
        throw new BadRequestException(
          'No se puede anular el ajuste de costo: el ítem ya no tiene saldo',
        );
      }
      const surviving = Decimal.min(balance.qty, origQty);
      type = 'ADJUST';
      qty = balance.qty;
      totalCost = origValue.times(surviving).div(origQty).negated();
      unitCost = totalCost.div(balance.qty);
      newQty = balance.qty;
      newValue = currentValue.plus(totalCost);
    }

    if (newValue.isNegative()) {
      if (newQty.lte(0)) {
        // Sin kilos, un residuo negativo es ruido de redondeo del promedio guardado con
        // 4 decimales: el saldo vacío se cierra en cero y no hay nada que distorsionar.
        newValue = new Decimal(0);
      } else {
        // Con kilos en stock sí importa: recortarlo a cero en silencio dejaría el
        // valorizado por debajo del costo real sin error, sin auditoría y sin traza.
        throw new ConflictException(
          `No se puede anular el movimiento: sacaría ${origValue.toFixed(2)} de un saldo valorizado en ${currentValue.toFixed(2)}. Revisa los movimientos posteriores del ítem.`,
        );
      }
    }
    const newAvgCost = newQty.lte(0) ? new Decimal(0) : newValue.div(newQty);

    // D-066: la reversa de un ingreso saca stock igual que una salida, así que también
    // tiene que respetar `disponible ≥ reservado`. Anular la compra de una bobina cuyo
    // material ya está prometido a un pedido falla acá, con el pedido nombrado.
    await assertReservationInvariant(
      tx,
      { itemType: original.itemType, itemId: original.itemId },
      newQty,
      balance.qty,
    );

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        qty: toFixedString(newQty, 'KG'),
        avgCost: toFixedString(newAvgCost, 'MONEY'),
        unit: balance.unit,
      },
    });

    // D-134: igual que en `record`. Anular el ingreso de una bobina baja el agregado sin
    // que ninguna reserva nombre a esa bobina.
    if (
      original.itemType === InventoryItemType.COIL &&
      newQty.lt(balance.qty) &&
      !SPLIT_REF_TYPES.includes(original.refType)
    ) {
      await assertRawMaterialInvariant(tx, [original.itemId], roofingToleranceMm(this.env));
    }

    try {
      return await tx.inventoryMovement.create({
        data: {
          businessLineId: original.businessLineId,
          itemType: original.itemType,
          itemId: original.itemId,
          type,
          qty: toFixedString(qty, 'KG'),
          unit: original.unit,
          unitCost: toFixedString(unitCost, 'MONEY'),
          totalCost: toFixedString(totalCost, 'MONEY'),
          refType: original.refType,
          refId: original.refId,
          notes: reason,
          reversalOfId: original.id,
          actorId,
          operationDate: toDateOnly(operationDate ?? businessToday()),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ese movimiento ya fue anulado por otra operación');
      }
      throw err;
    }
  }

  /**
   * Crea el saldo si no existe y lo bloquea (`FOR UPDATE`) hasta el fin de la
   * transacción, para que dos movimientos concurrentes del mismo ítem no calculen el
   * promedio ponderado sobre el mismo saldo previo.
   */
  private async lockBalance(tx: Prisma.TransactionClient, input: ItemRef): Promise<BalanceRow> {
    await tx.$executeRaw`
      INSERT INTO "inventory_balances"
        ("id", "business_line_id", "item_type", "item_id", "qty", "avg_cost", "unit", "updated_at")
      VALUES (
        ${randomUUID()}::uuid,
        ${input.businessLineId}::uuid,
        ${input.itemType}::"InventoryItemType",
        ${input.itemId}::uuid,
        0, 0, ${input.unit}, NOW()
      )
      ON CONFLICT ("item_type", "item_id") DO NOTHING
    `;

    const rows = await tx.$queryRaw<
      {
        id: string;
        qty: Prisma.Decimal;
        avg_cost: Prisma.Decimal;
        unit: string;
        business_line_id: string;
      }[]
    >`
      SELECT "id", "qty", "avg_cost", "unit", "business_line_id"
      FROM "inventory_balances"
      WHERE "item_type" = ${input.itemType}::"InventoryItemType"
        AND "item_id" = ${input.itemId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('No se pudo obtener el saldo de inventario del ítem');
    // El saldo es único por (itemType, itemId), no por línea: un movimiento emitido con
    // la línea equivocada actualizaría el saldo de otra línea sin que nada avisara, y el
    // valorizado por línea (RF-51) empezaría a mentir en las dos.
    if (row.business_line_id !== input.businessLineId) {
      throw new BadRequestException(
        'El ítem ya tiene saldo en otra línea de negocio: un mismo ítem no se mueve en dos líneas',
      );
    }

    return {
      id: row.id,
      qty: toDecimal(row.qty.toString()),
      avgCost: toDecimal(row.avg_cost.toString()),
      unit: row.unit,
    };
  }

  /**
   * Saldo físico, reservado y disponible de un ítem, **con el saldo bloqueado** (D-066).
   *
   * Es el mismo `FOR UPDATE` que toma cualquier movimiento de kardex, y por eso vive acá y
   * no en `sales`: la confirmación de un pedido tiene que ver exactamente el saldo que
   * verá la próxima salida, o dos transacciones concurrentes podrían prometer el mismo
   * material. `unit` sale del saldo si el ítem ya tiene uno, y del `fallbackUnit` si es
   * la primera vez que se lo toca.
   */
  async lockAvailability(
    tx: Prisma.TransactionClient,
    input: ItemRef,
  ): Promise<{ qty: Decimal; reserved: Decimal; available: Decimal; unit: string }> {
    const balance = await this.lockBalance(tx, input);
    const reserved = await reservedQty(tx, { itemType: input.itemType, itemId: input.itemId });
    return {
      qty: balance.qty,
      reserved,
      available: balance.qty.minus(reserved),
      unit: balance.unit,
    };
  }

  /**
   * D-119 (Fase 7e): la línea de negocio **dueña** de este ítem — la del propio producto,
   * o la de la bobina física, nunca la del documento comercial que lo reserva o lo
   * despacha. Antes de la Fase 7e todo pedido tenía una sola línea y coincidía siempre con
   * la del ítem; una cotización mixta (D-119) o una venta de bobina completa (D-116, donde
   * el producto es de `trading` pero la bobina es de Drywall o Metallic Roofing) rompen esa
   * coincidencia, y `lockBalance` rechaza un movimiento cuya `businessLineId` no sea la que
   * el saldo ya tiene.
   */
  async resolveItemBusinessLineId(
    tx: Prisma.TransactionClient,
    itemType: InventoryItemType,
    itemId: string,
  ): Promise<string> {
    // D-134: un agregado de materia prima no es un ítem de inventario y no tiene línea
    // propia — la tiene la spec. Sin esta rama caía en la de producto y devolvía un
    // "Producto no encontrado" que no dice nada de lo que de verdad pasó.
    if (itemType === InventoryItemType.RAW_MATERIAL) {
      const spec = await tx.rawMaterialSpec.findUnique({
        where: { id: itemId },
        select: { businessLineId: true },
      });
      if (!spec) throw new NotFoundException('Agregado de materia prima no encontrado');
      return spec.businessLineId;
    }
    if (itemType === InventoryItemType.COIL) {
      const coil = await tx.coil.findUnique({
        where: { id: itemId },
        select: { businessLineId: true },
      });
      if (!coil) throw new NotFoundException('Bobina no encontrada');
      return coil.businessLineId;
    }
    const product = await tx.product.findUnique({
      where: { id: itemId },
      select: { businessLineId: true },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product.businessLineId;
  }

  /** Inventario valorizado (RF-51, base de RF-90). */
  async findBalances(query: InventoryQuery, showCosts: boolean): Promise<InventoryBalanceDto[]> {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: {
        itemType: query.itemType,
        itemId: query.itemId,
        businessLine: query.businessLine
          ? { code: toPrismaLineCode(query.businessLine) }
          : undefined,
      },
      include: { businessLine: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });

    const labels = await this.resolveItemLabels(balances);
    // D-066: lo reservado se resuelve en una sola consulta agrupada, no una por fila.
    const reserved = await this.reservedByItem(balances);
    return balances.map((b) => {
      const qty = toDecimal(b.qty.toString());
      const avgCost = toDecimal(b.avgCost.toString());
      const label = labels.get(labelKey(b.itemType, b.itemId));
      const reservedQty = reserved.get(labelKey(b.itemType, b.itemId)) ?? new Decimal(0);
      return {
        id: b.id,
        businessLine: toSharedLineCode(b.businessLine.code),
        itemType: b.itemType,
        itemId: b.itemId,
        itemLabel: label?.code ?? b.itemId,
        itemName: label?.name ?? '',
        qty: qty.toFixed(3),
        unit: b.unit,
        reservedQty: reservedQty.toFixed(3),
        availableQty: qty.minus(reservedQty).toFixed(3),
        avgCost: showCosts ? avgCost.toFixed(4) : null,
        totalValue: showCosts ? toFixedString(qty.times(avgCost), 'MONEY') : null,
        updatedAt: b.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Inventario valorizado de una línea (RF-51). Las bobinas se agregan por `typeKey`
   * (RF-14) porque el partido cambia el ancho pero no el material; los productos de
   * catálogo van uno por SKU. Todo en soles (D-042).
   *
   * El promedio del grupo se calcula como valor total / cantidad total y no como
   * promedio de promedios: dos bobinas del mismo tipo con pesos distintos tienen que
   * pesar distinto en el costo agregado.
   */
  async summary(businessLine: BusinessLine, showCosts: boolean): Promise<InventorySummaryDto> {
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { businessLine: { code: toPrismaLineCode(businessLine) } },
      take: 5000,
    });
    const withStock = balances.filter((b) => toDecimal(b.qty.toString()).gt(0));
    const labels = await this.resolveItemLabels(withStock);
    // D-066: lo reservado se agrega por grupo junto con la cantidad, para que la pantalla
    // muestre físico, reservado y disponible como tres columnas de la misma fila.
    const reserved = await this.reservedByItem(withStock);

    const groups = new Map<
      string,
      { itemType: InventoryItemType; name: string; unit: string; ids: string[] } & {
        qty: Decimal;
        value: Decimal;
        reserved: Decimal;
      }
    >();

    for (const b of withStock) {
      const label = labels.get(labelKey(b.itemType, b.itemId));
      // Las bobinas se agrupan por su `typeKey`, que `resolveItemLabels` devuelve en
      // `name`; los productos, por su SKU, que es único dentro de la línea.
      const key = b.itemType === 'COIL' ? (label?.name ?? b.itemId) : (label?.code ?? b.itemId);
      const qty = toDecimal(b.qty.toString());
      const value = qty.times(toDecimal(b.avgCost.toString()));
      const itemReserved = reserved.get(labelKey(b.itemType, b.itemId)) ?? new Decimal(0);
      const current = groups.get(`${b.itemType}:${key}`);
      if (current) {
        current.qty = current.qty.plus(qty);
        current.value = current.value.plus(value);
        current.reserved = current.reserved.plus(itemReserved);
        current.ids.push(b.itemId);
      } else {
        groups.set(`${b.itemType}:${key}`, {
          itemType: b.itemType,
          // En bobinas la clave ya ES el `typeKey`; repetirlo como descripción dejaría
          // dos columnas iguales, así que se desarma en algo legible.
          name: b.itemType === 'COIL' ? describeTypeKey(key) : (label?.name ?? ''),
          unit: b.unit,
          ids: [b.itemId],
          qty,
          value,
          reserved: itemReserved,
        });
      }
    }

    const rows: (InventorySummaryRowDto & { itemType: InventoryItemType })[] = [];
    for (const [mapKey, g] of groups) {
      rows.push({
        key: mapKey.slice(mapKey.indexOf(':') + 1),
        itemType: g.itemType,
        name: g.name,
        qty: g.qty.toFixed(3),
        unit: g.unit,
        reservedQty: g.reserved.toFixed(3),
        availableQty: g.qty.minus(g.reserved).toFixed(3),
        avgCostPen: showCosts
          ? toFixedString(g.qty.lte(0) ? new Decimal(0) : g.value.div(g.qty), 'MONEY')
          : null,
        totalValuePen: showCosts ? toFixedString(g.value, 'MONEY') : null,
        itemCount: g.ids.length,
        // Solo tiene sentido enlazar al kardex de un ítem cuando el grupo es uno solo.
        itemId: g.ids.length === 1 ? (g.ids[0] ?? null) : null,
      });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));

    const total = rows.reduce(
      (acc, r) => acc.plus(toDecimal(r.totalValuePen ?? '0')),
      new Decimal(0),
    );
    return {
      businessLine,
      coils: rows.filter((r) => r.itemType === 'COIL'),
      products: rows.filter((r) => r.itemType === 'PRODUCT'),
      totalValuePen: showCosts ? toFixedString(total, 'MONEY') : null,
    };
  }

  /**
   * Movimientos de kardex (RF-53). Cuando la consulta apunta a un ítem concreto se
   * devuelve además el saldo corrido después de cada movimiento, recalculado en orden
   * cronológico; en un listado mezclado ese saldo no tiene sentido y va en `null`.
   */
  async findMovements(
    query: InventoryQuery,
    showCosts: boolean,
  ): Promise<PaginatedResult<InventoryMovementDto>> {
    const singleItem = Boolean(query.itemId && query.itemType);

    const where = {
      itemType: query.itemType,
      itemId: query.itemId,
      businessLine: query.businessLine ? { code: toPrismaLineCode(query.businessLine) } : undefined,
      // D-124: el corte por fecha es por **día de negocio**, no por el instante de
      // grabación. Un movimiento de agosto cargado en septiembre tiene que caer en agosto.
      operationDate: {
        gte: query.from ? toDateOnly(query.from) : undefined,
        lte: query.to ? toDateOnly(query.to) : undefined,
      },
    };
    // El kardex de un ítem concreto se lee completo y en orden cronológico, porque el saldo
    // corrido solo se puede calcular desde el primer movimiento: no pagina (D-113), y el
    // tope de 10 000 es "todo lo que un solo ítem puede acumular", no una página. El
    // listado mezclado sí pagina, y se recorta a los más RECIENTES: cortar por los más
    // antiguos mostraba justo lo contrario de lo que dice la vista.
    const { skip, take } = singleItem ? { skip: 0, take: 10_000 } : toSkipTake(query);
    const [total, movements] = await Promise.all([
      singleItem ? Promise.resolve(0) : this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        include: { businessLine: true, reversals: { select: { id: true } } },
        // D-124: ordena por fecha de operación; el `id` bigserial (orden real de grabación)
        // desempata dentro del mismo día, que es lo que hace determinista el saldo corrido.
        orderBy: singleItem
          ? [{ operationDate: 'asc' }, { id: 'asc' }]
          : [{ operationDate: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
    ]);
    if (!singleItem) movements.reverse();

    const labels = await this.resolveItemLabels(movements);
    const actors = await this.resolveActorNames(movements);

    // El saldo corrido se lleva por VALOR, no recalculando el promedio ponderado a
    // partir del `unitCost` de cada fila: una anulación (RF-18, RF-21) saca del saldo
    // el costo exacto que el movimiento original metió, no el promedio del momento, y
    // un `ADJUST` mueve valor sin mover cantidad. Con `totalCost` las tres formas caen
    // en la misma cuenta y esta vista no puede divergir de `inventory_balances`.
    //
    // Con filtro `desde` hay que arrancar del saldo de apertura, no de cero: si no, un
    // kardex filtrado por fecha muestra cantidades y promedios que no son los del ítem.
    const opening = singleItem && query.from ? await this.openingBalance(query, query.from) : null;
    let runningQty = opening?.qty ?? new Decimal(0);
    let runningValue = opening?.value ?? new Decimal(0);

    const dtos = movements.map((m) => {
      const qty = toDecimal(m.qty.toString());
      const unitCost = toDecimal(m.unitCost.toString());
      const totalCost = toDecimal(m.totalCost.toString());
      if (singleItem) {
        if (m.type === 'IN') {
          runningQty = runningQty.plus(qty);
          runningValue = runningValue.plus(totalCost);
        } else if (m.type === 'OUT') {
          runningQty = runningQty.minus(qty);
          runningValue = runningValue.minus(totalCost);
        } else {
          runningValue = runningValue.plus(totalCost);
        }
        if (runningValue.isNegative()) runningValue = new Decimal(0);
      }
      const runningAvg = runningQty.lte(0) ? new Decimal(0) : runningValue.div(runningQty);
      const label = labels.get(labelKey(m.itemType, m.itemId));
      return {
        id: m.id.toString(),
        businessLine: toSharedLineCode(m.businessLine.code),
        itemType: m.itemType,
        itemId: m.itemId,
        itemLabel: label?.code ?? m.itemId,
        type: m.type,
        qty: qty.toFixed(3),
        unit: m.unit,
        unitCost: showCosts ? unitCost.toFixed(4) : null,
        totalCost: showCosts ? m.totalCost.toFixed(4) : null,
        refType: m.refType,
        refId: m.refId,
        notes: m.notes,
        reversalOfId: m.reversalOfId === null ? null : m.reversalOfId.toString(),
        reversedById: m.reversals[0] ? m.reversals[0].id.toString() : null,
        actorId: m.actorId,
        actorName: m.actorId ? (actors.get(m.actorId) ?? null) : null,
        at: m.at.toISOString(),
        operationDate: fromDateOnly(m.operationDate),
        balanceQty: singleItem ? runningQty.toFixed(3) : null,
        balanceAvgCost: singleItem && showCosts ? toFixedString(runningAvg, 'MONEY') : null,
      } satisfies InventoryMovementDto;
    });

    // Más reciente primero para la vista; el cálculo del saldo corrido necesitaba el orden inverso.
    const items = dtos.reverse();
    // El de un ítem concreto no pagina: es "todo lo que hay", una sola página que lo
    // contiene entero. Decirlo así (en vez de fingir page/pageSize del pedido) es lo que
    // hace que `PaginatedResult` no mienta sobre cuántas páginas hay.
    return singleItem
      ? { items, total: items.length, page: 1, pageSize: Math.max(items.length, 1) }
      : paginate(items, total, query);
  }

  /**
   * Saldo de un ítem justo antes de `from`, con la misma cuenta por valor que usa el
   * saldo corrido: entradas suman cantidad y valor, salidas restan ambas y los ajustes
   * solo mueven valor. Se calcula en SQL para no traer a memoria un histórico entero
   * que la vista después descarta.
   */
  private async openingBalance(
    query: InventoryQuery,
    from: string,
  ): Promise<{ qty: Decimal; value: Decimal }> {
    const rows = await this.prisma.$queryRaw<{ qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
      SELECT
        COALESCE(SUM(CASE "type" WHEN 'IN' THEN "qty" WHEN 'OUT' THEN -"qty" ELSE 0 END), 0) AS "qty",
        COALESCE(SUM(CASE "type" WHEN 'OUT' THEN -"total_cost" ELSE "total_cost" END), 0) AS "value"
      FROM "inventory_movements"
      WHERE "item_type" = ${query.itemType}::"InventoryItemType"
        AND "item_id" = ${query.itemId}::uuid
        AND "operation_date" < ${toDateOnly(from)}::date
    `;
    const row = rows[0];
    return {
      qty: toDecimal(row?.qty.toString() ?? '0'),
      value: Decimal.max(toDecimal(row?.value.toString() ?? '0'), new Decimal(0)),
    };
  }

  /** Resuelve el código y nombre legible de cada ítem referido (SKU o código de bobina). */
  /**
   * Reservas `ACTIVA` de un conjunto de saldos, agrupadas por ítem (D-066). Una sola
   * consulta para toda la lista: en `/inventario` hay cientos de filas y una consulta por
   * fila sería el mismo N+1 que ya costó una corrección en la recepción de compras.
   */
  private async reservedByItem(
    balances: { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, Decimal>> {
    const map = new Map<string, Decimal>();
    if (balances.length === 0) return map;
    const rows = await this.prisma.reservation.groupBy({
      by: ['itemType', 'itemId'],
      where: {
        status: 'ACTIVE',
        itemId: { in: [...new Set(balances.map((b) => b.itemId))] },
      },
      _sum: { qty: true },
    });
    for (const r of rows) {
      if (r._sum.qty === null) continue;
      map.set(labelKey(r.itemType, r.itemId), toDecimal(r._sum.qty.toString()));
    }
    return map;
  }

  private async resolveItemLabels(
    rows: { itemType: InventoryItemType; itemId: string }[],
  ): Promise<Map<string, { code: string; name: string }>> {
    const productIds = [
      ...new Set(rows.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId)),
    ];
    const coilIds = [...new Set(rows.filter((r) => r.itemType === 'COIL').map((r) => r.itemId))];

    const [products, coils] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true, name: true },
          })
        : Promise.resolve([]),
      coilIds.length
        ? this.prisma.coil.findMany({
            where: { id: { in: coilIds } },
            select: { id: true, code: true, typeKey: true },
          })
        : Promise.resolve([]),
    ]);

    const labels = new Map<string, { code: string; name: string }>();
    for (const p of products) {
      labels.set(labelKey('PRODUCT', p.id), { code: p.sku, name: p.name });
    }
    for (const c of coils) {
      labels.set(labelKey('COIL', c.id), { code: c.code, name: c.typeKey });
    }
    return labels;
  }

  private async resolveActorNames(
    rows: { actorId: string | null }[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

function labelKey(itemType: InventoryItemType, itemId: string): string {
  return `${itemType}:${itemId}`;
}

/** `"GALV-0.50"` → `"Acabado GALV · 0.50 mm"` (RF-14). Sin consultar nada más. */
function describeTypeKey(typeKey: string): string {
  const separator = typeKey.lastIndexOf('-');
  if (separator <= 0) return typeKey;
  return `Acabado ${typeKey.slice(0, separator)} · ${typeKey.slice(separator + 1)} mm`;
}
