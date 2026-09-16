'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Role,
  type PriceListImportPreviewDto,
  type PriceListImportResultDto,
  type PriceListImportRowDto,
  type PriceListImportRowStatus,
  type PriceListRevertResultDto,
} from '@ayr/shared';
import { ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const STATUS_LABEL: Record<PriceListImportRowStatus, string> = {
  NEW: 'Nuevo',
  CHANGED: 'Cambia',
  UNCHANGED: 'Sin cambio',
  WARNING: 'Aviso',
  ERROR: 'Error',
};

const STATUS_VARIANT: Record<
  PriceListImportRowStatus,
  'default' | 'secondary' | 'destructive' | 'outline' | 'warning'
> = {
  NEW: 'default',
  CHANGED: 'secondary',
  UNCHANGED: 'outline',
  WARNING: 'warning',
  ERROR: 'destructive',
};

/** `fetch` crudo y no `api()`: el cuerpo de subida es `FormData`, no JSON (D-152). */
async function uploadForPreview(file: File): Promise<PriceListImportPreviewDto> {
  const body = new FormData();
  body.append('file', file);
  const res = await fetch('/api/catalog/price-list/import/preview', {
    method: 'POST',
    body,
    credentials: 'include',
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as PriceListImportPreviewDto;
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text();
  let message = `El API respondió ${String(res.status)}`;
  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    if (parsed.message)
      message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message;
  } catch {
    /* el cuerpo no era JSON */
  }
  return new ApiError(res.status, message);
}

/**
 * D-217/M1c: carga masiva del precio de lista. Sin estado entre el preview y la confirmación
 * (D-152): lo que se confirma es exactamente lo que este preview devolvió, no un archivo que
 * el servidor vuelve a leer.
 */
export function ImportarPreciosView() {
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  const [preview, setPreview] = useState<PriceListImportPreviewDto | null>(null);
  const [result, setResult] = useState<PriceListImportResultDto | null>(null);
  const [reverted, setReverted] = useState<PriceListRevertResultDto | null>(null);

  const upload = useMutation({
    mutationFn: uploadForPreview,
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setReverted(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo leer el archivo'),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Nada que confirmar');
      const rows = preview.rows.filter(
        (r): r is PriceListImportRowDto & { productId: string; afterValuePen: string } =>
          (r.status === 'NEW' || r.status === 'CHANGED' || r.status === 'WARNING') &&
          r.productId !== null &&
          r.afterValuePen !== null,
      );
      const body = {
        rows: rows.map((r) => ({ productId: r.productId, afterValuePen: r.afterValuePen })),
        idempotencyKey: idempotency.current(
          JSON.stringify(rows.map((r) => [r.productId, r.afterValuePen])),
        ),
      };
      const res = await fetch('/api/catalog/price-list/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as PriceListImportResultDto;
    },
    onSuccess: (data) => {
      idempotency.settle();
      toast.success(`Lote confirmado: ${String(data.changed)} precio(s) actualizado(s)`);
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (err) => {
      idempotency.settle(err);
      toast.error(err instanceof ApiError ? err.message : 'No se pudo confirmar la carga');
    },
  });

  const revert = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error('Nada que revertir');
      const res = await fetch(`/api/catalog/price-list/import/${result.batchId}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ idempotencyKey: idempotency.current(`revert:${result.batchId}`) }),
      });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as PriceListRevertResultDto;
    },
    onSuccess: (data) => {
      idempotency.settle();
      toast.success(`Lote revertido: ${String(data.reverted)} precio(s) restaurado(s)`);
      setReverted(data);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (err) => {
      idempotency.settle(err);
      toast.error(err instanceof ApiError ? err.message : 'No se pudo revertir el lote');
    },
  });

  const hasErrors = (preview?.summary.errors ?? 0) > 0;
  const confirmableCount = preview
    ? preview.rows.filter(
        (r) => r.status === 'NEW' || r.status === 'CHANGED' || r.status === 'WARNING',
      ).length
    : 0;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Cargar precios de lista</h1>
          <p className="text-xs text-muted-foreground">
            xlsx o csv con columnas <code>SKU</code> y <code>PRECIO CON IGV</code>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="/plantillas/precios-de-lista.csv" download>
              Descargar plantilla
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/catalogo">Volver al catálogo</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={upload.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload.mutate(file);
            }}
          />
        </CardContent>
      </Card>

      {preview && !result && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {preview.summary.new} nuevo(s) · {preview.summary.changed} cambia(n) ·{' '}
              {preview.summary.unchanged} sin cambio · {preview.summary.warnings} aviso(s) ·{' '}
              {preview.summary.errors} error(es)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {hasErrors && (
              <Alert variant="destructive">
                <AlertDescription>
                  Hay filas con error: corrígelas en el archivo y volvé a subirlo. Ningún error
                  bloquea las demás filas del preview, pero sí bloquea confirmar el lote entero.
                </AlertDescription>
              </Alert>
            )}
            <div className="max-h-[28rem] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>Fila</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">Antes</TableHead>
                    <TableHead className="text-right">Después</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Detalle</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.rowNumber}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {r.rowNumber}
                      </TableCell>
                      <TableCell className="font-medium">{r.sku}</TableCell>
                      <TableCell>{r.productName ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.beforeValuePen ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.afterValuePen ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.message ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-end">
              <Button
                disabled={hasErrors || confirmableCount === 0 || confirm.isPending}
                pending={confirm.isPending}
                pendingText="Confirmando…"
                onClick={() => {
                  confirm.mutate();
                }}
              >
                Confirmar {confirmableCount} cambio(s)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && !reverted && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Lote confirmado: {result.changed} precio(s) actualizado(s).</span>
            <Button
              variant="outline"
              size="sm"
              disabled={revert.isPending}
              pending={revert.isPending}
              pendingText="Revirtiendo…"
              onClick={() => {
                revert.mutate();
              }}
            >
              Revertir este lote
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {reverted && (
        <Alert>
          <AlertDescription>
            Lote revertido: {reverted.reverted} precio(s) restaurado(s) a su valor anterior.
          </AlertDescription>
        </Alert>
      )}
    </RoleGate>
  );
}
