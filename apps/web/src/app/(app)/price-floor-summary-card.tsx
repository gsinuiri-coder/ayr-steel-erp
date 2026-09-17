'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Role, type PriceListFloorSummaryDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * RF-S3/M4 (sacrificable, D-224/D-228): «SKUs con lista bajo piso», en el Panel.
 *
 * Mismo espíritu que `StockShortagesCard` (D-188): la tarjeta ES el aviso, recalculada en
 * cada carga contra `GET /catalog/price-list/floor-summary` — sin flag guardado ni job. Solo
 * ADMINISTRADOR: el ajuste que corresponde (el margen mínimo por línea) vive en
 * Administración → Márgenes, que ya es de ese rol (D-175).
 */
export function PriceFloorSummaryCard() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const summary = useQuery({
    queryKey: ['price-list-floor-summary'],
    queryFn: () => api<PriceListFloorSummaryDto>('/catalog/price-list/floor-summary'),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (!isAdmin || summary.isPending) return null;

  if (summary.isError) {
    return (
      <Card className="max-w-xl border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">SKUs con lista bajo piso</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No se pudo cargar el aviso.
        </CardContent>
      </Card>
    );
  }

  const rows = summary.data?.belowFloor ?? [];
  if (rows.length === 0) return null;

  return (
    <Card className="max-w-xl border-amber-500/50">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          SKUs con lista bajo piso
          <Badge variant="outline">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          Precio de lista por debajo del mínimo de D-163 (costo promedio del kardex sobre el margen
          mínimo de su línea). No bloquea: el catálogo se sigue vendiendo igual.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {rows.slice(0, 8).map((r) => (
          <Link
            key={r.productId}
            href={`/catalogo?bajoPiso=${r.productId}`}
            className="block rounded-md border p-2 text-sm transition-colors hover:bg-muted"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="font-medium">{r.sku}</span>
              <span className="text-xs text-muted-foreground">{r.name}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              S/ {r.listPricePen} de lista, mínimo S/ {r.minPricePen} por {r.priceUnitLabel}
            </p>
          </Link>
        ))}
        {rows.length > 8 && (
          <Link
            href="/catalogo?bajoPiso=1"
            className="text-center text-xs text-muted-foreground hover:underline"
          >
            Ver los {rows.length} en el catálogo
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
