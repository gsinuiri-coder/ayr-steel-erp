'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Role, ROLE_LABELS, type UserDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
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
import { UserDialog } from './user-dialog';
import { SortHead } from '@/components/sortable-table-head';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';
import { RowActions } from '@/components/row-actions';

export const USERS_QUERY_KEY = ['users'] as const;

export function UsersView() {
  // D-323: la tabla muestra su lista entera; el orden por columna es sobre todas las filas.
  const [sort, toggleSort] = useSort<'name' | 'email' | 'role' | 'status'>();
  const { user: me } = useSession();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ open: boolean; user?: UserDto; nonce: number }>({
    open: false,
    nonce: 0,
  });
  const openDialog = (user?: UserDto) => {
    setDialog((d) => ({ open: true, user, nonce: d.nonce + 1 }));
  };

  const users = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: () => api<UserDto[]>('/users') });

  const toggleActive = useMutation({
    mutationFn: (u: UserDto) =>
      api<UserDto>(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }),
    onSuccess: (updated) => {
      toast.success(updated.active ? 'Usuario activado' : 'Usuario desactivado');
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  if (me.role !== Role.ADMINISTRADOR) {
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        No tienes permiso para ver esta sección.
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Usuarios</h1>
          <p className="text-xs text-muted-foreground">Alta, edición y baja de usuarios (RF-04).</p>
        </div>
        <Button
          onClick={() => {
            openDialog();
          }}
        >
          Nuevo usuario
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <SortHead sort={sort} onSort={toggleSort} k="name">
                Nombre
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="email">
                Correo
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="role">
                Rol
              </SortHead>
              <SortHead sort={sort} onSort={toggleSort} k="status">
                Estado
              </SortHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {users.isError && (
              <TableRow>
                <TableCell colSpan={5} className="text-destructive">
                  No se pudo cargar la lista de usuarios.
                </TableCell>
              </TableRow>
            )}
            {sortRows(users.data ?? [], sort, {
              name: { text: (u) => u.name },
              email: { text: (u) => u.email },
              role: { text: (u) => u.role },
              status: { text: (u) => (u.active ? 'Activo' : 'Inactivo') },
            }).map((u) => (
              <TableRow key={u.id} data-state={u.active ? undefined : 'inactive'}>
                <TableCell className="font-medium">
                  {u.name}
                  {u.id === me.id && (
                    <span className="ml-2 text-xs text-muted-foreground">(tú)</span>
                  )}
                </TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{ROLE_LABELS[u.role]}</TableCell>
                <TableCell>
                  {u.active ? (
                    <Badge variant="secondary">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Inactivo</Badge>
                  )}
                  {u.mustChangePassword && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      Debe cambiar contraseña
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions
                    label={u.name}
                    primary="edit"
                    actions={[
                      {
                        key: 'edit',
                        label: 'Editar',
                        onSelect: () => {
                          openDialog(u);
                        },
                      },
                      {
                        key: 'toggle',
                        label: u.active ? 'Desactivar' : 'Activar',
                        disabled: u.id === me.id || toggleActive.isPending,
                        pending: toggleActive.isPending && toggleActive.variables?.id === u.id,
                        onSelect: () => {
                          if (toggleActive.isPending) return;
                          toggleActive.mutate(u);
                        },
                      },
                    ]}
                  />
                </TableCell>
              </TableRow>
            ))}
            {users.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No hay usuarios.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <UserDialog
        key={`${dialog.user?.id ?? 'nuevo'}-${dialog.nonce}`}
        open={dialog.open}
        user={dialog.user}
        onOpenChange={(open) => {
          setDialog((d) => ({ ...d, open }));
        }}
      />
    </>
  );
}
