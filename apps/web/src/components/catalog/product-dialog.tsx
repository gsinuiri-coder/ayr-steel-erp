'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  accessoryEdgeScrap,
  accessoryEffectiveWidthMm,
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
  FINISH_FIELD_LABEL,
  finishLabels,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { AuditHistoryLink } from '@/components/audit-history-link';
import { ColorSwatch } from '@/components/colors/color-swatch';
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
  /**
   * D-242: desarrollo del accesorio en mm — el ancho de fleje que se lleva una pieza
   * desplegada. Vacío fuera de un accesorio, donde el campo ni se muestra y el API lo
   * rechaza si viene.
   */
  developmentMm: z.string().trim(),
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

/**
 * D-085: solo coberturas llevan color; en el resto del catálogo el campo no aparece.
 *
 * Huecos de catálogo de F8-S4 (D-203): esta línea es siempre la misma que
 * {@link usesRoofingFields}, y por eso el color de un producto se **deriva** de su acabado
 * en vez de elegirse aparte — mismo criterio que la bobina (D-203/M2). Antes las dos
 * selecciones eran independientes y nada avisaba si no coincidían, así que ninguna bobina
 * de ese acabado llegaba a montarse jamás en el producto (D-086 compara los dos ids).
 */
function usesColor(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.METALLIC_ROOFING;
}

/** D-118: espesor y ancho del SKU, obligatorios solo en Metallic Roofing. */
function usesRoofingFields(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.METALLIC_ROOFING;
}

/**
 * Color derivado del acabado elegido (F8-S5, mismo criterio que D-203/M2). Un acabado sin
 * tipo (anterior a D-203) no tiene de dónde sacarlo: si es el que el producto ya tenía, se
 * conserva su color hasta que el acabado se complete; si es otro, no hay color que ofrecer.
 */
function deriveColorId(
  finish: FinishDto | null,
  finishId: string,
  product: ProductDto | undefined,
): string {
  if (finish === null) return '';
  if (finish.kind !== null) return finish.colorId ?? '';
  return finishId === product?.finishId ? (product?.colorId ?? '') : '';
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
  // El acabado guardado se ofrece siempre, aunque esté desactivado o de otra línea: si no,
  // el `Select` se vacía y parece que nadie eligió nada, cuando el producto sí tiene uno.
  // Huecos de catálogo de F8-S4 (D-203): un acabado de otra línea nunca podía montar una
  // bobina de esta, así que ofrecerlo era la puerta de entrada del defecto.
  const finishOptions = (finishes.data ?? []).filter(
    (f) => f.id === product?.finishId || (f.isActive && f.businessLine === businessLineCode),
  );
  // F8-S7/M2: el SKU de cobertura se elige por color, que es como lo pide el cliente.
  const finishOptionLabels = finishLabels(finishOptions);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sku: product?.sku ?? initial?.sku ?? '',
      name: product?.name ?? initial?.name ?? '',
      unit: product?.unit ?? '',
      source: product?.source ?? 'MANUFACTURED',
      listPricePen: product?.listPricePen ?? '',
      finishId: product?.finishId ?? '',
      thicknessMm: product?.thicknessMm ?? '',
      widthMm: product?.widthMm ?? '',
      lengthMm: product?.lengthMm ?? '',
      pieceWeightKg: product?.pieceWeightKg ?? '',
      // D-127: una cobertura nueva nace A MEDIDA — es el caso habitual del rubro y el que
      // el sistema hacía mal cuando el subtipo no existía. Una existente muestra el suyo.
      roofingKind: product?.roofingKind ?? (usesRoofingFields(businessLineCode) ? 'A_MEDIDA' : ''),
      developmentMm: product?.developmentMm ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const roofingKind = showRoofingFields ? (values.roofingKind as RoofingProductKind) : null;
      const chosenFinish = finishes.data?.find((f) => f.id === values.finishId) ?? null;
      const colorId = showColor ? deriveColorId(chosenFinish, values.finishId, product) : '';
      const structuredFields = {
        thicknessMm: showRoofingFields ? values.thicknessMm : '',
        widthMm: showRoofingFields || showDrywallFields ? values.widthMm : '',
        // D-127: el largo fijo es de la plancha. Una cobertura a medida no lo lleva —el
        // largo va en los subítems de cada línea de venta— y el API lo rechaza si viene.
        lengthMm:
          showDrywallFields || roofingKind === RoofingProductKind.PLANCHA ? values.lengthMm : '',
        pieceWeightKg: showDrywallFields ? values.pieceWeightKg : '',
        roofingKind,
        // D-242: el desarrollo es exactamente del accesorio. Mandarlo en cualquier otro
        // subtipo lo rechaza el API y el CHECK de la base, y con razón: sería un número que
        // ninguna cuenta lee.
        developmentMm: roofingKind === RoofingProductKind.ACCESORIO ? values.developmentMm : '',
      };
      if (editing) {
        // D-203/M2 aplicado al catálogo (F8-S5): el color sale del acabado, no se elige
        // aparte. Pero acá solo se manda cuando el acabado **cambió** (revisor: mandarlo
        // siempre reabría D-085 en cada edición — un producto legado cuyo color quedó
        // desalineado del suyo disparaba el guardrail de "receta viva" por renombrar o
        // repreciar, con un mensaje que hablaba de color sin que nadie lo hubiera tocado).
        // Un desalineado histórico se corrige a propósito, cambiando el acabado, igual que
        // en «Editar bobina» — no como efecto de lado de guardar cualquier otro campo.
        const finishChanged = values.finishId !== product.finishId;
        return api<ProductDto>(`/catalog/${product.id}`, {
          method: 'PATCH',
          body: {
            name: values.name,
            unit: values.unit,
            source: values.source,
            listPricePen: values.listPricePen,
            ...(showColor && finishChanged ? { colorId } : {}),
            ...(showRoofingFields ? { finishId: values.finishId } : {}),
            ...structuredFields,
          },
        });
      }
      return api<ProductDto>('/catalog', {
        method: 'POST',
        body: {
          ...values,
          colorId,
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-8">
          <DialogTitle>{editing ? 'Editar producto' : 'Nuevo producto'}</DialogTitle>
          {product && <AuditHistoryLink entityType="products" entityId={product.id} />}
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              save.mutate(v);
            })}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
            noValidate
          >
            <div className="grid min-h-0 gap-3 overflow-x-hidden overflow-y-auto overscroll-contain pr-1 md:grid-cols-2">
              {form.formState.errors.root && (
                <p role="alert" className="text-sm text-destructive md:col-span-2">
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
              {showRoofingFields && (
                <FormField
                  control={form.control}
                  name="finishId"
                  render={({ field }) => {
                    const chosenFinish = finishes.data?.find((f) => f.id === field.value) ?? null;
                    const legacyUnmapped =
                      field.value === product?.finishId && chosenFinish?.kind === null;
                    return (
                      <FormItem className="md:col-span-2">
                        <FormLabel>{FINISH_FIELD_LABEL}</FormLabel>
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
                            {/* F8-S7/M2: color comercial; el código solo si dos comparten color. */}
                            {finishOptions.map((f) => (
                              <SelectItem key={f.id} value={f.id}>
                                {finishOptionLabels.get(f.id) ?? f.code}
                                {f.isActive ? '' : ' (desactivado)'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          De su factor de densidad salen los kilos teóricos por metro lineal (RF-25,
                          D-122). El acabado ya no vive en la receta: una cobertura no lleva.
                        </p>
                        {showColor && (
                          <p className="text-sm text-muted-foreground">
                            Color:{' '}
                            {legacyUnmapped ? (
                              <>
                                {product?.colorName && product.colorHex ? (
                                  <ColorSwatch
                                    color={{ name: product.colorName, hexColor: product.colorHex }}
                                  />
                                ) : (
                                  'sin color'
                                )}{' '}
                                (acabado sin tipo)
                              </>
                            ) : chosenFinish?.colorName && chosenFinish.colorHex ? (
                              <ColorSwatch
                                color={{
                                  name: chosenFinish.colorName,
                                  hexColor: chosenFinish.colorHex,
                                }}
                              />
                            ) : chosenFinish ? (
                              'sin color'
                            ) : (
                              '—'
                            )}
                            . El color sale del acabado (D-086): para corregirlo, elige el acabado
                            correcto.
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    );
                  }}
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
                          <SelectTrigger className="w-full">
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
                          Nominal, para cotizar y calcular kg teóricos (D-118). La producción real
                          usa el ancho del rollo que se monte (D-086), no este dato.
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              {showRoofingFields && form.watch('roofingKind') === RoofingProductKind.ACCESORIO && (
                <FormField
                  control={form.control}
                  name="developmentMm"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Desarrollo (mm)</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="300"
                          {...field}
                        />
                      </FormControl>
                      {/* Mismo criterio que el largo de la plancha (D-166): el campo pide
                        milímetros y la pantalla de planta trabaja en metros, así que el
                        número traducido va en vivo. Acá además se muestra lo que de verdad
                        importa —cuántas piezas da una pasada— porque es el dato que decide
                        el rendimiento de la corrida y nadie puede calcularlo de cabeza
                        mientras tipea. */}
                      <AccessoryPassHint
                        widthMm={form.watch('widthMm')}
                        developmentMm={field.value}
                      />
                      <p className="text-xs text-muted-foreground">
                        El ancho de fleje que se lleva una pieza, desplegada. Cada pasada usa el
                        ancho completo de la bobina y da varias piezas del mismo largo; el sobrante
                        lateral es merma de canto.
                      </p>
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
                        <Input
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="3000"
                          {...field}
                        />
                      </FormControl>
                      {/* D-166: el equivalente en metros, en vivo. El campo pide milímetros y
                        todo el resto de la pantalla de coberturas trabaja en metros, así que
                        las tres planchas del catálogo terminaron con "3" y "6" donde iban
                        3 000 y 6 000 — y la cotización salía mil veces más barata sin que
                        nada avisara. Ver el número traducido mientras se tipea lo hace obvio
                        en el momento, que es cuando se puede corregir sin consecuencias. */}
                      <PlateLengthHint lengthMm={field.value} />
                      <p className="text-xs text-muted-foreground">
                        Solo la plancha de catálogo tiene largo fijo. A medida, el largo lo trae
                        cada línea de la cotización.
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
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={save.isPending}
                pending={save.isPending}
                pendingText="Guardando…"
              >
                {editing ? 'Guardar cambios' : 'Crear producto'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * D-242: el rendimiento del desarrollo tipeado, en vivo.
 *
 * Es el número que decide la corrida —cuántas piezas da una pasada y cuánto se va en canto—
 * y nadie lo tiene de cabeza mientras carga el SKU. Mostrarlo acá es lo que hace obvio, en el
 * momento, que un desarrollo de 305 mm rinde 3 piezas en 1 200 mm y 4 en 1 220: el borde que
 * después obliga a avisarle al operario si el rollo montado no coincide con el nominal.
 */
function AccessoryPassHint({ widthMm, developmentMm }: { widthMm: string; developmentMm: string }) {
  const width = widthMm.trim().replace(',', '.');
  const development = developmentMm.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(width) || !/^\d+(\.\d+)?$/.test(development)) return null;
  const scrap = accessoryEdgeScrap(width, development);
  if (scrap === null) {
    return (
      <p className="text-xs text-destructive">
        Un desarrollo de {toDecimal(development).toFixed(2)} mm no entra en un ancho de{' '}
        {toDecimal(width).toFixed(2)} mm: la bobina no da ni una pieza por pasada. El campo va en{' '}
        <strong>milímetros</strong>.
      </p>
    );
  }
  const effective = accessoryEffectiveWidthMm(width, development);
  return (
    <p className="text-xs text-muted-foreground">
      = {toDecimal(development).div(1000).toFixed(3)} m · <strong>{scrap.piecesPerPass}</strong>{' '}
      {scrap.piecesPerPass === 1 ? 'pieza' : 'piezas'} por pasada con el ancho nominal · canto{' '}
      {scrap.edgeMm.toFixed(2)} mm ({scrap.edgeRatio.times(100).toFixed(1)} %) · el metro vendido
      cuenta {effective?.toFixed(2)} mm de ancho
    </p>
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
