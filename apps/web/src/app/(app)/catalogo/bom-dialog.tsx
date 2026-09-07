'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BusinessLine,
  ProductBomKind,
  type FinishDto,
  type ProductBomDto,
  type ProductDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { isPositiveDecimal } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

const decimalField = (label: string) =>
  z.string().trim().refine(isPositiveDecimal, `${label} debe ser un número mayor a cero`);

/**
 * D-122: la receta es **solo** el vínculo fleje → perfil, y solo existe en drywall.
 *
 * Antes tenía dos formas —una de drywall y otra de coberturas— y pedía además el largo de la
 * pieza y sus kilos. Los tres datos se mudaron: el acabado, la geometría y el color de una
 * cobertura viven en su SKU (D-118 los había puesto ahí y D-122 los hizo la única fuente), y
 * el largo y el peso por pieza de un perfil también (D-139). Lo que queda es lo único que la
 * receta siempre describió de verdad: **qué fleje** consume el producto.
 */
const formSchema = z.object({
  finishId: z.string().uuid('Elige el acabado del fleje'),
  inputThicknessMm: decimalField('El espesor'),
  inputWidthMm: decimalField('El ancho'),
});
type FormValues = z.infer<typeof formSchema>;

/**
 * Receta de fabricación de un perfil de drywall (D-059, D-087, D-122).
 *
 * La orden de producción valida el fleje que se monta contra estos tres campos: acabado,
 * espesor y ancho exactos. Cuántos kilos consume cada pieza ya no se declara acá — es el
 * peso por pieza del SKU (D-139), y se edita en el propio producto.
 */
export function BomDialog({
  open,
  product,
  onOpenChange,
}: {
  open: boolean;
  product: ProductDto;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isRoofing = product.businessLineCode === BusinessLine.METALLIC_ROOFING;
  const [isActive, setIsActive] = useState(true);
  const loaded = useRef(false);

  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: open && !isRoofing,
  });
  const bom = useQuery({
    queryKey: ['production-bom', product.id],
    queryFn: () =>
      api<ProductBomDto | null>(`/production/boms/${product.id}`).catch((err: unknown) => {
        // 404 = el producto todavía no tiene receta; cualquier otro error sí es un error.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    enabled: open && !isRoofing,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { finishId: '', inputThicknessMm: '', inputWidthMm: '' },
  });

  useEffect(() => {
    if (bom.isPending || loaded.current) return;
    loaded.current = true;
    if (!bom.data) return;
    form.reset({
      finishId: bom.data.finishId,
      inputThicknessMm: bom.data.inputThicknessMm,
      inputWidthMm: bom.data.inputWidthMm ?? '',
    });
    setIsActive(bom.data.isActive);
  }, [bom.isPending, bom.data, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      api<ProductBomDto>(`/production/boms/${product.id}`, {
        method: 'PUT',
        body: { ...v, kind: ProductBomKind.DRYWALL, isActive },
      }),
    onSuccess: () => {
      toast.success('Receta guardada');
      void queryClient.invalidateQueries({ queryKey: ['production-bom', product.id] });
      void queryClient.invalidateQueries({ queryKey: ['production-boms'] });
      onOpenChange(false);
    },
    onError: (err) => {
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'Error inesperado',
      });
    },
  });

  // El acabado guardado se ofrece siempre, aunque esté desactivado: si no, el `Select` se
  // vacía y parece que nadie eligió nada, cuando la receta sí tiene uno.
  const finishOptions = (finishes.data ?? []).filter(
    (f) => f.isActive || f.id === bom.data?.finishId,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Receta de {product.sku}</DialogTitle>
          <DialogDescription>
            {isRoofing
              ? 'Una cobertura no lleva receta: su acabado, su espesor, su ancho, su largo y su color son del propio producto.'
              : 'Qué fleje consume el perfil: acabado, espesor y ancho exactos. La orden de producción valida contra estos tres datos.'}
          </DialogDescription>
        </DialogHeader>

        {isRoofing ? (
          <>
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Desde D-122 la densidad con la que se convierten metros en kilos sale del acabado del
              SKU, y el filtro de bobina compara contra su espesor. Editalos en el propio producto:
              acá no hay nada que cargar.
            </p>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Entendido
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {bom.isPending && <Skeleton className="h-40 w-full" />}
            {bom.isError && (
              <p role="alert" className="text-sm text-destructive">
                No se pudo cargar la receta actual: no la guardes hasta poder verla, o pisarías la
                que ya existe.
              </p>
            )}
            {finishes.isError && (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar los acabados.
              </p>
            )}
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
                  name="finishId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Acabado del fleje</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full" disabled={finishes.isPending}>
                            <SelectValue
                              placeholder={
                                finishes.isPending ? 'Cargando acabados…' : 'Elige el acabado'
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {finishOptions.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.code} — {f.name}
                              {f.isActive ? '' : ' (desactivado)'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="inputThicknessMm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Espesor (mm)</FormLabel>
                        <FormControl>
                          <Input inputMode="decimal" autoComplete="off" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="inputWidthMm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ancho (mm)</FormLabel>
                        <FormControl>
                          <Input inputMode="decimal" autoComplete="off" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                  Cada pieza consume <strong>{product.pieceWeightKg ?? '—'} kg</strong> y mide{' '}
                  <strong>{product.lengthMm ?? '—'} mm</strong>. Los dos son del SKU (D-139): se
                  editan en el producto, no acá.
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="bom-activa"
                    checked={isActive}
                    onCheckedChange={(v) => {
                      setIsActive(v === true);
                    }}
                  />
                  <Label htmlFor="bom-activa" className="font-normal">
                    Receta activa (una receta desactivada no se puede producir)
                  </Label>
                </div>
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
                  <Button type="submit" disabled={save.isPending || bom.isPending || bom.isError}>
                    {save.isPending ? 'Guardando…' : 'Guardar receta'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
