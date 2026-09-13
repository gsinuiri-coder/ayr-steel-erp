'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Role, type QuotationStockShortageDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatQty, unitSymbol } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** §3.4: el módulo comercial es de ADMINISTRADOR y VENDEDOR. */
const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/**
 * D-188 (F8-S2b/M1): «Cotizaciones sin stock disponible», en el Panel.
 *
 * **La tarjeta ES el aviso** — no hay campana, ni correo, ni nada que marcar como leído. La
 * lista sale de `GET /sales/quotations/stock-shortages`, que no guarda ningún flag: es la
 * misma cuenta que usa la vista previa de confirmar, recalculada en cada carga. Confirmar,
 * anular, vencer o que se libere el material que le faltaba saca sola a una cotización de
 * esta lista — sin que nadie la marque, sin job que la limpie.
 */
export function StockShortagesCard() {
  const { user } = useSession();
  const isSalesRole = (SALES_ROLES as readonly string[]).includes(user.role);

  const shortages = useQuery({
    queryKey: ['quotation-stock-shortages'],
    queryFn: () => api<QuotationStockShortageDto[]>('/sales/quotations/stock-shortages'),
    enabled: isSalesRole,
    // El Panel es la primera pantalla del día: que el material liberado (o el que se lo
    // llevó otro pedido) se note sin recargar la pestaña a mano.
    refetchInterval: 60_000,
  });

  if (!isSalesRole || shortages.isPending) return null;

  if (shortages.isError) {
    return (
      <Card className="max-w-xl border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Cotizaciones sin stock disponible</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No se pudo cargar el aviso.
        </CardContent>
      </Card>
    );
  }

  const rows = shortages.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Card className="max-w-xl border-amber-500/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Cotizaciones sin stock disponible
          <Badge variant="outline">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          Lo que prometen hoy no alcanza. No es un bloqueo: se puede seguir cotizando y reservando;
          esto solo avisa qué material falta.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {rows.map((r) => (
          <Link
            key={r.quotationId}
            href={`/cotizaciones/${r.quotationId}`}
            className="block rounded-md border p-2 text-sm transition-colors hover:bg-muted"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="font-medium">{r.quotationCode}</span>
              <span className="text-xs text-muted-foreground">{r.customerName}</span>
            </div>
            <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {r.lines.map((l) => (
                <li key={l.lineNumber}>
                  L{l.lineNumber} · {l.productSku} — faltan{' '}
                  {formatQty(l.missingQty, unitSymbol(l.unit))} de {l.label}
                </li>
              ))}
            </ul>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
