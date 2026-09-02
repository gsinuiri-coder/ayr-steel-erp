'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { PRODUCT_SOURCE_LABELS, PRODUCT_SOURCES, type ProductDto } from '@ayr/shared';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CATALOG_QUERY_KEY = ['catalog'] as const;

const formSchema = z.object({
  sku: z.string().trim().min(1, 'Obligatorio').max(40),
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(160),
  unit: z.string().trim().min(1, 'Obligatorio').max(20),
  source: z.enum(PRODUCT_SOURCES),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  businessLineId: string;
  product?: ProductDto;
  onOpenChange: (open: boolean) => void;
}

export function ProductDialog({ open, businessLineId, product, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!product;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sku: product?.sku ?? '',
      name: product?.name ?? '',
      unit: product?.unit ?? '',
      source: product?.source ?? 'MANUFACTURED',
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      if (editing) {
        return api<ProductDto>(`/catalog/${product.id}`, {
          method: 'PATCH',
          body: { name: values.name, unit: values.unit, source: values.source },
        });
      }
      return api<ProductDto>('/catalog', { method: 'POST', body: { ...values, businessLineId } });
    },
    onSuccess: () => {
      toast.success(editing ? 'Producto actualizado' : 'Producto creado');
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
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
          <DialogTitle>{editing ? 'Editar producto' : 'Nuevo producto'}</DialogTitle>
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
              name="sku"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SKU</FormLabel>
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
              name="unit"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Unidad</FormLabel>
                  <FormControl>
                    <Input placeholder="kg, unidad, m…" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Origen</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PRODUCT_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {PRODUCT_SOURCE_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                {save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear producto'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
