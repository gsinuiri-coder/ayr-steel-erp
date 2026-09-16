'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_SOURCE_LABELS,
  BUSINESS_TIME_ZONE,
  Role,
  type AuditEntityType,
  type AuditEventDto,
  type AuditPageDto,
  type UserDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { auditActionLabel, auditEntityTypeLabel } from '@/lib/audit-labels';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
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

/** `"2026-09-16T21:03:11.000Z"` → `"16/09/2026, 16:03"` en hora de Lima. */
function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** `"valuePerMeterPen"` → `"value per meter pen"`. Los campos son identificadores en inglés
 *  (D-idioma); no hay una etiqueta en español por campo sin mantener un mapa por fuente, así
 *  que se separan en palabras en vez de mostrarse pegados. */
function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatFieldValue(value: unknown): string {
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
            <span className="text-muted-foreground">{humanizeFieldKey(k)}: </span>
            {hasBefore && <span>{formatFieldValue(event.before?.[k])}</span>}
            {hasBefore && hasAfter && <span className="text-muted-foreground"> → </span>}
            {hasAfter && <span className="font-medium">{formatFieldValue(event.after?.[k])}</span>}
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

export function AuditoriaView() {
  // M4/D-218 (sacrificable, se llegó a tiempo): un "Historial" en el detalle de un pedido,
  // cotización, bobina o comprobante enlaza acá con `?entityType=&entityId=` — se lee una
  // sola vez al montar, como el `?item=` de /kardex, no como estado controlado por la URL.
  const initialParams = useSearchParams();
  const [entityType, setEntityType] = useState<AuditEntityType | typeof ALL>(() => {
    const raw = initialParams.get('entityType');
    return raw && isAuditEntityType(raw) ? raw : ALL;
  });
  const [entityId, setEntityId] = useState(() => initialParams.get('entityId') ?? '');
  const [actorId, setActorId] = useState<string>(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const debouncedEntityId = useDebouncedValue(entityId);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDto[]>('/users') });

  const filterKey = JSON.stringify({
    entityType,
    entityId: entityType === ALL ? '' : debouncedEntityId.trim(),
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
        if (debouncedEntityId.trim()) params.set('entityId', debouncedEntityId.trim());
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
          <h1 className="text-lg font-semibold">Auditoría</h1>
          <p className="text-xs text-muted-foreground">
            Historial de acciones sensibles del sistema (RF-95). Solo lectura.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Tipo de entidad</span>
            <Select
              value={entityType}
              onValueChange={(v) => {
                setEntityType(v as AuditEntityType | typeof ALL);
                if (v === ALL) setEntityId('');
              }}
            >
              <SelectTrigger className="w-56" aria-label="Tipo de entidad">
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
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">ID de entidad</span>
            <Input
              className="w-48"
              disabled={entityType === ALL}
              placeholder={entityType === ALL ? 'elige un tipo primero' : 'id exacto'}
              value={entityId}
              onChange={(e) => {
                setEntityId(e.target.value);
              }}
            />
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Usuario</span>
            <Select value={actorId} onValueChange={setActorId}>
              <SelectTrigger className="w-52" aria-label="Usuario">
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
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Desde</span>
            <Input
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
              }}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Hasta</span>
            <Input
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
              }}
            />
          </label>
          <p className="pb-1.5 text-xs text-muted-foreground">
            Sin fechas: últimos 31 días. Máximo 12 meses de rango.
          </p>
        </div>

        <div className="rounded-lg border">
          <Table>
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
