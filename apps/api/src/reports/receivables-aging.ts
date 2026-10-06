import {
  AGING_BUCKETS,
  agingBucket,
  daysOverdue,
  Decimal,
  salesOrderCode,
  toFixedString,
  type AgingBucket,
  type AgingBucketAmounts,
  type ReceivablesAgingCustomerDto,
  type ReceivablesAgingDocumentDto,
  type ReceivablesAgingDto,
} from '@ayr/shared';
import { documentOwnerId, type CollectibleDocument } from '../invoicing/collectible-documents';

/**
 * cc25 (D-421..D-423, D-428, D-432). Arma el reporte de cuentas por cobrar por antigüedad sobre
 * los comprobantes con saldo que ya leyó `loadCollectibleDocuments` — la lectura de cobranzas.
 * Función pura: no consulta nada, así que el cuadre con cobranzas se prueba sin base.
 *
 * Los saldos no se recalculan ni se redondean acá: se suman tal como los dejó la lectura
 * compartida (cuatro decimales).
 */
export function assembleReceivablesAging(input: {
  collectible: readonly CollectibleDocument[];
  sellerNames: ReadonlyMap<string, string>;
  sellerId: string | null;
  today: string;
}): ReceivablesAgingDto {
  const { collectible, sellerNames, sellerId, today } = input;

  // Las opciones del filtro salen del conjunto sin filtrar: elegir un vendedor no hace
  // desaparecer a los demás de la lista.
  const sellerIds = new Set(collectible.map((c) => documentOwnerId(c.document)));
  const sellers = [...sellerIds]
    .map((id) => ({ id, name: sellerNameOf(sellerNames, id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const byCustomer = new Map<string, ReceivableCustomerAcc>();
  const totals = emptyBuckets();
  let totalBalance = new Decimal(0);
  let documentCount = 0;

  for (const c of collectible) {
    const doc = c.document;
    const ownerId = documentOwnerId(doc);
    if (sellerId !== null && ownerId !== sellerId) continue;

    const dueDate = doc.dueDate ? isoDate(doc.dueDate) : null;
    // D-428: al contado vence el día de la emisión.
    const agingDate = dueDate ?? isoDate(doc.issueDate);
    const days = daysOverdue(agingDate, today);
    const bucket = agingBucket(days);
    const order = doc.salesOrder ?? doc.dispatch?.salesOrder ?? null;

    const row: ReceivablesAgingDocumentDto = {
      id: doc.id,
      docType: doc.docType,
      number: doc.number,
      issueDate: isoDate(doc.issueDate),
      paymentTerms: doc.paymentTerms,
      dueDate,
      agingDate,
      daysOverdue: days,
      bucket,
      totalPen: toFixedString(doc.totalPen.toString(), 'MONEY'),
      paidPen: toFixedString(c.paid, 'MONEY'),
      creditedPen: toFixedString(c.credited, 'MONEY'),
      balancePen: toFixedString(c.balance, 'MONEY'),
      salesOrderId: order?.id ?? null,
      salesOrderCode: order ? salesOrderCode(order.seq) : null,
      sellerId: ownerId,
      sellerName: sellerNameOf(sellerNames, ownerId),
    };

    const acc = byCustomer.get(doc.customerId) ?? {
      customerId: doc.customer.id,
      customerName: doc.customer.name,
      customerDocNumber: doc.customer.docNumber,
      documents: [],
      balance: new Decimal(0),
      buckets: emptyBuckets(),
    };
    acc.documents.push(row);
    acc.balance = acc.balance.plus(c.balance);
    acc.buckets[bucket] = acc.buckets[bucket].plus(c.balance);
    byCustomer.set(doc.customerId, acc);

    totals[bucket] = totals[bucket].plus(c.balance);
    totalBalance = totalBalance.plus(c.balance);
    documentCount += 1;
  }

  const customers: ReceivablesAgingCustomerDto[] = [...byCustomer.values()]
    .map((acc) => ({
      customerId: acc.customerId,
      customerName: acc.customerName,
      customerDocNumber: acc.customerDocNumber,
      documentCount: acc.documents.length,
      balancePen: toFixedString(acc.balance, 'MONEY'),
      buckets: bucketStrings(acc.buckets),
      documents: acc.documents.sort(
        (a, b) => b.daysOverdue - a.daysOverdue || (a.number ?? '').localeCompare(b.number ?? ''),
      ),
      sortKey: acc.balance,
    }))
    // De mayor a menor saldo, como cobranzas; a igual saldo, por nombre para que no salte.
    .sort((a, b) => b.sortKey.cmp(a.sortKey) || a.customerName.localeCompare(b.customerName, 'es'))
    .map(({ sortKey: _sortKey, ...dto }) => dto);

  return {
    asOf: today,
    sellerId,
    sellers,
    customers,
    totals: {
      balancePen: toFixedString(totalBalance, 'MONEY'),
      buckets: bucketStrings(totals),
      documentCount,
      customerCount: customers.length,
    },
  };
}

interface ReceivableCustomerAcc {
  customerId: string;
  customerName: string;
  customerDocNumber: string;
  documents: ReceivablesAgingDocumentDto[];
  balance: Decimal;
  buckets: Record<AgingBucket, Decimal>;
}

function emptyBuckets(): Record<AgingBucket, Decimal> {
  return {
    CURRENT: new Decimal(0),
    D1_30: new Decimal(0),
    D31_60: new Decimal(0),
    D61_90: new Decimal(0),
    OVER_90: new Decimal(0),
  };
}

function bucketStrings(b: Record<AgingBucket, Decimal>): AgingBucketAmounts {
  const out = {} as AgingBucketAmounts;
  for (const key of AGING_BUCKETS) out[key] = toFixedString(b[key], 'MONEY');
  return out;
}

/** Una columna `@db.Date` llega como medianoche UTC: su parte de fecha es el día guardado. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** El mismo nombre en el filtro y en el detalle, aunque el usuario no aparezca. */
function sellerNameOf(names: ReadonlyMap<string, string>, id: string): string {
  return names.get(id) ?? 'Usuario sin nombre';
}
