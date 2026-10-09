'use client';

import type { RoofingPieceDto } from '@ayr/shared';
import { formatMeters } from '@/lib/format';
import { mmToMeters } from '@/lib/pieces';
import type { PlanProgressView, ProgressPart } from '@/lib/plan-progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * cc38 (D-576, tableros `ProducirAvance` y `CerrarBarra`) — la barra de avance de la orden en tres
 * tramos y lo que dice la barra inferior sobre el cierre. Las cifras con dos decimales en pantalla
 * (`formatMeters`, el estándar de listas y formularios).
 */

/** «6.00», y «4.205» solo si hace falta el milímetro. */
export function lengthLabel(lengthMm: string): string {
  const m = mmToMeters(lengthMm);
  return m.endsWith('0') ? m.slice(0, -1) : m;
}

/** «2.40 m × 10, 1.80 m × 6». */
export function cutsLabel(pieces: readonly { lengthMm: string; qty: number }[]): string {
  return pieces.map((p) => `${lengthLabel(p.lengthMm)} m × ${String(p.qty)}`).join(', ');
}

function piecesWord(n: number, unitWord: 'planchas' | 'und'): string {
  if (unitWord === 'und') return `${String(n)} und`;
  return `${String(n)} ${n === 1 ? 'plancha' : 'planchas'}`;
}

function partLabel(part: ProgressPart, unitWord: 'planchas' | 'und'): string {
  return part.pieces === null ? '' : ` · ${piecesWord(part.pieces, unitWord)}`;
}

export function PlanProgressBar({
  view,
  unitWord = 'planchas',
  label,
}: {
  view: PlanProgressView;
  unitWord?: 'planchas' | 'und';
  label: string;
}) {
  return (
    <div className="grid gap-1.5" data-testid="barra-avance">
      <div
        role="img"
        aria-label={label}
        className="flex h-3.5 overflow-hidden rounded-full bg-muted-foreground/15"
      >
        <div className="bg-primary" style={{ width: `${String(view.bar.registered)}%` }} />
        <div
          className="bg-[repeating-linear-gradient(45deg,var(--color-primary)_0_6px,transparent_6px_12px)] opacity-45"
          style={{ width: `${String(view.bar.draft)}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
        <span data-testid="tramo-registrado">
          <Swatch className="bg-primary" /> Registrado <b>{formatMeters(view.registered.meters)}</b>
          {partLabel(view.registered, unitWord)}
        </span>
        <span data-testid="tramo-borrador">
          <Swatch className="bg-primary/40" /> En borrador, sin registrar{' '}
          <b>{formatMeters(view.draft.meters)}</b>
          {partLabel(view.draft, unitWord)}
        </span>
        <span data-testid="tramo-falta">
          <Swatch className="border border-border bg-muted-foreground/15" /> Falta{' '}
          <b>{formatMeters(view.missing.meters)}</b>
          {partLabel(view.missing, unitWord)}
        </span>
        <span className="ml-auto text-muted-foreground">
          Plan {formatMeters(view.plan.meters)}
          {partLabel(view.plan, unitWord)}
        </span>
      </div>
    </div>
  );
}

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block size-2.5 rounded-xs ${className}`} />;
}

/** La etiqueta de una bobina (D-576): lo que tiene en borrador manda sobre lo registrado. */
export function CoilStatusBadge({
  inDraft,
  registered,
}: {
  inDraft: boolean;
  registered: boolean;
}) {
  if (inDraft) return <Badge variant="progress">En borrador · sin registrar</Badge>;
  if (registered) return <Badge variant="done">Registrado</Badge>;
  return null;
}

/** El motivo por el que «Registrar y cerrar» no está activo, o `null` si se puede cerrar. */
export function closeBlockedReason(view: PlanProgressView): string | null {
  if (view.canClose) return null;
  if (view.excess.gt(0)) {
    return `Excede el plan en ${formatMeters(view.excess)} · ajusta el plan.`;
  }
  if (view.toClose.gt(0)) {
    return `Para cerrar falta registrar ${formatMeters(view.toClose)}. La orden se cierra solo con el plan completo.`;
  }
  return 'No hay nada registrado ni escrito para cerrar.';
}

/** El texto de la barra inferior sobre el cierre (tableros `ProducirAvance` y `CerrarBarra`). */
export function CloseHint({
  view,
  unitWord = 'planchas',
}: {
  view: PlanProgressView;
  unitWord?: 'planchas' | 'und';
}) {
  if (view.needsAutoConfirm) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="aviso-cierre">
        Con el bloque confirmado, el plan queda completo y la orden se puede cerrar.
      </span>
    );
  }
  if (view.canClose) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="aviso-cierre">
        El plan queda completo: la orden se puede cerrar.
      </span>
    );
  }
  if (view.excess.gt(0)) {
    return (
      <span className="text-sm" data-testid="aviso-cierre">
        <span className="font-semibold text-tone-warning-foreground">
          Excede el plan en {formatMeters(view.excess)} · ajusta el plan
        </span>
      </span>
    );
  }
  if (view.toClose.lte(0)) return null;
  const detail = view.missingDetail;
  const showDetail =
    detail !== null && detail.length > 0 && view.toClose.equals(view.missing.meters);
  return (
    <span className="text-sm" data-testid="aviso-cierre">
      <span className="font-semibold text-tone-warning-foreground">
        Para cerrar falta registrar {formatMeters(view.toClose)}
      </span>{' '}
      <span className="text-muted-foreground">
        {showDetail && <>({missingDetailLabel(detail, unitWord)}). </>}
        La orden se cierra solo con el plan completo.
      </span>
    </span>
  );
}

function missingDetailLabel(detail: readonly RoofingPieceDto[], unitWord: 'planchas' | 'und') {
  const total = detail.reduce((acc, p) => acc + p.qty, 0);
  return unitWord === 'und'
    ? piecesWord(total, unitWord)
    : `${piecesWord(total, unitWord)}: ${cutsLabel(detail)}`;
}

/**
 * «Registrar y cerrar», desactivado mientras falte plan, con el motivo en un tooltip (D-576). El
 * botón desactivado no recibe el puntero: el tooltip va en un envoltorio que sí.
 */
export function CloseButton({
  view,
  code,
  pending,
  busy,
  onClick,
}: {
  view: PlanProgressView;
  code: string;
  pending: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const reason = closeBlockedReason(view);
  const button = (
    <Button
      variant={reason === null ? 'default' : 'outline'}
      aria-label={`Registrar y cerrar ${code}`}
      pending={pending}
      pendingText="Calculando…"
      disabled={busy || reason !== null}
      onClick={onClick}
    >
      Registrar y cerrar
    </Button>
  );
  if (reason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid="motivo-cerrar" aria-label={reason}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
