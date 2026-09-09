'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describePieces,
  piecesMeters,
  MAX_PAGE_SIZE,
  MAX_PIECE_LENGTH_MM,
  MAX_PIECE_LINES,
  MAX_PIECE_QTY,
  MIN_PIECE_LENGTH_MM,
  Role,
  toDecimal,
  type Decimal,
  type CustomerDto,
  type ProductDto,
  type QuotationImportPreviewDto,
  type QuotationImportResultDto,
  type QuotationImportRowDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { RoleGate } from '@/components/role-gate';
import { ExpressCreateCustomer, ExpressCreateProduct } from '@/components/express-create';
import { SearchSelectField, type SearchSelectOption } from '@/components/search-select-modal';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Importador masivo de cotizaciones (D-152).
 *
 * Reemplaza al diálogo del importador genérico que D-150 borró, y cambia de forma a propósito:
 * aquel subía el archivo, lo persistía como lote y editaba las filas **contra el servidor**;
 * este lee el archivo, muestra todo en una tabla que se edita **en el navegador** y recién
 * manda lo revisado. Entre el preview y la confirmación no hay ni un byte guardado, así que no
 * hay lote a medio confirmar que alguien tenga que limpiar después.
 *
 * Dos reglas que la pantalla no afloja porque el API tampoco: **nada se crea solo** —un cliente
 * o un SKU que no está en el maestro detiene su fila— y **nada se adivina**: cuando el plan de
 * corte por defecto (1 × los ML de la línea) no cabe en una plancha, la fila pide el plan real
 * en vez de repartirlo por su cuenta.
 *
 * **D-156** no afloja la primera, le saca el callejón: la fila sigue detenida hasta que una
 * persona decida, pero ahora puede decidir **desde acá**, con el formulario de alta completo
 * del maestro y sin perder el archivo revisado. Lo que D-152 prohibió fue la creación
 * silenciosa, no que el botón estuviera cerca.
 *
 * El guardado es **todo o nada** por archivo, con el error de cada documento cuando alguno
 * falla: mismo contrato que la tanda de planta (D-147).
 */

/**
 * Tope de páginas del maestro de clientes que la pantalla trae para sus desplegables. Con
 * `MAX_PAGE_SIZE` de 200 son 2 000 clientes: mucho más que el maestro real, y una cota para que
 * un maestro que crezca sin control no dispare diez requests al abrir la pantalla.
 */
const MAX_CUSTOMER_PAGES = 10;

/** Lo que el usuario puede cambiar de una fila antes de confirmar. */
interface RowEdit {
  customerId?: string;
  productId?: string;
  qty?: string;
  unitPricePen?: string;
  /** Texto del plan de corte, formato `4x20, 1x1.9`. Vacío = el que trajo el preview. */
  plan?: string;
  removed?: boolean;
}

export function ImportarCotizacionesView() {
  const [preview, setPreview] = useState<QuotationImportPreviewDto | null>(null);
  const [edits, setEdits] = useState<Record<number, RowEdit>>({});
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuotationImportResultDto | null>(null);
  /**
   * D-156: qué comprobantes están desplegados. Solo lo que el usuario tocó a mano: lo que
   * no está acá se abre solo si tiene algo sin resolver, que es el único caso en que hay
   * trabajo que hacer adentro.
   */
  const [openDocuments, setOpenDocuments] = useState<Record<string, boolean>>({});

  // Los maestros completos, una sola vez: son los desplegables con los que se resuelve a mano
  // una fila que el archivo no pudo mapear.
  /**
   * El maestro de clientes entero, paginado de a `MAX_PAGE_SIZE` (D-113).
   *
   * Dos cosas que costaron un defecto cada una. **El tope de página es 200 y el schema lo
   * valida**: pedir 500 devolvía un 400 y el desplegable quedaba vacío, así que una fila sin
   * cliente no se podía corregir y la única salida era quitarla. Y **solo activos**: elegir uno
   * dado de baja tumba el archivo entero en el confirm con "el cliente está desactivado", que
   * no es algo que el usuario pueda arreglar desde acá.
   */
  const customers = useQuery({
    queryKey: ['customers', 'import'],
    queryFn: async () => {
      const items: CustomerDto[] = [];
      let truncated = false;
      for (let page = 1; page <= MAX_CUSTOMER_PAGES; page += 1) {
        const res = await api<{ items: CustomerDto[]; total: number }>(
          `/customers?page=${String(page)}&pageSize=${String(MAX_PAGE_SIZE)}`,
        );
        items.push(...res.items);
        if (items.length >= res.total) break;
        if (page === MAX_CUSTOMER_PAGES) truncated = true;
      }
      return { items: items.filter((c) => c.isActive), truncated };
    },
  });
  const products = useQuery({
    queryKey: ['catalog', 'import'],
    queryFn: () => api<ProductDto[]>('/catalog').then((all) => all.filter((p) => p.isActive)),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return fetch('/api/imports/quotations/preview', {
        method: 'POST',
        body,
        credentials: 'include',
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          let message = `El API respondió ${String(res.status)}`;
          try {
            const parsed = JSON.parse(text) as { message?: string };
            if (parsed.message) message = parsed.message;
          } catch {
            /* el cuerpo no era JSON */
          }
          throw new Error(message);
        }
        return (await res.json()) as QuotationImportPreviewDto;
      });
    },
    onSuccess: (data) => {
      setPreview(data);
      setEdits({});
      setDocumentErrors({});
      // Un archivo nuevo empieza con todos los acordeones en su estado por defecto: si no,
      // un comprobante que el usuario había colapsado a mano en el archivo anterior seguía
      // colapsado acá aunque ahora tenga líneas sin resolver, y el aviso rojo mandaba a
      // corregir filas que no se ven.
      setOpenDocuments({});
      setResult(null);
      toast.success(`${String(data.rows.length)} filas leídas`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'No se pudo leer el archivo');
    },
  });

  /**
   * D-156: lo que el alta express acaba de crear, **sumado a mano al maestro**. La
   * invalidación de la query es asincrónica, así que entre que el diálogo devuelve el
   * registro y la lista se refresca hay una ventana en la que la fila apunta a un id que su
   * desplegable todavía no ofrece: el campo se ve vacío y el error de "elige el cliente"
   * vuelve a aparecer sobre algo que ya está elegido.
   */
  const [createdCustomers, setCreatedCustomers] = useState<CustomerDto[]>([]);
  const [createdProducts, setCreatedProducts] = useState<ProductDto[]>([]);
  const allCustomers = useMemo(
    () => mergeById(customers.data?.items ?? [], createdCustomers),
    [customers.data, createdCustomers],
  );
  const allProducts = useMemo(
    () => mergeById(products.data ?? [], createdProducts),
    [products.data, createdProducts],
  );
  // Las opciones de los dos maestros, una sola vez para las 141 filas: rearmarlas por celda
  // era un recorrido del catálogo entero por render de cada fila.
  const customerOptions = useMemo(
    () => allCustomers.map((c) => ({ id: c.id, label: `${c.docNumber} — ${c.name}` })),
    [allCustomers],
  );
  const productOptions = useMemo(
    () => allProducts.map((p) => ({ id: p.id, label: p.sku, hint: p.name })),
    [allProducts],
  );
  const productsById = useMemo(() => new Map(allProducts.map((p) => [p.id, p])), [allProducts]);
  const customerIds = useMemo(() => new Set(allCustomers.map((c) => c.id)), [allCustomers]);
  const rows = useMemo(
    () =>
      (preview?.rows ?? []).map((row) =>
        resolveRow(row, edits[row.rowNumber] ?? {}, productsById, customerIds),
      ),
    [preview, edits, productsById, customerIds],
  );
  const live = rows.filter((r) => !r.removed && r.raw.excludedReason === null);
  // Solo los **errores** bloquean: un aviso (la unidad del papel que no coincide con la del
  // producto) hay que verlo, no impide crear la cotización — el API la acepta igual.
  const blocking = live.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const documents = new Set(live.map((r) => r.raw.documentKey));
  // D-156: las filas agrupadas por comprobante, en el orden en que aparecen en el archivo.
  const documentGroups = useMemo(() => groupByDocument(rows), [rows]);
  /**
   * Qué comprobantes se abren solos, decidido **sobre el archivo tal como llegó** y no sobre
   * el estado de cada render. Derivarlo de los errores vivos hacía que el acordeón se
   * cerrara en el instante en que se resolvía su última línea: elegir un cliente colapsaba
   * la factura entera y tapaba las otras tres líneas que quedaban por revisar, y tipear el
   * plan de corte desmontaba la tabla a media palabra y se llevaba el foco.
   */
  const autoOpen = useMemo(
    () =>
      new Set(
        groupByDocument(
          (preview?.rows ?? []).map((row) => resolveRow(row, {}, productsById, customerIds)),
        )
          .filter((g) => g.blocking > 0)
          .map((g) => g.key),
      ),
    // A propósito **sin** `edits`: es el estado inicial del archivo, no el actual.
    [preview, productsById, customerIds],
  );

  const setEdit = (rowNumber: number, documentKey: string, patch: RowEdit) => {
    setEdits((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], ...patch } }));
    // Solo el de **este** comprobante: corregir una línea de F001-15 no puede borrar el
    // motivo por el que el servidor rechazó F001-22, que sigue sin corregirse.
    setDocumentErrors((prev) => {
      if (prev[documentKey] === undefined) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== documentKey));
    });
  };

  const confirm = useMutation({
    onMutate: () => {
      setDocumentErrors({});
    },
    mutationFn: () =>
      api<QuotationImportResultDto>('/imports/quotations', {
        method: 'POST',
        body: {
          rows: live.map((r) => ({
            rowNumber: r.raw.rowNumber,
            documentKey: r.raw.documentKey,
            issueDate: r.raw.issueDate,
            customerId: r.customerId,
            productId: r.productId,
            qty: r.qty,
            unitPricePen: r.unitPricePen,
            ...(r.raw.rawProductName ? { description: r.raw.rawProductName } : {}),
            ...(r.pieces ? { pieces: r.pieces } : {}),
          })),
        },
      }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setEdits({});
      toast.success(`${String(data.quotations)} cotizaciones creadas en borrador`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors) {
        const mapped: Record<string, string> = {};
        for (const [key, messages] of Object.entries(err.errors)) {
          if (messages && messages.length > 0) mapped[key] = messages.join(' ');
        }
        setDocumentErrors(mapped);
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo importar');
    },
  });

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Importar cotizaciones</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Sube el export de ventas detalladas y revisa cada línea antes de crear nada. Cada
              comprobante del archivo se convierte en una <strong>cotización en borrador</strong>{' '}
              con su número anotado en las observaciones; de ahí en adelante el camino es el normal:
              emitir, confirmar, producir y vender.
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/cotizaciones">Volver a cotizaciones</Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. El archivo</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="import-file">Excel o CSV del sistema de facturación</Label>
              <Input
                id="import-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={upload.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                  // Sin esto, volver a elegir **el mismo archivo** no dispara `change` y la
                  // pantalla parece colgada.
                  e.target.value = '';
                }}
              />
            </div>
            {preview && (
              <p className="text-sm text-muted-foreground">
                {preview.fileName} · {String(preview.rows.length)} filas ·{' '}
                {String(preview.quotations)} comprobantes
              </p>
            )}
          </CardContent>
        </Card>

        {result && (
          <Alert>
            <AlertDescription>
              Se crearon <strong>{result.quotations}</strong> cotizaciones en borrador a partir de{' '}
              {result.rows} líneas: {result.codes.join(', ')}. Míralas en{' '}
              <Link href="/cotizaciones" className="underline">
                cotizaciones
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}

        {upload.isPending && <Skeleton className="h-64 w-full" />}

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                2. Revisar y corregir{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({String(live.length)} líneas · {String(documents.size)} cotizaciones ·{' '}
                  {String(preview.excluded)} excluidas)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {customers.data?.truncated === true && (
                <Alert>
                  <AlertDescription>
                    El maestro de clientes tiene más de {MAX_CUSTOMER_PAGES * MAX_PAGE_SIZE} activos
                    y el desplegable no los trae a todos. Si el cliente de una fila no aparece,
                    resolvelo desde el maestro y volvé a subir el archivo.
                  </AlertDescription>
                </Alert>
              )}
              {blocking.length > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {blocking.length === 1
                      ? 'Una línea tiene algo sin resolver'
                      : `${String(blocking.length)} líneas tienen algo sin resolver`}
                    . Corrígelas o quítalas: un cliente o un producto que falta se da de alta en su
                    propio maestro, nunca desde acá.
                  </AlertDescription>
                </Alert>
              )}
              {Object.keys(documentErrors).length > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    No se importó nada. {Object.keys(documentErrors).length} comprobantes fueron
                    rechazados por el servidor; el motivo está en su fila.
                  </AlertDescription>
                </Alert>
              )}

              {/*
                D-156: **un acordeón por comprobante**, no 141 filas sueltas. El archivo de
                un mes son decenas de facturas de tres o cuatro líneas cada una, y en una
                tabla plana no había forma de ver de qué factura era una fila ni cuánto
                sumaba: la cabecera dice el número, el cliente, el total y si le falta algo,
                y solo se abre la que hay que tocar.
              */}
              <div className="grid gap-2">
                {documentGroups.map((group) => (
                  <DocumentGroup
                    key={group.key}
                    group={group}
                    open={openDocuments[group.key] ?? autoOpen.has(group.key)}
                    customerOptions={customerOptions}
                    productOptions={productOptions}
                    documentError={documentErrors[group.key] ?? null}
                    disabled={confirm.isPending}
                    onToggle={() => {
                      setOpenDocuments((prev) => ({
                        ...prev,
                        [group.key]: !(prev[group.key] ?? autoOpen.has(group.key)),
                      }));
                    }}
                    onChange={setEdit}
                    onCreatedCustomer={(created) => {
                      setCreatedCustomers((prev) => [...prev, created]);
                    }}
                    onCreatedProduct={(created) => {
                      setCreatedProducts((prev) => [...prev, created]);
                    }}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {preview && (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
              <p className="text-sm text-muted-foreground">
                {live.length === 0
                  ? 'No queda ninguna línea para importar.'
                  : `Se crearán ${String(documents.size)} cotizaciones en borrador con ${String(live.length)} líneas.`}
              </p>
              <Button
                className="h-12"
                disabled={live.length === 0 || blocking.length > 0 || confirm.isPending}
                onClick={() => {
                  confirm.mutate();
                }}
              >
                {confirm.isPending ? 'Importando…' : 'Crear las cotizaciones'}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </RoleGate>
  );
}

// ---------------------------------------------------------------------------
// D-156 — un comprobante del archivo, con sus líneas adentro
// ---------------------------------------------------------------------------

interface DocumentGroup {
  key: string;
  issueDate: string;
  /** El cliente tal como vino en el papel: la cabecera lo dice aunque falte el mapeo. */
  rawCustomer: string;
  /** `Σ cantidad × precio` de las líneas vivas, en soles. */
  totalPen: Decimal;
  rows: ResolvedRow[];
  /** Líneas vivas del comprobante y cuántas tienen algo sin resolver. */
  live: number;
  blocking: number;
}

/**
 * Agrupa por `documentKey` conservando el orden del archivo. La clave del agrupado es la
 * misma que usa el mapa de errores del servidor —el comprobante, no la fila—, así que un
 * rechazo del confirm cae sobre la cabecera correcta sin traducir nada.
 */
function groupByDocument(rows: readonly ResolvedRow[]): DocumentGroup[] {
  const byKey = new Map<string, DocumentGroup>();
  for (const row of rows) {
    const key = row.raw.documentKey;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        issueDate: row.raw.issueDate,
        rawCustomer: row.raw.rawCustomer,
        totalPen: toDecimal('0'),
        rows: [],
        live: 0,
        blocking: 0,
      };
      byKey.set(key, group);
    }
    group.rows.push(row);
    if (row.removed || row.raw.excludedReason !== null) continue;
    group.live += 1;
    if (row.issues.some((i) => i.severity === 'error')) group.blocking += 1;
    // Un importe con el precio o la cantidad mal tipeados no se suma: el total de la
    // cabecera diría un número inventado justo cuando hay que compararlo con el papel.
    if (/^\d+(\.\d+)?$/.test(row.qty.trim()) && /^\d+(\.\d+)?$/.test(row.unitPricePen.trim())) {
      group.totalPen = group.totalPen.plus(
        toDecimal(row.qty.trim()).times(toDecimal(row.unitPricePen.trim())),
      );
    }
  }
  return [...byKey.values()];
}

function DocumentGroup({
  group,
  open,
  customerOptions,
  productOptions,
  documentError,
  disabled,
  onToggle,
  onChange,
  onCreatedCustomer,
  onCreatedProduct,
}: {
  group: DocumentGroup;
  open: boolean;
  customerOptions: readonly SearchSelectOption[];
  productOptions: readonly SearchSelectOption[];
  documentError: string | null;
  disabled: boolean;
  onToggle: () => void;
  onChange: (rowNumber: number, documentKey: string, patch: RowEdit) => void;
  onCreatedCustomer: (customer: CustomerDto) => void;
  onCreatedProduct: (product: ProductDto) => void;
}) {
  const status =
    group.live === 0
      ? { label: 'Sin líneas', variant: 'outline' as const }
      : group.blocking > 0
        ? {
            label:
              group.blocking === 1
                ? '1 línea sin resolver'
                : `${String(group.blocking)} líneas sin resolver`,
            variant: 'destructive' as const,
          }
        : { label: 'Lista', variant: 'secondary' as const };

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/50"
        aria-expanded={open}
        onClick={onToggle}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden className="text-muted-foreground">
            {open ? '▾' : '▸'}
          </span>
          <span className="font-mono font-medium">{group.key}</span>
          <span className="text-sm text-muted-foreground">
            {group.issueDate || 'sin fecha'} · {group.rawCustomer}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm tabular-nums">
            {formatMoney(group.totalPen.toFixed(4))} ·{' '}
            {group.live === 1 ? '1 línea' : `${String(group.live)} líneas`}
          </span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </button>
      {documentError !== null && (
        <p className="px-4 pb-2 text-xs text-destructive">{documentError}</p>
      )}
      {open && (
        <div
          className="overflow-x-auto border-t px-4 pb-3"
          tabIndex={0}
          role="region"
          aria-label={`Líneas de ${group.key}`}
        >
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">Cliente</th>
                <th className="py-2 pr-3 font-medium">Producto</th>
                <th className="py-2 pr-3 text-right font-medium">Cantidad</th>
                <th className="py-2 pr-3 text-right font-medium">P. unit. S/</th>
                <th className="py-2 pr-3 font-medium">Plan de corte</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <ImportRow
                  key={row.raw.rowNumber}
                  row={row}
                  customerOptions={customerOptions}
                  productOptions={productOptions}
                  disabled={disabled}
                  onChange={(patch) => {
                    onChange(row.raw.rowNumber, group.key, patch);
                  }}
                  onCreatedCustomer={onCreatedCustomer}
                  onCreatedProduct={onCreatedProduct}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Una fila
// ---------------------------------------------------------------------------

function ImportRow({
  row,
  customerOptions,
  productOptions,
  disabled,
  onChange,
  onCreatedCustomer,
  onCreatedProduct,
}: {
  row: ResolvedRow;
  customerOptions: readonly SearchSelectOption[];
  productOptions: readonly SearchSelectOption[];
  disabled: boolean;
  onChange: (patch: RowEdit) => void;
  onCreatedCustomer: (customer: CustomerDto) => void;
  onCreatedProduct: (product: ProductDto) => void;
}) {
  const { raw } = row;
  const excluded = raw.excludedReason !== null;

  if (row.removed) {
    return (
      <tr className="border-b text-muted-foreground">
        <td className="py-2 pr-3" colSpan={5}>
          Fila quitada de la importación.
        </td>
        <td className="py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange({ removed: false });
            }}
          >
            Deshacer
          </Button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-b align-top ${excluded ? 'text-muted-foreground' : ''}`}>
      <td className="py-3 pr-3">
        {excluded ? (
          <div className="text-xs">
            <div>{raw.rawCustomer}</div>
            <div className="mt-1 w-56 text-muted-foreground">{raw.excludedReason}</div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SearchSelectField
                label={`Cliente de la fila ${String(raw.rowNumber)}`}
                placeholder="Elige el cliente"
                options={customerOptions}
                value={row.customerId}
                disabled={disabled}
                onChange={(id) => {
                  onChange({ customerId: id });
                }}
              />
              {/*
                D-156: el botón que saca el callejón. Un cliente que no está en el maestro
                ya no obliga a irse de la pantalla y perder el archivo revisado; se da de
                alta acá con el **mismo** formulario, y la fila se rellena sola. Sigue sin
                crearse nada solo (D-152): es un acto explícito de una persona.
              */}
              <ExpressCreateCustomer
                initial={{ name: raw.rawCustomer }}
                disabled={disabled}
                onCreated={(created) => {
                  onCreatedCustomer(created);
                  onChange({ customerId: created.id });
                }}
              />
            </div>
            <div className="mt-1 w-52 text-xs text-muted-foreground">{raw.rawCustomer}</div>
          </>
        )}
        <Issue row={row} field="customer" />
      </td>
      <td className="py-3 pr-3">
        {excluded ? (
          <span className="text-xs">{raw.rawSku}</span>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SearchSelectField
                label={`Producto de la fila ${String(raw.rowNumber)}`}
                placeholder="Elige el producto"
                options={productOptions}
                value={row.productId}
                disabled={disabled}
                onChange={(id) => {
                  onChange({ productId: id });
                }}
              />
              <ExpressCreateProduct
                initial={{ sku: raw.rawSku, name: raw.rawProductName || raw.rawSku }}
                disabled={disabled}
                onCreated={(created) => {
                  onCreatedProduct(created);
                  onChange({ productId: created.id });
                }}
              />
            </div>
            <div className="mt-1 w-52 text-xs text-muted-foreground">
              {raw.rawSku} · {raw.rawUnit}
            </div>
          </>
        )}
        <Issue row={row} field="product" />
      </td>
      <td className="py-3 pr-3 text-right">
        {excluded ? (
          <span className="text-xs">{raw.qty}</span>
        ) : (
          <Input
            aria-label={`Cantidad de la fila ${String(raw.rowNumber)}`}
            inputMode="decimal"
            className="h-9 w-24 text-right text-xs"
            value={row.qty}
            disabled={disabled}
            onChange={(e) => {
              onChange({ qty: e.target.value });
            }}
          />
        )}
        <Issue row={row} field="qty" />
      </td>
      <td className="py-3 pr-3 text-right">
        {excluded ? (
          <span className="text-xs">{raw.unitPricePen}</span>
        ) : (
          <Input
            aria-label={`Precio unitario de la fila ${String(raw.rowNumber)}`}
            inputMode="decimal"
            className="h-9 w-24 text-right text-xs"
            value={row.unitPricePen}
            disabled={disabled}
            onChange={(e) => {
              onChange({ unitPricePen: e.target.value });
            }}
          />
        )}
        {raw.exchangeRate !== null && (
          <div className="mt-1 text-xs text-muted-foreground">
            {raw.currency} · TC {raw.exchangeRate}
          </div>
        )}
        <Issue row={row} field="unitPrice" />
      </td>
      <td className="py-3 pr-3">
        {row.needsPieces ? (
          <>
            <Input
              aria-label={`Plan de corte de la fila ${String(raw.rowNumber)}`}
              className="h-9 w-40 text-xs"
              placeholder="4x20, 1x1.9"
              value={row.planText}
              disabled={disabled}
              onChange={(e) => {
                onChange({ plan: e.target.value });
              }}
            />
            {row.pieces && (
              <div className="mt-1 w-40 text-xs text-muted-foreground">
                {describePieces(row.pieces)} · {piecesMeters(row.pieces).toFixed(3)} m
              </div>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        <Issue row={row} field="pieces" />
        <Issue row={row} field="row" />
      </td>
      <td className="py-3">
        {!excluded && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange({ removed: true });
            }}
          >
            Quitar
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * El maestro con lo recién creado encima, sin duplicar por id. Lo creado gana: es la versión
 * más nueva, y mientras la query no se refresca es la **única** que existe del lado del
 * navegador.
 */
function mergeById<T extends { id: string }>(base: readonly T[], extra: readonly T[]): T[] {
  if (extra.length === 0) return [...base];
  const byId = new Map(base.map((item) => [item.id, item]));
  for (const item of extra) byId.set(item.id, item);
  return [...byId.values()];
}

function Issue({ row, field }: { row: ResolvedRow; field: string }) {
  // Todos los del campo, no el primero: un producto puede faltar **y** traer el aviso de
  // unidad, y esconder uno de los dos deja al usuario resolviendo a ciegas.
  const issues = row.issues.filter((i) => i.field === field);
  return (
    <>
      {issues.map((issue, i) => (
        <p
          key={i}
          className={`mt-1 w-52 text-xs ${issue.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {issue.severity === 'warning' && '⚠ '}
          {issue.message}
        </p>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resolución de una fila con lo que el usuario editó
// ---------------------------------------------------------------------------

interface ResolvedRow {
  raw: QuotationImportRowDto;
  removed: boolean;
  customerId: string | null;
  productId: string | null;
  qty: string;
  unitPricePen: string;
  needsPieces: boolean;
  planText: string;
  pieces: RoofingPieceDto[] | null;
  issues: { field: string; severity: 'error' | 'warning'; message: string }[];
}

/**
 * Reaplica sobre la fila del preview lo que el usuario cambió y **vuelve a validar todo**:
 * los avisos que trajo el servidor se recalculan acá en vez de arrastrarse, porque elegir el
 * cliente que faltaba tiene que apagar su propio error sin ir y volver al API.
 */
function resolveRow(
  raw: QuotationImportRowDto,
  edit: RowEdit,
  productsById: ReadonlyMap<string, ProductDto>,
  customerIds: ReadonlySet<string>,
): ResolvedRow {
  const customerId = edit.customerId ?? raw.customerId;
  const productId = edit.productId ?? raw.productId;
  const qty = edit.qty ?? raw.qty;
  const unitPricePen = edit.unitPricePen ?? raw.unitPricePen;
  const planText = edit.plan ?? (raw.pieces ? formatPlan(raw.pieces) : '');
  // **Con el producto elegido, no con el del archivo.** Quien exige los largos es la unidad
  // (D-131), y cambiar el producto en el desplegable cambia la respuesta: sin recalcular, una
  // fila reasignada a un producto por metro lineal dejaba la celda del plan apagada y el
  // archivo entero moría en el confirm.
  const unit = productId === null ? null : (productsById.get(productId)?.unit ?? raw.productUnit);
  const needsPieces = unit === null ? raw.needsPieces : unit === 'MTR';

  const issues: { field: string; severity: 'error' | 'warning'; message: string }[] = [];
  // Los avisos del servidor que **no** dependen de lo editable se conservan tal cual: el
  // desajuste de unidad es del par archivo↔producto y sigue valiendo mientras el producto sea
  // el mismo.
  for (const issue of raw.issues) {
    if (issue.field === 'product' && productId !== null && productId === raw.productId) {
      issues.push(issue);
    }
  }

  // **Un id que el maestro no ofrece cuenta como faltante.** El preview puede haber mapeado
  // la fila a un cliente o un SKU **desactivado**, que las consultas de esta pantalla
  // filtran: el campo se veía vacío, la fila no marcaba nada, y el archivo entero moría en
  // el confirm con "el cliente está desactivado" —justo el error que desde acá no se puede
  // arreglar—.
  const customersLoaded = customerIds.size > 0;
  const productsLoaded = productsById.size > 0;
  if (!customerId || (customersLoaded && !customerIds.has(customerId))) {
    issues.unshift({
      field: 'customer',
      severity: 'error',
      message: customerId
        ? 'Ese cliente no está entre los activos: elige otro o dalo de alta.'
        : 'Elige el cliente o créalo con el botón de al lado.',
    });
  }
  if (!productId || (productsLoaded && !productsById.has(productId))) {
    issues.unshift({
      field: 'product',
      severity: 'error',
      message: productId
        ? 'Ese producto no está entre los activos: elige otro o dalo de alta.'
        : 'Elige el producto o créalo con el botón de al lado.',
    });
  }
  if (!/^\d+(\.\d{1,3})?$/.test(qty.trim()) || toDecimal(qty.trim() || '0').lte(0)) {
    issues.push({
      field: 'qty',
      severity: 'error',
      message: 'La cantidad va con hasta tres decimales.',
    });
  }
  if (
    !/^\d+(\.\d{1,4})?$/.test(unitPricePen.trim()) ||
    toDecimal(unitPricePen.trim() || '0').lte(0)
  ) {
    issues.push({
      field: 'unitPrice',
      severity: 'error',
      message: 'El precio va con hasta cuatro decimales.',
    });
  }
  if (!raw.issueDate) {
    issues.push({
      field: 'row',
      severity: 'error',
      message: 'La fecha de emisión no se pudo leer del archivo.',
    });
  }

  let pieces: RoofingPieceDto[] | null = null;
  if (needsPieces) {
    const parsed = parsePlan(planText);
    if (!parsed.ok) issues.push({ field: 'pieces', severity: 'error', message: parsed.reason });
    else {
      pieces = parsed.pieces;
      // D-083: con largos, la cantidad de la línea **es** su suma. El API lo rechaza igual;
      // decirlo acá evita mandar 141 filas para que vuelva una.
      const meters = piecesMeters(parsed.pieces);
      if (/^\d+(\.\d{1,3})?$/.test(qty.trim()) && !meters.equals(toDecimal(qty.trim()))) {
        issues.push({
          field: 'pieces',
          severity: 'error',
          message: `Los largos suman ${meters.toFixed(3)} m y la línea dice ${toDecimal(qty.trim()).toFixed(3)} m.`,
        });
      }
    }
  }

  return {
    raw,
    removed: edit.removed === true,
    customerId,
    productId,
    qty,
    unitPricePen,
    needsPieces,
    planText,
    pieces,
    issues,
  };
}

/** `[{4.20 m ×10}]` → `10x4.2`, que es como se vuelve a tipear. */
function formatPlan(pieces: readonly { lengthMm: string; qty: number }[]): string {
  return pieces
    .map((p) => `${String(p.qty)}x${toDecimal(p.lengthMm).div(1000).toFixed(2)}`)
    .join(', ');
}

type PlanParse = { ok: true; pieces: RoofingPieceDto[] } | { ok: false; reason: string };

/**
 * `4x20, 1x1.9` → los largos de la línea.
 *
 * Formato deliberadamente corto: el plan se tipea dentro de una celda de tabla, y un editor
 * de filas como el de `/planta` no entra. `cantidad x largo`, separados por coma.
 */
function parsePlan(text: string): PlanParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'Escribe el plan, por ejemplo 4x20, 1x1.9' };
  const parts = trimmed.split(',');
  // Las mismas cotas que `roofingPiecesSchema`: si no se comprueban acá, el error vuelve como
  // un Zod con path `rows.N.pieces.0.lengthMm`, que la pantalla no sabe atribuir a ninguna fila
  // —el mapa de errores va por comprobante— y el usuario solo ve un toast genérico.
  if (parts.length > MAX_PIECE_LINES) {
    return { ok: false, reason: `Como máximo ${String(MAX_PIECE_LINES)} largos distintos.` };
  }
  const pieces: RoofingPieceDto[] = [];
  const seen = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const match = /^\s*(\d+)\s*[xX*]\s*(\d+(?:\.\d{1,3})?)\s*$/.exec(part);
    if (!match) {
      return { ok: false, reason: `"${part.trim()}" no tiene la forma cantidad x largo.` };
    }
    const qty = Number(match[1]);
    const meters = toDecimal(match[2] ?? '0');
    const lengthMm = meters.times(1000).toFixed(2);
    if (qty < 1) return { ok: false, reason: 'La cantidad de planchas es un entero mayor a cero.' };
    if (qty > MAX_PIECE_QTY) {
      return { ok: false, reason: `Como máximo ${String(MAX_PIECE_QTY)} planchas por largo.` };
    }
    if (meters.times(1000).lt(MIN_PIECE_LENGTH_MM) || meters.times(1000).gt(MAX_PIECE_LENGTH_MM)) {
      return {
        ok: false,
        reason:
          `El largo va entre ${toDecimal(String(MIN_PIECE_LENGTH_MM)).div(1000).toFixed(2)} y ` +
          `${toDecimal(String(MAX_PIECE_LENGTH_MM)).div(1000).toFixed(2)} metros.`,
      };
    }
    if (seen.has(lengthMm)) {
      return { ok: false, reason: 'Ese largo está repetido: súmalo a la cantidad de esa parte.' };
    }
    seen.add(lengthMm);
    pieces.push({ lineNumber: i + 1, lengthMm, qty });
  }
  return { ok: true, pieces };
}
