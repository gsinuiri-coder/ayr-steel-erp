'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  toDecimal,
  type BusinessLine,
  type ProductDto,
  type ProductStockDto,
  type RawMaterialStockDto,
  type StockPanelDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty, unitSymbol } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * D-188 (F8-S2b/M1): elegir el producto de una línea **viendo su stock**, en vez de un
 * `<select>` de SKU sueltos y una hoja de stock aparte que había que abrir por separado.
 *
 * **Mismo cálculo que el gate, sin lógica paralela** (D-150): la disponibilidad que se ve
 * acá es `GET /sales/stock-panel`, la misma consulta que ya alimenta `RawMaterialCell` y
 * `PriceFloorHint` en la fila, y que el mostrador y la confirmación vuelven a comprobar bajo
 * lock antes de prometer nada. Este modal no bloquea nada — **sin stock igual se puede
 * elegir** (D-188): el aviso de faltante vive en la fila, una vez que se tipea la cantidad,
 * y en la tarjeta del Panel una vez que la cotización se guarda.
 *
 * El tope de `productIds` de `/sales/stock-panel` (50, el mismo que `MAX_SALES_ITEMS`) es
 * el motivo de que la consulta de stock siga al **filtro**, no a la línea de negocio entera:
 * una línea con más de 50 SKU activos sigue completa y buscable —viene del catálogo, ya
 * cargado— y lo único que se acota es para cuántas filas visibles se pide el disponible.
 */

const STOCK_QUERY_CAP = 50;

interface AvailabilitySummary {
  text: string;
  /** Rojo: el disponible es cero o el SKU no lleva stock que mostrar (a medida sin catálogo). */
  empty: boolean;
}

function availabilityOf(stock: ProductStockDto | undefined, unit: string): AvailabilitySummary {
  if (stock === undefined) return { text: '—', empty: false };
  if (!stock.carriesInventory) {
    return { text: 'Servicio · no lleva inventario', empty: false };
  }
  if (stock.rawMaterialAvailableKg !== null) {
    const label = stock.rawMaterialLabel ? ` (${stock.rawMaterialLabel})` : '';
    return {
      text: `${formatQty(stock.rawMaterialAvailableKg, 'kg')} de materia prima${label}`,
      empty: toDecimal(stock.rawMaterialAvailableKg).lte(0),
    };
  }
  if (stock.kgPerMeter !== null) {
    // Se fabrica contra el pedido pero el catálogo no da para calcular el agregado (falta
    // espesor o acabado): el mismo caso que rechaza `resolveSalesLines` al guardar.
    return { text: 'Sin espesor o acabado: no se puede calcular', empty: true };
  }
  return {
    text: `${formatQty(stock.availableQty, unit)} disponibles`,
    empty: toDecimal(stock.availableQty).lte(0),
  };
}

/**
 * El agregado de materia prima de una línea de negocio, agrupado por espesor y color
 * (D-134/D-136), con sus metros lineales teóricos. Vive acá y no repetido en el panel lateral
 * (`StockPanelSheet`) y en este modal: son la misma lista, con la misma fuente.
 */
export function RawMaterialPoolList({ rows }: { rows: RawMaterialStockDto[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No hay bobinas abiertas en esta línea de negocio.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={`${row.colorId ?? '-'}|${row.thicknessMm}`} className="rounded-md border p-2">
          <div className="flex items-center gap-2">
            {row.colorHex && (
              <span
                aria-hidden
                className="size-3 rounded-full border"
                style={{ backgroundColor: row.colorHex }}
              />
            )}
            <span className="text-sm font-medium">
              {row.thicknessMm} mm · {row.colorName ?? 'Sin color'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatQty(row.availableKg, 'kg')} disponibles de {formatQty(row.physicalKg, 'kg')} · ≈{' '}
            {formatQty(row.theoreticalMeters, 'm')} lineales
          </p>
          <p className="text-xs text-muted-foreground">
            {row.coils} bobina{row.coils === 1 ? '' : 's'} · {formatQty(row.reservedKg, 'kg')}{' '}
            comprometidos
          </p>
        </li>
      ))}
    </ul>
  );
}

export function ProductStockPickerDialog({
  open,
  onOpenChange,
  businessLine,
  businessLineLabel,
  activeProducts,
  selectedProductId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessLine: BusinessLine;
  businessLineLabel: string;
  /** Ya filtrados por línea de negocio y activos (D-119): el catálogo entero es gratis, ya
   * está cargado; lo que cuesta es el disponible, y eso se pide acotado más abajo. */
  activeProducts: ProductDto[];
  selectedProductId: string;
  onSelect: (productId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const debouncedFilter = useDebounced(filter, 250);

  const matches = useMemo(() => {
    const needle = debouncedFilter.trim().toLowerCase();
    if (needle === '') return activeProducts;
    return activeProducts.filter(
      (p) => p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
    );
  }, [activeProducts, debouncedFilter]);

  // El disponible se pide para lo que la búsqueda de HOY muestra, no para la línea entera:
  // así el tope de 50 de `/sales/stock-panel` nunca se pisa, sea cual sea el tamaño del
  // catálogo de la línea.
  const stockIds = useMemo(
    () =>
      [...matches]
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .slice(0, STOCK_QUERY_CAP)
        .map((p) => p.id),
    [matches],
  );

  const stockPanel = useQuery({
    queryKey: ['stock-panel-picker', businessLine, stockIds.join(',')],
    queryFn: () =>
      api<StockPanelDto>(
        `/sales/stock-panel?${new URLSearchParams({
          businessLine,
          productIds: stockIds.join(','),
        }).toString()}`,
      ),
    enabled: open && stockIds.length > 0,
  });
  const stockByProductId = new Map((stockPanel.data?.products ?? []).map((p) => [p.productId, p]));
  const truncated = matches.length > stockIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Elegir producto · {businessLineLabel}</DialogTitle>
          <DialogDescription>
            El disponible ya descuenta lo reservado, firme y temporal (D-185). Elegir un producto
            sin stock no está bloqueado: la línea avisa si no alcanza, y no reserva nada hasta
            confirmar.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {(stockPanel.data?.rawMaterial.length ?? 0) > 0 && (
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Bobinas del pool (espesor + color)</h3>
              <RawMaterialPoolList rows={stockPanel.data?.rawMaterial ?? []} />
            </section>
          )}
          <Input
            autoFocus
            aria-label="Filtrar productos"
            placeholder="Escribe el SKU o el nombre…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {matches.length} de {activeProducts.length} productos
            {truncated &&
              ` · el disponible se muestra para los primeros ${String(STOCK_QUERY_CAP)}: sigue filtrando para ver el de los demás`}
          </p>
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Disponible</TableHead>
                  <TableHead className="w-28 text-right">Elegir</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.slice(0, STOCK_QUERY_CAP).map((p) => {
                  const availability = availabilityOf(
                    stockByProductId.get(p.id),
                    unitSymbol(p.unit),
                  );
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.sku}</div>
                        <div className="text-xs text-muted-foreground">{p.name}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span
                          className={
                            availability.empty ? 'text-destructive' : 'text-muted-foreground'
                          }
                        >
                          {stockPanel.isPending ? 'Cargando…' : availability.text}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={p.id === selectedProductId ? 'default' : 'outline'}
                          aria-label={`Elegir ${p.sku}`}
                          onClick={() => {
                            onSelect(p.id);
                            onOpenChange(false);
                          }}
                        >
                          {p.id === selectedProductId ? 'Elegido' : 'Elegir'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {matches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {activeProducts.length === 0
                        ? 'Esta línea no tiene productos activos.'
                        : 'Ningún producto coincide con ese texto.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
