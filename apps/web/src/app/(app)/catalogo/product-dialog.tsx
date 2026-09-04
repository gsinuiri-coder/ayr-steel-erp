'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { PRODUCT_SOURCE_LABELS, PRODUCT_SOURCES, type ProductDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { ColorSelect } from '@/components/colors/color-select';
import { isPositiveDecimal } from '@/lib/format';
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
  /**
   * D-068: vacío significa "sin precio de lista", que el API guarda como `null`.
   * La comparación va con `isPositiveDecimal` (Decimal), no con `parseFloat`: regla dura 1.
   */
  listPricePen: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d+(\.\d+)?$/.test(v), 'Debe ser un número decimal')
    .refine((v) => v === '' || isPositiveDecimal(v), 'Debe ser mayor a cero'),
  /** D-085: vacío = sin color, que el API guarda como `null`. */
  colorId: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  businessLineId: string;
  /** D-085: solo coberturas llevan color; en el resto del catálogo el campo no aparece. */
  usesColor: boolean;
  product?: ProductDto;
  onOpenChange: (open: boolean) => void;
}

export function ProductDialog({ open, businessLineId, usesColor, product, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!product;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sku: product?.sku ?? '',
      name: product?.name ?? '',
      unit: product?.unit ?? '',
      source: product?.source ?? 'MANUFACTURED',
      listPricePen: product?.listPricePen ?? '',
      colorId: product?.colorId ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      if (editing) {
        return api<ProductDto>(`/catalog/${product.id}`, {
          method: 'PATCH',
          body: {
            name: values.name,
            unit: values.unit,
            source: values.source,
            listPricePen: values.listPricePen,
            ...(usesColor ? { colorId: values.colorId } : {}),
          },
        });
      }
      return api<ProductDto>('/catalog', {
        method: 'POST',
        body: { ...values, colorId: usesColor ? values.colorId : '', businessLineId },
      });
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
            {usesColor && (
              <FormField
                control={form.control}
                name="colorId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Color</FormLabel>
                    <ColorSelect value={field.value} onChange={field.onChange} />
                    <p className="text-xs text-muted-foreground">
                      La orden de producción solo ofrece bobinas de este mismo color (D-086). Un
                      producto sin color solo monta bobinas sin color.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="listPricePen"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Precio de lista (S/, sin IGV)</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      placeholder="Opcional"
                      autoComplete="off"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Se sugiere al cotizar (D-068). El vendedor lo puede editar en la línea; queda
                    registrado el precio de lista junto al cotizado.
                  </p>
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
