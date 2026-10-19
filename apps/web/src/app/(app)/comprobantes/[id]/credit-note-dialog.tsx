'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import {
  businessToday,
  CREDIT_NOTE_GROUP_HINTS,
  CREDIT_NOTE_GROUP_LABELS,
  CREDIT_NOTE_GROUP_REASONS,
  CREDIT_NOTE_GROUPS,
  CREDIT_NOTE_REASON_INFO,
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_REASON_SUNAT_CODE,
  returnsStock,
  toDecimal,
  type CreditNoteGroup,
  type CreditNotePreviewDto,
  type CreditNoteReason,
  type CustomerDto,
  type FiscalDocumentDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/notify';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate, formatMoney, formatQty, unitSymbol } from '@/lib/format';
import {
  creditNoteBody,
  creditNoteDateError,
  creditNoteGroupOfReason,
  emptyCreditNoteDraft,
  paperNumberError,
  type CreditNoteDraft,
} from '@/lib/credit-note-form';
import { cn } from '@/lib/utils';
import { SearchSelectModal } from '@/components/search-select-modal';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * cc54 (D-660, D-661, D-663) — **la nota de crédito en un solo diálogo**, modal ancho.
 *
 * Paso 1, «¿Qué quieres hacer?»: tarjetas por efecto, cada una con sus códigos SUNAT visibles y un
 * (i) por código. Paso 2: solo los campos del motivo, la fecha (D-645), la serie y el número del
 * papel, y «Qué va a pasar» calculado por el API (`credit-note/preview`). Un solo botón principal:
 * registra en un paso (alta, número del papel y lo que el motivo genera). Un comprobante emitido
 * por el ERP sigue el camino electrónico: el botón crea el borrador.
 */
export function CreditNoteDialog({
  document: d,
  open,
  isAdmin,
  onOpenChange,
  onDone,
}: {
  document: FiscalDocumentDto;
  open: boolean;
  isAdmin: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (note: FiscalDocumentDto, manual: boolean) => void;
}) {
  const today = businessToday();
  const manual = d.origin === 'MANUAL';
  // cc58 (D-678): las NC que devuelven mercadería (01, 06, 07) son del administrador; el vendedor
  // arranca en una que sí puede registrar.
  const initialReason: CreditNoteReason = isAdmin ? 'DEVOLUCION_ITEM' : 'DESCUENTO_ITEM';
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<CreditNoteDraft>(() =>
    emptyCreditNoteDraft(initialReason, today),
  );
  const [series, setSeries] = useState('');
  const [correlative, setCorrelative] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customerLabel, setCustomerLabel] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Cancelar y reabrir no arrastra lo escrito la vez anterior.
  useEffect(() => {
    if (open) return;
    setStep(1);
    setDraft(emptyCreditNoteDraft(initialReason, businessToday()));
    setSeries('');
    setCorrelative('');
    setCustomerLabel('');
  }, [open, initialReason]);

  const disabledReason = (reason: CreditNoteReason): string | null => {
    if (!manual && (reason === 'DEVOLUCION_ITEM' || reason === 'DEVOLUCION_TOTAL')) {
      return 'La devolución se registra sobre un comprobante manual';
    }
    if (!manual && reason === 'ANULACION_ERROR_RUC') {
      return 'El reemplazo se registra sobre un comprobante manual';
    }
    if (!isAdmin && reason === 'ANULACION_ERROR_RUC') {
      return 'Cambia el cliente del pedido: lo registra un administrador';
    }
    if (!isAdmin && returnsStock(reason)) {
      return 'Devuelve mercadería al almacén: pídeselo a un administrador';
    }
    if (reason === 'OTROS_AJUSTES' && !(d.docType === 'FACTURA' && d.paymentTerms === 'CREDITO')) {
      return 'Solo en una factura al crédito';
    }
    return null;
  };

  const set = (patch: Partial<CreditNoteDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const choose = (reason: CreditNoteReason) => {
    if (disabledReason(reason) !== null) return;
    setDraft((prev) => ({ ...emptyCreditNoteDraft(reason, prev.issueDate), notes: prev.notes }));
  };

  const dateError = creditNoteDateError(draft.issueDate, d.issueDate, today, isAdmin);
  const built = creditNoteBody(draft);
  const bodyError = 'error' in built ? built.error : null;
  const paperError = manual ? paperNumberError(series, correlative) : null;
  const body = 'body' in built ? built.body : null;
  const bodyKey = dateError === null && body ? JSON.stringify(body) : null;
  const debouncedBody = useDebounced(bodyKey, 400);

  const preview = useQuery({
    queryKey: ['credit-note-preview', d.id, debouncedBody],
    enabled: open && step === 2 && debouncedBody !== null,
    retry: false,
    queryFn: () =>
      api<CreditNotePreviewDto>(`/invoicing/documents/${d.id}/credit-note/preview`, {
        method: 'POST',
        body: JSON.parse(debouncedBody ?? '{}') as unknown,
      }),
  });

  const register = useMutation({
    mutationFn: () => {
      if (!body) throw new Error(bodyError ?? 'Faltan datos');
      return manual
        ? api<FiscalDocumentDto>(`/invoicing/documents/${d.id}/credit-note/register`, {
            method: 'POST',
            body: {
              ...body,
              series: series.trim().toUpperCase(),
              correlative: Number(correlative),
            },
          })
        : api<FiscalDocumentDto>(`/invoicing/documents/${d.id}/credit-note`, {
            method: 'POST',
            body,
          });
    },
    onMutate: () => {
      setStartedAt(Date.now());
      setElapsed(0);
    },
    onSettled: () => {
      setStartedAt(null);
    },
    onSuccess: (note) => {
      onDone(note, manual);
    },
  });

  // El progreso visible mientras se registra (D-660): un registro de devolución tarda segundos.
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => {
      clearInterval(id);
    };
  }, [startedAt]);

  const group = creditNoteGroupOfReason(draft.reason);
  const ready =
    step === 2 &&
    dateError === null &&
    bodyError === null &&
    paperError === null &&
    // Lo que se registra es lo que se previsualizó: no durante la espera del debounce.
    debouncedBody === bodyKey &&
    preview.isSuccess &&
    !preview.isFetching;
  const busy = register.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-5xl" data-testid="credit-note-dialog">
        <DialogHeader>
          <DialogTitle>Nota de crédito para {d.number}</DialogTitle>
          <DialogDescription>
            {d.customerName} · saldo por cobrar {formatMoney(d.balancePen)}
            {d.dueDate ? ` · vence ${formatDate(d.dueDate)}` : ''}
          </DialogDescription>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span className={cn(step === 1 && 'font-semibold text-foreground')}>
              1 · ¿Qué quieres hacer?
            </span>
            <span>›</span>
            <span className={cn(step === 2 && 'font-semibold text-foreground')}>
              2 · Datos de la nota
            </span>
          </div>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">¿Qué quieres hacer con este comprobante?</p>
            <div className="grid grid-cols-3 gap-3">
              {CREDIT_NOTE_GROUPS.map((g) => (
                <GroupCard
                  key={g}
                  group={g}
                  selected={group === g}
                  reason={draft.reason}
                  disabledReason={disabledReason}
                  onChoose={choose}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              No se muestran 08, 09 y 10 (por ahora) ni 11 (exportación) y 12 (IVAP), que no
              aplican.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_320px] gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded-full border bg-muted px-3 py-0.5">
                  Motivo SUNAT {CREDIT_NOTE_REASON_SUNAT_CODE[draft.reason]} ·{' '}
                  {CREDIT_NOTE_REASON_LABELS[draft.reason]}
                </span>
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={busy}
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  cambiar
                </Button>
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <Label htmlFor="cn-date">Fecha de la nota</Label>
                  <Input
                    id="cn-date"
                    type="date"
                    className="w-40"
                    min={d.issueDate}
                    max={today}
                    value={draft.issueDate}
                    // D-645: solo el ADMINISTRADOR elige otra fecha que hoy.
                    disabled={!isAdmin || busy}
                    onChange={(e) => {
                      set({ issueDate: e.target.value });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Entre {formatDate(d.issueDate)} (emisión) y hoy
                  </p>
                </div>
                {manual && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="cn-series">Serie</Label>
                      <Input
                        id="cn-series"
                        className="w-24"
                        placeholder="FC01"
                        value={series}
                        disabled={busy}
                        onChange={(e) => {
                          setSeries(e.target.value);
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="cn-number">Número del papel</Label>
                      <Input
                        id="cn-number"
                        className="w-32"
                        inputMode="numeric"
                        value={correlative}
                        disabled={busy}
                        onChange={(e) => {
                          setCorrelative(e.target.value);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
              {dateError !== null && <p className="text-xs text-destructive">{dateError}</p>}

              <ReasonFields
                document={d}
                draft={draft}
                set={set}
                busy={busy}
                customerLabel={customerLabel}
                onPickCustomer={() => {
                  setPickerOpen(true);
                }}
              />

              <div className="space-y-1">
                <Label htmlFor="cn-notes">Notas internas (opcional)</Label>
                <Input
                  id="cn-notes"
                  value={draft.notes}
                  disabled={busy}
                  maxLength={500}
                  onChange={(e) => {
                    set({ notes: e.target.value });
                  }}
                />
              </div>
            </div>

            <WhatWillHappen
              document={d}
              reason={draft.reason}
              preview={preview.data}
              loading={preview.isFetching}
              error={
                bodyError ??
                dateError ??
                (preview.isError ? errorMessage(preview.error, 'No se pudo calcular') : null)
              }
            />
          </div>
        )}

        <DialogFooter className="items-center">
          {busy && (
            <div
              className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
              role="status"
            >
              <div className="h-1.5 w-40 overflow-hidden rounded bg-muted">
                <div className="h-full w-1/3 animate-pulse rounded bg-primary" />
              </div>
              Registrando la nota y lo que genera… {elapsed} s
            </div>
          )}
          {step === 2 && paperError !== null && !busy && (
            <p className="mr-auto text-xs text-muted-foreground">{paperError}</p>
          )}
          {step === 1 ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => {
                  setStep(2);
                }}
              >
                Continuar
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setStep(1);
                }}
              >
                Atrás
              </Button>
              <Button
                disabled={!ready || busy}
                pending={busy}
                pendingText="Registrando…"
                onClick={() => {
                  if (busy) return;
                  register.mutate();
                }}
              >
                {manual ? 'Registrar nota de crédito' : 'Crear borrador de nota de crédito'}
              </Button>
            </>
          )}
        </DialogFooter>
        {register.isError && (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage(register.error, 'No se pudo registrar la nota de crédito')}
          </p>
        )}

        <SearchSelectModal
          open={pickerOpen}
          title="Cliente correcto"
          description="El comprobante de reemplazo y el pedido pasan a este cliente."
          search={async (q) =>
            (await fetchAllForPicker<CustomerDto>('/customers', { search: q }))
              .filter((c) => c.id !== d.customerId)
              .map((c) => ({ id: c.id, label: c.name, hint: `${c.docType} ${c.docNumber}` }))
          }
          onSelect={(id) => {
            setDraft((prev) => ({ ...prev, replacement: { ...prev.replacement, customerId: id } }));
            setPickerOpen(false);
          }}
          onOpenChange={setPickerOpen}
          emptyMessage="Si no está, créalo primero en Clientes."
        />
        <CustomerLabel id={draft.replacement.customerId} onLabel={setCustomerLabel} />
      </DialogContent>
    </Dialog>
  );
}

/** Resuelve el nombre del cliente elegido para el reemplazo (una consulta, solo si hay uno). */
function CustomerLabel({ id, onLabel }: { id: string; onLabel: (label: string) => void }) {
  const q = useQuery({
    queryKey: ['customer', id],
    enabled: id !== '',
    queryFn: () => api<CustomerDto>(`/customers/${id}`),
  });
  useEffect(() => {
    if (q.data) onLabel(`${q.data.name} (${q.data.docType} ${q.data.docNumber})`);
  }, [q.data, onLabel]);
  return null;
}

function GroupCard({
  group,
  selected,
  reason,
  disabledReason,
  onChoose,
}: {
  group: CreditNoteGroup;
  selected: boolean;
  reason: CreditNoteReason;
  disabledReason: (r: CreditNoteReason) => string | null;
  onChoose: (r: CreditNoteReason) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        selected && 'border-primary bg-primary/5 ring-1 ring-primary',
      )}
      data-testid={`credit-group-${group}`}
    >
      <h3 className="text-sm font-semibold">{CREDIT_NOTE_GROUP_LABELS[group]}</h3>
      <p className="mb-2 text-xs text-muted-foreground">{CREDIT_NOTE_GROUP_HINTS[group]}</p>
      <div className="space-y-1">
        {CREDIT_NOTE_GROUP_REASONS[group].map((r) => {
          const blocked = disabledReason(r);
          const info = CREDIT_NOTE_REASON_INFO[r];
          return (
            <div
              key={r}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1 text-xs',
                r === reason ? 'bg-background font-semibold ring-1 ring-primary' : 'bg-muted',
                blocked !== null && 'opacity-50',
              )}
            >
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                disabled={blocked !== null}
                title={blocked ?? undefined}
                data-testid={`credit-reason-${r}`}
                onClick={() => {
                  onChoose(r);
                }}
              >
                <span className="w-5 font-bold tabular-nums">
                  {CREDIT_NOTE_REASON_SUNAT_CODE[r]}
                </span>
                <span>{CREDIT_NOTE_REASON_LABELS[r]}</span>
              </button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Qué es ${CREDIT_NOTE_REASON_SUNAT_CODE[r]}`}
                    className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <Info className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 text-xs">
                  <p className="font-semibold">
                    {CREDIT_NOTE_REASON_SUNAT_CODE[r]} · {CREDIT_NOTE_REASON_LABELS[r]}
                  </p>
                  <p className="mb-2">{info.what}</p>
                  <dl className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1">
                    <dt className="text-muted-foreground">Cuándo</dt>
                    <dd>{info.when}</dd>
                    <dt className="text-muted-foreground">Almacén</dt>
                    <dd>{info.stock}</dd>
                    <dt className="text-muted-foreground">Ventas</dt>
                    <dd>{info.sales}</dd>
                    <dt className="text-muted-foreground">Cobranzas</dt>
                    <dd>{info.receivables}</dd>
                  </dl>
                  {blocked !== null && <p className="mt-2 text-destructive">{blocked}</p>}
                </PopoverContent>
              </Popover>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Los campos que pide el motivo elegido (y solo esos). */
function ReasonFields({
  document: d,
  draft,
  set,
  busy,
  customerLabel,
  onPickCustomer,
}: {
  document: FiscalDocumentDto;
  draft: CreditNoteDraft;
  set: (patch: Partial<CreditNoteDraft>) => void;
  busy: boolean;
  customerLabel: string;
  onPickCustomer: () => void;
}) {
  const remainingQty = (item: FiscalDocumentDto['items'][number]) =>
    toDecimal(item.qty).minus(toDecimal(item.creditedQty));
  switch (draft.reason) {
    case 'ANULACION_OPERACION':
      return (
        <p className="text-sm text-muted-foreground">
          Acredita todo lo que le queda al comprobante. Lo que salió del almacén por él vuelve
          (DEV-).
        </p>
      );
    case 'DEVOLUCION_TOTAL':
      return (
        <p className="text-sm text-muted-foreground">
          Vuelve todo lo despachado y no devuelto. Si fue solo una parte, elige 07.
        </p>
      );
    case 'DEVOLUCION_ITEM':
      return (
        <table className="w-full text-sm" data-testid="cn-lines">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="text-left">#</th>
              <th className="text-left">Producto</th>
              <th className="text-right">Facturado sin acreditar</th>
              <th className="text-right">Devuelve</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((item) => (
              <tr key={item.id} className="border-t">
                <td>{item.lineNumber}</td>
                <td>{item.productSku ?? item.description}</td>
                <td className="text-right tabular-nums">
                  {formatQty(remainingQty(item).toFixed(3), unitSymbol(item.unit))}
                </td>
                <td className="py-1 text-right">
                  <Input
                    className="ml-auto w-28 text-right"
                    inputMode="decimal"
                    placeholder="0"
                    disabled={busy}
                    value={draft.qty[item.id] ?? ''}
                    onChange={(e) => {
                      set({ qty: { ...draft.qty, [item.id]: e.target.value } });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'DESCUENTO_ITEM':
      return (
        <table className="w-full text-sm" data-testid="cn-lines">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="text-left">#</th>
              <th className="text-left">Producto</th>
              <th className="text-right">Cant.</th>
              <th className="text-right">P. unit. facturado c/IGV</th>
              <th className="text-right">P. unit. nuevo c/IGV</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((item) => (
              <tr key={item.id} className="border-t">
                <td>{item.lineNumber}</td>
                <td>{item.productSku ?? item.description}</td>
                <td className="text-right tabular-nums">
                  {formatQty(item.qty, unitSymbol(item.unit))}
                </td>
                <td className="text-right tabular-nums">
                  {formatMoney(toDecimal(item.totalPen).div(toDecimal(item.qty)).toFixed(4))}
                </td>
                <td className="py-1 text-right">
                  <Input
                    className="ml-auto w-28 text-right"
                    inputMode="decimal"
                    placeholder="—"
                    disabled={busy}
                    value={draft.price[item.id] ?? ''}
                    onChange={(e) => {
                      set({ price: { ...draft.price, [item.id]: e.target.value } });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'DESCUENTO_GLOBAL':
      return (
        <div className="space-y-1">
          <Label htmlFor="cn-amount">Monto a rebajar, con IGV</Label>
          <Input
            id="cn-amount"
            className="w-40"
            inputMode="decimal"
            disabled={busy}
            value={draft.amount}
            onChange={(e) => {
              set({ amount: e.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Se reparte entre las líneas en proporción a lo que les queda. Saldo hoy:{' '}
            {formatMoney(d.balancePen)}.
          </p>
        </div>
      );
    case 'CORRECCION_DESCRIPCION':
      return (
        <table className="w-full text-sm" data-testid="cn-lines">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="text-left">#</th>
              <th className="text-left">Descripción facturada</th>
              <th className="text-left">Descripción corregida</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((item) => (
              <tr key={item.id} className="border-t">
                <td>{item.lineNumber}</td>
                <td className="pr-2">{item.description}</td>
                <td className="py-1">
                  <Input
                    placeholder="(sin cambio)"
                    disabled={busy}
                    value={draft.description[item.id] ?? ''}
                    onChange={(e) => {
                      set({ description: { ...draft.description, [item.id]: e.target.value } });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'OTROS_AJUSTES':
      return (
        <div className="space-y-1">
          <Label htmlFor="cn-due">Vencimiento nuevo (pago único)</Label>
          <Input
            id="cn-due"
            type="date"
            className="w-44"
            min={d.issueDate}
            disabled={busy}
            value={draft.dueDate}
            onChange={(e) => {
              set({ dueDate: e.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">
            Hoy vence el {formatDate(d.dueDate)}. El importe de la factura no cambia. Las cuotas
            quedan para cuando se usen.
          </p>
        </div>
      );
    case 'ANULACION_ERROR_RUC':
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            El comprobante de reemplazo (ya emitido en papel al cliente correcto) lleva las mismas
            líneas e importes. El despacho pasa a él sin salida nueva y el pedido cambia de cliente.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Cliente correcto</Label>
              <Button variant="outline" disabled={busy} onClick={onPickCustomer}>
                {draft.replacement.customerId === ''
                  ? 'Elegir cliente…'
                  : customerLabel || 'Cliente elegido'}
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cn-r-series">Serie del reemplazo</Label>
              <Input
                id="cn-r-series"
                className="w-24"
                placeholder="F001"
                disabled={busy}
                value={draft.replacement.series}
                onChange={(e) => {
                  set({ replacement: { ...draft.replacement, series: e.target.value } });
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cn-r-number">Número del reemplazo</Label>
              <Input
                id="cn-r-number"
                className="w-32"
                inputMode="numeric"
                disabled={busy}
                value={draft.replacement.correlative}
                onChange={(e) => {
                  set({ replacement: { ...draft.replacement, correlative: e.target.value } });
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cn-r-date">Fecha del reemplazo</Label>
              <Input
                id="cn-r-date"
                type="date"
                className="w-40"
                min={d.issueDate}
                disabled={busy}
                value={draft.replacement.issueDate}
                onChange={(e) => {
                  set({ replacement: { ...draft.replacement, issueDate: e.target.value } });
                }}
              />
            </div>
          </div>
        </div>
      );
  }
}

/** El recuadro «Qué va a pasar», con lo que calculó el API. */
function WhatWillHappen({
  document: d,
  reason,
  preview,
  loading,
  error,
}: {
  document: FiscalDocumentDto;
  reason: CreditNoteReason;
  preview: CreditNotePreviewDto | undefined;
  loading: boolean;
  error: string | null;
}) {
  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-2 border-t border-dashed py-1.5 first:border-t-0">
      <div className="w-24 flex-none text-muted-foreground">{label}</div>
      <div className="flex-1">{value}</div>
    </div>
  );
  return (
    <div
      className="h-fit rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs"
      data-testid="credit-note-preview"
      aria-busy={loading}
    >
      <h4 className="mb-1 text-sm font-semibold">Qué va a pasar</h4>
      {error !== null ? (
        <p className="text-destructive">{error}</p>
      ) : !preview ? (
        <p className="text-muted-foreground">{loading ? 'Calculando…' : 'Completa los datos.'}</p>
      ) : (
        <div className={cn(loading && 'opacity-60')}>
          {row(
            'Almacén',
            preview.stock.length === 0 ? (
              <span className="text-muted-foreground">Nada: no se mueve mercadería.</span>
            ) : (
              <>
                Entran{' '}
                {preview.stock.map((s, i) => (
                  <span key={`${s.label}-${String(i)}`}>
                    {i > 0 ? ', ' : ''}
                    <b>{formatQty(s.qty, unitSymbol(s.unit))}</b> de {s.label}, del despacho{' '}
                    {s.dispatch}
                  </span>
                ))}{' '}
                con un documento DEV-, al costo con que salieron
                {/* cc55 (D-664): el costo solo llega a un ADMINISTRADOR. */}
                {preview.costPen === null ? (
                  '.'
                ) : (
                  <>
                    : <b>{formatMoney(preview.costPen)}</b>.
                  </>
                )}
              </>
            ),
          )}
          {row(
            'Venta',
            toDecimal(preview.subtotalPen).isZero() ? (
              <span className="text-muted-foreground">No cambia: ni venta ni costo.</span>
            ) : (
              <>
                Baja <b>{formatMoney(preview.subtotalPen)}</b> sin IGV
                {preview.costPen === null ? null : toDecimal(preview.costPen).gt(0) ? (
                  <>
                    {' '}
                    y el costo <b>{formatMoney(preview.costPen)}</b>
                  </>
                ) : (
                  ' (el costo no cambia)'
                )}
                , en el mes de la nota.
              </>
            ),
          )}
          {row(
            'Saldo',
            reason === 'OTROS_AJUSTES' ? (
              <>
                {formatMoney(preview.receivable.beforePen)}, vence el{' '}
                <b>{formatDate(preview.receivable.dueDateAfter)}</b> (antes,{' '}
                {formatDate(preview.receivable.dueDateBefore)}).
              </>
            ) : (
              <>
                De {formatMoney(preview.receivable.beforePen)} a{' '}
                <b>{formatMoney(preview.receivable.afterPen)}</b>.
              </>
            ),
          )}
          {preview.replacement &&
            row(
              'Reemplazo',
              <>
                {preview.replacement.number} a {preview.replacement.customerName}, por{' '}
                {formatMoney(preview.replacement.totalPen)}. El pedido pasa a ese cliente.
              </>,
            )}
          {row(
            'SUNAT',
            <>
              Nota por <b>{formatMoney(preview.totalPen)}</b>, motivo {preview.sunatCode}, sobre{' '}
              {d.number}.
            </>,
          )}
          {preview.warnings.map((w) => (
            <p
              key={w}
              className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900"
            >
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
