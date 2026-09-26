'use client';

import Link from 'next/link';
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
import { ColorSwatch } from '@/components/colors/color-swatch';
import {
  URL_PAGINATION_DEFAULTS,
  useUrlPagination,
  useUrlSearchInput,
  useUrlState,
} from '@/lib/use-url-state';
import { StatusFilter } from '@/components/status-filter';
import { compareDecimalBy, useSort } from '@/lib/use-sort';
import { RoleGate } from '@/components/role-gate';
import { SortableTableHead } from '@/components/sortable-table-head';
import { formatMoneyOrDash, formatQty, isPositiveDecimal } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { HeaderActions } from '@/components/header-actions';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/pagination-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const ALL = 'ALL';

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
  const [thicknessText, setThicknessText, thicknessMm] = useUrlSearchInput(url.thickness, (v) => {
    setUrl({ thickness: v });
  });
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
          <h1 className="text-lg font-semibold">Bobinas</h1>
          <p className="text-xs text-muted-foreground">
            Materia prima por línea de negocio (RF-23). El alta entra por compra, XML o planilla.
          </p>
        </div>
        {/*
          F8-S3b/M3: principal + «⋯». Principal: la compra de bobinas, que es por donde entra
          casi todo el alta. T6 (D-173): el PDF es el reporte del conjunto filtrado actual —mismos
          filtros que la tabla de abajo—, descarga directa contra el API (patrón D-149).
        */}
        <HeaderActions
          primary={['new-purchase']}
          actions={[
            {
              key: 'new-purchase',
              label: 'Nueva compra de bobinas',
              href: '/compras/nueva?tipo=COIL',
            },
            { key: 'from-xml', label: 'Desde XML', href: '/bobinas/nueva-xml' },
            {
              key: 'pdf',
              label: 'Descargar PDF',
              download: `/api/coils/report-pdf?${queryString}`,
            },
          ]}
        />
      </div>

      {/* Pestañas y filtros comparten fila: son el mismo gesto —acotar la lista— y en dos
          filas costaban 48 px de alto en todas las pantallas (S11, B1). */}
      <div className="flex flex-wrap items-center gap-3">
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

        <Select
          value={businessLine || ALL}
          onValueChange={(v) => {
            setUrl({ line: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-52" aria-label="Línea de negocio">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todas las líneas</SelectItem>
            {BUSINESS_LINES.map((line) => (
              <SelectItem key={line} value={line}>
                {BUSINESS_LINE_LABELS[line]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={finishId || ALL}
          onValueChange={(v) => {
            setUrl({ finish: v === ALL ? '' : v });
          }}
        >
          <SelectTrigger className="w-52" aria-label="Acabado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos los acabados</SelectItem>
            {finishes.data?.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.code} — {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          aria-label="Espesor en milímetros"
          placeholder="Espesor (mm)"
          className="w-36"
          inputMode="decimal"
          value={thicknessText}
          onChange={(e) => {
            setThicknessText(e.target.value);
          }}
        />

        {(tab === 'disponibles' || tab === 'todas') && (
          <Select
            value={film || ALL}
            onValueChange={(v) => {
              setUrl({ film: v === ALL ? '' : v });
            }}
          >
            <SelectTrigger className="w-40" aria-label="Film de protección">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Selladas y abiertas</SelectItem>
              {COIL_FILM_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'SEALED' ? 'Solo selladas' : 'Solo abiertas'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {tab === 'todas' && (
          <StatusFilter
            value={status}
            onChange={(v) => {
              setUrl({ status: v });
            }}
            options={COIL_STATUSES.filter((s) => s !== 'CANCELLED').map((s) => ({
              value: s,
              label: COIL_STATUS_LABELS[s],
            }))}
            negativeValue="CANCELLED"
            className="w-44"
          />
        )}

        <Input
          aria-label="Buscar bobinas por código"
          placeholder="Buscar por código…"
          className="max-w-xs"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
          }}
        />
      </div>

      <div className="rounded-lg border">
        <Table>
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
                  lugar, cuántos metros de plancha da lo disponible — la pregunta de planta. */}
              <TableHead className="text-right">Metro lineal teórico</TableHead>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {coils.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={10}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {coils.isError && (
              <TableRow>
                <TableCell colSpan={10} className="text-destructive">
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
                {/* El API lo calcula con `equivalentMeters` (@ayr/shared, D-116/D-165): kg
                    disponibles ÷ (ancho × espesor × densidad estándar del acabado). */}
                <TableCell className="text-right">
                  {c.equivalentMeters === null ? '—' : formatQty(c.equivalentMeters, 'm')}
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {formatMoneyOrDash(c.unitCostPerKg, c.currency ?? 'PEN', 4)}
                </TableCell>
                <TableCell>
                  <Badge variant={coilTone(c)}>{coilStateLabel(c)}</Badge>
                </TableCell>
              </TableRow>
            ))}
            {coils.isSuccess && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground">
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
    </RoleGate>
  );
}
