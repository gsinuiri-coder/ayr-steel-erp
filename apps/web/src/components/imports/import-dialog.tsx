'use client';

import { useRef, useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  IMPORT_ENTITY_LABELS,
  type ImportBatchWithRowsDto,
  type ImportEntity,
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
    mutationFn: ({ rowId, data }: { rowId: string; data: Record<string, unknown> }) =>
      api<ImportRowDto>(`/imports/${batch?.id}/rows/${rowId}`, { method: 'PATCH', body: { data } }),
    onSuccess: (updatedRow) => {
      setBatch((b) =>
        b ? { ...b, rows: b.rows.map((r) => (r.id === updatedRow.id ? updatedRow : r)) } : b,
      );
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
      toast.success(`${confirmed} de ${data.rows.length} filas importadas`);
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
                {validCount} de {batch.rows.length} filas listas para confirmar.
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
                {confirm.isPending ? 'Confirmando…' : `Confirmar ${validCount} filas`}
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
              onChange={(e) => {
                setValues((v) => ({ ...v, [c.key]: e.target.value }));
              }}
              onBlur={() => {
                onSave(values);
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
    </>
  );
}
