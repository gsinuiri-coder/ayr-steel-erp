'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  SEARCH_RESULT_LIMIT,
  sellsByFixedLength,
  toDecimal,
  toFixedString,
  type BusinessLine,
  type ProductDto,
  type ProductStockDto,
  type RawMaterialStockDto,
  type StockPanelDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatAmount, formatQty, unitSymbol } from '@/lib/format';
import { listPriceWithIgv } from '@/lib/list-price';
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
        No hay bobinas vigentes en esta línea de negocio.
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

/** cc36: el chip «Todas» del selector (sin filtro de línea de negocio). */
const ALL_LINES = 'ALL';

/** Una línea de negocio que el selector ofrece como filtro (las que admite el documento). */
export interface PickerBusinessLine {
  code: BusinessLine;
  label: string;
}

/** cc31 (corte 6): el subtipo de cobertura en minúsculas, para el renglón bajo el nombre. */
const KIND_HINT: Record<string, string> = {
  A_MEDIDA: 'a medida',
  PLANCHA: 'plancha',
  ACCESORIO: 'accesorio',
};

/** El precio de lista con IGV, en la unidad en que se negocia la línea. */
function ListPriceCell({ product }: { product: ProductDto }) {
  const perUnit = listPriceWithIgv(product);
  if (perUnit === null) return <span className="text-muted-foreground">sin lista</span>;
  if (sellsByFixedLength(product)) {
    const perPiece = listPriceWithIgv(product, true);
    return (
      <>
        <div>{formatAmount(perUnit, 2)} /m</div>
        {perPiece !== null && (
          <div className="text-muted-foreground">{formatAmount(perPiece, 2)} la plancha</div>
        )}
      </>
    );
  }
  // Un servicio (ZZ) no tiene símbolo de unidad: sin sufijo, en vez de un «/» suelto.
  const symbol = unitSymbol(product.unit);
  return (
    <div>
      {formatAmount(perUnit, 2)}
      {symbol === '' ? '' : ` /${symbol}`}
    </div>
  );
}

export function ProductStockPickerDialog({
  open,
  onOpenChange,
  lineNumber,
  businessLine,
  businessLines,
  selectedProductId,
  onSelect,
  onPicked,
  onChooseCoil,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** cc31: el número de la línea del documento que se está llenando («línea 3»). */
  lineNumber: number;
  /**
   * La línea de negocio de la fila: el filtro con el que abre. cc36: vacía —una fila nueva— abre en
   * «Todas», como el tablero Selector; la línea se elige aquí y no en un desplegable de la fila.
   */
  businessLine: BusinessLine | '';
  /**
   * cc31 (corte 6): las líneas de negocio que el documento admite, como filtros. Elegir un
   * producto de otra línea cambia la línea de la fila (`onSelect` la devuelve).
   */
  businessLines: readonly PickerBusinessLine[];
  selectedProductId: string;
  onSelect: (productId: string, businessLine: BusinessLine) => void;
  /** cc31: después de elegir y cerrar, a dónde va el foco (la cantidad de la línea). */
  onPicked?: () => void;
  /**
   * cc36: el chip «Bobina completa» del tablero Selector. Cierra este buscador y la fila pasa a
   * vender una bobina entera (D-116), que se elige en su propio diálogo (D-282).
   */
  onChooseCoil?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [line, setLine] = useState<BusinessLine | typeof ALL_LINES>(businessLine || ALL_LINES);
  const debouncedFilter = useDebounced(filter, 250);
  const trimmed = debouncedFilter.trim();
  // RF-S3/cierre: vacío no es "por debajo del mínimo" (ver el mismo ajuste en
  // `search-select-modal.tsx`) — abrir el picker sin escribir muestra los primeros
  // `SEARCH_RESULT_LIMIT` de la línea, en vez de nada.
  const belowMinChars = belowSearchMinimum(trimmed);
  /** Se eligió un producto: al cerrar, el foco va a la cantidad y no vuelve al botón. */
  const picked = useRef(false);
  const rowsRef = useRef<HTMLTableSectionElement>(null);

  // El filtro no sobrevive al cierre (mismo motivo que `SearchSelectModal`, D-156): sin esto,
  // reabrir el picker de otra línea —o el mismo después de elegir— mostraba la búsqueda de la
  // vez anterior, con «0 de N productos» hasta que alguien la borraba a mano. La línea de
  // negocio vuelve a la de la fila por el mismo motivo.
  useEffect(() => {
    if (open) {
      setFilter('');
      setLine(businessLine || ALL_LINES);
      picked.current = false;
    }
  }, [open, businessLine]);

  // RF-S3/M1: busca en el servidor (`GET /catalog/search`) en vez de filtrar el catálogo
  // entero ya cargado del formulario (D-119 sigue existiendo ahí, pero solo para el precio y
  // la unidad de las líneas ya elegidas — este modal no lo necesita más).
  const productsSearch = useQuery({
    queryKey: ['catalog-search', line, trimmed],
    queryFn: () =>
      api<ProductDto[]>(
        `/catalog/search?${new URLSearchParams({
          q: trimmed,
          ...(line === ALL_LINES ? {} : { businessLine: line }),
        }).toString()}`,
      ),
    enabled: open && !belowMinChars,
  });
  // cc36: con «Todas», solo las líneas que el documento admite (un pedido directo no ofrece las
  // que exigen cotización, D-065): el servidor busca en todas y aquí se descarta el resto.
  const allowed = new Set(businessLines.map((b) => b.code));
  const matches = (productsSearch.data ?? []).filter((p) => allowed.has(p.businessLineCode));
  // El disponible se pide para lo que la búsqueda de HOY muestra, no para la línea entera:
  // así el tope de 50 de `/sales/stock-panel` nunca se pisa. `SEARCH_RESULT_LIMIT` (20) ya
  // es menor que ese tope, así que no hace falta recortar de nuevo.
  const stockIds = matches.map((p) => p.id);

  const stockPanel = useQuery({
    queryKey: ['stock-panel-picker', line, stockIds.join(',')],
    queryFn: () =>
      api<StockPanelDto>(
        `/sales/stock-panel?${new URLSearchParams({
          ...(line === ALL_LINES ? {} : { businessLine: line }),
          productIds: stockIds.join(','),
        }).toString()}`,
      ),
    enabled: open && stockIds.length > 0,
  });
  const stockByProductId = new Map((stockPanel.data?.products ?? []).map((p) => [p.productId, p]));
  // Heurística, no un conteo exacto: si el servidor devolvió el tope, es probable que haya
  // más SKU sin mostrar — no hay forma barata de saber cuántos sin una segunda consulta.
  // cc36: sobre lo que devolvió el servidor, antes de descartar las líneas que el documento no
  // admite — si no, el aviso desaparecía justo cuando el descarte dejaba la lista corta.
  const mayHaveMore = (productsSearch.data?.length ?? 0) === SEARCH_RESULT_LIMIT;
  const hiddenByLine = (productsSearch.data?.length ?? 0) - matches.length;

  function choose(product: ProductDto): void {
    picked.current = true;
    // cc36: la línea es la del producto, no la del chip: con «Todas» no hay otra que tomar.
    onSelect(product.id, product.businessLineCode);
    onOpenChange(false);
  }

  /** cc31: ↑ ↓ se mueven entre las filas de resultados. */
  function focusRow(from: HTMLElement | null, step: 1 | -1): void {
    const rows = Array.from(
      rowsRef.current?.querySelectorAll<HTMLElement>('tr[data-product-row]') ?? [],
    );
    if (rows.length === 0) return;
    const at = from === null ? -1 : rows.indexOf(from);
    rows[Math.min(Math.max(at + step, 0), rows.length - 1)]?.focus();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          if (picked.current && onPicked) {
            event.preventDefault();
            picked.current = false;
            onPicked();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Elegir producto · línea {lineNumber}</DialogTitle>
          <DialogDescription>
            El disponible ya descuenta lo reservado, firme y temporal. Elegir un producto sin stock
            no está bloqueado: la línea avisa si no alcanza, y no reserva nada hasta confirmar.
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
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                focusRow(null, 1);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="group"
              aria-label="Línea de negocio"
              className="flex flex-wrap items-center gap-1.5"
            >
              {[{ code: ALL_LINES, label: 'Todas' } as const, ...businessLines].map((b) => (
                <Button
                  key={b.code}
                  type="button"
                  size="xs"
                  variant={b.code === line ? 'secondary' : 'outline'}
                  aria-pressed={b.code === line}
                  onClick={() => {
                    setLine(b.code);
                  }}
                >
                  {b.label}
                </Button>
              ))}
              {onChooseCoil && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    onChooseCoil();
                  }}
                >
                  Bobina completa
                </Button>
              )}
            </div>
            <p className="ml-auto text-xs text-muted-foreground">
              {asyncSearchStatus({
                belowMinimum: belowMinChars,
                isFetching: productsSearch.isFetching,
                count: matches.length,
                mayHaveMore,
              })}
              {hiddenByLine > 0 &&
                ' · algunos son de líneas que este documento no admite: filtra por línea para ver más'}
            </p>
          </div>
          {/* F8-S3b/M1: sin scroll horizontal. Tabla de ancho fijo y celdas que parten línea —
              la base de `TableCell` es `whitespace-nowrap`, y un nombre largo o un disponible
              con su materia prima empujaban «Elegir» fuera de la vista. */}
          <div className="max-h-96 overflow-x-hidden overflow-y-auto rounded-lg border">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead className="w-36">Línea</TableHead>
                  <TableHead className="w-[26%]">Disponible</TableHead>
                  <TableHead className="w-28 text-right">Lista con IGV</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Elegir</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={rowsRef}>
                {matches.map((p) => {
                  const availability = availabilityOf(
                    stockByProductId.get(p.id),
                    unitSymbol(p.unit),
                  );
                  const kind = p.roofingKind ? KIND_HINT[p.roofingKind] : undefined;
                  return (
                    <TableRow
                      key={p.id}
                      data-product-row
                      tabIndex={0}
                      aria-label={`Elegir ${p.sku}`}
                      className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => {
                        choose(p);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          choose(p);
                        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault();
                          focusRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
                        }
                      }}
                    >
                      <TableCell className="whitespace-normal break-words">
                        <div className="font-medium">{p.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {p.sku}
                          {kind && ` · ${kind}`}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal">
                        {BUSINESS_LINE_LABELS[p.businessLineCode]}
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
                      <TableCell className="text-right text-xs whitespace-normal tabular-nums">
                        <ListPriceCell product={p} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={p.id === selectedProductId ? 'default' : 'outline'}
                          aria-label={`Elegir ${p.sku}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            choose(p);
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
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      {productsSearch.isFetching
                        ? 'Buscando…'
                        : 'Ningún producto coincide con ese texto.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> moverse
            </span>
            <span>
              <Kbd>Enter</Kbd> elegir y pasar a la cantidad
            </span>
            <span>
              <Kbd>Esc</Kbd> cerrar
            </span>
            <span className="ml-auto">Los productos nuevos se crean en Catálogo</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Una tecla, para las ayudas de teclado del pie. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border bg-muted px-1 font-sans text-[11px] text-foreground">
      {children}
    </kbd>
  );
}
