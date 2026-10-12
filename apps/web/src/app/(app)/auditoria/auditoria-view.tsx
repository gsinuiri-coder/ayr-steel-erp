'use client';

import Link from 'next/link';
import { Copy } from 'lucide-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_SOURCE_LABELS,
  auditActionLabel,
  auditActionOptions,
  auditChangedKeys,
  auditEntityTypeLabel,
  auditFieldLabel,
  auditFieldValueLabel,
  businessToday,
  isPriceListValueField,
  money,
  Role,
  salePriceFromValue,
  toFixedString,
  type AuditEventDto,
  type AuditPageDto,
  type UserDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import {
  AUDIT_URL_DEFAULTS,
  auditActiveFilterCount,
  auditDefaultPeriodLabel,
  auditParamsOf,
  auditSearchNotice,
} from '@/lib/audit-url';
import { formatMoney, formatDateTime } from '@/lib/format';
import { listXlsxHref } from '@/lib/list-export';
import { toast } from '@/lib/notify';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { cn, LINK_CLASSNAME } from '@/lib/utils';
import { HeaderActions } from '@/components/header-actions';
import { SelectFilterField } from '@/components/select-filter-field';
import {
  FilterField,
  FiltersDialog,
  TableToolbar,
  ToolbarSearch,
} from '@/components/table-toolbar';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Precio de lista (D-217): se guarda sin IGV y el catálogo lo muestra con IGV — el visor sigue
 *  el mismo vocabulario en vez de mostrar el valor crudo de la base (D-225/ajustes UAT). */
function formatPriceListValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return formatMoney(toFixedString(money(salePriceFromValue(value as string)), 'MONEY'));
}

function formatFieldValue(event: AuditEventDto, key: string, value: unknown): string {
  if (isPriceListValueField(event.source, event.action, key)) return formatPriceListValue(value);
  const mapped = auditFieldValueLabel(key, value);
  if (mapped) return mapped;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Diff campo por campo entre `before` y `after` (D-218/M3): nunca un volcado de JSON crudo.
 * Solo se muestran los campos que cambiaron; si no hay ninguno (los dos vacíos, o iguales),
 * se dice explícitamente en vez de dejar la fila en blanco.
 */
function EventDiff({ event }: { event: AuditEventDto }) {
  const changed = auditChangedKeys(event);

  if (changed.length === 0) {
    return <span className="text-muted-foreground">Sin detalle registrado.</span>;
  }

  return (
    <ul className="space-y-0.5">
      {changed.map((k) => {
        const hasBefore = event.before !== null && k in event.before;
        const hasAfter = event.after !== null && k in event.after;
        return (
          <li key={k}>
            <span className="text-muted-foreground">{auditFieldLabel(k)}: </span>
            {hasBefore && <span>{formatFieldValue(event, k, event.before?.[k])}</span>}
            {hasBefore && hasAfter && <span className="text-muted-foreground"> → </span>}
            {hasAfter && (
              <span className="font-medium">{formatFieldValue(event, k, event.after?.[k])}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** cc48 (D-633): el UUID completo sigue a mano, sin ocupar la fila. */
function CopyIdButton({ id }: { id: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={id}
      aria-label={`Copiar id ${id}`}
      onClick={() => {
        void navigator.clipboard.writeText(id).then(
          () => toast.success('Id copiado'),
          () => toast.error('No se pudo copiar el id'),
        );
      }}
    >
      <Copy aria-hidden />
    </Button>
  );
}

/**
 * cc48 (D-633): la entidad con su código legible (PED-…, el número del comprobante, el código de
 * la bobina, el SKU, el nombre del cliente…), enlazado a su detalle cuando existe. Una entidad
 * borrada lo dice.
 */
function EntityCell({ event }: { event: AuditEventDto }) {
  const code = event.entityCode;
  return (
    <>
      <div className="text-xs text-muted-foreground">{auditEntityTypeLabel(event.entityType)}</div>
      {code !== null && (
        <div className="flex items-center gap-1">
          {event.entityHref ? (
            <Link href={event.entityHref} className={cn('font-medium', LINK_CLASSNAME)}>
              {code}
            </Link>
          ) : (
            <span className={event.entityDeleted ? 'text-muted-foreground' : 'font-medium'}>
              {code}
            </span>
          )}
          {/* El código guardado de una entidad borrada no dice que se borró: la marca sí. */}
          {event.entityDeleted && !code.startsWith('Eliminado') && (
            <Badge variant="outline">Eliminado</Badge>
          )}
          {event.entityId && <CopyIdButton id={event.entityId} />}
        </div>
      )}
    </>
  );
}

/** cc47 (D-615) y cc48 (D-634): los filtros del modal. */
interface AuditFilters {
  entityType: string;
  actorId: string;
  action: string;
  from: string;
  to: string;
}

const NO_AUDIT_FILTERS: AuditFilters = {
  entityType: '',
  actorId: '',
  action: '',
  from: '',
  to: '',
};

const ENTITY_TYPE_OPTIONS = AUDIT_ENTITY_TYPES.map((t) => ({
  value: t,
  label: auditEntityTypeLabel(t),
}));
const ACTION_OPTIONS = auditActionOptions();

/**
 * Visor unificado de auditoría (RF-95, D-218/M3). Une `audit_log` con los changelogs
 * dedicados que ya existían (D-187/D-217/D-211) en una sola línea de tiempo, paginada por
 * cursor — "Cargar más" en vez de páginas numeradas porque la unión no tiene un `total`
 * barato de calcular (D-218: presupuesto de consultas fijo, sin `COUNT` por fuente).
 * Admin-only: `RoleGate` corta la vista, y el API vuelve a exigir el rol del lado del server.
 *
 * cc48 (D-633..D-635): cada fila con el código legible de su entidad; buscar primero (por código
 * o por el texto del detalle) y «Filtros» con periodo, usuario, acción y tipo de entidad, todo en
 * la URL; el Excel en «Más opciones», con lo mismo. El «Historial» de un documento entra con
 * `?entityType=&entityId=`.
 */
export function AuditoriaView() {
  const [url, setUrl] = useUrlState(AUDIT_URL_DEFAULTS);
  const [searchText, setSearchText] = useUrlSearchInput(url.search, (v) => {
    setUrl({ search: v });
  });
  const params = auditParamsOf(url);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDto[]>('/users') });

  const pages = useInfiniteQuery({
    queryKey: ['audit', params.toString()],
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(params);
      if (pageParam) page.set('cursor', pageParam);
      return api<AuditPageDto>(`/audit?${page.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const rows = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const filters: AuditFilters = {
    entityType: url.entityType,
    actorId: url.actorId,
    action: url.action,
    from: url.from,
    to: url.to,
  };
  const period = auditDefaultPeriodLabel(url);
  const searchNotice = auditSearchNotice(url, businessToday());

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Auditoría</h1>
            <p className="text-xs text-muted-foreground">
              Historial de acciones sensibles del sistema. Solo lectura.
            </p>
          </div>
          {/* cc48 (D-634, D-623): el Excel, en «Más opciones», con el buscar y los filtros. */}
          <HeaderActions
            primary={[]}
            actions={[
              {
                key: 'xlsx',
                label: 'Descargar Excel',
                download: listXlsxHref('/audit', params),
              },
            ]}
          />
        </div>

        <TableToolbar
          search={
            <ToolbarSearch
              label="Buscar en la auditoría"
              placeholder="Buscar por código (PED-…, bobina, SKU, cliente) o detalle…"
              value={searchText}
              onChange={setSearchText}
            />
          }
          filters={
            <FiltersDialog<AuditFilters>
              value={filters}
              empty={NO_AUDIT_FILTERS}
              activeCount={auditActiveFilterCount(url)}
              onApply={(next) => {
                // Otro tipo de entidad (o ninguno) suelta el documento del «Historial».
                setUrl({
                  ...next,
                  ...(next.entityType === url.entityType ? {} : { entityId: '' }),
                });
              }}
            >
              {(draft, update) => (
                <>
                  <div className="flex flex-wrap items-end gap-3">
                    <FilterField label="Desde" htmlFor="filtro-desde">
                      <Input
                        id="filtro-desde"
                        type="date"
                        className="w-40"
                        value={draft.from}
                        onChange={(e) => {
                          update({ from: e.target.value });
                        }}
                      />
                    </FilterField>
                    <FilterField label="Hasta" htmlFor="filtro-hasta">
                      <Input
                        id="filtro-hasta"
                        type="date"
                        className="w-40"
                        value={draft.to}
                        onChange={(e) => {
                          update({ to: e.target.value });
                        }}
                      />
                    </FilterField>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sin fechas: últimos 31 días (el historial de un documento, 12 meses). Máximo 12
                    meses de rango.
                  </p>
                  <SelectFilterField
                    id="filtro-usuario"
                    label="Usuario"
                    value={draft.actorId}
                    onChange={(v) => {
                      update({ actorId: v });
                    }}
                    allLabel="Todos los usuarios"
                    options={(users.data ?? []).map((u) => ({ value: u.id, label: u.name }))}
                  />
                  <SelectFilterField
                    id="filtro-accion"
                    label="Acción"
                    value={draft.action}
                    onChange={(v) => {
                      update({ action: v });
                    }}
                    allLabel="Todas las acciones"
                    options={ACTION_OPTIONS}
                  />
                  <SelectFilterField
                    id="filtro-entidad"
                    label="Tipo de entidad"
                    value={draft.entityType}
                    onChange={(v) => {
                      update({ entityType: v });
                    }}
                    allLabel="Todos los tipos"
                    options={ENTITY_TYPE_OPTIONS}
                  />
                </>
              )}
            </FiltersDialog>
          }
          status={
            <>
              {period !== null && <span className="text-sm text-muted-foreground">{period}</span>}
              {searchNotice !== null && (
                <span
                  role="status"
                  className="text-sm text-muted-foreground"
                  data-testid="aviso-buscar"
                >
                  {searchNotice}
                </span>
              )}
              {/* D-635: abierta desde el «Historial» de un documento. */}
              {url.entityType && url.entityId && (
                <span className="flex items-center gap-1 text-sm" data-testid="filtro-documento">
                  <span className="text-muted-foreground">
                    Solo un registro de {auditEntityTypeLabel(url.entityType).toLowerCase()}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setUrl({ entityId: '' });
                    }}
                  >
                    Quitar
                  </Button>
                </span>
              )}
            </>
          }
        />

        <div className="rounded-lg border">
          <Table list>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Fecha y hora</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead>Entidad</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.isPending && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {pages.isError && (
                <TableRow>
                  <TableCell colSpan={5} className="text-destructive">
                    No se pudo cargar la auditoría.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((ev) => (
                <TableRow key={`${ev.source}:${ev.id}`} data-testid="fila-auditoria">
                  <TableCell className="whitespace-nowrap align-top">
                    {formatDateTime(ev.occurredAt)}
                  </TableCell>
                  <TableCell className="align-top">
                    <div>{auditActionLabel(ev.action, ev.source)}</div>
                    <Badge variant="outline" className="mt-1">
                      {AUDIT_SOURCE_LABELS[ev.source]}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top" data-testid="entidad-auditoria">
                    <EntityCell event={ev} />
                  </TableCell>
                  <TableCell className="align-top">
                    {ev.actorKind === 'SYSTEM' ? (
                      <span className="text-muted-foreground">Sistema</span>
                    ) : (
                      (ev.actorName ?? <span className="text-muted-foreground">—</span>)
                    )}
                    {ev.reason && (
                      <div className="text-xs text-muted-foreground" title={ev.reason}>
                        {ev.reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    <EventDiff event={ev} />
                  </TableCell>
                </TableRow>
              ))}
              {pages.isSuccess && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No hay eventos para este filtro.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {pages.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              disabled={pages.isFetchingNextPage}
              onClick={() => {
                void pages.fetchNextPage();
              }}
            >
              {pages.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
            </Button>
          </div>
        )}
      </div>
    </RoleGate>
  );
}
