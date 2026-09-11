'use client';

import { useMemo, useState } from 'react';
import { ROOFING_THICKNESS_TOLERANCE_MM, type RoofingCoilOptionDto } from '@ayr/shared';
import { formatQty } from '@/lib/format';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { SearchSelectModal, type SearchSelectOption } from '@/components/search-select-modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Elegir la bobina a montar (D-159).
 *
 * Reemplaza a la lista de tarjetas —y al `<select>` de la terminal— por el mismo modal de
 * búsqueda con tabla que D-156 trajo para los maestros largos. El motivo es el mismo y el
 * dato es distinto: lo que decide cuál bobina montar no es un nombre sino cuatro cifras
 * —código, espesor, color y kilos disponibles— que hay que **comparar entre filas**, y una
 * lista de tarjetas apiladas no se compara: se recorre.
 *
 * No filtra nada por su cuenta: las bobinas que llegan ya vienen filtradas por el API
 * (`GET /production/roofing/coils`, D-086) y una que no aparezca acá tampoco se puede montar.
 */
export function CoilPicker({
  orderCode,
  productSku,
  options,
  loading,
  failed,
  pending,
  disabled = false,
  onMount,
}: {
  orderCode: string;
  productSku: string;
  options: readonly RoofingCoilOptionDto[];
  loading: boolean;
  failed: boolean;
  pending: boolean;
  disabled?: boolean | undefined;
  onMount: (coilId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const rows = useMemo<SearchSelectOption[]>(
    () =>
      options.map((c) => ({
        id: c.coilId,
        label: c.code,
        hint: `alcanza para ${c.estimatedMeters} m`,
        cells: [
          `${c.thicknessMm} mm`,
          <ColorSwatch
            key="color"
            color={c.colorName && c.colorHex ? { name: c.colorName, hexColor: c.colorHex } : null}
          />,
          formatQty(c.availableKg, 'kg'),
        ],
        // El color es un `<ColorSwatch>` y no texto: sin esto, filtrar por "ROJO" no encuentra
        // la bobina roja aunque la columna la esté mostrando.
        searchText: `${c.colorName ?? ''} ${c.widthMm} ${c.availableKg}`,
      })),
    [options],
  );

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
        Buscar y montar una bobina ({options.length})
      </Button>
      <SearchSelectModal
        open={open}
        title={`Bobinas para ${orderCode}`}
        description={`${String(options.length)} bobinas libres del espesor y el color de ${productSku}. Filtra por código, color o kilos.`}
        options={rows}
        columns={['Espesor', 'Color', 'kg disponibles']}
        actionLabel="Montar"
        onSelect={onMount}
        onOpenChange={setOpen}
      />
    </>
  );
}
