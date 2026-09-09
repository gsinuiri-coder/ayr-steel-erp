'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/**
 * Elegir de una lista larga (D-156).
 *
 * Un `<select>` nativo con 900 productos es un callejón: no se filtra, no se busca y hay
 * que reconocer el SKU de memoria mientras se recorre la lista con la rueda del mouse. Por
 * encima de {@link SEARCH_SELECT_THRESHOLD} opciones el campo pasa a ser un botón que abre
 * esta tabla —filtro de texto y una columna "Seleccionar"—, y por debajo se queda como el
 * desplegable de siempre, que para diez opciones es más rápido que abrir un modal.
 *
 * El componente no sabe qué está eligiendo: recibe opciones `{ id, label, hint }` y devuelve
 * el id. Es lo que le permite servir para clientes, productos y cualquier maestro que la
 * auditoría de campos-callejón encuentre después.
 */

export const SEARCH_SELECT_THRESHOLD = 50;

/** Cuántas filas se pintan por vez. Filtrar es barato; pintar 900 filas no. */
const PAGE = 50;

export interface SearchSelectOption {
  id: string;
  label: string;
  /** Segunda línea, opcional: la descripción larga que no entra en el label. */
  hint?: string;
  /**
   * Columnas extra de la fila, alineadas con `columns` (D-159). Existen para el selector de
   * bobinas, donde lo que decide cuál montar no es un nombre sino cuatro cifras —espesor,
   * color, kilos, alcance— que en un `label` concatenado no se pueden ni comparar ni alinear.
   */
  cells?: readonly ReactNode[];
  /** Texto por el que se filtra cuando las celdas no son texto (un color, por ejemplo). */
  searchText?: string;
}

export function SearchSelectModal({
  open,
  title,
  description,
  options,
  columns,
  actionLabel = 'Seleccionar',
  selectedId,
  onSelect,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  description?: string;
  options: readonly SearchSelectOption[];
  /** Encabezados de las columnas extra, en el orden de `cells`. */
  columns?: readonly string[];
  /** Rótulo de la última columna y de su botón. `Montar` en el selector de bobinas. */
  actionLabel?: string;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE);

  // El filtro no sobrevive al cierre: reabrir el modal con el texto de la búsqueda anterior
  // lo muestra vacío ("0 de 12 opciones") sobre una lista que sí tiene lo que se busca.
  useEffect(() => {
    if (open) {
      setFilter('');
      setShown(PAGE);
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter((o) =>
      `${o.label} ${o.hint ?? ''} ${o.searchText ?? ''}`.toLowerCase().includes(needle),
    );
  }, [options, filter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            autoFocus
            aria-label="Filtrar opciones"
            placeholder="Escribe para filtrar…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setShown(PAGE);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {matches.length} de {options.length} opciones
          </p>
          <div className="max-h-80 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Opción</TableHead>
                  {(columns ?? []).map((column) => (
                    <TableHead key={column}>{column}</TableHead>
                  ))}
                  <TableHead className="w-32 text-right">{actionLabel}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.slice(0, shown).map((option) => (
                  <TableRow key={option.id}>
                    <TableCell>
                      <div className="font-medium">{option.label}</div>
                      {option.hint !== undefined && (
                        <div className="text-xs text-muted-foreground">{option.hint}</div>
                      )}
                    </TableCell>
                    {(columns ?? []).map((column, i) => (
                      <TableCell key={column} className="text-sm">
                        {option.cells?.[i] ?? '—'}
                      </TableCell>
                    ))}
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant={option.id === selectedId ? 'default' : 'outline'}
                        aria-label={`${actionLabel} ${option.label}`}
                        onClick={() => {
                          onSelect(option.id);
                          onOpenChange(false);
                        }}
                      >
                        {option.id === selectedId ? 'Elegida' : actionLabel}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {matches.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={2 + (columns?.length ?? 0)}
                      className="text-center text-muted-foreground"
                    >
                      Ninguna opción coincide con ese texto.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {matches.length > shown && (
            <Button
              variant="outline"
              onClick={() => {
                setShown((n) => n + PAGE);
              }}
            >
              Ver {Math.min(PAGE, matches.length - shown)} más
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * El campo: desplegable cuando la lista es corta, botón + modal cuando es larga. Quien lo
 * usa no decide cuál: decide el número de opciones, que es el dato que de verdad manda.
 */
export function SearchSelectField({
  label,
  placeholder,
  options,
  value,
  disabled,
  onChange,
}: {
  /** Se usa como `aria-label` y como título del modal. */
  label: string;
  placeholder: string;
  options: readonly SearchSelectOption[];
  value: string | null;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value) ?? null;
  /**
   * Elegido, pero **fuera de la lista**: el id existe y ninguna opción lo ofrece. Sin
   * decirlo, el campo se ve exactamente igual que uno vacío —el `<select>` queda en blanco
   * y el botón muestra el placeholder— y quien mira no tiene forma de saber que hay un valor
   * puesto. Pasa con un maestro que filtra inactivos y con la ventana entre crear un
   * registro y que la lista se refresque.
   */
  const missing = value !== null && value !== '' && selected === null;

  if (options.length <= SEARCH_SELECT_THRESHOLD) {
    return (
      <div className="grid gap-1">
        <select
          aria-label={label}
          className="h-9 w-52 rounded-md border bg-background px-2 text-xs"
          value={missing ? '' : (value ?? '')}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {missing && <MissingNote />}
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant="outline"
        aria-label={label}
        disabled={disabled}
        className="h-9 w-52 justify-start truncate text-xs font-normal"
        onClick={() => {
          setOpen(true);
        }}
      >
        {selected?.label ?? placeholder}
      </Button>
      {missing && <MissingNote />}
      {/*
        El título del modal no puede ser el mismo texto que el `aria-label` del botón: con el
        modal abierto, una consulta por ese nombre encuentra los dos y toda búsqueda estricta
        —la de los E2E incluida— falla por ambigüedad.
      */}
      <SearchSelectModal
        open={open}
        title={`Elegir · ${label}`}
        description={`${options.length} opciones: filtra por cualquier parte del texto.`}
        options={options}
        selectedId={value}
        onSelect={onChange}
        onOpenChange={setOpen}
      />
    </div>
  );
}

function MissingNote() {
  return (
    <p className="w-52 text-xs text-destructive">
      Lo elegido no está entre las opciones (puede estar desactivado): elige otro.
    </p>
  );
}
