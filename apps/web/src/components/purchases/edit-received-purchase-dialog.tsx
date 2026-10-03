'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CURRENCY_LABELS,
  Decimal,
  FINISH_FIELD_LABEL,
  PAYMENT_TERMS,
  PAYMENT_TERMS_LABELS,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_DOC_TYPES,
  PurchaseType,
  finishLabels,
  type CommitReceivedPurchaseEditInput,
  type EditReceivedPurchaseInput,
  type FinishDto,
  type PaymentTerms,
  type ProductDto,
  type PurchaseDocType,
  type PurchaseDto,
  type ReceivedEditPath,
  type ReceivedEditPlanDto,
  type ReceivedPurchaseHeaderEdit,
  type ReceivedPurchaseItemEdit,
  type SupplierDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type PurchaseItem = PurchaseDto['items'][number];

/** Lo editable de una línea, como texto: los importes nunca pasan por `number` (D-003). */
interface ItemDraft {
  unitPrice: string;
  qty: string;
  productId: string;
  finishId: string;
  widthMm: string;
  thicknessMm: string;
}

interface HeaderDraft {
  supplierId: string;
  docType: PurchaseDocType;
  series: string;
  number: string;
  issueDate: string;
  paymentTerms: PaymentTerms;
  creditDays: string;
  notes: string;
}

const PRICE_PATTERN = /^\d+(\.\d{1,4})?$/;
const QTY_PATTERN = /^\d+(\.\d{1,3})?$/;
const MM_PATTERN = /^\d+(\.\d{1,2})?$/;

const PATH_LABELS: Record<ReceivedEditPath, string> = {
  IN_PLACE: 'Se edita',
  REVERSE_REENTRY: 'Reversa y nuevo ingreso',
  COST_ADJUST: 'Ajuste sobre lo que queda',
  BLOCKED: 'Bloqueado',
};
const PATH_TONE: Record<ReceivedEditPath, 'secondary' | 'warning' | 'destructive'> = {
  IN_PLACE: 'secondary',
  REVERSE_REENTRY: 'warning',
  COST_ADJUST: 'warning',
  BLOCKED: 'destructive',
};

function validDecimal(value: string, pattern: RegExp): boolean {
  const v = value.trim();
  return pattern.test(v) && new Decimal(v).gt(0);
}

/** `true` si el valor escrito difiere del guardado. Solo se llama con valores válidos. */
function decimalChanged(value: string, current: string | null): boolean {
  if (current === null) return true;
  return !new Decimal(value.trim()).equals(new Decimal(current));
}

function initialHeader(p: PurchaseDto): HeaderDraft {
  return {
    supplierId: p.supplierId,
    docType: p.docType,
    series: p.series,
    number: p.number,
    issueDate: p.issueDate.slice(0, 10),
    paymentTerms: p.paymentTerms,
    creditDays: p.creditDays === null ? '' : String(p.creditDays),
    notes: p.notes ?? '',
  };
}

function initialItem(item: PurchaseItem): ItemDraft {
  return {
    unitPrice: item.unitPrice,
    qty: item.qty,
    productId: item.productId ?? '',
    finishId: item.finishId ?? '',
    widthMm: item.widthMm ?? '',
    thicknessMm: item.thicknessMm ?? '',
  };
}

/**
 * D-372 (cc14) — editar una compra ya recibida.
 *
 * La pantalla junta lo que se quiere cambiar y lo manda a la vista previa del API, que clasifica
 * cada cambio (se edita en la fila, reversa y nuevo ingreso, o bloqueado y por qué). Solo con una
 * vista previa ejecutable y vigente —cualquier cambio en los campos la invalida— se puede guardar,
 * con motivo. Se envían únicamente los campos que difieren de lo guardado.
 */
export function EditReceivedPurchaseDialog({
  purchase: p,
  onClose,
  onSaved,
}: {
  purchase: PurchaseDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [header, setHeader] = useState<HeaderDraft>(() => initialHeader(p));
  const [items, setItems] = useState<Record<string, ItemDraft>>(() =>
    Object.fromEntries(p.items.map((item) => [item.id, initialItem(item)])),
  );
  const [reason, setReason] = useState('');
  // La vista previa queda atada al cuerpo que la produjo: si los campos cambian, deja de valer.
  const [plan, setPlan] = useState<{ key: string; data: ReceivedEditPlanDto } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const isCoil = p.type === PurchaseType.COIL;
  const isFinishedGood = p.type === PurchaseType.FINISHED_GOOD;
  const editsLines = isCoil || isFinishedGood;

  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });
  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: isCoil,
  });
  const products = useQuery({
    queryKey: ['catalog', p.businessLine],
    queryFn: () => api<ProductDto[]>(`/catalog?businessLine=${p.businessLine}`),
    enabled: isFinishedGood,
  });

  // --- validación y diferencias ------------------------------------------------------------

  const errors: string[] = [];
  const headerEdit: ReceivedPurchaseHeaderEdit = {};
  const series = header.series.trim().toUpperCase();
  const number = header.number.trim();
  // cc15: serie y número se validan solo si cambian. Un dato viejo fuera del formato actual no
  // tiene que bloquear la corrección de un precio.
  const seriesOk = series === p.series || /^[A-Z0-9]{1,10}$/.test(series);
  const numberOk = number === p.number || /^[0-9]{1,20}$/.test(number);
  const issueDateOk = /^\d{4}-\d{2}-\d{2}$/.test(header.issueDate);
  const creditDaysText = header.creditDays.trim();
  const creditDaysOk =
    header.paymentTerms !== 'CREDITO' ||
    (/^\d{1,3}$/.test(creditDaysText) &&
      Number.parseInt(creditDaysText, 10) >= 1 &&
      Number.parseInt(creditDaysText, 10) <= 365);
  const notes = header.notes.trim();
  if (!seriesOk) errors.push('Serie inválida (ej: F001)');
  if (!numberOk) errors.push('El número solo admite dígitos');
  if (!issueDateOk) errors.push('Fecha de emisión inválida');
  if (!creditDaysOk) errors.push('Días de crédito: un entero entre 1 y 365');
  if (notes.length > 500) errors.push('Observaciones: máximo 500 caracteres');

  if (header.supplierId !== p.supplierId) headerEdit.supplierId = header.supplierId;
  if (header.docType !== p.docType) headerEdit.docType = header.docType;
  if (seriesOk && series !== p.series) headerEdit.series = series;
  if (numberOk && number !== p.number) headerEdit.number = number;
  if (issueDateOk && header.issueDate !== p.issueDate.slice(0, 10)) {
    headerEdit.issueDate = header.issueDate;
  }
  if (header.paymentTerms !== p.paymentTerms) headerEdit.paymentTerms = header.paymentTerms;
  if (header.paymentTerms === 'CREDITO' && creditDaysOk) {
    const days = Number.parseInt(creditDaysText, 10);
    if (days !== p.creditDays) headerEdit.creditDays = days;
  }
  if (notes.length <= 500 && notes !== (p.notes ?? '')) {
    headerEdit.notes = notes === '' ? null : notes;
  }

  const itemEdits: ReceivedPurchaseItemEdit[] = [];
  if (editsLines) {
    for (const item of p.items) {
      const draft = items[item.id];
      if (!draft) continue;
      const edit: ReceivedPurchaseItemEdit = { itemId: item.id };
      const line = `Línea ${String(item.lineNumber)}`;
      if (!validDecimal(draft.unitPrice, PRICE_PATTERN)) {
        errors.push(`${line}: precio mayor a cero, hasta 4 decimales`);
      } else if (decimalChanged(draft.unitPrice, item.unitPrice)) {
        edit.unitPrice = draft.unitPrice.trim();
      }
      if (!validDecimal(draft.qty, QTY_PATTERN)) {
        errors.push(`${line}: cantidad mayor a cero, hasta 3 decimales`);
      } else if (decimalChanged(draft.qty, item.qty)) {
        edit.qty = draft.qty.trim();
      }
      if (isFinishedGood && draft.productId && draft.productId !== item.productId) {
        edit.productId = draft.productId;
      }
      if (isCoil) {
        if (draft.finishId && draft.finishId !== item.finishId) edit.finishId = draft.finishId;
        if (!validDecimal(draft.widthMm, MM_PATTERN)) {
          errors.push(`${line}: ancho mayor a cero, hasta 2 decimales`);
        } else if (decimalChanged(draft.widthMm, item.widthMm)) {
          edit.widthMm = draft.widthMm.trim();
        }
        if (!validDecimal(draft.thicknessMm, MM_PATTERN)) {
          errors.push(`${line}: espesor mayor a cero, hasta 2 decimales`);
        } else if (decimalChanged(draft.thicknessMm, item.thicknessMm)) {
          edit.thicknessMm = draft.thicknessMm.trim();
        }
      }
      if (Object.keys(edit).length > 1) itemEdits.push(edit);
    }
  }

  const payload: EditReceivedPurchaseInput = {};
  if (Object.keys(headerEdit).length > 0) payload.header = headerEdit;
  if (itemEdits.length > 0) payload.items = itemEdits;
  const payloadKey = JSON.stringify(payload);
  const hasChanges = payload.header !== undefined || payload.items !== undefined;
  const currentPlan = plan?.key === payloadKey ? plan.data : null;

  // --- mutaciones --------------------------------------------------------------------------

  const preview = useMutation({
    mutationFn: (body: EditReceivedPurchaseInput) =>
      api<ReceivedEditPlanDto>(`/purchases/${p.id}/received-edit/preview`, {
        method: 'POST',
        body,
      }),
    onMutate: () => {
      setPreviewError(null);
    },
    onSuccess: (data, body) => {
      setPlan({ key: JSON.stringify(body), data });
    },
    onError: (err) => {
      setPlan(null);
      setPreviewError(err instanceof ApiError ? err.message : 'No se pudo revisar los cambios');
    },
  });

  // cc15: un mismo envío (doble click, reintento tras un corte de red) se aplica una sola vez.
  // La clave es del contenido: si se corrige el formulario, el envío es otro.
  const commitKey = useIdempotencyKey();
  const commit = useMutation({
    mutationFn: (body: CommitReceivedPurchaseEditInput) =>
      api<PurchaseDto>(`/purchases/${p.id}/received-edit`, {
        method: 'POST',
        body: { ...body, idempotencyKey: commitKey.current(JSON.stringify(body)) },
      }),
    onSettled: (_data, error) => {
      commitKey.settle(error ?? undefined);
    },
    onSuccess: () => {
      toast.success('Compra corregida');
      onSaved();
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo corregir la compra');
    },
  });

  const trimmedReason = reason.trim();
  const reasonOk = trimmedReason.length >= 3 && trimmedReason.length <= 240;
  const canReview = hasChanges && errors.length === 0 && !preview.isPending && !commit.isPending;
  const canSave =
    currentPlan !== null &&
    currentPlan.executable &&
    reasonOk &&
    errors.length === 0 &&
    !preview.isPending;

  // Cualquier cambio en los campos borra la vista previa: hay que volver a revisar.
  const touch = () => {
    setPlan(null);
    setPreviewError(null);
  };
  const setHeaderField = <K extends keyof HeaderDraft>(key: K, value: HeaderDraft[K]) => {
    touch();
    setHeader((prev) => ({ ...prev, [key]: value }));
  };
  const setItemField = (itemId: string, key: keyof ItemDraft, value: string) => {
    touch();
    setItems((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      return { ...prev, [itemId]: { ...current, [key]: value } };
    });
  };

  // --- opciones de los selects ------------------------------------------------------------

  const supplierOptions = (suppliers.data ?? []).filter(
    (s) => s.isActive || s.id === header.supplierId,
  );
  const finishOptions = (finishes.data ?? []).filter(
    (f) =>
      p.items.some((item) => item.finishId === f.id) ||
      (f.isActive && f.kind !== null && f.businessLine === p.businessLine),
  );
  const finishLabelMap = finishLabels(finishOptions);
  const productOptions = (products.data ?? []).filter(
    (prod) => prod.isActive || p.items.some((item) => item.productId === prod.id),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !commit.isPending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-6xl"
        data-testid="received-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle>Editar la compra {p.documentLabel}</DialogTitle>
          <DialogDescription>
            La compra ya está recibida. Las cantidades solo cambian en ítems sin movimientos
            posteriores. El precio se corrige siempre que nada lo bloquee: si el ítem ya se
            consumió, con un ajuste sobre lo que queda de esta compra, y lo que ya salió no se
            recalcula. Para deshacer una corrección, se vuelve a editar al valor anterior. Moneda,
            tipo de cambio y fecha de recepción no se editan acá.
          </DialogDescription>
        </DialogHeader>

        <section className="grid gap-3">
          <h3 className="text-sm font-medium">Comprobante</h3>
          <div className="grid grid-cols-12 gap-x-3 gap-y-2">
            <div className="col-span-5 grid gap-1">
              <Label htmlFor="re-supplier">Proveedor</Label>
              <Select
                value={header.supplierId}
                onValueChange={(v) => {
                  setHeaderField('supplierId', v);
                }}
              >
                <SelectTrigger id="re-supplier" className="w-full">
                  <SelectValue placeholder={`${p.supplierCode} — ${p.supplierName}`} />
                </SelectTrigger>
                <SelectContent>
                  {supplierOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {suppliers.isError && (
                <p className="text-xs text-destructive">No se pudieron cargar los proveedores.</p>
              )}
            </div>
            <div className="col-span-3 grid gap-1">
              <Label htmlFor="re-doctype">Tipo de comprobante</Label>
              <Select
                value={header.docType}
                onValueChange={(v) => {
                  setHeaderField('docType', v as PurchaseDocType);
                }}
              >
                <SelectTrigger id="re-doctype" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PURCHASE_DOC_TYPES.map((d) => (
                    <SelectItem key={d} value={d}>
                      {PURCHASE_DOC_TYPE_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 grid gap-1">
              <Label htmlFor="re-series">Serie</Label>
              <Input
                id="re-series"
                autoComplete="off"
                value={header.series}
                aria-invalid={!seriesOk}
                onChange={(e) => {
                  setHeaderField('series', e.target.value.toUpperCase());
                }}
              />
            </div>
            <div className="col-span-2 grid gap-1">
              <Label htmlFor="re-number">Número</Label>
              <Input
                id="re-number"
                autoComplete="off"
                value={header.number}
                aria-invalid={!numberOk}
                onChange={(e) => {
                  setHeaderField('number', e.target.value);
                }}
              />
            </div>
            <div className="col-span-3 grid gap-1">
              <Label htmlFor="re-issue-date">Fecha de emisión</Label>
              <Input
                id="re-issue-date"
                type="date"
                value={header.issueDate}
                aria-invalid={!issueDateOk}
                onChange={(e) => {
                  setHeaderField('issueDate', e.target.value);
                }}
              />
            </div>
            <div className="col-span-3 grid gap-1">
              <Label htmlFor="re-terms">Condición de pago</Label>
              <Select
                value={header.paymentTerms}
                onValueChange={(v) => {
                  setHeaderField('paymentTerms', v as PaymentTerms);
                }}
              >
                <SelectTrigger id="re-terms" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TERMS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PAYMENT_TERMS_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {header.paymentTerms === 'CREDITO' && (
              <div className="col-span-2 grid gap-1">
                <Label htmlFor="re-credit-days">Días de crédito</Label>
                <Input
                  id="re-credit-days"
                  inputMode="numeric"
                  value={header.creditDays}
                  aria-invalid={!creditDaysOk}
                  onChange={(e) => {
                    setHeaderField('creditDays', e.target.value);
                  }}
                />
              </div>
            )}
            <div className="col-span-12 grid gap-1">
              <Label htmlFor="re-notes">Observaciones</Label>
              <Input
                id="re-notes"
                autoComplete="off"
                placeholder="Opcional"
                maxLength={500}
                value={header.notes}
                onChange={(e) => {
                  setHeaderField('notes', e.target.value);
                }}
              />
            </div>
          </div>
        </section>

        {editsLines ? (
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">
              {isCoil ? 'Bobinas' : 'Detalle'} — precios en {CURRENCY_LABELS[p.currency]}, sin IGV
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>{isCoil ? 'Bobina' : 'Producto'}</TableHead>
                  {isCoil && <TableHead>{FINISH_FIELD_LABEL}</TableHead>}
                  {isCoil && <TableHead className="text-right">Ancho (mm)</TableHead>}
                  {isCoil && <TableHead className="text-right">Espesor (mm)</TableHead>}
                  <TableHead className="text-right">Cantidad</TableHead>
                  <TableHead className="text-right">Precio unitario</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.items.map((item) => {
                  const draft = items[item.id];
                  if (!draft) return null;
                  const n = String(item.lineNumber);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>{item.lineNumber}</TableCell>
                      <TableCell className="min-w-56">
                        {isFinishedGood ? (
                          <Select
                            value={draft.productId}
                            onValueChange={(v) => {
                              setItemField(item.id, 'productId', v);
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-full"
                              aria-label={`Producto de la línea ${n}`}
                            >
                              <SelectValue
                                placeholder={`${item.productSku ?? ''} ${item.description}`}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {productOptions.map((prod) => (
                                <SelectItem key={prod.id} value={prod.id}>
                                  {prod.sku} — {prod.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="font-mono text-xs">
                            {item.coilCode ?? item.description}
                          </span>
                        )}
                      </TableCell>
                      {isCoil && (
                        <TableCell className="min-w-40">
                          <Select
                            value={draft.finishId}
                            onValueChange={(v) => {
                              setItemField(item.id, 'finishId', v);
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              className="w-full"
                              aria-label={`Acabado de la línea ${n}`}
                            >
                              <SelectValue placeholder={item.finishCode ?? 'Elige'} />
                            </SelectTrigger>
                            <SelectContent>
                              {finishOptions.map((f) => (
                                <SelectItem key={f.id} value={f.id}>
                                  {finishLabelMap.get(f.id) ?? f.code}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      )}
                      {isCoil && (
                        <TableCell>
                          <Input
                            className="h-7 w-24 text-right"
                            inputMode="decimal"
                            aria-label={`Ancho (mm) de la línea ${n}`}
                            aria-invalid={!validDecimal(draft.widthMm, MM_PATTERN)}
                            value={draft.widthMm}
                            onChange={(e) => {
                              setItemField(item.id, 'widthMm', e.target.value);
                            }}
                          />
                        </TableCell>
                      )}
                      {isCoil && (
                        <TableCell>
                          <Input
                            className="h-7 w-24 text-right"
                            inputMode="decimal"
                            aria-label={`Espesor (mm) de la línea ${n}`}
                            aria-invalid={!validDecimal(draft.thicknessMm, MM_PATTERN)}
                            value={draft.thicknessMm}
                            onChange={(e) => {
                              setItemField(item.id, 'thicknessMm', e.target.value);
                            }}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Input
                          className="h-7 w-28 text-right"
                          inputMode="decimal"
                          aria-label={`Cantidad de la línea ${n}`}
                          aria-invalid={!validDecimal(draft.qty, QTY_PATTERN)}
                          value={draft.qty}
                          onChange={(e) => {
                            setItemField(item.id, 'qty', e.target.value);
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="h-7 w-28 text-right"
                          inputMode="decimal"
                          aria-label={`Precio unitario de la línea ${n}`}
                          aria-invalid={!validDecimal(draft.unitPrice, PRICE_PATTERN)}
                          value={draft.unitPrice}
                          onChange={(e) => {
                            setItemField(item.id, 'unitPrice', e.target.value);
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {(finishes.isError || products.isError) && (
              <p className="text-xs text-destructive">
                No se pudieron cargar las opciones de las líneas.
              </p>
            )}
          </section>
        ) : (
          <p className="text-xs text-muted-foreground">
            En una compra de servicio o gasto solo se edita el comprobante: sus líneas no tocan
            inventario.
          </p>
        )}

        {errors.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={!canReview}
            pending={preview.isPending}
            pendingText="Revisando…"
            onClick={() => {
              if (!canReview) return;
              preview.mutate(payload);
            }}
          >
            Revisar cambios
          </Button>
          {!hasChanges && (
            <span className="text-xs text-muted-foreground">
              Todavía no hay cambios respecto de lo guardado.
            </span>
          )}
          {hasChanges && !currentPlan && !preview.isPending && errors.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Revisa los cambios antes de guardar.
            </span>
          )}
        </div>

        {previewError && (
          <p role="alert" className="text-sm text-destructive">
            {previewError}
          </p>
        )}

        {currentPlan && (
          <section className="grid gap-2" data-testid="received-edit-preview">
            <h3 className="text-sm font-medium">Cambios a aplicar</h3>
            {currentPlan.changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No hay cambios respecto de lo guardado.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Línea</TableHead>
                    <TableHead>Campo</TableHead>
                    <TableHead>Antes</TableHead>
                    <TableHead>Después</TableHead>
                    <TableHead>Camino</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {currentPlan.changes.map((change, index) => (
                    <TableRow
                      // Un mismo campo puede repetirse en líneas distintas.
                      key={`${String(change.lineNumber)}-${change.field}-${String(index)}`}
                      data-testid="received-edit-change"
                      data-path={change.path}
                    >
                      <TableCell>{change.lineNumber ?? 'Cabecera'}</TableCell>
                      <TableCell>{change.label}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {change.before ?? '—'}
                      </TableCell>
                      <TableCell>{change.after ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={PATH_TONE[change.path]}>{PATH_LABELS[change.path]}</Badge>
                        {change.path === 'BLOCKED' && change.blockedReason && (
                          <p className="mt-1 text-xs text-destructive">{change.blockedReason}</p>
                        )}
                        {change.adjustment && (
                          <div
                            className="mt-1 grid gap-1 text-xs"
                            data-testid="received-edit-adjustment"
                          >
                            <p>
                              Quedan {change.adjustment.remainingQty} de esta compra: ajuste de{' '}
                              <strong>S/ {change.adjustment.amountPen}</strong> con la fecha de hoy.
                            </p>
                            {change.adjustment.affected.length > 0 && (
                              <div>
                                <p className="text-muted-foreground">
                                  Ya salió al costo anterior (no se recalcula):
                                </p>
                                <ul className="list-disc pl-4" data-testid="received-edit-affected">
                                  {change.adjustment.affected.map((a, i) => (
                                    <li key={`${a.document}-${a.operationDate}-${String(i)}`}>
                                      {a.operationDate} · {a.document} · {a.qty} a {a.unitCost}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(currentPlan.warnings ?? []).length > 0 && (
              <ul
                className="grid list-disc gap-1 pl-4 text-xs text-amber-700 dark:text-amber-400"
                data-testid="received-edit-warnings"
              >
                {(currentPlan.warnings ?? []).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {!currentPlan.executable && currentPlan.changes.length > 0 && (
              <p className="text-xs text-destructive">
                Hay cambios bloqueados: corrígelos o devuélvelos a su valor para poder guardar.
              </p>
            )}
          </section>
        )}

        <div className="grid gap-1">
          <Label htmlFor="re-reason">Motivo</Label>
          <textarea
            id="re-reason"
            rows={2}
            maxLength={240}
            placeholder="Por qué se corrige la compra"
            className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-[13px] dark:bg-input/30"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          {trimmedReason.length > 0 && trimmedReason.length < 3 && (
            <p className="text-xs text-destructive">Explica el motivo en al menos 3 caracteres.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={commit.isPending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!canSave}
            pending={commit.isPending}
            pendingText="Guardando…"
            onClick={() => {
              // Guard contra el doble Enter antes del repintado (F8-S1/M1).
              if (!canSave || commit.isPending) return;
              commit.mutate({ ...payload, reason: trimmedReason });
            }}
          >
            Guardar cambios
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
