'use client';

import { useQuery } from '@tanstack/react-query';
import { BUSINESS_LINE_LABELS, type BusinessLineDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** §2.2: las cinco líneas de negocio son datos fijos, solo lectura. */
export function LineasView() {
  const lines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Líneas de negocio</h1>
        <p className="text-sm text-muted-foreground">
          Las cinco líneas del negocio (§2.2). Determinan si un producto lleva kardex.
        </p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Línea</TableHead>
              <TableHead>Estrategia de inventario</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={2}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {lines.isError && (
              <TableRow>
                <TableCell colSpan={2} className="text-destructive">
                  No se pudieron cargar las líneas de negocio.
                </TableCell>
              </TableRow>
            )}
            {lines.data?.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{BUSINESS_LINE_LABELS[l.code]}</TableCell>
                <TableCell>
                  {l.inventoryStrategy === 'STOCK' ? (
                    <Badge variant="secondary">Con kardex</Badge>
                  ) : (
                    <Badge variant="outline">Sin kardex</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
