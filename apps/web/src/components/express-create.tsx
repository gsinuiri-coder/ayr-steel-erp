'use client';

import { useState } from 'react';
import type { CustomerDto } from '@ayr/shared';
import { CustomerDialog } from '@/components/customers/customer-dialog';
import { Button } from '@/components/ui/button';

/**
 * El alta express de un maestro, sin salir de la pantalla que la necesita (D-156).
 *
 * Es la respuesta al **callejón**: una pantalla que exige elegir un cliente o un SKU que
 * todavía no existe, y cuya única salida era irse al maestro, darlo de alta y volver — con
 * el trabajo de la pantalla perdido en el camino. Acá el botón abre **el mismo formulario de
 * alta**, con sus mismas validaciones y su mismo endpoint: no hay una segunda ruta de
 * creación "rápida" que se salte reglas, que es lo que D-138 hizo y D-152 tuvo que deshacer.
 * Lo único que agrega es que el nuevo registro vuelva al llamador para rellenar el campo.
 *
 * El estado de la pantalla que abre el diálogo **no se toca**: nadie navega y nadie
 * desmonta nada.
 */

export function ExpressCreateCustomer({
  initial,
  disabled,
  onCreated,
}: {
  /** Lo que la fila ya sabe del cliente: no se vuelve a tipear. */
  initial?: { docNumber?: string; name?: string };
  disabled?: boolean;
  onCreated: (customer: CustomerDto) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 text-xs"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
        }}
      >
        + Crear cliente
      </Button>
      {/* Montado solo mientras está abierto: así el formulario nace con los valores de
          ESTA fila y no con los de la anterior — `defaultValues` se lee al montar. */}
      {open && (
        <CustomerDialog
          open
          initial={initial}
          onCreated={onCreated}
          onOpenChange={(next) => {
            setOpen(next);
          }}
        />
      )}
    </>
  );
}
