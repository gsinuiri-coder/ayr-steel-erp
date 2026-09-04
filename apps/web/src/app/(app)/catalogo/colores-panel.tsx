'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import type { ColorDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
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
import { colorsQueryKey, useColors } from '@/components/colors/color-select';
import { ColorSwatch } from '@/components/colors/color-swatch';

const formSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Obligatorio')
    .max(20)
    .regex(/^[A-Za-z0-9-]+$/, 'Solo letras, números y guiones'),
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  hexColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Usa el formato #rrggbb'),
});
type FormValues = z.infer<typeof formSchema>;

/**
 * RF-54: la paleta (D-085). Vive dentro de `/catalogo` y no como ruta propia porque es un
 * maestro de apoyo del catálogo, como los acabados: se abre cuando hace falta dar de alta un
 * color y no es una pantalla de trabajo diario.
 */
export function ColoresPanel({ isAdmin }: { isAdmin: boolean }) {
  const colors = useColors();
  const [editing, setEditing] = useState<ColorDto | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const toggleActive = useMutation({
    mutationFn: (c: ColorDto) =>
      api<ColorDto>(`/colors/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Color activado' : 'Color desactivado');
      void queryClient.invalidateQueries({ queryKey: colorsQueryKey });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  if (colors.isPending) return <Skeleton className="h-48 w-full" />;
  if (colors.isError) return <p className="text-destructive">No se pudieron cargar los colores.</p>;

  return (
    <div className="grid gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          El color es un dato del maestro, no parte del texto del SKU: el filtro de bobinas de la
          orden de producción compara colores por id (D-085).
        </p>
        {isAdmin && (
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
            }}
          >
            Nuevo color
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Color</TableHead>
              <TableHead>Hex</TableHead>
              <TableHead>Estado</TableHead>
              {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {colors.data.map((c) => (
              <TableRow key={c.id} data-state={c.isActive ? undefined : 'inactive'}>
                <TableCell className="font-medium">{c.code}</TableCell>
                <TableCell>
                  <ColorSwatch color={c} />
                </TableCell>
                <TableCell className="font-mono text-xs">{c.hexColor}</TableCell>
                <TableCell>
                  {c.isActive ? (
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
                      aria-label={`Editar el color ${c.name}`}
                      onClick={() => {
                        setEditing(c);
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${c.isActive ? 'Desactivar' : 'Activar'} el color ${c.name}`}
                      disabled={toggleActive.isPending}
                      onClick={() => {
                        toggleActive.mutate(c);
                      }}
                    >
                      {c.isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {colors.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={isAdmin ? 5 : 4} className="text-center text-muted-foreground">
                  Todavía no hay colores. Cárgalos antes de dar de alta coberturas prepintadas.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin && (creating || editing) && (
        <ColorDialog
          key={editing?.id ?? 'nuevo'}
          color={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ColorDialog({ color, onClose }: { color: ColorDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const editing = color !== null;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: color?.code ?? '',
      name: color?.name ?? '',
      hexColor: color?.hexColor ?? '#c8102e',
    },
  });
  const hex = form.watch('hexColor');

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      editing
        ? api<ColorDto>(`/colors/${color.id}`, {
            method: 'PATCH',
            body: { name: values.name, hexColor: values.hexColor },
          })
        : api<ColorDto>('/colors', { method: 'POST', body: values }),
    onSuccess: () => {
      toast.success(editing ? 'Color actualizado' : 'Color creado');
      void queryClient.invalidateQueries({ queryKey: colorsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onClose();
    },
    onError: (err) => {
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'Error inesperado',
      });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar color' : 'Nuevo color'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              save.mutate(v);
            })}
            className="grid gap-4"
            noValidate
          >
            {form.formState.errors.root && (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.root.message}
              </p>
            )}
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Código</FormLabel>
                  <FormControl>
                    <Input disabled={editing} placeholder="ROJ" autoComplete="off" {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Va en el SKU de la cobertura para leerlo a simple vista; el sistema nunca lo
                    interpreta.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre</FormLabel>
                  <FormControl>
                    <Input placeholder="Rojo colonial" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="hexColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Muestra</FormLabel>
                  <div className="flex items-center gap-3">
                    <FormControl>
                      <Input
                        type="color"
                        aria-label="Selector de color"
                        className="h-10 w-16 p-1"
                        {...field}
                      />
                    </FormControl>
                    <Input
                      aria-label="Código hexadecimal"
                      className="font-mono"
                      value={field.value}
                      onChange={field.onChange}
                    />
                    <span
                      aria-hidden
                      className="size-8 shrink-0 rounded border border-border"
                      style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : undefined }}
                    />
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear color'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
