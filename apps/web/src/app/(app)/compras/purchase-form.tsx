'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { errorMessage, toast } from '@/lib/notify';
import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  BUSINESS_LINES,
  COIL_BUSINESS_LINES,
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
  type CuttingOrderListItemDto,
  type FinishDto,
  type ProductDto,
  type PurchaseDto,
  type PurchaseListItemDto,
  type SupplierDto,
  FINISH_FIELD_LABEL,
  finishLabels,
  PURCHASE_NUMBER_MESSAGE,
  PURCHASE_NUMBER_PATTERN,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { formatKg, formatMoney, isPositiveDecimal, todayIso } from '@/lib/format';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField } from '@/components/ui/form';
import { FormFieldCell, focusField, StickyActionBar, type MissingField } from '@/components/form';
import { Input, InputWithUnit } from '@/components/ui/input';
import { Section } from '@/components/section';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
  description: z.string().trim().min(1, 'Escribe la descripción de la línea').max(240),
  qty: decimalField('Escribe una cantidad mayor que cero'),
  unit: z.enum(UNITS),
  unitPrice: decimalField('Escribe el precio sin IGV, mayor que cero'),
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
    .regex(/^[A-Z0-9]{1,10}$/, 'Escribe la serie: hasta 10 letras o números, como F001'),
  // B8 (cc33): letras, dígitos, guion y barra, hasta 20; el API lo guarda sin ceros a la izquierda.
  number: z.string().trim().toUpperCase().regex(PURCHASE_NUMBER_PATTERN, PURCHASE_NUMBER_MESSAGE),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Elige la fecha de emisión'),
  currency: z.enum(CURRENCIES),
  exchangeRate: z.string().trim().optional(),
  igvRate: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Escribe la tasa de IGV, como 18'),
  paymentTerms: z.enum(PAYMENT_TERMS),
  creditDays: z.string().trim().optional(),
  serviceKind: z.enum(SERVICE_KINDS).optional(),
  /** Landed cost (D-043): compra COIL a la que se imputa el servicio. */
  relatedPurchaseId: z.string().optional(),
  /** Costo de corte tercerizado (RF-41): orden de corte a la que se imputa el servicio. */
  relatedCuttingOrderId: z.string().optional(),
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
        message: 'Escribe los días de crédito: un entero entre 1 y 365',
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
          message: 'Escribe el ancho en mm, mayor que cero',
        });
      }
      if (!isPositiveDecimal(item.thicknessMm ?? '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'thicknessMm'],
          message: 'Escribe el espesor en mm, mayor que cero',
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

export function defaultPurchaseValues(
  type: PurchaseType,
  overrides?: { businessLine?: string; serviceKind?: string; relatedCuttingOrderId?: string },
): PurchaseFormValues {
  return {
    type,
    supplierId: '',
    businessLine:
      (overrides?.businessLine as PurchaseFormValues['businessLine']) ??
      (type === PurchaseType.COIL ? 'drywall' : 'trading'),
    docType: 'FACTURA',
    series: '',
    number: '',
    issueDate: todayIso(),
    currency: 'PEN',
    exchangeRate: '',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    creditDays: '',
    serviceKind: overrides?.serviceKind as PurchaseFormValues['serviceKind'],
    relatedPurchaseId: '',
    relatedCuttingOrderId: overrides?.relatedCuttingOrderId ?? '',
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
  /**
   * cc31: el formulario nace con datos que se perderían al salir (los leídos de un XML), así que
   * avisa aunque todavía no se haya tocado nada.
   */
  startsDirty?: boolean;
}

/**
 * Formulario único de alta de compra (D-030). Cambia de forma según el tipo:
 * COIL pide acabado/ancho/espesor por línea (cada línea es una bobina, RF-10),
 * FINISHED_GOOD pide producto del catálogo, SERVICE pide la clase de servicio y
 * EXPENSE solo descripción y montos (no toca inventario).
 */
export function PurchaseForm({
  initialValues,
  lockType,
  warnings,
  submitLabel,
  startsDirty = false,
}: Props) {
  const router = useRouter();
  const form = useForm<PurchaseFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initialValues,
    // cc31: el foco lo lleva la barra al primer faltante, en el orden de la pantalla (los
    // selectores no registran `ref` y RHF los saltaba).
    shouldFocusError: false,
  });
  const items = useFieldArray({ control: form.control, name: 'items' });
  const formRef = useRef<HTMLFormElement>(null);

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
    // D-203: el acabado que falta se crea en otra pestaña; al volver, tiene que aparecer.
    refetchOnWindowFocus: true,
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
    if (form.getValues('relatedCuttingOrderId')) form.setValue('relatedCuttingOrderId', '');
    // Solo al cambiar de línea: la compra/orden vinculada tiene que ser de la misma línea.
  }, [businessLine, form]);
  const coilPurchases = useQuery({
    queryKey: ['purchases', 'coil-received', businessLine],
    queryFn: () =>
      fetchAllForPicker<PurchaseListItemDto>('/purchases', {
        type: 'COIL',
        status: 'RECEIVED',
        businessLine,
      }),
    enabled: canLink,
  });

  // Costo de corte tercerizado (RF-41): solo se imputa a una orden de corte de la misma
  // línea, no anulada del todo (D-033: el costo se ingresa al recibir, aunque la orden
  // todavía tenga bobinas pendientes de volver).
  const canLinkCutting = type === PurchaseType.SERVICE && serviceKind === 'CUTTING';
  const relatedCuttingOrderId = form.watch('relatedCuttingOrderId');
  useEffect(() => {
    if (relatedCuttingOrderId && !canLinkCutting) form.setValue('relatedCuttingOrderId', '');
  }, [canLinkCutting, relatedCuttingOrderId, form]);
  const cuttingOrders = useQuery({
    queryKey: ['cutting-orders', businessLine],
    queryFn: () => api<CuttingOrderListItemDto[]>(`/cutting?businessLine=${businessLine}`),
    enabled: canLinkCutting,
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
        message: errorMessage(err, 'No se pudo registrar la compra'),
      });
    },
  });
  // cc27 (UX26-13, D-455): salir con la compra a medio cargar avisa; guardada, ya no.
  useUnsavedChanges((startsDirty || form.formState.isDirty) && !save.isSuccess);

  const isCoil = type === PurchaseType.COIL;
  const isFinishedGood = type === PurchaseType.FINISHED_GOOD;

  // cc31 (ESPEC §6): el botón principal no se apaga por un dato faltante. Al pulsarlo con
  // faltantes no se envía: RHF marca los campos y la barra los lista, con enlaces, en el orden
  // de la pantalla; el foco va al primero.
  const [attempted, setAttempted] = useState(false);
  const [missing, setMissing] = useState<MissingField[]>([]);
  const focusFirst = useRef(false);
  const errorPaths: string[] = [];
  collectErrorPaths(form.formState.errors, '', errorPaths);
  const errorKey = attempted ? errorPaths.join('|') : '';
  // Cada intento cuenta: pulsar dos veces con lo mismo pendiente vuelve a llevar el foco.
  const submitCount = form.formState.submitCount;
  useEffect(() => {
    if (!attempted) return;
    const next = readInvalidFields(formRef.current, isCoil ? 'Bobina' : 'Línea');
    setMissing(next);
    if (focusFirst.current && next[0]) {
      focusFirst.current = false;
      focusField(next[0].target);
    }
  }, [attempted, errorKey, isCoil, submitCount]);

  // cc31 (ESPEC §6, defecto): cambiar el tipo de compra rehace las líneas. Con líneas cargadas
  // se pregunta antes; sin nada escrito, cambia directo.
  const [pendingType, setPendingType] = useState<PurchaseType | null>(null);
  const filledLines = watchedItems.filter(lineHasData).length;
  const applyType = (next: PurchaseType) => {
    form.setValue('type', next, { shouldDirty: true });
    items.replace([emptyItem(next)]);
    // D-116: solo Drywall y Metallic Roofing compran bobinas; si la línea elegida no aplica,
    // cae a Drywall en vez de dejar un 400 silencioso.
    if (
      next === PurchaseType.COIL &&
      !COIL_BUSINESS_LINES.includes(form.getValues('businessLine'))
    ) {
      form.setValue('businessLine', 'drywall');
    }
  };

  const outcome = summarizeOutcome(watchedItems);

  return (
    <Form {...form}>
      <form
        ref={formRef}
        onSubmit={form.handleSubmit(
          (v) => {
            if (save.isPending) return;
            save.mutate(v);
          },
          () => {
            setAttempted(true);
            focusFirst.current = true;
          },
        )}
        className="grid gap-4"
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

        {/* cc31 (ESPEC §6): secciones con banda gris; lo que decide la compra va primero. */}
        <Section title="Compra" separated={false}>
          <div className="grid grid-cols-12 items-start gap-x-3 gap-y-1 pt-2">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormFieldCell span={4} label="Tipo de compra">
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      const next = v as PurchaseType;
                      if (next === field.value) return;
                      if (filledLines > 0) {
                        setPendingType(next);
                        return;
                      }
                      applyType(next);
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
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="supplierId"
              render={({ field }) => (
                <FormFieldCell span={4} label="Proveedor">
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
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="businessLine"
              render={({ field }) => (
                <FormFieldCell span={4} label="Línea de negocio">
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
                      // D-203: un acabado pertenece a una línea. El de la línea anterior quedaba
                      // elegido sin verse y el API lo rechazaba al guardar.
                      if (form.getValues('type') === PurchaseType.COIL) {
                        form.getValues('items').forEach((item, i) => {
                          const finish = finishes.data?.find((x) => x.id === item.finishId);
                          if (finish && finish.businessLine !== v) {
                            form.setValue(`items.${i}.finishId`, '');
                          }
                        });
                      }
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {/* D-116: solo Drywall y Metallic Roofing manejan bobinas. */}
                      {(type === PurchaseType.COIL ? COIL_BUSINESS_LINES : BUSINESS_LINES).map(
                        (line) => (
                          <SelectItem key={line} value={line}>
                            {BUSINESS_LINE_LABELS[line]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </FormFieldCell>
              )}
            />
            {type === PurchaseType.SERVICE && (
              <FormField
                control={form.control}
                name="serviceKind"
                render={({ field }) => (
                  <FormFieldCell span={4} label="Clase de servicio">
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
                  </FormFieldCell>
                )}
              />
            )}
            {canLink && (
              <FormField
                control={form.control}
                name="relatedPurchaseId"
                render={({ field }) => (
                  <FormFieldCell span={8} label="Imputar al costo de una compra de bobinas">
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
                  </FormFieldCell>
                )}
              />
            )}
            {canLinkCutting && (
              <FormField
                control={form.control}
                name="relatedCuttingOrderId"
                render={({ field }) => (
                  <FormFieldCell span={8} label="Imputar al costo de una orden de corte">
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
                        {cuttingOrders.data
                          ?.filter((o) => o.status !== 'CANCELLED')
                          .map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {o.supplierName} — {o.coilCount} bobina(s)
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      Al recibir esta compra, su valor sin IGV se reparte por kilo entre los flejes
                      ya recibidos de esa orden, sin importar si llega antes o después de la
                      recepción física. Solo un administrador puede imputarlo.
                    </p>
                  </FormFieldCell>
                )}
              />
            )}
          </div>
        </Section>

        <Section title="Comprobante del proveedor">
          <div className="grid grid-cols-12 items-start gap-x-3 gap-y-1 pt-2">
            <FormField
              control={form.control}
              name="docType"
              render={({ field }) => (
                <FormFieldCell span={4} label="Comprobante">
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
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="series"
              render={({ field }) => (
                <FormFieldCell span={4} label="Serie" help="Por ejemplo: F001">
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="number"
              render={({ field }) => (
                <FormFieldCell span={4} label="Número" help="Por ejemplo: 1523">
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="issueDate"
              render={({ field }) => (
                <FormFieldCell span={4} label="Fecha de emisión">
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormFieldCell span={4} label="Moneda">
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value);
                      if (value === 'PEN') form.setValue('exchangeRate', '');
                    }}
                  >
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
                </FormFieldCell>
              )}
            />
            {currency !== 'PEN' && (
              <FormField
                control={form.control}
                name="exchangeRate"
                render={({ field }) => (
                  <FormFieldCell
                    span={4}
                    label="Tipo de cambio"
                    numeric
                    optional
                    help="En blanco se usa el de SUNAT de la fecha de emisión."
                  >
                    <FormControl>
                      <Input inputMode="decimal" {...field} />
                    </FormControl>
                  </FormFieldCell>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="igvRate"
              render={({ field }) => (
                <FormFieldCell span={4} label="IGV" numeric size="md">
                  <FormControl>
                    <InputWithUnit unit="%" inputMode="decimal" {...field} />
                  </FormControl>
                </FormFieldCell>
              )}
            />
            <FormField
              control={form.control}
              name="paymentTerms"
              render={({ field }) => (
                <FormFieldCell span={4} label="Condición de pago">
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
                </FormFieldCell>
              )}
            />
            {paymentTerms === 'CREDITO' && (
              <FormField
                control={form.control}
                name="creditDays"
                render={({ field }) => (
                  <FormFieldCell span={4} label="Días de crédito" numeric size="md">
                    <FormControl>
                      <InputWithUnit unit="días" type="number" min={1} max={365} {...field} />
                    </FormControl>
                  </FormFieldCell>
                )}
              />
            )}
          </div>
        </Section>

        <Section title={isCoil ? 'Bobinas' : 'Detalle'} bodyClassName="grid gap-3 pt-2">
          {isCoil && (
            <p className="text-sm text-muted-foreground">
              Cada línea es una bobina: al recibir la compra se crea con su código y su entrada de
              kardex.
            </p>
          )}
          {items.fields.map((row, index) => (
            <div
              key={row.id}
              // cc31: la barra de faltantes nombra el campo por su línea («Bobina 2 · Peso»).
              data-line={index + 1}
              className="grid grid-cols-12 items-start gap-x-3 gap-y-1 rounded-lg border p-3"
            >
              {isFinishedGood && (
                <FormField
                  control={form.control}
                  name={`items.${index}.productId`}
                  render={({ field }) => (
                    <FormFieldCell span={4} label="Producto">
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
                    </FormFieldCell>
                  )}
                />
              )}
              {isCoil && (
                <FormField
                  control={form.control}
                  name={`items.${index}.finishId`}
                  render={({ field }) => (
                    <FormFieldCell span={2} label={FINISH_FIELD_LABEL}>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Elige" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {/* D-203: solo acabados completos de la línea de la compra. Uno sin
                                tipo no dice qué color lleva la bobina. */}
                          {(() => {
                            const options = (finishes.data ?? []).filter(
                              (f) =>
                                (f.isActive || f.id === field.value) &&
                                f.kind !== null &&
                                f.businessLine === businessLine,
                            );
                            // F8-S7/M2: el color comercial manda; el código solo aparece si
                            // dos opciones de **esta** lista comparten color.
                            const labels = finishLabels(options);
                            return options.map((f) => (
                              <SelectItem key={f.id} value={f.id}>
                                {labels.get(f.id) ?? f.code}
                              </SelectItem>
                            ));
                          })()}
                        </SelectContent>
                      </Select>
                      <FinishColorHint
                        loading={finishes.isPending}
                        finish={
                          finishes.data?.find(
                            (f) => f.id === field.value && f.businessLine === businessLine,
                          ) ?? null
                        }
                        unmapped={
                          finishes.data?.filter((f) => f.isActive && f.kind === null).length ?? 0
                        }
                      />
                      {finishes.isError && (
                        <p className="text-xs text-destructive">
                          No se pudieron cargar los acabados.
                        </p>
                      )}
                    </FormFieldCell>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name={`items.${index}.description`}
                render={({ field }) => (
                  <FormFieldCell span={4} label="Descripción">
                    <FormControl>
                      <Input autoComplete="off" {...field} />
                    </FormControl>
                  </FormFieldCell>
                )}
              />
              {isCoil && (
                <>
                  <FormField
                    control={form.control}
                    name={`items.${index}.widthMm`}
                    render={({ field }) => (
                      <FormFieldCell span={2} label="Ancho" numeric>
                        <FormControl>
                          <InputWithUnit unit="mm" inputMode="decimal" {...field} />
                        </FormControl>
                      </FormFieldCell>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`items.${index}.thicknessMm`}
                    render={({ field }) => (
                      <FormFieldCell span={2} label="Espesor" numeric>
                        <FormControl>
                          <InputWithUnit unit="mm" inputMode="decimal" {...field} />
                        </FormControl>
                      </FormFieldCell>
                    )}
                  />
                </>
              )}
              <FormField
                control={form.control}
                name={`items.${index}.qty`}
                render={({ field }) => (
                  <FormFieldCell span={2} label={isCoil ? 'Peso' : 'Cantidad'} numeric>
                    <FormControl>
                      {isCoil ? (
                        <InputWithUnit unit="kg" inputMode="decimal" {...field} />
                      ) : (
                        <Input inputMode="decimal" {...field} />
                      )}
                    </FormControl>
                  </FormFieldCell>
                )}
              />
              {!isCoil && (
                <FormField
                  control={form.control}
                  name={`items.${index}.unit`}
                  render={({ field }) => (
                    <FormFieldCell span={2} label="Unidad">
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
                    </FormFieldCell>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name={`items.${index}.unitPrice`}
                render={({ field }) => (
                  <FormFieldCell
                    span={2}
                    label={<>{isCoil ? 'Precio por kg' : 'Precio unitario'} (sin IGV)</>}
                    numeric
                  >
                    <FormControl>
                      <Input inputMode="decimal" {...field} />
                    </FormControl>
                  </FormFieldCell>
                )}
              />
              <div className="col-span-2 mt-5">
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
        </Section>

        <Section title="Observaciones">
          <div className="grid grid-cols-12 items-start gap-x-3 gap-y-1 pt-2">
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormFieldCell span={12} label="Observaciones" optional>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                </FormFieldCell>
              )}
            />
          </div>
        </Section>

        {/* cc31 (ESPEC §6): «Qué va a pasar», con cifras, antes de la barra. */}
        <div className="grid gap-1 rounded-lg bg-muted px-3 py-2 text-sm">
          <p className="text-xs font-semibold text-muted-foreground">Qué va a pasar</p>
          <p>
            {isCoil
              ? `La compra queda en borrador. Al recibirla entran ${pluralize(outcome.lines, 'bobina', 'bobinas')} · ${formatKg(outcome.kg)}.`
              : isFinishedGood
                ? `La compra queda en borrador. Al recibirla entran ${pluralize(outcome.lines, 'línea', 'líneas')} al inventario.`
                : 'La compra queda en borrador. No mueve el inventario.'}
          </p>
          <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-8 gap-y-0.5 tabular-nums">
            <dt className="text-muted-foreground">Valor de venta (sin IGV)</dt>
            <dd className="text-right">{formatMoney(totals.subtotal, currency)}</dd>
            <dt className="text-muted-foreground">IGV</dt>
            <dd className="text-right">{formatMoney(totals.igv, currency)}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-medium">{formatMoney(totals.total, currency)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            El costo que entra al kardex es el valor sin IGV; el IGV se guarda aparte.
          </p>
        </div>

        {/* cc27 (D-454): la acción principal queda a la vista en una compra larga. */}
        <StickyActionBar missing={missing}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              router.back();
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
            {submitLabel ?? 'Registrar compra'}
          </Button>
        </StickyActionBar>
      </form>

      <ConfirmDialog
        open={pendingType !== null}
        onOpenChange={(open) => {
          if (!open) setPendingType(null);
        }}
        title="Cambiar el tipo de compra"
        consequences={`Cambiar el tipo borra ${filledLines === 1 ? 'la línea cargada' : `las ${String(filledLines)} líneas cargadas`}. ¿Cambiar igual?`}
        confirmLabel="Cambiar igual"
        onConfirm={() => {
          if (pendingType) applyType(pendingType);
          setPendingType(null);
        }}
      />
    </Form>
  );
}

/** «1 bobina», «3 bobinas». */
function pluralize(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Una línea con algo escrito: cambiar el tipo la perdería. */
function lineHasData(item: PurchaseFormValues['items'][number]): boolean {
  return [
    item.description,
    item.qty,
    item.unitPrice,
    item.widthMm,
    item.thicknessMm,
    item.finishId,
    item.productId,
  ].some((v) => (v ?? '').trim() !== '');
}

/** Lo que entra al recibir: líneas con cantidad válida y la suma de kilos (bobinas). */
function summarizeOutcome(items: PurchaseFormValues['items']): { lines: number; kg: Decimal } {
  let lines = 0;
  let kg = new Decimal(0);
  for (const item of items) {
    if (!isDecimalString(item.qty)) continue;
    lines += 1;
    kg = kg.plus(item.qty);
  }
  return { lines, kg };
}

/** Las rutas de los errores de RHF («supplierId», «items.0.qty»), sin el error del servidor. */
function collectErrorPaths(node: unknown, prefix: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (prefix && prefix !== 'root' && typeof record.type === 'string') out.push(prefix);
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ref' || key === 'type' || key === 'message' || key === 'types') continue;
    if (!prefix && key === 'root') continue;
    collectErrorPaths(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

/**
 * Los campos marcados en la pantalla, en su orden: el control con `aria-invalid` (lo pone
 * `FormControl` de RHF) y su rótulo. Un campo de una línea se nombra con ella («Bobina 2 · Peso»).
 */
function readInvalidFields(root: HTMLElement | null, lineNoun: string): MissingField[] {
  if (!root) return [];
  const out: MissingField[] = [];
  root.querySelectorAll<HTMLElement>('[aria-invalid="true"][id]').forEach((el) => {
    const label = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = (label?.textContent ?? '').replace(/\s*·\s*opcional$/, '').trim() || 'Dato';
    const line = el.closest('[data-line]')?.getAttribute('data-line');
    out.push({ label: line ? `${lineNoun} ${line} · ${text}` : text, target: el.id });
  });
  return out;
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
    // cc33 N1: una compra en soles no lleva TC (el API la guarda con 1 y rechaza otro).
    exchangeRate:
      values.currency !== 'PEN' && values.exchangeRate?.trim()
        ? values.exchangeRate.trim()
        : undefined,
    igvRate: values.igvRate,
    paymentTerms: values.paymentTerms,
    // El superRefine ya garantizó que sea un entero de 1 a 365 cuando hay crédito.
    creditDays: values.creditDays?.trim() ? Number(values.creditDays) : undefined,
    serviceKind: values.type === PurchaseType.SERVICE ? values.serviceKind : undefined,
    relatedPurchaseId:
      values.type === PurchaseType.SERVICE && values.relatedPurchaseId?.trim()
        ? values.relatedPurchaseId
        : undefined,
    relatedCuttingOrderId:
      values.type === PurchaseType.SERVICE &&
      values.serviceKind === 'CUTTING' &&
      values.relatedCuttingOrderId?.trim()
        ? values.relatedCuttingOrderId
        : undefined,
    sourceXmlKey: values.sourceXmlKey ?? undefined,
    notes: values.notes?.trim() ? values.notes.trim() : undefined,
    items: values.items.map((item) => ({
      productId: item.productId?.trim() ? item.productId : undefined,
      description: item.description,
      qty: item.qty,
      unit: isCoil ? 'KGM' : item.unit,
      unitPrice: item.unitPrice,
      // D-203: sin color aparte — la bobina toma el de su acabado.
      finishId: item.finishId?.trim() ? item.finishId : undefined,
      widthMm: item.widthMm?.trim() ? item.widthMm : undefined,
      thicknessMm: item.thicknessMm?.trim() ? item.thicknessMm : undefined,
      // D-328: la bobina comprada llega vigente y con el film puesto; el API la da de alta así.
    })),
  };
}

/**
 * D-203: el color de la bobina **se ve**, pero no se elige: sale del acabado. Si el que hace
 * falta no existe, se dice dónde crearlo; el formulario nunca inventa un color ni un acabado.
 */
function FinishColorHint({
  finish,
  loading,
  unmapped,
}: {
  finish: FinishDto | null;
  loading: boolean;
  /** Acabados activos sin tipo (anteriores a D-203): no se ofrecen hasta completarlos. */
  unmapped: number;
}) {
  if (loading) return <p className="text-xs text-muted-foreground">Cargando acabados…</p>;
  if (!finish) {
    return (
      <p className="text-xs text-muted-foreground">
        {unmapped > 0 &&
          `${String(unmapped)} acabado(s) sin tipo no se ofrecen: un administrador tiene que completarlos. `}
        ¿No está el acabado o el color? Créalo en{' '}
        {/* Pestaña nueva: salir de acá pierde la compra a medio cargar. */}
        <Link
          href="/acabados"
          target="_blank"
          rel="noopener"
          className="underline underline-offset-2"
        >
          Acabados
        </Link>{' '}
        (los colores, en Catálogo → Colores) y vuelve a abrir el selector.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Color de la bobina:{' '}
      {finish.colorName && finish.colorHex ? (
        <ColorSwatch color={{ name: finish.colorName, hexColor: finish.colorHex }} />
      ) : (
        'sin color'
      )}
    </p>
  );
}
