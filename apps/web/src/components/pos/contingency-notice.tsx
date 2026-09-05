'use client';

import type { PosContextDto } from '@ayr/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Aviso de contingencia del PSE (D-102).
 *
 * Mientras producción corra sin credenciales del PSE (D-080) **toda** emisión cae en la
 * contingencia de D-073: la venta se cierra igual, la mercadería sale igual y el
 * comprobante queda pendiente de envío hasta que el job lo entregue. Eso es correcto y
 * está diseñado así, pero en un mostrador hay alguien esperando su boleta: decirlo antes
 * de cobrar es la diferencia entre una operación conocida y un cliente preguntando por un
 * papel que no llega.
 *
 * Se muestra en dos casos distintos y el texto los separa, porque la salida es distinta:
 * sin PSE configurado no hay nada que hacer desde la aplicación; con el interruptor manual
 * levantado, un administrador lo baja desde `/comprobantes`.
 */
export function ContingencyNotice({ context }: { context: PosContextDto }) {
  if (context.providerConfigured && !context.providerOffline) return null;

  return (
    <Alert>
      <AlertTitle>Comprobantes en contingencia</AlertTitle>
      <AlertDescription>
        {context.providerConfigured
          ? 'El envío al PSE está en contingencia manual: las ventas se cierran y los comprobantes toman su número, pero quedan pendientes de envío hasta que un administrador baje el interruptor en Comprobantes.'
          : 'Este entorno no tiene proveedor de facturación electrónica configurado: las ventas se cierran y los comprobantes toman su número y su serie, pero quedan pendientes de envío a SUNAT. Se envían solos en cuanto haya credenciales.'}
      </AlertDescription>
    </Alert>
  );
}
