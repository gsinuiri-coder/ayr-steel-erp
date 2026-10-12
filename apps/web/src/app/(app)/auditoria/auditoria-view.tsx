'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_SOURCE_LABELS,
  money,
  Role,
  salePriceFromValue,
  toFixedString,
  type AuditEntityType,
  type AuditEventDto,
  type AuditPageDto,
  type UserDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import {
  auditActionLabel,
  auditEntityTypeLabel,
  auditFieldLabel,
  auditFieldValueLabel,
  isPriceListValueField,
} from '@/lib/audit-labels';
import { formatMoney, formatDateTime } from '@/lib/format';
import { FilterField, FiltersDialog, TableToolbar } from '@/components/table-toolbar';
import { RoleGate } from '@/components/role-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL = 'ALL';

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
  const keys = [
    ...new Set([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})]),
  ];
  const changed = keys.filter((k) => {
    const bv = event.before?.[k];
    const av = event.after?.[k];
    return JSON.stringify(bv) !== JSON.stringify(av);
  });

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

/**
 * Visor unificado de auditoría (RF-95, D-218/M3). Une `audit_log` con los changelogs
 * dedicados que ya existían (D-187/D-217/D-211) en una sola línea de tiempo, paginada por
 * cursor — "Cargar más" en vez de páginas numeradas porque la unión no tiene un `total`
 * barato de calcular (D-218: presupuesto de consultas fijo, sin `COUNT` por fuente).
 * Admin-only: `RoleGate` corta la vista, y el API vuelve a exigir el rol del lado del server.
 */
/** `AUDIT_ENTITY_TYPES` no exporta el tipo como un `Set`, y `includes` de un array `readonly
 *  string[]` no acepta un `string` suelto sin este cast — el valor ya se valida acá. */
function isAuditEntityType(value: string): value is AuditEntityType {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** cc47 (D-615): los filtros del modal. */
interface AuditFilters {
  entityType: AuditEntityType | typeof ALL;
  entityId: string;
  actorId: string;
  from: string;
  to: string;
}

const NO_AUDIT_FILTERS: AuditFilters = {
  entityType: ALL,
  entityId: '',
  actorId: ALL,
  from: '',
  to: '',
};

export function AuditoriaView() {
  // M4/D-218 (sacrificable, se llegó a tiempo): un "Historial" en el detalle de un pedido,
  // cotización, bobina o comprobante enlaza acá con `?entityType=&entityId=` — se lee una
  // sola vez al montar, como el `?item=` de /kardex, no como estado controlado por la URL.
  const initialParams = useSearchParams();
  // cc47 (D-615): los filtros se eligen en el modal «Filtros» y se aplican juntos. Siguen en
  // estado de la pantalla, como antes (no en la URL).
  const [filters, setFilters] = useState<AuditFilters>(() => {
    const raw = initialParams.get('entityType');
    return {
      ...NO_AUDIT_FILTERS,
      entityType: raw && isAuditEntityType(raw) ? raw : ALL,
      entityId: initialParams.get('entityId') ?? '',
    };
  });
  const { entityType, actorId, from, to } = filters;
  const entityId = filters.entityId.trim();

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDto[]>('/users') });

  const filterKey = JSON.stringify({
    entityType,
    entityId: entityType === ALL ? '' : entityId,
    actorId,
    from,
    to,
  });

  const pages = useInfiniteQuery({
    queryKey: ['audit', filterKey],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (entityType !== ALL) {
        params.set('entityType', entityType);
        if (entityId) params.set('entityId', entityId);
      }
      if (actorId !== ALL) params.set('actorId', actorId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (pageParam) params.set('cursor', pageParam);
      return api<AuditPageDto>(`/audit?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const rows = pages.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Auditoría</h1>
          <p className="text-xs text-muted-foreground">
            Historial de acciones sensibles del sistema. Solo lectura.
          </p>
        </div>

        {/* cc47 (D-615): «Filtros» con todos los filtros. Sin buscar ni Excel. */}
        <TableToolbar
          filters={
            <FiltersDialog<AuditFilters>
              value={filters}
              empty={NO_AUDIT_FILTERS}
              activeCount={
                [entityType !== ALL, actorId !== ALL, from !== '', to !== ''].filter(Boolean).length
              }
              onApply={(next) => {
                setFilters(next.entityType === ALL ? { ...next, entityId: '' } : next);
              }}
            >
              {(draft, update) => (
                <>
                  <FilterField label="Tipo de entidad" htmlFor="filtro-entidad">
                    <Select
                      value={draft.entityType}
                      onValueChange={(v) => {
                        update(
                          v === ALL
                            ? { entityType: ALL, entityId: '' }
                            : { entityType: v as AuditEntityType },
                        );
                      }}
                    >
                      <SelectTrigger id="filtro-entidad" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>Todos los tipos</SelectItem>
                        {AUDIT_ENTITY_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {auditEntityTypeLabel(t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FilterField>
                  <FilterField label="ID de entidad" htmlFor="filtro-id">
                    <Input
                      id="filtro-id"
                      disabled={draft.entityType === ALL}
                      placeholder={draft.entityType === ALL ? 'elige un tipo primero' : 'id exacto'}
                      value={draft.entityId}
                      onChange={(e) => {
                        update({ entityId: e.target.value });
                      }}
                    />
                  </FilterField>
                  <FilterField label="Usuario" htmlFor="filtro-usuario">
                    <Select
                      value={draft.actorId}
                      onValueChange={(v) => {
                        update({ actorId: v });
                      }}
                    >
                      <SelectTrigger id="filtro-usuario" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>Todos los usuarios</SelectItem>
                        {(users.data ?? []).map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FilterField>
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
                    Sin fechas: últimos 31 días. Máximo 12 meses de rango.
                  </p>
                </>
              )}
            </FiltersDialog>
          }
          status={
            from === '' && to === '' ? (
              <span className="text-sm text-muted-foreground">Últimos 31 días</span>
            ) : undefined
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
                <TableRow key={`${ev.source}:${ev.id}`}>
                  <TableCell className="whitespace-nowrap align-top">
                    {formatDateTime(ev.occurredAt)}
                  </TableCell>
                  <TableCell className="align-top">
                    <div>{auditActionLabel(ev.action, ev.source)}</div>
                    <Badge variant="outline" className="mt-1">
                      {AUDIT_SOURCE_LABELS[ev.source]}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <div>{auditEntityTypeLabel(ev.entityType)}</div>
                    {ev.entityId && (
                      <div className="font-mono text-xs text-muted-foreground">{ev.entityId}</div>
                    )}
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
