'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  DOC_TYPES,
  ORDER_STAGE_LABELS,
  Role,
  businessToday,
  toDecimal,
  type CustomerDto,
  type DispatchDto,
  type DocType,
  type OrderReadinessDto,
  type SalesOrderListItemDto,
  type SalesOrderProgressDto,
  type TransferMode,
  type TransportSuggestionsDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import {
  formatDate,
  formatKg,
  formatMeters,
  formatUnitQty,
  isPositiveDecimal,
  unitSymbol,
} from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { useSession } from '@/lib/session';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { cn } from '@/lib/utils';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { DetailSummary, type SummaryItem } from '@/components/detail-summary';
import { RoleGate } from '@/components/role-gate';
import { Section } from '@/components/section';
import {
  FormCell,
  FormGrid,
  StickyActionBar,
  focusField,
  type MissingField,
} from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input, InputWithUnit } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatUnitSums, qtyError, sumByUnit, toFixText, ubigeoError } from './dispatch-form';

const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;
const NONE = '';

/** cc31 (ESPEC §6): la modalidad en tres botones; los valores son los mismos de siempre. */
const MODE_OPTIONS: { mode: TransferMode; label: string }[] = [
  { mode: 'PRIVATE', label: 'Vehículo propio' },
  { mode: 'PUBLIC', label: 'Transportista' },
  { mode: 'PICKUP', label: 'Lo recoge el cliente' },
];

/** El estado del material del pedido (RF-S3c, `readiness`), en palabras. */
function readinessSummary(readiness: OrderReadinessDto): { value: string; detail?: string } {
  const missing = toDecimal(readiness.missingMl);
  switch (readiness.status) {
    case 'SIN_PRODUCCION':
      return { value: 'Sin producción', detail: 'el pedido no tiene órdenes de producción' };
    case 'EN_PRODUCCION':
      return {
        value: 'En producción',
        detail: missing.gt(0) ? `faltan ${formatMeters(missing)} por reportar` : undefined,
      };
    case 'LISTO':
      return { value: 'Listo', detail: 'producción terminada' };
    case 'LISTO_CON_FALTANTE':
      return { value: 'Listo con faltante', detail: `faltan ${formatMeters(missing)}` };
  }
}

type SectionKey = 'pedido' | 'sale' | 'traslado' | 'transporte';

/** Un dato que falta o que está mal: dónde está, cómo se llama y qué hay que corregir. */
interface FieldIssue {
  target: string;
  label: string;
  message: string;
  section: SectionKey;
}

/**
 * RF-77/RF-78: despacho de un pedido.
 *
 * Los datos de transporte (D-078) se autocompletan con lo usado en despachos anteriores:
 * es lo que reemplaza al catálogo de vehículos y conductores, que quedó diferido.
 *
 * cc31 (ESPEC §6, «Formulario de página»): secciones con banda gris en el orden en que se
 * decide el despacho (pedido, qué sale, traslado, transporte, observaciones), la franja de
 * resumen del pedido, el bloque «Qué va a pasar» y la barra fija con lo que falta. El botón
 * «Despachar» ya no se apaga por un dato faltante: al pulsarlo con faltantes no envía, marca los
 * campos y lleva el foco al primero. El payload que viaja al API es el mismo de antes.
 */
export function NuevoDespachoView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  /**
   * UX26-02: cada rótulo se enlaza con su control por `htmlFor`/`id`. Sin eso, los campos no
   * tenían nombre accesible (axe `label`/`button-name`) y un lector de pantalla —o un test—
   * no podía llegar a ellos por su rótulo.
   */
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;

  const [salesOrderId, setSalesOrderId] = useState<string>(searchParams.get('pedido') ?? NONE);
  const { user } = useSession();
  const [dispatchDate, setDispatchDate] = useState(businessToday());
  const [originAddress, setOriginAddress] = useState('');
  const [originUbigeo, setOriginUbigeo] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [destinationUbigeo, setDestinationUbigeo] = useState('');
  const [transferMode, setTransferMode] = useState<TransferMode>('PRIVATE');
  const [totalWeightKg, setTotalWeightKg] = useState('');
  const [packageCount, setPackageCount] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [driverGivenNames, setDriverGivenNames] = useState('');
  const [driverFamilyNames, setDriverFamilyNames] = useState('');
  const [driverDocType, setDriverDocType] = useState<DocType>('DNI');
  const [driverDocNumber, setDriverDocNumber] = useState('');
  const [driverLicense, setDriverLicense] = useState('');
  const [carrierDocNumber, setCarrierDocNumber] = useState('');
  const [carrierName, setCarrierName] = useState('');
  const [notes, setNotes] = useState('');
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});
  const [weightKgByLine, setWeightKgByLine] = useState<Record<string, string>>({});
  /**
   * cc27 (UX26-13, D-455): el usuario escribió o eligió algo. El formulario se siembra solo (lo
   * pendiente del pedido, la partida más usada), así que comparar contra el estado inicial avisaría
   * sin que nadie haya tocado nada: cuenta lo tipeado y lo elegido en un selector (cc28, SM-4).
   */
  const [typed, setTyped] = useState(false);
  /** cc31: se pulsó «Despachar» con faltantes; desde ahí cada campo dice qué corregir. */
  const [showErrors, setShowErrors] = useState(false);

  const orders = useQuery({
    queryKey: ['sales-orders', 'dispatchable'],
    queryFn: () => fetchAllForPicker<SalesOrderListItemDto>('/sales/orders'),
  });

  const progress = useQuery({
    queryKey: ['order-progress', salesOrderId],
    queryFn: () => api<SalesOrderProgressDto>(`/invoicing/orders/${salesOrderId}/progress`),
    enabled: salesOrderId !== NONE,
  });

  const suggestions = useQuery({
    queryKey: ['transport-suggestions'],
    queryFn: () => api<TransportSuggestionsDto>('/dispatches/transport-suggestions'),
  });

  /**
   * cc31: el cliente del pedido, por su documento (franja de resumen) y su dirección guardada
   * (dirección de llegada). El maestro guarda una sola dirección por cliente.
   */
  const customerId = progress.data?.customerId ?? null;
  const customer = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => api<CustomerDto>(`/customers/${customerId ?? ''}`),
    enabled: customerId !== null,
  });
  const savedAddress = customer.data?.address?.trim() ?? '';
  const customerAddress = savedAddress === '' ? null : savedAddress;

  const selectedOrder = useMemo(
    () => (orders.data ?? []).find((o) => o.id === salesOrderId) ?? null,
    [orders.data, salesOrderId],
  );

  const lines = useMemo(() => progress.data?.lines ?? [], [progress.data]);
  const pendingLines = useMemo(
    () => lines.filter((l) => toDecimal(l.pendingDispatchQty).gt(0)),
    [lines],
  );

  /** Se propone despachar todo lo pendiente: es el caso normal. */
  function fillWithPending(): void {
    setQtyByLine(
      Object.fromEntries(pendingLines.map((l) => [l.salesOrderItemId, l.pendingDispatchQty])),
    );
  }

  // Se propone despachar todo lo pendiente: es el caso normal, y dejarlo en blanco
  // obligaba a retipear el pedido entero.
  useEffect(() => {
    if (!progress.data) return;
    setQtyByLine(
      Object.fromEntries(
        progress.data.lines
          .filter((l) => toDecimal(l.pendingDispatchQty).gt(0))
          .map((l) => [l.salesOrderItemId, l.pendingDispatchQty]),
      ),
    );
  }, [salesOrderId, progress.data]);

  // La partida más usada es el almacén: se propone sola y se puede cambiar.
  useEffect(() => {
    const origin = suggestions.data?.origins[0];
    if (!origin) return;
    setOriginAddress((prev) => (prev === '' ? origin.address : prev));
    setOriginUbigeo((prev) => (prev === '' ? origin.ubigeo : prev));
  }, [suggestions.data]);

  const selectedLines = useMemo(
    () => lines.filter((l) => isPositiveDecimal(qtyByLine[l.salesOrderItemId] ?? '')),
    [lines, qtyByLine],
  );

  // El peso total se propone sumando el de las líneas elegidas, en proporción a lo que
  // cada una reserva. Es editable: la báscula manda sobre la estimación.
  const suggestedWeight = useMemo(
    () =>
      selectedLines
        .reduce((acc, l) => {
          const qty = toDecimal(qtyByLine[l.salesOrderItemId] ?? '0');
          const ordered = toDecimal(l.qty);
          if (ordered.lte(0)) return acc;
          return acc.plus(toDecimal(l.reserveQty).times(qty).div(ordered));
        }, toDecimal('0'))
        .toFixed(3),
    [selectedLines, qtyByLine],
  );

  useEffect(() => {
    setTotalWeightKg((prev) => (prev === '' || prev === '0.000' ? suggestedWeight : prev));
  }, [suggestedWeight]);

  /**
   * F8-S1/M3: peso teórico de la línea (kg/unidad de venta × cantidad a despachar), la
   * misma propuesta que ya arma `suggestedWeight` para el total pero por línea. `null`
   * cuando el producto no tiene un kg por unidad calculable (a medida): ahí no hay
   * propuesta y el campo queda en blanco hasta que lo escriba la báscula.
   */
  function theoreticalLineWeight(l: SalesOrderProgressDto['lines'][number]): string | null {
    if (l.weightKgPerUnit === null) return null;
    const qty = toDecimal(qtyByLine[l.salesOrderItemId] ?? '0');
    if (qty.lte(0)) return null;
    return toDecimal(l.weightKgPerUnit).times(qty).toFixed(3);
  }

  // Mismo criterio que el peso total (`suggestedWeight`): la propuesta sigue a la cantidad
  // mientras el campo no se tocó, y deja de pisarlo apenas el usuario escribe algo distinto
  // de lo último que se propuso — ahí manda la báscula.
  const lastSuggestedWeightRef = useRef<Record<string, string>>({});
  useEffect(() => {
    setWeightKgByLine((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const l of selectedLines) {
        const suggested = theoreticalLineWeight(l);
        if (suggested === null) continue;
        const current = next[l.salesOrderItemId];
        const wasAutoFilled =
          current === undefined ||
          current === '' ||
          current === lastSuggestedWeightRef.current[l.salesOrderItemId];
        if (wasAutoFilled && current !== suggested) {
          next[l.salesOrderItemId] = suggested;
          changed = true;
        }
        lastSuggestedWeightRef.current[l.salesOrderItemId] = suggested;
      }
      return changed ? next : prev;
    });
  }, [selectedLines, qtyByLine]);

  // cc31: «Sale en este despacho» — suma por unidad y peso de las líneas, siempre con Decimal.
  const unitSums = sumByUnit(
    selectedLines.map((l) => ({ qty: qtyByLine[l.salesOrderItemId] ?? '', unit: l.unit })),
  );
  const unitSumsText = formatUnitSums(unitSums);
  const lineWeights = selectedLines.map((l) => weightKgByLine[l.salesOrderItemId] ?? '');
  const lineWeightTotal = lineWeights
    .filter((w) => isPositiveDecimal(w))
    .reduce((acc, w) => acc.plus(toDecimal(w.trim())), toDecimal('0'));
  const allLineWeightsKnown = lineWeights.every((w) => isPositiveDecimal(w));

  const create = useMutation({
    mutationFn: (confirmBackdate: boolean) =>
      api<DispatchDto>('/dispatches', {
        method: 'POST',
        body: {
          salesOrderId,
          // D-124: `dispatchDate` es la fecha de operación del despacho y la que fecha la
          // salida de kardex. Un VENDEDOR solo puede mandar hoy (el API le da 403 si no).
          dispatchDate,
          confirmBackdate: confirmBackdate || undefined,
          originAddress: originAddress.trim(),
          originUbigeo: originUbigeo.trim(),
          destinationAddress: destinationAddress.trim(),
          destinationUbigeo: destinationUbigeo.trim(),
          transferMode,
          // D-103: un recojo en mostrador no genera guía, así que no lleva peso bruto ni
          // datos de transporte. El API los rechaza si vienen, y con razón: serían datos
          // inventados sobre un traslado que no hacemos nosotros.
          ...(transferMode === 'PICKUP' ? {} : { totalWeightKg }),
          ...(packageCount.trim() ? { packageCount: Number(packageCount) } : {}),
          ...(transferMode === 'PICKUP'
            ? {}
            : transferMode === 'PRIVATE'
              ? {
                  vehiclePlate: vehiclePlate.trim(),
                  driverGivenNames: driverGivenNames.trim(),
                  driverFamilyNames: driverFamilyNames.trim(),
                  driverDocType,
                  driverDocNumber: driverDocNumber.trim(),
                  driverLicense: driverLicense.trim(),
                }
              : {
                  carrierDocNumber: carrierDocNumber.trim(),
                  carrierName: carrierName.trim(),
                }),
          // cc31: las observaciones se ven y se mandan en cualquier modalidad, también en recojo.
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          items: selectedLines.map((l) => {
            const weightKg = (weightKgByLine[l.salesOrderItemId] ?? '').trim();
            return {
              salesOrderItemId: l.salesOrderItemId,
              qty: (qtyByLine[l.salesOrderItemId] ?? '').trim(),
              ...(weightKg ? { weightKg } : {}),
            };
          }),
        },
      }),
    onSuccess: (created) => {
      // cc31 (ESPEC §8): el éxito dice qué salió y trae el paso siguiente. Con transporte, la
      // guía se emite desde el despacho; un recojo no lleva guía (D-103).
      const orderId = salesOrderId;
      toast.success(`${created.code} despachado`, {
        description: unitSumsText
          ? `Salieron ${unitSumsText} del almacén.`
          : 'El material ya salió del almacén.',
        action:
          transferMode === 'PICKUP'
            ? {
                label: 'Ver pedido',
                onClick: () => {
                  router.push(`/pedidos/${orderId}`);
                },
              }
            : {
                label: 'Emitir guía',
                onClick: () => {
                  router.push(`/despachos/${created.id}`);
                },
              },
      });
      invalidateInvoicing(queryClient, { orderId: salesOrderId });
      setTyped(false);
      router.push(`/despachos/${created.id}`);
    },
    onError: (err: unknown) => {
      toast.error(errorMessage(err, 'No se pudo registrar el despacho'));
    },
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await create.mutateAsync(confirmBackdate);
  });

  /**
   * S11/F2-02 y cc31: qué le falta o qué está mal, campo por campo. Son las mismas condiciones
   * que antes apagaban el botón; ahora cada una sabe a qué campo lleva y qué decir debajo de él.
   */
  const issues: FieldIssue[] = [];
  const add = (issue: FieldIssue) => {
    issues.push(issue);
  };
  if (salesOrderId === NONE) {
    add({
      target: fieldId('pedido'),
      label: 'pedido',
      message: 'Elige el pedido que vas a despachar.',
      section: 'pedido',
    });
  }
  const qtyErrors = new Map<string, string>();
  pendingLines.forEach((l) => {
    const err = qtyError(qtyByLine[l.salesOrderItemId] ?? '', l.pendingDispatchQty, l.unit);
    if (err === null) return;
    qtyErrors.set(l.salesOrderItemId, err);
    add({
      target: fieldId(`cantidad-${l.salesOrderItemId}`),
      label: `cantidad de la línea ${String(lines.indexOf(l) + 1)}`,
      message: err,
      section: 'sale',
    });
  });
  if (salesOrderId !== NONE && selectedLines.length === 0 && qtyErrors.size === 0) {
    const first = pendingLines[0];
    add({
      target: first ? fieldId(`cantidad-${first.salesOrderItemId}`) : fieldId('que-sale'),
      label: 'qué cantidad sale',
      message: 'Escribe cuánto sale de al menos una línea.',
      section: 'sale',
    });
  }
  /**
   * F8-S1/M3: el peso es obligatorio por línea para la guía de remisión (SUNAT), pero
   * solo cuando el despacho lleva transporte — un recojo no genera guía (D-103) y el API
   * fija su peso en cero sin pedirlo.
   */
  if (transferMode !== 'PICKUP') {
    selectedLines.forEach((l) => {
      if (isPositiveDecimal(weightKgByLine[l.salesOrderItemId] ?? '')) return;
      add({
        target: fieldId(`peso-${l.salesOrderItemId}`),
        label: `peso de la línea ${String(lines.indexOf(l) + 1)}`,
        message: 'Escribe el peso de la línea en kg: la guía lo pide.',
        section: 'sale',
      });
    });
  }
  if (originAddress.trim() === '') {
    add({
      target: fieldId('origen'),
      label: 'dirección de partida',
      message: 'Escribe la dirección de partida.',
      section: 'traslado',
    });
  }
  const originUbigeoError = ubigeoError(originUbigeo);
  if (originUbigeoError) {
    add({
      target: fieldId('ubigeo-origen'),
      label: 'ubigeo de partida',
      message: originUbigeoError,
      section: 'traslado',
    });
  }
  if (destinationAddress.trim() === '') {
    add({
      target: fieldId('destino'),
      label: 'dirección de llegada',
      message: 'Escribe la dirección de llegada.',
      section: 'traslado',
    });
  }
  const destinationUbigeoError = ubigeoError(destinationUbigeo);
  if (destinationUbigeoError) {
    add({
      target: fieldId('ubigeo-destino'),
      label: 'ubigeo de llegada',
      message: destinationUbigeoError,
      section: 'traslado',
    });
  }
  if (transferMode !== 'PICKUP' && !isPositiveDecimal(totalWeightKg)) {
    add({
      target: fieldId('peso-total'),
      label: 'peso bruto total',
      message: 'Escribe el peso bruto del traslado en kg.',
      section: 'traslado',
    });
  }
  // D-078: la modalidad decide qué datos pide la guía. D-103: el recojo no pide ninguno.
  const transportFields: [string, string, string, string][] =
    transferMode === 'PRIVATE'
      ? [
          ['placa', vehiclePlate, 'placa', 'Escribe la placa.'],
          [
            'conductor-nombres',
            driverGivenNames,
            'nombres del conductor',
            'Escribe los nombres del conductor.',
          ],
          [
            'conductor-apellidos',
            driverFamilyNames,
            'apellidos del conductor',
            'Escribe los apellidos del conductor.',
          ],
          ['licencia', driverLicense, 'licencia de conducir', 'Escribe la licencia de conducir.'],
          [
            'doc-numero',
            driverDocNumber,
            'número de documento',
            'Escribe el número de documento del conductor.',
          ],
        ]
      : transferMode === 'PUBLIC'
        ? [
            [
              'transportista-ruc',
              carrierDocNumber,
              'RUC del transportista',
              'Escribe el RUC del transportista.',
            ],
            [
              'transportista-nombre',
              carrierName,
              'razón social del transportista',
              'Escribe la razón social del transportista.',
            ],
          ]
        : [];
  for (const [name, value, label, message] of transportFields) {
    if (value.trim() === '') {
      add({ target: fieldId(name), label, message, section: 'transporte' });
    }
  }

  const errorFor = (name: string): string | null =>
    showErrors ? (issues.find((i) => i.target === fieldId(name))?.message ?? null) : null;
  const sectionSummary = (section: SectionKey): string | undefined => {
    if (!showErrors) return undefined;
    const count = issues.filter((i) => i.section === section).length;
    return count > 0 ? toFixText(count) : undefined;
  };
  const missing: MissingField[] = issues.map((i) => ({ label: i.label, target: i.target }));

  useUnsavedChanges(typed && !create.isSuccess);

  function submit(): void {
    if (create.isPending) return;
    const first = issues[0];
    if (first) {
      setShowErrors(true);
      focusField(first.target);
      return;
    }
    void backdate.attempt();
  }

  // cc31: «Qué va a pasar al despachar». El pedido queda atendido cuando cada línea con
  // pendiente sale completa; si alguna cantidad está mal, no se afirma nada del estado.
  const everythingLeaves =
    pendingLines.length > 0 &&
    qtyErrors.size === 0 &&
    pendingLines.every((l) => {
      const raw = (qtyByLine[l.salesOrderItemId] ?? '').trim();
      return isPositiveDecimal(raw) && toDecimal(raw).eq(toDecimal(l.pendingDispatchQty));
    });
  const linesLeftPending = pendingLines.filter((l) => {
    const raw = (qtyByLine[l.salesOrderItemId] ?? '').trim();
    return !isPositiveDecimal(raw) || toDecimal(raw).lt(toDecimal(l.pendingDispatchQty));
  }).length;
  const orderCode = progress.data?.salesOrderCode ?? selectedOrder?.code ?? 'El pedido';

  const summaryItems: SummaryItem[] = [];
  if (progress.data) {
    const docLabel = customer.data
      ? `${customer.data.docType} ${customer.data.docNumber}`
      : selectedOrder?.customerDocNumber;
    summaryItems.push({
      label: 'Cliente',
      value: progress.data.customerName,
      detail: docLabel,
    });
    summaryItems.push({
      label: 'Pedido',
      value: progress.data.salesOrderCode,
      detail: selectedOrder?.promisedDeliveryDate
        ? `fecha prometida ${formatDate(selectedOrder.promisedDeliveryDate)}`
        : undefined,
    });
    const anyDispatched = lines.some((l) => toDecimal(l.dispatchedQty).gt(0));
    summaryItems.push({
      label: 'Pendiente de despachar',
      value: `${String(pendingLines.length)} ${pendingLines.length === 1 ? 'línea' : 'líneas'}`,
      detail: anyDispatched ? 'con despachos anteriores' : 'ningún despacho previo',
    });
    if (selectedOrder) {
      const material = readinessSummary(selectedOrder.readiness);
      summaryItems.push({ label: 'Material', value: material.value, detail: material.detail });
    }
  }

  const qtyFilledWithPending =
    pendingLines.length > 0 &&
    pendingLines.every((l) => (qtyByLine[l.salesOrderItemId] ?? '') === l.pendingDispatchQty);
  const allQtyEmpty = pendingLines.every(
    (l) => (qtyByLine[l.salesOrderItemId] ?? '').trim() === '',
  );
  const noLinesError = errorFor('que-sale');

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <h1 className="text-xl font-semibold">Nuevo despacho</h1>

      {summaryItems.length > 0 && <DetailSummary items={summaryItems} />}

      {/* D-455: cualquier campo tipeado de aquí abajo cuenta como cambio sin guardar. */}
      <div
        className="contents"
        onInput={() => {
          setTyped(true);
        }}
      >
        <Section title="Pedido y fecha" summary={sectionSummary('pedido')}>
          <FormGrid className="pt-2">
            <FormCell
              span={6}
              label="Pedido"
              htmlFor={fieldId('pedido')}
              help="Solo aparecen pedidos con algo por despachar."
              error={errorFor('pedido')}
            >
              <Select
                value={salesOrderId}
                onValueChange={(v) => {
                  // cc28 (SM-4 de cc27): elegir en un selector también es un cambio sin guardar.
                  setTyped(true);
                  setSalesOrderId(v);
                }}
              >
                <SelectTrigger
                  id={fieldId('pedido')}
                  className="w-full"
                  aria-invalid={errorFor('pedido') ? true : undefined}
                >
                  <SelectValue placeholder="Elige un pedido" />
                </SelectTrigger>
                <SelectContent>
                  {(orders.data ?? [])
                    .filter((o) => o.status !== 'CANCELLED' && o.status !== 'FULFILLED')
                    .map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.code} · {o.customerName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormCell>
            <FormCell
              span={3}
              label="Fecha de traslado"
              htmlFor={fieldId('fecha')}
              help={
                user.role === Role.ADMINISTRADOR
                  ? undefined
                  : 'Solo un administrador puede cambiarla.'
              }
            >
              <Input
                id={fieldId('fecha')}
                type="date"
                max={businessToday()}
                value={dispatchDate}
                // D-124: es la fecha de operación del despacho. Solo un administrador la puede
                // mover del día; el API rechaza con 403 a cualquier otro rol que lo intente,
                // así que la pantalla no ofrece algo que va a fallar.
                disabled={user.role !== Role.ADMINISTRADOR}
                onChange={(e) => {
                  setDispatchDate(e.target.value);
                }}
              />
            </FormCell>
            <FormCell span={3} label="Bultos" htmlFor={fieldId('bultos')} size="md" optional>
              <Input
                id={fieldId('bultos')}
                inputMode="numeric"
                value={packageCount}
                onChange={(e) => {
                  setPackageCount(e.target.value);
                }}
              />
            </FormCell>
          </FormGrid>
        </Section>

        <Section
          title="Qué sale"
          summary={
            sectionSummary('sale') ??
            (qtyFilledWithPending ? 'Viene llenado con todo lo pendiente' : undefined)
          }
          action={
            pendingLines.length > 0 ? (
              allQtyEmpty ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setTyped(true);
                    fillWithPending();
                  }}
                >
                  Llenar con lo pendiente
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setTyped(true);
                    setQtyByLine({});
                  }}
                >
                  Vaciar cantidades
                </Button>
              )
            ) : undefined
          }
        >
          <div id={fieldId('que-sale')} className="pt-1">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Producto</TableHead>
                  <TableHead className="text-right">Pedido</TableHead>
                  <TableHead className="text-right">Ya despachado</TableHead>
                  <TableHead className="text-right">Pendiente</TableHead>
                  <TableHead className="w-40 text-right">A despachar</TableHead>
                  <TableHead className="w-40 text-right">Peso</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, index) => {
                  const hasPending = toDecimal(l.pendingDispatchQty).gt(0);
                  const qtyErr = qtyErrors.get(l.salesOrderItemId) ?? null;
                  const qtyMessage =
                    qtyErr ?? errorFor(`cantidad-${l.salesOrderItemId}`) ?? undefined;
                  const weightMessage = errorFor(`peso-${l.salesOrderItemId}`) ?? undefined;
                  const qtyErrId = fieldId(`cantidad-${l.salesOrderItemId}-error`);
                  const weightErrId = fieldId(`peso-${l.salesOrderItemId}-error`);
                  return (
                    <TableRow key={l.salesOrderItemId} className="align-top">
                      <TableCell>
                        <div className="font-medium">{l.description}</div>
                        <div className="text-xs text-muted-foreground">{l.productSku}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUnitQty(l.qty, l.unit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUnitQty(l.dispatchedQty, l.unit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUnitQty(l.pendingDispatchQty, l.unit)}
                      </TableCell>
                      <TableCell>
                        {/* UX26-02: la celda no tiene rótulo propio; el nombre dice qué línea es. */}
                        <InputWithUnit
                          id={fieldId(`cantidad-${l.salesOrderItemId}`)}
                          unit={unitSymbol(l.unit)}
                          aria-label={`Cantidad a despachar de la línea ${index + 1} (${l.productSku})`}
                          aria-invalid={qtyMessage ? true : undefined}
                          aria-describedby={qtyMessage ? qtyErrId : undefined}
                          inputMode="decimal"
                          className="text-right tabular-nums"
                          disabled={!hasPending}
                          value={qtyByLine[l.salesOrderItemId] ?? ''}
                          onChange={(e) => {
                            setQtyByLine((prev) => ({
                              ...prev,
                              [l.salesOrderItemId]: e.target.value,
                            }));
                          }}
                        />
                        {qtyMessage && (
                          <p
                            id={qtyErrId}
                            role="alert"
                            className="mt-1 text-right text-xs text-destructive"
                          >
                            {qtyMessage}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {/*
                          F8-S1/M3: el peso es de la guía de remisión (SUNAT), no del kardex —
                          se pide por línea siempre que hay algo que despachar, prellenado con
                          el kg teórico cuando el producto lo tiene (D-118) y editable con la
                          báscula. Solo es obligatorio con transporte (validado en `issues`);
                          en recojo el API lo ignora y lo deja en cero (D-103).
                        */}
                        <InputWithUnit
                          id={fieldId(`peso-${l.salesOrderItemId}`)}
                          unit="kg"
                          aria-label={`Peso (kg) de la línea ${index + 1} (${l.productSku})`}
                          aria-invalid={weightMessage ? true : undefined}
                          aria-describedby={weightMessage ? weightErrId : undefined}
                          inputMode="decimal"
                          className="text-right tabular-nums"
                          disabled={!hasPending}
                          value={weightKgByLine[l.salesOrderItemId] ?? ''}
                          onChange={(e) => {
                            setWeightKgByLine((prev) => ({
                              ...prev,
                              [l.salesOrderItemId]: e.target.value,
                            }));
                          }}
                        />
                        {weightMessage && (
                          <p
                            id={weightErrId}
                            role="alert"
                            className="mt-1 text-right text-xs text-destructive"
                          >
                            {weightMessage}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Elige un pedido para ver qué queda por despachar.
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow className="bg-muted/40 font-medium hover:bg-muted/40">
                    <TableCell colSpan={4}>Sale en este despacho</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {qtyErrors.size > 0
                        ? `corrige ${qtyErrors.size === 1 ? 'la cantidad marcada' : 'las cantidades marcadas'}`
                        : unitSumsText || 'nada todavía'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {selectedLines.length > 0 ? formatKg(lineWeightTotal) : '—'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {noLinesError && (
              <p role="alert" className="mt-1 px-2.5 text-xs text-destructive">
                {noLinesError}
              </p>
            )}
          </div>
        </Section>

        <Section title="Traslado" summary={sectionSummary('traslado')}>
          <FormGrid className="pt-2">
            <div className="col-span-12 mb-3 flex flex-col items-start">
              <span id={fieldId('modalidad-rotulo')} className="mb-1 text-sm font-medium">
                Modalidad
              </span>
              <div
                role="group"
                aria-labelledby={fieldId('modalidad-rotulo')}
                className="flex flex-wrap gap-2"
              >
                {MODE_OPTIONS.map((o) => (
                  <Button
                    key={o.mode}
                    type="button"
                    variant={transferMode === o.mode ? 'default' : 'outline'}
                    aria-pressed={transferMode === o.mode}
                    onClick={() => {
                      setTyped(true);
                      setTransferMode(o.mode);
                    }}
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            </div>
            <FormCell
              span={8}
              label="Dirección de partida"
              htmlFor={fieldId('origen')}
              error={errorFor('origen')}
            >
              <Input
                id={fieldId('origen')}
                value={originAddress}
                list="origenes"
                maxLength={240}
                aria-invalid={errorFor('origen') ? true : undefined}
                onChange={(e) => {
                  setOriginAddress(e.target.value);
                  const match = suggestions.data?.origins.find((o) => o.address === e.target.value);
                  if (match) setOriginUbigeo(match.ubigeo);
                }}
              />
              <datalist id="origenes">
                {(suggestions.data?.origins ?? []).map((o) => (
                  <option key={o.address} value={o.address} />
                ))}
              </datalist>
            </FormCell>
            <FormCell
              span={4}
              label="Ubigeo de partida"
              htmlFor={fieldId('ubigeo-origen')}
              size="md"
              help="6 dígitos del distrito."
              error={errorFor('ubigeo-origen')}
            >
              <Input
                id={fieldId('ubigeo-origen')}
                inputMode="numeric"
                maxLength={6}
                value={originUbigeo}
                aria-invalid={errorFor('ubigeo-origen') ? true : undefined}
                onChange={(e) => {
                  setOriginUbigeo(e.target.value);
                }}
              />
            </FormCell>
            <FormCell
              span={8}
              label="Dirección de llegada"
              htmlFor={fieldId('destino')}
              error={errorFor('destino')}
              help={
                customerAddress ? (
                  <span>
                    Dirección guardada del cliente, o escribe otra.
                    {destinationAddress.trim() !== customerAddress && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="text-primary underline-offset-2 hover:underline"
                          onClick={() => {
                            setTyped(true);
                            setDestinationAddress(customerAddress);
                          }}
                        >
                          Usar «{customerAddress}»
                        </button>
                      </>
                    )}
                  </span>
                ) : undefined
              }
            >
              <Input
                id={fieldId('destino')}
                value={destinationAddress}
                list={customerAddress ? 'direcciones-cliente' : undefined}
                maxLength={240}
                aria-invalid={errorFor('destino') ? true : undefined}
                onChange={(e) => {
                  setDestinationAddress(e.target.value);
                }}
              />
              {customerAddress && (
                <datalist id="direcciones-cliente">
                  <option value={customerAddress} />
                </datalist>
              )}
            </FormCell>
            <FormCell
              span={4}
              label="Ubigeo de llegada"
              htmlFor={fieldId('ubigeo-destino')}
              size="md"
              help="6 dígitos del distrito. Ejemplo: 150131."
              error={errorFor('ubigeo-destino')}
            >
              <Input
                id={fieldId('ubigeo-destino')}
                inputMode="numeric"
                maxLength={6}
                value={destinationUbigeo}
                aria-invalid={errorFor('ubigeo-destino') ? true : undefined}
                onChange={(e) => {
                  setDestinationUbigeo(e.target.value);
                }}
              />
            </FormCell>
            <FormCell
              span={6}
              label="Peso bruto total"
              htmlFor={fieldId('peso-total')}
              size="lg"
              numeric
              help={`Propuesto ${formatKg(suggestedWeight)} a partir del material reservado; corrígelo con la báscula.`}
              error={errorFor('peso-total')}
              className={transferMode === 'PICKUP' ? 'hidden' : undefined}
            >
              <InputWithUnit
                id={fieldId('peso-total')}
                unit="kg"
                inputMode="decimal"
                value={totalWeightKg}
                aria-invalid={errorFor('peso-total') ? true : undefined}
                onChange={(e) => {
                  setTotalWeightKg(e.target.value);
                }}
              />
            </FormCell>
          </FormGrid>
        </Section>

        {/* D-078: la modalidad decide qué datos pide la guía. D-103: el recojo no pide ninguno. */}
        {transferMode !== 'PICKUP' && (
          <Section
            title={transferMode === 'PRIVATE' ? 'Vehículo y conductor' : 'Transportista'}
            summary={sectionSummary('transporte')}
          >
            <FormGrid className="pt-2">
              {transferMode === 'PRIVATE' ? (
                <>
                  <FormCell
                    span={3}
                    label="Placa"
                    htmlFor={fieldId('placa')}
                    help="Ejemplo: ABC-123."
                    error={errorFor('placa')}
                  >
                    <Input
                      id={fieldId('placa')}
                      value={vehiclePlate}
                      list="placas"
                      maxLength={10}
                      aria-invalid={errorFor('placa') ? true : undefined}
                      onChange={(e) => {
                        setVehiclePlate(e.target.value.toUpperCase());
                      }}
                    />
                    <datalist id="placas">
                      {(suggestions.data?.vehicles ?? []).map((v) => (
                        <option key={v.plate} value={v.plate} />
                      ))}
                    </datalist>
                  </FormCell>
                  <FormCell
                    span={3}
                    label="Licencia de conducir"
                    htmlFor={fieldId('licencia')}
                    error={errorFor('licencia')}
                  >
                    <Input
                      id={fieldId('licencia')}
                      value={driverLicense}
                      maxLength={20}
                      aria-invalid={errorFor('licencia') ? true : undefined}
                      onChange={(e) => {
                        setDriverLicense(e.target.value.toUpperCase());
                      }}
                    />
                  </FormCell>
                  <FormCell span={3} label="Tipo de documento" htmlFor={fieldId('doc-tipo')}>
                    <Select
                      value={driverDocType}
                      onValueChange={(v) => {
                        setTyped(true);
                        setDriverDocType(v as DocType);
                      }}
                    >
                      <SelectTrigger id={fieldId('doc-tipo')} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DOC_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormCell>
                  <FormCell
                    span={3}
                    label="Número de documento"
                    htmlFor={fieldId('doc-numero')}
                    error={errorFor('doc-numero')}
                  >
                    <Input
                      id={fieldId('doc-numero')}
                      value={driverDocNumber}
                      maxLength={20}
                      aria-invalid={errorFor('doc-numero') ? true : undefined}
                      onChange={(e) => {
                        setDriverDocNumber(e.target.value);
                      }}
                    />
                  </FormCell>
                  {/*
                    Nombres y apellidos por separado: SUNAT los pide así y el PSE rechaza la
                    guía sin los apellidos. Partirlos de un campo único se equivoca con un
                    nombre compuesto, y esa adivinanza saldría impresa en la guía.
                  */}
                  <FormCell
                    span={6}
                    label="Nombres del conductor"
                    htmlFor={fieldId('conductor-nombres')}
                    error={errorFor('conductor-nombres')}
                  >
                    <Input
                      id={fieldId('conductor-nombres')}
                      value={driverGivenNames}
                      list="conductores"
                      maxLength={80}
                      aria-invalid={errorFor('conductor-nombres') ? true : undefined}
                      onChange={(e) => {
                        setDriverGivenNames(e.target.value);
                        // Elegir un conductor conocido trae sus apellidos, su documento y su
                        // licencia: es lo que reemplaza al catálogo diferido (D-078).
                        const match = suggestions.data?.drivers.find(
                          (d) => d.givenNames === e.target.value,
                        );
                        if (match) {
                          setDriverFamilyNames(match.familyNames);
                          setDriverDocType(match.docType);
                          setDriverDocNumber(match.docNumber);
                          setDriverLicense(match.license);
                        }
                      }}
                    />
                    <datalist id="conductores">
                      {(suggestions.data?.drivers ?? []).map((d) => (
                        <option key={d.docNumber} value={d.givenNames} />
                      ))}
                    </datalist>
                  </FormCell>
                  <FormCell
                    span={6}
                    label="Apellidos del conductor"
                    htmlFor={fieldId('conductor-apellidos')}
                    error={errorFor('conductor-apellidos')}
                  >
                    <Input
                      id={fieldId('conductor-apellidos')}
                      value={driverFamilyNames}
                      maxLength={80}
                      aria-invalid={errorFor('conductor-apellidos') ? true : undefined}
                      onChange={(e) => {
                        setDriverFamilyNames(e.target.value);
                      }}
                    />
                  </FormCell>
                </>
              ) : (
                <>
                  <FormCell
                    span={4}
                    label="RUC del transportista"
                    htmlFor={fieldId('transportista-ruc')}
                    error={errorFor('transportista-ruc')}
                  >
                    <Input
                      id={fieldId('transportista-ruc')}
                      value={carrierDocNumber}
                      list="transportistas"
                      maxLength={20}
                      aria-invalid={errorFor('transportista-ruc') ? true : undefined}
                      onChange={(e) => {
                        setCarrierDocNumber(e.target.value);
                        const match = suggestions.data?.carriers.find(
                          (c) => c.docNumber === e.target.value,
                        );
                        if (match) setCarrierName(match.name);
                      }}
                    />
                    <datalist id="transportistas">
                      {(suggestions.data?.carriers ?? []).map((c) => (
                        <option key={c.docNumber} value={c.docNumber} />
                      ))}
                    </datalist>
                  </FormCell>
                  <FormCell
                    span={8}
                    label="Razón social del transportista"
                    htmlFor={fieldId('transportista-nombre')}
                    error={errorFor('transportista-nombre')}
                  >
                    <Input
                      id={fieldId('transportista-nombre')}
                      value={carrierName}
                      maxLength={160}
                      aria-invalid={errorFor('transportista-nombre') ? true : undefined}
                      onChange={(e) => {
                        setCarrierName(e.target.value);
                      }}
                    />
                  </FormCell>
                </>
              )}
            </FormGrid>
          </Section>
        )}

        <Section title="Observaciones">
          <FormGrid className="pt-2">
            <FormCell
              span={12}
              label="Observaciones"
              htmlFor={fieldId('notas')}
              optional
              help="Se guarda con el despacho en cualquier modalidad, también en recojo."
            >
              <Input
                id={fieldId('notas')}
                value={notes}
                maxLength={500}
                onChange={(e) => {
                  setNotes(e.target.value);
                }}
              />
            </FormCell>
          </FormGrid>
        </Section>

        <Section title="Qué va a pasar al despachar">
          <ul className="list-disc space-y-1 px-2.5 py-2 pl-7 text-sm">
            {selectedLines.length === 0 ? (
              <li>Todavía no sale nada: escribe cuánto sale de cada línea.</li>
            ) : qtyErrors.size > 0 ? (
              <li>Corrige las cantidades marcadas para ver qué sale.</li>
            ) : (
              <li>
                Salen del almacén <span className="font-semibold tabular-nums">{unitSumsText}</span>
                {transferMode !== 'PICKUP' && allLineWeightsKnown && (
                  <span className="tabular-nums"> ({formatKg(lineWeightTotal)})</span>
                )}
                .
              </li>
            )}
            {progress.data && qtyErrors.size === 0 && selectedLines.length > 0 && (
              <li>
                {everythingLeaves ? (
                  <>
                    {orderCode} pasa a{' '}
                    <span className="font-semibold">{ORDER_STAGE_LABELS.FULFILLED}</span>: no queda
                    nada pendiente.
                  </>
                ) : (
                  <>
                    {orderCode} queda{' '}
                    <span className="font-semibold">{ORDER_STAGE_LABELS.PARTIALLY_FULFILLED}</span>:{' '}
                    {linesLeftPending === 1
                      ? 'queda 1 línea'
                      : `quedan ${String(linesLeftPending)} líneas`}{' '}
                    con algo por despachar.
                  </>
                )}
              </li>
            )}
            <li className={cn(transferMode === 'PICKUP' && 'text-muted-foreground')}>
              {transferMode === 'PICKUP'
                ? 'Lo recoge el cliente: este despacho no lleva guía de remisión.'
                : 'La guía de remisión se emite después, desde el despacho.'}
            </li>
          </ul>
        </Section>
      </div>

      {/* cc27 (D-454) y cc31: «Despachar» queda a la vista y la barra dice qué falta. */}
      <StickyActionBar missing={missing}>
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button pending={create.isPending} pendingText="Despachando…" onClick={submit}>
          Despachar
        </Button>
      </StickyActionBar>

      <BackdateConfirmDialog
        open={backdate.open}
        onOpenChange={(open) => {
          if (!open) backdate.close();
        }}
        detail={backdate.detail ?? ''}
        pending={create.isPending}
        onConfirm={() => {
          void backdate.confirm();
        }}
      />
    </RoleGate>
  );
}
