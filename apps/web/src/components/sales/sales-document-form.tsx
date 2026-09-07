'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  Decimal,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  describePieces,
  MAX_QUOTATION_VALIDITY_DAYS,
  MAX_SALES_ITEMS,
  piecesCount,
  piecesMeters,
  RoofingProductKind,
  salesLineTotals,
  toFixedString,
  type BusinessLine,
  type BusinessLineDto,
  type CustomerDto,
  type ProductDto,
  type QuotationDto,
  type ReservableCoilDto,
  type RoofingPieceDto,
  type SalesItemInput,
  type SalesOrderDto,
  type SellableCoilDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { formatMoney, formatQty, isPositiveDecimal, todayIso, unitSymbol } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { EMPTY_PIECE_ROW, parsePieceRows, type PieceRow } from '@/lib/pieces';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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

/**
 * Formulario de cotización y de pedido directo (D-065). Es el mismo formulario porque un
 * pedido directo es exactamente una cotización que se salta el paso de cotizar: si fueran
 * dos, la validación de líneas divergiría y el pedido directo terminaría admitiendo lo que
 * la cotización rechaza.
 *
 * La única diferencia visible es la vigencia, que solo tiene sentido en una cotización.
 *
 * **D-119 (Fase 7e): sin línea de negocio de documento.** Antes el formulario elegía UNA
 * línea arriba y todas las filas vendían de esa misma línea; ahora cada fila elige la suya
 * (o ninguna, si vende una bobina completa, que siempre es `trading`). El API ya no exige
 * que coincidan (`resolveSalesLines` valida cada línea contra su propio producto).
 *
 * Los totales se calculan con `salesLineTotals` de `@ayr/shared` —la **misma** función que
 * usa el API— para que lo que el vendedor ve mientras tipea sea exactamente lo que se
 * guarda (mismo criterio que el partido de RF-15 y el kilo por pieza de D-059).
 */

/** Un subítem de la línea compuesta: metros a la vista, milímetros hacia el API (D-083). */
type PieceDraft = PieceRow;

interface LineDraft {
  key: number;
  /**
   * D-116 (Fase 7e): `BOBINA` vende una bobina completa (RF-73) — el producto, la cantidad
   * y la reserva los resuelve el API a partir del `saleCoilId`, nunca lo que esta línea
   * tipee. `PRODUCT` es todo lo demás (perfiles, trading normal, coberturas).
   */
  kind: 'PRODUCT' | 'BOBINA';
  /**
   * D-119: línea de negocio de **esta fila**, solo para filtrar su propio catálogo y su
   * propio picker de materia prima — no viaja al API (el producto ya dice la suya).
   * Sin sentido en una fila `BOBINA` (siempre `trading`, D-037).
   */
  businessLine: BusinessLine | '';
  productId: string;
  /** D-116: bobina que esta línea vende entera. Vacío salvo `kind === 'BOBINA'`. */
  saleCoilId: string;
  qty: string;
  unitPricePen: string;
  /** D-066: bobina de la que sale el material prometido. Vacío = se reserva el producto. */
  reserveFromCoilId: string;
  reserveKg: string;
  /**
   * D-083: los largos de una cobertura a medida. La cantidad de la línea deja de tipearse y
   * pasa a ser la suma `Σ cantidad × largo` en metros, que es lo que el API exige que
   * coincida — por eso el campo de cantidad se bloquea en cuanto la línea es compuesta.
   */
  pieces: PieceDraft[];
}

const EMPTY_PIECE = EMPTY_PIECE_ROW;

function emptyLine(key: number): LineDraft {
  return {
    key,
    kind: 'PRODUCT',
    businessLine: '',
    productId: '',
    saleCoilId: '',
    qty: '',
    unitPricePen: '',
    reserveFromCoilId: '',
    reserveKg: '',
    pieces: [EMPTY_PIECE],
  };
}

/** Los subítems del borrador, o el motivo por el que todavía no son válidos. */
function toPieces(rows: PieceDraft[]): RoofingPieceDto[] | null {
  const parsed = parsePieceRows(rows);
  return parsed.ok ? parsed.pieces : null;
}

/** Cantidad y precio con la escala fija que el API aplica antes de calcular (D-003). */
function normalizeLine(l: { qty: string; unitPricePen: string }): {
  qty: string;
  unitPricePen: string;
} {
  return {
    qty: toFixedString(l.qty, 'KG'),
    unitPricePen: toFixedString(l.unitPricePen, 'MONEY'),
  };
}

/** D-083: la línea es compuesta cuando el producto se vende por metro lineal. */
function isMadeToMeasure(product: ProductDto | undefined): boolean {
  return product?.roofingKind === RoofingProductKind.A_MEDIDA;
}

export function SalesDocumentForm({ mode }: { mode: 'quotation' | 'order' }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isQuotation = mode === 'quotation';

  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [validityDays, setValidityDays] = useState(String(DEFAULT_QUOTATION_VALIDITY_DAYS));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => fetchAllForPicker<CustomerDto>('/customers'),
  });
  const businessLines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });
  // D-119: el catálogo completo, una sola vez — cada fila filtra el suyo por su propia
  // línea. Cachear una copia por línea era pedir lo mismo N veces para descartar casi todo.
  const products = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ProductDto[]>('/catalog'),
  });
  // D-116: bobinas DISPONIBLES para vender enteras (RF-73), siempre `trading` (D-037); trae
  // bobinas de Drywall y Metallic Roofing por igual, sin depender de ninguna fila.
  const sellableCoils = useQuery({
    queryKey: ['sellable-coils'],
    queryFn: () => api<SellableCoilDto[]>('/sales/sellable-coils'),
  });

  // D-119: material reservable de cada línea de negocio que alguna fila esté usando —
  // `useQueries` (no un `useQuery` por fila) porque el número de filas cambia en tiempo de
  // ejecución y los hooks no se pueden condicionar a eso. Sin campo de costo: VENDEDOR no
  // tiene acceso a `/coils` (§3.4).
  const distinctLines = [
    ...new Set(lines.flatMap((l) => (l.businessLine ? [l.businessLine] : []))),
  ];
  const coilQueries = useQueries({
    queries: distinctLines.map((bl) => ({
      queryKey: ['reservable-coils', bl],
      queryFn: () => api<ReservableCoilDto[]>(`/sales/reservable-coils?businessLine=${bl}`),
    })),
  });
  const coilsByLine = new Map<string, ReservableCoilDto[]>(
    distinctLines.map((bl, i) => [bl, coilQueries[i]?.data ?? []]),
  );
  const coilsLoadedByLine = new Map<string, boolean>(
    distinctLines.map((bl, i) => [bl, coilQueries[i]?.isSuccess ?? false]),
  );

  const productById = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.id, p])),
    [products.data],
  );

  function patchLine(key: number, patch: Partial<LineDraft>): void {
    // Corregir la línea limpia el cartel rojo: dejarlo hasta el próximo envío hacía que el
    // vendedor siguiera leyendo un error que ya había arreglado.
    setFormError(null);
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /**
   * Al elegir producto se sugiere su precio de lista (D-068); el vendedor lo puede pisar.
   * Si el producto nuevo no tiene precio de lista se **conserva** lo que ya estaba escrito:
   * borrarlo obligaba a retipear un precio que el vendedor acababa de poner a mano.
   */
  function chooseProduct(key: number, productId: string): void {
    const listPrice = productById.get(productId)?.listPricePen;
    patchLine(key, {
      productId,
      ...(listPrice ? { unitPricePen: new Decimal(listPrice).toFixed(4) } : {}),
      // Cambiar de producto puede cambiar la forma de la línea (simple ↔ compuesta): el
      // detalle anterior dejaría de significar nada, y la cantidad se recalcula sola.
      pieces: [EMPTY_PIECE],
      qty: '',
      reserveFromCoilId: '',
      reserveKg: '',
    });
  }

  /** D-116: alterna una línea entre producto normal y venta de bobina completa. */
  function setLineKind(key: number, kind: LineDraft['kind']): void {
    patchLine(key, {
      kind,
      businessLine: '',
      productId: '',
      saleCoilId: '',
      qty: '',
      reserveFromCoilId: '',
      reserveKg: '',
      pieces: [EMPTY_PIECE],
    });
  }

  /**
   * Al elegir la bobina se congela su saldo disponible como cantidad de la línea: "siempre
   * el saldo completo, nunca una fracción" es una decisión del dueño, no un campo editable
   * (el API la vuelve a calcular al confirmar, esto es solo la vista previa).
   */
  function chooseSaleCoil(key: number, coilId: string): void {
    const coil = sellableCoils.data?.find((c) => c.coilId === coilId);
    patchLine(key, { saleCoilId: coilId, qty: coil?.availableQty ?? '' });
  }

  /**
   * Reemplaza los largos de una línea y **recalcula su cantidad**: en una línea compuesta la
   * cantidad no es un dato que el vendedor escriba, es la suma de los largos. Mantenerla
   * como campo editable era ofrecer dos verdades sobre lo mismo, que es justo lo que el API
   * rechaza.
   */
  function patchPieces(key: number, pieces: PieceDraft[]): void {
    const parsed = toPieces(pieces);
    patchLine(key, { pieces, qty: parsed === null ? '' : piecesMeters(parsed).toFixed(3) });
  }

  // El API normaliza a la escala fija antes de calcular (`decimalStringSchema`), así que la
  // previsualización tiene que hacerlo también: con `1.2345` kg, el importe de pantalla y el
  // guardado diferían en milésimas — el mismo desajuste que se corrigió en el partido (2b).
  const totals = lines
    .filter((l) => isPositiveDecimal(l.qty) && isPositiveDecimal(l.unitPricePen))
    .map((l) => salesLineTotals(normalizeLine(l)));
  const subtotal = totals.reduce((acc, t) => acc.plus(t.subtotal), new Decimal(0));
  const igv = totals.reduce((acc, t) => acc.plus(t.igv), new Decimal(0));

  const save = useMutation<QuotationDto | SalesOrderDto, unknown, unknown>({
    mutationFn: (body: unknown) =>
      isQuotation
        ? api<QuotationDto>('/sales/quotations', { method: 'POST', body })
        : api<SalesOrderDto>('/sales/orders', { method: 'POST', body }),
    onSuccess: (created) => {
      toast.success(isQuotation ? 'Cotización creada' : 'Pedido creado');
      invalidateSales(queryClient);
      router.push(isQuotation ? `/cotizaciones/${created.id}` : `/pedidos/${created.id}`);
    },
    onError: (err) => {
      setFormError(err instanceof ApiError ? err.message : 'No se pudo guardar');
    },
  });

  /**
   * Valida el borrador y devuelve las líneas listas, o el primer error legible. Replica lo
   * que el API valida (`resolveSalesLines` y la comprobación de disponible de
   * `createReservations`): el objetivo no es sustituirlo sino evitar el viaje de ida y
   * vuelta, igual que la previsualización del partido (RF-15).
   *
   * El disponible se comprueba **acumulado por bobina**: dos líneas de 250 kg sobre una
   * bobina con 400 disponibles pasan una a una y solo fallan sumadas — y en una cotización
   * ese error no aparece al crearla sino al **confirmar**, cuando el cliente ya tiene el PDF.
   */
  function validate(): { items: SalesItemInput[] } | { error: string } {
    if (!customerId) return { error: 'Elige un cliente' };
    if (isQuotation) {
      const days = Number(validityDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_QUOTATION_VALIDITY_DAYS) {
        return {
          error: `La vigencia debe ser un número entero de 1 a ${MAX_QUOTATION_VALIDITY_DAYS} días`,
        };
      }
    }

    const items: SalesItemInput[] = [];
    const reservedPerCoil = new Map<string, Decimal>();
    const soldCoilIds = new Set<string>();
    for (const [index, l] of lines.entries()) {
      const at = `Línea ${index + 1}`;

      // D-116: una línea BOBINA no tiene producto que elegir ni largos que detallar — el
      // API resuelve todo eso a partir del `saleCoilId` y el saldo vivo de esa bobina.
      if (l.kind === 'BOBINA') {
        if (!l.saleCoilId) return { error: `${at}: elige qué bobina vender` };
        if (soldCoilIds.has(l.saleCoilId)) {
          return {
            error: `${at}: esa bobina ya se está vendiendo en otra línea de este documento`,
          };
        }
        soldCoilIds.add(l.saleCoilId);
        if (!isPositiveDecimal(l.unitPricePen)) {
          return { error: `${at}: escribe el precio por kg` };
        }
        const coil = sellableCoils.data?.find((c) => c.coilId === l.saleCoilId);
        items.push({
          saleCoilId: l.saleCoilId,
          qty: toFixedString(coil?.availableQty ?? l.qty, 'KG'),
          unitPricePen: toFixedString(l.unitPricePen, 'MONEY'),
        });
        continue;
      }

      if (!l.productId) return { error: `${at}: elige un producto` };
      const madeToMeasure = isMadeToMeasure(productById.get(l.productId));
      const pieces = madeToMeasure ? toPieces(l.pieces) : null;
      if (madeToMeasure) {
        const parsed = parsePieceRows(l.pieces);
        if (!parsed.ok) return { error: `${at}: ${parsed.reason}` };
      }
      if (!isPositiveDecimal(l.qty)) {
        return { error: `${at}: la cantidad debe ser mayor a cero` };
      }
      if (!isPositiveDecimal(l.unitPricePen)) {
        return { error: `${at}: escribe un precio unitario mayor a cero` };
      }
      // Los dos campos de la reserva de materia prima van juntos o no van (el API valida lo
      // mismo); acá se dice antes de gastar el viaje.
      const hasCoil = l.reserveFromCoilId !== '';
      const hasKg = l.reserveKg !== '';
      if (hasCoil !== hasKg) {
        return { error: `${at}: para reservar materia prima hacen falta la bobina y los kilos` };
      }
      // Desde D-083 una línea de una línea con cotización obligatoria puede salir de stock
      // (una plancha de catálogo, o el sobrante de una corrida): quien decide es el
      // disponible real al confirmar, no un rechazo de forma acá.
      if (hasKg && !isPositiveDecimal(l.reserveKg)) {
        return { error: `${at}: los kilos a reservar deben ser mayores a cero` };
      }
      if (hasCoil) {
        const coil = coilsByLine.get(l.businessLine)?.find((c) => c.coilId === l.reserveFromCoilId);
        // Sin la lista cargada no se inventa una validación: el API tiene la última palabra
        // y la comprueba bajo el lock del saldo, que es donde de verdad importa.
        if (coil) {
          const acc = (reservedPerCoil.get(coil.coilId) ?? new Decimal(0)).plus(
            toFixedString(l.reserveKg, 'KG'),
          );
          reservedPerCoil.set(coil.coilId, acc);
          if (acc.gt(new Decimal(coil.availableQty))) {
            return {
              error: `${at}: ${coil.code} tiene ${coil.availableQty} kg disponibles y las líneas de este documento ya piden ${acc.toFixed(3)}`,
            };
          }
        }
      }
      const normalized = normalizeLine(l);
      items.push({
        productId: l.productId,
        qty: normalized.qty,
        unitPricePen: normalized.unitPricePen,
        ...(pieces ? { pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })) } : {}),
        ...(hasCoil
          ? {
              reserveFromCoilId: l.reserveFromCoilId,
              reserveKg: toFixedString(l.reserveKg, 'KG'),
            }
          : {}),
      });
    }
    return { items };
  }

  function submit(): void {
    setFormError(null);
    const result = validate();
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    const { items } = result;

    save.mutate({
      customerId,
      issueDate,
      ...(isQuotation ? { validityDays: Number(validityDays) } : {}),
      // `validityDays` ya quedó validado como entero en rango dentro de `validate()`.
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      items,
    });
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">
          {isQuotation ? 'Nueva cotización' : 'Nuevo pedido directo'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isQuotation
            ? 'Simulación de precio: no reserva stock. La reserva nace al confirmarla (D-054).'
            : 'Crea el pedido y reserva el material en el acto. Solo en líneas que no exigen cotización.'}
        </p>
      </div>

      {(customers.isError || businessLines.isError) && (
        <Alert variant="destructive">
          <AlertDescription>
            No se pudieron cargar los maestros. Recarga la página.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-4">
        <div className="grid gap-2 md:col-span-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="customer">Cliente</Label>
            {/* El cliente nuevo se da de alta sin perder el borrador de la cotización. */}
            <Link
              href="/clientes/nuevo"
              target="_blank"
              className="text-xs underline underline-offset-4 text-muted-foreground"
            >
              Registrar un cliente nuevo
            </Link>
          </div>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger id="customer" className="w-full">
              <SelectValue placeholder="Elige un cliente" />
            </SelectTrigger>
            <SelectContent>
              {customers.data
                ?.filter((c) => c.isActive)
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} — {c.docNumber}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="issue-date">Fecha de emisión</Label>
          <Input
            id="issue-date"
            type="date"
            value={issueDate}
            onChange={(e) => {
              setIssueDate(e.target.value);
            }}
          />
        </div>
        {isQuotation && (
          <div className="grid gap-2">
            <Label htmlFor="validity">Vigencia (días)</Label>
            <Input
              id="validity"
              type="number"
              min={1}
              max={MAX_QUOTATION_VALIDITY_DAYS}
              value={validityDays}
              onChange={(e) => {
                setValidityDays(e.target.value);
              }}
            />
          </div>
        )}
        <div className="grid gap-2 md:col-span-3">
          <Label htmlFor="notes">Observaciones</Label>
          <Input
            id="notes"
            maxLength={500}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
          />
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">Línea de negocio</TableHead>
              <TableHead className="w-[20%]">Producto</TableHead>
              <TableHead className="w-[10%]">Cantidad</TableHead>
              <TableHead className="w-[12%]">P. unitario (sin IGV)</TableHead>
              <TableHead className="w-[16%]">Reserva desde bobina</TableHead>
              <TableHead className="w-[10%]">Kg a reservar</TableHead>
              <TableHead className="text-right">Importe</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.flatMap((l, index) => (
              <LineRow
                key={l.key}
                line={l}
                index={index}
                isQuotation={isQuotation}
                businessLines={businessLines.data}
                products={products.data}
                productById={productById}
                sellableCoils={sellableCoils.data}
                sellableCoilsLoaded={sellableCoils.isSuccess}
                reservableCoils={coilsByLine.get(l.businessLine)}
                reservableCoilsLoaded={coilsLoadedByLine.get(l.businessLine) ?? false}
                canRemove={lines.length > 1}
                onPatch={(patch) => {
                  patchLine(l.key, patch);
                }}
                onSetKind={(kind) => {
                  setLineKind(l.key, kind);
                }}
                onChooseProduct={(productId) => {
                  chooseProduct(l.key, productId);
                }}
                onChooseSaleCoil={(coilId) => {
                  chooseSaleCoil(l.key, coilId);
                }}
                onPatchPieces={(rows) => {
                  patchPieces(l.key, rows);
                }}
                onRemove={() => {
                  setLines((current) => current.filter((x) => x.key !== l.key));
                }}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <Button
          variant="outline"
          disabled={lines.length >= MAX_SALES_ITEMS}
          onClick={() => {
            setLines((current) => [...current, emptyLine(nextKey)]);
            setNextKey((k) => k + 1);
          }}
        >
          Agregar línea
        </Button>
        <div className="min-w-56 space-y-1 text-sm">
          <div className="flex justify-between gap-8">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatMoney(subtotal.toFixed(4))}</span>
          </div>
          <div className="flex justify-between gap-8">
            <span className="text-muted-foreground">IGV (18%)</span>
            <span>{formatMoney(igv.toFixed(4))}</span>
          </div>
          <div className="flex justify-between gap-8 border-t pt-1 font-medium">
            <span>Total</span>
            <span>{formatMoney(subtotal.plus(igv).toFixed(4))}</span>
          </div>
        </div>
      </div>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          Cancelar
        </Button>
        <Button disabled={save.isPending} onClick={submit}>
          {save.isPending ? 'Guardando…' : isQuotation ? 'Crear cotización' : 'Crear pedido'}
        </Button>
      </div>
    </>
  );
}

/**
 * Una fila del documento (D-119). Vive aparte del formulario porque su picker de materia
 * prima viene resuelto desde el padre (`useQueries` en `SalesDocumentForm`, D-119): el
 * número de filas cambia en tiempo de ejecución y los hooks no se pueden condicionar a eso.
 */
function LineRow({
  line: l,
  index,
  isQuotation,
  businessLines,
  products,
  productById,
  sellableCoils,
  sellableCoilsLoaded,
  reservableCoils,
  reservableCoilsLoaded,
  canRemove,
  onPatch,
  onSetKind,
  onChooseProduct,
  onChooseSaleCoil,
  onPatchPieces,
  onRemove,
}: {
  line: LineDraft;
  index: number;
  isQuotation: boolean;
  businessLines: BusinessLineDto[] | undefined;
  products: ProductDto[] | undefined;
  productById: Map<string, ProductDto>;
  sellableCoils: SellableCoilDto[] | undefined;
  sellableCoilsLoaded: boolean;
  reservableCoils: ReservableCoilDto[] | undefined;
  reservableCoilsLoaded: boolean;
  canRemove: boolean;
  onPatch: (patch: Partial<LineDraft>) => void;
  onSetKind: (kind: LineDraft['kind']) => void;
  onChooseProduct: (productId: string) => void;
  onChooseSaleCoil: (coilId: string) => void;
  onPatchPieces: (rows: PieceDraft[]) => void;
  onRemove: () => void;
}) {
  const line = businessLines?.find((b) => b.code === l.businessLine);
  const requiresQuotation = line?.quotationRequired ?? false;
  const activeProducts = products?.filter(
    (p) => p.isActive && p.businessLineCode === l.businessLine,
  );
  const product = productById.get(l.productId);
  const valid = isPositiveDecimal(l.qty) && isPositiveDecimal(l.unitPricePen);
  const lineTotal = valid
    ? salesLineTotals({ qty: l.qty, unitPricePen: l.unitPricePen }).subtotal
    : null;
  const madeToMeasure = isMadeToMeasure(product);
  const parsedLine = madeToMeasure ? parsePieceRows(l.pieces) : null;
  const parsedPieces = parsedLine?.ok === true ? parsedLine.pieces : null;
  const pieceError = parsedLine?.ok === false ? parsedLine.reason : '';

  return (
    <>
      <TableRow>
        <TableCell>
          {/* D-119: cada fila elige su propia línea; no gobierna el documento entero. */}
          <Select
            value={l.kind === 'BOBINA' ? '__BOBINA__' : l.businessLine}
            onValueChange={(v) => {
              if (v === '__BOBINA__') {
                onSetKind('BOBINA');
                return;
              }
              if (l.kind === 'BOBINA') onSetKind('PRODUCT');
              onPatch({
                businessLine: v as BusinessLine,
                productId: '',
                pieces: [EMPTY_PIECE],
                qty: '',
                reserveFromCoilId: '',
                reserveKg: '',
              });
            }}
          >
            <SelectTrigger
              className="w-full"
              aria-label={`Línea de negocio de la línea ${index + 1}`}
            >
              <SelectValue placeholder="Elige una línea" />
            </SelectTrigger>
            <SelectContent>
              {businessLines
                // D-065: un pedido directo no se admite en una línea que exige cotización.
                // Ofrecerla llevaba al vendedor a llenar la fila entera y comerse un 400 al
                // guardar — el mismo "previsualización verde → 400" del partido (2b).
                ?.filter(
                  (b) => b.inventoryStrategy === 'STOCK' && (isQuotation || !b.quotationRequired),
                )
                .map((b) => (
                  <SelectItem key={b.id} value={b.code}>
                    {BUSINESS_LINE_LABELS[b.code]}
                  </SelectItem>
                ))}
              {/* D-116: vender una bobina completa es siempre `trading` (D-037); se ofrece
                  como una opción más de la lista en vez de un selector aparte. */}
              <SelectItem value="__BOBINA__">Bobina completa (venta directa)</SelectItem>
            </SelectContent>
          </Select>
          {requiresQuotation && l.kind === 'PRODUCT' && (
            <p className="mt-1 text-xs text-muted-foreground">
              Se fabrica contra el pedido (RF-31): reserva kilos de una bobina concreta, o deja la
              bobina vacía si ya está en stock.
            </p>
          )}
        </TableCell>
        <TableCell>
          {l.kind === 'BOBINA' ? (
            <Select value={l.saleCoilId} onValueChange={onChooseSaleCoil}>
              <SelectTrigger
                className="w-full"
                aria-label={`Bobina a vender de la línea ${index + 1}`}
              >
                <SelectValue placeholder="Bobina" />
              </SelectTrigger>
              <SelectContent>
                {sellableCoils?.map((c) => (
                  <SelectItem key={c.coilId} value={c.coilId}>
                    {c.code} — {formatQty(c.availableQty, 'kg')}
                  </SelectItem>
                ))}
                {sellableCoilsLoaded && sellableCoils?.length === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No hay bobinas disponibles para vender.
                  </div>
                )}
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={l.productId}
              onValueChange={onChooseProduct}
              disabled={l.businessLine === ''}
            >
              <SelectTrigger className="w-full" aria-label={`Producto de la línea ${index + 1}`}>
                <SelectValue placeholder="Producto" />
              </SelectTrigger>
              <SelectContent>
                {activeProducts?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                  </SelectItem>
                ))}
                {/* Un desplegable vacío se ve igual que uno que no cargó: se dice. */}
                {products && activeProducts?.length === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    Esta línea no tiene productos activos.
                  </div>
                )}
              </SelectContent>
            </Select>
          )}
        </TableCell>
        <TableCell>
          <Input
            inputMode="decimal"
            aria-label={`Cantidad de la línea ${index + 1}`}
            value={l.qty}
            // D-083: en una línea compuesta la cantidad la manda el detalle de largos.
            // D-116: en una venta de bobina la manda el saldo disponible. Editarla a mano
            // abriría la puerta a que diga otra cosa, que es exactamente lo que el API
            // rechaza (recalcula igual, siempre).
            readOnly={madeToMeasure || l.kind === 'BOBINA'}
            disabled={madeToMeasure || l.kind === 'BOBINA'}
            onChange={(e) => {
              onPatch({ qty: e.target.value });
            }}
          />
          {l.kind === 'BOBINA' ? (
            <span className="text-xs text-muted-foreground">kg (saldo completo)</span>
          ) : (
            product && (
              <span className="text-xs text-muted-foreground">
                {unitSymbol(product.unit)}
                {/* D-118: kg teóricos de la línea (espesor × ancho × densidad), informativo
                    — el precio no cambia, es peso estimado para el cliente y la guía. */}
                {product.theoreticalKgPerUnit && isPositiveDecimal(l.qty) && (
                  <> · ≈ {new Decimal(product.theoreticalKgPerUnit).times(l.qty).toFixed(3)} kg</>
                )}
              </span>
            )
          )}
        </TableCell>
        <TableCell>
          <Input
            inputMode="decimal"
            aria-label={`Precio unitario de la línea ${index + 1}`}
            value={l.unitPricePen}
            onChange={(e) => {
              onPatch({ unitPricePen: e.target.value });
            }}
          />
          {product?.listPricePen && (
            <span className="text-xs text-muted-foreground">
              Lista: {formatMoney(product.listPricePen, 'PEN', 4)}
            </span>
          )}
        </TableCell>
        <TableCell>
          {l.kind === 'BOBINA' ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <Select
              value={l.reserveFromCoilId}
              onValueChange={(v) => {
                onPatch({ reserveFromCoilId: v });
              }}
              disabled={l.businessLine === ''}
            >
              <SelectTrigger
                className="w-full"
                aria-label={`Bobina a reservar de la línea ${index + 1}`}
              >
                <SelectValue placeholder="Stock del producto" />
              </SelectTrigger>
              <SelectContent>
                {reservableCoils?.map((c) => (
                  <SelectItem key={c.coilId} value={c.coilId}>
                    {c.code} — {formatQty(c.availableQty, 'kg')} disp.
                  </SelectItem>
                ))}
                {reservableCoilsLoaded && reservableCoils?.length === 0 && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No hay bobinas con material disponible en esta línea.
                  </div>
                )}
              </SelectContent>
            </Select>
          )}
        </TableCell>
        <TableCell>
          {l.kind !== 'BOBINA' && (
            <Input
              inputMode="decimal"
              aria-label={`Kilos a reservar de la línea ${index + 1}`}
              value={l.reserveKg}
              disabled={l.reserveFromCoilId === ''}
              onChange={(e) => {
                onPatch({ reserveKg: e.target.value });
              }}
            />
          )}
        </TableCell>
        <TableCell className="text-right">
          {lineTotal ? formatMoney(lineTotal.toFixed(4)) : '—'}
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Quitar la línea ${index + 1}`}
            disabled={!canRemove}
            onClick={onRemove}
          >
            Quitar
          </Button>
        </TableCell>
      </TableRow>
      {/* D-083: el editor de largos va en su propia fila y no en una celda, porque en una
          obra real son varias medidas y no entran en el ancho de la columna. */}
      {madeToMeasure && (
        <TableRow className="bg-muted/40">
          <TableCell colSpan={8} className="py-3">
            <PieceEditor rows={l.pieces} lineIndex={index} onChange={onPatchPieces} />
            <p className="mt-2 text-xs text-muted-foreground">
              {parsedPieces === null
                ? pieceError
                : `${describePieces(parsedPieces)} · ${String(piecesCount(parsedPieces))} planchas · ${piecesMeters(parsedPieces).toFixed(3)} m`}
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Editor de subítems de una línea compuesta (D-083). Habla en **metros** porque es como se
 * mide un techo; el API guarda milímetros como el resto de las medidas del proyecto.
 */
function PieceEditor({
  rows,
  lineIndex,
  onChange,
}: {
  rows: PieceDraft[];
  lineIndex: number;
  onChange: (rows: PieceDraft[]) => void;
}) {
  const set = (i: number, patch: Partial<PieceDraft>) => {
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  };
  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        Planchas de esta línea (cantidad × largo)
      </span>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="w-24"
            inputMode="numeric"
            placeholder="3"
            aria-label={`Planchas del largo ${i + 1} de la línea ${lineIndex + 1}`}
            value={row.qty}
            onChange={(e) => {
              set(i, { qty: e.target.value });
            }}
          />
          <span className="text-muted-foreground">×</span>
          <Input
            className="w-28"
            inputMode="decimal"
            placeholder="4.20"
            aria-label={`Largo ${i + 1} de la línea ${lineIndex + 1} en metros`}
            value={row.lengthM}
            onChange={(e) => {
              set(i, { lengthM: e.target.value });
            }}
          />
          <span className="text-muted-foreground">m</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Quitar el largo ${i + 1} de la línea ${lineIndex + 1}`}
            disabled={rows.length === 1}
            onClick={() => {
              onChange(rows.filter((_, j) => j !== i));
            }}
          >
            Quitar
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => {
          onChange([...rows, EMPTY_PIECE]);
        }}
      >
        Agregar largo
      </Button>
    </div>
  );
}
