'use client';

import { useState } from 'react';
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
} from '@ayr/shared';
import { api } from '@/lib/api';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useSession } from '@/lib/session';
import { RoleGate } from '@/components/role-gate';
import { formatMoney, formatQty, isPositiveDecimal } from '@/lib/format';
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

/** Inventario de bobinas por línea (RF-23), con filtros de acabado, espesor y estado. */
export function BobinasView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [businessLine, setBusinessLine] = useState<BusinessLine | typeof ALL>(ALL);
  const [finishId, setFinishId] = useState<string>(ALL);
  const [thicknessMm, setThicknessMm] = useState('');
  const [status, setStatus] = useState<CoilStatus | typeof ALL>(ALL);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const debouncedThickness = useDebouncedValue(thicknessMm);

  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
  });

  const params = new URLSearchParams();
  if (businessLine !== ALL) params.set('businessLine', businessLine);
  if (finishId !== ALL) params.set('finishId', finishId);
  // Se manda solo cuando ya es un decimal válido: a medio escribir el API responde 400.
  if (isPositiveDecimal(debouncedThickness)) params.set('thicknessMm', debouncedThickness.trim());
  if (status !== ALL) params.set('status', status);
  if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
  const queryString = params.toString();

  const coils = useQuery({
    queryKey: ['coils', queryString],
    queryFn: () => api<CoilDto[]>(`/coils${queryString ? `?${queryString}` : ''}`),
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Bobinas</h1>
          <p className="text-sm text-muted-foreground">
            Materia prima por línea de negocio (RF-23). El alta entra por compra, XML o planilla.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="outline" asChild>
              <Link href="/bobinas/importar">Importar planilla</Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href="/bobinas/nueva-xml">Desde XML</Link>
          </Button>
          <Button asChild>
            <Link href="/compras/nueva?tipo=COIL">Nueva compra de bobinas</Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Línea</TableHead>
              <TableHead>Proveedor</TableHead>
              <TableHead>Color</TableHead>
              <TableHead className="text-right">Ancho</TableHead>
              <TableHead className="text-right">Peso</TableHead>
              <TableHead className="text-right">Disponible</TableHead>
              <TableHead className="text-right">Costo/kg</TableHead>
              <TableHead>Estado</TableHead>
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
            {coils.data?.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono font-medium">
                  <Link className="underline underline-offset-4" href={`/bobinas/${c.id}`}>
                    {c.code}
                  </Link>
                </TableCell>
                <TableCell>{c.typeKey}</TableCell>
                <TableCell>{BUSINESS_LINE_LABELS[c.businessLine]}</TableCell>
                <TableCell>{c.supplierName}</TableCell>
                <TableCell>
                  <ColorSwatch
                    color={
                      c.colorName && c.colorHex ? { name: c.colorName, hexColor: c.colorHex } : null
                    }
                  />
                </TableCell>
                <TableCell className="text-right">{c.widthMm} mm</TableCell>
                <TableCell className="text-right">{formatQty(c.weightKg, 'kg')}</TableCell>
                <TableCell className="text-right font-medium">
                  {formatQty(c.availableKg, 'kg')}
                </TableCell>
                <TableCell className="text-right">
                  {formatMoney(c.unitCostPerKg, c.currency, 4)}
                </TableCell>
                <TableCell>
                  <Badge variant={c.status === 'OPEN' ? 'secondary' : 'outline'}>
                    {COIL_STATUS_LABELS[c.status]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {coils.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground">
                  No hay bobinas que coincidan con los filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </RoleGate>
  );
}
