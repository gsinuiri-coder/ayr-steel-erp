'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  COIL_ADJUST_DATE_LABELS,
  COIL_ADJUST_DATES,
  COIL_BUSINESS_LINES,
  COIL_IMPORT_MODE_LABELS,
  COIL_IMPORT_MODES,
  CoilAdjustDate,
  CoilImportMode,
  fiscalDocumentNumber,
  IMPORT_ENTITY_LABELS,
  IMPORT_FULFILLMENT_LABELS,
  IMPORT_FULFILLMENTS,
  ImportEntity,
  ImportFulfillment,
  type BusinessLine,
  type CoilImportCheckDto,
  type ColorDto,
  type FinishDto,
  type ImportBatchWithRowsDto,
  type ImportOptions,
  type ImportRowDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { IMPORT_COLUMNS } from './import-columns';

/**
 * Entidades cuya planilla trae **varias filas por entidad** (RF-71, D-107). Son las únicas
 * que necesitan releer el lote entero al corregir una fila: en las demás, una fila es una
 * entidad y su veredicto no depende de ninguna otra.
 */
const GROUPED_ENTITIES: ImportEntity[] = [
  ImportEntity.FISCAL_DOCUMENTS,
  ImportEntity.SALES_HISTORY,
];

/**
 * D-137: entidades cuyo archivo no trae todo lo que hace falta y hay que elegirlo antes de
 * subirlo. Hoy es solo la carga histórica de bobinas: el Excel no dice de qué línea de
 * negocio son ni qué hacer con la diferencia entre el peso de compra y el stock de hoy.
 */
const ENTITIES_WITH_OPTIONS: ImportEntity[] = [ImportEntity.COILS_HISTORY];

/**
 * D-141: entidades cuyo grupo se decide **entero** con un toggle. Hoy solo la carga de
 * ventas: cada comprobante crea un pedido, y si ese pedido es una cáscara o uno vivo con
 * reserva y orden de producción es una decisión del documento, no de sus líneas.
 */
const ENTITIES_WITH_FULFILLMENT: ImportEntity[] = [ImportEntity.SALES_HISTORY];

/**
 * La clave de grupo tal como la calcula el adaptador del API (`F001-00000123`). Se recalcula
 * acá con la misma función de `@ayr/shared` en vez de mandarla en la fila: son los mismos
 * dos campos ya normalizados y duplicar el formato habría sido una segunda verdad sobre
 * cómo se escribe un número de comprobante.
 */
function groupKeyOf(row: ImportRowDto): string | null {
  const series = row.data.series;
  const correlative = row.data.correlative;
  if (typeof series !== 'string' || series === '') return null;
  if (typeof correlative !== 'number') return null;
  return fiscalDocumentNumber(series, correlative);
}

/** Las filas del lote partidas en documentos, en el orden en que vienen. */
function toGroups(rows: ImportRowDto[]): { key: string | null; rows: ImportRowDto[] }[] {
  const groups: { key: string | null; rows: ImportRowDto[] }[] = [];
  for (const row of rows) {
    const key = groupKeyOf(row);
    const last = groups[groups.length - 1];
    // Una fila sin clave (le falta el número) no pertenece a ningún documento y va sola:
    // agruparla con la anterior habría dejado el toggle de un comprobante mandando sobre
    // una línea que no es suya.
    if (key !== null && last?.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

/**
 * D-137: columnas que se corrigen eligiendo de un maestro y no tipeando. Un acabado
 * tecleado a mano vuelve a fallar por un espacio de más; un desplegable no puede.
 */
const MASTER_COLUMNS: Record<string, 'finish' | 'color'> = {
  finishCode: 'finish',
  colorCode: 'color',
};

async function uploadImport(
  entity: ImportEntity,
  file: File,
  options: ImportOptions | undefined,
): Promise<ImportBatchWithRowsDto> {
  const form = new FormData();
  form.append('entity', entity);
  if (options) form.append('options', JSON.stringify(options));
  form.append('file', file);
  const res = await fetch('/api/imports', { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(res.status, body.message ?? `Error ${res.status}`);
  }
  return (await res.json()) as ImportBatchWithRowsDto;
}

interface Props {
  entity: ImportEntity;
  /** Query key que se invalida cuando la importación termina de confirmarse. */
  invalidateQueryKey: QueryKey;
  /**
   * Texto del botón. Por defecto "Importar"; se cambia cuando hay **dos** importadores en
   * la misma pantalla (el canónico y el del Excel del negocio, D-137/D-138) y "Importar" a
   * secas no dice cuál es cuál.
   */
  label?: string;
}

export function ImportDialog({ entity, invalidateQueryKey, label = 'Importar' }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState<ImportBatchWithRowsDto | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const columns = IMPORT_COLUMNS[entity];
  const grouped = GROUPED_ENTITIES.includes(entity);
  const needsOptions = ENTITIES_WITH_OPTIONS.includes(entity);
  const hasFulfillment = ENTITIES_WITH_FULFILLMENT.includes(entity);
  // Sin línea preseleccionada, a propósito. El adaptador la exige, pero esa red nunca se
  // dispararía si el web mandara siempre algo: un import distraído crearía el archivo
  // entero de bobinas en la línea equivocada, con movimientos de kardex append-only que no
  // se borran (regla dura 2). Elegirla es una decisión, no un default.
  const [options, setOptions] = useState<ImportOptions>({
    businessLine: undefined,
    mode: CoilImportMode.REPLAY,
    adjustDate: CoilAdjustDate.PURCHASE_DATE,
  });
  const optionsReady = !needsOptions || options.businessLine !== undefined;

  // Los maestros con los que se corrige un acabado o un color que no mapeó. Solo se piden
  // cuando la entidad los usa: el catálogo de clientes no tiene nada que hacer con ellos.
  const finishes = useQuery({
    queryKey: ['finishes'],
    queryFn: () => api<FinishDto[]>('/finishes'),
    enabled: open && entity === ImportEntity.COILS_HISTORY,
  });
  const colors = useQuery({
    queryKey: ['colors'],
    queryFn: () => api<ColorDto[]>('/colors'),
    enabled: open && entity === ImportEntity.COILS_HISTORY,
  });
  // El valor ya elegido se ofrece siempre, aunque esté desactivado: si no, el `Select`
  // aparece vacío y parece que nadie eligió nada. Mismo criterio que `bom-dialog` y
  // `product-dialog`.
  const chosen = new Set(
    (batch?.rows ?? []).flatMap((r) => {
      return [r.data.finishCode, r.data.colorCode].filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
    }),
  );
  const masterOptions = {
    finish: (finishes.data ?? [])
      .filter((f) => f.isActive || chosen.has(f.code))
      .map((f) => ({
        value: f.code,
        label: `${f.code} — ${f.name}${f.isActive ? '' : ' (desactivado)'}`,
      })),
    color: (colors.data ?? [])
      .filter((c) => c.isActive || chosen.has(c.code))
      .map((c) => ({
        value: c.code,
        label: `${c.code} — ${c.name}${c.isActive ? '' : ' (desactivado)'}`,
      })),
  };
  // En una entidad agrupada una fila es una **línea**, no un comprobante: decir "filas" no
  // es falso pero cuenta en una unidad que el usuario no usa.
  const unit = grouped ? 'líneas' : 'filas';
  /**
   * Número de la última edición lanzada. Dos `blur` seguidos dejan dos peticiones en vuelo
   * y la primera puede contestar última: sin este contador, su respuesta —con los errores
   * de antes de la segunda corrección— pisaba a la buena, y el usuario decidía confirmar
   * mirando información caducada.
   */
  const editSeq = useRef(new Map<string, number>());

  const upload = useMutation({
    mutationFn: (file: File) => uploadImport(entity, file, needsOptions ? options : undefined),
    onSuccess: (data) => {
      setBatch(data);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo subir el archivo');
    },
  });

  const updateRow = useMutation({
    mutationFn: async ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) => {
      // Una secuencia **por fila**: con un contador único, corregir el acabado de varias
      // filas seguidas descartaba toda respuesta salvo la última, y esas filas quedaban
      // pintadas como inválidas aunque el servidor ya las hubiera validado.
      const seq = (editSeq.current.get(rowId) ?? 0) + 1;
      editSeq.current.set(rowId, seq);
      const batchId = batch?.id;
      const row = await api<ImportRowDto>(`/imports/${batchId}/rows/${rowId}`, {
        method: 'PATCH',
        body: { data },
      });
      // Solo la importación agrupada necesita releer el lote: ahí (RF-71) corregir una línea
      // cambia si el **comprobante** cuadra, y esa respuesta está en las otras filas del
      // grupo, que el PATCH no devuelve. En catálogo o clientes, releer 2000 filas por cada
      // celda que pierde el foco sería pagar un viaje entero para no enterarse de nada.
      const full = grouped ? await api<ImportBatchWithRowsDto>(`/imports/${batchId}`) : null;
      return { seq, rowId, batchId, row, full };
    },
    onSuccess: ({ seq, rowId, batchId, row, full }) => {
      // Descarta lo que llegó tarde y lo que ya no corresponde: el lote pudo cancelarse
      // (`reset()`) mientras la petición volaba, y aplicarlo resucitaba un preview cerrado
      // con su botón de confirmar activo — confirmando un archivo que el usuario descartó.
      if (seq !== editSeq.current.get(rowId)) return;
      setBatch((b) => {
        if (!b || b.id !== batchId || b.status === 'CONFIRMED') return b;
        if (full) return full;
        return { ...b, rows: b.rows.map((r) => (r.id === row.id ? row : r)) };
      });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo validar la fila');
    },
  });

  /**
   * D-141: el toggle del documento. Una sola petición por comprobante, que devuelve el lote
   * entero — cambiar de "entregado" a "pendiente" revalida cada línea contra el stock y el
   * material disponible, así que el veredicto de todas cambia a la vez.
   */
  const updateGroup = useMutation({
    mutationFn: ({ groupKey, data }: { groupKey: string; data: Record<string, unknown> }) =>
      api<ImportBatchWithRowsDto>(`/imports/${batch?.id}/group`, {
        method: 'PATCH',
        body: { groupKey, data },
      }),
    onSuccess: (full) => {
      setBatch((b) => (b?.id === full.id && b.status !== 'CONFIRMED' ? full : b));
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo marcar el comprobante');
    },
  });

  const confirm = useMutation({
    mutationFn: () =>
      api<ImportBatchWithRowsDto>(`/imports/${batch?.id}/confirm`, { method: 'POST' }),
    onSuccess: (data) => {
      setBatch(data);
      const confirmed = data.rows.filter((r) => r.status === 'CONFIRMED').length;
      toast.success(`${confirmed} de ${data.rows.length} ${unit} importadas`);
      void queryClient.invalidateQueries({ queryKey: invalidateQueryKey });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo confirmar la importación');
    },
  });

  // D-137: el reporte de saldo vs objetivo, después de confirmar una carga de bobinas.
  const stockCheck = useQuery({
    queryKey: ['import-coil-stock-check', batch?.id],
    queryFn: () => api<CoilImportCheckDto>(`/imports/${batch?.id}/coil-stock-check`),
    enabled:
      entity === ImportEntity.COILS_HISTORY && batch?.status === 'CONFIRMED' && batch.id !== '',
  });

  const reset = () => {
    setBatch(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const validCount = batch?.rows.filter((r) => r.status !== 'INVALID').length ?? 0;
  const alreadyConfirmed = batch?.status === 'CONFIRMED';

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Importar {IMPORT_ENTITY_LABELS[entity].toLowerCase()}</DialogTitle>
            <DialogDescription>
              Sube un archivo xlsx o csv. Vas a poder revisar y corregir cada fila antes de
              confirmar.
            </DialogDescription>
          </DialogHeader>

          {!batch && needsOptions && (
            <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="import-line">Línea de negocio</Label>
                <Select
                  value={options.businessLine ?? ''}
                  onValueChange={(v) => {
                    setOptions((o) => ({ ...o, businessLine: v as BusinessLine }));
                  }}
                >
                  <SelectTrigger id="import-line" disabled={upload.isPending}>
                    <SelectValue placeholder="Elige una línea" />
                  </SelectTrigger>
                  <SelectContent>
                    {COIL_BUSINESS_LINES.map((line) => (
                      <SelectItem key={line} value={line}>
                        {BUSINESS_LINE_LABELS[line]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="import-mode">Modo</Label>
                <Select
                  value={options.mode}
                  onValueChange={(v) => {
                    setOptions((o) => ({ ...o, mode: v as CoilImportMode }));
                  }}
                >
                  <SelectTrigger id="import-mode" disabled={upload.isPending}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COIL_IMPORT_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {COIL_IMPORT_MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {options.mode === CoilImportMode.ADJUST && (
                <div className="grid gap-1.5">
                  <Label htmlFor="import-adjust-date">Fecha del consumo pre-sistema</Label>
                  <Select
                    value={options.adjustDate}
                    onValueChange={(v) => {
                      setOptions((o) => ({ ...o, adjustDate: v as CoilAdjustDate }));
                    }}
                  >
                    <SelectTrigger id="import-adjust-date" disabled={upload.isPending}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COIL_ADJUST_DATES.map((d) => (
                        <SelectItem key={d} value={d}>
                          {COIL_ADJUST_DATE_LABELS[d]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {!batch && (
            <div className="grid gap-4">
              <Input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload.mutate(file);
                }}
                disabled={upload.isPending || !optionsReady}
              />
              {!optionsReady && (
                <p className="text-sm text-destructive">
                  Elige la línea de negocio antes de subir el archivo: es lo que decide en qué
                  inventario entran las bobinas, y no se puede deshacer.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Columnas esperadas: {columns.map((c) => c.label).join(', ')}.
              </p>
              {upload.isPending && <p className="text-sm text-muted-foreground">Subiendo…</p>}
            </div>
          )}

          {batch && (
            <div className="grid gap-4">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      {columns.map((c) => (
                        <TableHead key={c.key}>{c.label}</TableHead>
                      ))}
                      <TableHead>Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toGroups(batch.rows).map((group, groupIndex) => {
                      // En una constante y no en `group.key`: dentro del callback del
                      // `Select` el estrechamiento de la propiedad ya no vale, y el linter
                      // prohíbe tanto el `!` como el `as string` con los que se tapaba.
                      const groupKey = group.key;
                      return (
                        <Fragment key={groupKey ?? `sin-grupo-${groupIndex}`}>
                          {hasFulfillment && groupKey !== null && (
                            <DocumentHeader
                              groupKey={groupKey}
                              rows={group.rows}
                              columnCount={columns.length + 2}
                              disabled={
                                alreadyConfirmed || confirm.isPending || updateGroup.isPending
                              }
                              onChange={(fulfillment) => {
                                updateGroup.mutate({ groupKey, data: { fulfillment } });
                              }}
                            />
                          )}
                          {group.rows.map((row) => (
                            <RowEditor
                              key={row.id}
                              row={row}
                              columns={columns}
                              masterColumns={
                                entity === ImportEntity.COILS_HISTORY ? MASTER_COLUMNS : {}
                              }
                              masterOptions={masterOptions}
                              disabled={alreadyConfirmed || confirm.isPending}
                              onSave={(data) => {
                                updateRow.mutate({ rowId: row.id, data });
                              }}
                            />
                          ))}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <p className="text-sm text-muted-foreground">
                {validCount} de {batch.rows.length} {unit} listas para confirmar.
              </p>
              {stockCheck.data && (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Saldo vs objetivo</p>
                  <p className="text-muted-foreground">
                    {stockCheck.data.matching} bobinas cuadran y {stockCheck.data.mismatching} no.
                    {stockCheck.data.mode === CoilImportMode.REPLAY
                      ? ' En modo replay la diferencia es lo que falta cargar: cortes, producción y ventas del período.'
                      : ' En modo ajuste tendría que cuadrar todo desde el primer día.'}
                  </p>
                  {stockCheck.data.rows.filter((r) => !r.matches).length > 0 && (
                    <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
                      {stockCheck.data.rows
                        .filter((r) => !r.matches)
                        .slice(0, 20)
                        .map((r) => (
                          <li key={r.rowNumber}>
                            Fila {r.rowNumber} · {r.coilCode ?? '—'}: kardex {r.currentKg} kg,
                            objetivo {r.targetKg} kg ({r.differenceKg})
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {batch && !alreadyConfirmed && (
              <Button variant="outline" onClick={reset}>
                Subir otro archivo
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              {alreadyConfirmed ? 'Cerrar' : 'Cancelar'}
            </Button>
            {batch && !alreadyConfirmed && (
              <Button
                onClick={() => {
                  confirm.mutate();
                }}
                disabled={validCount === 0 || confirm.isPending}
              >
                {confirm.isPending ? 'Confirmando…' : `Confirmar ${validCount} ${unit}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * D-141: la cabecera de un comprobante en la previsualización, con **el** toggle que decide
 * qué pedido va a crear.
 *
 * Vive en una fila propia y no en una celda de la primera línea porque la decisión es del
 * documento: puesta en una línea, un archivo con tres líneas mostraba tres controles que
 * hacían lo mismo y el usuario no tenía cómo saber que tocar cualquiera de ellos movía a las
 * otras dos.
 *
 * El texto de abajo dice lo que va a pasar en cada caso porque es exactamente la clase de
 * elección que no se puede deshacer sola: un pedido cáscara no toca nada, pero uno pendiente
 * compromete material y abre una orden en planta.
 */
function DocumentHeader({
  groupKey,
  rows,
  columnCount,
  disabled,
  onChange,
}: {
  groupKey: string;
  rows: ImportRowDto[];
  columnCount: number;
  disabled: boolean;
  onChange: (fulfillment: ImportFulfillment) => void;
}) {
  const value =
    rows[0]?.data.fulfillment === ImportFulfillment.PENDING
      ? ImportFulfillment.PENDING
      : ImportFulfillment.DELIVERED;
  const confirmed = rows.every((r) => r.status === 'CONFIRMED');
  return (
    <TableRow className="bg-muted/50">
      <TableCell colSpan={columnCount} className="py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm font-medium">{groupKey}</span>
          <span className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'línea' : 'líneas'}
          </span>
          <Select
            value={value}
            disabled={disabled || confirmed}
            onValueChange={(v) => {
              onChange(v as ImportFulfillment);
            }}
          >
            <SelectTrigger
              className="h-7 w-auto min-w-[22rem] text-xs"
              aria-label={`Entrega de ${groupKey}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IMPORT_FULFILLMENTS.map((f) => (
                <SelectItem key={f} value={f}>
                  {IMPORT_FULFILLMENT_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {value === ImportFulfillment.PENDING
              ? 'Reserva material, entra a la cola de producción y la orden nace sin bobina montada.'
              : 'Sin reserva, sin despacho, sin kardex y sin cola: solo queda registrado.'}
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
}

function RowEditor({
  row,
  columns,
  masterColumns,
  masterOptions,
  disabled,
  onSave,
}: {
  row: ImportRowDto;
  columns: { key: string; label: string }[];
  /** Qué columnas se corrigen eligiendo de un maestro y con cuál (D-137). */
  masterColumns: Record<string, 'finish' | 'color'>;
  masterOptions: Record<'finish' | 'color', { value: string; label: string }[]>;
  disabled: boolean;
  onSave: (data: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(row.data);
  const [focused, setFocused] = useState<string | null>(null);

  // El API **normaliza** al validar (el correlativo pasa a número, los importes a escala
  // fija), así que sin esto el preview seguía mostrando el texto crudo y no lo que de verdad
  // se iba a importar. La celda con el foco se respeta: el usuario puede estar tabulando al
  // campo siguiente de la misma fila mientras vuelve la respuesta del anterior.
  useEffect(() => {
    setValues((current) => {
      const next = { ...row.data };
      if (focused !== null && focused in current) next[focused] = current[focused];
      return next;
    });
    // `focused` queda fuera de las dependencias a propósito: resincronizar al cambiar de
    // celda borraría lo que el usuario está tipeando en la siguiente.
  }, [row.data]);

  return (
    <>
      <TableRow data-state={row.status === 'INVALID' ? 'inactive' : undefined}>
        <TableCell className="text-xs text-muted-foreground">{row.rowNumber}</TableCell>
        {columns.map((c) => {
          const master = masterColumns[c.key];
          const choices = master ? masterOptions[master] : undefined;
          // Un maestro que todavía no cargó deja el campo como texto: es preferible a un
          // desplegable vacío que parece que no hay ningún acabado dado de alta.
          if (choices && choices.length > 0) {
            return (
              <TableCell key={c.key}>
                <Select
                  value={(values[c.key] as string | undefined) ?? ''}
                  disabled={disabled || row.status === 'CONFIRMED'}
                  onValueChange={(v) => {
                    const next = { ...values, [c.key]: v };
                    setValues(next);
                    onSave(next);
                  }}
                >
                  <SelectTrigger
                    className="h-7 text-xs"
                    aria-label={`${c.label} fila ${row.rowNumber}`}
                  >
                    <SelectValue placeholder="Elegir" />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
            );
          }
          return (
            <TableCell key={c.key}>
              <Input
                className="h-7 text-xs"
                aria-label={`${c.label} fila ${row.rowNumber}`}
                value={(values[c.key] as string | number | undefined)?.toString() ?? ''}
                disabled={disabled || row.status === 'CONFIRMED'}
                onFocus={() => {
                  setFocused(c.key);
                }}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [c.key]: e.target.value }));
                }}
                onBlur={() => {
                  setFocused(null);
                  // Solo si de verdad cambió. Guardar en cada `blur` mandaba una petición por
                  // celda tabulada —dieciséis por fila en comprobantes— y, peor, el `blur` que
                  // dispara el clic en «Confirmar» ponía un PATCH en carrera con el POST.
                  const current = (values[c.key] as string | number | undefined)?.toString() ?? '';
                  const saved = (row.data[c.key] as string | number | undefined)?.toString() ?? '';
                  if (current !== saved) onSave(values);
                }}
              />
            </TableCell>
          );
        })}
        <TableCell>
          {row.status === 'CONFIRMED' && <Badge variant="secondary">Creada</Badge>}
          {row.status === 'VALID' && <Badge variant="outline">Lista</Badge>}
          {row.status === 'INVALID' && <Badge variant="destructive">Con errores</Badge>}
        </TableCell>
      </TableRow>
      {row.errors && row.errors.length > 0 && (
        <TableRow>
          <TableCell colSpan={columns.length + 2} className="py-1 text-xs text-destructive">
            {row.errors.join('; ')}
          </TableCell>
        </TableRow>
      )}
      {/*
        RF-72: un aviso no bloquea, pero el usuario tiene que verlo antes de confirmar.
        Lleva la palabra "Aviso" delante y no solo otro color: en escala de grises o con un
        lector de pantalla, un aviso se leía igual que un error que impide confirmar.
      */}
      {row.warnings && row.warnings.length > 0 && (
        <TableRow>
          <TableCell
            colSpan={columns.length + 2}
            className="py-1 text-xs text-amber-600 dark:text-amber-400"
          >
            Aviso: {row.warnings.join('; ')}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
