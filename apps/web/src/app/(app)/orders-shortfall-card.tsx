'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Role, type OrderWithShortfallDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatQty, unitSymbol } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * D-341: «Pedidos con faltante», en el Panel — los pedidos que un administrador confirmó con
 * material sin reservar. Es el hermano de «Cotizaciones sin stock disponible» (D-188): la
 * tarjeta ES el aviso, solo ADMINISTRADOR, y desaparece sola cuando el faltante se completa,
 * se libera la reserva o se anula el pedido. La lista sale de `reservations.shortfall_qty`.
 */
export function OrdersShortfallCard() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const orders = useQuery({
    queryKey: ['orders-with-shortfall'],
    queryFn: () => api<OrderWithShortfallDto[]>('/sales/orders/with-shortfall'),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (!isAdmin || orders.isPending) return null;

  if (orders.isError) {
    return (
      <Card className="max-w-xl border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Pedidos con faltante</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No se pudo cargar el aviso.
        </CardContent>
      </Card>
    );
  }

  const rows = orders.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Card className="max-w-xl border-amber-500/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          Pedidos con faltante
          <Badge variant="warning">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          Confirmados con material sin reservar. Cuando llegue, «Completar reserva» en el pedido.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {rows.map((r) => (
          <Link
            key={r.orderId}
            href={`/pedidos/${r.orderId}`}
            className="block rounded-md border p-2 text-sm transition-colors hover:bg-muted"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="font-medium">{r.orderCode}</span>
              <span className="text-xs text-muted-foreground">{r.customerName}</span>
            </div>
            <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {r.shortfalls.map((s) => (
                <li key={s.label} className="tabular-nums">
                  faltan {formatQty(s.missingQty, unitSymbol(s.unit))} de {s.label}
                </li>
              ))}
            </ul>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
