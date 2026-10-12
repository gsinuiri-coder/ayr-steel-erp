'use client';

import {
  FISCAL_DOC_TYPE_LABELS,
  FISCAL_DOCUMENT_ORIGIN_LABELS,
  FISCAL_DOCUMENT_ORIGINS,
  INVOICE_DOC_TYPES,
} from '@ayr/shared';
import { SelectFilterField } from '@/components/select-filter-field';

/**
 * cc47 (D-615): «Tipo» y «Origen» de un comprobante en el modal «Filtros», iguales en
 * Comprobantes y en Cobranzas. La guía de remisión se ve desde su despacho, no aquí.
 */
export function DocumentFilterFields({
  docType,
  origin,
  onChange,
}: {
  docType: string;
  origin: string;
  onChange: (patch: { docType?: string; origin?: string }) => void;
}) {
  return (
    <>
      <SelectFilterField
        id="filtro-tipo"
        label="Tipo"
        value={docType}
        onChange={(v) => {
          onChange({ docType: v });
        }}
        allLabel="Todos los tipos"
        options={INVOICE_DOC_TYPES.map((t) => ({ value: t, label: FISCAL_DOC_TYPE_LABELS[t] }))}
      />
      <SelectFilterField
        id="filtro-origen"
        label="Origen"
        value={origin}
        onChange={(v) => {
          onChange({ origin: v });
        }}
        allLabel="Todos los orígenes"
        options={FISCAL_DOCUMENT_ORIGINS.map((o) => ({
          value: o,
          label: FISCAL_DOCUMENT_ORIGIN_LABELS[o],
        }))}
      />
    </>
  );
}
