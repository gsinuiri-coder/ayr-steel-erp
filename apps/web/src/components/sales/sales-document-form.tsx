'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  Decimal,
  MAX_SALES_ITEMS,
  salesLineTotals,
  type BusinessLine,
  type BusinessLineDto,
  type CoilDto,
  type CustomerDto,
  type ProductDto,
  type QuotationDto,
  type SalesItemInput,
  type SalesOrderDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatQty, isPositiveDecimal, todayIso, unitSymbol } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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

/**
 * Formulario de cotización y de pedido directo (D-065). Es el mismo formulario porque un
 * pedido directo es exactamente una cotización que se salta el paso de cotizar: si fueran
 * dos, la validación de líneas divergiría y el pedido directo terminaría admitiendo lo que
 * la cotización rechaza.
 *
 * La única diferencia visible es la vigencia, que solo tiene sentido en una cotización.
 *
 * Los totales se calculan con `salesLineTotals` de `@ayr/shared` —la **misma** función que
 * usa el API— para que lo que el vendedor ve mientras tipea sea exactamente lo que se
 * guarda (mismo criterio que el partido de RF-15 y el kilo por pieza de D-059).
 */

interface LineDraft {
  key: number;
  productId: string;
  qty: string;
  unitPricePen: string;
  /** D-066: bobina de la que sale el material prometido. Vacío = se reserva el producto. */
  reserveFromCoilId: string;
  reserveKg: string;
}

function emptyLine(key: number): LineDraft {
  return { key, productId: '', qty: '', unitPricePen: '', reserveFromCoilId: '', reserveKg: '' };
}

export function SalesDocumentForm({ mode }: { mode: 'quotation' | 'order' }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isQuotation = mode === 'quotation';

  const [customerId, setCustomerId] = useState('');
  const [businessLine, setBusinessLine] = useState<BusinessLine | ''>('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [validityDays, setValidityDays] = useState(String(DEFAULT_QUOTATION_VALIDITY_DAYS));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api<CustomerDto[]>('/customers'),
  });
  const businessLines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });
  const products = useQuery({
    queryKey: ['catalog', businessLine],
    queryFn: () => api<ProductDto[]>('/catalog'),
    enabled: businessLine !== '',
  });
  // Solo se reserva material de una bobina abierta; el API valida lo mismo.
  const coils = useQuery({
    queryKey: ['coils', businessLine, 'OPEN'],
    queryFn: () => api<CoilDto[]>(`/coils?businessLine=${businessLine}&status=OPEN`),
    enabled: businessLine !== '',
  });

  const line = businessLines.data?.find((l) => l.code === businessLine);
  const requiresQuotation = line?.quotationRequired ?? false;
  const activeProducts = products.data?.filter(
    (p) => p.isActive && p.businessLineCode === businessLine,
  );
  const productById = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.id, p])),
    [products.data],
  );

  function patchLine(key: number, patch: Partial<LineDraft>): void {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** Al elegir producto se sugiere su precio de lista (D-068); el vendedor lo puede pisar. */
  function chooseProduct(key: number, productId: string): void {
    const product = productById.get(productId);
    patchLine(key, {
      productId,
      unitPricePen: product?.listPricePen ? new Decimal(product.listPricePen).toFixed(4) : '',
    });
  }

  const totals = lines
    .filter((l) => isPositiveDecimal(l.qty) && isPositiveDecimal(l.unitPricePen))
    .map((l) => salesLineTotals({ qty: l.qty, unitPricePen: l.unitPricePen }));
  const subtotal = totals.reduce((acc, t) => acc.plus(t.subtotal), new Decimal(0));
  const igv = totals.reduce((acc, t) => acc.plus(t.igv), new Decimal(0));

  const save = useMutation<QuotationDto | SalesOrderDto, unknown, unknown>({
    mutationFn: (body: unknown) =>
      isQuotation
        ? api<QuotationDto>('/sales/quotations', { method: 'POST', body })
        : api<SalesOrderDto>('/sales/orders', { method: 'POST', body }),
    onSuccess: (created) => {
      toast.success(isQuotation ? 'Cotización creada' : 'Pedido creado');
      invalidateSales(queryClient);
      router.push(isQuotation ? `/cotizaciones/${created.id}` : `/pedidos/${created.id}`);
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : 'No se pudo guardar');
    },
  });

  /**
   * Valida el borrador y devuelve las líneas listas, o el primer error legible. Replica
   * exactamente lo que el API valida (`resolveSalesLines`): el objetivo no es sustituirlo
   * sino evitar el viaje de ida y vuelta, igual que la previsualización del partido (RF-15).
   */
  function validate(): { items: SalesItemInput[] } | { error: string } {
    if (!customerId) return { error: 'Elige un cliente' };
    if (!businessLine) return { error: 'Elige una línea de negocio' };

    const items: SalesItemInput[] = [];
    for (const [index, l] of lines.entries()) {
      const at = `Línea ${index + 1}`;
      if (!l.productId) return { error: `${at}: elige un producto` };
      if (!isPositiveDecimal(l.qty)) {
        return { error: `${at}: la cantidad debe ser mayor a cero` };
      }
      if (!isPositiveDecimal(l.unitPricePen)) {
        return { error: `${at}: escribe un precio unitario mayor a cero` };
      }
      // Los dos campos de la reserva de materia prima van juntos o no van (el API valida lo
      // mismo); acá se dice antes de gastar el viaje.
      const hasCoil = l.reserveFromCoilId !== '';
      const hasKg = l.reserveKg !== '';
      if (hasCoil !== hasKg) {
        return { error: `${at}: para reservar materia prima hacen falta la bobina y los kilos` };
      }
      if (requiresQuotation && !hasCoil) {
        return {
          error: `${at}: en ${BUSINESS_LINE_LABELS[businessLine]} el producto se fabrica contra el pedido; indica de qué bobina y cuántos kilos se reservan`,
        };
      }
      if (hasKg && !isPositiveDecimal(l.reserveKg)) {
        return { error: `${at}: los kilos a reservar deben ser mayores a cero` };
      }
      items.push({
        productId: l.productId,
        qty: l.qty,
        unitPricePen: l.unitPricePen,
        ...(hasCoil ? { reserveFromCoilId: l.reserveFromCoilId, reserveKg: l.reserveKg } : {}),
      });
    }
    return { items };
  }

  function submit(): void {
    setFormError(null);
    const result = validate();
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    const { items } = result;

    save.mutate({
      customerId,
      businessLine,
      issueDate,
      ...(isQuotation ? { validityDays: Number(validityDays) } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      items,
    });
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">
          {isQuotation ? 'Nueva cotización' : 'Nuevo pedido directo'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isQuotation
            ? 'Simulación de precio: no reserva stock. La reserva nace al confirmarla (D-054).'
            : 'Crea el pedido y reserva el material en el acto. Solo en líneas que no exigen cotización.'}
        </p>
      </div>

      {(customers.isError || businessLines.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            No se pudieron cargar los maestros. Recarga la página.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-4">
        <div className="grid gap-2 md:col-span-2">
          <Label htmlFor="customer">Cliente</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger id="customer" className="w-full">
              <SelectValue placeholder="Elige un cliente" />
            </SelectTrigger>
            <SelectContent>
              {customers.data
                ?.filter((c) => c.isActive)
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} — {c.docNumber}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="line">Línea de negocio</Label>
          <Select
            value={businessLine}
            onValueChange={(v) => {
              // Cambiar de línea invalida productos y bobinas ya elegidos: son de otra línea
              // y el API los rechazaría uno por uno con un mensaje por línea.
              setBusinessLine(v as BusinessLine);
              setLines([emptyLine(nextKey)]);
              setNextKey((k) => k + 1);
            }}
          >
            <SelectTrigger id="line" className="w-full">
              <SelectValue placeholder="Elige una línea" />
            </SelectTrigger>
            <SelectContent>
              {businessLines.data
                ?.filter((l) => l.inventoryStrategy === 'STOCK')
                .map((l) => (
                  <SelectItem key={l.id} value={l.code}>
                    {BUSINESS_LINE_LABELS[l.code]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="issue-date">Fecha de emisión</Label>
          <Input
            id="issue-date"
            type="date"
            value={issueDate}
            onChange={(e) => {
              setIssueDate(e.target.value);
            }}
          />
        </div>
        {isQuotation && (
          <div className="grid gap-2">
            <Label htmlFor="validity">Vigencia (días)</Label>
            <Input
              id="validity"
              type="number"
              min={1}
              max={365}
              value={validityDays}
              onChange={(e) => {
                setValidityDays(e.target.value);
              }}
            />
          </div>
        )}
        <div className="grid gap-2 md:col-span-3">
          <Label htmlFor="notes">Observaciones</Label>
          <Input
            id="notes"
            maxLength={500}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
          />
        </div>
      </div>

      {requiresQuotation && (
        <Alert>
          <AlertDescription>
            En {businessLine ? BUSINESS_LINE_LABELS[businessLine] : 'esta línea'} el producto se
            fabrica contra el pedido (RF-31): cada línea reserva kilos de una bobina concreta, no
            producto terminado.
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Producto</TableHead>
              <TableHead className="w-[12%]">Cantidad</TableHead>
              <TableHead className="w-[14%]">P. unitario (sin IGV)</TableHead>
              <TableHead className="w-[22%]">Reserva desde bobina</TableHead>
              <TableHead className="w-[12%]">Kg a reservar</TableHead>
              <TableHead className="text-right">Importe</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, index) => {
              const product = productById.get(l.productId);
              const valid = isPositiveDecimal(l.qty) && isPositiveDecimal(l.unitPricePen);
              const lineTotal = valid
                ? salesLineTotals({ qty: l.qty, unitPricePen: l.unitPricePen }).subtotal
                : null;
              return (
                <TableRow key={l.key}>
                  <TableCell>
                    <Select
                      value={l.productId}
                      onValueChange={(v) => {
                        chooseProduct(l.key, v);
                      }}
                      disabled={businessLine === ''}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={`Producto de la línea ${index + 1}`}
                      >
                        <SelectValue placeholder="Producto" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeProducts?.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.sku} — {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      aria-label={`Cantidad de la línea ${index + 1}`}
                      value={l.qty}
                      onChange={(e) => {
                        patchLine(l.key, { qty: e.target.value });
                      }}
                    />
                    {product && (
                      <span className="text-xs text-muted-foreground">
                        {unitSymbol(product.unit)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      aria-label={`Precio unitario de la línea ${index + 1}`}
                      value={l.unitPricePen}
                      onChange={(e) => {
                        patchLine(l.key, { unitPricePen: e.target.value });
                      }}
                    />
                    {product?.listPricePen && (
                      <span className="text-xs text-muted-foreground">
                        Lista: {formatMoney(product.listPricePen, 'PEN', 4)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={l.reserveFromCoilId}
                      onValueChange={(v) => {
                        patchLine(l.key, { reserveFromCoilId: v });
                      }}
                      disabled={businessLine === ''}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={`Bobina a reservar de la línea ${index + 1}`}
                      >
                        <SelectValue placeholder="Stock del producto" />
                      </SelectTrigger>
                      <SelectContent>
                        {coils.data?.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.code} — {formatQty(c.availableKg, 'kg')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      aria-label={`Kilos a reservar de la línea ${index + 1}`}
                      value={l.reserveKg}
                      disabled={l.reserveFromCoilId === ''}
                      onChange={(e) => {
                        patchLine(l.key, { reserveKg: e.target.value });
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {lineTotal ? formatMoney(lineTotal.toFixed(4)) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Quitar la línea ${index + 1}`}
                      disabled={lines.length === 1}
                      onClick={() => {
                        setLines((current) => current.filter((x) => x.key !== l.key));
                      }}
                    >
                      Quitar
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <Button
          variant="outline"
          disabled={lines.length >= MAX_SALES_ITEMS}
          onClick={() => {
            setLines((current) => [...current, emptyLine(nextKey)]);
            setNextKey((k) => k + 1);
          }}
        >
          Agregar línea
        </Button>
        <div className="min-w-56 space-y-1 text-sm">
          <div className="flex justify-between gap-8">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatMoney(subtotal.toFixed(4))}</span>
          </div>
          <div className="flex justify-between gap-8">
            <span className="text-muted-foreground">IGV (18%)</span>
            <span>{formatMoney(igv.toFixed(4))}</span>
          </div>
          <div className="flex justify-between gap-8 border-t pt-1 font-medium">
            <span>Total</span>
            <span>{formatMoney(subtotal.plus(igv).toFixed(4))}</span>
          </div>
        </div>
      </div>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button disabled={save.isPending} onClick={submit}>
          {save.isPending ? 'Guardando…' : isQuotation ? 'Crear cotización' : 'Crear pedido'}
        </Button>
      </div>
    </>
  );
}
