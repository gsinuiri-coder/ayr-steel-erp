'use client';

import { useMemo, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  Decimal,
  DEFAULT_QUOTATION_VALIDITY_DAYS,
  describePieces,
  fixedLengthMeters,
  fixedLengthUnitValue,
  fixedLengthValuePerMeter,
  isPlausiblePieceLength,
  MAX_QUOTATION_VALIDITY_DAYS,
  MAX_SALES_ITEMS,
  money,
  PIECE_LENGTH_RANGE_LABEL,
  piecesCount,
  piecesMeters,
  salePriceFromValue,
  saleValueFromPrice,
  salesLineTotals,
  sellsByFixedLength,
  toDecimal,
  toFixedString,
  Unit,
  type BusinessLine,
  type BusinessLineDto,
  type CustomerDto,
  type ProductDto,
  type QuotationDto,
  type RoofingPieceDto,
  type SalesItemInput,
  type SalesOrderDto,
  type ProductStockDto,
  type SellableCoilDto,
  type StockPanelDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { ExpressCreateCustomer, ExpressCreateProduct } from '@/components/express-create';
import { fetchAllForPicker } from '@/lib/fetch-all-for-picker';
import { formatMoney, formatQty, isPositiveDecimal, todayIso, unitSymbol } from '@/lib/format';
import { invalidateSales } from '@/lib/sales-queries';
import { EMPTY_PIECE_ROW, parsePieceRows, type PieceRow } from '@/lib/pieces';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
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
  /**
   * D-162: lo que el vendedor tipea es el **precio de venta, CON IGV** — el número que le
   * promete al cliente. El valor sin IGV, que es lo que se guarda y lo que SUNAT factura, lo
   * deriva el formulario (`precio ÷ 1.18`) y se muestra debajo del campo.
   *
   * D-161: en una plancha de catálogo este precio es **por metro lineal**, no por plancha: el
   * acero se negocia por metro y la plancha tiene largo fijo, así que el valor unitario sale
   * de multiplicar. En todo lo demás es por unidad de venta.
   */
  pricePen: string;
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
    pricePen: '',
    pieces: [EMPTY_PIECE],
  };
}

/**
 * D-161/D-162: de lo que el vendedor tipea a lo que se guarda y a lo que se compara.
 *
 * Una sola función porque las tres cifras se derivan en cadena y separarlas era invitar a que
 * una pantalla mostrara el importe con una y mandara la otra:
 *
 * - `valuePerMeterPen` — el valor por metro (sin IGV) de una plancha, que es lo que viaja al
 *   API en esa línea. `null` en cualquier otra;
 * - `unitValuePen` — el valor unitario (sin IGV) que la línea factura: `largo × valor por
 *   metro` en una plancha, el valor derivado del precio en el resto. Es lo que multiplica la
 *   cantidad y lo que se compara contra el piso;
 * - todo redondeado a la escala de dinero **una sola vez**, con las mismas funciones que usa
 *   el API, para que el importe de pantalla y el guardado sean el mismo número.
 */
function lineValues(
  l: Pick<LineDraft, 'pricePen'>,
  product: ProductDto | undefined,
): { valuePerMeterPen: string | null; unitValuePen: string | null } {
  if (!isPositiveDecimal(l.pricePen)) return { valuePerMeterPen: null, unitValuePen: null };
  const value = toFixedString(money(saleValueFromPrice(l.pricePen)), 'MONEY');
  if (product === undefined || !sellsByFixedLength(product) || product.lengthMm === null) {
    return { valuePerMeterPen: null, unitValuePen: value };
  }
  return {
    valuePerMeterPen: value,
    unitValuePen: toFixedString(money(fixedLengthUnitValue(product.lengthMm, value)), 'MONEY'),
  };
}

/** Los subítems del borrador, o el motivo por el que todavía no son válidos. */
function toPieces(rows: PieceDraft[]): RoofingPieceDto[] | null {
  const parsed = parsePieceRows(rows);
  return parsed.ok ? parsed.pieces : null;
}

/**
 * Los totales de una línea, o `null` si todavía no está completa.
 *
 * El API normaliza a la escala fija antes de calcular (`decimalStringSchema`), así que la
 * previsualización tiene que hacerlo también: con `1.2345` kg, el importe de pantalla y el
 * guardado diferían en milésimas — el mismo desajuste que se corrigió en el partido (2b).
 */
function lineTotalsOf(
  l: Pick<LineDraft, 'qty' | 'pricePen'>,
  product: ProductDto | undefined,
): ReturnType<typeof salesLineTotals> | null {
  const { unitValuePen } = lineValues(l, product);
  if (unitValuePen === null || !isPositiveDecimal(l.qty)) return null;
  return salesLineTotals({ qty: toFixedString(l.qty, 'KG'), unitPricePen: unitValuePen });
}

/**
 * D-083: la línea es compuesta cuando el producto se vende por metro lineal.
 *
 * El nombre es `sellsByLength` y no `isMadeToMeasure` a propósito (D-131): la unidad y el
 * subtipo son **dos preguntas distintas**, y en el API `isMadeToMeasure` es la del subtipo.
 * Compartir el nombre entre las dos es exactamente lo que dejó al mostrador vendiendo
 * material a medida.
 */
function sellsByLength(product: ProductDto | undefined): boolean {
  return product?.unit === Unit.MTR;
}

/**
 * D-161: la línea se cotiza por metro contra el largo fijo del SKU (una plancha de catálogo).
 * Es la **tercera** pregunta de la familia, distinta de las otras dos: ver `sellsByFixedLength`
 * en `@ayr/shared`, que es la definición única y la que usa también el API.
 */
function byFixedLength(product: ProductDto | undefined): boolean {
  return product !== undefined && sellsByFixedLength(product);
}

/**
 * D-166: **¿el largo de catálogo de esta plancha es imposible?**
 *
 * Es una pregunta distinta de las tres de la familia de D-131, y por eso es una función más:
 * `sellsByFixedLength` responde *en qué unidad se negocia* y para eso le alcanza con
 * `largo > 0`; esta responde *si el número del maestro se puede creer*. Con `3.00` mm donde
 * iban 3 000 la primera dice que sí —y multiplica— y solo esta dice que no.
 */
function brokenFixedLength(product: ProductDto | undefined): boolean {
  return (
    product?.roofingKind === 'PLANCHA' &&
    product.unit === Unit.NIU &&
    product.lengthMm !== null &&
    !isPlausiblePieceLength(product.lengthMm)
  );
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

  // D-136: el panel de stock en vivo. Reemplaza al selector "Reserva desde bobina" que
  // D-134 eliminó, y responde otra pregunta: no *cuál rollo* —eso lo decide planta al montar
  // la OP— sino *cuánto hay*, que es lo que el vendedor necesita para prometer.
  //
  // La clave de la consulta incluye la selección, así que cambiar de línea o de producto la
  // reconsulta sola. Se pide la primera línea de negocio con valor porque el agregado de
  // materia prima es por línea; los SKU van todos juntos.
  const panelBusinessLine =
    lines.find((l) => l.kind === 'PRODUCT' && l.businessLine !== '')?.businessLine ?? '';
  const panelProductIds = [...new Set(lines.flatMap((l) => (l.productId ? [l.productId] : [])))];
  const stockPanel = useQuery({
    queryKey: ['stock-panel', panelBusinessLine, panelProductIds.join(',')],
    queryFn: () =>
      api<StockPanelDto>(
        `/sales/stock-panel?${new URLSearchParams({
          ...(panelBusinessLine === '' ? {} : { businessLine: panelBusinessLine }),
          ...(panelProductIds.length === 0 ? {} : { productIds: panelProductIds.join(',') }),
        }).toString()}`,
      ),
  });
  const stockByProductId = new Map(
    (stockPanel.data?.products ?? []).map((row) => [row.productId, row]),
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
   * Al elegir producto se sugiere su valor de lista (D-068); el vendedor lo puede pisar.
   * Si el producto nuevo no tiene valor de lista se **conserva** lo que ya estaba escrito:
   * borrarlo obligaba a retipear un precio que el vendedor acababa de poner a mano.
   *
   * D-161/D-162: el maestro guarda un **valor por unidad de venta y sin IGV**, y el campo de
   * la línea es un **precio con IGV** que en una plancha además es **por metro**. Así que la
   * sugerencia se traduce en vez de copiarse: sin traducir, elegir una plancha de 3.60 m con
   * lista de S/ 25.20 sembraba «25.20 por metro» y la línea salía a S/ 90.72 la plancha.
   */
  function chooseProduct(key: number, productId: string): void {
    const product = productById.get(productId);
    const listValue = product?.listPricePen;
    // D-161: si el producto nuevo se negocia en otra unidad que el anterior —por metro contra
    // por unidad—, lo que había escrito **deja de significar lo mismo**. Antes de D-161 dejarlo
    // era a lo sumo un rótulo desactualizado; ahora un «7.00 por metro» heredado por un perfil
    // se lee como S/ 7.00 la unidad, y al revés es un factor de 3.6. Se limpia salvo que el
    // producto nuevo traiga su propia sugerencia, que lo pisa igual.
    const basisChanged =
      byFixedLength(productById.get(lines.find((l) => l.key === key)?.productId ?? '')) !==
      byFixedLength(product);
    const perUnitValue =
      listValue && product && sellsByFixedLength(product) && product.lengthMm !== null
        ? fixedLengthValuePerMeter(product.lengthMm, listValue)
        : listValue
          ? toDecimal(listValue)
          : null;
    patchLine(key, {
      productId,
      ...(perUnitValue === null
        ? basisChanged
          ? { pricePen: '' }
          : {}
        : { pricePen: toFixedString(money(salePriceFromValue(perUnitValue)), 'MONEY') }),
      // Cambiar de producto puede cambiar la forma de la línea (simple ↔ compuesta): el
      // detalle anterior dejaría de significar nada, y la cantidad se recalcula sola.
      pieces: [EMPTY_PIECE],
      qty: '',
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

  const totals = lines.flatMap((l) => {
    const t = lineTotalsOf(l, productById.get(l.productId));
    return t === null ? [] : [t];
  });
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
        if (!isPositiveDecimal(l.pricePen)) {
          return { error: `${at}: escribe el precio por kg` };
        }
        const coil = sellableCoils.data?.find((c) => c.coilId === l.saleCoilId);
        const { unitValuePen } = lineValues(l, undefined);
        // Sin el `?? '0.0000'`: mandar un cero cuando el precio no se pudo convertir cambiaba
        // un error local y legible por el 400 genérico del schema.
        if (unitValuePen === null) return { error: `${at}: el precio no es un número válido` };
        // D-163: la venta de un rollo entero también tiene piso, y su mínimo viaja por kg en
        // la propia bobina. Se comprueba contra el **precio** tipeado porque es en esa unidad
        // que el API lo devuelve.
        if (coil?.minPricePen && toDecimal(l.pricePen).lt(toDecimal(coil.minPricePen))) {
          return {
            error:
              `${at}: el precio está por debajo del mínimo. El mínimo de ${coil.code} es ` +
              `${formatMoney(coil.minPricePen, 'PEN', 2)} por kg (con IGV). ` +
              'Súbelo, o cambia el margen mínimo de esa línea de negocio en Configuración → Márgenes.',
          };
        }
        items.push({
          saleCoilId: l.saleCoilId,
          qty: toFixedString(coil?.availableQty ?? l.qty, 'KG'),
          unitPricePen: unitValuePen,
        });
        continue;
      }

      if (!l.productId) return { error: `${at}: elige un producto` };
      const product = productById.get(l.productId);
      // D-166: una plancha cuyo largo de catálogo es imposible no se cotiza. El API también lo
      // rechaza, pero decirlo acá señala **qué línea** y, sobre todo, llega antes de que el
      // vendedor mande un documento cuyo importe salió mil veces más chico sin avisar.
      if (brokenFixedLength(product)) {
        return {
          error:
            `${at}: ${product?.sku ?? 'este producto'} tiene ${product?.lengthMm ?? '?'} mm de largo ` +
            `en el catálogo, y el largo de una plancha va entre ${PIECE_LENGTH_RANGE_LABEL}. ` +
            'Corrígelo en Catálogo — el campo va en milímetros, una plancha de 3 metros son 3000.',
        };
      }
      const sellsMeters = sellsByLength(product);
      const pieces = sellsMeters ? toPieces(l.pieces) : null;
      if (sellsMeters) {
        const parsed = parsePieceRows(l.pieces);
        if (!parsed.ok) return { error: `${at}: ${parsed.reason}` };
      }
      if (!isPositiveDecimal(l.qty)) {
        return { error: `${at}: la cantidad debe ser mayor a cero` };
      }
      if (!isPositiveDecimal(l.pricePen)) {
        return {
          error: `${at}: escribe un precio ${byFixedLength(product) ? 'por metro' : 'unitario'} mayor a cero`,
        };
      }
      const { valuePerMeterPen, unitValuePen } = lineValues(l, product);
      if (unitValuePen === null) return { error: `${at}: el precio no es un número válido` };

      // D-163: el piso duro. La palabra final la tiene el API —el costo se puede mover entre
      // que se pintó el panel y que se guarda— pero decirlo acá evita el viaje de ida y
      // vuelta y, sobre todo, señala **qué línea** es: el 400 llega como un cartel rojo
      // suelto arriba del formulario.
      const stock = stockByProductId.get(l.productId);
      if (
        stock?.minValuePen &&
        stock.minPricePen &&
        toDecimal(unitValuePen).lt(toDecimal(stock.minValuePen))
      ) {
        // El mínimo se nombra en la **misma** unidad que el campo que el vendedor acaba de
        // llenar, y con el mismo número que el renglón de ayuda debajo de ese campo: son el
        // mismo `minPricePen`, que el API ya calculó por metro cuando la línea es una plancha.
        // Mostrarlo por plancha y rotularlo «por metro» era reintroducir en el cartel de error
        // el factor ×largo que D-161 vino a corregir.
        const perMeter = byFixedLength(product);
        return {
          error:
            `${at}: el precio está por debajo del mínimo. El mínimo de ${product?.sku ?? 'este producto'} es ` +
            `${formatMoney(stock.minPricePen, 'PEN', 2)} por ${perMeter ? 'metro' : unitSymbol(product?.unit ?? '')} (con IGV). ` +
            'Súbelo, o cambia el margen mínimo de esa línea de negocio en Configuración → Márgenes.',
        };
      }

      // D-134: la línea ya no dice qué reservar. Una cobertura a medida promete kilos del
      // agregado compatible y el API los calcula; el aviso de que no alcanzan sale del panel
      // de stock, y la palabra final la tiene el API bajo el lock, que es donde importa.
      items.push({
        productId: l.productId,
        qty: toFixedString(l.qty, 'KG'),
        // D-161: en una plancha viaja el valor por metro y el API multiplica por el largo del
        // SKU; en el resto viaja el valor unitario. Nunca los dos (el schema lo rechaza).
        ...(valuePerMeterPen === null ? { unitPricePen: unitValuePen } : { valuePerMeterPen }),
        ...(pieces ? { pieces: pieces.map((p) => ({ lengthMm: p.lengthMm, qty: p.qty })) } : {}),
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
            {/*
              D-156: el alta pasa a ser un diálogo sobre esta misma pantalla. El enlace a
              `/clientes/nuevo` en otra pestaña conservaba el borrador —la pantalla no se
              desmontaba— pero dejaba al vendedor volver a mano, buscar el cliente recién
              creado en un desplegable que además puede estar cacheado, y elegirlo. Acá el
              formulario es el mismo y la fila queda elegida sola.
            */}
            <ExpressCreateCustomer
              onCreated={(created) => {
                setCustomerId(created.id);
              }}
            />
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

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Líneas del documento. El material a medida se compromete por kilos; la bobina la elige
          planta.
        </p>
        <StockPanelSheet
          data={stockPanel.data}
          loading={stockPanel.isPending}
          businessLine={panelBusinessLine === '' ? null : panelBusinessLine}
        />
      </div>

      <div className="rounded-lg border">
        {/*
          `min-w`: las celdas de esta tabla son `whitespace-nowrap` por defecto y llevan un
          renglón de ayuda debajo de cada campo (la unidad, el kilo teórico, el precio de
          lista). Sin un ancho mínimo, en una pantalla angosta las columnas se comprimen
          hasta que esos renglones se desbordan y pintan **encima** de la columna vecina —
          que es exactamente el solape que se veía. Con el mínimo, el contenedor
          (`overflow-x-auto` del propio `Table`) desplaza en lugar de aplastar.
        */}
        <Table className="min-w-[68rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[18%]">Línea de negocio</TableHead>
              <TableHead className="w-[22%]">Producto</TableHead>
              {/* Los tres numéricos alineados a la derecha, como en el resto de la app. */}
              <TableHead className="w-[12%] text-right">Cantidad</TableHead>
              {/*
                D-162: se tipea el **precio** (con IGV) y se muestra el **valor** (sin IGV)
                debajo. Las dos palabras son distintas y significan cosas distintas: el precio
                es lo que el cliente paga, el valor es lo que SUNAT factura.
              */}
              <TableHead className="w-[14%] text-right">Precio (con IGV)</TableHead>
              <TableHead className="w-[18%]">Materia prima</TableHead>
              <TableHead className="w-[11%] text-right">Valor de venta</TableHead>
              <TableHead className="w-[5%]" />
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
                stock={l.productId === '' ? undefined : stockByProductId.get(l.productId)}
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
        {/*
          Los tres importes en una rejilla de dos columnas y no en tres `flex` sueltos: así
          los números comparten una misma columna derecha y con `tabular-nums` los dígitos
          quedan uno debajo del otro, que es lo que hace legible una columna de plata.
        */}
        <div className="grid min-w-64 grid-cols-[1fr_auto] gap-x-8 gap-y-1 text-sm">
          {/* D-162: el mismo vocabulario que el PDF y los detalles. Era la única pantalla
              que seguía diciendo «Subtotal»/«Total», y es la pantalla donde se tipea. */}
          <span className="text-muted-foreground">Valor de venta</span>
          <span className="text-right tabular-nums">{formatMoney(subtotal.toFixed(4))}</span>
          <span className="text-muted-foreground">IGV (18%)</span>
          <span className="text-right tabular-nums">{formatMoney(igv.toFixed(4))}</span>
          <span className="border-t pt-1 font-medium">Precio de venta</span>
          <span className="border-t pt-1 text-right text-base font-semibold tabular-nums">
            {formatMoney(subtotal.plus(igv).toFixed(4))}
          </span>
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
  stock,
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
  /** D-136: disponible del SKU y, en una cobertura a medida, del agregado que va a prometer. */
  stock: ProductStockDto | undefined;
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
  const lineTotal = lineTotalsOf(l, product)?.subtotal ?? null;
  const sellsMeters = sellsByLength(product);
  // D-161: una plancha de catálogo cotiza por metro y su cantidad se cuenta en planchas, así
  // que la cantidad la manda su editor de largo fijo igual que en una a medida la manda el
  // detalle de largos. En las dos, el campo de cantidad de la fila es de solo lectura.
  const fixedLength = byFixedLength(product);
  /** El largo del SKU, ya estrechado: `byFixedLength` garantiza que exista, el tipo no. */
  const fixedLengthMm = product?.lengthMm ?? null;
  /** D-166: el largo está, pero no se puede creer. Ver `brokenFixedLength`. */
  const brokenLength = brokenFixedLength(product);
  const { valuePerMeterPen, unitValuePen } = lineValues(l, product);
  const parsedLine = sellsMeters ? parsePieceRows(l.pieces) : null;
  const parsedPieces = parsedLine?.ok === true ? parsedLine.pieces : null;
  const pieceError = parsedLine?.ok === false ? parsedLine.reason : '';

  return (
    <>
      {/*
        `align-top` en toda la fila: cada celda tiene una altura distinta (unas llevan un
        renglón de ayuda debajo del campo, otras no) y con el centrado por defecto los
        campos de una misma fila quedaban a alturas distintas.
      */}
      <TableRow className="align-top">
        {/*
          `whitespace-normal`: la celda hereda `whitespace-nowrap` del componente `Table`,
          pensado para listados de una línea. Acá abajo hay frases —el aviso de RF-31, el
          precio de lista, los kilos a reservar— que en una sola línea se desbordan de su
          columna y se pintan sobre la de al lado. Se repite en cada celda con texto de
          ayuda y no se cambia en `TableCell`, que lo usa media aplicación.
        */}
        <TableCell className="whitespace-normal">
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
                //
                // D-167: **sin filtrar por `inventoryStrategy`**. Excluir las líneas `NOOP`
                // era el reverso del rechazo que el API tenía: el vendedor ni siquiera podía
                // elegir Servicios, así que un conformado no se cotizaba por ninguna puerta.
                // Que una línea no lleve existencias no la hace menos vendible; lo único que
                // cambia es que no promete stock, y eso lo resuelve el API.
                ?.filter((b) => isQuotation || !b.quotationRequired)
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
          {/*
            Una línea y no tres: la frase completa —«la bobina la elige planta; acá solo se
            comprometen los kilos»— ya está arriba de la tabla, y repetirla por fila hacía
            que cada línea de coberturas midiera cuatro renglones de alto.
          */}
          {requiresQuotation && l.kind === 'PRODUCT' && (
            <p className="mt-1 text-xs text-muted-foreground">
              Se fabrica contra el pedido (RF-31)
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
            <div className="grid gap-1">
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
              {/*
                D-156: el SKU que falta se da de alta desde acá, con la línea de la fila ya
                elegida. Es el callejón más caro del sistema: hasta ahora había que salir al
                catálogo con la cotización a medio llenar.
              */}
              {l.businessLine !== '' && (
                <ExpressCreateProduct
                  businessLine={l.businessLine}
                  onCreated={(created) => {
                    onChooseProduct(created.id);
                  }}
                />
              )}
            </div>
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          <Input
            className="text-right tabular-nums"
            inputMode="decimal"
            aria-label={`Cantidad de la línea ${index + 1}`}
            value={l.qty}
            // D-083: en una línea compuesta la cantidad la manda el detalle de largos.
            // D-116: en una venta de bobina la manda el saldo disponible.
            // D-161: en una plancha de catálogo la manda su editor de largo fijo, que es
            // donde el vendedor escribe cuántas planchas lleva.
            // Editarla a mano abriría la puerta a que diga otra cosa, que es exactamente lo
            // que el API rechaza (recalcula igual, siempre).
            readOnly={sellsMeters || fixedLength || l.kind === 'BOBINA'}
            disabled={sellsMeters || fixedLength || l.kind === 'BOBINA'}
            onChange={(e) => {
              onPatch({ qty: e.target.value });
            }}
          />
          {/*
            `block`: el renglón de ayuda va **debajo** del campo, no al lado. Como `span`
            en línea, seguía al `Input` en el mismo flujo y en una columna angosta se salía
            por la derecha.
          */}
          {l.kind === 'BOBINA' ? (
            <span className="mt-1 block text-right text-xs text-muted-foreground">
              kg (saldo completo)
            </span>
          ) : (
            product && (
              <span className="mt-1 block text-right text-xs text-muted-foreground tabular-nums">
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
        <TableCell className="whitespace-normal">
          <Input
            className="text-right tabular-nums"
            inputMode="decimal"
            aria-label={
              fixedLength
                ? `Precio por metro de la línea ${index + 1}`
                : `Precio unitario de la línea ${index + 1}`
            }
            value={l.pricePen}
            onChange={(e) => {
              onPatch({ pricePen: e.target.value });
            }}
          />
          {/*
            D-162: el valor sin IGV va **debajo** del precio y no en su lugar. Es lo que se
            guarda y lo que sale en el comprobante, así que el vendedor lo tiene que ver; y es
            lo que hace evidente que el número de arriba ya lleva el IGV adentro.
            D-161: en una plancha el precio es por metro, así que el renglón dice además a
            cuánto sale la plancha entera — que es lo que el cliente compara.
          */}
          <span className="mt-1 block text-right text-xs text-muted-foreground tabular-nums">
            {fixedLength ? 'por metro' : `por ${unitSymbol(product?.unit ?? '')}`}
            {unitValuePen !== null && (
              <>
                {' · valor '}
                {formatMoney(valuePerMeterPen ?? unitValuePen, 'PEN', 4)}
                {valuePerMeterPen !== null && <> /m</>}
              </>
            )}
          </span>
          {fixedLength && unitValuePen !== null && (
            <span className="mt-0.5 block text-right text-xs text-muted-foreground tabular-nums">
              {formatMoney(unitValuePen, 'PEN', 4)} por plancha
            </span>
          )}
          <PriceFloorHint
            line={l}
            product={product}
            stock={stock}
            coil={sellableCoils?.find((c) => c.coilId === l.saleCoilId)}
          />
          {product?.listPricePen && (
            <span className="mt-1 block text-right text-xs text-muted-foreground tabular-nums">
              Valor de lista: {formatMoney(product.listPricePen, 'PEN', 4)}
            </span>
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          <RawMaterialCell
            line={l}
            product={product}
            stock={stock}
            coil={sellableCoils?.find((c) => c.coilId === l.saleCoilId)}
          />
        </TableCell>
        <TableCell className="text-right font-medium tabular-nums">
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
      {sellsMeters && (
        <TableRow className="bg-muted/40">
          <TableCell colSpan={7} className="py-3">
            <PieceEditor rows={l.pieces} lineIndex={index} onChange={onPatchPieces} />
            <p className="mt-2 text-xs text-muted-foreground">
              {parsedPieces === null
                ? pieceError
                : `${describePieces(parsedPieces)} · ${String(piecesCount(parsedPieces))} planchas · ${piecesMeters(parsedPieces).toFixed(3)} m`}
            </p>
          </TableCell>
        </TableRow>
      )}
      {/*
        D-161: la plancha de catálogo, espejo del plan de corte del espacio de producción
        (D-159): **el largo lo trae el SKU y solo la cantidad se edita**. Sin filas que agregar
        —una plancha de catálogo tiene un largo y uno solo— así que tampoco hay botón para
        agregarlas: ofrecerlo sería ofrecer una medida que el catálogo no tiene.
      */}
      {fixedLength && fixedLengthMm !== null && (
        <TableRow className="bg-muted/40">
          <TableCell colSpan={7} className="py-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid w-32 gap-1">
                <Label htmlFor={`largo-fijo-${index}`}>Largo (m)</Label>
                <Input
                  id={`largo-fijo-${index}`}
                  className="text-right tabular-nums"
                  readOnly
                  disabled
                  value={toDecimal(fixedLengthMm).div(1000).toFixed(2)}
                />
              </div>
              <span className="pb-2 text-muted-foreground">×</span>
              <div className="grid w-32 gap-1">
                <Label htmlFor={`planchas-${index}`}>Planchas</Label>
                <Input
                  id={`planchas-${index}`}
                  className="text-right tabular-nums"
                  inputMode="numeric"
                  placeholder="10"
                  aria-label={`Planchas de la línea ${index + 1}`}
                  value={l.qty}
                  onChange={(e) => {
                    onPatch({ qty: e.target.value });
                  }}
                />
              </div>
              {/* D-166: con un largo de catálogo imposible no se muestran metros lineales —
                  serían 0.030 m para diez planchas de 3 metros, que es justo el número que
                  nadie miró. Se dice qué está mal y dónde se arregla. */}
              {brokenLength ? (
                <p className="pb-2 text-xs text-destructive">
                  El catálogo dice {fixedLengthMm} mm de largo, y una plancha va entre{' '}
                  {PIECE_LENGTH_RANGE_LABEL}. Corrígelo en Catálogo: el campo va en{' '}
                  <strong>milímetros</strong> — una plancha de 3 metros son 3000.
                </p>
              ) : (
                <p className="pb-2 text-xs text-muted-foreground tabular-nums">
                  {isPositiveDecimal(l.qty)
                    ? `${fixedLengthMeters(fixedLengthMm, l.qty).toFixed(3)} m lineales`
                    : 'Escribe cuántas planchas lleva la línea'}
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * El piso de precio de la línea (D-163), debajo del campo del precio.
 *
 * Se muestra **siempre** que exista, no solo cuando se incumple: un mínimo que aparece recién
 * al fallar obliga a tipear a ciegas y a corregir después. En rojo cuando el precio de la
 * línea ya está por debajo, que es el mismo rechazo que el API va a repetir al guardar.
 */
function PriceFloorHint({
  line: l,
  product,
  stock,
  coil,
}: {
  line: LineDraft;
  product: ProductDto | undefined;
  stock: ProductStockDto | undefined;
  /** D-116/D-163: la bobina de una línea `BOBINA`, que trae su propio piso por kg. */
  coil: SellableCoilDto | undefined;
}): ReactElement | null {
  // Una venta de bobina entera es a precio negociado y el vendedor tipea el número a mano, así
  // que es **la línea que más necesita ver su piso**: dejarla sin aviso hacía que el único que
  // le dijera que se pasó fuera el 400 al guardar, con el resto del documento ya lleno.
  const minPricePen =
    l.kind === 'BOBINA' ? (coil?.minPricePen ?? null) : (stock?.minPricePen ?? null);
  const minValuePen = l.kind === 'BOBINA' ? minPricePen : (stock?.minValuePen ?? null);
  if (minPricePen === null || minValuePen === null) return null;
  const fixedLength = byFixedLength(product);
  // `minPricePen` **ya viene en la unidad en la que se tipea** —por metro en una plancha, por
  // kg en una bobina— y ya es un precio tipeable de dos decimales (D-163, `minTypeablePrice`).
  // Convertirlo o redondearlo acá otra vez es exactamente lo que hacía que la pantalla mostrara
  // un mínimo que el API después rechazaba.
  const { unitValuePen } = lineValues(l, l.kind === 'BOBINA' ? undefined : product);
  // En una bobina el piso viaja solo como precio, así que la comparación local se hace contra
  // el precio tipeado; en el resto, contra el valor, que es lo que el API compara.
  const below =
    unitValuePen !== null &&
    (l.kind === 'BOBINA'
      ? isPositiveDecimal(l.pricePen) && toDecimal(l.pricePen).lt(toDecimal(minPricePen))
      : toDecimal(unitValuePen).lt(toDecimal(minValuePen)));
  return (
    <span
      className={`mt-1 block text-right text-xs tabular-nums ${below ? 'font-medium text-destructive' : 'text-muted-foreground'}`}
    >
      Mínimo: {formatMoney(minPricePen, 'PEN', 2)}
      {fixedLength ? ' /m' : l.kind === 'BOBINA' ? ' /kg' : ''}
      {below ? ' — por debajo' : ''}
    </span>
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
            variant="outline"
            size="sm"
            className="w-9"
            aria-label={`Quitar el largo ${i + 1} de la línea ${lineIndex + 1}`}
            disabled={rows.length === 1}
            onClick={() => {
              onChange(rows.filter((_, j) => j !== i));
            }}
          >
            ✕
          </Button>
          {/* El `+` al costado de la última fila, no en un botón ancho debajo (ver
              `length-editor.tsx`: es la misma captura y ahora se ve igual en los dos lados). */}
          {i === rows.length - 1 ? (
            <Button
              variant="outline"
              size="sm"
              className="w-9"
              aria-label={`Agregar otro largo a la línea ${lineIndex + 1}`}
              title="Agregar otro largo"
              onClick={() => {
                onChange([...rows, EMPTY_PIECE]);
              }}
            >
              +
            </Button>
          ) : (
            <span aria-hidden className="w-9" />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * La celda de materia prima de una línea (D-134/D-136).
 *
 * Es informativa y no editable, y esa es toda la diferencia con las dos columnas que
 * reemplaza: antes el vendedor **elegía** un rollo y tipeaba kilos; ahora ve los kilos que su
 * línea va a comprometer y contra cuánto se comparan. La elección del rollo se fue a planta,
 * que es donde se toma (D-086).
 */
function RawMaterialCell({
  line: l,
  product,
  stock,
  coil,
}: {
  line: LineDraft;
  product: ProductDto | undefined;
  stock: ProductStockDto | undefined;
  coil: SellableCoilDto | undefined;
}): ReactElement {
  if (l.kind === 'BOBINA') {
    return (
      <span className="text-sm text-muted-foreground">
        La bobina entera
        {/*
          D-170: el promedio del propio rollo, que es a lo que el kardex lo va a dar de baja.
          Una venta de bobina es a precio negociado por kg y a ojo; con el costo al lado, el
          vendedor ve contra qué está negociando sin despejarlo del precio mínimo.
        */}
        {coil?.avgCostPen && (
          <span className="mt-0.5 block text-xs tabular-nums">
            Costo promedio {formatMoney(coil.avgCostPen, 'PEN', 4)} /kg
          </span>
        )}
        <span className="mt-0.5 block text-xs">Se cierra al despacharla</span>
      </span>
    );
  }
  if (!product) return <span className="text-sm text-muted-foreground">—</span>;

  // D-167: un servicio no lleva existencias, así que no se le muestra un disponible. El cero
  // de su saldo y el cero de un producto agotado se ven iguales y significan lo contrario.
  if (stock?.carriesInventory === false) {
    return <span className="text-xs text-muted-foreground">Servicio · no lleva inventario</span>;
  }

  // D-131: la rama la decide el **subtipo**, no la unidad. Un producto en `MTR` de otra
  // línea (UPVC, trading) sale de stock y tiene su disponible; mandarlo a la rama de
  // materia prima le mostraba "—" justo en el dato que sí existe.
  //
  // **D-171: y ahora la decide tener subtipo, no ser `A_MEDIDA`.** Desde que la plancha se
  // fabrica contra el pedido, mostrarle al vendedor el saldo de su SKU sería mostrarle un cero
  // que no significa nada: lo que decide si puede prometer son los kilos del agregado.
  if (product.roofingKind === null) {
    return (
      <span className="text-xs text-muted-foreground">
        Sale de stock
        {stock && (
          <>
            {' · '}
            {formatQty(stock.availableQty, unitSymbol(stock.unit))} disp.
          </>
        )}
      </span>
    );
  }

  // Kilos teóricos de ESTA línea: el mismo `ml × espesor × ancho × densidad` que el API
  // calcula al confirmar, para que el número que se ve y el que se compromete sean uno.
  //
  // D-171: y los metros salen de la misma conversión que `orderedMeters` del lado del API. En
  // una plancha la cantidad son **planchas**, así que multiplicar el kilo por metro por ella
  // directamente daba los kilos de una plancha de un metro: seis veces menos en un SKU de 6 m,
  // y el vendedor veía que el material alcanzaba justo cuando no alcanzaba.
  // La rama la decide `byFixedLength` —el mismo predicado que el API usa en `orderedMeters`—
  // y **no** el subtipo: preguntarlo por `roofingKind === A_MEDIDA` coincide hoy solo porque
  // el catálogo fuerza `A_MEDIDA → MTR`, y es literalmente el patrón que la regla dura 14
  // prohíbe. La primera `PLANCHA` legada en otra unidad separaba las dos cuentas.
  const meters = !isPositiveDecimal(l.qty)
    ? null
    : byFixedLength(product) && product.lengthMm !== null
      ? new Decimal(l.qty).times(product.lengthMm).div(1000)
      : new Decimal(l.qty);
  const needed =
    stock?.kgPerMeter && meters !== null ? new Decimal(stock.kgPerMeter).times(meters) : null;
  const available =
    stock?.rawMaterialAvailableKg === null || stock?.rawMaterialAvailableKg === undefined
      ? null
      : new Decimal(stock.rawMaterialAvailableKg);
  const short = needed !== null && available !== null && needed.gt(available);

  return (
    <div className="grid gap-0.5 text-xs">
      <span className="font-medium tabular-nums">
        {needed === null ? 'Kg a reservar: —' : `${needed.toFixed(3)} kg a reservar`}
      </span>
      <span
        className={short ? 'text-destructive tabular-nums' : 'text-muted-foreground tabular-nums'}
      >
        {available === null
          ? 'No se pudo calcular la materia prima de este SKU'
          : `${available.toFixed(3)} kg disponibles${short ? ' — no alcanza' : ''}`}
      </span>
      {stock?.rawMaterialLabel && (
        <span className="text-muted-foreground">{stock.rawMaterialLabel}</span>
      )}
    </div>
  );
}

/**
 * Panel de stock en vivo (D-136): un panel lateral, solo lectura, que se abre desde el
 * formulario y se actualiza con lo que el vendedor va eligiendo.
 *
 * Es lo que quedó en el lugar del selector de bobina, y a propósito no es un selector: la
 * pregunta que el vendedor sí tiene que responder es "¿alcanza?", y esa se responde mirando
 * el agregado —espesor + color— y el stock por SKU, no eligiendo un rollo.
 */
function StockPanelSheet({
  data,
  loading,
  businessLine,
}: {
  data: StockPanelDto | undefined;
  loading: boolean;
  businessLine: BusinessLine | null;
}): ReactElement {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          Stock disponible
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="overflow-y-auto p-4">
        <SheetHeader className="p-0">
          <SheetTitle>Stock disponible</SheetTitle>
          <SheetDescription>
            Se actualiza con lo que vas eligiendo. Solo lectura: la bobina concreta la decide planta
            al montar la orden.
          </SheetDescription>
        </SheetHeader>

        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">
            Materia prima
            {businessLine && (
              <span className="ml-1 font-normal text-muted-foreground">
                ({BUSINESS_LINE_LABELS[businessLine]})
              </span>
            )}
          </h3>
          {businessLine === null ? (
            <p className="text-xs text-muted-foreground">
              Elige una línea de negocio para ver las bobinas agrupadas por espesor y color.
            </p>
          ) : loading ? (
            <p className="text-xs text-muted-foreground">Cargando…</p>
          ) : (data?.rawMaterial ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No hay bobinas abiertas en esta línea de negocio.
            </p>
          ) : (
            <ul className="grid gap-2">
              {data?.rawMaterial.map((row) => (
                <li
                  key={`${row.colorId ?? '-'}|${row.thicknessMm}`}
                  className="rounded-md border p-2"
                >
                  <div className="flex items-center gap-2">
                    {row.colorHex && (
                      <span
                        aria-hidden
                        className="size-3 rounded-full border"
                        style={{ backgroundColor: row.colorHex }}
                      />
                    )}
                    <span className="text-sm font-medium">
                      {row.thicknessMm} mm · {row.colorName ?? 'Sin color'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatQty(row.availableKg, 'kg')} disponibles de{' '}
                    {formatQty(row.physicalKg, 'kg')} · ≈ {formatQty(row.theoreticalMeters, 'm')}{' '}
                    lineales
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.coils} bobina{row.coils === 1 ? '' : 's'} ·{' '}
                    {formatQty(row.reservedKg, 'kg')} comprometidos
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Productos de las líneas</h3>
          {(data?.products ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Elige un producto en alguna línea para ver su disponible.
            </p>
          ) : (
            <ul className="grid gap-2">
              {data?.products.map((row) => (
                <li key={row.productId} className="rounded-md border p-2">
                  <p className="text-sm font-medium">{row.sku}</p>
                  <p className="text-xs text-muted-foreground">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {!row.carriesInventory
                      ? 'Servicio: no lleva inventario'
                      : row.rawMaterialAvailableKg !== null
                        ? `${formatQty(row.rawMaterialAvailableKg, 'kg')} de materia prima disponibles`
                        : row.kgPerMeter !== null
                          ? 'No se pudo calcular la materia prima de este SKU'
                          : `${formatQty(row.availableQty, unitSymbol(row.unit))} disponibles`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </SheetContent>
    </Sheet>
  );
}
