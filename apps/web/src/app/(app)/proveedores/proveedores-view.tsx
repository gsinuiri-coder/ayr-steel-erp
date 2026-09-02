'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DOC_TYPE_LABELS, Role, type SupplierDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SupplierDialog } from './supplier-dialog';

const SUPPLIERS_QUERY_KEY = ['suppliers'] as const;

/** RF-81/RF-83: proveedores, incluido si prestan corte tercerizado (D-033/P-10). */
export function ProveedoresView() {
  const { user } = useSession();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [dialog, setDialog] = useState<{ open: boolean; supplier?: SupplierDto; nonce: number }>({
    open: false,
    nonce: 0,
  });
  const openDialog = (supplier?: SupplierDto) => {
    setDialog((d) => ({ open: true, supplier, nonce: d.nonce + 1 }));
  };

  const suppliers = useQuery({
    queryKey: SUPPLIERS_QUERY_KEY,
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Proveedores</h1>
          <p className="text-sm text-muted-foreground">
            Alta, edición y baja de proveedores (RF-81).
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => {
              openDialog();
            }}
          >
            Nuevo proveedor
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Documento</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Corte tercerizado</TableHead>
              <TableHead>Días de crédito</TableHead>
              <TableHead>Estado</TableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {suppliers.isError && (
              <TableRow>
                <TableCell colSpan={6} className="text-destructive">
                  No se pudieron cargar los proveedores.
                </TableCell>
              </TableRow>
            )}
            {suppliers.data?.map((s) => (
              <TableRow key={s.id} data-state={s.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">
                  {DOC_TYPE_LABELS[s.docType]} {s.docNumber}
                </TableCell>
                <TableCell>{s.name}</TableCell>
                <TableCell>
                  {s.providesCuttingService ? (
                    <Badge variant="secondary">Sí</Badge>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </TableCell>
                <TableCell>{s.creditDays}</TableCell>
                <TableCell>
                  {s.isActive ? (
                    <Badge variant="secondary">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openDialog(s);
                      }}
                    >
                      Editar
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {suppliers.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No hay proveedores registrados.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin && (
        <SupplierDialog
          key={`${dialog.supplier?.id ?? 'nuevo'}-${dialog.nonce}`}
          open={dialog.open}
          supplier={dialog.supplier}
          onOpenChange={(open) => {
            setDialog((d) => ({ ...d, open }));
          }}
        />
      )}
    </>
  );
}
