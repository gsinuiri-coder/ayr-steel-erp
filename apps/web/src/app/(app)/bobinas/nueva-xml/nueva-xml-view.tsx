'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PurchaseType, Role, type InvoiceXmlPreviewDto } from '@ayr/shared';
import { ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { defaultPurchaseValues, emptyItem, PurchaseForm } from '../../compras/purchase-form';
import type { PurchaseFormValues } from '../../compras/purchase-form';

async function uploadXml(file: File): Promise<InvoiceXmlPreviewDto> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/purchases/xml/preview', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? `Error ${res.status}`);
  }
  return (await res.json()) as InvoiceXmlPreviewDto;
}

/**
 * RF-11: alta de bobinas desde el XML de la factura del proveedor. El XML solo
 * prellena el formulario; nada se crea hasta que el usuario revisa y confirma.
 */
export function NuevaXmlView() {
  const [preview, setPreview] = useState<InvoiceXmlPreviewDto | null>(null);

  const upload = useMutation({
    mutationFn: uploadXml,
    onSuccess: setPreview,
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo leer el XML');
    },
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div>
        <h1 className="text-2xl font-semibold">Bobinas desde XML</h1>
        <p className="text-sm text-muted-foreground">
          Sube el XML de la factura electrónica del proveedor (UBL 2.1). Se prellena la compra y sus
          bobinas; tú completas acabado, ancho y espesor de cada una antes de confirmar.
        </p>
      </div>

      {!preview && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="text-base">Archivo XML</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Input
              type="file"
              aria-label="Archivo XML de la factura del proveedor"
              accept=".xml,text/xml,application/xml"
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Si el proveedor envió un ZIP, extrae el XML y súbelo suelto.
            </p>
            {upload.isPending && <p className="text-sm text-muted-foreground">Leyendo el XML…</p>}
          </CardContent>
        </Card>
      )}

      {preview && !preview.supplierId && (
        <Alert variant="destructive">
          <AlertTitle>Falta el proveedor</AlertTitle>
          <AlertDescription>
            El emisor del XML ({preview.supplierName || 'sin nombre'}, documento{' '}
            {preview.supplierDocNumber || 'desconocido'}) no está registrado como proveedor activo.
            Créalo en Proveedores y vuelve, o elige otro en el formulario.
          </AlertDescription>
        </Alert>
      )}

      {preview && (
        <>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Leído del XML: {preview.series}-{preview.number} · {preview.supplierName} · valor de
              venta {formatMoney(preview.subtotal, preview.currency)} + IGV{' '}
              {formatMoney(preview.igv, preview.currency)} ={' '}
              {formatMoney(preview.total, preview.currency)}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setPreview(null);
              }}
            >
              Subir otro XML
            </Button>
          </div>
          <PurchaseForm
            initialValues={toFormValues(preview)}
            lockType
            warnings={preview.warnings}
            submitLabel="Confirmar compra y bobinas"
          />
        </>
      )}
    </RoleGate>
  );
}

/** Traduce el preview del XML al formulario. Los datos físicos de la bobina no vienen
 *  en el comprobante (el XML no trae acabado, ancho ni espesor): los pone el usuario. */
function toFormValues(preview: InvoiceXmlPreviewDto): PurchaseFormValues {
  const base = defaultPurchaseValues(PurchaseType.COIL);
  return {
    ...base,
    supplierId: preview.supplierId ?? '',
    docType: preview.docType,
    series: preview.series,
    number: preview.number,
    issueDate: preview.issueDate,
    currency: preview.currency,
    igvRate: preview.igvRate,
    paymentTerms: preview.paymentTerms,
    creditDays: preview.creditDays ? String(preview.creditDays) : '',
    sourceXmlKey: preview.sourceXmlKey,
    items: preview.lines.map((line) => ({
      ...emptyItem(PurchaseType.COIL),
      description: line.description,
      qty: line.qty,
      unit: 'KGM' as const,
      unitPrice: line.unitPrice,
    })),
  };
}
