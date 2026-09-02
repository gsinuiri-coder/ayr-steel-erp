'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { createUserSchema, passwordSchema, ROLE_LABELS, ROLES, type UserDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const USERS_QUERY_KEY = ['users'] as const;

/** Mismo formulario para crear y editar; en edición la contraseña vacía significa "no cambiar". */
const baseSchema = createUserSchema.extend({ password: z.string() });
type FormValues = z.infer<typeof baseSchema>;
function schemaFor(editing: boolean): z.ZodType<FormValues, z.ZodTypeDef, FormValues> {
  return editing
    ? baseSchema.extend({ password: z.union([z.literal(''), passwordSchema]) })
    : baseSchema.extend({ password: passwordSchema });
}

interface Props {
  open: boolean;
  user?: UserDto;
  onOpenChange: (open: boolean) => void;
}

export function UserDialog({ open, user, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!user;
  const form = useForm<FormValues>({
    resolver: zodResolver(schemaFor(editing)),
    defaultValues: {
      email: user?.email ?? '',
      name: user?.name ?? '',
      role: user?.role ?? 'VENDEDOR',
      password: '',
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      if (editing) {
        const body: Record<string, unknown> = { name: values.name, role: values.role };
        if (values.password) body.password = values.password;
        return api<UserDto>(`/users/${user.id}`, { method: 'PATCH', body });
      }
      return api<UserDto>('/users', { method: 'POST', body: values });
    },
    onSuccess: () => {
      toast.success(editing ? 'Usuario actualizado' : 'Usuario creado');
      void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors) {
        for (const [field, messages] of Object.entries(err.errors)) {
          if (messages?.[0] && field in form.getValues()) {
            form.setError(field as keyof FormValues, { message: messages[0] });
          }
        }
      }
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'Error inesperado',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar usuario' : 'Nuevo usuario'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Cambiar el rol o resetear la contraseña cierra las sesiones abiertas del usuario.'
              : 'El usuario deberá cambiar la contraseña temporal en su primer ingreso.'}
          </DialogDescription>
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
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Correo electrónico</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" disabled={editing} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rol</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Selecciona un rol" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {editing ? 'Nueva contraseña temporal' : 'Contraseña temporal'}
                  </FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  {editing && <FormDescription>Déjala vacía para no cambiarla.</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear usuario'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
