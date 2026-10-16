import { PAYMENT_METHOD_LABELS } from '@ayr/shared';
import { MISSING_POLICY_LABELS, type OpeningPlan, type PlanIssue } from './opening-balances-plan';
import { DIRTY_SUFFIX } from '../inventory/recost-historic';
import type { OpeningBatchResult } from './opening-balances.service';

/**
 * cc56 (D-668) — la vista previa del lote de saldos iniciales (lo que lee el dueño) y el candado de
 * la ejecución: `--execute` solo corre si el plan de ahora es el mismo de la vista previa.
 */

export interface OpeningPreview {
  branch: string;
  gitSha: string;
  generatedAtIso: string;
  /** Huella de cada archivo leído (sha-256), o `null` si ese lado no vino. */
  files: { customers: string | null; suppliers: string | null };
  result: OpeningBatchResult;
  executed: boolean;
}

/** Lo que tiene que coincidir entre la vista previa y la ejecución (todo menos el id del lote). */
export function planFingerprint(result: OpeningBatchResult): string {
  const side = (plan: OpeningPlan | undefined) =>
    plan?.payments.map((p) => [
      p.accountId,
      p.date,
      p.amount,
      p.method,
      p.reference,
      p.exchangeRate,
    ]) ?? null;
  return JSON.stringify({
    cutoff: result.cutoff,
    missing: result.missing,
    customers: side(result.customers?.plan),
    suppliers: side(result.suppliers?.plan),
  });
}

export const PREVIEW_MAX_AGE_HOURS = 24;

/** Por qué no se puede ejecutar con esa vista previa, o `null` si se puede. */
export function previewRejection(
  preview: OpeningPreview | null,
  now: { branch: string; gitSha: string; at: Date; files: OpeningPreview['files'] },
): string | null {
  if (preview === null) return 'no hay vista previa: corre primero el dry-run';
  if (preview.executed) return 'la vista previa es de una ejecución, no de un dry-run';
  if (preview.branch !== now.branch) return `la vista previa es de ${preview.branch}`;
  if (preview.gitSha !== now.gitSha || now.gitSha.endsWith(DIRTY_SUFFIX)) {
    return `la vista previa es del commit ${preview.gitSha} y el checkout está en ${now.gitSha}`;
  }
  const ageHours = (now.at.getTime() - new Date(preview.generatedAtIso).getTime()) / 3_600_000;
  if (ageHours > PREVIEW_MAX_AGE_HOURS) {
    return `la vista previa tiene ${ageHours.toFixed(1)} h (máximo ${String(PREVIEW_MAX_AGE_HOURS)} h)`;
  }
  if (
    preview.files.customers !== now.files.customers ||
    preview.files.suppliers !== now.files.suppliers
  ) {
    return 'los archivos no son los mismos de la vista previa';
  }
  return null;
}

function issues(title: string, list: PlanIssue[]): string[] {
  if (list.length === 0) return [];
  return [
    `**${title} (${String(list.length)}):**`,
    '',
    ...list.map(
      (i) =>
        `- ${i.rowNumber === null ? '' : `fila ${String(i.rowNumber)} · `}${i.key ?? '(sin clave)'}: ${i.message}`,
    ),
    '',
  ];
}

const TREATMENT_LABELS = {
  EXCEL: 'según el Excel',
  MISSING_PAID: 'no está en el Excel → pagado al corte',
  MISSING_PENDING: 'no está en el Excel → sigue pendiente',
  AFTER_CUTOFF: 'emitido después del corte (no se toca)',
} as const;

/** El total por moneda (soles y dólares no se suman entre sí). */
function totals(plan: OpeningPlan, fallback: string): string {
  const entries = Object.entries(plan.totalsByCurrency);
  if (entries.length === 0) return `${fallback} 0.00`;
  return entries.map(([c, v]) => `${c === 'PEN' ? 'S/' : c} ${v}`).join(' + ');
}

function side(title: string, currency: string, plan: OpeningPlan): string[] {
  const counts = new Map<string, number>();
  for (const a of plan.accounts) counts.set(a.treatment, (counts.get(a.treatment) ?? 0) + 1);
  const touched = plan.accounts.filter((a) => a.registered !== '0.00');
  return [
    `## ${title}`,
    '',
    `- Pagos a registrar: **${String(plan.payments.length)}** por **${totals(plan, currency)}**.`,
    ...[...counts.entries()].map(
      ([t, c]) => `- ${TREATMENT_LABELS[t as keyof typeof TREATMENT_LABELS]}: ${String(c)}`,
    ),
    `- Errores: ${String(plan.errors.length)} · avisos: ${String(plan.warnings.length)}.`,
    '',
    ...issues('Errores (el lote no se registra)', plan.errors),
    ...issues('Avisos', plan.warnings),
    ...(touched.length === 0
      ? []
      : [
          '| Cuenta | Emisión | Saldo al corte antes | Se registra | Saldo al corte después | Cómo |',
          '| --- | --- | ---: | ---: | ---: | --- |',
          ...touched.map(
            (a) =>
              `| ${a.key} | ${a.issueDate} | ${a.balanceAtCutoffBefore} | ${a.registered} | ${a.balanceAtCutoffAfter} | ${TREATMENT_LABELS[a.treatment]} |`,
          ),
          '',
          '| Cuenta | Fecha | Monto | Moneda | Medio | Referencia del Excel |',
          '| --- | --- | ---: | --- | --- | --- |',
          ...plan.payments.map(
            (p) =>
              `| ${p.key} | ${p.date} | ${p.amount} | ${p.currency ?? 'PEN'} | ${PAYMENT_METHOD_LABELS[p.method]} | ${p.reference ?? ''} |`,
          ),
          '',
        ]),
  ];
}

/** La vista previa (o el resultado) en markdown. Vive en `local-data/`: trae datos reales. */
export function renderOpeningPreview(preview: OpeningPreview): string {
  const r = preview.result;
  return [
    `# Saldos iniciales — ${preview.executed ? 'EJECUCIÓN' : 'vista previa (dry-run)'} en ${preview.branch}`,
    '',
    `- Corte: **${r.cutoff}** · lo que no está en el Excel: **${MISSING_POLICY_LABELS[r.missing]}**.`,
    `- Lote: \`${r.batchId}\`${preview.executed ? '' : ' (el de la ejecución será otro)'} · commit ${preview.gitSha} · ${preview.generatedAtIso}.`,
    '',
    ...(r.customers
      ? side('Cobranzas (comprobantes)', 'S/', r.customers.plan)
      : ['## Cobranzas: no vino archivo (no se tocan)', '']),
    ...(r.suppliers
      ? side('Pagos a proveedor (compras)', 'S/', r.suppliers.plan)
      : ['## Pagos: no vino archivo (no se tocan)', '']),
  ].join('\n');
}
