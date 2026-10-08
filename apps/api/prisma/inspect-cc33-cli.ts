/**
 * cc33 — diagnóstico histórico de los hallazgos de la auditoría externa (N1..N5, ceros a la
 * izquierda). **Solo lectura**: una transacción `READ ONLY`, sin modo execute y sin reparar nada.
 * Imprime un JSON en stdout (para guardarlo en `local-data/cc33/diagnostico/`) y un resumen en
 * stderr.
 *
 * Conjuntos:
 * 1. Compras en soles con TC ≠ 1, sus bobinas, sus entradas al kardex y sus pagos.
 * 2. Comprobantes que un VENDEDOR creó sobre el pedido de otro vendedor.
 * 3. Comprobantes con pedido anulado o de otro cliente.
 * 4. Notas de crédito (vivas y en borrador) cuya factura está anulada, dada de baja, rechazada o
 *    archivada.
 * 5. Compras vivas cuyo número, sin ceros a la izquierda, choca con otra viva del mismo proveedor.
 * 6. Fechas de compra o de pago que no coinciden con lo que se escribió, donde la auditoría lo
 *    guarda.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import { assertExecuteAllowed } from './cli-gate';
import { assertExternalOutputsOff } from '../src/common/external-outputs';

type Tx = Prisma.TransactionClient;

const day = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
const dec = (v: Prisma.Decimal | null | undefined): Decimal =>
  v === null || v === undefined ? new Decimal(0) : toDecimal(v.toString());
const fmt = (d: Decimal): string => d.toFixed(2);

/** Una fecha `YYYY-MM-DD` que existe en el calendario (mismo criterio que `operationDateSchema`). */
function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}

/** El número de compra sin ceros a la izquierda (`'00012'` → `'12'`; `'000'` → `'0'`). */
function stripZeros(n: string): string {
  const s = n.replace(/^0+/, '');
  return s === '' ? '0' : s;
}

async function penWithRate(tx: Tx) {
  const purchases = await tx.purchase.findMany({
    where: { currency: 'PEN', NOT: { exchangeRate: new Prisma.Decimal(1) } },
    include: {
      supplier: { select: { name: true } },
      coils: {
        select: { id: true, code: true, totalCost: true, totalCostPen: true, status: true },
      },
      payments: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const ids = purchases.map((p) => p.id);
  const movements = ids.length
    ? await tx.inventoryMovement.findMany({
        where: { refType: 'PURCHASE', refId: { in: ids } },
        select: { refId: true, type: true, totalCost: true },
      })
    : [];
  let totalOverPen = new Decimal(0);
  let kardexOverPen = new Decimal(0);
  const rows = purchases.map((p) => {
    const rate = dec(p.exchangeRate);
    const totalPenOver = dec(p.totalPen).minus(dec(p.total));
    // Solo las recibidas pesan en saldos y reportes: un borrador no tocó el kardex y una anulada
    // dejó de contar. Los borradores se cuentan aparte (son los que la guarda de D-534 frena).
    if (p.status === 'RECEIVED') totalOverPen = totalOverPen.plus(totalPenOver);
    const own = movements.filter((m) => m.refId === p.id);
    // Neto de la compra (entradas menos reversas): un reemplazo o una anulación no cuentan doble.
    const kardexIn = own.reduce(
      (a, m) => (m.type === 'OUT' ? a.minus(dec(m.totalCost)) : a.plus(dec(m.totalCost))),
      new Decimal(0),
    );
    // Lo que entró al kardex ya multiplicado por el TC: el exceso es (1 − 1/TC) de esa cifra.
    const kardexOver = rate.isZero() ? new Decimal(0) : kardexIn.minus(kardexIn.div(rate));
    kardexOverPen = kardexOverPen.plus(kardexOver);
    return {
      id: p.id,
      document: `${p.series}-${p.number}`,
      supplier: p.supplier.name,
      status: p.status,
      issueDate: day(p.issueDate),
      exchangeRate: p.exchangeRate.toFixed(4),
      exchangeRateSource: p.exchangeRateSource,
      total: fmt(dec(p.total)),
      totalPen: fmt(dec(p.totalPen)),
      totalPenOver: fmt(totalPenOver),
      kardexInPen: fmt(kardexIn),
      kardexOverPen: fmt(kardexOver),
      coils: p.coils.map((c) => ({
        code: c.code,
        status: c.status,
        totalCost: fmt(dec(c.totalCost)),
        totalCostPen: fmt(dec(c.totalCostPen)),
      })),
      payments: p.payments.map((pay) => ({
        date: day(pay.date),
        amount: fmt(dec(pay.amount)),
        currency: pay.currency,
        exchangeRate: pay.exchangeRate.toFixed(4),
        reversed: pay.reversedAt !== null,
      })),
    };
  });
  // Pagos en soles de compras en soles con TC ≠ 1 (el mismo patrón en el pago, aunque la compra
  // tenga TC 1): no cambian el saldo (misma moneda) pero dejan un TC falso registrado.
  const penPayments = await tx.supplierPayment.findMany({
    where: {
      currency: 'PEN',
      purchase: { currency: 'PEN' },
      NOT: { exchangeRate: new Prisma.Decimal(1) },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      exchangeRate: true,
      reversedAt: true,
      purchase: { select: { series: true, number: true } },
    },
  });
  return {
    count: rows.length,
    byStatus: Object.fromEntries(
      ['DRAFT', 'RECEIVED', 'CANCELLED'].map((st) => [
        st,
        rows.filter((r) => r.status === st).length,
      ]),
    ),
    coilCount: rows.reduce((a, r) => a + r.coils.length, 0),
    note: 'kardexOverstatedPen es lo que entró de más al kardex (tope del impacto), no lo que sigue en stock; las bobinas hijas de un partido heredan coil.exchangeRate y no se listan aparte.',
    totalPenOverstatedPen: fmt(totalOverPen),
    kardexOverstatedPen: fmt(kardexOverPen),
    purchases: rows,
    penPaymentsWithRate: {
      count: penPayments.length,
      payments: penPayments.map((p) => ({
        id: p.id,
        purchase: `${p.purchase.series}-${p.purchase.number}`,
        date: day(p.date),
        amount: fmt(dec(p.amount)),
        exchangeRate: p.exchangeRate.toFixed(4),
        reversed: p.reversedAt !== null,
      })),
    },
  };
}

async function invoiceScope(tx: Tx) {
  const docs = await tx.fiscalDocument.findMany({
    where: { salesOrderId: { not: null } },
    select: {
      id: true,
      docType: true,
      status: true,
      origin: true,
      number: true,
      seriesRef: { select: { series: true } },
      correlative: true,
      customerId: true,
      createdById: true,
      totalPen: true,
      issueDate: true,
      archivedAt: true,
      createdAt: true,
      customer: { select: { name: true } },
      salesOrder: {
        select: {
          seq: true,
          status: true,
          customerId: true,
          sellerId: true,
          cancelledAt: true,
          customer: { select: { name: true } },
        },
      },
    },
  });
  const users = await tx.user.findMany({ select: { id: true, role: true, name: true } });
  const userById = new Map(users.map((u) => [u.id, u]));
  const label = (d: (typeof docs)[number]) =>
    d.number ?? `${d.seriesRef?.series ?? '?'}-${d.correlative ?? '?'}`;

  const foreignSeller = docs
    .filter((d) => {
      const creator = userById.get(d.createdById);
      return (
        creator?.role === 'VENDEDOR' &&
        d.salesOrder !== null &&
        d.salesOrder.sellerId !== d.createdById
      );
    })
    .map((d) => ({
      id: d.id,
      document: label(d),
      docType: d.docType,
      status: d.status,
      createdBy: userById.get(d.createdById)?.name ?? d.createdById,
      orderSeq: d.salesOrder?.seq,
      orderSeller: d.salesOrder?.sellerId
        ? (userById.get(d.salesOrder.sellerId)?.name ?? d.salesOrder.sellerId)
        : null,
      totalPen: fmt(dec(d.totalPen)),
      createdAt: d.createdAt.toISOString(),
    }));

  const badOrder = docs
    .filter(
      (d) =>
        d.salesOrder !== null &&
        (d.salesOrder.status === 'CANCELLED' || d.salesOrder.customerId !== d.customerId),
    )
    .map((d) => ({
      id: d.id,
      document: label(d),
      docType: d.docType,
      status: d.status,
      origin: d.origin,
      archived: d.archivedAt !== null,
      reason: [
        d.salesOrder?.status === 'CANCELLED' ? 'pedido anulado' : null,
        d.salesOrder?.customerId !== d.customerId ? 'pedido de otro cliente' : null,
      ]
        .filter(Boolean)
        .join(' y '),
      customer: d.customer.name,
      orderSeq: d.salesOrder?.seq,
      orderCustomer: d.salesOrder?.customer.name,
      orderCancelledAt: d.salesOrder?.cancelledAt?.toISOString() ?? null,
      docCreatedAt: d.createdAt.toISOString(),
      totalPen: fmt(dec(d.totalPen)),
    }));
  // Un comprobante que se dio de baja (o se anuló) y después se anuló su pedido es el camino
  // normal; lo que interesa es el comprobante que sigue vivo sobre un pedido anulado o ajeno.
  const DEAD = new Set(['VOIDED', 'ANNULLED', 'REJECTED']);
  const badOrderLive = badOrder.filter((d) => !DEAD.has(d.status) && !d.archived);
  return {
    foreignSeller: {
      count: foreignSeller.length,
      totalPen: fmt(foreignSeller.reduce((a, d) => a.plus(d.totalPen), new Decimal(0))),
      documents: foreignSeller,
    },
    badOrder: {
      count: badOrder.length,
      liveCount: badOrderLive.length,
      liveTotalPen: fmt(badOrderLive.reduce((a, d) => a.plus(d.totalPen), new Decimal(0))),
      documents: badOrder,
    },
  };
}

async function creditNotesOnDeadInvoices(tx: Tx) {
  const notes = await tx.fiscalDocument.findMany({
    where: { docType: 'NOTA_CREDITO', affectedDocumentId: { not: null } },
    select: {
      id: true,
      status: true,
      origin: true,
      number: true,
      seriesRef: { select: { series: true } },
      correlative: true,
      totalPen: true,
      archivedAt: true,
      createdAt: true,
      affectedDocument: {
        select: {
          id: true,
          number: true,
          docType: true,
          status: true,
          origin: true,
          archivedAt: true,
          voidedAt: true,
          annulledAt: true,
          totalPen: true,
        },
      },
    },
  });
  const BAD = new Set(['VOIDED', 'VOID_PENDING', 'ANNULLED', 'REJECTED']);
  const hits = notes
    .filter(
      (n) =>
        n.affectedDocument !== null &&
        (BAD.has(n.affectedDocument.status) || n.affectedDocument.archivedAt !== null),
    )
    .map((n) => ({
      id: n.id,
      note: n.number ?? `${n.seriesRef?.series ?? '?'}-${n.correlative ?? '(borrador)'}`,
      noteStatus: n.status,
      noteOrigin: n.origin,
      noteArchived: n.archivedAt !== null,
      noteTotalPen: fmt(dec(n.totalPen)),
      affected: n.affectedDocument?.number ?? n.affectedDocument?.id,
      affectedStatus: n.affectedDocument?.status,
      affectedArchived: n.affectedDocument?.archivedAt !== null,
      noteCreatedAt: n.createdAt.toISOString(),
    }));
  const DEAD_NOTE = new Set(['VOIDED', 'ANNULLED', 'REJECTED']);
  const drafts = hits.filter((h) => h.noteStatus === 'DRAFT');
  const live = hits.filter(
    (h) => h.noteStatus !== 'DRAFT' && !DEAD_NOTE.has(h.noteStatus) && !h.noteArchived,
  );
  const sum = (xs: typeof hits) => fmt(xs.reduce((a, h) => a.plus(h.noteTotalPen), new Decimal(0)));
  return {
    liveCount: live.length,
    liveTotalPen: sum(live),
    draftCount: drafts.length,
    draftTotalPen: sum(drafts),
    otherCount: hits.length - live.length - drafts.length,
    notes: hits,
  };
}

async function leadingZeroCollisions(tx: Tx) {
  const live = await tx.purchase.findMany({
    where: { status: { not: 'CANCELLED' } },
    select: {
      id: true,
      supplierId: true,
      docType: true,
      series: true,
      number: true,
      status: true,
      total: true,
      totalPen: true,
      currency: true,
      supplier: { select: { name: true } },
    },
  });
  const groups = new Map<string, typeof live>();
  for (const p of live) {
    const key = [p.supplierId, p.docType, p.series.toUpperCase(), stripZeros(p.number)].join('|');
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const collisions = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      supplier: g[0]?.supplier.name,
      normalized: `${g[0]?.series}-${stripZeros(g[0]?.number ?? '')}`,
      purchases: g.map((p) => ({
        id: p.id,
        document: `${p.series}-${p.number}`,
        docType: p.docType,
        status: p.status,
        total: fmt(dec(p.total)),
        currency: p.currency,
        totalPen: fmt(dec(p.totalPen)),
      })),
    }));
  const withZeros = live.filter((p) => stripZeros(p.number) !== p.number).length;
  // B8: números que el formato nuevo (letras, dígitos, guion y barra, hasta 20) rechazaría.
  const badFormat = live
    .filter((p) => !/^[A-Z0-9/-]{1,20}$/.test(p.number))
    .map((p) => ({ id: p.id, document: `${p.series}-${p.number}` }));
  return {
    livePurchases: live.length,
    withLeadingZeros: withZeros,
    collisionGroups: collisions.length,
    collisions,
    numbersOutsideNewFormat: badFormat,
  };
}

async function datesVersusAudit(tx: Tx) {
  // Pagos: la auditoría `purchases.payment` guarda la fecha de operación ya resuelta
  // (`after.operationDate`, D-124), que es el texto del body una vez validado: lo que se compara es
  // ese texto contra la columna `date`. Un día inexistente que el schema dejó pasar aparece acá.
  const paymentAudits = await tx.auditLog.findMany({
    where: { action: 'purchases.payment', entity: 'supplier_payments' },
    select: { entityId: true, after: true, at: true },
  });
  const paymentIds = paymentAudits.map((a) => a.entityId).filter((x): x is string => !!x);
  const payments = await tx.supplierPayment.findMany({
    where: { id: { in: paymentIds } },
    select: { id: true, date: true, purchase: { select: { series: true, number: true } } },
  });
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const paymentMismatches = paymentAudits
    .map((a) => {
      const typed = (a.after as { operationDate?: string } | null)?.operationDate;
      const p = a.entityId ? paymentById.get(a.entityId) : undefined;
      if (!typed || !p) return null;
      const stored = day(p.date);
      if (typed === stored && isCalendarDate(typed)) return null;
      return {
        paymentId: p.id,
        purchase: `${p.purchase.series}-${p.purchase.number}`,
        typed,
        stored,
        at: a.at.toISOString(),
      };
    })
    .filter(Boolean);

  // Edición de compra recibida: `before/after.changes` guarda cada campo con su valor.
  const editAudits = await tx.auditLog.findMany({
    where: { action: 'purchases.update-received', entity: 'purchases' },
    select: { entityId: true, after: true, at: true },
  });
  const editDateIssues = editAudits.flatMap((a) => {
    const changes =
      (a.after as { changes?: { field?: string; value?: unknown }[] } | null)?.changes ?? [];
    return changes
      .filter(
        (c) =>
          typeof c.field === 'string' &&
          /date/i.test(c.field) &&
          typeof c.value === 'string' &&
          !isCalendarDate(c.value),
      )
      .map((c) => ({ purchaseId: a.entityId, field: c.field, value: c.value, at: a.at }));
  });

  // Importador: la auditoría del lote guarda las filas tal como llegaron.
  const importAudits = await tx.auditLog.findMany({
    where: { action: 'imports.purchases' },
    select: { entityId: true, after: true, at: true },
  });
  const importDateIssues: { batch: string | null; value: string }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (/date/i.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          if (!isCalendarDate(v)) importDateIssues.push({ batch: null, value: v });
        } else walk(v);
      }
    }
  };
  for (const a of importAudits) walk(a.after);

  // Alta de compra: `purchases.create` no guarda la fecha de emisión, así que lo escrito no se
  // puede comparar con lo guardado.
  return {
    payments: {
      audited: paymentAudits.length,
      mismatches: paymentMismatches.length,
      examples: paymentMismatches.slice(0, 20),
    },
    receivedEdits: { audited: editAudits.length, invalidDates: editDateIssues },
    imports: {
      audited: importAudits.length,
      invalidDates: importDateIssues,
      note: 'Se buscan claves *date* con valor YYYY-MM-DD inexistente en el JSON de la auditoría del lote.',
    },
    purchaseCreate: {
      detectable: false,
      note: 'purchases.create no guarda la fecha de emisión escrita: no se puede comparar con lo guardado.',
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    throw new Error(`Este subcomando es solo lectura y no acepta argumentos: ${args[0] ?? ''}`);
  }
  assertExecuteAllowed(false);
  assertExternalOutputsOff(process.env, (line) => {
    console.error(line);
  });
  const branch = process.env.AYR_CLI_BRANCH;
  if (!branch) throw new Error('Ejecutá este subcomando mediante runApiCli');
  const db = new PrismaClient();
  try {
    const report = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          branch,
          takenAt: new Date().toISOString(),
          penWithRate: await penWithRate(tx),
          invoices: await invoiceScope(tx),
          creditNotes: await creditNotesOnDeadInvoices(tx),
          purchaseNumbers: await leadingZeroCollisions(tx),
          dates: await datesVersusAudit(tx),
        };
      },
      { timeout: 120_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    console.error(`Rama ${branch}; foto ${report.takenAt}; transacción READ ONLY`);
    console.error(
      `1. Compras PEN con TC≠1: ${report.penWithRate.count} (bobinas ${report.penWithRate.coilCount}; ` +
        `totalPen de más S/ ${report.penWithRate.totalPenOverstatedPen}; kardex de más S/ ${report.penWithRate.kardexOverstatedPen}); ` +
        `pagos PEN con TC≠1: ${report.penWithRate.penPaymentsWithRate.count}`,
    );
    console.error(
      `2. Comprobantes de VENDEDOR sobre pedido ajeno: ${report.invoices.foreignSeller.count}`,
    );
    console.error(
      `3. Comprobantes con pedido anulado u otro cliente: ${report.invoices.badOrder.count} (vivos ${report.invoices.badOrder.liveCount})`,
    );
    console.error(
      `4. NC sobre factura muerta: vivas ${report.creditNotes.liveCount} (S/ ${report.creditNotes.liveTotalPen}), ` +
        `borrador ${report.creditNotes.draftCount}, otras ${report.creditNotes.otherCount}`,
    );
    console.error(
      `5. Choques de número sin ceros: ${report.purchaseNumbers.collisionGroups} grupos; con ceros ${report.purchaseNumbers.withLeadingZeros}; ` +
        `fuera del formato nuevo ${report.purchaseNumbers.numbersOutsideNewFormat.length}`,
    );
    console.error(
      `6. Fechas: pagos distintos de lo escrito ${report.dates.payments.mismatches}/${report.dates.payments.audited}; ` +
        `ediciones con fecha inexistente ${report.dates.receivedEdits.invalidDates.length}; importador ${report.dates.imports.invalidDates.length}; alta de compra no detectable`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
