'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  COIL_STATUS_LABELS,
  COIL_STATUSES,
  Role,
  type BusinessLine,
  type CoilDto,
  type CoilStatus,
  type FinishDto,
  type PaginatedResult,
} from '@ayr/shared';
import { COIL_TONE } from '@/components/status-tone';
import { api } from '@/lib/api';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { usePagination } from '@/lib/use-pagination';
import { compareBy, compareDecimalBy, useSort } from '@/lib/use-sort';
import { RoleGate } from '@/components/role-gate';
import { SortableTableHead } from '@/components/sortable-table-head';
import { formatMoney, formatQty, isPositiveDecimal } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
 * disponible y en planta—; lo demás (en corte tercerizado, agotadas) queda a un clic
 * pero no compite por espacio. Nada se borra: "Todas" trae la lista completa de antes,
 * con el filtro de Estado fino para cuando alguien necesita ver una anulada puntual.
 */
const VIEW_TABS = ['disponibles', 'en-corte', 'agotadas', 'todas'] as const;
type ViewTab = (typeof VIEW_TABS)[number];
const VIEW_TAB_LABELS: Record<ViewTab, string> = {
  disponibles: 'Disponibles',
  'en-corte': 'En corte',
  agotadas: 'Agotadas',
  todas: 'Todas',
};

/** Inventario de bobinas por línea (RF-23), con filtros de acabado, espesor y estado. */
export function BobinasView() {
  const [tab, setTab] = useState<ViewTab>('disponibles');
  const [businessLine, setBusinessLine] = useState<BusinessLine | typeof ALL>(ALL);
  const [finishId, setFinishId] = useState<string>(ALL);
  const [thicknessMm, setThicknessMm] = useState('');
  // Solo se usa en la pestaña "Todas": las otras tres fijan el estado (o su ausencia)
  // desde la pestaña misma.
  const [status, setStatus] = useState<CoilStatus | typeof ALL>(ALL);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const debouncedThickness = useDebouncedValue(thicknessMm);
  const { page, pageSize, setPage, setPageSize, resetPage } = usePagination();

  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
  });

  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (businessLine !== ALL) params.set('businessLine', businessLine);
  if (finishId !== ALL) params.set('finishId', finishId);
  // Se manda solo cuando ya es un decimal válido: a medio escribir el API responde 400.
  if (isPositiveDecimal(debouncedThickness)) params.set('thicknessMm', debouncedThickness.trim());
  if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
  if (tab === 'disponibles') {
    params.set('statusNe', 'IN_THIRD_PARTY');
    params.set('availability', 'available');
  } else if (tab === 'en-corte') {
    params.set('status', 'IN_THIRD_PARTY');
  } else if (tab === 'agotadas') {
    params.set('statusNe', 'IN_THIRD_PARTY');
    params.set('availability', 'depleted');
  } else if (status !== ALL) {
    params.set('status', status);
  }
  const queryString = params.toString();

  // Volver a la página 1 cuando cambia cualquier filtro: si no, una búsqueda nueva podía
  // dejar la pantalla en blanco en una página que el resultado nuevo ya no tiene.
  useEffect(() => {
    resetPage();
  }, [tab, businessLine, finishId, debouncedThickness, status, debouncedSearch, resetPage]);

  const coils = useQuery({
    queryKey: ['coils', queryString],
    queryFn: () => api<PaginatedResult<CoilDto>>(`/coils?${queryString}`),
  });
  // S10b/M1: sort sobre la página actual, no sobre el total — el orden por defecto del
  // servidor (por `operationDate` descendente, D-124) no se toca salvo que el usuario
  // clickee una columna.
  const [sort, toggleSort] = useSort<'code' | 'availableKg' | 'status'>();
  const unsortedRows = coils.data?.items ?? [];
  const rows =
    sort.key === null
      ? unsortedRows
      : [...unsortedRows].sort((a, b) => {
          switch (sort.key) {
            case 'code':
              return compareBy(sort.dir, a.code, b.code);
            case 'availableKg':
              return compareDecimalBy(sort.dir, a.availableKg, b.availableKg);
            case 'status':
              return compareBy(sort.dir, a.status, b.status);
            default:
              return 0;
          }
        });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Bobinas</h1>
          <p className="text-xs text-muted-foreground">
            Materia prima por línea de negocio (RF-23). El alta entra por compra, XML o planilla.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* T6 (D-173): el reporte del conjunto filtrado actual — mismos filtros que la
              tabla de abajo, la descarga es directa contra el API (patrón D-149). */}
          <Button variant="outline" asChild>
            <a href={`/api/coils/report-pdf?${queryString}`}>Descargar PDF</a>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/bobinas/nueva-xml">Desde XML</Link>
          </Button>
          <Button asChild>
            <Link href="/compras/nueva?tipo=COIL">Nueva compra de bobinas</Link>
          </Button>
        </div>
      </div>

      {/* Pestañas y filtros comparten fila: son el mismo gesto —acotar la lista— y en dos
          filas costaban 48 px de alto en todas las pantallas (S11, B1). */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as ViewTab);
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
          value={businessLine}
          onValueChange={(v) => {
            setBusinessLine(v as BusinessLine | typeof ALL);
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

        <Select value={finishId} onValueChange={setFinishId}>
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
          value={thicknessMm}
          onChange={(e) => {
            setThicknessMm(e.target.value);
          }}
        />

        {tab === 'todas' && (
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as CoilStatus | typeof ALL);
            }}
          >
            <SelectTrigger className="w-44" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos los estados</SelectItem>
              {COIL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {COIL_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Input
          aria-label="Buscar bobinas por código"
          placeholder="Buscar por código…"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
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
              <TableHead className="text-right">Ancho</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Peso</TableHead>
              <SortableTableHead
                active={sort.key === 'availableKg'}
                dir={sort.dir}
                align="right"
                className="text-right"
                onClick={() => {
                  toggleSort('availableKg');
                }}
              >
                Disponible
              </SortableTableHead>
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
                <TableCell className="text-right">{c.widthMm} mm</TableCell>
                <TableCell className="hidden text-right sm:table-cell">
                  {formatQty(c.weightKg, 'kg')}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatQty(c.availableKg, 'kg')}
                </TableCell>
                <TableCell className="hidden text-right lg:table-cell">
                  {formatMoney(c.unitCostPerKg, c.currency, 4)}
                </TableCell>
                <TableCell>
                  <Badge variant={COIL_TONE[c.status]}>{COIL_STATUS_LABELS[c.status]}</Badge>
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
