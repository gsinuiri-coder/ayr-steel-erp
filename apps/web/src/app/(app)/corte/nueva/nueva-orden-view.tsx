'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Decimal,
  MIN_CHILD_WIDTH_MM,
  ProductBomKind,
  Role,
  type CoilDto,
  type CuttingOrderDto,
  type ProductBomDto,
  type SupplierDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { OperationDateField } from '@/components/operation-date-field';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { formatQty, isPositiveDecimal } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface WidthRow {
  /**
   * E (Fase 7e): el ancho ya no se tipea a mano — se elige el SKU de perfil de drywall
   * cuya receta (`product_boms.input_width_mm`, D-059) necesita ese fleje, y el ancho sale
   * de ahí. `widthMm` queda derivado, no editable, para que el plan de corte no invente
   * anchos que ninguna receta consume.
   */
  bomProductId: string;
  widthMm: string;
  stripsCount: string;
}

interface DraftCoil {
  coil: CoilDto;
  widthPlanMm: WidthRow[];
  expectedKerfLossMm: string;
}

/**
 * Enviar bobinas a corte tercerizado (RF-40). El plan de anchos es una intención: el
 * peso real de cada fleje se conoce recién al recibir (RF-41), así que acá solo se
 * valida que los anchos más la merma esperada quepan en el ancho de cada bobina.
 */
export function NuevaOrdenCorteView() {
  const router = useRouter();
  const [supplierId, setSupplierId] = useState('');
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<DraftCoil[]>([]);

  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });
  const cuttingSuppliers = suppliers.data?.filter((s) => s.isActive && s.providesCuttingService);

  // E (Fase 7e): el corte tercerizado es solo para Drywall — Metallic Roofing se rola
  // entero (D-086) y trading/UPVC no fabrican, así que no tienen fleje que enviar.
  const availableCoils = useQuery({
    queryKey: ['coils', 'kind=COIL&status=OPEN&businessLine=drywall'],
    queryFn: () =>
      fetchAllForPicker<CoilDto>('/coils', {
        kind: 'COIL',
        status: 'OPEN',
        businessLine: 'drywall',
      }),
  });
  const addedIds = new Set(drafts.map((d) => d.coil.id));
  const candidates = (availableCoils.data ?? []).filter((c) => !addedIds.has(c.id));

  // E: el ancho de cada fleje sale de la receta del perfil que lo va a consumir
  // (`product_boms.input_width_mm`), no de un campo libre — así el plan de corte nunca
  // pide un ancho que ninguna receta de drywall necesita.
  const boms = useQuery({
    queryKey: ['production', 'boms'],
    queryFn: () => api<ProductBomDto[]>('/production/boms'),
  });
  const drywallBoms = (boms.data ?? []).filter(
    (b) => b.kind === ProductBomKind.DRYWALL && b.isActive && b.inputWidthMm !== null,
  );
  const bomById = new Map(drywallBoms.map((b) => [b.productId, b]));

  // D-124: día de negocio del envío. Enviar a corte no mueve kardex (D-050), así que acá no
  // hay advertencia de orden que confirmar: solo la fecha con la que queda la orden.
  const [operationDate, setOperationDate] = useState<string | undefined>(undefined);
  const send = useMutation({
    mutationFn: () =>
      api<CuttingOrderDto>('/cutting', {
        method: 'POST',
        body: {
          supplierId,
          operationDate,
          notes: notes.trim() || undefined,
          coils: drafts.map((d) => ({
            coilId: d.coil.id,
            widthPlanMm: d.widthPlanMm
              .filter((r) => r.widthMm.trim())
              .map((r) => ({ widthMm: r.widthMm.trim(), stripsCount: stripCount(r.stripsCount) })),
            expectedKerfLossMm: d.expectedKerfLossMm.trim() || '0',
          })),
        },
      }),
    onSuccess: (order) => {
      toast.success('Orden de corte enviada');
      router.push(`/corte/${order.id}`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo enviar la orden'),
  });

  const canSubmit =
    Boolean(supplierId) &&
    drafts.length > 0 &&
    drafts.every((d) => planFits(d) && d.widthPlanMm.some((r) => r.widthMm.trim()));

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div>
        <h1 className="text-2xl font-semibold">Enviar bobinas a corte</h1>
        <p className="text-sm text-muted-foreground">
          El envío no mueve el kardex (D-050): la bobina sigue siendo propia, solo cambia de
          ubicación mientras el tercero la corta.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Proveedor de corte</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1">
            <Label>Proveedor</Label>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Elige un proveedor de corte" />
              </SelectTrigger>
              <SelectContent>
                {cuttingSuppliers?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {suppliers.isError && (
              <p className="text-xs text-destructive">No se pudieron cargar los proveedores.</p>
            )}
            {!suppliers.isError && cuttingSuppliers?.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Ningún proveedor tiene marcado &quot;presta servicio de corte&quot; (RF-81).
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <Label>Notas</Label>
            <Input
              placeholder="Opcional"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bobinas disponibles</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Ancho</TableHead>
                <TableHead className="text-right">Disponible</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {availableCoils.isPending && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {availableCoils.isError && (
                <TableRow>
                  <TableCell colSpan={5} className="text-destructive">
                    No se pudieron cargar las bobinas disponibles.
                  </TableCell>
                </TableRow>
              )}
              {candidates.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono">{c.code}</TableCell>
                  <TableCell>{c.typeKey}</TableCell>
                  <TableCell className="text-right">{c.widthMm} mm</TableCell>
                  <TableCell className="text-right">{formatQty(c.availableKg, 'kg')}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDrafts((prev) => [
                          ...prev,
                          {
                            coil: c,
                            widthPlanMm: [{ bomProductId: '', widthMm: '', stripsCount: '1' }],
                            expectedKerfLossMm: '0',
                          },
                        ]);
                      }}
                    >
                      Agregar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!availableCoils.isPending && !availableCoils.isError && candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No hay bobinas abiertas disponibles.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {drafts.map((draft, draftIndex) => (
        <DraftCoilCard
          key={draft.coil.id}
          draft={draft}
          drywallBoms={drywallBoms}
          bomById={bomById}
          onChange={(next) => {
            setDrafts((prev) => prev.map((d, i) => (i === draftIndex ? next : d)));
          }}
          onRemove={() => {
            setDrafts((prev) => prev.filter((_, i) => i !== draftIndex));
          }}
        />
      ))}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <OperationDateField value={operationDate} onChange={setOperationDate} />
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button
          disabled={!canSubmit || send.isPending}
          onClick={() => {
            send.mutate();
          }}
        >
          {send.isPending ? 'Enviando…' : `Enviar ${drafts.length} bobina(s)`}
        </Button>
      </div>
    </RoleGate>
  );
}

function DraftCoilCard({
  draft,
  drywallBoms,
  bomById,
  onChange,
  onRemove,
}: {
  draft: DraftCoil;
  drywallBoms: ProductBomDto[];
  bomById: Map<string, ProductBomDto>;
  onChange: (next: DraftCoil) => void;
  onRemove: () => void;
}) {
  const fit = planFits(draft);
  // E: kg teóricos del plan (informativo) — la misma proporción por ancho que
  // `validateWidthBudget`/`planCoilSplit` ya usan, aplicada al disponible de la bobina en
  // vez de a un peso recibido (que todavía no existe: RF-41 ajusta contra lo real).
  const theoreticalKg = draft.widthPlanMm
    .filter((r) => r.widthMm.trim() && isPositiveDecimal(r.widthMm))
    .reduce((acc, r) => {
      const share = new Decimal(r.widthMm).times(stripCount(r.stripsCount));
      return acc.plus(share.div(draft.coil.widthMm).times(draft.coil.availableKg));
    }, new Decimal(0));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="font-mono text-base">
          {draft.coil.code} · {draft.coil.widthMm} mm
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Quitar
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1 md:w-48">
          <Label>Merma esperada (mm)</Label>
          <Input
            inputMode="decimal"
            value={draft.expectedKerfLossMm}
            onChange={(e) => {
              onChange({ ...draft, expectedKerfLossMm: e.target.value });
            }}
          />
        </div>
        <div className="grid gap-2">
          <Label>Plan de corte (por SKU de perfil)</Label>
          {draft.widthPlanMm.map((row, rowIndex) => {
            const bom = bomById.get(row.bomProductId);
            return (
              <div key={rowIndex} className="flex items-center gap-2">
                <Select
                  value={row.bomProductId}
                  onValueChange={(v) => {
                    const chosen = bomById.get(v);
                    const rows = draft.widthPlanMm.map((r, i) =>
                      i === rowIndex
                        ? { ...r, bomProductId: v, widthMm: chosen?.inputWidthMm ?? '' }
                        : r,
                    );
                    onChange({ ...draft, widthPlanMm: rows });
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={`SKU de perfil de la fila ${rowIndex + 1}`}
                  >
                    <SelectValue placeholder="Elige el perfil que consume este fleje" />
                  </SelectTrigger>
                  <SelectContent>
                    {drywallBoms.map((b) => (
                      <SelectItem key={b.productId} value={b.productId}>
                        {b.productSku} — {b.productName} ({b.inputWidthMm} mm)
                      </SelectItem>
                    ))}
                    {drywallBoms.length === 0 && (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        Ningún perfil de drywall tiene receta activa (D-059).
                      </div>
                    )}
                  </SelectContent>
                </Select>
                <Input
                  aria-label={`Cantidad de flejes de la fila ${rowIndex + 1}`}
                  className="w-24"
                  inputMode="numeric"
                  value={row.stripsCount}
                  onChange={(e) => {
                    const rows = draft.widthPlanMm.map((r, i) =>
                      i === rowIndex ? { ...r, stripsCount: e.target.value } : r,
                    );
                    onChange({ ...draft, widthPlanMm: rows });
                  }}
                />
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {bom ? `${bom.inputWidthMm} mm` : '—'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={draft.widthPlanMm.length === 1}
                  onClick={() => {
                    onChange({
                      ...draft,
                      widthPlanMm: draft.widthPlanMm.filter((_, i) => i !== rowIndex),
                    });
                  }}
                >
                  Quitar
                </Button>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              onChange({
                ...draft,
                widthPlanMm: [
                  ...draft.widthPlanMm,
                  { bomProductId: '', widthMm: '', stripsCount: '1' },
                ],
              });
            }}
          >
            Agregar fila
          </Button>
        </div>
        <p className={`text-sm ${fit.error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {fit.error ??
            `Consume ${fit.consumedWidthMm} mm de ${draft.coil.widthMm} mm (queda ${fit.remainingWidthMm} mm) · ≈ ${theoreticalKg.toFixed(3)} kg teóricos.`}
        </p>
      </CardContent>
    </Card>
  );
}

function stripCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Presupuesto de ancho en el cliente (RF-40): igual chequeo que `validateWidthBudget`
 * del API, sin el peso —que todavía no existe— para que el operario vea de entrada si
 * el plan cabe en la bobina antes de mandarlo.
 */
function planFits(draft: DraftCoil): {
  error: string | null;
  consumedWidthMm: string;
  remainingWidthMm: string;
} {
  const parentWidth = new Decimal(draft.coil.widthMm);
  const kerf = isPositiveDecimal(draft.expectedKerfLossMm)
    ? new Decimal(draft.expectedKerfLossMm)
    : new Decimal(0);

  const rows = draft.widthPlanMm.filter((r) => r.widthMm.trim());
  if (rows.some((r) => !isPositiveDecimal(r.widthMm))) {
    return { error: 'Ancho inválido.', consumedWidthMm: '0.00', remainingWidthMm: '0.00' };
  }
  const widthsTotal = rows.reduce(
    (acc, r) => acc.plus(new Decimal(r.widthMm).times(stripCount(r.stripsCount))),
    new Decimal(0),
  );
  const consumed = widthsTotal.plus(kerf);
  const remaining = parentWidth.minus(consumed);

  let error: string | null = null;
  if (rows.some((r) => new Decimal(r.widthMm).lt(MIN_CHILD_WIDTH_MM))) {
    error = `El ancho de cada fleje debe ser de al menos ${MIN_CHILD_WIDTH_MM} mm.`;
  } else if (consumed.gt(parentWidth)) {
    error = `Los anchos más la merma esperada (${consumed.toFixed(2)} mm) superan el ancho de la bobina (${draft.coil.widthMm} mm).`;
  }

  return { error, consumedWidthMm: consumed.toFixed(2), remainingWidthMm: remaining.toFixed(2) };
}
