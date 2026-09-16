'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  money,
  saleValueFromPrice,
  salePriceFromValue,
  toDecimal,
  toFixedString,
  type PriceListFloorDto,
  type ProductDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { formatMoney, isPositiveDecimal } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * D-217/M1b: edición inline del precio de lista en el catálogo (solo admin). Se tipea **con
 * IGV** y se muestra **sin IGV** debajo (D-162) — el mismo vocabulario que ya usa el resto de
 * la app. El piso de D-163 se consulta después de guardar y solo **avisa**: nunca bloquea acá,
 * la lista solo prellena la línea nueva (D-163 exime la lista misma).
 */
export function PriceListCell({
  product,
  isAdmin,
  onOpenHistory,
}: {
  product: ProductDto;
  isAdmin: boolean;
  onOpenHistory: (product: ProductDto) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: async (priceWithIgvPen: string) => {
      // Cadena vacía = "sin precio de lista" (D-068): se manda `null` directo, no se deriva
      // un valor sin IGV de la nada.
      const listPricePen =
        priceWithIgvPen === ''
          ? null
          : toFixedString(money(saleValueFromPrice(priceWithIgvPen)), 'MONEY');
      const updated = await api<ProductDto>(`/catalog/${product.id}`, {
        method: 'PATCH',
        body: { listPricePen },
      });
      // No bloquea: el piso solo prellena la línea nueva (D-163). Si la consulta falla, el
      // precio ya se guardó — no tiene sentido deshacerlo por no poder avisar.
      const floor = await api<PriceListFloorDto>(`/catalog/${product.id}/price-floor`).catch(
        () => null,
      );
      return { updated, floor };
    },
    onSuccess: ({ updated, floor }) => {
      toast.success(
        updated.listPricePen === null
          ? 'Precio de lista quitado'
          : `Precio de lista actualizado: ${formatMoney(priceWithIgv(updated))}`,
      );
      if (
        updated.listPricePen !== null &&
        floor?.minPricePen &&
        toDecimal(priceWithIgv(updated)).lt(toDecimal(floor.minPricePen))
      ) {
        toast.warning(
          `Queda por debajo del piso (mínimo ${formatMoney(floor.minPricePen)} por ${floor.priceUnitLabel}). No bloquea, pero una cotización nueva sí lo va a exigir.`,
        );
      }
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  });

  if (!isAdmin) {
    return <span className="tabular-nums">{formatListPrice(product)}</span>;
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="tabular-nums underline decoration-dotted underline-offset-4 hover:decoration-solid"
          onClick={() => {
            setValue(product.listPricePen === null ? '' : priceWithIgv(product));
            setEditing(true);
          }}
        >
          {formatListPrice(product)}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs text-muted-foreground"
          onClick={() => {
            onOpenHistory(product);
          }}
        >
          Historial
        </Button>
      </div>
    );
  }

  const valid = value.trim() === '' || isPositiveDecimal(value);
  return (
    <div className="flex items-center justify-end gap-1">
      <Input
        autoFocus
        inputMode="decimal"
        className="h-8 w-28 text-right"
        value={value}
        disabled={save.isPending}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button
        type="button"
        size="sm"
        className="h-8"
        disabled={save.isPending || !valid}
        pending={save.isPending}
        onClick={() => {
          if (!valid) return;
          save.mutate(value.trim());
        }}
      >
        Guardar
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8"
        disabled={save.isPending}
        onClick={() => {
          setEditing(false);
        }}
      >
        Cancelar
      </Button>
    </div>
  );
}

/** Con IGV, en la unidad de venta del SKU (D-217: no siempre coincide con la de negociación
 *  del pedido — acá siempre es la del catálogo, D-161 la traduce donde hace falta). */
function priceWithIgv(product: ProductDto): string {
  if (product.listPricePen === null) return '';
  return toFixedString(money(salePriceFromValue(product.listPricePen)), 'MONEY');
}

function formatListPrice(product: ProductDto): string {
  return product.listPricePen === null ? 'sin precio' : formatMoney(priceWithIgv(product));
}
