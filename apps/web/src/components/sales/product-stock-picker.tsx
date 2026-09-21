'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SEARCH_RESULT_LIMIT,
  toDecimal,
  toFixedString,
  type BusinessLine,
  type ProductDto,
  type ProductStockDto,
  type RawMaterialStockDto,
  type StockPanelDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatQty, unitSymbol } from '@/lib/format';
import { asyncSearchStatus, belowSearchMinimum } from '@/lib/search-status';
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
 * RF-S3/M1: la lista de opciones ya no es el catálogo entero filtrado en el navegador — es
 * `GET /catalog/search`, acotada a `SEARCH_RESULT_LIMIT` (20) por el servidor, bien por
 * debajo del tope de `/sales/stock-panel` (50, `MAX_SALES_ITEMS`): el disponible se pide para
 * exactamente lo que la búsqueda de hoy muestra, sin recortar de nuevo.
 */

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
    const kg = toDecimal(stock.rawMaterialAvailableKg);
    const empty = kg.lte(0);
    // F8-S3c/M3: el ML manda, el kg acompaña — el vendedor piensa en metros de plancha, no en
    // kilos de bobina. Mismo `kgPerMeter` que ya usa el gate de confirmación (D-150).
    if (stock.kgPerMeter !== null && toDecimal(stock.kgPerMeter).gt(0)) {
      const meters = toFixedString(kg.div(toDecimal(stock.kgPerMeter)), 'KG');
      return {
        text: `${formatQty(meters, 'm')} (${formatQty(stock.rawMaterialAvailableKg, 'kg')})${label}`,
        empty,
      };
    }
    return {
      text: `${formatQty(stock.rawMaterialAvailableKg, 'kg')} de materia prima${label}`,
      empty,
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
 * (D-134/D-136), con sus metros lineales teóricos. Lo muestra el panel lateral
 * (`StockPanelSheet`). Este modal lo mostraba también hasta F8-S3b/M1: el dueño lo pidió solo
 * con la lista de productos, igual en todas las líneas.
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
  selectedProductId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  businessLine: BusinessLine;
  businessLineLabel: string;
  selectedProductId: string;
  onSelect: (productId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const debouncedFilter = useDebounced(filter, 250);
  const trimmed = debouncedFilter.trim();
  // RF-S3/cierre: vacío no es "por debajo del mínimo" (ver el mismo ajuste en
  // `search-select-modal.tsx`) — abrir el picker sin escribir muestra los primeros
  // `SEARCH_RESULT_LIMIT` de la línea, en vez de nada.
  const belowMinChars = belowSearchMinimum(trimmed);

  // El filtro no sobrevive al cierre (mismo motivo que `SearchSelectModal`, D-156): sin esto,
  // reabrir el picker de otra línea —o el mismo después de elegir— mostraba la búsqueda de la
  // vez anterior, con «0 de N productos» hasta que alguien la borraba a mano.
  useEffect(() => {
    if (open) setFilter('');
  }, [open]);

  // RF-S3/M1: busca en el servidor (`GET /catalog/search`) en vez de filtrar el catálogo
  // entero ya cargado del formulario (D-119 sigue existiendo ahí, pero solo para el precio y
  // la unidad de las líneas ya elegidas — este modal no lo necesita más).
  const productsSearch = useQuery({
    queryKey: ['catalog-search', businessLine, trimmed],
    queryFn: () =>
      api<ProductDto[]>(
        `/catalog/search?${new URLSearchParams({ q: trimmed, businessLine }).toString()}`,
      ),
    enabled: open && !belowMinChars,
  });
  const matches = productsSearch.data ?? [];
  // El disponible se pide para lo que la búsqueda de HOY muestra, no para la línea entera:
  // así el tope de 50 de `/sales/stock-panel` nunca se pisa. `SEARCH_RESULT_LIMIT` (20) ya
  // es menor que ese tope, así que no hace falta recortar de nuevo.
  const stockIds = matches.map((p) => p.id);

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
  // Heurística, no un conteo exacto: si el servidor devolvió el tope, es probable que haya
  // más SKU sin mostrar — no hay forma barata de saber cuántos sin una segunda consulta.
  const mayHaveMore = matches.length === SEARCH_RESULT_LIMIT;

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
        <div className="grid min-w-0 gap-3">
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
            {asyncSearchStatus({
              belowMinimum: belowMinChars,
              isFetching: productsSearch.isFetching,
              count: matches.length,
              mayHaveMore,
            })}
          </p>
          {/* F8-S3b/M1: sin scroll horizontal. Tabla de ancho fijo y celdas que parten línea —
              la base de `TableCell` es `whitespace-nowrap`, y un nombre largo o un disponible
              con su materia prima empujaban «Elegir» fuera de la vista. */}
          <div className="max-h-96 overflow-x-hidden overflow-y-auto rounded-lg border">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead className="w-[38%]">Disponible</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Elegir</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map((p) => {
                  const availability = availabilityOf(
                    stockByProductId.get(p.id),
                    unitSymbol(p.unit),
                  );
                  return (
                    <TableRow
                      key={p.id}
                      tabIndex={0}
                      aria-label={`Elegir ${p.sku}`}
                      className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => {
                        onSelect(p.id);
                        onOpenChange(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(p.id);
                          onOpenChange(false);
                        }
                      }}
                    >
                      <TableCell className="whitespace-normal break-words">
                        <div className="font-medium">{p.sku}</div>
                        <div className="text-xs text-muted-foreground">{p.name}</div>
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal break-words">
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
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(p.id);
                            onOpenChange(false);
                          }}
                        >
                          Elegir
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {matches.length === 0 && !belowMinChars && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {productsSearch.isFetching
                        ? 'Buscando…'
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
