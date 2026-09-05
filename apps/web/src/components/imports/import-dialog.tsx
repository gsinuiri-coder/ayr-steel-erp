'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  IMPORT_ENTITY_LABELS,
  ImportEntity,
  type ImportBatchWithRowsDto,
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
const GROUPED_ENTITIES: ImportEntity[] = [ImportEntity.FISCAL_DOCUMENTS];

async function uploadImport(entity: ImportEntity, file: File): Promise<ImportBatchWithRowsDto> {
  const form = new FormData();
  form.append('entity', entity);
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
}

export function ImportDialog({ entity, invalidateQueryKey }: Props) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState<ImportBatchWithRowsDto | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const columns = IMPORT_COLUMNS[entity];
  const grouped = GROUPED_ENTITIES.includes(entity);
  // En una entidad agrupada una fila es una **línea**, no un comprobante: decir "filas" no
  // es falso pero cuenta en una unidad que el usuario no usa.
  const unit = grouped ? 'líneas' : 'filas';
  /**
   * Número de la última edición lanzada. Dos `blur` seguidos dejan dos peticiones en vuelo
   * y la primera puede contestar última: sin este contador, su respuesta —con los errores
   * de antes de la segunda corrección— pisaba a la buena, y el usuario decidía confirmar
   * mirando información caducada.
   */
  const editSeq = useRef(0);

  const upload = useMutation({
    mutationFn: (file: File) => uploadImport(entity, file),
    onSuccess: (data) => {
      setBatch(data);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo subir el archivo');
    },
  });

  const updateRow = useMutation({
    mutationFn: async ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) => {
      const seq = (editSeq.current += 1);
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
      return { seq, batchId, row, full };
    },
    onSuccess: ({ seq, batchId, row, full }) => {
      // Descarta lo que llegó tarde y lo que ya no corresponde: el lote pudo cancelarse
      // (`reset()`) mientras la petición volaba, y aplicarlo resucitaba un preview cerrado
      // con su botón de confirmar activo — confirmando un archivo que el usuario descartó.
      if (seq !== editSeq.current) return;
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
        Importar
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
                disabled={upload.isPending}
              />
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
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      {columns.map((c) => (
                        <TableHead key={c.key}>{c.label}</TableHead>
                      ))}
                      <TableHead>Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batch.rows.map((row) => (
                      <RowEditor
                        key={row.id}
                        row={row}
                        columns={columns}
                        disabled={alreadyConfirmed || confirm.isPending}
                        onSave={(data) => {
                          updateRow.mutate({ rowId: row.id, data });
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-sm text-muted-foreground">
                {validCount} de {batch.rows.length} {unit} listas para confirmar.
              </p>
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

function RowEditor({
  row,
  columns,
  disabled,
  onSave,
}: {
  row: ImportRowDto;
  columns: { key: string; label: string }[];
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
        {columns.map((c) => (
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
        ))}
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
