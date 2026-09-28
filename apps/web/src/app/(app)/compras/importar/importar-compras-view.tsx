'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  businessLineOf,
  PURCHASE_TYPE_LABELS,
  Role,
  type BusinessLineDto,
  type FinishDto,
  type ProductDto,
  type PurchaseImportDocumentDto,
  type PurchaseImportPreviewDto,
  type PurchaseImportResultDto,
  type PurchaseImportUndoResultDto,
  type SupplierDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { useSession } from '@/lib/session';
import {
  documentStatus,
  errorsOf,
  lineEditPatch,
  lineShape,
  mergeChoices,
  newSuppliersOf,
  toDocumentInput,
  warningsOf,
  type ReviewDocument,
  type ReviewLine,
} from '@/lib/purchase-import';
import { RoleGate } from '@/components/role-gate';
import { ReasonDialog } from '@/components/reason-dialog';
import { InfoPopover } from '@/components/info-popover';
import { ProductDialog } from '@/components/catalog/product-dialog';
import { SearchSelectField, type SearchSelectOption } from '@/components/search-select-modal';
import { SupplierDialog } from '@/app/(app)/proveedores/supplier-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Importador masivo de compras (D-351).
 *
 * Mismo esquema que el de cotizaciones (D-152/D-156): se sube la planilla, el servidor la lee sin
 * guardar nada y la pantalla muestra **un acordeón por comprobante** con sus líneas editables.
 * A diferencia de aquel, **toda la regla la decide el servidor**: cada edición se revalida con
 * `POST /imports/purchases/validate` (la misma función que usa la confirmación), así la pantalla
 * no tiene una copia de las reglas que pueda envejecer. Confirmar crea cada compra en BORRADOR
 * por el alta normal, todo o nada; recibirlas es el paso aparte de siempre.
 */

/** Espera tras la última tecla antes de revalidar contra el servidor. */
const REVALIDATE_MS = 600;

export function ImportarComprasView() {
  const { user } = useSession();
  const isAdmin = user?.role === Role.ADMINISTRADOR;
  const [fileName, setFileName] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [docs, setDocs] = useState<ReviewDocument[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PurchaseImportResultDto | null>(null);
  const [undone, setUndone] = useState<PurchaseImportUndoResultDto | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const version = useRef(0);
  const idempotency = useIdempotencyKey();

  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });
  const products = useQuery({
    queryKey: ['catalog', 'purchase-import'],
    queryFn: () => api<ProductDto[]>('/catalog?active=true'),
  });
  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
  });
  const lines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });

  const supplierOptions = useMemo<SearchSelectOption[]>(
    () =>
      (suppliers.data ?? [])
        .filter((s) => s.isActive)
        .map((s) => ({ id: s.id, label: `${s.docNumber} — ${s.name}`, hint: s.code })),
    [suppliers.data],
  );

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/imports/purchases/preview', {
        method: 'POST',
        body,
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        let message = `El API respondió ${String(res.status)}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          /* el cuerpo no era JSON */
        }
        throw new Error(message);
      }
      return (await res.json()) as PurchaseImportPreviewDto;
    },
    onSuccess: (data) => {
      setFileName(data.fileName);
      setNotices(data.notices);
      setDocs(mergeChoices(data.documents, []));
      // Se abren solos los que tienen algo que resolver, decidido sobre el archivo tal como llegó.
      setOpen(Object.fromEntries(data.documents.map((d) => [d.key, errorsOf(d).length > 0])));
      setServerErrors({});
      setResult(null);
      setUndone(null);
      setDirty(false);
      toast.success(
        `${String(data.rows)} filas leídas en ${String(data.documents.length)} comprobantes`,
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'No se pudo leer el archivo');
    },
  });

  const revalidate = useMutation({
    mutationFn: ({ documents }: { documents: ReviewDocument[]; version: number }) =>
      api<PurchaseImportDocumentDto[]>('/imports/purchases/validate', {
        method: 'POST',
        body: { documents: documents.map(toDocumentInput) },
      }),
    onSuccess: (fresh, vars) => {
      // Una respuesta vieja (se siguió editando mientras viajaba) no pisa lo más nuevo.
      if (vars.version !== version.current) return;
      setDocs((prev) => mergeChoices(fresh, prev ?? []));
      setDirty(false);
    },
    onError: (err, vars) => {
      if (vars.version !== version.current) return;
      toast.error(err instanceof ApiError ? err.message : 'No se pudo revalidar');
    },
  });

  // Cada edición revalida contra el servidor, con una espera tras la última tecla.
  useEffect(() => {
    if (!dirty || docs === null) return;
    const current = ++version.current;
    const handle = setTimeout(() => {
      if (docs.length > 0) revalidate.mutate({ documents: docs, version: current });
      else setDirty(false);
    }, REVALIDATE_MS);
    return () => {
      clearTimeout(handle);
    };
    // `revalidate` es estable en lo que importa; incluirlo relanzaría el efecto en cada render.
  }, [docs, dirty]);

  const edit = (key: string, patch: (doc: ReviewDocument) => ReviewDocument | null) => {
    setDocs((prev) =>
      (prev ?? []).flatMap((d) => {
        if (d.key !== key) return [d];
        const next = patch(d);
        return next === null ? [] : [next];
      }),
    );
    setServerErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
    setDirty(true);
  };

  const editLine = (key: string, index: number, patch: Partial<ReviewLine>) => {
    edit(key, (d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  };

  const removeLine = (key: string, index: number) => {
    edit(key, (d) => {
      const remaining = d.lines.filter((_, i) => i !== index);
      return remaining.length === 0 ? null : { ...d, lines: remaining };
    });
  };

  const list = docs ?? [];
  const blocking = list.filter((d) => errorsOf(d).length > 0).length;
  const newSuppliers = newSuppliersOf(list);

  const confirm = useMutation({
    mutationFn: () => {
      const documents = list.map(toDocumentInput);
      return api<PurchaseImportResultDto>('/imports/purchases', {
        method: 'POST',
        body: {
          documents,
          fileName,
          // D-182: una clave por intento; el mismo contenido reintentado tras un corte reusa la suya.
          idempotencyKey: idempotency.current(JSON.stringify(documents)),
        },
      });
    },
    onSuccess: (data) => {
      idempotency.settle();
      setResult(data);
      setDocs(null);
      toast.success(`${String(data.purchases.length)} compras creadas en borrador`);
    },
    onError: (err) => {
      idempotency.settle(err);
      if (err instanceof ApiError && err.errors) {
        const mapped: Record<string, string> = {};
        for (const [key, messages] of Object.entries(err.errors)) {
          if (messages && messages.length > 0) mapped[key] = messages.join(' ');
        }
        setServerErrors(mapped);
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo importar');
    },
  });

  const undo = useMutation({
    mutationFn: ({ batchId, reason }: { batchId: string; reason: string }) =>
      api<PurchaseImportUndoResultDto>(`/imports/purchases/batches/${batchId}/undo`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (data) => {
      setUndoOpen(false);
      setUndone(data);
      toast.success(`${String(data.cancelled.length)} compras anuladas`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo deshacer el lote');
    },
  });

  const busy = confirm.isPending || upload.isPending;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1">
              <h1 className="text-lg font-semibold">Importar compras</h1>
              <InfoPopover label="Cómo funciona la importación de compras">
                <p className="text-sm">
                  Cada comprobante se convierte en una <strong>compra en borrador</strong> por el
                  alta normal. Recibirla (crear las bobinas y mover el kardex) sigue siendo el paso
                  de siempre, desde la compra. Si algo falla no se importa nada.
                </p>
              </InfoPopover>
            </div>
            <p className="text-sm text-muted-foreground">
              Bobinas, producto terminado, servicios y gastos posteriores al inventario inicial.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href="/plantillas/importar-compras.xlsx" download>
                Plantilla
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href="/plantillas/importar-compras-ejemplo.xlsx" download>
                Ejemplo
              </a>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/compras">Volver a compras</Link>
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. El archivo</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="import-file">Planilla de compras (xlsx o csv)</Label>
              <Input
                id="import-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  e.target.value = '';
                }}
              />
            </div>
            {docs && (
              <p className="text-sm text-muted-foreground">
                {fileName} · {String(list.length)} comprobantes
              </p>
            )}
          </CardContent>
        </Card>

        {result && (
          <Alert>
            <AlertDescription className="grid gap-2">
              <p>
                Se crearon <strong>{result.purchases.length}</strong> compras en borrador:{' '}
                {result.purchases.map((p, i) => (
                  <span key={p.id}>
                    {i > 0 && ', '}
                    <Link href={`/compras/${p.id}`} className="underline">
                      {p.document}
                    </Link>{' '}
                    ({p.supplier})
                  </span>
                ))}
                .
                {result.createdSuppliers.length > 0 &&
                  ` Proveedores creados desde el padrón: ${result.createdSuppliers.join(', ')}.`}
              </p>
              {isAdmin && !undone && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={undo.isPending}
                    pending={undo.isPending}
                    pendingText="Deshaciendo…"
                    onClick={() => {
                      setUndoOpen(true);
                    }}
                  >
                    Deshacer lote
                  </Button>
                  {/* Anula compras: pide el motivo, como toda anulación (segundo modelo, P1). */}
                  <ReasonDialog
                    open={undoOpen}
                    onOpenChange={setUndoOpen}
                    title="Deshacer el lote"
                    description={`Se anularán las compras de esta importación que sigan en borrador y sin pagos (${String(result.purchases.length)} en el lote). Las ya recibidas no se tocan.`}
                    confirmLabel="Deshacer lote"
                    pending={undo.isPending}
                    onConfirm={(reason) => {
                      undo.mutate({ batchId: result.batchId, reason });
                    }}
                  />
                </div>
              )}
              {undone && (
                <p>
                  Lote deshecho: {undone.cancelled.length} anuladas
                  {undone.kept.length > 0 &&
                    `; no se tocaron ${undone.kept.map((k) => `${k.document} (${k.reason})`).join(', ')}`}
                  .
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {upload.isPending && <Skeleton className="h-64 w-full" />}

        {docs && (
          <Card>
            <CardHeader>
              <CardTitle>
                2. Revisar y corregir{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({String(list.length)} comprobantes
                  {revalidate.isPending || dirty ? ' · revalidando…' : ''})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {notices.map((n) => (
                <Alert key={n}>
                  <AlertDescription>{n}</AlertDescription>
                </Alert>
              ))}
              {newSuppliers.length > 0 && (
                <Alert>
                  <AlertDescription>
                    Se crearán desde el padrón{' '}
                    {newSuppliers.length === 1
                      ? 'un proveedor'
                      : `${String(newSuppliers.length)} proveedores`}{' '}
                    ({newSuppliers.join(', ')}). Revisa su código corto: es el primer segmento del
                    código de cada bobina y no se cambia después.
                  </AlertDescription>
                </Alert>
              )}
              {blocking > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {blocking === 1
                      ? 'Un comprobante tiene'
                      : `${String(blocking)} comprobantes tienen`}{' '}
                    algo sin resolver. Corrígelo o quítalo: un proveedor o un producto que falta se
                    crea desde su campo, sin salir de acá.
                  </AlertDescription>
                </Alert>
              )}
              {Object.keys(serverErrors).length > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    No se importó nada: el servidor rechazó {Object.keys(serverErrors).length}{' '}
                    comprobante(s); el motivo está en su cabecera.
                  </AlertDescription>
                </Alert>
              )}
              <div className="grid gap-2">
                {list.map((doc) => (
                  <DocumentCard
                    key={doc.key}
                    doc={doc}
                    open={open[doc.key] ?? false}
                    disabled={busy}
                    serverError={serverErrors[doc.key] ?? null}
                    supplierOptions={supplierOptions}
                    products={products.data ?? []}
                    finishes={finishes.data ?? []}
                    lines={lines.data ?? []}
                    onToggle={() => {
                      setOpen((prev) => ({ ...prev, [doc.key]: !(prev[doc.key] ?? false) }));
                    }}
                    onEdit={(patch) => {
                      edit(doc.key, (d) => ({ ...d, ...patch }));
                    }}
                    onEditLine={(index, patch) => {
                      editLine(doc.key, index, patch);
                    }}
                    onRemoveLine={(index) => {
                      removeLine(doc.key, index);
                    }}
                    onRemove={() => {
                      edit(doc.key, () => null);
                    }}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {docs && (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
              <p className="text-sm text-muted-foreground">
                {list.length === 0
                  ? 'No queda ningún comprobante para importar.'
                  : `Se crearán ${String(list.length)} compras en borrador` +
                    (newSuppliers.length === 0
                      ? '.'
                      : ` y ${String(newSuppliers.length)} proveedores desde el padrón.`)}
              </p>
              <Button
                className="h-12"
                disabled={
                  list.length === 0 || blocking > 0 || dirty || revalidate.isPending || busy
                }
                pending={confirm.isPending}
                pendingText="Importando…"
                onClick={() => {
                  confirm.mutate();
                }}
              >
                Crear las compras
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </RoleGate>
  );
}

// ---------------------------------------------------------------------------
// Un comprobante
// ---------------------------------------------------------------------------

function DocumentCard({
  doc,
  open,
  disabled,
  serverError,
  supplierOptions,
  products,
  finishes,
  lines,
  onToggle,
  onEdit,
  onEditLine,
  onRemoveLine,
  onRemove,
}: {
  doc: ReviewDocument;
  open: boolean;
  disabled: boolean;
  serverError: string | null;
  supplierOptions: readonly SearchSelectOption[];
  products: readonly ProductDto[];
  finishes: readonly FinishDto[];
  lines: readonly BusinessLineDto[];
  onToggle: () => void;
  onEdit: (patch: Partial<ReviewDocument>) => void;
  onEditLine: (index: number, patch: Partial<ReviewLine>) => void;
  onRemoveLine: (index: number) => void;
  onRemove: () => void;
}) {
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const status = documentStatus(doc);
  const shape = lineShape(doc.type);
  const lineCode = businessLineOf(doc.businessLine);
  const businessLine = lines.find((l) => l.code === lineCode) ?? null;
  const headerIssues = [
    ...errorsOf(doc).filter((i) => !i.field.startsWith('lines.')),
    ...warningsOf(doc),
  ];
  const productOptions = useMemo<SearchSelectOption[]>(
    () =>
      products
        .filter((p) => lineCode === null || p.businessLineCode === lineCode)
        .map((p) => ({ id: p.id, label: p.sku, hint: p.name })),
    [products, lineCode],
  );
  const finishOptions = useMemo<SearchSelectOption[]>(
    () =>
      finishes
        .filter(
          (f) =>
            f.isActive && f.kind !== null && (lineCode === null || f.businessLine === lineCode),
        )
        .map((f) => ({ id: f.id, label: f.code, hint: f.colorName ?? f.name })),
    [finishes, lineCode],
  );
  const title = `${doc.series}${doc.number ? `-${doc.number}` : ''}`;

  return (
    <div className="rounded-lg border" data-testid={`purchase-doc-${title}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          className="flex flex-1 flex-wrap items-center gap-3 rounded text-left hover:opacity-80"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span aria-hidden className="text-muted-foreground">
            {open ? '▾' : '▸'}
          </span>
          <span className="font-mono font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">
            {PURCHASE_TYPE_LABELS[shape === 'OTHER' ? 'EXPENSE' : shape]} ·{' '}
            {doc.supplierLabel ??
              (doc.newSupplier ? `${doc.newSupplier.name} (nuevo)` : doc.supplierRuc)}{' '}
            · {doc.issueDate}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm tabular-nums">
            {doc.total === null
              ? '—'
              : `${doc.currency.toUpperCase() === 'USD' ? 'US$' : 'S/'} ${doc.total}`}{' '}
            · {doc.lines.length === 1 ? '1 línea' : `${String(doc.lines.length)} líneas`}
          </span>
          <Badge variant={status.tone === 'ok' ? 'secondary' : 'destructive'}>{status.label}</Badge>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
            Quitar comprobante
          </Button>
        </div>
      </div>

      {/* El proveedor es del comprobante: sus líneas lo heredan (D-158). */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
        <span className="text-xs uppercase text-muted-foreground">Proveedor</span>
        <SearchSelectField
          label={`Proveedor de ${title}`}
          placeholder={doc.newSupplier ? 'Se creará desde el padrón' : 'Elige el proveedor'}
          actionLabel="Elegir"
          options={supplierOptions}
          value={doc.chosenSupplierId ?? doc.supplierId}
          disabled={disabled}
          onChange={(id) => {
            onEdit({ chosenSupplierId: id });
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 text-xs"
          disabled={disabled}
          onClick={() => {
            setCreatingSupplier(true);
          }}
        >
          + Crear proveedor
        </Button>
        {creatingSupplier && (
          <SupplierDialog
            open
            initial={{ docNumber: doc.supplierRuc, code: doc.newSupplierCode ?? undefined }}
            onCreated={(created) => {
              onEdit({ chosenSupplierId: created.id, newSupplier: null });
            }}
            onOpenChange={setCreatingSupplier}
          />
        )}
        {doc.newSupplier !== null && (doc.chosenSupplierId ?? null) === null && (
          <>
            <Badge
              variant="outline"
              className="border-amber-500 text-amber-700 dark:text-amber-500"
            >
              Nuevo — se creará desde padrón: {doc.newSupplier.name}
            </Badge>
            <Label htmlFor={`code-${doc.key}`} className="text-xs text-muted-foreground">
              Código corto
            </Label>
            <Input
              id={`code-${doc.key}`}
              aria-label={`Código corto del proveedor nuevo de ${title}`}
              className="h-9 w-24 text-xs uppercase"
              value={doc.newSupplierCode ?? ''}
              disabled={disabled}
              onChange={(e) => {
                onEdit({ newSupplierCode: e.target.value.toUpperCase() });
              }}
            />
          </>
        )}
      </div>

      {doc.initialLoadMatch !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t bg-amber-500/5 px-4 py-2 text-sm">
          <Checkbox
            id={`other-${doc.key}`}
            checked={doc.confirmedNotInitialLoad}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onEdit({ confirmedNotInitialLoad: checked === true });
            }}
          />
          <Label htmlFor={`other-${doc.key}`}>Es otra compra</Label>
          <span className="text-xs text-muted-foreground">
            Coincide con la factura de referencia de la carga inicial (bobinas/SKU:{' '}
            {doc.initialLoadMatch.items.slice(0, 5).join(', ')}
            {doc.initialLoadMatch.items.length > 5 ? '…' : ''}); la carga no guardó el proveedor.
          </span>
        </div>
      )}

      {(headerIssues.length > 0 || serverError !== null) && (
        <ul className="grid gap-0.5 border-t px-4 py-2 text-xs">
          {serverError !== null && <li className="text-destructive">{serverError}</li>}
          {headerIssues.map((i) => (
            <li
              key={`${i.field}-${i.message}`}
              className={
                i.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-500'
              }
            >
              {i.severity === 'warning' ? '⚠ ' : ''}
              {i.message}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="grid gap-3 border-t px-4 py-3">
          <HeaderFields doc={doc} disabled={disabled} onEdit={onEdit} />
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label={`Líneas de ${title}`}
          >
            <table className="w-full min-w-[60rem] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-2 font-medium">Fila</th>
                  {shape === 'COIL' && (
                    <>
                      <th className="py-2 pr-2 font-medium">Acabado</th>
                      <th className="py-2 pr-2 font-medium">Color</th>
                      <th className="py-2 pr-2 text-right font-medium">Espesor mm</th>
                      <th className="py-2 pr-2 text-right font-medium">Ancho mm</th>
                      <th className="py-2 pr-2 text-right font-medium">KG</th>
                    </>
                  )}
                  {shape === 'FINISHED_GOOD' && <th className="py-2 pr-2 font-medium">Producto</th>}
                  {shape !== 'COIL' && (
                    <>
                      <th className="py-2 pr-2 font-medium">Descripción</th>
                      <th className="py-2 pr-2 text-right font-medium">Cantidad</th>
                      <th className="py-2 pr-2 font-medium">Unidad</th>
                    </>
                  )}
                  <th className="py-2 pr-2 text-right font-medium">Precio unit. sin IGV</th>
                  <th className="py-2 pr-2 text-right font-medium">Importe sin IGV</th>
                  {shape === 'COIL' && <th className="py-2 pr-2 font-medium">Código externo</th>}
                  <th className="py-2 pr-2 text-right font-medium">Subtotal</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((line, index) => (
                  <LineRow
                    key={`${String(line.rowNumber)}-${String(index)}`}
                    line={line}
                    shape={shape}
                    disabled={disabled}
                    productOptions={productOptions}
                    finishOptions={finishOptions}
                    businessLine={businessLine}
                    onEdit={(patch) => {
                      onEditLine(index, patch);
                    }}
                    onRemove={() => {
                      onRemoveLine(index);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Los campos de cabecera, como texto: el servidor los interpreta y dice qué no entiende. */
function HeaderFields({
  doc,
  disabled,
  onEdit,
}: {
  doc: ReviewDocument;
  disabled: boolean;
  onEdit: (patch: Partial<ReviewDocument>) => void;
}) {
  const fields: { key: HeaderTextField; label: string; width: string }[] = [
    { key: 'type', label: 'Tipo de compra', width: 'w-36' },
    { key: 'businessLine', label: 'Línea de negocio', width: 'w-40' },
    { key: 'docType', label: 'Comprobante', width: 'w-24' },
    { key: 'issueDate', label: 'Emisión (AAAA-MM-DD)', width: 'w-32' },
    { key: 'currency', label: 'Moneda', width: 'w-16' },
    { key: 'exchangeRate', label: 'Tipo de cambio', width: 'w-24' },
    { key: 'paymentTerms', label: 'Condición', width: 'w-24' },
    { key: 'creditDays', label: 'Días', width: 'w-16' },
    { key: 'serviceKind', label: 'Tipo de servicio', width: 'w-32' },
    { key: 'igvRate', label: 'IGV %', width: 'w-16' },
  ];
  return (
    <div className="flex flex-wrap items-end gap-2">
      {fields.map((f) => (
        <div key={f.key} className="grid gap-1">
          <Label htmlFor={`${doc.key}-${f.key}`} className="text-xs text-muted-foreground">
            {f.label}
          </Label>
          <Input
            id={`${doc.key}-${f.key}`}
            className={`h-8 text-xs ${f.width}`}
            value={doc[f.key]}
            disabled={disabled}
            onChange={(e) => {
              onEdit({ [f.key]: e.target.value });
            }}
          />
        </div>
      ))}
      {doc.resolvedExchangeRate !== null && doc.currency.toUpperCase() === 'USD' && (
        <span className="pb-1.5 text-xs text-muted-foreground">
          TC a usar: {doc.resolvedExchangeRate.rate} (
          {doc.resolvedExchangeRate.source === 'MANUAL' ? 'del archivo' : 'SUNAT'})
        </span>
      )}
      {doc.subtotal !== null && (
        <span className="pb-1.5 text-xs text-muted-foreground">
          Subtotal {doc.subtotal} · IGV {doc.igv} · Total {doc.total}
          {doc.currency.toUpperCase() === 'PEN' && doc.total !== null
            ? ` (${formatMoney(doc.total, 'PEN', 2)})`
            : ''}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Una línea
// ---------------------------------------------------------------------------

function LineRow({
  line,
  shape,
  disabled,
  productOptions,
  finishOptions,
  businessLine,
  onEdit,
  onRemove,
}: {
  line: ReviewLine;
  shape: 'COIL' | 'FINISHED_GOOD' | 'OTHER';
  disabled: boolean;
  productOptions: readonly SearchSelectOption[];
  finishOptions: readonly SearchSelectOption[];
  businessLine: BusinessLineDto | null;
  onEdit: (patch: Partial<ReviewLine>) => void;
  onRemove: () => void;
}) {
  const [creatingProduct, setCreatingProduct] = useState(false);
  const row = line.rowNumber > 0 ? String(line.rowNumber) : 'nueva';
  const text = (field: LineTextField, label: string, width: string, align = '') => (
    <td className="py-2 pr-2">
      <Input
        aria-label={`${label} de la fila ${row}`}
        className={`h-8 text-xs ${width} ${align}`}
        value={line[field]}
        disabled={disabled}
        onChange={(e) => {
          onEdit(lineEditPatch(line, field, e.target.value));
        }}
      />
    </td>
  );
  return (
    <>
      <tr className="align-top">
        <td className="py-2 pr-2 text-xs text-muted-foreground">{row}</td>
        {shape === 'COIL' && (
          <>
            <td className="py-2 pr-2">
              <SearchSelectField
                label={`Acabado de la fila ${row}`}
                placeholder={line.finishCode || 'Elige el acabado'}
                actionLabel="Elegir"
                options={finishOptions}
                value={line.chosenFinishId ?? line.finishId}
                disabled={disabled}
                onChange={(id) => {
                  onEdit({ chosenFinishId: id });
                }}
              />
            </td>
            {text('color', 'Color', 'w-24')}
            {text('thicknessMm', 'Espesor', 'w-20', 'text-right')}
            {text('widthMm', 'Ancho', 'w-20', 'text-right')}
            {text('qty', 'Kilos', 'w-24', 'text-right')}
          </>
        )}
        {shape === 'FINISHED_GOOD' && (
          <td className="py-2 pr-2">
            <div className="flex items-center gap-1">
              <SearchSelectField
                label={`Producto de la fila ${row}`}
                placeholder={line.sku || 'Elige el producto'}
                actionLabel="Elegir"
                options={productOptions}
                value={line.chosenProductId ?? line.productId}
                disabled={disabled}
                onChange={(id) => {
                  onEdit({ chosenProductId: id });
                }}
              />
              {businessLine !== null && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={disabled}
                  onClick={() => {
                    setCreatingProduct(true);
                  }}
                >
                  + Crear
                </Button>
              )}
            </div>
            {creatingProduct && businessLine !== null && (
              <ProductDialog
                open
                businessLineId={businessLine.id}
                businessLineCode={businessLine.code}
                initial={{ sku: line.sku, name: line.description }}
                onCreated={(created) => {
                  onEdit({ chosenProductId: created.id, sku: created.sku });
                }}
                onOpenChange={setCreatingProduct}
              />
            )}
          </td>
        )}
        {shape !== 'COIL' && (
          <>
            {text('description', 'Descripción', 'w-56')}
            {text('qty', 'Cantidad', 'w-20', 'text-right')}
            {text('unit', 'Unidad', 'w-16')}
          </>
        )}
        {text('unitPrice', 'Precio', 'w-24', 'text-right')}
        {text('lineAmount', 'Importe sin IGV', 'w-24', 'text-right')}
        {shape === 'COIL' && text('externalCode', 'Código externo', 'w-28')}
        <td className="py-2 pr-2 text-right text-xs tabular-nums">{line.subtotal ?? '—'}</td>
        <td className="py-2">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
            Quitar
          </Button>
        </td>
      </tr>
      {line.issues.length > 0 && (
        <tr>
          <td />
          <td colSpan={13} className="pb-2 text-xs text-destructive">
            {line.issues.map((i) => i.message).join(' · ')}
          </td>
        </tr>
      )}
    </>
  );
}

/** Los campos de cabecera que se editan como texto (el servidor los interpreta). */
type HeaderTextField =
  | 'type'
  | 'businessLine'
  | 'docType'
  | 'issueDate'
  | 'currency'
  | 'exchangeRate'
  | 'paymentTerms'
  | 'creditDays'
  | 'serviceKind'
  | 'igvRate';

/** Los campos de línea que se editan como texto. */
type LineTextField =
  | 'color'
  | 'thicknessMm'
  | 'widthMm'
  | 'qty'
  | 'description'
  | 'unit'
  | 'unitPrice'
  | 'lineAmount'
  | 'externalCode';
