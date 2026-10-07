'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  paperCoilWeightCheck,
  type ConfirmLineAction,
  type ConfirmPreviewDto,
  type ConfirmPreviewLineDto,
  type ConfirmQuotationInput,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatKgPrecise, formatQty, unitSymbol } from '@/lib/format';
import { formatExpiry } from '@/components/sales/temporary-reservation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ACTION_LABELS: Record<ConfirmLineAction, string> = {
  PRODUCE: 'Reserva MP y genera OP',
  RESERVE_STOCK: 'Reserva de stock',
  NONE: 'No reserva ni produce',
  CHOOSE_COIL: 'Elige la bobina',
};

/** Lo que el diálogo manda al confirmar, además de la fecha que no pide. */
export type ConfirmQuotationRequest = Pick<
  ConfirmQuotationInput,
  'confirmShortfall' | 'shortfallReason' | 'coilAssignments'
>;

/**
 * D-186: confirmar es **un solo clic después de ver qué va a pasar**: qué se reserva, qué
 * órdenes salen con qué plan, qué líneas no generan nada. Si falta material el botón queda
 * apagado con el faltante dicho línea por línea (la confirmación bloquea, D-054).
 *
 * D-341: para un ADMINISTRADOR el faltante ya no apaga el botón: lo confirma **a conciencia**,
 * con el faltante a la vista, una casilla que lo reconoce y un motivo que queda en la auditoría.
 * El vendedor sigue viendo el bloqueo de siempre.
 */
export function ConfirmQuotationDialog({
  quotationId,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  quotationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: (request: ConfirmQuotationRequest) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  /** D-385: la bobina elegida por línea (`CHOOSE_COIL`). */
  const [coils, setCoils] = useState<Record<number, string>>({});
  // Ni el reconocimiento ni el motivo se arrastran de una apertura a la siguiente: el faltante
  // pudo cambiar, y confirmar «a conciencia» con la casilla marcada de antes no es conciencia.
  // La bobina elegida tampoco: entre una apertura y otra pudo tomarla otro documento.
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setReason('');
      setCoils({});
    }
  }, [open]);
  const preview = useQuery({
    queryKey: ['confirm-preview', quotationId],
    queryFn: () => api<ConfirmPreviewDto>(`/sales/quotations/${quotationId}/confirm-preview`),
    enabled: open,
    // Cada apertura vuelve a leer: el disponible pudo cambiar desde la última vez.
    staleTime: 0,
    gcTime: 0,
  });

  const data = preview.data;
  const withShortfall = data?.canConfirmWithShortfall === true;
  const trimmedReason = reason.trim();
  // Con faltante hace falta reconocerlo y explicarlo (mismo mínimo que el API).
  const shortfallPending = withShortfall && (!acknowledged || trimmedReason.length < 5);
  // D-385: cada línea sin bobina necesita una bobina elegida y dentro de la tolerancia.
  const chooseLines = data?.lines.filter((l) => l.action === 'CHOOSE_COIL') ?? [];
  const coilPending = chooseLines.some((l) => {
    const chosen = l.coilChoices.find((c) => c.coilId === coils[l.lineNumber]);
    return !chosen?.withinTolerance;
  });
  const blocked = !data || data.blockers.length > 0 || shortfallPending || coilPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Confirmar {data?.quotationCode ?? 'cotización'}</DialogTitle>
          <DialogDescription>
            En un solo paso: se crea el pedido, se reserva el material en firme y las líneas que se
            fabrican quedan con su orden de producción en cola.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : preview.isError || !data ? (
          <Alert variant="destructive">
            <AlertDescription>No se pudo calcular la vista previa.</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-3">
            {data.temporaryReservationExpiresAt && (
              <p className="text-sm text-muted-foreground">
                La reserva temporal vigente (vence{' '}
                {formatExpiry(data.temporaryReservationExpiresAt)}) se convierte en firme.
              </p>
            )}
            <div className="max-h-[50vh] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead>Qué pasa</TableHead>
                    <TableHead>Reserva</TableHead>
                    <TableHead className="text-right">Disponible</TableHead>
                    <TableHead>Plan de corte</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((l) => (
                    <TableRow key={l.lineNumber} className="align-top">
                      <TableCell className="text-muted-foreground tabular-nums">
                        {l.lineNumber}
                      </TableCell>
                      <TableCell className="max-w-xs whitespace-normal">
                        <div className="font-medium">{l.productSku}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatQty(l.qty, unitSymbol(l.unit))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={l.action === 'NONE' ? 'outline' : 'secondary'}>
                          {ACTION_LABELS[l.action]}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[14rem] text-xs whitespace-normal">
                        {l.action === 'CHOOSE_COIL' ? (
                          <CoilChoice
                            line={l}
                            value={coils[l.lineNumber] ?? ''}
                            onChange={(coilId) => {
                              setCoils((prev) => ({ ...prev, [l.lineNumber]: coilId }));
                            }}
                          />
                        ) : l.reserveLabel ? (
                          <>
                            {l.reserveLabel}
                            <span className="block tabular-nums">
                              {formatQty(l.reserveQty ?? '0', unitSymbol(l.reserveUnit ?? ''))}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {l.availableQty === null ? (
                          '—'
                        ) : (
                          <span
                            className={l.shortfallQty ? 'font-medium text-destructive' : undefined}
                          >
                            {formatQty(l.availableQty, unitSymbol(l.reserveUnit ?? ''))}
                            {l.shortfallQty && (
                              <span className="block">
                                faltan {formatQty(l.shortfallQty, unitSymbol(l.reserveUnit ?? ''))}
                              </span>
                            )}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[14rem] text-xs whitespace-normal">
                        {l.plan ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data.blockers.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription>
                  <ul className="grid gap-1">
                    {data.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {withShortfall && (
              <Alert variant="warning">
                <AlertDescription className="grid gap-3">
                  <div>
                    <p className="font-medium text-foreground">
                      Falta material: el pedido se confirma con faltante.
                    </p>
                    <ul className="mt-1 grid gap-1">
                      {data.shortfallNotes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs">
                      Se reserva lo que hay y las órdenes de producción salen igual. El pedido queda
                      marcado «Con faltante» hasta que se complete la reserva.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="ack-shortfall"
                      checked={acknowledged}
                      onCheckedChange={(v) => {
                        setAcknowledged(v === true);
                      }}
                    />
                    <Label htmlFor="ack-shortfall">
                      Entiendo que falta material y confirmo el pedido con faltante
                    </Label>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="shortfall-reason">Motivo</Label>
                    <Input
                      id="shortfall-reason"
                      value={reason}
                      maxLength={500}
                      placeholder="Ej.: llega bobina el lunes; el cliente acepta esperar"
                      onChange={(e) => {
                        setReason(e.target.value);
                      }}
                    />
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            disabled={blocked}
            pending={pending}
            pendingText="Confirmando…"
            onClick={() => {
              if (pending || blocked) return;
              onConfirm({
                ...(withShortfall
                  ? { confirmShortfall: true, shortfallReason: trimmedReason }
                  : {}),
                ...(chooseLines.length > 0
                  ? {
                      coilAssignments: chooseLines.map((l) => ({
                        lineNumber: l.lineNumber,
                        saleCoilId: coils[l.lineNumber] ?? '',
                      })),
                    }
                  : {}),
              });
            }}
          >
            {withShortfall ? 'Confirmar con faltante' : 'Confirmar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-385: el selector de bobina de una línea sin bobina asignada. Ofrece **todas** las bobinas
 * libres del SKU; la que cae fuera de la tolerancia del papel se puede elegir para ver por qué no
 * sirve —los dos pesos— y deja el botón apagado. El API vuelve a comprobarlo bajo lock.
 */
function CoilChoice({
  line,
  value,
  onChange,
}: {
  line: ConfirmPreviewLineDto;
  value: string;
  onChange: (coilId: string) => void;
}) {
  if (line.coilChoices.length === 0) {
    return (
      <span className="text-destructive">
        Sin bobina libre de {line.paperSku ?? line.productSku}
      </span>
    );
  }
  const chosen = line.coilChoices.find((c) => c.coilId === value);
  const range = paperCoilWeightCheck(line.qty, chosen?.balanceKg ?? line.qty);
  return (
    <div className="grid gap-1">
      {/* D-385 (A): el papel y la bobina elegida, que puede ser de otro SKU en tolerancia. */}
      <span>
        papel: <span className="font-mono">{line.paperSku ?? line.productSku}</span>
        {chosen && (
          <>
            {' '}
            · bobina:{' '}
            <span className="font-mono font-medium">
              {chosen.productSku} ({chosen.thicknessMm} mm)
            </span>
          </>
        )}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="h-8 w-full text-xs"
          aria-label={`Bobina de la línea ${String(line.lineNumber)}`}
        >
          <SelectValue placeholder="Elige la bobina" />
        </SelectTrigger>
        <SelectContent>
          {line.coilChoices.map((c) => (
            <SelectItem key={c.coilId} value={c.coilId}>
              {c.code} · {c.productSku} {c.thicknessMm} mm · {formatQty(c.balanceKg, 'kg')}
              {c.withinTolerance ? '' : ' · fuera de tolerancia'}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen && !chosen.withinTolerance && (
        <span className="text-destructive">
          {chosen.code} tiene {formatKgPrecise(chosen.balanceKg)} y el papel dice{' '}
          {formatKgPrecise(line.qty)}: tiene que estar entre {formatKgPrecise(range.minKg)} y{' '}
          {formatKgPrecise(range.maxKg)}.
        </span>
      )}
      {!chosen && (
        <span className="text-muted-foreground">Sin bobina asignada: se reserva al confirmar.</span>
      )}
    </div>
  );
}
