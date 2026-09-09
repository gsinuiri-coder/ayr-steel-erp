'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BusinessLine, BusinessLineDto, CustomerDto, ProductDto } from '@ayr/shared';
import { BUSINESS_LINE_LABELS } from '@ayr/shared';
import { api } from '@/lib/api';
import { ProductDialog } from '@/components/catalog/product-dialog';
import { CustomerDialog } from '@/components/customers/customer-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

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

/**
 * Igual, con un paso previo: un producto **necesita su línea de negocio** antes de que el
 * formulario sepa qué campos pedir (D-118/D-122 — una cobertura lleva acabado, color,
 * espesor y subtipo; un perfil de drywall, ancho, largo y peso). El importador no puede
 * deducirla de un SKU que no está en el maestro, así que se pregunta; una fila de cotización
 * que ya eligió su línea la pasa en `businessLine` y el paso se saltea.
 */
export function ExpressCreateProduct({
  initial,
  businessLine,
  disabled,
  onCreated,
}: {
  initial?: { sku?: string; name?: string };
  /** Código de la línea cuando el llamador ya la sabe: se salta el paso de elegirla. */
  businessLine?: BusinessLine;
  disabled?: boolean;
  onCreated: (product: ProductDto) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [line, setLine] = useState<BusinessLineDto | null>(null);

  const lines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
    enabled: picking,
  });

  // Con la línea dada, el paso de elegirla no se muestra: se resuelve en cuanto llega el
  // maestro. Sigue haciendo falta la consulta porque `ProductDialog` necesita el **id**, y
  // lo que el llamador tiene es el código.
  const preset =
    businessLine === undefined
      ? null
      : ((lines.data ?? []).find((l) => l.code === businessLine) ?? null);
  const chosen = line ?? preset;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 text-xs"
        disabled={disabled}
        onClick={() => {
          setPicking(true);
        }}
      >
        + Crear producto
      </Button>

      <Dialog
        open={picking && chosen === null && businessLine === undefined}
        onOpenChange={(next) => {
          if (!next) setPicking(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>¿De qué línea es el producto?</DialogTitle>
            <DialogDescription>
              La línea decide qué datos pide el SKU: una cobertura lleva acabado, color y espesor;
              un perfil de drywall, ancho, largo y peso por pieza.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Línea de negocio</Label>
            {lines.isPending && <p className="text-sm text-muted-foreground">Cargando…</p>}
            {lines.isError && (
              <p className="text-sm text-destructive">No se pudieron cargar las líneas.</p>
            )}
            {lines.isSuccess && lines.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hay ninguna línea de negocio dada de alta: créala primero desde Líneas.
              </p>
            )}
            {(lines.data ?? []).map((l) => (
              <Button
                key={l.id}
                variant="outline"
                className="justify-start"
                onClick={() => {
                  setLine(l);
                }}
              >
                {BUSINESS_LINE_LABELS[l.code]}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {picking && chosen !== null && (
        <ProductDialog
          open
          businessLineId={chosen.id}
          businessLineCode={chosen.code}
          initial={initial}
          onCreated={onCreated}
          onOpenChange={(next) => {
            if (!next) {
              setLine(null);
              setPicking(false);
            }
          }}
        />
      )}
    </>
  );
}
