import { DispatchStatus, FiscalDocType, type PrismaClient } from '@prisma/client';
import { dispatchCode, type FiscalDocumentDispatchLinkDto } from '@ayr/shared';

/** Lo mínimo de un comprobante para buscarle sus despachos. */
export interface DocumentDispatchRef {
  id: string;
  docType: FiscalDocType;
  salesOrderId: string | null;
  /** El despacho de una guía de remisión (`FiscalDocument.dispatchId`), que es el suyo. */
  dispatchId?: string | null;
  dispatchCode?: string | null;
}

export interface DocumentDispatchLinks {
  /** Los despachos vivos que declaran este comprobante (`dispatches.invoice_id`). */
  invoicedDispatches: FiscalDocumentDispatchLinkDto[];
  /** Los despachos vivos del pedido, **solo** si no hay ninguno declarado (D-205). */
  orderDispatches: FiscalDocumentDispatchLinkDto[];
}

/**
 * Correcciones 05 / M5: a qué despacho está asociado cada comprobante.
 *
 * El enlace propio es `Dispatch.invoiceId` —lo escriben el mostrador (D-099), D-213 al declarar
 * el despacho al facturar y D-278 al despachar a la fecha del comprobante—, **no**
 * `FiscalDocument.dispatchId`, que es solo de la guía de remisión. Vivo es `ISSUED`: el mismo
 * corte que el resto del código usa para un despacho que sigue en pie (uno `REVERSED` devolvió
 * la mercadería).
 *
 * Sin despacho declarado, los del pedido van en su propio campo para que la pantalla los rotule
 * como del pedido: D-205 prohíbe presentar un enlace inferido como propio (un pedido puede tener
 * varios despachos parciales). La guía de remisión no se consulta: su despacho es `dispatchId`, el
 * que la emitió, y se devuelve como el suyo sin viaje a la base.
 *
 * **Una sola consulta** para toda la página, sin importar cuántos comprobantes traiga
 * (`document-dispatches.spec.ts`).
 */
export async function dispatchLinksByDocument(
  prisma: Pick<PrismaClient, 'dispatch'>,
  documents: readonly DocumentDispatchRef[],
): Promise<Map<string, DocumentDispatchLinks>> {
  const out = new Map<string, DocumentDispatchLinks>();
  const payable = documents.filter((d) => d.docType !== FiscalDocType.GUIA_REMISION_REMITENTE);
  for (const d of documents) {
    const { dispatchId, dispatchCode: code } = d;
    const ownGuide =
      d.docType === FiscalDocType.GUIA_REMISION_REMITENTE &&
      typeof dispatchId === 'string' &&
      typeof code === 'string'
        ? [{ id: dispatchId, code }]
        : [];
    out.set(d.id, { invoicedDispatches: ownGuide, orderDispatches: [] });
  }
  if (payable.length === 0) return out;

  const documentIds = payable.map((d) => d.id);
  const orderIds = [
    ...new Set(payable.map((d) => d.salesOrderId).filter((id): id is string => id !== null)),
  ];
  const rows = await prisma.dispatch.findMany({
    where: {
      status: DispatchStatus.ISSUED,
      OR: [
        { invoiceId: { in: documentIds } },
        ...(orderIds.length > 0 ? [{ salesOrderId: { in: orderIds } }] : []),
      ],
    },
    select: { id: true, seq: true, invoiceId: true, salesOrderId: true },
    orderBy: [{ dispatchDate: 'asc' }, { seq: 'asc' }],
  });

  for (const d of payable) {
    const invoicedDispatches = rows
      .filter((r) => r.invoiceId === d.id)
      .map((r) => ({ id: r.id, code: dispatchCode(r.seq) }));
    const orderDispatches =
      invoicedDispatches.length === 0 && d.salesOrderId !== null
        ? rows
            .filter((r) => r.salesOrderId === d.salesOrderId)
            .map((r) => ({ id: r.id, code: dispatchCode(r.seq) }))
        : [];
    out.set(d.id, { invoicedDispatches, orderDispatches });
  }
  return out;
}
