import { PurchaseType } from '@prisma/client';
import {
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
  refType: string;
  operationDate: string;
}

/** Lo que el servicio sabe de una línea antes de clasificar. */
export interface ItemFacts {
  itemId: string;
  lineNumber: number;
  /** Producto (FINISHED_GOOD) o `null`. */
  productId: string | null;
  productLabel: string | null;
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
};

/** Igualdad de importes y medidas por valor, no por texto ("10" = "10.0000"). */
function sameNumber(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return toDecimal(a).equals(toDecimal(b));
}

function blockedBy(
  facts: PurchaseFacts,
  item: ItemFacts,
  group: ReceivedEditGroup,
  reentry: boolean,
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
  if (item.laterMovements.length > 0) {
    const detail = item.laterMovements
      .slice(0, 5)
      .map((m) => `${REF_LABELS[m.refType] ?? m.refType} (${m.refType}) el ${m.operationDate}`)
      .join(', ');
    const more =
      item.laterMovements.length > 5 ? ` y ${String(item.laterMovements.length - 5)} más` : '';
    return group === 'COST'
      ? `El ítem ya tuvo consumo después del ingreso (${detail}${more}): corregir el costo con consumo posterior estará disponible en la próxima versión`
      : `El ítem tiene movimientos posteriores al ingreso (${detail}${more}): revierte esas operaciones primero o anula la compra`;
  }
  if (reentry && !item.hasLiveIn) {
    return 'La línea no tiene un ingreso de kardex vivo de esta compra: no hay ingreso que corregir';
  }
  if (item.ownReservation) {
    return reentry
      ? 'El ítem tiene material reservado que la reversa del ingreso dejaría sin cubrir: libera esa reserva primero'
      : 'La bobina tiene una reserva propia: libérala antes de corregir su especificación';
  }
  return null;
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
    const pathOf = (reason: string | null, inPlace = false): ReceivedEditPath =>
      reason !== null ? 'BLOCKED' : inPlace ? 'IN_PLACE' : 'REVERSE_REENTRY';
    // Precio o cantidad recalculan los importes de la línea con la tasa deducida (D-371).
    const amountsReason = (reason: string | null): string | null => reason ?? facts.igvRateIssue;

    if (newPrice !== null) {
      // Un precio que viaja con una cantidad o un producto nuevos es parte de esa misma
      // reversa: el mensaje que vale es el de kardex.
      const reason = amountsReason(
        blockedBy(facts, item, newQty !== null || newProduct !== null ? 'KARDEX' : 'COST', true),
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
      const reason = amountsReason(blockedBy(facts, item, 'KARDEX', true));
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
