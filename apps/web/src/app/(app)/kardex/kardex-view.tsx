'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  INVENTORY_ITEM_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  KARDEX_ALL_FROM,
  KARDEX_METHOD_LABELS,
  REF_TARGET_ROUTES,
  Role,
  businessToday,
  movementsToKardexSheet,
  pepsToKardexSheet,
  type InventoryItemOptionDto,
  type InventoryMovementDto,
  type KardexMethod,
  type KardexPepsReportDto,
  type KardexSheetRow,
  type PaginatedResult,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { formatDate, formatTimestampDate } from '@/lib/format';
import {
  isIsoDate,
  KARDEX_RANGE_LABELS,
  parseKardexRange,
  resolveKardexDates,
  type KardexRange,
} from '@/lib/kardex-range';
import { INVOICE_LINK_ROLES, REF_TARGET_ROLES } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { useColumnFilters } from '@/lib/use-column-filters';
import { useUrlState } from '@/lib/use-url-state';
import { FilterChip } from '@/components/filter-chip';
import { HeaderActions } from '@/components/header-actions';
import { RoleGate } from '@/components/role-gate';
import { SearchSelectField, type SearchSelectOption } from '@/components/search-select-modal';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LINK_CLASSNAME } from '@/lib/utils';
import { KardexSheetTable } from './kardex-sheet-table';

/** El id de una opción del selector lleva el tipo: `COIL:<uuid>` o `PRODUCT:<uuid>`. */
function optionId(item: Pick<InventoryItemOptionDto, 'itemType' | 'itemId'>): string {
  return `${item.itemType}:${item.itemId}`;
}

function toOption(item: InventoryItemOptionDto): SearchSelectOption {
  return {
    id: optionId(item),
    label: item.code,
    // El tipo va en el hint: el modal no distingue bobinas de productos de otra forma.
    hint: `${INVENTORY_ITEM_TYPE_LABELS[item.itemType]} · ${item.description}${item.inactive ? ' · inactivo' : ''}`,
  };
}

/**
 * Kardex de un producto o de una bobina (RF-53). D-290: arranca **vacío** y se elige el ítem con
 * un buscador; el rango por defecto es el mes en curso. D-298: la hoja tiene el **formato del
 * cliente** —Fecha, Detalle, ENTRADAS, SALIDAS y SALDO, cada uno con cantidad, C.U. y monto— para
 * los dos métodos de costeo: Promedio (el del sistema, D-028) y PEPS (reporte de D-279/D-296, solo
 * del administrador). Ítem, rango y método viven en la URL.
 */
export function KardexView() {
  const { user } = useSession();
  const [url, setUrl] = useUrlState({
    itemType: '',
    item: '',
    range: '',
    costing: '',
    from: '',
    to: '',
  });

  // La URL la escribe cualquiera: un tipo inventado no llega al API (daría 400 y un «no se
  // pudo cargar» sin explicación). Los enlaces viejos (`?itemType=COIL&item=…`) siguen sirviendo.
  const itemType = url.itemType === 'PRODUCT' || url.itemType === 'COIL' ? url.itemType : '';
  const itemId = url.item;
  const hasItem = Boolean(itemType && itemId);

  const range = parseKardexRange(url.range);
  const today = businessToday();
  const dates = resolveKardexDates(range, url.from, url.to, today);
  // D-296/D-298: el promedio ponderado es el del sistema (D-028) y el default; PEPS es un reporte
  // solo del administrador.
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const method: KardexMethod = hasItem && isAdmin && url.costing === 'peps' ? 'PEPS' : 'AVERAGE';

  const selectedItem = useQuery({
    queryKey: ['inventory', 'item', itemType, itemId],
    queryFn: () =>
      api<InventoryItemOptionDto>(
        `/inventory/items/resolve?itemType=${itemType}&itemId=${encodeURIComponent(itemId)}`,
      ),
    enabled: hasItem,
  });

  const query = new URLSearchParams({ itemType, itemId });
  if (dates.from) query.set('from', dates.from);
  if (dates.to) query.set('to', dates.to);
  const movements = useQuery({
    queryKey: ['inventory', 'movements', query.toString()],
    queryFn: () =>
      api<PaginatedResult<InventoryMovementDto>>(`/inventory/movements?${query.toString()}`),
    enabled: hasItem && method === 'AVERAGE',
  });
  // PEPS: el rango es obligatorio en el formato; sin fechas, desde el principio hasta hoy.
  const excelFrom = dates.from || KARDEX_ALL_FROM;
  const excelTo = dates.to || today;
  const validRange = excelFrom <= excelTo;
  const peps = useQuery({
    queryKey: ['reports', 'kardex-peps', itemType, itemId, excelFrom, excelTo],
    queryFn: () =>
      api<KardexPepsReportDto>(
        `/reports/kardex-peps?itemType=${itemType}&itemId=${encodeURIComponent(itemId)}&from=${excelFrom}&to=${excelTo}`,
      ),
    enabled: hasItem && method === 'PEPS' && validRange,
  });

  // La hoja del cliente: los mismos números de siempre, en su formato (D-298).
  const movementById = new Map((movements.data?.items ?? []).map((m) => [m.id, m]));
  const sheet =
    method === 'PEPS'
      ? peps.data
        ? pepsToKardexSheet(peps.data)
        : null
      : movements.data
        ? movementsToKardexSheet(movements.data.items, {
            itemCode: selectedItem.data?.code ?? '',
            itemDescription: selectedItem.data?.description ?? '',
            from: dates.from,
            to: dates.to,
            unit: movements.data.items[0]?.unit ?? null,
          })
        : null;

  // D-295: el kardex de un ítem no pagina (D-237), así que filtrar por columna es exacto.
  const columnFilters = useColumnFilters<'detail'>();
  const rows = columnFilters.apply(sheet?.rows ?? [], {
    detail: (r) => r.detail,
  });
  const isPending = method === 'PEPS' ? peps.isPending && validRange : movements.isPending;
  const isError = method === 'PEPS' ? peps.isError : movements.isError;

  const setRange = (next: KardexRange) => {
    setUrl({ range: next, from: '', to: '' });
  };

  /** «Detalle» del promedio: el origen con su enlace (D-205), la nota y el usuario. */
  const renderAverageDetail = (row: KardexSheetRow) => {
    const m = movementById.get(row.key);
    if (!m) return row.detail;
    const label = INVENTORY_REF_TYPE_LABELS[m.refType];
    const canLink =
      m.refTargetType && m.refTargetId && REF_TARGET_ROLES[m.refTargetType].includes(user.role);
    return (
      <div>
        <div>
          {canLink && m.refTargetType && m.refTargetId ? (
            <Link
              className={LINK_CLASSNAME}
              href={`${REF_TARGET_ROUTES[m.refTargetType]}/${m.refTargetId}`}
            >
              {label}
            </Link>
          ) : (
            label
          )}
          {m.reversalOfId && <span className="ml-2 text-xs text-muted-foreground">anulación</span>}
          {m.type === 'ADJUST' && (
            <span className="ml-2 text-xs text-muted-foreground">ajuste de costo</span>
          )}
          {/* D-205: solo una venta puede llevar factura enlazada, y solo desde el mostrador. */}
          {m.refType === 'SALE' && (
            <span className="ml-2 text-xs text-muted-foreground">
              Factura:{' '}
              {m.invoiceId && INVOICE_LINK_ROLES.includes(user.role) ? (
                <Link className={LINK_CLASSNAME} href={`/comprobantes/${m.invoiceId}`}>
                  ver
                </Link>
              ) : (
                '—'
              )}
            </span>
          )}
        </div>
        {(m.notes ?? m.actorName) && (
          <div className="text-xs text-muted-foreground">
            {[m.notes, m.actorName].filter(Boolean).join(' · ')}
          </div>
        )}
        {/* D-124: la fecha de operación manda; el instante de grabación solo si difiere. */}
        {formatDate(m.operationDate) !== formatTimestampDate(m.at) && (
          <div className="text-xs text-muted-foreground">
            registrado {new Date(m.at).toLocaleString('es-PE')}
          </div>
        )}
      </div>
    );
  };

  const excelHref = `/api/reports/kardex/xlsx?itemType=${itemType}&itemId=${itemId}&from=${excelFrom}&to=${excelTo}&method=${method}`;
  const sunatHref = `/api/reports/kardex-peps/xlsx?itemType=${itemType}&itemId=${itemId}&from=${dates.from || `${today.slice(0, 7)}-01`}&to=${excelTo}`;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Kardex</h1>
          <p className="text-xs text-muted-foreground">
            Saldo corrido de un producto o de una bobina (RF-53).
          </p>
        </div>
        {hasItem && isAdmin && (
          <HeaderActions
            primary={['excel']}
            actions={[
              {
                key: 'excel',
                label: 'Descargar Excel',
                download: excelHref,
                // Una descarga principal es un enlace y no se deshabilita: con el rango al
                // revés el API respondería 400, así que el botón no se ofrece.
                show: validRange,
              },
              {
                key: 'sunat',
                label: 'Descargar PEPS (SUNAT 13.1)',
                download: sunatHref,
                show: validRange,
              },
            ]}
          />
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Ítem</span>
          <SearchSelectField
            className="w-80"
            label="Ítem del kardex"
            placeholder="Buscar bobina por código o producto por SKU / nombre"
            actionLabel="Ver kardex"
            value={hasItem ? `${itemType}:${itemId}` : null}
            selectedOption={selectedItem.data ? toOption(selectedItem.data) : null}
            selectedOptionLoading={selectedItem.isLoading}
            search={(q) =>
              api<InventoryItemOptionDto[]>(
                `/inventory/items/search?q=${encodeURIComponent(q)}`,
              ).then((list) => list.map(toOption))
            }
            onChange={(id) => {
              const [type = '', ...rest] = id.split(':');
              setUrl({ itemType: type, item: rest.join(':') });
            }}
          />
        </div>

        <div className="flex items-center gap-2" role="group" aria-label="Rango de fechas">
          {(Object.keys(KARDEX_RANGE_LABELS) as (keyof typeof KARDEX_RANGE_LABELS)[]).map((r) => (
            <FilterChip
              key={r}
              active={range === r}
              onToggle={() => {
                setRange(r);
              }}
            >
              {KARDEX_RANGE_LABELS[r]}
            </FilterChip>
          ))}
        </div>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Desde</span>
          <Input
            type="date"
            className="w-40"
            value={dates.from}
            onChange={(e) => {
              setUrl({ range: 'custom', from: e.target.value, to: dates.to });
            }}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Hasta</span>
          <Input
            type="date"
            className="w-40"
            value={dates.to}
            onChange={(e) => {
              setUrl({ range: 'custom', from: dates.from, to: e.target.value });
            }}
          />
        </label>
      </div>
      {range === 'custom' &&
        dates.from &&
        dates.to &&
        !(isIsoDate(dates.from) && dates.from <= dates.to) && (
          <p className="text-xs text-destructive">La fecha «Desde» es posterior a «Hasta».</p>
        )}

      {!hasItem ? (
        <div
          className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          data-testid="kardex-empty"
        >
          Elegí un ítem para ver su kardex
        </div>
      ) : (
        <>
          {/* Cabecera de la hoja del cliente: Producto / Código / Método. */}
          <dl
            className="grid grid-cols-[1fr_auto_auto] items-end gap-x-6 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-sm"
            data-testid="kardex-header"
          >
            <div>
              <dt className="text-xs text-muted-foreground">Producto</dt>
              <dd className="font-medium">{selectedItem.data?.description ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Código</dt>
              <dd className="font-mono font-medium">{selectedItem.data?.code ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Método</dt>
              <dd>
                {isAdmin ? (
                  <Select
                    value={method === 'PEPS' ? 'peps' : 'avg'}
                    onValueChange={(v) => {
                      setUrl({ costing: v === 'peps' ? 'peps' : '' });
                    }}
                  >
                    <SelectTrigger className="w-56" aria-label="Método de costeo">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="avg">Promedio (por defecto)</SelectItem>
                      <SelectItem value="peps">PEPS</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="font-medium">{KARDEX_METHOD_LABELS.AVERAGE}</span>
                )}
              </dd>
            </div>
          </dl>
          {method === 'PEPS' && (
            <p className="text-xs text-muted-foreground">
              Kardex valorizado por PEPS (formato 13.1 de SUNAT): es un reporte, la valorización del
              sistema sigue en costo promedio.
              {peps.data && peps.data.warnings.length > 0 && (
                <span className="text-destructive">
                  {' '}
                  {peps.data.warnings.length} advertencia(s) del cálculo: ver el Detalle.
                </span>
              )}
            </p>
          )}
          {!validRange ? (
            <p className="text-sm text-destructive">
              El rango termina antes de empezar: corrige «Desde» y «Hasta».
            </p>
          ) : (
            <KardexSheetTable
              rows={rows}
              isPending={isPending}
              isError={isError}
              emptyMessage={
                columnFilters.hasActive
                  ? 'Ningún movimiento coincide con el filtro del detalle.'
                  : 'No hay movimientos en este rango. Prueba con «Mes anterior» o «Todo».'
              }
              detailFilter={{
                value: columnFilters.filters.detail ?? '',
                onChange: (v) => {
                  columnFilters.setFilter('detail', v);
                },
              }}
              renderDetail={method === 'AVERAGE' ? renderAverageDetail : undefined}
              rowClassName={(row) =>
                method === 'AVERAGE' && movementById.get(row.key)?.reversedById
                  ? 'opacity-60'
                  : undefined
              }
            />
          )}
        </>
      )}
    </RoleGate>
  );
}
