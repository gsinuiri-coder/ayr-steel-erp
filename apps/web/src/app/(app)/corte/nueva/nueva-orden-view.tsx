'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  Decimal,
  MIN_CHILD_WIDTH_MM,
  Role,
  type CoilDto,
  type CuttingOrderDto,
  type ProductDto,
  type SupplierDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { FilmOpenNotice } from '@/components/film-open-notice';
import { drywallProfilesOf, type DrywallProfile } from '@/lib/drywall-profiles';
import { OperationDateField } from '@/components/operation-date-field';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { formatKg, formatQty, isPositiveDecimal } from '@/lib/format';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { RoleGate } from '@/components/role-gate';
import { Section } from '@/components/section';
import {
  FormCell,
  FormGrid,
  focusField,
  StickyActionBar,
  type MissingField,
} from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input, InputWithUnit } from '@/components/ui/input';
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
   * E (Fase 7e) / D-344: el ancho ya no se tipea a mano — se elige el SKU del perfil de drywall
   * que necesita ese fleje, y el ancho sale de su SKU (`products.width_mm`, el ancho del fleje).
   * `widthMm` queda derivado, no editable, para que el plan de corte no invente anchos que
   * ningún perfil consume.
   */
  profileProductId: string;
  widthMm: string;
  stripsCount: string;
}

interface DraftCoil {
  coil: CoilDto;
  widthPlanMm: WidthRow[];
  expectedKerfLossMm: string;
}

/** Ids de los campos, para los enlaces de la barra de faltantes (cc31). */
const SUPPLIER_ID = 'cut-supplier';
const AVAILABLE_ID = 'cut-available';
const profileFieldId = (coilId: string, row: number) => `cut-${coilId}-profile-${String(row)}`;
const kerfFieldId = (coilId: string) => `cut-${coilId}-kerf`;

/** Un plan sin ningún perfil elegido: la bobina no tiene qué cortar. */
function planIsEmpty(draft: DraftCoil): boolean {
  return !draft.widthPlanMm.some((r) => r.widthMm.trim());
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
  /** cc31: tras el primer intento de enviar, los faltantes se marcan en su campo. */
  const [attempted, setAttempted] = useState(false);

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

  // E/D-344: el ancho de cada fleje sale del SKU del perfil que lo va a consumir (su ancho de
  // fleje, `products.width_mm`), no de un campo libre — así el plan de corte nunca pide un
  // ancho que ningún perfil de drywall necesita. Ya no hay receta que lo guarde.
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ProductDto[]>('/catalog'),
  });
  const drywallProfiles = drywallProfilesOf(catalog.data ?? []).ready;
  const profileById = new Map(drywallProfiles.map((p) => [p.productId, p]));

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
    onError: (err) => toast.error(errorMessage(err, 'No se pudo enviar la orden')),
  });

  // cc31 (ESPEC §6): salir con el envío a medio armar avisa; enviado, ya no.
  useUnsavedChanges(
    (supplierId !== '' || notes.trim() !== '' || drafts.length > 0) && !send.isSuccess,
  );

  // cc31 (ESPEC §6): lo que falta para enviar, con enlace a cada campo. Son las mismas reglas
  // que antes apagaban el botón; ahora el botón queda encendido y la barra lo dice.
  const missing: MissingField[] = [];
  if (!supplierId) missing.push({ label: 'Proveedor de corte', target: SUPPLIER_ID });
  if (drafts.length === 0) missing.push({ label: 'Al menos una bobina', target: AVAILABLE_ID });
  for (const d of drafts) {
    if (planIsEmpty(d)) {
      missing.push({ label: `${d.coil.code} · perfil`, target: profileFieldId(d.coil.id, 0) });
    } else if (planFits(d).error) {
      missing.push({ label: `${d.coil.code} · plan de corte`, target: kerfFieldId(d.coil.id) });
    }
  }

  const totalKg = drafts.reduce((acc, d) => acc.plus(d.coil.availableKg), new Decimal(0));

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div>
        <h1 className="text-xl font-semibold">Enviar bobinas a corte</h1>
        <p className="text-xs text-muted-foreground">
          El envío no mueve el kardex: la bobina sigue siendo propia, solo cambia de ubicación
          mientras el tercero la corta.
        </p>
      </div>

      {/* cc31 (ESPEC §6): secciones con banda gris; lo que decide el envío va primero. */}
      <Section title="Proveedor de corte" separated={false}>
        <FormGrid className="pt-2">
          <FormCell
            span={6}
            label="Proveedor"
            htmlFor={SUPPLIER_ID}
            error={attempted && !supplierId ? 'Elige el proveedor que va a cortar.' : null}
            help={
              suppliers.isError ? (
                <span className="text-destructive">No se pudieron cargar los proveedores.</span>
              ) : cuttingSuppliers?.length === 0 ? (
                'Ningún proveedor tiene marcado «presta servicio de corte».'
              ) : undefined
            }
          >
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger
                id={SUPPLIER_ID}
                className="w-full"
                aria-invalid={attempted && !supplierId}
              >
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
          </FormCell>
          <FormCell span={6} label="Notas" htmlFor="cut-notes" optional>
            <Input
              id="cut-notes"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </FormCell>
        </FormGrid>
      </Section>

      <div id={AVAILABLE_ID}>
        <Section title="Bobinas disponibles" bodyClassName="pt-1">
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
                  <TableCell className="text-right tabular-nums">{c.widthMm} mm</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(c.availableKg, 'kg')}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDrafts((prev) => [
                          ...prev,
                          {
                            coil: c,
                            widthPlanMm: [{ profileProductId: '', widthMm: '', stripsCount: '1' }],
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
                    No hay bobinas vigentes disponibles.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {attempted && drafts.length === 0 && (
            <p role="alert" className="px-2.5 pt-1 text-xs text-destructive">
              Agrega al menos una bobina para enviar a corte.
            </p>
          )}
        </Section>
      </div>

      {drafts.length > 0 && (
        <Section title="Plan de corte" bodyClassName="grid gap-3 pt-2">
          {drafts.map((draft, draftIndex) => (
            <DraftCoilCard
              key={draft.coil.id}
              draft={draft}
              attempted={attempted}
              drywallProfiles={drywallProfiles}
              profileById={profileById}
              onChange={(next) => {
                setDrafts((prev) => prev.map((d, i) => (i === draftIndex ? next : d)));
              }}
              onRemove={() => {
                setDrafts((prev) => prev.filter((_, i) => i !== draftIndex));
              }}
            />
          ))}
        </Section>
      )}

      {/* D-328: enviar a corte abre las bobinas selladas; cancelar el envío sin recibir nada las
          vuelve a sellar. */}
      <FilmOpenNotice coils={drafts.map((d) => d.coil)} />

      {/* cc31 (ESPEC §6): «Qué va a pasar», con cifras, antes de la barra. */}
      <div className="grid gap-1 rounded-lg bg-muted px-3 py-2 text-sm">
        <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
        <p>
          {drafts.length === 0
            ? 'Todavía no hay bobinas en el envío.'
            : `Salen a corte ${String(drafts.length)} ${drafts.length === 1 ? 'bobina' : 'bobinas'} · ${formatKg(totalKg)} disponibles.`}{' '}
          El kardex no se mueve: las bobinas siguen siendo propias y solo cambian de ubicación.
        </p>
        <OperationDateField value={operationDate} onChange={setOperationDate} />
      </div>

      <StickyActionBar missing={missing}>
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button
          disabled={send.isPending}
          pending={send.isPending}
          pendingText="Enviando…"
          onClick={() => {
            if (send.isPending) return;
            // cc31: con faltantes no se envía; se marcan los campos y el foco va al primero.
            if (missing[0]) {
              setAttempted(true);
              focusField(missing[0].target);
              return;
            }
            send.mutate();
          }}
        >
          {`Enviar ${String(drafts.length)} ${drafts.length === 1 ? 'bobina' : 'bobinas'}`}
        </Button>
      </StickyActionBar>
    </RoleGate>
  );
}

function DraftCoilCard({
  draft,
  attempted,
  drywallProfiles,
  profileById,
  onChange,
  onRemove,
}: {
  draft: DraftCoil;
  attempted: boolean;
  drywallProfiles: DrywallProfile[];
  profileById: Map<string, DrywallProfile>;
  onChange: (next: DraftCoil) => void;
  onRemove: () => void;
}) {
  const fit = planFits(draft);
  const emptyPlan = planIsEmpty(draft);
  // E: kg teóricos del plan (informativo) — la misma proporción por ancho que
  // `validateWidthBudget`/`planCoilSplit` ya usan, aplicada al disponible de la bobina en
  // vez de a un peso recibido (que todavía no existe: RF-41 ajusta contra lo real).
  const theoreticalKg = draft.widthPlanMm
    .filter((r) => r.widthMm.trim() && isPositiveDecimal(r.widthMm))
    .reduce((acc, r) => {
      const share = new Decimal(r.widthMm).times(stripCount(r.stripsCount));
      return acc.plus(share.div(draft.coil.widthMm).times(draft.coil.availableKg));
    }, new Decimal(0));
  const kerfId = kerfFieldId(draft.coil.id);
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-sm font-semibold">
          {draft.coil.code} · {draft.coil.widthMm} mm
        </p>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Quitar
        </Button>
      </div>
      <div className="grid w-48 gap-1">
        <Label htmlFor={kerfId}>Merma esperada</Label>
        <InputWithUnit
          id={kerfId}
          unit="mm"
          inputMode="decimal"
          className="text-right tabular-nums"
          aria-invalid={attempted && fit.error !== null}
          value={draft.expectedKerfLossMm}
          onChange={(e) => {
            onChange({ ...draft, expectedKerfLossMm: e.target.value });
          }}
        />
      </div>
      <div className="grid gap-2">
        <Label>Plan de corte (por SKU de perfil)</Label>
        {draft.widthPlanMm.map((row, rowIndex) => {
          const profile = profileById.get(row.profileProductId);
          return (
            <div key={rowIndex} className="flex items-center gap-2">
              <Select
                value={row.profileProductId}
                onValueChange={(v) => {
                  const chosen = profileById.get(v);
                  const rows = draft.widthPlanMm.map((r, i) =>
                    i === rowIndex
                      ? { ...r, profileProductId: v, widthMm: chosen?.widthMm ?? '' }
                      : r,
                  );
                  onChange({ ...draft, widthPlanMm: rows });
                }}
              >
                <SelectTrigger
                  id={profileFieldId(draft.coil.id, rowIndex)}
                  className="w-full"
                  aria-label={`SKU de perfil de la fila ${rowIndex + 1}`}
                  aria-invalid={attempted && emptyPlan && rowIndex === 0}
                >
                  <SelectValue placeholder="Elige el perfil que consume este fleje" />
                </SelectTrigger>
                <SelectContent>
                  {drywallProfiles.map((p) => (
                    <SelectItem key={p.productId} value={p.productId}>
                      {p.sku} — {p.name} ({p.widthMm} mm)
                    </SelectItem>
                  ))}
                  {drywallProfiles.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                      Ningún perfil de drywall tiene el SKU completo (espesor, ancho del fleje y
                      peso).
                    </div>
                  )}
                </SelectContent>
              </Select>
              <Input
                aria-label={`Cantidad de flejes de la fila ${rowIndex + 1}`}
                className="w-24 text-right tabular-nums"
                inputMode="numeric"
                value={row.stripsCount}
                onChange={(e) => {
                  const rows = draft.widthPlanMm.map((r, i) =>
                    i === rowIndex ? { ...r, stripsCount: e.target.value } : r,
                  );
                  onChange({ ...draft, widthPlanMm: rows });
                }}
              />
              <span className="w-20 shrink-0 text-xs text-muted-foreground tabular-nums">
                {profile ? `${profile.widthMm} mm` : '—'}
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
        {attempted && emptyPlan && (
          <p role="alert" className="text-xs text-destructive">
            Elige el perfil de al menos un fleje.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => {
            onChange({
              ...draft,
              widthPlanMm: [
                ...draft.widthPlanMm,
                { profileProductId: '', widthMm: '', stripsCount: '1' },
              ],
            });
          }}
        >
          Agregar fila
        </Button>
      </div>
      <p className={`text-sm ${fit.error ? 'text-destructive' : 'text-muted-foreground'}`}>
        {fit.error ??
          `Consume ${fit.consumedWidthMm} mm de ${draft.coil.widthMm} mm (queda ${fit.remainingWidthMm} mm) · ≈ ${formatKg(theoreticalKg)} teóricos.`}
      </p>
    </div>
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
