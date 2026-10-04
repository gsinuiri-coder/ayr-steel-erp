import Link from 'next/link';
import { Check, TriangleAlert } from 'lucide-react';
import { quotationInvoiceState, type QuotationInvoiceDocument } from '@ayr/shared';
import { cn } from '@/lib/utils';

/** Texto del tooltip del estado «solo referencia». */
export const REFERENCE_ONLY_HINT = 'Número del Excel, aún sin comprobante registrado';

/**
 * D-387: el comprobante de una cotización, como lo muestran la lista y la cabecera del detalle.
 *
 * - **Solo referencia** (gris): el número de la marca del importador, sin comprobante vigente en
 *   el sistema. No es un comprobante: por eso no se ve como uno.
 * - **Registrado** (color normal, con check y enlace): el comprobante vigente del pedido.
 * - **No coincide** (ámbar, el tono `warning` de S11; nunca rojo): hay comprobante vigente y su
 *   número no es el del Excel. El tooltip dice los dos.
 * - **Sin nada**: no se dibuja.
 *
 * Con más de un comprobante vigente se muestra el primero y «+N», con la lista en el tooltip.
 */
export function QuotationInvoice({
  externalInvoice,
  invoiceDocuments,
}: {
  externalInvoice: string | null;
  invoiceDocuments: readonly QuotationInvoiceDocument[];
}) {
  const state = quotationInvoiceState(externalInvoice, invoiceDocuments);
  if (state.kind === 'NONE') return null;
  if (state.kind === 'REFERENCE') {
    // El gris y el tooltip no llegan a un lector de pantalla: el nombre accesible dice lo mismo.
    return (
      <span
        data-testid="quotation-external-invoice"
        data-state="reference"
        role="note"
        aria-label={`${state.reference}: ${REFERENCE_ONLY_HINT}`}
        className="text-muted-foreground"
        title={REFERENCE_ONLY_HINT}
      >
        {state.reference}
      </span>
    );
  }
  const [first, ...rest] = state.documents;
  const all = state.documents.map((d) => d.number).join(', ');
  const mismatch = state.kind === 'MISMATCH';
  const title = mismatch
    ? `Comprobante registrado: ${all}. Número del Excel: ${state.reference}`
    : rest.length > 0
      ? `Comprobantes registrados: ${all}`
      : undefined;
  return (
    <span
      data-testid="quotation-external-invoice"
      data-state={mismatch ? 'mismatch' : 'registered'}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap',
        mismatch && 'text-tone-warning-foreground',
      )}
      title={title}
    >
      {/* El estado no se dice solo con color (WCAG 1.4.1): cada uno lleva su ícono con nombre. */}
      {mismatch ? (
        <TriangleAlert
          role="img"
          aria-label={`No coincide con el número del Excel ${state.reference}`}
          className="size-3.5 shrink-0"
        />
      ) : (
        <Check role="img" aria-label="Comprobante registrado" className="size-3.5 shrink-0" />
      )}
      {/* El tooltip también en el enlace: con teclado, el foco cae acá y no en el contenedor. */}
      <Link
        href={`/comprobantes/${first?.id ?? ''}`}
        className="underline-offset-4 hover:underline"
        title={title}
      >
        {first?.number}
      </Link>
      {rest.length > 0 && (
        <span className="text-xs" aria-label={`y ${String(rest.length)} más: ${all}`}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}
