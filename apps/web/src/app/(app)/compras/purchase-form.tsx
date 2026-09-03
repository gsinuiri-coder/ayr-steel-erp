'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  CURRENCIES,
  CURRENCY_LABELS,
  Decimal,
  PAYMENT_TERMS,
  PAYMENT_TERMS_LABELS,
  PURCHASE_DOC_TYPE_LABELS,
  PURCHASE_DOC_TYPES,
  PURCHASE_TYPE_LABELS,
  PURCHASE_TYPES,
  PurchaseType,
  LANDED_COST_SERVICE_KINDS,
  SERVICE_KIND_LABELS,
  SERVICE_KINDS,
  UNIT_LABELS,
  UNITS,
  type FinishDto,
  type ProductDto,
  type PurchaseDto,
  type PurchaseListItemDto,
  type SupplierDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, isPositiveDecimal, todayIso } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

/** Valor centinela del select: Radix no admite un SelectItem con value vacío. */
const NO_LINK = 'NONE';

const decimalField = (message: string) =>
  z
    .string()
    .trim()
    // D-003: la comparación va por `Decimal`, no por `parseFloat`.
    .refine((v) => isPositiveDecimal(v), message);

const itemSchema = z.object({
  productId: z.string().optional(),
  description: z.string().trim().min(1, 'Obligatorio').max(240),
  qty: decimalField('Cantidad inválida'),
  unit: z.enum(UNITS),
  unitPrice: decimalField('Precio inválido'),
  finishId: z.string().optional(),
  widthMm: z.string().trim().optional(),
  thicknessMm: z.string().trim().optional(),
});

const baseFormSchema = z.object({
  type: z.enum(PURCHASE_TYPES),
  supplierId: z.string().uuid('Elige un proveedor'),
  businessLine: z.enum(BUSINESS_LINES),
  docType: z.enum(PURCHASE_DOC_TYPES),
  series: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, 'Serie inválida (ej: F001)'),
  number: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, 'Solo dígitos'),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida'),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string().trim().optional(),
  igvRate: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Tasa inválida'),
  paymentTerms: z.enum(PAYMENT_TERMS),
  creditDays: z.string().trim().optional(),
  serviceKind: z.enum(SERVICE_KINDS).optional(),
  /** Landed cost (D-043): compra COIL a la que se imputa el servicio. */
  relatedPurchaseId: z.string().optional(),
  notes: z.string().trim().max(500).optional(),
  sourceXmlKey: z.string().optional(),
  items: z
    .array(itemSchema)
    .min(1, 'La compra necesita al menos una línea')
    .max(200, 'Una compra admite hasta 200 líneas'),
});

/**
 * Espeja las reglas del `superRefine` de `createPurchaseSchema` (el API es el que manda,
 * pero validarlas también acá pone el error en el campo exacto en vez de devolver un
 * único mensaje de servidor tras cargar veinte bobinas).
 */
const formSchema = baseFormSchema.superRefine((d, ctx) => {
  if (d.paymentTerms === 'CREDITO') {
    const days = d.creditDays?.trim() ?? '';
    if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['creditDays'],
        message: 'Días de crédito: un entero entre 1 y 365',
      });
    }
  }
  if (d.type === PurchaseType.SERVICE && !d.serviceKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serviceKind'],
      message: 'Indica qué clase de servicio es',
    });
  }
  d.items.forEach((item, index) => {
    if (d.type === PurchaseType.COIL) {
      if (!item.finishId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'finishId'],
          message: 'Elige el acabado',
        });
      }
      if (!isPositiveDecimal(item.widthMm ?? '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'widthMm'],
          message: 'Ancho en mm inválido',
        });
      }
      if (!isPositiveDecimal(item.thicknessMm ?? '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'thicknessMm'],
          message: 'Espesor en mm inválido',
        });
      }
    }
    if (d.type === PurchaseType.FINISHED_GOOD && !item.productId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'productId'],
        message: 'Elige el producto del catálogo',
      });
    }
  });
});
export type PurchaseFormValues = z.infer<typeof baseFormSchema>;

export function emptyItem(type: PurchaseType): PurchaseFormValues['items'][number] {
  return {
    description: '',
    qty: '',
    unit: type === PurchaseType.COIL ? 'KGM' : 'NIU',
    unitPrice: '',
    finishId: '',
    widthMm: '',
    thicknessMm: '',
    productId: '',
  };
}

export function defaultPurchaseValues(type: PurchaseType): PurchaseFormValues {
  return {
    type,
    supplierId: '',
    businessLine: type === PurchaseType.COIL ? 'drywall' : 'trading',
    docType: 'FACTURA',
    series: '',
    number: '',
    issueDate: todayIso(),
    currency: 'PEN',
    exchangeRate: '',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    creditDays: '',
    notes: '',
    items: [emptyItem(type)],
  };
}

interface Props {
  initialValues: PurchaseFormValues;
  /** El tipo viene fijado por la ruta (`?tipo=` o el flujo de XML) y no se cambia acá. */
  lockType?: boolean;
  /** Avisos del parseo del XML (RF-11) a mostrar antes de confirmar. */
  warnings?: string[];
  submitLabel?: string;
}

/**
 * Formulario único de alta de compra (D-030). Cambia de forma según el tipo:
 * COIL pide acabado/ancho/espesor por línea (cada línea es una bobina, RF-10),
 * FINISHED_GOOD pide producto del catálogo, SERVICE pide la clase de servicio y
 * EXPENSE solo descripción y montos (no toca inventario).
 */
export function PurchaseForm({ initialValues, lockType, warnings, submitLabel }: Props) {
  const router = useRouter();
  const form = useForm<PurchaseFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initialValues,
  });
  const items = useFieldArray({ control: form.control, name: 'items' });

  const type = form.watch('type');
  const currency = form.watch('currency');
  const paymentTerms = form.watch('paymentTerms');
  const businessLine = form.watch('businessLine');
  const watchedItems = form.watch('items');

  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<SupplierDto[]>('/suppliers'),
  });
  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: type === PurchaseType.COIL,
  });
  // Landed cost (D-043): solo se puede imputar a una compra de bobinas ya recibida de
  // la misma línea. La lista se pide únicamente cuando el servicio lo admite.
  const serviceKind = form.watch('serviceKind');
  const canLink =
    type === PurchaseType.SERVICE &&
    serviceKind !== undefined &&
    LANDED_COST_SERVICE_KINDS.includes(serviceKind);
  const relatedPurchaseId = form.watch('relatedPurchaseId');
  // El vínculo se limpia cuando deja de tener sentido: si sobrevive a un cambio de
  // servicio o de línea, el campo desaparece de pantalla pero se sigue enviando, y el
  // API responde apuntando a un campo que el usuario ya no ve.
  useEffect(() => {
    if (relatedPurchaseId && !canLink) form.setValue('relatedPurchaseId', '');
  }, [canLink, relatedPurchaseId, form]);
  useEffect(() => {
    if (form.getValues('relatedPurchaseId')) form.setValue('relatedPurchaseId', '');
    // Solo al cambiar de línea: la compra vinculada tiene que ser de la misma (D-043).
  }, [businessLine, form]);
  const coilPurchases = useQuery({
    queryKey: ['purchases', 'coil-received', businessLine],
    queryFn: () =>
      api<PurchaseListItemDto[]>(
        `/purchases?type=COIL&status=RECEIVED&businessLine=${businessLine}`,
      ),
    enabled: canLink,
  });

  const products = useQuery({
    queryKey: ['catalog', businessLine],
    queryFn: () => api<ProductDto[]>(`/catalog?businessLine=${businessLine}`),
    enabled: type === PurchaseType.FINISHED_GOOD,
  });

  const totals = computeTotals(watchedItems, form.watch('igvRate'));

  const save = useMutation({
    mutationFn: (values: PurchaseFormValues) =>
      api<PurchaseDto>('/purchases', { method: 'POST', body: toApiBody(values) }),
    onSuccess: (purchase) => {
      toast.success('Compra registrada');
      router.push(`/compras/${purchase.id}`);
    },
    onError: (err) => {
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'No se pudo registrar la compra',
      });
    },
  });

  const isCoil = type === PurchaseType.COIL;
  const isFinishedGood = type === PurchaseType.FINISHED_GOOD;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => {
          save.mutate(v);
        })}
        className="grid gap-6"
        noValidate
      >
        {warnings && warnings.length > 0 && (
          <Alert>
            <AlertTitle>Revisa antes de confirmar</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {form.formState.errors.root && (
          <p role="alert" className="text-sm text-destructive">
            {form.formState.errors.root.message}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Comprobante</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo de compra</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      items.replace([emptyItem(v as PurchaseType)]);
                    }}
                    disabled={lockType}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PURCHASE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {PURCHASE_TYPE_LABELS[t]}
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
              name="supplierId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Proveedor</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Elige un proveedor" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {suppliers.data
                        ?.filter((s) => s.isActive)
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.code} — {s.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {suppliers.isPending && (
                    <p className="text-xs text-muted-foreground">Cargando proveedores…</p>
                  )}
                  {suppliers.isError && (
                    <p className="text-xs text-destructive">
                      No se pudieron cargar los proveedores.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="businessLine"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Línea de negocio</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      // El catálogo es por línea: un producto de la línea anterior daría 400.
                      if (form.getValues('type') === PurchaseType.FINISHED_GOOD) {
                        items.replace(
                          items.fields.map(() => emptyItem(PurchaseType.FINISHED_GOOD)),
                        );
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {BUSINESS_LINES.map((line) => (
                        <SelectItem key={line} value={line}>
                          {BUSINESS_LINE_LABELS[line]}
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
              name="docType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Comprobante</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PURCHASE_DOC_TYPES.map((d) => (
                        <SelectItem key={d} value={d}>
                          {PURCHASE_DOC_TYPE_LABELS[d]}
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
              name="series"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Serie</FormLabel>
                  <FormControl>
                    <Input placeholder="F001" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="number"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Número</FormLabel>
                  <FormControl>
                    <Input placeholder="1523" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="issueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fecha de emisión</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Moneda</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CURRENCY_LABELS[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {currency !== 'PEN' && (
              <FormField
                control={form.control}
                name="exchangeRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo de cambio</FormLabel>
                    <FormControl>
                      <Input placeholder="Automático (SUNAT del día)" {...field} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      En blanco usa el TC SUNAT de la fecha de emisión (D-029).
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="igvRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>IGV (%)</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentTerms"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Condición de pago</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_TERMS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {PAYMENT_TERMS_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {paymentTerms === 'CREDITO' && (
              <FormField
                control={form.control}
                name="creditDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Días de crédito</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} max={365} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {type === PurchaseType.SERVICE && (
              <FormField
                control={form.control}
                name="serviceKind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Clase de servicio</FormLabel>
                    <Select value={field.value ?? ''} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Elige" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SERVICE_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {SERVICE_KIND_LABELS[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {canLink && (
              <FormField
                control={form.control}
                name="relatedPurchaseId"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Imputar al costo de una compra de bobinas (D-043)</FormLabel>
                    <Select
                      value={field.value ?? NO_LINK}
                      onValueChange={(v) => {
                        field.onChange(v === NO_LINK ? '' : v);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_LINK}>No imputar (queda como gasto)</SelectItem>
                        {coilPurchases.data?.map((purchase) => (
                          <SelectItem key={purchase.id} value={purchase.id}>
                            {purchase.documentLabel} — {purchase.supplierName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Al recibir esta compra, su valor sin IGV se reparte por kilo entre las bobinas
                      de la compra elegida y sube su costo promedio. Solo un administrador puede
                      imputarlo.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="md:col-span-3">
                  <FormLabel>Observaciones</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" placeholder="Opcional" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{isCoil ? 'Bobinas' : 'Detalle'}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {isCoil && (
              <p className="text-sm text-muted-foreground">
                Cada línea es una bobina: al recibir la compra se crea con su código RF-13 y su
                entrada de kardex.
              </p>
            )}
            {items.fields.map((row, index) => (
              <div key={row.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-6">
                {isFinishedGood && (
                  <FormField
                    control={form.control}
                    name={`items.${index}.productId`}
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>Producto</FormLabel>
                        <Select
                          value={field.value ?? ''}
                          onValueChange={(v) => {
                            field.onChange(v);
                            const product = products.data?.find((p) => p.id === v);
                            if (product) {
                              form.setValue(`items.${index}.description`, product.name);
                              form.setValue(`items.${index}.unit`, coerceUnit(product.unit));
                            }
                          }}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Elige" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {products.data
                              ?.filter((p) => p.isActive)
                              .map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.sku} — {p.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {products.isError && (
                          <p className="text-xs text-destructive">
                            No se pudo cargar el catálogo de la línea.
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                {isCoil && (
                  <FormField
                    control={form.control}
                    name={`items.${index}.finishId`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Acabado</FormLabel>
                        <Select value={field.value ?? ''} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Elige" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {finishes.data
                              ?.filter((f) => f.isActive)
                              .map((f) => (
                                <SelectItem key={f.id} value={f.id}>
                                  {f.code} — {f.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {finishes.isError && (
                          <p className="text-xs text-destructive">
                            No se pudieron cargar los acabados.
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <FormField
                  control={form.control}
                  name={`items.${index}.description`}
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Descripción</FormLabel>
                      <FormControl>
                        <Input autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isCoil && (
                  <>
                    <FormField
                      control={form.control}
                      name={`items.${index}.widthMm`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Ancho (mm)</FormLabel>
                          <FormControl>
                            <Input inputMode="decimal" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`items.${index}.thicknessMm`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Espesor (mm)</FormLabel>
                          <FormControl>
                            <Input inputMode="decimal" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
                <FormField
                  control={form.control}
                  name={`items.${index}.qty`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{isCoil ? 'Peso (kg)' : 'Cantidad'}</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {!isCoil && (
                  <FormField
                    control={form.control}
                    name={`items.${index}.unit`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Unidad</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {UNITS.map((u) => (
                              <SelectItem key={u} value={u}>
                                {UNIT_LABELS[u]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <FormField
                  control={form.control}
                  name={`items.${index}.unitPrice`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {isCoil ? 'Precio por kg' : 'Precio unitario'} (sin IGV)
                      </FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={items.fields.length === 1}
                    onClick={() => {
                      items.remove(index);
                    }}
                  >
                    Quitar
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  items.append(emptyItem(type));
                }}
              >
                {isCoil ? 'Agregar bobina' : 'Agregar línea'}
              </Button>
            </div>
            {form.formState.errors.items?.message && (
              <p className="text-sm text-destructive">{form.formState.errors.items.message}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Totales</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Valor de venta (sin IGV)</span>
              <span>{formatMoney(totals.subtotal, currency)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">IGV</span>
              <span>{formatMoney(totals.igv, currency)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span>{formatMoney(totals.total, currency)}</span>
            </div>
            <p className="pt-2 text-xs text-muted-foreground">
              El costo que entra al kardex es el valor sin IGV (D-038); el IGV se guarda aparte.
            </p>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              router.back();
            }}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : (submitLabel ?? 'Registrar compra')}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Totales de vista previa. Decimal, nunca `number` (D-003). */
function computeTotals(
  items: PurchaseFormValues['items'],
  igvRate: string,
): { subtotal: string; igv: string; total: string } {
  const rate = isDecimalString(igvRate) ? new Decimal(igvRate).div(100) : new Decimal(0);
  let subtotal = new Decimal(0);
  let igv = new Decimal(0);
  for (const item of items) {
    if (!isDecimalString(item.qty) || !isDecimalString(item.unitPrice)) continue;
    const lineSubtotal = new Decimal(item.qty).times(item.unitPrice).toDecimalPlaces(4);
    subtotal = subtotal.plus(lineSubtotal);
    igv = igv.plus(lineSubtotal.times(rate).toDecimalPlaces(4));
  }
  return {
    subtotal: subtotal.toFixed(4),
    igv: igv.toFixed(4),
    total: subtotal.plus(igv).toFixed(4),
  };
}

function isDecimalString(value: string | undefined): value is string {
  return !!value && /^\d+(\.\d+)?$/.test(value);
}

function coerceUnit(unit: string): PurchaseFormValues['items'][number]['unit'] {
  const match = UNITS.find((u) => u === unit.toUpperCase());
  return match ?? 'NIU';
}

/** Traduce el formulario (todo string) al cuerpo que espera `POST /purchases`. */
function toApiBody(values: PurchaseFormValues): Record<string, unknown> {
  const isCoil = values.type === PurchaseType.COIL;
  return {
    supplierId: values.supplierId,
    businessLine: values.businessLine,
    type: values.type,
    docType: values.docType,
    series: values.series,
    number: values.number,
    issueDate: values.issueDate,
    currency: values.currency,
    exchangeRate: values.exchangeRate?.trim() ? values.exchangeRate.trim() : undefined,
    igvRate: values.igvRate,
    paymentTerms: values.paymentTerms,
    // El superRefine ya garantizó que sea un entero de 1 a 365 cuando hay crédito.
    creditDays: values.creditDays?.trim() ? Number(values.creditDays) : undefined,
    serviceKind: values.type === PurchaseType.SERVICE ? values.serviceKind : undefined,
    relatedPurchaseId:
      values.type === PurchaseType.SERVICE && values.relatedPurchaseId?.trim()
        ? values.relatedPurchaseId
        : undefined,
    sourceXmlKey: values.sourceXmlKey ?? undefined,
    notes: values.notes?.trim() ? values.notes.trim() : undefined,
    items: values.items.map((item) => ({
      productId: item.productId?.trim() ? item.productId : undefined,
      description: item.description,
      qty: item.qty,
      unit: isCoil ? 'KGM' : item.unit,
      unitPrice: item.unitPrice,
      finishId: item.finishId?.trim() ? item.finishId : undefined,
      widthMm: item.widthMm?.trim() ? item.widthMm : undefined,
      thicknessMm: item.thicknessMm?.trim() ? item.thicknessMm : undefined,
    })),
  };
}
