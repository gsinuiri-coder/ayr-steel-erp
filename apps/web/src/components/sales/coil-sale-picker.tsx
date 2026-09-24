'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SellableCoilDto, UnavailableSellableCoilDto } from '@ayr/shared';
import { api } from '@/lib/api';
import { groupByPool, matchesCoilFilter } from '@/lib/coil-sale-picker';
import { formatQty } from '@/lib/format';
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
 * D-282: elegir la bobina de una venta directa (D-116) en un modal, igual que se elige el
 * producto en las otras líneas (D-188), en vez de un desplegable de códigos sueltos. Agrupa por
 * pool (espesor + color comercial, D-253), muestra el acabado con su RAL (D-270) y, debajo, las
 * bobinas con saldo que **no** se ofrecen y por qué (`GET /sales/sellable-coils/unavailable`,
 * que a un VENDEDOR no le nombra documentos de otro vendedor: D-267/D-275).
 *
 * Las vendibles llegan del formulario (`GET /sales/sellable-coils`, la misma lista que ya usaba
 * el desplegable): el modal no recalcula disponibilidad, solo la presenta.
 */
export function CoilSalePickerDialog({
  open,
  onOpenChange,
  coils,
  loading,
  quotationId,
  selectedCoilId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coils: SellableCoilDto[] | undefined;
  loading: boolean;
  /** La cotización que se edita: su propia reserva no cuenta como «de otro» (D-185). */
  quotationId: string | null;
  selectedCoilId: string;
  onSelect: (coilId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  // Mismo criterio que el modal de productos (D-156): el filtro no sobrevive al cierre.
  useEffect(() => {
    if (open) setFilter('');
  }, [open]);

  const unavailable = useQuery({
    queryKey: ['sellable-coils-unavailable', quotationId],
    queryFn: () =>
      api<UnavailableSellableCoilDto[]>(
        `/sales/sellable-coils/unavailable${quotationId ? `?excludeQuotationId=${quotationId}` : ''}`,
      ),
    enabled: open,
  });

  const groups = groupByPool((coils ?? []).filter((c) => matchesCoilFilter(c, filter)));
  const taken = (unavailable.data ?? []).filter((c) => matchesCoilFilter(c, filter));

  function choose(coilId: string): void {
    onSelect(coilId);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Elegir bobina · venta directa</DialogTitle>
          <DialogDescription>
            Se vende la bobina entera, por su saldo completo. El disponible ya descuenta lo
            reservado; debajo se listan las bobinas con saldo que no se ofrecen y por qué.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3">
          <Input
            autoFocus
            aria-label="Filtrar bobinas"
            placeholder="Código, color, RAL o espesor…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
          <div className="max-h-96 overflow-x-hidden overflow-y-auto rounded-lg border">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Bobina</TableHead>
                  <TableHead className="w-[34%]">Acabado (RAL)</TableHead>
                  <TableHead className="w-[18%] text-right">Disponible</TableHead>
                  <TableHead className="w-24 text-right">
                    <span className="sr-only">Elegir</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.flatMap((group) => [
                  <TableRow key={`pool-${group.label}`} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={4} className="py-1 text-xs font-medium">
                      {group.label}
                    </TableCell>
                  </TableRow>,
                  ...group.coils.map((c) => (
                    <TableRow
                      key={c.coilId}
                      tabIndex={0}
                      aria-label={`Elegir ${c.code}`}
                      className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => {
                        choose(c.coilId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          choose(c.coilId);
                        }
                      }}
                    >
                      <TableCell className="whitespace-normal break-words">
                        <div className="font-medium">{c.code}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.widthMm} mm de ancho{c.status === 'CLOSED' ? ' · cerrada' : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs whitespace-normal break-words">
                        {c.finishName}
                        <div className="text-muted-foreground">{c.finishCode}</div>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatQty(c.availableQty, 'kg')}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant={c.coilId === selectedCoilId ? 'default' : 'outline'}
                          aria-label={`Elegir ${c.code}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            choose(c.coilId);
                          }}
                        >
                          Elegir
                        </Button>
                      </TableCell>
                    </TableRow>
                  )),
                ])}
                {groups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      {loading
                        ? 'Cargando bobinas…'
                        : filter.trim() === ''
                          ? 'No hay bobinas disponibles para vender.'
                          : 'Ninguna bobina disponible coincide con ese texto.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {taken.length > 0 && (
            <section aria-label="Bobinas que no se ofrecen" className="grid gap-1">
              <p className="text-xs font-medium">No se ofrecen</p>
              <ul className="max-h-40 overflow-y-auto rounded-lg border p-2 text-xs text-muted-foreground">
                {taken.map((c) => (
                  <li key={c.coilId}>
                    <span className="font-medium text-foreground">{c.code}</span> ·{' '}
                    {c.thicknessMm} mm · {c.finishName} · {formatQty(c.balanceKg, 'kg')} —{' '}
                    {c.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {unavailable.isError && (
            <p className="text-xs text-destructive">
              No se pudo leer qué bobinas no se ofrecen; las disponibles de arriba sí son válidas.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
