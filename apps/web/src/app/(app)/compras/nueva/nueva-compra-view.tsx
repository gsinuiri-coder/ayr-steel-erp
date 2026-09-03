'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PURCHASE_TYPE_LABELS, PURCHASE_TYPES, PurchaseType, Role } from '@ayr/shared';
import { Button } from '@/components/ui/button';
import { RoleGate } from '@/components/role-gate';
import { defaultPurchaseValues, PurchaseForm } from '../purchase-form';

function typeFromQuery(raw: string | null): PurchaseType {
  const upper = (raw ?? '').toUpperCase();
  return PURCHASE_TYPES.includes(upper as PurchaseType)
    ? (upper as PurchaseType)
    : PurchaseType.COIL;
}

/** Alta manual de compra (RF-10 para bobinas, D-030 para el resto). */
export function NuevaCompraView() {
  const params = useSearchParams();
  const type = typeFromQuery(params.get('tipo'));
  // Vincular el costo de un corte tercerizado (RF-41) reusa el flujo normal de compras:
  // `/corte/[id]` linkea acá con la orden y la línea de negocio ya elegidas.
  const ordenCorte = params.get('ordenCorte') ?? undefined;
  const businessLine = params.get('linea') ?? undefined;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]}>
      <div>
        <h1 className="text-2xl font-semibold">Nueva compra</h1>
        <p className="text-sm text-muted-foreground">
          {PURCHASE_TYPE_LABELS[type]}. La compra se registra como borrador; el stock se mueve
          recién al recibirla.
        </p>
      </div>

      {type === PurchaseType.COIL && (
        <p className="text-sm text-muted-foreground">
          ¿Tienes el XML de la factura del proveedor?{' '}
          <Button variant="link" className="h-auto p-0" asChild>
            <Link href="/bobinas/nueva-xml">Súbelo y se prellena solo (RF-11)</Link>
          </Button>
          .
        </p>
      )}

      <PurchaseForm
        key={`${type}-${ordenCorte ?? ''}`}
        initialValues={defaultPurchaseValues(type, {
          businessLine,
          serviceKind: ordenCorte ? 'CUTTING' : undefined,
          relatedCuttingOrderId: ordenCorte,
        })}
      />
    </RoleGate>
  );
}
