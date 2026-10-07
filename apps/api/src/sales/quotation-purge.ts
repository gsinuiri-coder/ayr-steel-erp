import {
  AuditActorKind,
  QuotationStatus,
  TemporaryReservationStatus,
  type Prisma,
} from '@prisma/client';
import { quotationCode, salesOrderCode } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import { productsWithUsage } from '../catalog/product-usage';
import { lockDocuments } from '../inventory/document-locks';

/**
 * **Purga de cotizaciones anuladas elegidas por el dueño (D-350).**
 *
 * Borra físicamente una cotización ANULADA cuyo número el dueño pasó explícitamente, y solo si
 * nada la usa: ningún pedido (`sales_orders.quotation_id`, en cualquier estado), ninguna reserva
 * temporal que no esté `RELEASED`. Con ella se van sus líneas (y sus piezas, en cascada), sus
 * reservas `RELEASED` y su historial de cambios de precio por línea (`sales_price_changes`). Todo
 * lo demás se reporta como bloqueado, con el motivo, y no se toca.
 *
 * El PDF en R2 **no se borra** (decisión del dueño): la CLI corre sin R2, así que el informe
 * lista su clave como huérfana — no se ve en ninguna pantalla, porque nadie la vuelve a pedir.
 */

const QUOTATION_CODE = /^COT-?(\d{1,9})$/i;

export interface PurgeCandidate {
  code: string;
  id: string;
  customerId: string;
  customerName: string;
  status: QuotationStatus;
  itemCount: number;
  releasedReservations: number;
  priceChanges: number;
  pdfKey: string | null;
  productIds: string[];
}

export interface BlockedQuotation {
  code: string;
  status: QuotationStatus | null;
  reasons: string[];
}

export interface PurgePlan {
  purgeable: PurgeCandidate[];
  blocked: BlockedQuotation[];
  /** Productos que después de la purga quedarían sin uso (`canDelete = true`, D-347). */
  freedProducts: { id: string; sku: string; name: string }[];
}

/** `COT-000123`, `cot-123` o `123` → 123. `null` si no es un número de cotización. */
export function parseQuotationNumber(raw: string): number | null {
  const trimmed = raw.trim();
  const match = QUOTATION_CODE.exec(trimmed) ?? /^(\d{1,9})$/.exec(trimmed);
  if (!match?.[1]) return null;
  const seq = Number(match[1]);
  return seq > 0 ? seq : null;
}

/**
 * Lo que la purga haría con cada número, sin escribir nada. Se vuelve a correr dentro de la
 * transacción del `--execute`, con las filas bloqueadas, para que nada cambie entre el dry-run
 * y el borrado sin que se note.
 */
export async function planQuotationPurge(
  tx: Prisma.TransactionClient,
  numbers: readonly string[],
): Promise<PurgePlan> {
  const blocked: BlockedQuotation[] = [];
  const seqs = new Map<number, string>();
  for (const raw of numbers) {
    const seq = parseQuotationNumber(raw);
    if (seq === null) {
      blocked.push({ code: raw, status: null, reasons: ['no es un número de cotización'] });
      continue;
    }
    seqs.set(seq, quotationCode(seq));
  }
  const rows = await tx.quotation.findMany({
    where: { seq: { in: [...seqs.keys()] } },
    select: {
      id: true,
      seq: true,
      status: true,
      pdfKey: true,
      customerId: true,
      customer: { select: { name: true } },
      items: { select: { productId: true } },
      salesOrders: { select: { seq: true } },
      temporaryReservations: { select: { status: true } },
      _count: { select: { priceChanges: true } },
    },
    orderBy: { seq: 'asc' },
  });
  const found = new Set(rows.map((r) => r.seq));
  for (const [seq, code] of seqs) {
    if (!found.has(seq)) blocked.push({ code, status: null, reasons: ['no existe'] });
  }

  const purgeable: PurgeCandidate[] = [];
  for (const q of rows) {
    const code = quotationCode(q.seq);
    const reasons: string[] = [];
    if (q.status !== QuotationStatus.CANCELLED) {
      reasons.push(`está ${q.status}, no ANULADA`);
    }
    if (q.salesOrders.length > 0) {
      reasons.push(`tiene pedido(s) ${q.salesOrders.map((o) => salesOrderCode(o.seq)).join(', ')}`);
    }
    const liveReservations = q.temporaryReservations.filter(
      (r) => r.status !== TemporaryReservationStatus.RELEASED,
    );
    if (liveReservations.length > 0) {
      const byStatus = [...new Set(liveReservations.map((r) => r.status))].join(', ');
      reasons.push(
        `tiene ${String(liveReservations.length)} reserva(s) temporal(es) no liberada(s) (${byStatus})`,
      );
    }
    if (reasons.length > 0) {
      blocked.push({ code, status: q.status, reasons });
      continue;
    }
    purgeable.push({
      code,
      id: q.id,
      customerId: q.customerId,
      customerName: q.customer.name,
      status: q.status,
      itemCount: q.items.length,
      releasedReservations: q.temporaryReservations.length,
      priceChanges: q._count.priceChanges,
      pdfKey: q.pdfKey,
      productIds: [...new Set(q.items.map((i) => i.productId))],
    });
  }

  return { purgeable, blocked, freedProducts: await freedProducts(tx, purgeable) };
}

/** Los productos de las cotizaciones purgables que quedarían sin ningún uso (D-347). */
async function freedProducts(
  tx: Prisma.TransactionClient,
  purgeable: readonly PurgeCandidate[],
): Promise<PurgePlan['freedProducts']> {
  const ids = [...new Set(purgeable.flatMap((c) => c.productIds))];
  if (ids.length === 0) return [];
  const products = await tx.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, sku: true, name: true, businessLine: { select: { code: true } } },
    orderBy: { sku: 'asc' },
  });
  const used = await productsWithUsage(tx, products, {
    excludeQuotationIds: purgeable.map((c) => c.id),
  });
  return products
    .filter((p) => !used.has(p.id))
    .map((p) => ({ id: p.id, sku: p.sku, name: p.name }));
}

export interface PurgeResult {
  purged: PurgeCandidate[];
  blocked: BlockedQuotation[];
  freedProducts: PurgePlan['freedProducts'];
  /** Claves de PDF que quedan en R2 sin nada que las pida (la CLI no borra R2). */
  orphanPdfKeys: string[];
}

/**
 * Borra, en la transacción que recibe, las cotizaciones purgables del plan. **Todo o nada**: si
 * al revalidar bajo lock alguna pasó a estar bloqueada, no se borra ninguna y se devuelve el
 * motivo — el dueño eligió un conjunto, y borrar una parte sería otra decisión.
 */
export async function executeQuotationPurge(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  numbers: readonly string[],
  expectedCodes: readonly string[],
): Promise<PurgeResult> {
  const seqs = numbers.map(parseQuotationNumber).filter((s): s is number => s !== null);
  // El mismo orden siempre: dos purgas a la vez no se cruzan los locks. cc30: por la puerta y
  // por id, como cualquier otra toma de cotizaciones (antes, por `seq`).
  const toLock = await tx.quotation.findMany({
    where: { seq: { in: seqs } },
    select: { id: true },
  });
  await lockDocuments(tx, { quotations: toLock.map((q) => q.id) });
  const plan = await planQuotationPurge(tx, numbers);
  const byCode = (a: string, b: string) => a.localeCompare(b);
  const planned = plan.purgeable.map((c) => c.code).sort(byCode);
  const expected = [...expectedCodes].sort(byCode);
  if (planned.join(',') !== expected.join(',')) {
    throw new Error(
      `El plan cambió desde el dry-run (esperadas: ${expected.join(', ') || 'ninguna'}; ahora: ${planned.join(', ') || 'ninguna'}). No se borró nada.`,
    );
  }
  for (const c of plan.purgeable) {
    await tx.salesPriceChange.deleteMany({ where: { quotationId: c.id } });
    await tx.quotationReservation.deleteMany({
      where: { quotationId: c.id, status: TemporaryReservationStatus.RELEASED },
    });
    // Las líneas y sus piezas se van en cascada (FK `ON DELETE CASCADE`).
    await tx.quotation.delete({ where: { id: c.id } });
    await audit.write(tx, {
      actorId: null,
      actorKind: AuditActorKind.SYSTEM,
      action: 'quotations.purge',
      entity: 'quotations',
      entityId: c.id,
      // D-350: solo el número y el cliente — no el `before` completo de la cotización.
      before: { code: c.code, customerId: c.customerId, customerName: c.customerName },
    });
  }
  return {
    purged: plan.purgeable,
    blocked: plan.blocked,
    freedProducts: plan.freedProducts,
    orphanPdfKeys: plan.purgeable.flatMap((c) => (c.pdfKey === null ? [] : [c.pdfKey])),
  };
}

/** El informe legible del plan (dry-run) o del resultado (execute). */
export function formatPurgeReport(
  plan: PurgePlan & { orphanPdfKeys?: string[] },
  header: string,
): string {
  const out: string[] = [header, ''];
  out.push(`A borrar: ${String(plan.purgeable.length)}`);
  for (const c of plan.purgeable) {
    out.push(
      `  ${c.code}  ${c.status}  ${c.customerName}  · ${String(c.itemCount)} línea(s), ` +
        `${String(c.releasedReservations)} reserva(s) RELEASED, ` +
        `${String(c.priceChanges)} cambio(s) de precio` +
        (c.pdfKey === null ? '' : `, PDF ${c.pdfKey}`),
    );
  }
  out.push('', `Bloqueadas (no se tocan): ${String(plan.blocked.length)}`);
  for (const b of plan.blocked) {
    out.push(`  ${b.code}  ${b.status ?? '—'}  ${b.reasons.join('; ')}`);
  }
  out.push(
    '',
    `Productos que quedarían sin uso (se podrían borrar): ${String(plan.freedProducts.length)}`,
  );
  for (const p of plan.freedProducts) out.push(`  ${p.sku}  ${p.name}`);
  const orphans =
    plan.orphanPdfKeys ?? plan.purgeable.flatMap((c) => (c.pdfKey === null ? [] : [c.pdfKey]));
  out.push('', `PDF en R2 que quedan huérfanos (no se borran): ${String(orphans.length)}`);
  for (const key of orphans) out.push(`  ${key}`);
  return out.join('\n');
}
