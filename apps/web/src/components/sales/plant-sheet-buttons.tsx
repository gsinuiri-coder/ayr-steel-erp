'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Hoja de planta del pedido (D-149): descargarla y —en el teléfono— compartirla.
 *
 * La descarga es un `<a>` directo contra el API, igual que el PDF de la cotización (D-068):
 * el proxy `/api/*` reenvía el binario y el navegador se encarga del resto.
 *
 * El botón de compartir **solo aparece si el navegador puede compartir archivos**. La Web
 * Share API existe en el móvil y casi nunca en el escritorio, y `navigator.share` sin
 * `canShare({ files })` falla en el momento de compartir y no antes — mostrar un botón que
 * revienta al apretarlo es peor que no mostrarlo. La comprobación va en un efecto porque en
 * el servidor no hay `navigator` y el primer render tiene que coincidir con el del cliente.
 */
export function PlantSheetButtons({ orderId, code }: { orderId: string; code: string }) {
  const [canShare, setCanShare] = useState(false);
  const [sharing, setSharing] = useState(false);
  const href = `/api/sales/orders/${orderId}/pdf-planta`;

  useEffect(() => {
    // `canShare` con un archivo de muestra: es la única forma de saber si este navegador
    // comparte **archivos** y no solo texto.
    const probe = new File([new Blob([''], { type: 'application/pdf' })], 'x.pdf', {
      type: 'application/pdf',
    });
    setCanShare(typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] }));
  }, []);

  async function share(): Promise<void> {
    setSharing(true);
    try {
      // Un `fetch` crudo se salta el refresh-y-reintento de `@/lib/api` (que devuelve JSON y
      // no sirve para un binario). Con el token de acceso vencido —dura poco, D-010— el 401
      // dejaba al usuario con "no se pudo compartir" y sin más salida que recargar, así que
      // el reintento se hace acá a mano, una sola vez.
      let res = await fetch(href, { credentials: 'include', cache: 'no-store' });
      if (res.status === 401) {
        await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        res = await fetch(href, { credentials: 'include', cache: 'no-store' });
      }
      if (!res.ok) throw new Error(`El API respondió ${String(res.status)}`);
      const file = new File([await res.blob()], `${code}-planta.pdf`, { type: 'application/pdf' });
      await navigator.share({ files: [file], title: `${code} — hoja de planta` });
    } catch (err) {
      // Cancelar el diálogo del sistema llega como `AbortError`: no es un fallo del que
      // haya que avisar, es el usuario diciendo que no.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error('No se pudo compartir la hoja de planta');
    } finally {
      setSharing(false);
    }
  }

  return (
    <>
      <Button variant="outline" asChild>
        <a href={href}>Hoja de planta (PDF)</a>
      </Button>
      {canShare && (
        <Button
          variant="outline"
          disabled={sharing}
          onClick={() => {
            void share();
          }}
        >
          {sharing ? 'Preparando…' : 'Compartir'}
        </Button>
      )}
    </>
  );
}
