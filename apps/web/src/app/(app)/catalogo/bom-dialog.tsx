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
  ROOFING_THICKNESS_TOLERANCE_MM,
  theoreticalKgPerPiece,
  toDecimal,
  toFixedString,
  Unit,
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
  FormDescription,
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
 * D-087: la receta tiene dos formas. En drywall el ancho del fleje, el largo de la pieza y
 * el kilo son obligatorios; en coberturas el ancho lo pone la bobina que se monte y el kilo
 * sale de su geometría por el largo reportado, así que acá solo se pide acabado y espesor.
 * El largo sigue siendo opcional en coberturas y es lo que separa los dos productos de
 * D-083: con largo es una plancha de catálogo, sin largo es una cobertura a medida.
 */
const formSchema = z
  .object({
    finishId: z.string().uuid('Elige el acabado del material'),
    inputThicknessMm: decimalField('El espesor'),
    inputWidthMm: z.string(),
    pieceLengthMm: z.string(),
    kgPerPiece: z.string(),
    kind: z.enum([ProductBomKind.DRYWALL, ProductBomKind.ROOFING]),
    /** Una plancha de catálogo (cobertura con largo fijo) sí necesita su largo. */
    requiresPieceLength: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // En drywall los tres son obligatorios. En coberturas, el largo lo es **solo** cuando el
    // formulario lo muestra (plancha de catálogo): el diálogo lo esconde en una cobertura a
    // medida, y ahí no hay nada que exigir.
    const required =
      v.kind === ProductBomKind.DRYWALL
        ? (['inputWidthMm', 'pieceLengthMm', 'kgPerPiece'] as const)
        : v.requiresPieceLength
          ? (['pieceLengthMm'] as const)
          : ([] as const);
    const labels: Record<string, string> = {
      inputWidthMm: 'El ancho',
      pieceLengthMm: 'El largo',
      kgPerPiece: 'El kilo por pieza',
    };
    for (const field of required) {
      if (!isPositiveDecimal(v[field].trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${labels[field] ?? 'El campo'} debe ser un número mayor a cero`,
        });
      }
    }
  });
type FormValues = z.infer<typeof formSchema>;

/**
 * Las medidas viajan al API con escala fija de mm (D-003) y allá se redondean antes de
 * guardarse. Redondear también acá es lo que hace que la sugerencia de la vista sea
 * exactamente el número que el servidor calcula: sin esto, un espesor de `0.455` sugería
 * el kilo de 0.455 y el API guardaba la geometría de 0.46, y al reabrir el diálogo el
 * valor guardado parecía un override manual que nadie hizo.
 */
function normalizedMm(value: string): string | null {
  const trimmed = value.trim();
  if (!isPositiveDecimal(trimmed)) return null;
  const rounded = toFixedString(trimmed, 'MM');
  return toDecimal(rounded).gt(0) ? rounded : null;
}

/**
 * Receta de fabricación de un perfil (D-059): qué fleje consume y cuántos kilos se lleva
 * cada pieza. El kilo por pieza se sugiere desde la geometría y el factor de densidad del
 * acabado (D-047) con la MISMA función que usa el API (`theoreticalKgPerPiece`), para que
 * la previsualización no pueda divergir del número que el servidor guarda — la lección
 * que dejó la previsualización del partido en Fase 2b.
 *
 * El kilo por pieza **sigue a la geometría** salvo que el maestro lo escriba a mano. Si no
 * fuera así, corregir el ancho dejaría el kilo del ancho anterior, y cada reporte de planta
 * sacaría del fleje kilos que la máquina no consumió: el mismo tipo de defecto que el tipo
 * de cambio heredado del diálogo de edición de bobina en Fase 2b.
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
  // D-087/D-083: la clase de receta y el producto que produce salen de la línea y de la
  // unidad del producto, no de un selector: son exactamente las condiciones que valida
  // `BomsService.upsert`, y ofrecer elegirlas dejaría guardar combinaciones que el API
  // rechaza recién al enviar.
  const kind =
    product.businessLineCode === BusinessLine.METALLIC_ROOFING
      ? ProductBomKind.ROOFING
      : ProductBomKind.DRYWALL;
  const isRoofing = kind === ProductBomKind.ROOFING;
  /** Cobertura **a medida**: se mide en metros y el largo lo trae el pedido (D-083). */
  const madeToMeasure = isRoofing && product.unit === Unit.MTR;
  /** El maestro escribió el kilo a mano: deja de seguir a la geometría. */
  const [manualKg, setManualKg] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const loaded = useRef(false);

  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: open,
  });
  const bom = useQuery({
    queryKey: ['production-bom', product.id],
    queryFn: () =>
      api<ProductBomDto | null>(`/production/boms/${product.id}`).catch((err: unknown) => {
        // 404 = el producto todavía no tiene receta; cualquier otro error sí es un error.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    enabled: open,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      finishId: '',
      inputThicknessMm: '',
      inputWidthMm: '',
      pieceLengthMm: '',
      kgPerPiece: '',
      kind,
      requiresPieceLength: isRoofing && !madeToMeasure,
    },
  });

  // La receta llega después de abrir el diálogo: se vuelca al formulario **una sola vez**,
  // para que una respuesta lenta no borre lo que el maestro ya empezó a escribir.
  useEffect(() => {
    if (loaded.current || bom.isPending) return;
    loaded.current = true;
    if (!bom.data) return;
    form.reset({
      finishId: bom.data.finishId,
      inputThicknessMm: bom.data.inputThicknessMm,
      inputWidthMm: bom.data.inputWidthMm ?? '',
      pieceLengthMm: bom.data.pieceLengthMm ?? '',
      kgPerPiece: bom.data.kgPerPiece ?? '',
      kind: bom.data.kind,
      requiresPieceLength: isRoofing && !madeToMeasure,
    });
    setManualKg(
      bom.data.kgPerPiece !== null && bom.data.kgPerPiece !== bom.data.suggestedKgPerPiece,
    );
    setIsActive(bom.data.isActive);
  }, [bom.isPending, bom.data, form]);

  const values = form.watch();
  const finish = (finishes.data ?? []).find((f) => f.id === values.finishId);
  const widthMm = normalizedMm(values.inputWidthMm);
  const thicknessMm = normalizedMm(values.inputThicknessMm);
  const pieceLengthMm = normalizedMm(values.pieceLengthMm);
  const suggested =
    finish && widthMm && thicknessMm && pieceLengthMm
      ? theoreticalKgPerPiece({
          widthMm,
          thicknessMm,
          pieceLengthMm,
          densityFactor: finish.densityFactor,
        }).toFixed(3)
      : null;

  // Mientras el maestro no lo toque, el kilo por pieza sigue a la geometría. En coberturas
  // no hay nada que seguir: el kilo lo pone el rollo que se monte.
  useEffect(() => {
    if (isRoofing || manualKg || suggested === null) return;
    if (form.getValues('kgPerPiece') !== suggested) {
      form.setValue('kgPerPiece', suggested, { shouldValidate: true });
    }
  }, [isRoofing, manualKg, suggested, form]);

  const overridden = suggested !== null && values.kgPerPiece.trim() !== suggested;

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      api<ProductBomDto>(`/production/boms/${product.id}`, {
        method: 'PUT',
        // Solo se manda `kgPerPiece` cuando de verdad es un override: si coincide con la
        // geometría, se deja que el API lo calcule y no queda un número congelado.
        // En coberturas, ancho y kilo **no se mandan**: el API los rechaza a propósito
        // (D-087), porque mandarlos significaría creer que la receta fija el material.
        body: isRoofing
          ? {
              kind,
              finishId: v.finishId,
              inputThicknessMm: v.inputThicknessMm,
              pieceLengthMm: madeToMeasure ? undefined : v.pieceLengthMm,
              isActive,
            }
          : { ...v, kgPerPiece: manualKg ? v.kgPerPiece : undefined, isActive },
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
              ? madeToMeasure
                ? 'Con qué material se rola esta cobertura. El largo lo trae cada pedido y el kilo sale del ancho y el espesor de la bobina que se monte (D-047).'
                : 'Con qué material se rola esta plancha de catálogo y de qué largo sale. El kilo sale del ancho y el espesor de la bobina que se monte (D-047).'
              : 'Qué fleje consume el perfil y cuántos kilos se lleva cada pieza. La orden de producción valida el fleje contra estos datos.'}
          </DialogDescription>
        </DialogHeader>
        {bom.isPending && <Skeleton className="h-40 w-full" />}
        {bom.isError && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo cargar la receta actual: no la guardes hasta poder verla, o pisarías la que
            ya existe.
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
                  <FormLabel>{isRoofing ? 'Acabado del material' : 'Acabado del fleje'}</FormLabel>
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
            <div className={isRoofing ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-3 gap-3'}>
              <FormField
                control={form.control}
                name="inputThicknessMm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Espesor (mm)</FormLabel>
                    <FormControl>
                      <Input inputMode="decimal" autoComplete="off" {...field} />
                    </FormControl>
                    {isRoofing && (
                      <FormDescription>
                        La orden ofrece bobinas de este espesor ±{ROOFING_THICKNESS_TOLERANCE_MM} mm
                        (D-086).
                      </FormDescription>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              {!isRoofing && (
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
              )}
              {!madeToMeasure && (
                <FormField
                  control={form.control}
                  name="pieceLengthMm"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Largo (mm)</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>
            {isRoofing && (
              <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                {madeToMeasure
                  ? 'Esta cobertura se vende por metro lineal: cada pedido trae sus largos y la orden de producción los copia como plan de corte (D-083, D-084).'
                  : 'Esta plancha tiene largo fijo y se cuenta por pieza. La orden de producción rechaza reportar cualquier otro largo.'}
              </p>
            )}
            <FormField
              control={form.control}
              name="kgPerPiece"
              render={({ field }) => (
                <FormItem className={isRoofing ? 'hidden' : undefined}>
                  <FormLabel>Kilos por pieza</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      {...field}
                      onChange={(e) => {
                        setManualKg(true);
                        field.onChange(e);
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    {suggested === null ? (
                      'Completa acabado, espesor, ancho y largo para ver el valor teórico.'
                    ) : overridden ? (
                      <span className="text-destructive">
                        La geometría da {suggested} kg por pieza y esta receta dice{' '}
                        {values.kgPerPiece.trim() || '—'}.{' '}
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          onClick={() => {
                            setManualKg(false);
                            form.setValue('kgPerPiece', suggested, { shouldValidate: true });
                          }}
                        >
                          Usar el teórico
                        </button>
                      </span>
                    ) : (
                      <>Calculado desde la geometría y el acabado: {suggested} kg.</>
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
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
      </DialogContent>
    </Dialog>
  );
}
