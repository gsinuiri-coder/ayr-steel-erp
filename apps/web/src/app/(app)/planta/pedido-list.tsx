'use client';

import Link from 'next/link';
import { formatDate, formatQty } from '@/lib/format';
import { LINK_CLASSNAME } from '@/lib/utils';
import { QueueEntrySummary } from '@/components/production-queue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { plantaHref } from './planta-links';
import type { PedidoGroup } from './pedido-groups';

/** F8-S3c/M2: la cotización de origen de un pedido, para el link clickable de su tarjeta. */
export type QuotationOf = ReadonlyMap<string, { quotationId: string; quotationCode: string }>;

/**
 * F8-S3b/M2: la primera vista de `/planta` es la lista de **pedidos** con producción
 * pendiente, no la de órdenes. Una tarjeta por pedido, en el orden de su orden más urgente
 * (`groupByPedido`); el clic lleva a la vista de producción de ese pedido, que es donde
 * viven su cola y su workspace.
 *
 * La información precisa de la cola (D-189) no se pierde: cada tarjeta lista las órdenes no
 * iniciadas del pedido con el mismo resumen que tenía la tarjeta de cola global.
 */
export function PedidoList({
  groups,
  pending,
  failed,
  quotations,
}: {
  groups: readonly PedidoGroup[];
  pending: boolean;
  failed: boolean;
  /** F8-S3c/M2: cotización de origen por `salesOrderId`, cuando se conoce. */
  quotations: QuotationOf;
}) {
  if (pending) return <Skeleton className="h-64 w-full" />;
  if (failed) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          No se pudieron cargar los pedidos con producción pendiente.
        </AlertDescription>
      </Alert>
    );
  }
  if (groups.length === 0) {
    return (
      <Alert>
        <AlertDescription>No hay pedidos con producción pendiente.</AlertDescription>
      </Alert>
    );
  }
  return (
    <section aria-label="Pedidos con producción pendiente" className="grid gap-3">
      {groups.map((g) => (
        <PedidoCard
          key={g.key}
          group={g}
          quotation={g.salesOrderId === null ? null : (quotations.get(g.salesOrderId) ?? null)}
        />
      ))}
    </section>
  );
}

function PedidoCard({
  group: g,
  quotation,
}: {
  group: PedidoGroup;
  quotation: { quotationId: string; quotationCode: string } | null;
}) {
  const title =
    g.salesOrderId === null ? 'Órdenes sin pedido (a stock)' : (g.salesOrderCode ?? 'Pedido');
  const { counts } = g;
  return (
    <Card className="relative transition-colors hover:bg-muted/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {/*
            El enlace se estira sobre toda la tarjeta (`after:absolute`): la tarjeta entera es el
            clic, pero el nombre accesible es solo el título y no el resumen de cada orden.
          */}
          <Link
            href={plantaHref({ pedido: g.key })}
            className="font-mono after:absolute after:inset-0 after:content-['']"
          >
            <span className="sr-only">Producir </span>
            {title}
          </Link>
          {g.customerName !== null && g.salesOrderId !== null && (
            <span className="text-sm font-normal">{g.customerName}</span>
          )}
          {/*
            F8-S3c/M2: por encima del `after:absolute` de arriba (el orden en el DOM decide,
            los dos son position:relative de hecho vía Link/CardTitle), con su propio z-index:
            sin él, el link a la cotización quedaría debajo del enlace que cubre toda la
            tarjeta y el clic nunca le llegaría.
          */}
          {quotation !== null && (
            <Link
              href={`/cotizaciones/${quotation.quotationId}`}
              className={`relative z-10 text-sm font-normal ${LINK_CLASSNAME}`}
            >
              {quotation.quotationCode}
            </Link>
          )}
          {g.prioritized > 0 && <Badge>Prioridad</Badge>}
          {g.overdue && <Badge variant="destructive">Vencido</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {g.salesOrderId !== null && (
            <span>
              Compromiso:{' '}
              {g.promisedDeliveryDate ? formatDate(g.promisedDeliveryDate) : 'sin fecha'}
            </span>
          )}
          <span>
            {counts.total} {counts.total === 1 ? 'orden abierta' : 'órdenes abiertas'}:{' '}
            {counts.covered} con el plan cubierto · {counts.inProgress} en curso ·{' '}
            {counts.notStarted} sin iniciar
          </span>
          {g.roofing.length > 0 && (
            <span>
              {formatQty(g.reportedMeters, 'm')} de {formatQty(g.planMeters, 'm')} reportados
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Productos: {g.productSkus.join(', ')}</p>
        {g.queue.length > 0 && (
          <ul aria-label={`Cola de ${title}`} className="grid gap-1.5">
            {g.queue.map((entry) => (
              <li key={entry.orderId} className="rounded-md border bg-background/60 p-2">
                <QueueEntrySummary entry={entry} srPrefix={false} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
