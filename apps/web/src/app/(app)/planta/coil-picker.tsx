'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MAX_ORDER_STRIPS,
  ROOFING_THICKNESS_TOLERANCE_MM,
  type RoofingCoilOptionDto,
} from '@ayr/shared';
import { formatQty } from '@/lib/format';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Elegir las bobinas a montar (D-159, ampliado por D-192).
 *
 * Una tabla y no una lista de tarjetas: lo que decide cuál montar son cifras —espesor, color,
 * **peso inicial** y kilos disponibles— que hay que comparar entre filas. D-192 agrega dos
 * cosas que planta pidió: el peso con el que entró el rollo (para reconocerlo en el almacén:
 * el disponible teórico no se ve en la bobina, el peso de la etiqueta sí) y **montar varias a la
 * vez** — un pedido largo se rola de más de un rollo y montarlas de a una era abrir el modal N
 * veces. Cada fila conserva su botón «Montar» para el caso normal de una sola.
 *
 * No filtra nada por su cuenta: las bobinas que llegan ya vienen filtradas por el API
 * (`GET /production/roofing/coils`, D-086) y una que no aparezca acá tampoco se puede montar.
 */
export function CoilPicker({
  orderCode,
  productSku,
  options,
  mountedCount,
  loading,
  failed,
  pending,
  disabled = false,
  onMount,
}: {
  orderCode: string;
  productSku: string;
  options: readonly RoofingCoilOptionDto[];
  /** Bobinas ya montadas en la orden: el tope de `MAX_ORDER_STRIPS` cuenta las dos. */
  mountedCount: number;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  disabled?: boolean | undefined;
  onMount: (coilIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // El filtro y la selección no sobreviven al cierre: reabrir con una selección vieja montaría
  // rollos que ya nadie está mirando.
  useEffect(() => {
    if (open) {
      setFilter('');
      setSelected(new Set());
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter((c) =>
      `${c.code} ${c.colorName ?? ''} ${c.thicknessMm} ${c.widthMm} ${c.weightKg} ${c.availableKg}`
        .toLowerCase()
        .includes(needle),
    );
  }, [options, filter]);

  const room = Math.max(MAX_ORDER_STRIPS - mountedCount, 0);
  const overLimit = selected.size > room;

  if (loading) return <Skeleton className="h-12 w-full" />;
  if (failed) {
    return (
      <p className="text-sm text-destructive">No se pudieron cargar las bobinas disponibles.</p>
    );
  }
  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hay bobinas libres del color y el espesor de {productSku} (±
        {ROOFING_THICKNESS_TOLERANCE_MM} mm). Una bobina en corte tercerizado, montada en otra orden
        o prometida a otro pedido tampoco aparece acá.
      </p>
    );
  }

  const mount = (ids: string[]) => {
    onMount(ids);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        className="justify-self-start"
        aria-label={`Buscar una bobina para ${orderCode}`}
        disabled={disabled || pending}
        onClick={() => {
          setOpen(true);
        }}
      >
        Buscar y montar bobinas ({options.length})
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Bobinas para {orderCode}</DialogTitle>
            <DialogDescription>
              {options.length} bobinas libres del espesor y el color de {productSku}. Monta una con
              su botón, o elige varias y móntalas juntas.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              autoFocus
              aria-label="Filtrar opciones"
              placeholder="Filtra por código, color o kilos…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {matches.length} de {options.length} bobinas
              {selected.size > 0 && <> · {selected.size} elegidas</>}
            </p>
            <div className="max-h-96 overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">Elegir</span>
                    </TableHead>
                    <TableHead>Bobina</TableHead>
                    <TableHead>Espesor</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead className="text-right">Peso inicial</TableHead>
                    <TableHead className="text-right">kg disponibles</TableHead>
                    <TableHead className="w-28 text-right">Montar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((c) => (
                    <TableRow
                      key={c.coilId}
                      data-state={selected.has(c.coilId) ? 'selected' : undefined}
                    >
                      <TableCell>
                        <Checkbox
                          aria-label={`Elegir ${c.code}`}
                          checked={selected.has(c.coilId)}
                          onCheckedChange={(checked) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (checked === true) next.add(c.coilId);
                              else next.delete(c.coilId);
                              return next;
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-mono font-medium">{c.code}</div>
                        <div className="text-xs text-muted-foreground">
                          alcanza para {c.estimatedMeters} m
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{c.thicknessMm} mm</TableCell>
                      <TableCell>
                        <ColorSwatch
                          color={
                            c.colorName && c.colorHex
                              ? { name: c.colorName, hexColor: c.colorHex }
                              : null
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(c.weightKg, 'kg')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(c.availableKg, 'kg')}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Montar ${c.code}`}
                          disabled={pending || room === 0}
                          onClick={() => {
                            mount([c.coilId]);
                          }}
                        >
                          Montar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {matches.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        Ninguna bobina coincide con ese texto.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {overLimit && (
              <p className="text-sm text-destructive">
                La orden admite {MAX_ORDER_STRIPS} bobinas a la vez y ya tiene {mountedCount}: elige
                como máximo {room}.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              aria-label={`Montar las ${String(selected.size)} bobinas elegidas en ${orderCode}`}
              disabled={selected.size === 0 || overLimit || pending}
              onClick={() => {
                mount([...selected]);
              }}
            >
              Montar {selected.size === 1 ? 'la elegida' : `las ${String(selected.size)} elegidas`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
