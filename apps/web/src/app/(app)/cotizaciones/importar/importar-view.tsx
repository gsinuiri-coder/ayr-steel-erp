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
  type CustomerDto,
  type ProductDto,
  type QuotationImportPreviewDto,
  type QuotationImportResultDto,
  type QuotationImportRowDto,
  type RoofingPieceDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
 * o un SKU que no está en el maestro detiene su fila y hay que darlo de alta por su formulario—
 * y **nada se adivina**: cuando el plan de corte por defecto (1 × los ML de la línea) no cabe
 * en una plancha, la fila pide el plan real en vez de repartirlo por su cuenta.
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
      setResult(null);
      toast.success(`${String(data.rows.length)} filas leídas`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'No se pudo leer el archivo');
    },
  });

  const productsById = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.id, p])),
    [products.data],
  );
  const rows = useMemo(
    () =>
      (preview?.rows ?? []).map((row) => resolveRow(row, edits[row.rowNumber] ?? {}, productsById)),
    [preview, edits, productsById],
  );
  const live = rows.filter((r) => !r.removed && r.raw.excludedReason === null);
  // Solo los **errores** bloquean: un aviso (la unidad del papel que no coincide con la del
  // producto) hay que verlo, no impide crear la cotización — el API la acepta igual.
  const blocking = live.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const documents = new Set(live.map((r) => r.raw.documentKey));

  const setEdit = (rowNumber: number, patch: RowEdit) => {
    setEdits((prev) => ({ ...prev, [rowNumber]: { ...prev[rowNumber], ...patch } }));
    setDocumentErrors({});
  };

  const confirm = useMutation({
    mutationFn: () => {
      setDocumentErrors({});
      return api<QuotationImportResultDto>('/imports/quotations', {
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
      });
    },
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

              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="Líneas del archivo"
              >
                <table className="w-full min-w-[70rem] text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-3 font-medium">Comprobante</th>
                      <th className="py-2 pr-3 font-medium">Cliente</th>
                      <th className="py-2 pr-3 font-medium">Producto</th>
                      <th className="py-2 pr-3 text-right font-medium">Cantidad</th>
                      <th className="py-2 pr-3 text-right font-medium">P. unit. S/</th>
                      <th className="py-2 pr-3 font-medium">Plan de corte</th>
                      <th className="py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <ImportRow
                        key={row.raw.rowNumber}
                        row={row}
                        customers={customers.data?.items ?? []}
                        products={products.data ?? []}
                        documentError={documentErrors[row.raw.documentKey] ?? null}
                        disabled={confirm.isPending}
                        onChange={(patch) => {
                          setEdit(row.raw.rowNumber, patch);
                        }}
                      />
                    ))}
                  </tbody>
                </table>
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
// Una fila
// ---------------------------------------------------------------------------

function ImportRow({
  row,
  customers,
  products,
  documentError,
  disabled,
  onChange,
}: {
  row: ResolvedRow;
  customers: readonly CustomerDto[];
  products: readonly ProductDto[];
  documentError: string | null;
  disabled: boolean;
  onChange: (patch: RowEdit) => void;
}) {
  const { raw } = row;
  const excluded = raw.excludedReason !== null;

  if (row.removed) {
    return (
      <tr className="border-b text-muted-foreground">
        <td className="py-2 pr-3 font-mono">{raw.documentKey}</td>
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
        <div className="font-mono">{raw.documentKey}</div>
        <div className="text-xs text-muted-foreground">{raw.issueDate || 'sin fecha'}</div>
        {excluded && (
          <div className="mt-1 w-56 text-xs text-muted-foreground">{raw.excludedReason}</div>
        )}
        {documentError !== null && (
          <div className="mt-1 w-56 text-xs text-destructive">{documentError}</div>
        )}
      </td>
      <td className="py-3 pr-3">
        {excluded ? (
          <span className="text-xs">{raw.rawCustomer}</span>
        ) : (
          <>
            <select
              aria-label={`Cliente de la fila ${String(raw.rowNumber)}`}
              className="h-9 w-52 rounded-md border bg-background px-2 text-xs"
              value={row.customerId ?? ''}
              disabled={disabled}
              onChange={(e) => {
                onChange({ customerId: e.target.value });
              }}
            >
              <option value="">Elige el cliente</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.docNumber} — {c.name}
                </option>
              ))}
            </select>
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
            <select
              aria-label={`Producto de la fila ${String(raw.rowNumber)}`}
              className="h-9 w-52 rounded-md border bg-background px-2 text-xs"
              value={row.productId ?? ''}
              disabled={disabled}
              onChange={(e) => {
                onChange({ productId: e.target.value });
              }}
            >
              <option value="">Elige el producto</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
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

  if (!customerId) {
    issues.unshift({
      field: 'customer',
      severity: 'error',
      message: 'Elige el cliente: no se crea ninguno desde el importador.',
    });
  }
  if (!productId) {
    issues.unshift({
      field: 'product',
      severity: 'error',
      message: 'Elige el producto: no se crea ninguno desde el importador.',
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
        reason: `El largo va entre ${String(MIN_PIECE_LENGTH_MM / 1000)} y ${String(MAX_PIECE_LENGTH_MM / 1000)} metros.`,
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
