'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  INVENTORY_ITEM_TYPE_LABELS,
  INVENTORY_MOVEMENT_TYPE_LABELS,
  INVENTORY_REF_TYPE_LABELS,
  REF_TARGET_ROUTES,
  Role,
  businessToday,
  type InventoryItemOptionDto,
  type InventoryMovementDto,
  type PaginatedResult,
} from '@ayr/shared';
import { api } from '@/lib/api';
import {
  formatDate,
  formatMoneyOrDash,
  formatQty,
  formatTimestampDate,
  unitSymbol,
} from '@/lib/format';
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
import { SortableTableHead } from '@/components/sortable-table-head';
import { KardexPepsTable } from './kardex-peps-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FilterChip } from '@/components/filter-chip';
import { HeaderActions } from '@/components/header-actions';
import { RoleGate } from '@/components/role-gate';
import { SearchSelectField, type SearchSelectOption } from '@/components/search-select-modal';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** El id de una opción del selector lleva el tipo: `COIL:<uuid>` o `PRODUCT:<uuid>`. */
/** «Todo» en PEPS: el formato declara un período, así que se lee desde el principio de los tiempos. */
const PEPS_ALL_FROM = '2000-01-01';

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
 * Kardex de un producto o de una bobina (RF-53). D-290: arranca **vacío** —sin ítem no hay
 * kardex que mostrar, y el listado mezclado de movimientos sueltos no respondía ninguna
 * pregunta— y se elige el ítem con un buscador. Con ítem se ve su historial completo del
 * rango elegido (por defecto, el mes en curso), en orden ascendente y con saldo corrido
 * (D-237). Ítem y rango viven en la URL, así que el enlace reproduce la vista.
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
  // D-296: método de costeo de lo que se ve. El promedio ponderado es el del sistema (D-028) y
  // el default; PEPS es un reporte solo del administrador, con las mismas filas que el Excel.
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const pepsMode = hasItem && isAdmin && url.costing === 'peps';

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
  const queryString = query.toString();

  const movements = useQuery({
    queryKey: ['inventory', 'movements', queryString],
    queryFn: () =>
      api<PaginatedResult<InventoryMovementDto>>(`/inventory/movements?${queryString}`),
    enabled: hasItem && !pepsMode,
  });
  // D-295: el kardex de un ítem no pagina (D-237), así que filtrar por columna es exacto.
  const columnFilters = useColumnFilters<'type' | 'origin' | 'notes'>();
  const colFilter = (key: 'type' | 'origin' | 'notes', label: string) => ({
    label,
    value: columnFilters.filters[key] ?? '',
    onChange: (v: string) => {
      columnFilters.setFilter(key, v);
    },
  });
  const rows = columnFilters.apply(movements.data?.items ?? [], {
    type: (m) => INVENTORY_MOVEMENT_TYPE_LABELS[m.type],
    origin: (m) => INVENTORY_REF_TYPE_LABELS[m.refType],
    notes: (m) => `${m.notes ?? ''} ${m.actorName ?? ''}`,
  });

  const setRange = (next: KardexRange) => {
    setUrl({ range: next, from: '', to: '' });
  };

  // D-279: el kardex PEPS (formato 13.1) es de un producto o una bobina y solo lo baja el
  // administrador. El formato siempre declara un período: sin fechas, el mes en curso.
  const pepsFrom = dates.from || `${today.slice(0, 7)}-01`;
  const pepsTo = dates.to || today;
  const canDownloadPeps = hasItem && isAdmin;

  const columnCount = 9;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA, Role.VENDEDOR]}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Kardex</h1>
          <p className="text-xs text-muted-foreground">
            {hasItem
              ? `Movimientos de ${selectedItem.data ? `${INVENTORY_ITEM_TYPE_LABELS[selectedItem.data.itemType]} ${selectedItem.data.code}` : 'el ítem seleccionado'}, con saldo corrido (RF-53).`
              : 'Saldo corrido de un producto o de una bobina (RF-53).'}
          </p>
        </div>
        {canDownloadPeps && (
          <HeaderActions
            primary={['peps']}
            actions={[
              {
                key: 'peps',
                label: 'Descargar PEPS (SUNAT 13.1)',
                download: `/api/reports/kardex-peps/xlsx?itemType=${itemType}&itemId=${itemId}&from=${pepsFrom}&to=${pepsTo}`,
                // Una descarga principal es un enlace y no se deshabilita: con el rango al
                // revés el API respondería 400, así que el botón no se ofrece.
                show: pepsFrom <= pepsTo,
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
        {hasItem && isAdmin && (
          <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Método de costeo</span>
            <Select
              value={pepsMode ? 'peps' : 'avg'}
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
          </div>
        )}
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
      ) : pepsMode ? (
        <KardexPepsTable
          itemType={itemType as 'COIL' | 'PRODUCT'}
          itemId={itemId}
          from={dates.from || PEPS_ALL_FROM}
          to={dates.to || today}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Fecha de operación</TableHead>
                <SortableTableHead filter={colFilter('type', 'movimiento')}>
                  Movimiento
                </SortableTableHead>
                <SortableTableHead
                  className="hidden md:table-cell"
                  filter={colFilter('origin', 'origen')}
                >
                  Origen
                </SortableTableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Costo unit. (S/)</TableHead>
                <TableHead className="text-right">Total (S/)</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Costo prom.</TableHead>
                <SortableTableHead filter={colFilter('notes', 'motivo o usuario')}>
                  Motivo / usuario
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.isPending && (
                <TableRow>
                  <TableCell colSpan={columnCount}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {movements.isError && (
                <TableRow>
                  <TableCell colSpan={columnCount} className="text-destructive">
                    No se pudo cargar el kardex.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((m) => (
                <TableRow key={m.id} className={m.reversedById ? 'opacity-60' : undefined}>
                  {/*
                    D-124: manda la fecha de operación —el día de negocio al que pertenece el
                    movimiento— porque es por la que esta tabla ordena y por la que el filtro
                    corta. El instante de grabación queda debajo y solo cuando difieren: en
                    una operación del día repetirlo sería ruido, y en una carga histórica es
                    justo lo que permite ver que se registró después.
                  */}
                  <TableCell className="whitespace-nowrap">
                    <div>{formatDate(m.operationDate)}</div>
                    {formatDate(m.operationDate) !== formatTimestampDate(m.at) && (
                      <div className="text-xs text-muted-foreground">
                        registrado {new Date(m.at).toLocaleString('es-PE')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.type === 'IN' ? 'secondary' : 'outline'}>
                      {INVENTORY_MOVEMENT_TYPE_LABELS[m.type]}
                    </Badge>
                    {m.reversalOfId && (
                      <span className="ml-2 text-xs text-muted-foreground">anulación</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {/* F8-S5/M1 (D-205): la referencia se vuelve link cuando el API ya
                        resolvió a qué pantalla apunta (`refTargetType`) y el rol de quien
                        mira puede entrar ahí — `/kardex` la ven los tres roles, pero sus
                        destinos son más angostos (revisor); sin el rol que corresponde queda
                        como el mismo texto de siempre, no un link que el propio destino
                        rebota. Un `SPLIT`, una `SCRAP` o un `CLOSE_ADJUSTMENT` señalan la
                        bobina que ya se está mirando y no necesitan link propio. */}
                    {m.refTargetType &&
                    m.refTargetId &&
                    REF_TARGET_ROLES[m.refTargetType].includes(user.role) ? (
                      <Link
                        className={LINK_CLASSNAME}
                        href={`${REF_TARGET_ROUTES[m.refTargetType]}/${m.refTargetId}`}
                      >
                        {INVENTORY_REF_TYPE_LABELS[m.refType]}
                      </Link>
                    ) : (
                      INVENTORY_REF_TYPE_LABELS[m.refType]
                    )}
                    {/* D-205: solo una venta puede llevar factura enlazada, y solo desde el
                        mostrador (el único punto sin ambigüedad despacho↔comprobante). Sin
                        enlace no es "sin comprobante": es "no enlazado todavía" — deuda
                        documentada, no un hueco de datos. */}
                    {m.refType === 'SALE' && (
                      <div className="text-xs text-muted-foreground">
                        Factura:{' '}
                        {m.invoiceId && INVOICE_LINK_ROLES.includes(user.role) ? (
                          <Link className={LINK_CLASSNAME} href={`/comprobantes/${m.invoiceId}`}>
                            ver
                          </Link>
                        ) : (
                          '—'
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Un ADJUST no mueve cantidad: su `qty` son los kilos sobre los que se
                        repartió el costo, mostrarlo como movimiento confundiría el saldo. */}
                    {m.type === 'ADJUST' ? '—' : formatQty(m.qty, unitSymbol(m.unit))}
                  </TableCell>
                  <TableCell className="hidden text-right lg:table-cell">
                    {formatMoneyOrDash(m.unitCost, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right">{formatMoneyOrDash(m.totalCost)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {m.balanceQty ? formatQty(m.balanceQty, unitSymbol(m.unit)) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoneyOrDash(m.balanceAvgCost, 'PEN', 4)}
                  </TableCell>
                  {/* S11/F3-01: es la columna que hay que leer entera cuando se audita un
                      movimiento, y se cortaba con «…» sin forma de ver el resto. El texto
                      completo queda en el `title`. */}
                  <TableCell
                    className="max-w-xs truncate text-muted-foreground"
                    title={[m.notes, m.actorName].filter(Boolean).join(' · ')}
                  >
                    {m.notes ?? ''}
                    {m.notes && m.actorName ? ' · ' : ''}
                    {m.actorName ?? ''}
                  </TableCell>
                </TableRow>
              ))}
              {movements.isSuccess && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columnCount} className="text-center text-muted-foreground">
                    {columnFilters.hasActive
                      ? 'Ningún movimiento coincide con los filtros de columna.'
                      : 'No hay movimientos en este rango. Prueba con «Mes anterior» o «Todo».'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </RoleGate>
  );
}
