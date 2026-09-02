'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PURCHASE_TYPE_LABELS, PURCHASE_TYPES, PurchaseType } from '@ayr/shared';
import { Button } from '@/components/ui/button';
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

  return (
    <>
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

      <PurchaseForm key={type} initialValues={defaultPurchaseValues(type)} />
    </>
  );
}
