'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SEARCH_MIN_CHARS } from '@ayr/shared';
import { useDebounced } from '@/lib/use-debounced';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
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
 *
 * **RF-S3/M1: dos modos, no dos componentes.** `options` (síncrono) sigue siendo "ya tengo
 * el maestro entero cargado, filtro en memoria" — lo usa el importador, que necesita el
 * maestro completo de todas formas para resolver filas (D-152). `search` (servidor) es
 * "no cargues nada hasta que el usuario escriba" — lo usan el cliente y el producto de
 * cotizaciones/pedidos, que antes traían el maestro entero solo para poblar este campo. Los
 * dos modos comparten la tabla, el debounce y el patrón crear-desde-campo; lo que cambia es
 * de dónde salen las filas.
 */

/**
 * A partir de cuántas opciones el campo deja de ser un desplegable y pasa a ser el buscador.
 * Solo aplica al modo síncrono: el modo `search` siempre es botón + modal, porque no hay
 * lista completa de la que medir el tamaño.
 *
 * **20 desde el saneamiento E2E**, por decisión del dueño. Estaba en 50 y producción tenía 49
 * clientes activos: el vendedor quedaba a un cliente de distancia del buscador y mientras
 * tanto elegía de una lista de 49 nombres reconociéndolos de vista. Con 20 el buscador entra
 * donde de verdad hace falta y el desplegable se queda para los maestros que son de verdad
 * cortos, que es la única cosa para la que es mejor.
 */
export const SEARCH_SELECT_THRESHOLD = 20;

/** Cuántas filas se pintan por vez en modo síncrono. Filtrar es barato; pintar 900 filas no. */
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
  search,
  minChars = SEARCH_MIN_CHARS,
  columns,
  actionLabel = 'Seleccionar',
  selectedId,
  onSelect,
  onOpenChange,
  extraAction,
  emptyMessage,
}: {
  open: boolean;
  title: string;
  description?: string;
  /** Modo síncrono: el maestro entero, ya cargado. Exclusivo con `search`. */
  options?: readonly SearchSelectOption[];
  /**
   * RF-S3/M1, modo servidor: exclusivo con `options`. Se llama con el texto ya debounceado
   * (250 ms) y solo cuando tiene al menos `minChars` caracteres — por debajo no busca nada,
   * ni en el servidor ni en memoria.
   */
  search?: (q: string) => Promise<SearchSelectOption[]>;
  minChars?: number;
  /** Encabezados de las columnas extra, en el orden de `cells`. */
  columns?: readonly string[];
  /** Rótulo de la última columna y de su botón. `Montar` en el selector de bobinas. */
  actionLabel?: string;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onOpenChange: (open: boolean) => void;
  /**
   * F8-S3c/M4: el alta express (D-156) de la opción que falta, **dentro** del modal —el
   * patrón crear-desde-campo mantiene el contexto—, no al lado del campo que lo abre. Sigue
   * a la vista con la lista vacía o filtrada a cero, que es justo cuando hace falta.
   */
  extraAction?: ReactNode;
  /**
   * F8-S3c/M4: el maestro no tiene **ninguna** opción todavía (no es que el filtro no
   * encontró nada). Sin esto, un maestro recién creado se leía igual que una búsqueda sin
   * resultados, y no decía qué hacer al respecto — `extraAction` es la respuesta.
   */
  emptyMessage?: string;
}) {
  const isAsync = search !== undefined;
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const debouncedFilter = useDebounced(filter, 250);

  // El filtro no sobrevive al cierre: reabrir el modal con el texto de la búsqueda anterior
  // lo muestra vacío ("0 de 12 opciones") sobre una lista que sí tiene lo que se busca.
  useEffect(() => {
    if (open) {
      setFilter('');
      setShown(PAGE);
    }
  }, [open]);

  const trimmed = filter.trim();
  const debouncedTrimmed = debouncedFilter.trim();
  // RF-S3/cierre (hallazgo de `qa` contra `selector-cliente-f8s3c.spec.ts`, D-156/F8-S3c/M4):
  // vacío no es "por debajo del mínimo" — es "sin filtro de texto", y el servicio ya sabe
  // devolver los primeros `SEARCH_RESULT_LIMIT` para ese caso (ver `searchQuerySchema`). Solo
  // 1..minChars-1 caracteres es la zona muerta real: ni "nada" ni alcanza para acotar.
  const belowMinChars =
    isAsync && debouncedTrimmed.length > 0 && debouncedTrimmed.length < minChars;

  const serverSearch = useQuery({
    queryKey: ['search-select-modal', title, debouncedTrimmed],
    queryFn: () => (search ? search(debouncedTrimmed) : Promise.resolve([])),
    enabled: open && isAsync && !belowMinChars,
  });

  const staticMatches = useMemo(() => {
    if (isAsync) return [];
    const needle = trimmed.toLowerCase();
    const all = options ?? [];
    if (needle === '') return all;
    return all.filter((o) =>
      `${o.label} ${o.hint ?? ''} ${o.searchText ?? ''}`.toLowerCase().includes(needle),
    );
  }, [isAsync, options, trimmed]);

  const matches = isAsync ? (serverSearch.data ?? []) : staticMatches;
  // En modo servidor el tope de 20 ya lo puso la API: no hay "ver más" que pedir.
  const visible = isAsync ? matches : matches.slice(0, shown);

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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {isAsync
                ? belowMinChars
                  ? `Escribe al menos ${String(minChars)} caracteres para buscar.`
                  : serverSearch.isFetching
                    ? 'Buscando…'
                    : `${String(matches.length)} resultado${matches.length === 1 ? '' : 's'}`
                : `${String(matches.length)} de ${String((options ?? []).length)} opciones: filtra por cualquier parte del texto.`}
            </p>
            {extraAction}
          </div>
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
                {visible.map((option) => (
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
                {visible.length === 0 && !belowMinChars && (
                  <TableRow>
                    <TableCell
                      colSpan={2 + (columns?.length ?? 0)}
                      className="text-center text-muted-foreground"
                    >
                      {isAsync
                        ? serverSearch.isFetching
                          ? 'Buscando…'
                          : debouncedTrimmed === ''
                            ? (emptyMessage ?? 'No hay ninguna opción registrada todavía.')
                            : 'Ninguna opción coincide con ese texto.'
                        : (options ?? []).length === 0
                          ? (emptyMessage ?? 'No hay ninguna opción registrada todavía.')
                          : 'Ninguna opción coincide con ese texto.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {!isAsync && matches.length > shown && (
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
 * El campo: desplegable cuando la lista es corta, botón + modal cuando es larga (modo
 * síncrono), o siempre botón + modal cuando busca en el servidor (modo `search`, RF-S3/M1).
 * Quien lo usa no decide la forma del modo síncrono: decide el número de opciones, que es el
 * dato que de verdad manda.
 */
export function SearchSelectField({
  label,
  placeholder,
  options,
  search,
  selectedOption,
  selectedOptionLoading = false,
  minChars,
  value,
  disabled,
  onChange,
  id,
  className,
  forceModal = false,
  actionLabel,
  extraAction,
  emptyMessage,
}: {
  /** Se usa como `aria-label` y como título del modal. */
  label: string;
  placeholder: string;
  /** Modo síncrono: el maestro entero, ya cargado. Exclusivo con `search`. */
  options?: readonly SearchSelectOption[];
  /** RF-S3/M1, modo servidor: exclusivo con `options`. Ver `SearchSelectModal`. */
  search?: (q: string) => Promise<SearchSelectOption[]>;
  /**
   * RF-S3/M1: el rótulo de lo ya elegido, **hidratado por id fuera de este componente** (p.
   * ej. `GET /customers/:id`). En modo `search` no existe una lista completa de la que sacar
   * el label de lo ya elegido —por diseño, es lo que evita traerla— así que quien usa el
   * campo lo resuelve una vez, por id, y se lo pasa. Sin esto, editar una cotización o un
   * pedido viejo mostraría el selector vacío aunque el cliente/producto elegido exista.
   */
  selectedOption?: SearchSelectOption | null;
  /**
   * RF-S3/cierre (hallazgo de `revisor`): mientras la hidratación de `selectedOption`
   * todavía está en vuelo (la primera carga de `useQuery`, no un refetch de fondo), no hay
   * forma de distinguir "no existe" de "todavía no llegó" — sin esto, abrir para editar una
   * cotización o un pedido con cliente ya elegido mostraba un instante "no está entre las
   * opciones" sobre un cliente que sí existe y está activo, y lo mismo pasaba justo después
   * de elegir uno nuevo. El llamador pasa el `isLoading` de su propio `useQuery`.
   */
  selectedOptionLoading?: boolean;
  minChars?: number;
  value: string | null;
  disabled?: boolean;
  onChange: (id: string) => void;
  /**
   * Para que un `<Label htmlFor>` de afuera enfoque el campo. Sin esto, la etiqueta del
   * formulario de ventas apuntaba a un id que dejó de existir al cambiar el `<Select>` por
   * este componente: el clic en «Cliente» no enfocaba nada.
   */
  id?: string;
  /**
   * Ancho y demás, desde afuera. El `w-52` por defecto es el del importador, donde el campo
   * vive en una celda de tabla; en un formulario a dos columnas trunca nombres que entran de
   * sobra («PÚBLICO EN GENERAL — 00000000» al lado de una fecha a ancho completo).
   */
  className?: string;
  /**
   * F8-S3c/M4: el campo nunca cae al `<select>` corto, ni con cero opciones — es el selector
   * de cliente, que tiene que poder abrirse (y ofrecer el alta) también en un maestro vacío.
   * Sin efecto en modo `search`, que ya es siempre modal.
   */
  forceModal?: boolean;
  actionLabel?: string;
  /** Ver `SearchSelectModal`. Recibe `close` para cerrar el modal desde la acción propia. */
  extraAction?: (helpers: { close: () => void }) => ReactNode;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const isAsync = search !== undefined;
  const selected = isAsync
    ? (selectedOption ?? null)
    : ((options ?? []).find((o) => o.id === value) ?? null);
  /**
   * Elegido, pero **fuera de la lista**: el id existe y ninguna opción lo ofrece. Sin
   * decirlo, el campo se ve exactamente igual que uno vacío —el `<select>` queda en blanco
   * y el botón muestra el placeholder— y quien mira no tiene forma de saber que hay un valor
   * puesto. Pasa con un maestro que filtra inactivos y con la ventana entre crear un
   * registro y que la lista se refresque.
   */
  const missing =
    value !== null && value !== '' && selected === null && !(isAsync && selectedOptionLoading);

  if (!isAsync && !forceModal && (options ?? []).length <= SEARCH_SELECT_THRESHOLD) {
    const syncOptions = options ?? [];
    return (
      <div className="grid gap-1">
        <select
          id={id}
          aria-label={label}
          className={cn('h-9 w-52 rounded-md border bg-background px-2 text-xs', className)}
          value={missing ? '' : (value ?? '')}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        >
          <option value="">{placeholder}</option>
          {syncOptions.map((o) => (
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
        id={id}
        variant="outline"
        aria-label={label}
        disabled={disabled}
        className={cn('h-9 w-52 justify-start truncate text-xs font-normal', className)}
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
        description={
          isAsync
            ? undefined
            : (options ?? []).length === 0
              ? 'Todavía no hay ninguna opción en este maestro.'
              : `${String((options ?? []).length)} opciones: filtra por cualquier parte del texto.`
        }
        options={isAsync ? undefined : options}
        search={search}
        minChars={minChars}
        actionLabel={actionLabel}
        selectedId={value}
        onSelect={onChange}
        onOpenChange={setOpen}
        extraAction={extraAction?.({
          close: () => {
            setOpen(false);
          },
        })}
        emptyMessage={emptyMessage}
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
