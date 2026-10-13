import { productionOrderCode, salesOrderCode } from '@ayr/shared';
import type { AuditEntry } from './audit.service';

/**
 * cc50 (D-638): los registros que ponen en el «Historial» de un documento lo que otro documento le
 * hizo (el pago a la compra, el flete a la compra de bobinas, la factura a la orden de corte, el
 * pedido a sus OP). Funciones puras: cada servicio las escribe con `audit.write(tx, …)` dentro de
 * la transacción de su operación. Los montos llegan ya formateados (`toFixed`), como el resto de
 * la auditoría.
 */

interface PurchaseRef {
  id: string;
  series: string;
  number: string;
}

const documentOf = (p: { series: string; number: string }) => `${p.series}-${p.number}`;

export interface PaymentRef {
  id: string;
  /** Con 4 decimales, en la moneda del pago. */
  amount: string;
  currency: string;
  method: string;
}

/** Pago a proveedor: en la compra, con el pago y el proveedor en el detalle. */
export function paymentAuditEntry(
  actorId: string,
  purchase: PurchaseRef & { supplierId: string },
  payment: PaymentRef,
  operationDate: string,
): AuditEntry {
  return {
    actorId,
    action: 'purchases.payment',
    entity: 'purchases',
    entityId: purchase.id,
    after: {
      paymentId: payment.id,
      supplierId: purchase.supplierId,
      document: documentOf(purchase),
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      // D-124: con qué fecha de negocio quedó registrado el pago.
      operationDate,
    },
  };
}

/** Reversa del pago: también en la compra, con el motivo. */
export function paymentReverseAuditEntry(
  actorId: string,
  purchase: PurchaseRef & { supplierId: string },
  payment: PaymentRef,
  reason: string,
): AuditEntry {
  return {
    actorId,
    action: 'purchases.payment-reverse',
    entity: 'purchases',
    entityId: purchase.id,
    before: {
      paymentId: payment.id,
      supplierId: purchase.supplierId,
      document: documentOf(purchase),
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
    },
    after: { reason },
  };
}

interface ServiceRef extends PurchaseRef {
  serviceKind: string | null;
}

/**
 * Costo de importación: en la compra de bobinas que lo recibe. La compra del servicio ya lo dice en
 * su «Recepción de compra» (`landedCost`).
 */
export function landedCostAuditEntry(
  actorId: string,
  related: PurchaseRef,
  service: ServiceRef,
  imputed: { amountPen: string; coils: number; operationDate: string },
): AuditEntry {
  return {
    actorId,
    action: 'purchases.landed-cost',
    entity: 'purchases',
    entityId: related.id,
    after: {
      document: documentOf(related),
      servicePurchaseId: service.id,
      serviceDocument: documentOf(service),
      serviceKind: service.serviceKind,
      amountPen: imputed.amountPen,
      coils: imputed.coils,
      operationDate: imputed.operationDate,
    },
  };
}

/** Anular el servicio deshace su costo: la compra de bobinas lo dice también. */
export function landedCostReverseAuditEntry(
  actorId: string,
  relatedPurchaseId: string,
  service: ServiceRef,
  reversed: { amountPen: string; coils: number },
  reason: string,
): AuditEntry {
  return {
    actorId,
    action: 'purchases.landed-cost-reverse',
    entity: 'purchases',
    entityId: relatedPurchaseId,
    before: { amountPen: reversed.amountPen, coils: reversed.coils },
    after: {
      servicePurchaseId: service.id,
      serviceDocument: documentOf(service),
      serviceKind: service.serviceKind,
    },
    reason,
  };
}

/** La factura de un corte tercerizado, en la orden de corte, al vincularla. */
export function cuttingInvoiceAuditEntry(
  actorId: string,
  cuttingOrderId: string,
  invoice: PurchaseRef & { supplierId: string; subtotal: string; currency: string },
): AuditEntry {
  return {
    actorId,
    action: 'cutting.invoice-linked',
    entity: 'cutting_orders',
    entityId: cuttingOrderId,
    after: {
      purchaseId: invoice.id,
      document: documentOf(invoice),
      supplierId: invoice.supplierId,
      subtotal: invoice.subtotal,
      currency: invoice.currency,
    },
  };
}

interface OrderOpRef {
  id: string;
  seq: number;
}

/** Una OP que la anulación del pedido arrastra. */
export function productionCancelledBySalesOrderEntry(
  actorId: string,
  op: OrderOpRef & { status: string },
  salesOrder: { id: string; code: string },
  reason: string,
): AuditEntry {
  return {
    actorId,
    action: 'production.cancel-by-sales-order',
    entity: 'production_orders',
    entityId: op.id,
    before: { code: productionOrderCode(op.seq), status: op.status },
    after: { status: 'CANCELLED', salesOrderId: salesOrder.id, salesOrder: salesOrder.code },
    reason,
  };
}

/** El plan de la OP que sigue al cambio de cantidad de su línea. */
export function productionPlanBySalesOrderEntry(
  actorId: string,
  op: OrderOpRef & { planMeters: string },
  line: { salesOrderId: string; salesOrderSeq: number; lineNumber: number },
  planMetersAfter: string,
  reason: string | undefined,
): AuditEntry {
  return {
    actorId,
    action: 'production.plan-by-sales-order',
    entity: 'production_orders',
    entityId: op.id,
    before: { code: productionOrderCode(op.seq), planMeters: op.planMeters },
    after: {
      planMeters: planMetersAfter,
      salesOrderId: line.salesOrderId,
      salesOrder: salesOrderCode(line.salesOrderSeq),
      lineNumber: line.lineNumber,
    },
    ...(reason !== undefined ? { reason } : {}),
  };
}
