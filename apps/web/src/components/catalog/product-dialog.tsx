'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BusinessLine,
  isPlausiblePieceLength,
  PIECE_LENGTH_RANGE_LABEL,
  PRODUCT_SOURCE_LABELS,
  PRODUCT_SOURCES,
  ROOFING_KIND_UNIT,
  ROOFING_PRODUCT_KIND_HINTS,
  ROOFING_PRODUCT_KIND_LABELS,
  ROOFING_PRODUCT_KINDS,
  RoofingProductKind,
  toDecimal,
  type FinishDto,
  type ProductDto,
} from '@ayr/shared';
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
  /**
   * D-122: acabado del SKU. Obligatorio en Metallic Roofing —de él sale la densidad con la
   * que se convierten metros en kilos (RF-25)—, y el campo ni se muestra en el resto.
   */
  finishId: z.string(),
  /** D-118: vacío = sin dato, que el API guarda como `null`. Obligatorios los valida el API
   * según la línea; acá solo se muestran los que aplican. */
  thicknessMm: z.string().trim(),
  widthMm: z.string().trim(),
  lengthMm: z.string().trim(),
  pieceWeightKg: z.string().trim(),
  /**
   * D-127: subtipo de cobertura. Vacío solo fuera de Metallic Roofing, donde el campo ni
   * se muestra. Es lo que decide qué hace la confirmación de una cotización con esta línea.
   */
  roofingKind: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  businessLineId: string;
  businessLineCode: BusinessLine;
  product?: ProductDto;
  /**
   * D-156: valores con los que abrir un alta **nueva** — el SKU y la descripción que el
   * importador leyó del archivo, para no volver a tipear lo que ya está en pantalla. Se
   * ignora al editar, donde manda el producto cargado.
   */
  initial?: { sku?: string; name?: string };
  /** D-156: el producto recién creado, para que quien abrió el diálogo lo use en el acto. */
  onCreated?: (product: ProductDto) => void;
  onOpenChange: (open: boolean) => void;
}

/** D-085: solo coberturas llevan color; en el resto del catálogo el campo no aparece. */
function usesColor(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.METALLIC_ROOFING;
}

/** D-118: espesor y ancho del SKU, obligatorios solo en Metallic Roofing. */
function usesRoofingFields(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.METALLIC_ROOFING;
}

/** D-118: ancho, largo y peso de la pieza terminada, obligatorios solo en Drywall. */
function usesDrywallFields(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.DRYWALL;
}

export function ProductDialog({
  open,
  businessLineId,
  businessLineCode,
  product,
  initial,
  onCreated,
  onOpenChange,
}: Props) {
  const queryClient = useQueryClient();
  const editing = !!product;
  const showColor = usesColor(businessLineCode);
  const showRoofingFields = usesRoofingFields(businessLineCode);
  const showDrywallFields = usesDrywallFields(businessLineCode);
  // D-122: los acabados solo hacen falta donde el SKU los lleva.
  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: open && showRoofingFields,
  });
  // El acabado guardado se ofrece siempre, aunque esté desactivado: si no, el `Select` se
  // vacía y parece que nadie eligió nada, cuando el producto sí tiene uno.
  const finishOptions = (finishes.data ?? []).filter(
    (f) => f.isActive || f.id === product?.finishId,
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sku: product?.sku ?? initial?.sku ?? '',
      name: product?.name ?? initial?.name ?? '',
      unit: product?.unit ?? '',
      source: product?.source ?? 'MANUFACTURED',
      listPricePen: product?.listPricePen ?? '',
      colorId: product?.colorId ?? '',
      finishId: product?.finishId ?? '',
      thicknessMm: product?.thicknessMm ?? '',
      widthMm: product?.widthMm ?? '',
      lengthMm: product?.lengthMm ?? '',
      pieceWeightKg: product?.pieceWeightKg ?? '',
      // D-127: una cobertura nueva nace A MEDIDA — es el caso habitual del rubro y el que
      // el sistema hacía mal cuando el subtipo no existía. Una existente muestra el suyo.
      roofingKind: product?.roofingKind ?? (usesRoofingFields(businessLineCode) ? 'A_MEDIDA' : ''),
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const roofingKind = showRoofingFields ? (values.roofingKind as RoofingProductKind) : null;
      const structuredFields = {
        thicknessMm: showRoofingFields ? values.thicknessMm : '',
        widthMm: showRoofingFields || showDrywallFields ? values.widthMm : '',
        // D-127: el largo fijo es de la plancha. Una cobertura a medida no lo lleva —el
        // largo va en los subítems de cada línea de venta— y el API lo rechaza si viene.
        lengthMm:
          showDrywallFields || roofingKind === RoofingProductKind.PLANCHA ? values.lengthMm : '',
        pieceWeightKg: showDrywallFields ? values.pieceWeightKg : '',
        roofingKind,
      };
      if (editing) {
        return api<ProductDto>(`/catalog/${product.id}`, {
          method: 'PATCH',
          body: {
            name: values.name,
            unit: values.unit,
            source: values.source,
            listPricePen: values.listPricePen,
            ...(showColor ? { colorId: values.colorId } : {}),
            ...(showRoofingFields ? { finishId: values.finishId } : {}),
            ...structuredFields,
          },
        });
      }
      return api<ProductDto>('/catalog', {
        method: 'POST',
        body: {
          ...values,
          colorId: showColor ? values.colorId : '',
          finishId: showRoofingFields ? values.finishId : '',
          ...structuredFields,
          businessLineId,
        },
      });
    },
    onSuccess: (saved) => {
      toast.success(editing ? 'Producto actualizado' : 'Producto creado');
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
      if (!editing) onCreated?.(saved);
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
            {showColor && (
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
            {showRoofingFields && (
              <FormField
                control={form.control}
                name="finishId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Acabado</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger disabled={finishes.isPending}>
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
                    <p className="text-xs text-muted-foreground">
                      De su factor de densidad salen los kilos teóricos por metro lineal (RF-25,
                      D-122). El acabado ya no vive en la receta: una cobertura no lleva.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {showRoofingFields && (
              <FormField
                control={form.control}
                name="roofingKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subtipo de cobertura</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // Subtipo y unidad son el mismo hecho (el API y un CHECK lo exigen):
                        // elegir el subtipo fija la unidad en vez de dejar que discrepen.
                        form.setValue('unit', ROOFING_KIND_UNIT[value as RoofingProductKind]);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Elige el subtipo" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROOFING_PRODUCT_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {ROOFING_PRODUCT_KIND_LABELS[kind]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {
                        ROOFING_PRODUCT_KIND_HINTS[
                          (field.value || 'A_MEDIDA') as RoofingProductKind
                        ]
                      }
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {showRoofingFields && (
              <FormField
                control={form.control}
                name="thicknessMm"
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
            )}
            {(showRoofingFields || showDrywallFields) && (
              <FormField
                control={form.control}
                name="widthMm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {showDrywallFields ? 'Ancho de la pieza (mm)' : 'Ancho (mm)'}
                    </FormLabel>
                    <FormControl>
                      <Input inputMode="decimal" autoComplete="off" {...field} />
                    </FormControl>
                    {showRoofingFields && (
                      <p className="text-xs text-muted-foreground">
                        Nominal, para cotizar y calcular kg teóricos (D-118). La producción real usa
                        el ancho del rollo que se monte (D-086), no este dato.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {showRoofingFields && form.watch('roofingKind') === RoofingProductKind.PLANCHA && (
              <FormField
                control={form.control}
                name="lengthMm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Largo de la plancha (mm)</FormLabel>
                    <FormControl>
                      <Input inputMode="decimal" autoComplete="off" placeholder="3000" {...field} />
                    </FormControl>
                    {/* D-166: el equivalente en metros, en vivo. El campo pide milímetros y
                        todo el resto de la pantalla de coberturas trabaja en metros, así que
                        las tres planchas del catálogo terminaron con "3" y "6" donde iban
                        3 000 y 6 000 — y la cotización salía mil veces más barata sin que
                        nada avisara. Ver el número traducido mientras se tipea lo hace obvio
                        en el momento, que es cuando se puede corregir sin consecuencias. */}
                    <PlateLengthHint lengthMm={field.value} />
                    <p className="text-xs text-muted-foreground">
                      Solo la plancha de catálogo tiene largo fijo. A medida, el largo lo trae cada
                      línea de la cotización.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {showDrywallFields && (
              <>
                <FormField
                  control={form.control}
                  name="lengthMm"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Largo de la pieza (mm)</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="pieceWeightKg"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Peso de la pieza (kg)</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" autoComplete="off" {...field} />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">
                        Declarado, no calculado: la sección del perfil no es un prisma simple.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
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

/**
 * D-166: el largo tipeado, traducido a metros en vivo, y un aviso cuando cae fuera del rango
 * de una plancha real.
 *
 * Es la mitad barata del arreglo: el API rechaza el largo imposible, pero el rechazo llega
 * al guardar y no dice de dónde salió la confusión. Ver «3.00 mm = 0.003 m» debajo del campo
 * mientras se tipea la desarma en el momento — que es exactamente lo que faltó cuando las
 * tres planchas del catálogo se cargaron en metros.
 */
function PlateLengthHint({ lengthMm }: { lengthMm: string }) {
  const typed = lengthMm.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(typed)) return null;
  const meters = toDecimal(typed).div(1000);
  const plausible = isPlausiblePieceLength(typed);
  return (
    <p className={plausible ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
      = {meters.toFixed(3)} m
      {!plausible && (
        <>
          {' '}
          · fuera de rango: el largo de una plancha va entre {PIECE_LENGTH_RANGE_LABEL}. El campo va
          en <strong>milímetros</strong> — una plancha de 3 metros son 3000.
        </>
      )}
    </p>
  );
}
