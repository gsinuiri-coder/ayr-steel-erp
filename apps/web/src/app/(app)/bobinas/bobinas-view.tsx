'use client';

import { SelectFilterField } from '@/components/select-filter-field';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  COIL_FILM_STATES,
  COIL_STATUS_LABELS,
  COIL_STATUSES,
  coilStateLabel,
  Role,
  type BusinessLine,
  type CoilDto,
  type CoilFilmState,
  type FinishDto,
  type PaginatedResult,
} from '@ayr/shared';
import { coilTone } from '@/components/status-tone';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { RowActions } from '@/components/row-actions';
import { canRestoreCoil, RestoreCoilDialog } from '@/components/coils/restore-coil-dialog';
import { ColorSwatch } from '@/components/colors/color-swatch';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import {
  FilterField,
  FiltersDialog,
  TableToolbar,
  ToolbarSearch,
} from '@/components/table-toolbar';
import { compareDecimalBy, useSort } from '@/lib/use-sort';
import { RoleGate } from '@/components/role-gate';
import { SortableTableHead } from '@/components/sortable-table-head';
import { formatMoneyOrDash, formatQty, isPositiveDecimal } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { HeaderActions } from '@/components/header-actions';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** cc47 (D-615): los filtros del modal, con los mismos valores que la URL. */
interface CoilFilters {
  line: string;
  finish: string;
  thickness: string;
  film: string;
  status: string;
}

const NO_COIL_FILTERS: CoilFilters = { line: '', finish: '', thickness: '', film: '', status: '' };

/**
 * Pestañas de la vista (Fase 7e, D-121): el default es lo que planta usa a diario —
 * disponible y en planta—; lo demás (en corte tercerizado, terminadas) queda a un clic
 * pero no compite por espacio. Nada se borra: "Todas" trae la lista completa de antes,
 * con el filtro de Estado fino para cuando alguien necesita ver una anulada puntual.
 *
 * D-328: «Agotadas» pasó a llamarse «Terminadas» (solo el rótulo: sigue siendo saldo en cero).
 */
const VIEW_TABS = ['disponibles', 'en-corte', 'terminadas', 'todas'] as const;
type ViewTab = (typeof VIEW_TABS)[number];
const VIEW_TAB_LABELS: Record<ViewTab, string> = {
  disponibles: 'Disponibles',
  'en-corte': 'En corte',
  terminadas: 'Terminadas',
  todas: 'Todas',
};

/** Inventario de bobinas por línea (RF-23), con filtros de acabado, espesor y estado. */
export function BobinasView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [restoring, setRestoring] = useState<CoilDto | null>(null);
  // D-289: pestaña, filtros, búsqueda y página viven en la URL.
  const [url, setUrl] = useUrlState({
    ...URL_PAGINATION_DEFAULTS,
    tab: 'disponibles',
    line: '',
    finish: '',
    thickness: '',
    // Solo se usa en la pestaña "Todas": las otras tres fijan el estado (o su ausencia)
    // desde la pestaña misma.
    status: '',
    // D-328: solo las selladas o solo las abiertas (las vigentes se rotulan por su film).
    film: '',
    search: '',
  });
  const { page, pageSize, setPage, setPageSize } = useUrlPagination(url, setUrl);
  const tab: ViewTab = (VIEW_TABS as readonly string[]).includes(url.tab)
    ? (url.tab as ViewTab)
    : 'disponibles';
  const businessLine = url.line as BusinessLine | '';
  const finishId = url.finish;
  const status = url.status;
  const film = (COIL_FILM_STATES as readonly string[]).includes(url.film)
    ? (url.film as CoilFilmState)
    : '';
  // cc47 (D-615): el espesor se escribe en el modal «Filtros» y llega a la URL con «Aplicar».
  const thicknessMm = url.thickness.trim();
  const [searchText, setSearchText, search] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });

  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
  });

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (businessLine) params.set('businessLine', businessLine);
  if (finishId) params.set('finishId', finishId);
  // Se manda solo cuando ya es un decimal válido: a medio escribir el API responde 400.
  if (isPositiveDecimal(thicknessMm)) params.set('thicknessMm', thicknessMm);
  if (search) params.set('search', search);
  if (tab === 'disponibles') {
    params.set('statusNe', 'IN_THIRD_PARTY');
    params.set('availability', 'available');
  } else if (tab === 'en-corte') {
    params.set('status', 'IN_THIRD_PARTY');
  } else if (tab === 'terminadas') {
    params.set('statusNe', 'IN_THIRD_PARTY');
    params.set('availability', 'depleted');
  } else if (status) {
    params.set('status', status);
  }
  if (film && (tab === 'disponibles' || tab === 'todas')) params.set('film', film);
  const [sort, toggleSort] = useSort<'code' | 'availableKg' | 'status'>();
  if (sort.key === 'code' || sort.key === 'status') {
    params.set('sort', sort.key);
    params.set('dir', sort.dir);
  }
  const queryString = params.toString();

  const coils = useQuery({
    queryKey: ['coils', queryString],
    queryFn: () => api<PaginatedResult<CoilDto>>(`/coils?${queryString}`),
  });
  // D-323: código y estado se ordenan en el servidor; el disponible vive en el kardex y no es una
  // columna de la bobina, así que ordena solo las filas de la página.
  const rawRows = coils.data?.items ?? [];
  const rows =
    sort.key === 'availableKg'
      ? [...rawRows].sort((x, y) => compareDecimalBy(sort.dir, x.availableKg, y.availableKg))
      : rawRows;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Bobinas</h1>
          <p className="text-xs text-muted-foreground">
            Materia prima por línea de negocio. El alta entra por compra, XML o planilla.
          </p>
        </div>
        {/*
          F8-S3b/M3: principal + «⋯». Principal: la compra de bobinas, que es por donde entra
          casi todo el alta. cc47 (D-615): el PDF pasa a la línea de la tabla.
        */}
        <HeaderActions
          primary={['new-purchase', 'import-purchases']}
          actions={[
            {
              key: 'new-purchase',
              label: 'Nueva compra de bobinas',
              href: '/compras/nueva?tipo=COIL',
            },
            // D-351: el importador de compras, el mismo para los cuatro tipos (una bobina no
            // existe sin su compra).
            {
              key: 'import-purchases',
              label: 'Importar compra de bobinas',
              href: '/compras/importar',
            },
            { key: 'from-xml', label: 'Desde XML', href: '/bobinas/nueva-xml' },
            // T6 (D-173): el PDF es el reporte del conjunto filtrado actual —mismos filtros que la
            // tabla de abajo—, descarga directa contra el API (patrón D-149).
            {
              key: 'pdf',
              label: 'Descargar PDF',
              download: `/api/coils/report-pdf?${queryString}`,
            },
          ]}
        />
      </div>

      {/* La pestaña de vista es la principal de la página (en la URL, como antes); debajo, la
          línea estándar (cc47, D-615): buscar, «Filtros» y, a la derecha, el PDF. */}
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setUrl({ tab: v });
        }}
      >
        <TabsList>
          {VIEW_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {VIEW_TAB_LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <TableToolbar
        search={
          <ToolbarSearch
            label="Buscar bobinas por código"
            placeholder="Buscar por código…"
            value={searchText}
            onChange={setSearchText}
          />
        }
        filters={
          <FiltersDialog<CoilFilters>
            value={{
              line: url.line,
              finish: url.finish,
              thickness: url.thickness,
              film: url.film,
              status: url.status,
            }}
            empty={NO_COIL_FILTERS}
            activeCount={
              [
                businessLine,
                finishId,
                isPositiveDecimal(thicknessMm) ? thicknessMm : '',
                tab === 'disponibles' || tab === 'todas' ? film : '',
                tab === 'todas' ? status : '',
              ].filter(Boolean).length
            }
            validate={(d) =>
              d.thickness.trim() === '' || isPositiveDecimal(d.thickness.trim())
                ? null
                : 'El espesor tiene que ser un número mayor que cero, en milímetros.'
            }
            onApply={(next) => {
              setUrl({ ...next, thickness: next.thickness.trim() });
            }}
          >
            {(draft, update) => (
              <>
                <SelectFilterField
                  id="filtro-linea"
                  label="Línea de negocio"
                  value={draft.line}
                  onChange={(v) => {
                    update({ line: v });
                  }}
                  allLabel="Todas las líneas"
                  options={BUSINESS_LINES.map((line) => ({
                    value: line,
                    label: BUSINESS_LINE_LABELS[line],
                  }))}
                />
                <SelectFilterField
                  id="filtro-acabado"
                  label="Acabado"
                  value={draft.finish}
                  onChange={(v) => {
                    update({ finish: v });
                  }}
                  allLabel="Todos los acabados"
                  options={(finishes.data ?? []).map((f) => ({
                    value: f.id,
                    label: `${f.code} — ${f.name}`,
                  }))}
                />
                <FilterField label="Espesor (mm)" htmlFor="filtro-espesor">
                  <Input
                    id="filtro-espesor"
                    placeholder="Todos"
                    className="w-36"
                    inputMode="decimal"
                    value={draft.thickness}
                    onChange={(e) => {
                      update({ thickness: e.target.value });
                    }}
                  />
                </FilterField>
                {(tab === 'disponibles' || tab === 'todas') && (
                  <SelectFilterField
                    id="filtro-film"
                    label="Film de protección"
                    value={draft.film}
                    onChange={(v) => {
                      update({ film: v });
                    }}
                    allLabel="Selladas y abiertas"
                    options={COIL_FILM_STATES.map((st) => ({
                      value: st,
                      label: st === 'SEALED' ? 'Solo selladas' : 'Solo abiertas',
                    }))}
                  />
                )}
                {tab === 'todas' && (
                  <FilterField label="Estado">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusFilter
                        value={draft.status}
                        onChange={(v) => {
                          update({ status: v });
                        }}
                        options={COIL_STATUSES.filter((st) => st !== 'CANCELLED').map((st) => ({
                          value: st,
                          label: COIL_STATUS_LABELS[st],
                        }))}
                        negativeValue="CANCELLED"
                      />
                    </div>
                  </FilterField>
                )}
              </>
            )}
          </FiltersDialog>
        }
      />

      <div className="rounded-lg border">
        <Table list>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortableTableHead
                active={sort.key === 'code'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('code');
                }}
              >
                Código
              </SortableTableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="hidden md:table-cell">Línea</TableHead>
              <TableHead className="hidden lg:table-cell">Proveedor</TableHead>
              <TableHead>Color</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Peso</TableHead>
              <SortableTableHead
                active={sort.key === 'availableKg'}
                dir={sort.dir}
                title="Ordena las filas de esta página"
                align="right"
                className="text-right"
                onClick={() => {
                  toggleSort('availableKg');
                }}
              >
                Disponible
              </SortableTableHead>
              {/* D-281: el ancho sale de la tabla (sigue en el detalle y en el PDF); en su
                  lugar, el metro lineal teórico; D-356: del peso inicial (el del disponible está en
                  Inventario → «Bobinas por tipo» y en el detalle). */}
              <TableHead className="text-right">ML teórico (peso inicial)</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Costo/kg</TableHead>
              <SortableTableHead
                active={sort.key === 'status'}
                dir={sort.dir}
                onClick={() => {
                  toggleSort('status');
                }}
              >
                Estado
              </SortableTableHead>
              {isAdmin && (
                <TableHead className="w-10">
                  <span className="sr-only">Acciones</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {coils.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={isAdmin ? 11 : 10}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {coils.isError && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 11 : 10} className="text-destructive">
                  No se pudieron cargar las bobinas.
                </TableCell>
              </TableRow>
            )}
            {rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono font-medium">
                  <Link className={LINK_CLASSNAME} href={`/bobinas/${c.id}`}>
                    {c.code}
                  </Link>
                </TableCell>
                <TableCell>{c.typeKey}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {BUSINESS_LINE_LABELS[c.businessLine]}
                </TableCell>
                <TableCell className="hidden lg:table-cell">{c.supplierName}</TableCell>
                <TableCell>
                  <ColorSwatch
                    color={
                      c.colorName && c.colorHex ? { name: c.colorName, hexColor: c.colorHex } : null
                    }
                  />
                </TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  {formatQty(c.weightKg, 'kg')}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatQty(c.availableKg, 'kg')}
                </TableCell>
                {/* D-356: el API lo calcula con `equivalentMeters` (@ayr/shared, D-116/D-165) sobre el
                 **peso inicial**: kg ÷ (ancho × espesor × densidad estándar del acabado). */}
                <TableCell className="text-right">
                  {c.initialMeters === null ? '—' : formatQty(c.initialMeters, 'm')}
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {formatMoneyOrDash(c.unitCostPerKg, c.currency ?? 'PEN', 4)}
                </TableCell>
                <TableCell>
                  <Badge variant={coilTone(c)}>{coilStateLabel(c)}</Badge>
                </TableCell>
                {isAdmin && (
                  <TableCell className="w-10">
                    {/* D-375: «Restaurar» en el menú de la fila, solo en anuladas de compra. */}
                    <RowActions
                      label={c.code}
                      primary={null}
                      actions={[
                        {
                          key: 'restore',
                          label: 'Restaurar',
                          show: canRestoreCoil(c),
                          onSelect: () => {
                            setRestoring(c);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {coils.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={isAdmin ? 11 : 10}
                  className="text-center text-muted-foreground"
                >
                  No hay bobinas que coincidan con los filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={coils.data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={coils.isFetching}
      />
      {restoring && (
        <RestoreCoilDialog
          coil={restoring}
          open
          onOpenChange={(open) => {
            if (!open) setRestoring(null);
          }}
        />
      )}
    </RoleGate>
  );
}
