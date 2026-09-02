'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { createFinishSchema, type FinishDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
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

const FINISHES_QUERY_KEY = ['finishes'] as const;

const formSchema = z.object({
  code: z.string().trim().min(1, 'Obligatorio').max(20),
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(120),
  densityFactor: z.string().trim().min(1, 'Obligatorio'),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  finish?: FinishDto;
  onOpenChange: (open: boolean) => void;
}

export function FinishDialog({ open, finish, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!finish;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: finish?.code ?? '',
      name: finish?.name ?? '',
      densityFactor: finish?.densityFactor ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      if (editing) {
        return api<FinishDto>(`/finishes/${finish.id}`, {
          method: 'PATCH',
          body: { name: values.name, densityFactor: values.densityFactor },
        });
      }
      const parsed = createFinishSchema.parse(values);
      return api<FinishDto>('/finishes', { method: 'POST', body: parsed });
    },
    onSuccess: () => {
      toast.success(editing ? 'Acabado actualizado' : 'Acabado creado');
      void queryClient.invalidateQueries({ queryKey: FINISHES_QUERY_KEY });
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
          <DialogTitle>{editing ? 'Editar acabado' : 'Nuevo acabado'}</DialogTitle>
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
                    <Input disabled={editing} autoComplete="off" {...field} />
                  </FormControl>
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
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="densityFactor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Factor de densidad</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" autoComplete="off" {...field} />
                  </FormControl>
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
                {save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear acabado'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
