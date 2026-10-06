'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Role, type SellerDashboardDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { LINK_CLASSNAME } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * cc27 (M4, D-457). El mes del vendedor: sus ventas sin IGV y su conversión de cotización a
 * pedido. Solo VENDEDOR; el API le devuelve **solo lo suyo** y nada de costos ni márgenes.
 */
export function SellerSalesCard() {
  const { user } = useSession();
  const isSeller = user.role === Role.VENDEDOR;
  const q = useQuery({
    queryKey: ['seller-dashboard-month'],
    queryFn: () => api<SellerDashboardDto>('/reports/seller-dashboard'),
    enabled: isSeller,
  });
  if (!isSeller || !q.data) return null;
  const d = q.data;
  const range = `del ${formatDate(d.month.from)} al ${formatDate(d.month.to)}`;

  return (
    <section aria-labelledby="seller-month" className="grid gap-4 md:grid-cols-2">
      <h2 id="seller-month" className="sr-only">
        Tu mes
      </h2>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Tus ventas del mes (sin IGV)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums" data-testid="seller-sales">
            {formatMoney(d.salesPen)}
          </div>
          <p className="text-xs text-muted-foreground">
            {d.documentCount === 1 ? '1 comprobante' : `${String(d.documentCount)} comprobantes`}{' '}
            {range}, por fecha de emisión; las notas de crédito restan.{' '}
            <Link href="/comprobantes" className={LINK_CLASSNAME}>
              Ver tus comprobantes
            </Link>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Tu conversión de cotización a pedido
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums" data-testid="seller-conversion">
            {d.conversionPct === null ? '—' : `${d.conversionPct} %`}
          </div>
          <p className="text-xs text-muted-foreground">
            {d.quotationsIssued === 0
              ? `Sin cotizaciones emitidas ${range}.`
              : `${String(d.quotationsConverted)} de ${String(d.quotationsIssued)} cotizaciones emitidas ${range} tienen pedido.`}{' '}
            <Link href="/cotizaciones" className={LINK_CLASSNAME}>
              Ver tus cotizaciones
            </Link>
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
