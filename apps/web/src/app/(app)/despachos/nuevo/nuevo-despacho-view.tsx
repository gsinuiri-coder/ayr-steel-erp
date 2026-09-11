'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DOC_TYPES,
  Role,
  TRANSFER_MODE_LABELS,
  TRANSFER_MODES,
  businessToday,
  toDecimal,
  type DispatchDto,
  type DocType,
  type SalesOrderListItemDto,
  type SalesOrderProgressDto,
  type TransferMode,
  type TransportSuggestionsDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { isPositiveDecimal, unitSymbol } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { useSession } from '@/lib/session';
import { useBackdateConfirm } from '@/lib/use-backdate-confirm';
import { BackdateConfirmDialog } from '@/components/backdate-confirm-dialog';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;
const NONE = '';

/**
 * RF-77/RF-78: despacho de un pedido.
 *
 * Los datos de transporte (D-078) se autocompletan con lo usado en despachos anteriores:
 * es lo que reemplaza al catálogo de vehículos y conductores, que quedó diferido.
 */
export function NuevoDespachoView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

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
    () =>
      (progress.data?.lines ?? []).filter((l) =>
        isPositiveDecimal(qtyByLine[l.salesOrderItemId] ?? ''),
      ),
    [progress.data, qtyByLine],
  );

  const invalidLines = useMemo(
    () =>
      (progress.data?.lines ?? []).filter((l) => {
        const raw = (qtyByLine[l.salesOrderItemId] ?? '').trim();
        if (raw === '') return false;
        if (!isPositiveDecimal(raw)) return true;
        return toDecimal(raw).gt(toDecimal(l.pendingDispatchQty));
      }).length,
    [progress.data, qtyByLine],
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
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          items: selectedLines.map((l) => ({
            salesOrderItemId: l.salesOrderItemId,
            qty: (qtyByLine[l.salesOrderItemId] ?? '').trim(),
          })),
        },
      }),
    onSuccess: (created) => {
      toast.success(`${created.code} despachado: el stock ya salió del almacén`);
      invalidateInvoicing(queryClient, { orderId: salesOrderId });
      router.push(`/despachos/${created.id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar el despacho');
    },
  });
  const backdate = useBackdateConfirm(async (confirmBackdate) => {
    await create.mutateAsync(confirmBackdate);
  });

  const transportComplete =
    transferMode === 'PICKUP'
      ? true
      : transferMode === 'PRIVATE'
        ? vehiclePlate.trim() !== '' &&
          driverGivenNames.trim() !== '' &&
          driverFamilyNames.trim() !== '' &&
          driverDocNumber.trim() !== '' &&
          driverLicense.trim() !== ''
        : carrierDocNumber.trim() !== '' && carrierName.trim() !== '';

  const canSubmit =
    salesOrderId !== NONE &&
    selectedLines.length > 0 &&
    invalidLines === 0 &&
    originAddress.trim() !== '' &&
    /^\d{6}$/.test(originUbigeo.trim()) &&
    destinationAddress.trim() !== '' &&
    /^\d{6}$/.test(destinationUbigeo.trim()) &&
    (transferMode === 'PICKUP' || isPositiveDecimal(totalWeightKg)) &&
    transportComplete &&
    !create.isPending;

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div>
        <h1 className="text-lg font-semibold">Nuevo despacho</h1>
        <p className="text-xs text-muted-foreground">
          Al guardar, el material sale del kardex y el pedido pasa a atendido —total o en parte—. La
          guía de remisión se emite después, desde el despacho.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pedido y fecha</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-4 gap-y-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label>Pedido</Label>
            <Select value={salesOrderId} onValueChange={setSalesOrderId}>
              <SelectTrigger className="w-full">
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
          </div>
          <div className="space-y-1">
            <Label>Fecha de traslado</Label>
            <Input
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
          </div>
          <div className="space-y-1">
            <Label>Bultos</Label>
            <Input
              inputMode="numeric"
              value={packageCount}
              onChange={(e) => {
                setPackageCount(e.target.value);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traslado</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Dirección de partida</Label>
            <Input
              value={originAddress}
              list="origenes"
              maxLength={240}
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
          </div>
          <div className="space-y-1">
            <Label>Ubigeo de partida</Label>
            <Input
              inputMode="numeric"
              maxLength={6}
              placeholder="150101"
              value={originUbigeo}
              onChange={(e) => {
                setOriginUbigeo(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Dirección de llegada</Label>
            <Input
              value={destinationAddress}
              maxLength={240}
              onChange={(e) => {
                setDestinationAddress(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Ubigeo de llegada</Label>
            <Input
              inputMode="numeric"
              maxLength={6}
              placeholder="150131"
              value={destinationUbigeo}
              onChange={(e) => {
                setDestinationUbigeo(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label>Modalidad</Label>
            <Select
              value={transferMode}
              onValueChange={(v) => {
                setTransferMode(v as TransferMode);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSFER_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {TRANSFER_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1" hidden={transferMode === 'PICKUP'}>
            <Label>Peso bruto total (kg)</Label>
            <Input
              inputMode="decimal"
              value={totalWeightKg}
              onChange={(e) => {
                setTotalWeightKg(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Propuesto {suggestedWeight} kg a partir del material reservado; corrígelo con la
              báscula.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* D-078: la modalidad decide qué datos pide la guía. D-103: el recojo no pide ninguno. */}
      <Card hidden={transferMode === 'PICKUP'}>
        <CardHeader>
          <CardTitle className="text-base">
            {transferMode === 'PRIVATE' ? 'Vehículo y conductor' : 'Transportista'}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-4 gap-y-3 md:grid-cols-3">
          {transferMode === 'PRIVATE' ? (
            <>
              <div className="space-y-1">
                <Label>Placa</Label>
                <Input
                  value={vehiclePlate}
                  list="placas"
                  maxLength={10}
                  onChange={(e) => {
                    setVehiclePlate(e.target.value.toUpperCase());
                  }}
                />
                <datalist id="placas">
                  {(suggestions.data?.vehicles ?? []).map((v) => (
                    <option key={v.plate} value={v.plate} />
                  ))}
                </datalist>
              </div>
              {/*
                Nombres y apellidos por separado: SUNAT los pide así y el PSE rechaza la
                guía sin los apellidos. Partirlos de un campo único se equivoca con un
                nombre compuesto, y esa adivinanza saldría impresa en la guía.
              */}
              <div className="space-y-1">
                <Label>Nombres del conductor</Label>
                <Input
                  value={driverGivenNames}
                  list="conductores"
                  maxLength={80}
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
              </div>
              <div className="space-y-1">
                <Label>Apellidos del conductor</Label>
                <Input
                  value={driverFamilyNames}
                  maxLength={80}
                  onChange={(e) => {
                    setDriverFamilyNames(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Licencia</Label>
                <Input
                  value={driverLicense}
                  maxLength={20}
                  onChange={(e) => {
                    setDriverLicense(e.target.value.toUpperCase());
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Tipo de documento</Label>
                <Select
                  value={driverDocType}
                  onValueChange={(v) => {
                    setDriverDocType(v as DocType);
                  }}
                >
                  <SelectTrigger className="w-full">
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
              </div>
              <div className="space-y-1">
                <Label>Número de documento</Label>
                <Input
                  value={driverDocNumber}
                  maxLength={20}
                  onChange={(e) => {
                    setDriverDocNumber(e.target.value);
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <Label>RUC del transportista</Label>
                <Input
                  value={carrierDocNumber}
                  list="transportistas"
                  maxLength={20}
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
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Razón social del transportista</Label>
                <Input
                  value={carrierName}
                  maxLength={160}
                  onChange={(e) => {
                    setCarrierName(e.target.value);
                  }}
                />
              </div>
            </>
          )}
          <div className="space-y-2 md:col-span-3">
            <Label>Observaciones</Label>
            <Input
              value={notes}
              maxLength={500}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {invalidLines > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            {invalidLines === 1 ? 'Una línea tiene' : `${invalidLines} líneas tienen`} una cantidad
            que no es válida o que pasa lo pendiente de despachar.
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Qué sale</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Pedido</TableHead>
                <TableHead className="text-right">Ya despachado</TableHead>
                <TableHead className="text-right">Pendiente</TableHead>
                <TableHead className="w-36 text-right">A despachar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(progress.data?.lines ?? []).map((l) => (
                <TableRow key={l.salesOrderItemId}>
                  <TableCell>
                    <div className="font-medium">{l.productSku}</div>
                    <div className="text-xs text-muted-foreground">{l.description}</div>
                  </TableCell>
                  <TableCell className="text-sm">{l.itemLabel}</TableCell>
                  <TableCell className="text-right">
                    {l.qty} {unitSymbol(l.unit)}
                  </TableCell>
                  <TableCell className="text-right">{l.dispatchedQty}</TableCell>
                  <TableCell className="text-right">{l.pendingDispatchQty}</TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      className="text-right"
                      disabled={!toDecimal(l.pendingDispatchQty).gt(0)}
                      value={qtyByLine[l.salesOrderItemId] ?? ''}
                      onChange={(e) => {
                        setQtyByLine((prev) => ({
                          ...prev,
                          [l.salesOrderItemId]: e.target.value,
                        }));
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {(progress.data?.lines.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Elige un pedido para ver qué queda por despachar.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button
          disabled={!canSubmit}
          onClick={() => {
            void backdate.attempt();
          }}
        >
          Despachar
        </Button>
      </div>

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
