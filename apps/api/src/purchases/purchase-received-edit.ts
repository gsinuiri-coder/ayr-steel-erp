import { PurchaseType } from '@prisma/client';
import {
  Decimal,
  toDecimal,
  toFixedString,
  type EditReceivedPurchaseInput,
  type ReceivedEditGroup,
  type ReceivedEditPath,
  type ReceivedEditPlanDto,
} from '@ayr/shared';

/**
 * D-372 (cc14) — editar una compra ya recibida, versión 1.
 *
 * Diseño aprobado en `docs/analisis/m2b-editar-compras-2026-10-02.md`:
 *
 * - **Cáscara** (proveedor, comprobante, fecha de emisión, condiciones, observaciones): se edita
 *   en la fila y se audita. El proveedor solo sin pagos vigentes.
 * - **Costo** (precio de la línea) y **kardex** (cantidad, producto, especificación de la bobina):
 *   solo en ítems **sin movimientos posteriores**. Precio, cantidad y producto revierten el
 *   ingreso y vuelven a ingresar en la misma fecha (el recosteo de D-045 generalizado); la
 *   especificación de una bobina intacta se corrige en la fila, sin mover kardex.
 * - **Bloqueos:** pagos vigentes, movimientos posteriores (con cuáles), bobina en corte o montada,
 *   landed cost aplicado, y costo con consumo posterior («disponible en la próxima versión»: el
 *   ajuste proporcional de la sesión 2).
 *
 * Este módulo es **puro**: recibe los hechos ya leídos y devuelve el plan. El servicio lo usa
 * igual para la vista previa y dentro de la transacción que escribe, así lo que se muestra es lo
 * que se hace.
 */

/** Un movimiento posterior que bloquea, ya nombrado para el mensaje. */
export interface LaterMovement {
  /** `IN` es otra entrada (otra compra del mismo producto); `OUT`/`ADJUST`, consumo o costo. */
  type: 'IN' | 'OUT' | 'ADJUST';
  refType: string;
  operationDate: string;
}

/** Fecha de vencimiento de una compra al crédito, o `null` al contado (la cuenta del alta). */
function dueDateOf(
  paymentTerms: string,
  creditDays: number | null,
  issueDate: string,
): string | null {
  if (paymentTerms !== 'CREDITO' || !creditDays) return null;
  const due = new Date(`${issueDate}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + creditDays);
  return due.toISOString().slice(0, 10);
}

/** Lo que el servicio sabe de una línea antes de clasificar. */
export interface ItemFacts {
  itemId: string;
  lineNumber: number;
  /** Producto (FINISHED_GOOD) o `null`. */
  productId: string | null;
  productLabel: string | null;
  /** Descripción de la línea (la del papel). */
  description: string;
  unit: string;
  qty: string;
  unitPrice: string;
  finishId: string | null;
  finishLabel: string | null;
  widthMm: string | null;
  thicknessMm: string | null;
  /** Movimientos vivos del ítem después del ingreso de esta compra (no los de ella). */
  laterMovements: LaterMovement[];
  /**
   * Hay un ingreso vivo de esta compra para la línea, y es el que se revierte. Sin él, una
   * reversa y reingreso no tienen qué revertir: se bloquea en vez de tocar solo la compra.
   */
  hasLiveIn: boolean;
  /**
   * D-134: los pedidos cuya promesa de materia prima por agregado quedaría sin cubrir si la
   * bobina se quedara sin saldo (el instante de la reversa), ya nombrados; `null` si ninguno.
   */
  backsPromised: string | null;
  /**
   * cc15b, punto 5: los pedidos cuya promesa de materia prima quedaría sin cubrir si la bobina
   * cambiara de color o de espesor y dejara su agregado; `null` si ninguno o si no cambia.
   */
  specPromised: string | null;
  /** cc15b, punto 3: saldo del ítem hoy y lo reservado sobre él, para la reserva al final. */
  balanceQty: string;
  reservedQty: string;
  /**
   * cc15b (revisión P1-1): si la cantidad nueva dejaría el saldo corrido negativo en alguna
   * fecha posterior (una salida anulada sigue en su fecha), ese mínimo; si no, `null`.
   */
  runningLow: string | null;
  /** Bobina: estado, si está montada en una OP y si tiene landed cost. */
  coilStatus: string | null;
  mountedOrder: string | null;
  /**
   * Hay material reservado que la reversa del ingreso dejaría sin cubrir (la reserva de la
   * bobina, o la del producto por encima de lo que queda sin este ingreso). La reversa de
   * `InventoryService` lo rechazaría; la vista previa lo dice antes.
   */
  ownReservation: boolean;
  landedCost: boolean;
  /** Más de una línea de la compra entra al mismo producto: el ingreso no se separa por línea. */
  sharedProduct: boolean;
}

export interface PurchaseFacts {
  purchaseId: string;
  type: PurchaseType;
  livePayments: number;
  /**
   * Si la tasa de IGV no se deduce de los totales (D-371), el motivo: un cambio de precio o
   * cantidad no puede recalcular los importes de la línea.
   */
  igvRateIssue: string | null;
  header: {
    supplierId: string;
    supplierLabel: string;
    docType: string;
    series: string;
    number: string;
    issueDate: string;
    paymentTerms: string;
    creditDays: number | null;
    /** Vencimiento guardado, para mostrar el recalculado (cc15). */
    dueDate: string | null;
    notes: string | null;
  };
  items: ItemFacts[];
}

/** Lo que el servicio necesita resolver para clasificar un cambio de producto o acabado. */
export interface TargetFacts {
  /** Etiqueta del proveedor, producto o acabado nuevo, por id. */
  labels: Map<string, string>;
  /** Producto nuevo con movimientos posteriores a la fecha de recepción, por id. */
  productsWithLaterMovements: Set<string>;
  /** Producto nuevo inválido (otra línea, otra unidad, inactivo), con el motivo. */
  invalidProducts: Map<string, string>;
  invalidFinishes: Map<string, string>;
  /** Nombre del producto nuevo: pasa a ser la descripción de la línea (decisión D de cc15). */
  productNames: Map<string, string>;
}

type Change = ReceivedEditPlanDto['changes'][number];

const HEADER_LABELS: Record<string, string> = {
  supplierId: 'Proveedor',
  docType: 'Tipo de comprobante',
  series: 'Serie',
  number: 'Número',
  issueDate: 'Fecha de emisión',
  paymentTerms: 'Condición de pago',
  creditDays: 'Días de crédito',
  dueDate: 'Vencimiento',
  notes: 'Observaciones',
};

const ITEM_LABELS: Record<string, string> = {
  unitPrice: 'Precio unitario',
  qty: 'Cantidad',
  productId: 'Producto',
  finishId: 'Acabado',
  widthMm: 'Ancho (mm)',
  thicknessMm: 'Espesor (mm)',
};

/** El nombre de la operación que movió el ítem, para el mensaje de bloqueo. */
const REF_LABELS: Record<string, string> = {
  PURCHASE: 'otra compra',
  SALE: 'venta',
  PRODUCTION: 'producción',
  SPLIT: 'partido',
  SCRAP: 'merma',
  CLOSE_ADJUSTMENT: 'cierre de bobina',
  CUTTING: 'corte',
  ADJUSTMENT: 'ajuste de inventario',
  IMPORT: 'carga inicial',
  OWN_COST_CORRECTION: 'corrección de costo de esta compra',
};

/** Igualdad de importes y medidas por valor, no por texto ("10" = "10.0000"). */
function sameNumber(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return toDecimal(a).equals(toDecimal(b));
}

/**
 * Por qué no se puede un cambio. `replace` (cc15b) es el reemplazo del ingreso sobre el **mismo**
 * ítem (precio o cantidad, `InventoryService.replaceEntry`): ahí otras entradas posteriores no
 * bloquean (punto 4) y la reserva se mira sobre el estado final (punto 3), no acá.
 */
function blockedBy(
  facts: PurchaseFacts,
  item: ItemFacts,
  group: ReceivedEditGroup,
  reentry: boolean,
  replace = false,
): string | null {
  if (facts.livePayments > 0) {
    return 'La compra tiene pagos vigentes: revierte los pagos antes de corregir costo o cantidades';
  }
  if (facts.type !== PurchaseType.COIL && facts.type !== PurchaseType.FINISHED_GOOD) {
    return 'En esta versión solo se corrigen las líneas de compras de bobinas y de producto terminado';
  }
  if (item.coilStatus === 'IN_THIRD_PARTY') {
    return 'La bobina está en corte tercerizado: recíbela o cancela esa orden primero';
  }
  if (item.coilStatus === 'CANCELLED') return 'La bobina está anulada';
  if (item.mountedOrder !== null) {
    return `La bobina está montada en ${item.mountedOrder}: desmóntala primero`;
  }
  if (item.landedCost) {
    return 'La bobina tiene landed cost aplicado: corregirla recalcularía el flete o la aduana, y eso no entra en esta versión';
  }
  if (item.sharedProduct) {
    return 'Otra línea de la compra entra al mismo producto: esta versión no separa sus ingresos';
  }
  const onlyLaterEntries = item.laterMovements.every((m) => m.type === 'IN');
  if (item.laterMovements.length > 0 && !(replace && onlyLaterEntries)) {
    const detail = item.laterMovements
      .slice(0, 5)
      .map((m) => `${REF_LABELS[m.refType] ?? m.refType} (${m.refType}) el ${m.operationDate}`)
      .join(', ');
    const more =
      item.laterMovements.length > 5 ? ` y ${String(item.laterMovements.length - 5)} más` : '';
    // Con consumo, el costo va por el ajuste proporcional (`adjustBlockedBy`); acá llega solo
    // cuando lo posterior son entradas (otra compra del mismo producto) o cuando cambia kardex.
    return `El ítem tiene movimientos posteriores al ingreso (${detail}${more}): revierte esas operaciones primero o anula la compra`;
  }
  if (reentry && !item.hasLiveIn) {
    return 'La línea no tiene un ingreso de kardex vivo de esta compra: no hay ingreso que corregir';
  }
  if (reentry && item.backsPromised !== null) {
    return replace
      ? `No se puede corregir porque esta bobina respalda material comprometido de ${item.backsPromised}: con la cantidad nueva esa promesa quedaría sin cubrir`
      : `No se puede corregir porque esta bobina respalda material comprometido de ${item.backsPromised}: la reversa del ingreso dejaría esa promesa sin cubrir`;
  }
  // Con o sin precio o cantidad en la misma edición: el servicio solo lo llena cuando la edición
  // cambia color o espesor (autorrevisión de cc15b, P2-1).
  if (item.specPromised !== null) {
    return `No se puede cambiar el color o el espesor porque esta bobina respalda material comprometido de ${item.specPromised}: fuera de ese agregado, la promesa quedaría sin cubrir`;
  }
  if (item.ownReservation && !replace) {
    return reentry
      ? 'El ítem tiene material reservado que la reversa del ingreso dejaría sin cubrir: libera esa reserva primero'
      : 'La bobina tiene una reserva propia: libérala antes de corregir su especificación';
  }
  return null;
}

/**
 * cc15b, punto 3: con el reemplazo, lo reservado sobre el ítem tiene que caber en el saldo
 * **final** (el de hoy, sin lo que entró por esta línea, más la cantidad nueva). La primitiva lo
 * vuelve a comprobar bajo el lock; acá se dice antes.
 */
function finalReservationShort(item: ItemFacts, newQty: string | null): string | null {
  if (newQty !== null && item.runningLow !== null) {
    return `Con la cantidad nueva el kardex quedaría en ${item.runningLow} en alguna fecha posterior (una salida anulada sigue en su fecha): elige una cantidad mayor`;
  }
  const reserved = toDecimal(item.reservedQty);
  if (reserved.lte(0)) return null;
  const finalQty = toDecimal(item.balanceQty)
    .minus(toDecimal(item.qty))
    .plus(toDecimal(newQty ?? item.qty));
  if (finalQty.gte(reserved)) return null;
  return `Con la cantidad nueva quedarían ${toFixedString(finalQty, 'KG')} y hay ${toFixedString(reserved, 'KG')} reservados: libera la reserva o elige una cantidad que la cubra`;
}

/**
 * El ítem ya tuvo **consumo** (una salida o un ajuste de costo después del ingreso): el precio
 * se corrige con el ajuste proporcional de la decisión 3 (cc15), no con reversa.
 */
function consumed(item: ItemFacts): boolean {
  return item.laterMovements.some((m) => m.type !== 'IN');
}

/**
 * Lo que bloquea el ajuste proporcional (decisión 3): lo mismo que cualquier corrección de costo
 * —pagos, tipo de compra, corte tercerizado, bobina anulada o montada, landed cost, producto
 * repetido, sin ingreso vivo, tasa de IGV no estándar—, pero **no** el consumo, que es justamente
 * su caso, ni la reserva, porque no mueve cantidades.
 */
function adjustBlockedBy(facts: PurchaseFacts, item: ItemFacts): string | null {
  const reason = blockedBy(
    facts,
    { ...item, laterMovements: [], ownReservation: false },
    'COST',
    false,
  );
  if (reason !== null) return reason;
  if (!item.hasLiveIn) {
    return 'La línea no tiene un ingreso de kardex vivo de esta compra: no hay ingreso que corregir';
  }
  return facts.igvRateIssue;
}

/** El plan de una edición: cada cambio, su grupo, su camino y, si no se puede, por qué. */
export function classifyReceivedEdit(
  facts: PurchaseFacts,
  input: EditReceivedPurchaseInput,
  targets: TargetFacts,
): ReceivedEditPlanDto {
  const changes: Change[] = [];

  // --- Cáscara ---
  const header = input.header ?? {};
  const current = facts.header;
  const push = (
    group: ReceivedEditGroup,
    field: string,
    label: string,
    lineNumber: number | null,
    before: string | null,
    after: string | null,
    path: ReceivedEditPath,
    blockedReason: string | null,
  ): void => {
    changes.push({ group, field, label, lineNumber, before, after, path, blockedReason });
  };
  const headerPairs: [string, string | null | undefined, string | null][] = [
    ['supplierId', header.supplierId, current.supplierId],
    ['docType', header.docType, current.docType],
    ['series', header.series, current.series],
    ['number', header.number, current.number],
    ['issueDate', header.issueDate, current.issueDate],
    ['paymentTerms', header.paymentTerms, current.paymentTerms],
    [
      'creditDays',
      header.creditDays === undefined
        ? undefined
        : header.creditDays === null
          ? null
          : String(header.creditDays),
      current.creditDays === null ? null : String(current.creditDays),
    ],
    [
      'notes',
      header.notes === undefined ? undefined : header.notes === '' ? null : header.notes,
      current.notes,
    ],
  ];
  for (const [field, next, before] of headerPairs) {
    if (next === undefined || next === before) continue;
    const label = HEADER_LABELS[field] ?? field;
    if (field === 'supplierId') {
      const blocked = facts.livePayments > 0;
      push(
        'SHELL',
        field,
        label,
        null,
        current.supplierLabel,
        next === null ? null : (targets.labels.get(next) ?? next),
        blocked ? 'BLOCKED' : 'IN_PLACE',
        blocked
          ? 'La compra tiene pagos vigentes: el proveedor no se cambia (la deuda es suya)'
          : null,
      );
      continue;
    }
    push('SHELL', field, label, null, before, next, 'IN_PLACE', null);
  }

  // cc15: lo que la condición de pago arrastra, a la vista. Pasar a contado borra los días de
  // crédito, y cualquier cambio de fecha, condición o días recalcula el vencimiento.
  const nextTerms = header.paymentTerms ?? current.paymentTerms;
  // Solo cuando la edición **toca** la condición: el guardado solo borra los días entonces.
  if (
    header.paymentTerms !== undefined &&
    nextTerms !== 'CREDITO' &&
    current.creditDays !== null &&
    header.creditDays === undefined
  ) {
    push(
      'SHELL',
      'creditDays',
      HEADER_LABELS.creditDays ?? 'creditDays',
      null,
      String(current.creditDays),
      null,
      'IN_PLACE',
      null,
    );
  }
  if (
    header.issueDate !== undefined ||
    header.paymentTerms !== undefined ||
    header.creditDays !== undefined
  ) {
    const nextDays =
      nextTerms === 'CREDITO'
        ? header.creditDays !== undefined
          ? header.creditDays
          : current.creditDays
        : null;
    // Al crédito sin días el guardado lo rechaza: la vista previa lo dice antes.
    if (nextTerms === 'CREDITO' && (nextDays === null || nextDays <= 0)) {
      push(
        'SHELL',
        'creditDays',
        HEADER_LABELS.creditDays ?? 'creditDays',
        null,
        current.creditDays === null ? null : String(current.creditDays),
        null,
        'BLOCKED',
        'Una compra al crédito necesita días de crédito',
      );
    }
    const nextDue = dueDateOf(nextTerms, nextDays, header.issueDate ?? current.issueDate);
    if (nextDue !== current.dueDate) {
      push(
        'SHELL',
        'dueDate',
        HEADER_LABELS.dueDate ?? 'dueDate',
        null,
        current.dueDate,
        nextDue,
        'IN_PLACE',
        null,
      );
    }
  }

  // --- Líneas ---
  const byId = new Map(facts.items.map((i) => [i.itemId, i]));
  // El producto con que queda cada línea después de la edición: dos líneas al mismo producto
  // dejarían una compra que ya no se podría volver a editar (`sharedProduct`).
  const finalProduct = new Map(facts.items.map((i) => [i.itemId, i.productId]));
  for (const edit of input.items ?? []) {
    if (edit.productId !== undefined && byId.has(edit.itemId)) {
      finalProduct.set(edit.itemId, edit.productId);
    }
  }
  const productLines = new Map<string, number>();
  for (const p of finalProduct.values()) {
    if (p !== null) productLines.set(p, (productLines.get(p) ?? 0) + 1);
  }
  const seen = new Set<string>();
  for (const edit of input.items ?? []) {
    const item = byId.get(edit.itemId);
    if (seen.has(edit.itemId)) {
      push(
        'KARDEX',
        'itemId',
        'Línea',
        item?.lineNumber ?? null,
        null,
        edit.itemId,
        'BLOCKED',
        'La línea aparece dos veces en la edición',
      );
      continue;
    }
    seen.add(edit.itemId);
    if (!item) {
      push(
        'KARDEX',
        'itemId',
        'Línea',
        null,
        null,
        edit.itemId,
        'BLOCKED',
        'La línea no es de esta compra',
      );
      continue;
    }
    const line = item.lineNumber;
    const label = (field: string): string => ITEM_LABELS[field] ?? field;
    const { qty, unitPrice, productId, finishId, widthMm, thicknessMm } = edit;
    const newQty = qty !== undefined && !sameNumber(qty, item.qty) ? qty : null;
    const newPrice =
      unitPrice !== undefined && !sameNumber(unitPrice, item.unitPrice) ? unitPrice : null;
    const newProduct = productId !== undefined && productId !== item.productId ? productId : null;
    const newFinish = finishId !== undefined && finishId !== item.finishId ? finishId : null;
    const newWidth = widthMm !== undefined && !sameNumber(widthMm, item.widthMm) ? widthMm : null;
    const newThickness =
      thicknessMm !== undefined && !sameNumber(thicknessMm, item.thicknessMm) ? thicknessMm : null;

    // Precio y cantidad revierten y vuelven a ingresar; la especificación de la bobina solo se
    // corrige en la fila. El producto cambia el ítem del kardex: también reversa y reingreso.
    const reentry = newQty !== null || newPrice !== null || newProduct !== null;
    // cc15b: precio o cantidad sobre el mismo ítem van por `replaceEntry` (reservas y materia
    // prima al final; otras entradas posteriores no bloquean). Un cambio de producto mueve el
    // ingreso a otro ítem y sigue siendo reversa + ingreso nuevo, con sus bloqueos de siempre.
    const replace = reentry && newProduct === null;
    const pathOf = (reason: string | null, inPlace = false): ReceivedEditPath =>
      reason !== null ? 'BLOCKED' : inPlace ? 'IN_PLACE' : 'REVERSE_REENTRY';
    // Precio o cantidad recalculan los importes de la línea con la tasa deducida (D-371).
    const amountsReason = (reason: string | null): string | null => reason ?? facts.igvRateIssue;

    if (newPrice !== null && newQty === null && newProduct === null && consumed(item)) {
      // Decisión 3 (cc15): con consumo, el precio se corrige con un ajuste proporcional sobre lo
      // que queda de la compra. El servicio completa el monto y las salidas afectadas.
      const reason = adjustBlockedBy(facts, item);
      push(
        'COST',
        'unitPrice',
        label('unitPrice'),
        line,
        toFixedString(item.unitPrice, 'MONEY'),
        toFixedString(newPrice, 'MONEY'),
        reason === null ? 'COST_ADJUST' : 'BLOCKED',
        reason,
      );
    } else if (newPrice !== null) {
      // Un precio que viaja con una cantidad o un producto nuevos es parte de esa misma
      // reversa: el mensaje que vale es el de kardex.
      const reason = amountsReason(
        blockedBy(
          facts,
          item,
          newQty !== null || newProduct !== null ? 'KARDEX' : 'COST',
          true,
          replace,
        ) ?? (replace ? finalReservationShort(item, newQty) : null),
      );
      push(
        'COST',
        'unitPrice',
        label('unitPrice'),
        line,
        toFixedString(item.unitPrice, 'MONEY'),
        toFixedString(newPrice, 'MONEY'),
        pathOf(reason),
        reason,
      );
    }
    if (newQty !== null) {
      const reason = amountsReason(
        blockedBy(facts, item, 'KARDEX', true, replace) ??
          (replace ? finalReservationShort(item, newQty) : null),
      );
      push(
        'KARDEX',
        'qty',
        label('qty'),
        line,
        toFixedString(item.qty, 'KG'),
        toFixedString(newQty, 'KG'),
        pathOf(reason),
        reason,
      );
    }
    if (newProduct !== null) {
      let reason =
        facts.type === PurchaseType.FINISHED_GOOD
          ? blockedBy(facts, item, 'KARDEX', true)
          : 'Solo una compra de producto terminado cambia de producto';
      reason ??= targets.invalidProducts.get(newProduct) ?? null;
      if (reason === null && (productLines.get(newProduct) ?? 0) > 1) {
        reason =
          'La compra quedaría con el mismo producto en dos líneas: esta versión no separa sus ingresos';
      }
      if (reason === null && targets.productsWithLaterMovements.has(newProduct)) {
        reason =
          'El producto nuevo ya tiene movimientos posteriores a la fecha de recepción: su ingreso cambiaría su historia';
      }
      push(
        'KARDEX',
        'productId',
        label('productId'),
        line,
        item.productLabel,
        targets.labels.get(newProduct) ?? newProduct,
        pathOf(reason),
        reason,
      );
      // Decisión D (cc15): la descripción de la línea pasa a ser el nombre del producto nuevo.
      const name = targets.productNames.get(newProduct);
      if (name !== undefined && name !== item.description) {
        push(
          'SHELL',
          'description',
          'Descripción',
          line,
          item.description,
          name,
          reason === null ? 'IN_PLACE' : 'BLOCKED',
          reason,
        );
      }
    }
    const specChanges: [string, string | null, string][] = [];
    if (newFinish !== null) {
      specChanges.push(['finishId', item.finishLabel, targets.labels.get(newFinish) ?? newFinish]);
    }
    if (newWidth !== null)
      specChanges.push(['widthMm', item.widthMm, toFixedString(newWidth, 'MM')]);
    if (newThickness !== null) {
      specChanges.push(['thicknessMm', item.thicknessMm, toFixedString(newThickness, 'MM')]);
    }
    for (const [field, before, after] of specChanges) {
      let reason =
        facts.type === PurchaseType.COIL
          ? blockedBy(facts, item, 'KARDEX', reentry)
          : 'Solo una compra de bobinas tiene especificación de bobina';
      if (reason === null && field === 'finishId' && newFinish !== null) {
        reason = targets.invalidFinishes.get(newFinish) ?? null;
      }
      push('KARDEX', field, label(field), line, before, after, pathOf(reason, !reentry), reason);
    }
  }

  return {
    purchaseId: facts.purchaseId,
    changes,
    executable: changes.length > 0 && changes.every((c) => c.path !== 'BLOCKED'),
  };
}

/**
 * Decisión A (cc15): cuánto queda de **un lote** (el ingreso de una compra) en un saldo que
 * mezcla varias compras, y qué salidas se lo llevaron, en orden de llegada (PEPS).
 *
 * Recibe los movimientos **vivos** del ítem (sin pares revertidos) ya ordenados como el kardex
 * (fecha de operación, instante de grabación, id). Cada entrada abre una capa; cada salida
 * consume las más antiguas primero; los ajustes no mueven cantidad. Una salida sin capas
 * suficientes (un dato viejo retrofechado) consume lo que hay y el resto se ignora.
 */
export function fifoLotConsumption<
  T extends { id: bigint; type: 'IN' | 'OUT' | 'ADJUST'; qty: { toString(): string } },
>(
  movements: T[],
  lotId: bigint,
): { remaining: Decimal; consumers: { movement: T; qty: Decimal }[] } {
  const layers: { id: bigint; qty: Decimal }[] = [];
  const consumers: { movement: T; qty: Decimal }[] = [];
  for (const m of movements) {
    const qty = toDecimal(m.qty.toString());
    if (m.type === 'IN') {
      layers.push({ id: m.id, qty });
      continue;
    }
    if (m.type !== 'OUT') continue;
    let pending = qty;
    while (pending.gt(0) && layers.length > 0) {
      const head = layers[0];
      if (!head) break;
      const take = Decimal.min(head.qty, pending);
      if (head.id === lotId && take.gt(0)) consumers.push({ movement: m, qty: take });
      head.qty = head.qty.minus(take);
      pending = pending.minus(take);
      if (head.qty.lte(0)) layers.shift();
    }
  }
  const lot = layers.find((l) => l.id === lotId);
  return { remaining: lot ? lot.qty : new Decimal(0), consumers };
}

/** Los motivos de bloqueo de un plan, para el mensaje de un intento de guardar igual. */
export function blockedSummary(plan: ReceivedEditPlanDto): string {
  return plan.changes
    .filter((c) => c.path === 'BLOCKED')
    .map(
      (c) =>
        `${c.lineNumber === null ? '' : `Línea ${String(c.lineNumber)} · `}${c.label}: ${c.blockedReason ?? ''}`,
    )
    .join(' · ');
}
