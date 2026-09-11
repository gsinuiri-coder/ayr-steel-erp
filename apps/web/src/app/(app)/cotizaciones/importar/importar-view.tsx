'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  describePieces,
  piecesMeters,
  suggestedRoofingPlanText,
  MAX_PAGE_SIZE,
  MAX_PIECE_LENGTH_MM,
  MAX_PIECE_LINES,
  MAX_PIECE_QTY,
  MIN_PIECE_LENGTH_MM,
  Role,
  toDecimal,
  Unit,
  type Decimal,
  type CustomerDto,
  type ProductDto,
  type QuotationImportPadronDto,
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
 * Dos reglas que la pantalla no afloja porque el API tampoco: **nada se crea solo sin que una
 * persona lo vea** y **nada se adivina** — cuando el plan de corte sugerido (1 × los ML de la
 * línea) no cabe en una plancha, la fila lo dice y hay que corregirlo antes de importar.
 *
 * **D-156** le sacó el callejón a los campos que exigen elegir de un maestro: el alta está a
 * un botón, con el formulario completo y sin perder el archivo revisado. **D-158** va un paso
 * más: cuando el documento del papel no está en el maestro pero **sí en el padrón**, el
 * comprobante muestra el nombre real que devolvió SUNAT y el cliente se crea al confirmar.
 * Sigue sin ser creación silenciosa —está a la vista, con nombre y documento, antes de
 * apretar— y sigue sin inventarse nada: si el padrón no responde, la fila queda como estaba.
 *
 * **El cliente es del comprobante, no de la línea** (D-158): una factura es de un solo
 * cliente, así que el campo vive en la cabecera del acordeón y sus diez líneas lo heredan.
 * Repetirlo por línea era pedir diez veces el mismo dato y dejar abierta la única forma de
 * armar un documento imposible.
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

/** Lo que el usuario puede cambiar de una **línea** antes de confirmar. */
interface RowEdit {
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
  /**
   * D-158: el cliente elegido a mano **por comprobante**. Lo que no está acá lo resuelve el
   * archivo: el cliente que el preview mapeó, o el que el padrón devolvió para dar de alta.
   */
  const [documentCustomers, setDocumentCustomers] = useState<Record<string, string>>({});
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
      setDocumentCustomers({});
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
      (preview?.rows ?? []).map((row) => resolveRow(row, edits[row.rowNumber] ?? {}, productsById)),
    [preview, edits, productsById],
  );
  // D-158: las filas agrupadas por comprobante, con **su** cliente resuelto en la cabecera.
  const documentGroups = useMemo(
    () => groupByDocument(rows, documentCustomers, customerIds),
    [rows, documentCustomers, customerIds],
  );
  const live = documentGroups.flatMap((g) => g.rows.filter(isLive));
  // Solo los **errores** bloquean: un aviso (la unidad del papel que no coincide con la del
  // producto) hay que verlo, no impide crear la cotización — el API la acepta igual.
  const blockingRows = live.filter((r) => r.issues.some((i) => i.severity === 'error')).length;
  const blockingDocuments = documentGroups.filter(
    (g) => g.live > 0 && g.customerError !== null,
  ).length;
  const blocking = blockingRows + blockingDocuments;
  const documents = documentGroups.filter((g) => g.live > 0);
  const newCustomers = documents.filter((g) => g.customerId === null && g.padron !== null);
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
          (preview?.rows ?? []).map((row) => resolveRow(row, {}, productsById)),
          {},
          customerIds,
        )
          .filter((g) => g.blocking > 0 || g.customerError !== null)
          .map((g) => g.key),
      ),
    // A propósito **sin** `edits` ni `documentCustomers`: es el estado inicial del archivo.
    [preview, productsById, customerIds],
  );

  /** Olvida el rechazo del servidor sobre **este** comprobante, que acaba de cambiar. */
  const clearDocumentError = (documentKey: string) => {
    setDocumentErrors((prev) => {
      if (prev[documentKey] === undefined) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([key]) => key !== documentKey));
    });
  };

  const setEdit = (rowNumber: number, documentKey: string, patch: RowEdit) => {
    setEdits((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], ...patch } }));
    // Solo el de **este** comprobante: corregir una línea de F001-15 no puede borrar el
    // motivo por el que el servidor rechazó F001-22, que sigue sin corregirse.
    clearDocumentError(documentKey);
  };

  const setDocumentCustomer = (documentKey: string, customerId: string) => {
    setDocumentCustomers((prev) => ({ ...prev, [documentKey]: customerId }));
    clearDocumentError(documentKey);
  };

  const confirm = useMutation({
    onMutate: () => {
      setDocumentErrors({});
    },
    mutationFn: () =>
      api<QuotationImportResultDto>('/imports/quotations', {
        method: 'POST',
        body: {
          rows: documents.flatMap((group) =>
            group.rows.filter(isLive).map((r) => ({
              rowNumber: r.raw.rowNumber,
              documentKey: group.key,
              issueDate: r.raw.issueDate,
              // D-158: el cliente es del comprobante. Y cuando no hay ninguno en el maestro,
              // viaja **el documento y nada más**: el nombre lo pone el padrón del lado del
              // servidor, para que nadie pueda dar de alta una razón social inventada.
              customerId: group.customerId,
              ...(group.customerId === null && group.padron
                ? {
                    newCustomer: {
                      docType: group.padron.docType,
                      docNumber: group.padron.docNumber,
                    },
                  }
                : {}),
              productId: r.productId,
              qty: r.qty,
              unitPricePen: r.unitPricePen,
              // D-169: el importe del papel viaja **solo mientras siga siendo el del papel**.
              // Si alguien corrigió la cantidad o el precio de esta fila, el importe del
              // archivo dejó de describirla: mandarlo haría que la corrección no cambiara el
              // importe, y el rechazo por tolerancia culparía al Excel de una diferencia que
              // introdujo la corrección.
              ...(r.netAmountPen ? { netAmountPen: r.netAmountPen } : {}),
              ...(r.raw.rawProductName ? { description: r.raw.rawProductName } : {}),
              ...(r.pieces ? { pieces: r.pieces } : {}),
            })),
          ),
        },
      }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setEdits({});
      setDocumentCustomers({});
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
            <h1 className="text-lg font-semibold">Importar cotizaciones</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Sube el export de ventas detalladas y revisa cada comprobante antes de crear nada.
              Cada uno se convierte en una <strong>cotización en borrador</strong> sin fecha de
              vencimiento, con su número anotado en las observaciones; de ahí en adelante el camino
              es el normal: emitir, confirmar, producir y vender.
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/cotizaciones">Volver a cotizaciones</Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. El archivo</CardTitle>
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
              {result.createdCustomers.length > 0 && (
                <>
                  {' '}
                  Y se dieron de alta {result.createdCustomers.length} clientes desde el padrón:{' '}
                  {result.createdCustomers.join(', ')}.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        {upload.isPending && <Skeleton className="h-64 w-full" />}

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle>
                2. Revisar y corregir{' '}
                <span className="text-sm font-normal text-muted-foreground">
                  ({String(live.length)} líneas · {String(documents.length)} cotizaciones ·{' '}
                  {String(preview.excluded)} excluidas)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {customers.data?.truncated === true && (
                <Alert>
                  <AlertDescription>
                    El maestro de clientes tiene más de {MAX_CUSTOMER_PAGES * MAX_PAGE_SIZE} activos
                    y el desplegable no los trae a todos. Si el cliente de una fila no aparece,
                    resolvelo desde el maestro y volvé a subir el archivo.
                  </AlertDescription>
                </Alert>
              )}
              {newCustomers.length > 0 && (
                <Alert>
                  <AlertDescription>
                    {newCustomers.length === 1
                      ? 'Un comprobante trae un cliente que no está en el maestro y sí en el padrón: se dará de alta al importar, con la razón social que devolvió SUNAT.'
                      : `${String(newCustomers.length)} comprobantes traen clientes que no están en el maestro y sí en el padrón: se darán de alta al importar, con la razón social que devolvió SUNAT.`}{' '}
                    Si preferís otro, elegilo en la cabecera del comprobante.
                  </AlertDescription>
                </Alert>
              )}
              {blocking > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {blocking === 1
                      ? 'Un comprobante tiene algo sin resolver'
                      : `${String(blocking)} cosas quedan sin resolver`}
                    . Corrígelas o quita la línea: un cliente o un producto que falta se crea con el
                    botón de al lado, sin salir de acá.
                  </AlertDescription>
                </Alert>
              )}
              {Object.keys(documentErrors).length > 0 && (
                <Alert variant="destructive">
                  <AlertDescription>
                    No se importó nada. {Object.keys(documentErrors).length} comprobantes fueron
                    rechazados por el servidor; el motivo está en su cabecera.
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
                  <DocumentGroupCard
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
                    onCustomer={(id) => {
                      setDocumentCustomer(group.key, id);
                    }}
                    onChange={setEdit}
                    onCreatedCustomer={(created) => {
                      setCreatedCustomers((prev) => [...prev, created]);
                      setDocumentCustomer(group.key, created.id);
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
                  : `Se crearán ${String(documents.length)} cotizaciones en borrador con ${String(live.length)} líneas` +
                    (newCustomers.length === 0
                      ? '.'
                      : `, y ${String(newCustomers.length)} clientes nuevos desde el padrón.`)}
              </p>
              <Button
                className="h-12"
                disabled={live.length === 0 || blocking > 0 || confirm.isPending}
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
// D-156 / D-158 — un comprobante del archivo, con su cliente y sus líneas
// ---------------------------------------------------------------------------

interface DocumentGroup {
  key: string;
  issueDate: string;
  /** El cliente tal como vino en el papel: la cabecera lo dice aunque falte el mapeo. */
  rawCustomer: string;
  /** `true` cuando las líneas del comprobante no traen todas el mismo cliente en el papel. */
  mixedRawCustomer: boolean;
  /** Cliente del maestro con el que se creará la cotización. `null` = se crea del padrón. */
  customerId: string | null;
  /** D-158: lo que el padrón devolvió, cuando no hay cliente en el maestro. */
  padron: QuotationImportPadronDto | null;
  /** Qué le falta al cliente del comprobante. `null` cuando está resuelto. */
  customerError: string | null;
  /** `Σ cantidad × precio` de las líneas vivas, en soles. */
  totalPen: Decimal;
  rows: ResolvedRow[];
  /** Líneas vivas del comprobante y cuántas tienen algo sin resolver. */
  live: number;
  blocking: number;
}

/** Una línea que sí se va a importar: ni quitada a mano ni excluida por el archivo. */
function isLive(row: ResolvedRow): boolean {
  return !row.removed && row.raw.excludedReason === null;
}

/**
 * Agrupa por `documentKey` conservando el orden del archivo y **resuelve el cliente del
 * comprobante** (D-158). La clave del agrupado es la misma que usa el mapa de errores del
 * servidor —el comprobante, no la fila—, así que un rechazo del confirm cae sobre la cabecera
 * correcta sin traducir nada.
 */
function groupByDocument(
  rows: readonly ResolvedRow[],
  chosen: Readonly<Record<string, string>>,
  customerIds: ReadonlySet<string>,
): DocumentGroup[] {
  const byKey = new Map<string, DocumentGroup>();
  for (const row of rows) {
    const key = row.raw.documentKey;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        issueDate: row.raw.issueDate,
        rawCustomer: row.raw.rawCustomer,
        mixedRawCustomer: false,
        customerId: null,
        // Se llena abajo, y **solo desde una línea viva**: el `padron` de una fila excluida
        // daría de alta un cliente para un comprobante que no se importa.
        padron: null,
        customerError: null,
        totalPen: toDecimal('0'),
        rows: [],
        live: 0,
        blocking: 0,
      };
      byKey.set(key, group);
    }
    group.rows.push(row);
    // **Solo las líneas vivas deciden el cliente.** Antes se miraba toda fila del
    // comprobante, así que una nota de crédito excluida por el archivo —o una que el usuario
    // acababa de quitar— podía imponerle su cliente a las líneas que sí se importan, y el
    // aviso de "más de un cliente" comparaba textos de filas que no iban a entrar.
    if (!isLive(row)) continue;
    // El cliente del comprobante sale de la **primera** línea viva que lo trae mapeado; que
    // las demás traigan otro texto es un aviso, no una segunda cotización.
    if (group.customerId === null && row.raw.customerId !== null) {
      group.customerId = row.raw.customerId;
    }
    if (group.padron === null && row.raw.padron !== null) group.padron = row.raw.padron;
    if (row.raw.rawCustomer !== group.rawCustomer) group.mixedRawCustomer = true;
    group.live += 1;
    if (row.issues.some((i) => i.severity === 'error')) group.blocking += 1;
    // D-169: el total de la cabecera es **el que se va a crear**, y por eso suma el importe
    // del papel cuando la fila todavía responde a él. Sumar `cantidad × precio` sobre una
    // fila cuyo importe se copia dejaba la cabecera diciendo unos céntimos menos que la
    // cotización resultante, justo en el número que se compara contra el comprobante.
    if (row.netAmountPen !== null) {
      group.totalPen = group.totalPen.plus(toDecimal(row.netAmountPen));
      continue;
    }
    // Un importe con el precio o la cantidad mal tipeados no se suma: el total de la
    // cabecera diría un número inventado justo cuando hay que compararlo con el papel.
    if (/^\d+(\.\d+)?$/.test(row.qty.trim()) && /^\d+(\.\d+)?$/.test(row.unitPricePen.trim())) {
      group.totalPen = group.totalPen.plus(
        toDecimal(row.qty.trim()).times(toDecimal(row.unitPricePen.trim())),
      );
    }
  }

  const customersLoaded = customerIds.size > 0;
  for (const group of byKey.values()) {
    // Lo elegido a mano gana sobre lo que el archivo resolvió, y sobre el padrón: elegir un
    // cliente del maestro es decir "ese, no el nuevo".
    const picked = chosen[group.key];
    if (picked !== undefined && picked !== '') {
      group.customerId = picked;
      group.padron = null;
    }
    // **Un id que el maestro no ofrece cuenta como faltante.** El preview puede haber mapeado
    // el comprobante a un cliente **desactivado**, que las consultas de esta pantalla filtran:
    // el campo se veía vacío, nada se marcaba, y el archivo entero moría en el confirm con "el
    // cliente está desactivado" —justo el error que desde acá no se puede arreglar—.
    if (group.customerId !== null && customersLoaded && !customerIds.has(group.customerId)) {
      group.customerError = 'Ese cliente no está entre los activos: elige otro o dalo de alta.';
      group.customerId = null;
    } else if (group.customerId === null && group.padron === null) {
      group.customerError = 'Elige el cliente del comprobante o créalo con el botón de al lado.';
    }
  }
  return [...byKey.values()];
}

function DocumentGroupCard({
  group,
  open,
  customerOptions,
  productOptions,
  documentError,
  disabled,
  onToggle,
  onCustomer,
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
  onCustomer: (customerId: string) => void;
  onChange: (rowNumber: number, documentKey: string, patch: RowEdit) => void;
  onCreatedCustomer: (customer: CustomerDto) => void;
  onCreatedProduct: (product: ProductDto) => void;
}) {
  const status =
    group.live === 0
      ? { label: 'Sin líneas', variant: 'outline' as const }
      : group.blocking > 0 || group.customerError !== null
        ? {
            label:
              group.customerError !== null && group.blocking === 0
                ? 'Sin cliente'
                : group.blocking === 1
                  ? '1 línea sin resolver'
                  : `${String(group.blocking)} líneas sin resolver`,
            variant: 'destructive' as const,
          }
        : { label: 'Lista', variant: 'secondary' as const };

  return (
    <div className="rounded-lg border">
      {/*
        La cabecera **no** es un botón entero: adentro va el campo de cliente, y un `<select>`
        o un diálogo dentro de un `<button>` no es HTML válido ni se puede operar. El botón es
        solo el disparador de la izquierda, que es también lo único que abre y cierra.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          className="flex flex-1 flex-wrap items-center gap-3 rounded text-left hover:opacity-80"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span aria-hidden className="text-muted-foreground">
            {open ? '▾' : '▸'}
          </span>
          <span className="font-mono font-medium">{group.key}</span>
          <span className="text-sm text-muted-foreground">
            {group.issueDate || 'sin fecha'} · {group.rawCustomer}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm tabular-nums">
            {formatMoney(group.totalPen.toFixed(4))} ·{' '}
            {group.live === 1 ? '1 línea' : `${String(group.live)} líneas`}
          </span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </div>

      {/*
        D-158: **el cliente del comprobante**, una sola vez. Una factura es de un solo
        cliente y sus diez líneas lo heredan; pedirlo por línea era repetir el mismo dato diez
        veces y dejar abierta la única forma de armar un documento que el API no acepta.
      */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
        <span className="text-xs uppercase text-muted-foreground">Cliente</span>
        <SearchSelectField
          label={`Cliente de ${group.key}`}
          placeholder={group.padron === null ? 'Elige el cliente' : 'Se creará desde el padrón'}
          options={customerOptions}
          value={group.customerId}
          disabled={disabled}
          onChange={onCustomer}
        />
        <ExpressCreateCustomer
          initial={{
            docNumber: group.padron?.docNumber ?? docNumberOf(group.rawCustomer),
            name: group.padron?.name ?? nameOf(group.rawCustomer),
          }}
          disabled={disabled}
          onCreated={onCreatedCustomer}
        />
        {group.customerId === null && group.padron !== null && (
          <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-500">
            Nuevo — se creará desde padrón: {group.padron.name}
          </Badge>
        )}
        {group.customerError !== null && (
          <span className="text-xs text-destructive">{group.customerError}</span>
        )}
        {group.mixedRawCustomer && (
          <span className="text-xs text-muted-foreground">
            ⚠ El archivo trae más de un cliente en este comprobante: se importa con el de arriba.
          </span>
        )}
      </div>

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
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">Producto</th>
                <th className="py-2 pr-3 text-right font-medium">Cantidad</th>
                <th className="py-2 pr-3 text-right font-medium">Valor unit. S/</th>
                <th className="py-2 pr-3 font-medium">Plan de corte</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <ImportRow
                  key={row.raw.rowNumber}
                  row={row}
                  productOptions={productOptions}
                  disabled={disabled}
                  onChange={(patch) => {
                    onChange(row.raw.rowNumber, group.key, patch);
                  }}
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

/** `20606364335 - RAZÓN SOCIAL S.A.C.` → `20606364335`. Vacío cuando el papel no lo trae. */
function docNumberOf(rawCustomer: string): string | undefined {
  return /^(\d{8,11})\s*-/.exec(rawCustomer.trim())?.[1];
}

/** `20606364335 - RAZÓN SOCIAL S.A.C.` → `RAZÓN SOCIAL S.A.C.`. */
function nameOf(rawCustomer: string): string {
  const cut = rawCustomer.indexOf('-');
  return cut === -1 ? rawCustomer.trim() : rawCustomer.slice(cut + 1).trim();
}

// ---------------------------------------------------------------------------
// Una línea
// ---------------------------------------------------------------------------

function ImportRow({
  row,
  productOptions,
  disabled,
  onChange,
  onCreatedProduct,
}: {
  row: ResolvedRow;
  productOptions: readonly SearchSelectOption[];
  disabled: boolean;
  onChange: (patch: RowEdit) => void;
  onCreatedProduct: (product: ProductDto) => void;
}) {
  const { raw } = row;
  const excluded = raw.excludedReason !== null;

  if (row.removed) {
    return (
      <tr className="border-b text-muted-foreground">
        <td className="py-2 pr-3" colSpan={4}>
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
            <div>{raw.rawSku}</div>
            <div className="mt-1 w-56 text-muted-foreground">{raw.excludedReason}</div>
          </div>
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
        {/*
          D-169: el importe con el que la línea se va a crear, y de dónde sale. Se muestra
          siempre y no solo cuando difiere: el punto de la decisión es que el vendedor sepa
          que el número del papel se copia, y una etiqueta que aparece nada más cuando hay
          diferencia no enseña la regla, solo el caso raro.
        */}
        <div className="mt-1 text-xs text-muted-foreground">
          {row.netAmountPen !== null
            ? `Importe del archivo: ${formatMoney(row.netAmountPen, 'PEN', 2)}`
            : 'Importe recalculado: cantidad × precio'}
        </div>
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
  productId: string | null;
  qty: string;
  unitPricePen: string;
  /**
   * D-169: el importe del papel, o `null` cuando esta fila dejó de responder a él porque
   * alguien editó su cantidad o su precio. Es la señal que decide si el API copia el importe
   * o lo recalcula.
   */
  netAmountPen: string | null;
  needsPieces: boolean;
  planText: string;
  pieces: RoofingPieceDto[] | null;
  issues: { field: string; severity: 'error' | 'warning'; message: string }[];
}

/**
 * Reaplica sobre la fila del preview lo que el usuario cambió y **vuelve a validar todo**:
 * los avisos que trajo el servidor se recalculan acá en vez de arrastrarse, porque elegir el
 * producto que faltaba tiene que apagar su propio error sin ir y volver al API.
 *
 * El cliente ya no se resuelve acá: es del comprobante (D-158) y lo decide `groupByDocument`.
 */
function resolveRow(
  raw: QuotationImportRowDto,
  edit: RowEdit,
  productsById: ReadonlyMap<string, ProductDto>,
): ResolvedRow {
  const productId = edit.productId ?? raw.productId;
  const qty = edit.qty ?? raw.qty;
  const unitPricePen = edit.unitPricePen ?? raw.unitPricePen;
  // **Con el producto elegido, no con el del archivo.** Quien exige los largos es la unidad
  // (D-131), y cambiar el producto en el desplegable cambia la respuesta: sin recalcular, una
  // fila reasignada a un producto por metro lineal dejaba la celda del plan apagada y el
  // archivo entero moría en el confirm.
  const unit = productId === null ? null : (productsById.get(productId)?.unit ?? raw.productUnit);
  const needsPieces = unit === null ? raw.needsPieces : unit === Unit.MTR;
  /**
   * El plan **llega relleno**: el que el preview resolvió, o la sugerencia `1 × los ML de la
   * línea` cuando el archivo no traía ninguno posible. La sugerencia no siempre es válida
   * —una línea de 1 832 m no cabe en una plancha de 20— y en ese caso la celda muestra el
   * error de siempre; lo que cambia es que corregirla sea editar un número y no transcribir
   * la cifra del papel a mano. **La regla de D-152 sigue viva**: el importador no reparte
   * esos metros en planchas por su cuenta.
   *
   * La cantidad se comprueba **antes** de derivar nada: `toDecimal` lanza con lo que no es un
   * número, y acá se ejecuta dentro del `useMemo` que arma las 141 filas. Una coma del
   * teclado latino tipeada en una cantidad tumbaba la pantalla entera y se llevaba el archivo
   * revisado — el callejón exacto que D-156 vino a sacar, reaparecido por otra puerta.
   */
  const planText =
    edit.plan ??
    (raw.pieces
      ? formatPlan(raw.pieces)
      : isNumeric(qty)
        ? suggestedRoofingPlanText(qty.trim())
        : '');

  const issues: { field: string; severity: 'error' | 'warning'; message: string }[] = [];
  // Los avisos del servidor que **no** dependen de lo editable se conservan tal cual: el
  // desajuste de unidad es del par archivo↔producto y sigue valiendo mientras el producto sea
  // el mismo.
  for (const issue of raw.issues) {
    if (issue.field === 'product' && productId !== null && productId === raw.productId) {
      issues.push(issue);
    }
  }

  const productsLoaded = productsById.size > 0;
  if (!productId || (productsLoaded && !productsById.has(productId))) {
    issues.unshift({
      field: 'product',
      severity: 'error',
      message: productId
        ? 'Ese producto no está entre los activos: elige otro o dalo de alta.'
        : 'Elige el producto o créalo con el botón de al lado.',
    });
  }
  if (!isNumeric(qty) || toDecimal(qty.trim()).lte(0)) {
    issues.push({
      field: 'qty',
      severity: 'error',
      message: 'La cantidad va con hasta tres decimales.',
    });
  }
  // Mismo motivo que la cantidad: el patrón corta **antes** de que `toDecimal` vea la coma.
  if (!/^\d+(\.\d{1,4})?$/.test(unitPricePen.trim()) || toDecimal(unitPricePen.trim()).lte(0)) {
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
      if (isNumeric(qty) && !meters.equals(toDecimal(qty.trim()))) {
        issues.push({
          field: 'pieces',
          severity: 'error',
          message: `Los largos suman ${meters.toFixed(3)} m y la línea dice ${toDecimal(qty.trim()).toFixed(3)} m.`,
        });
      }
    }
  }

  // D-169: el importe del archivo sigue valiendo mientras la cantidad y el precio sean los que
  // el archivo trajo. Se compara contra `raw` y no contra un flag propio: `edit.qty` puede
  // existir con el mismo valor —abrir el campo y volver a escribir lo mismo— y eso no cambia
  // nada del papel.
  const untouched = qty === raw.qty && unitPricePen === raw.unitPricePen;

  return {
    raw,
    removed: edit.removed === true,
    productId,
    qty,
    unitPricePen,
    netAmountPen: untouched && raw.netAmountPen ? raw.netAmountPen : null,
    needsPieces,
    planText,
    pieces,
    issues,
  };
}

/**
 * La cantidad, tal como el API la acepta: hasta tres decimales y **con punto**.
 *
 * Está en una función porque es la guarda de todo lo que después llama a `toDecimal`, que
 * **lanza** con cualquier otra cosa —una coma del teclado latino, un `4.` a medio tipear— y
 * corre dentro del `useMemo` que arma las 141 filas: una excepción ahí no marca una celda en
 * rojo, tumba la pantalla y se lleva el archivo revisado.
 */
function isNumeric(value: string): boolean {
  return /^\d+(\.\d{1,3})?$/.test(value.trim());
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
          `${toDecimal(String(MAX_PIECE_LENGTH_MM)).div(1000).toFixed(2)} metros: reparte la línea ` +
          'en las planchas que de verdad se cortaron.',
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
