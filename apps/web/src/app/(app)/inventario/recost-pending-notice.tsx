'use client';

import { useQuery } from '@tanstack/react-query';
import type { RecostPendingDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatTimestampDate } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * cc63 (RC-01 de audit-02): los recosteos por fecha que superaron el tope de movimientos y
 * quedaron pendientes. Solo ADMINISTRADOR (lo decide quien lo monta y lo exige el API). Mientras
 * estén pendientes, el costo de esos ítems y de sus ventas puede estar desactualizado; los completa
 * `pnpm recosteo:pendientes`. Sin pendientes no muestra nada.
 */
export function RecostPendingNotice() {
  const pending = useQuery({
    queryKey: ['inventory', 'recost-pending'],
    queryFn: () => api<RecostPendingDto[]>('/inventory/recost-pending'),
  });
  const rows = pending.data ?? [];
  if (rows.length === 0) return null;
  const items = [...new Map(rows.flatMap((r) => r.items).map((i) => [i.itemId, i])).values()];
  return (
    <Alert variant="destructive" data-testid="recost-pending">
      <AlertTitle>
        {rows.length === 1
          ? 'Hay 1 recosteo por fecha pendiente'
          : `Hay ${String(rows.length)} recosteos por fecha pendientes`}
      </AlertTitle>
      <AlertDescription className="grid gap-1">
        <span>
          Superaron el tope de movimientos que se recalculan en una operación. Hasta completarlos,
          el costo de estos ítems y de sus ventas puede estar desactualizado: pídele al agente que
          corra <code>pnpm recosteo:pendientes</code>.
        </span>
        <span>
          {items.map((i) => i.label).join(', ')} · desde el {formatTimestampDate(rows[0]?.at ?? '')}
        </span>
      </AlertDescription>
    </Alert>
  );
}
