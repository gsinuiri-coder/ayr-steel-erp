'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Role, type InvoicingSettingsDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * El interruptor de contingencia y el barrido manual (D-073).
 *
 * Existen en la UI porque son operativos, no de mantenimiento: durante una caída conocida
 * del PSE alguien tiene que poder decir "dejen de intentar" sin tocar credenciales, y
 * después "prueben ahora" sin esperar los quince minutos del job.
 *
 * Solo ADMINISTRADOR, y solo se muestra cuando hay algo que decir: con el proveedor en
 * línea y sin pendientes, la tarjeta se esconde para no ocupar la pantalla con un estado
 * que ya es el normal.
 */
export function ContingencyCard() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;

  const settings = useQuery({
    queryKey: ['invoicing-settings'],
    queryFn: () => api<InvoicingSettingsDto>('/invoicing/settings'),
  });
  const alerts = useQuery({
    queryKey: ['invoicing-alerts'],
    queryFn: () => api<{ pending: number; stalled: number }>('/invoicing/alerts'),
  });

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }
  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['invoicing-settings'] });
    void queryClient.invalidateQueries({ queryKey: ['invoicing-alerts'] });
    void queryClient.invalidateQueries({ queryKey: ['fiscal-documents'] });
  }

  const toggle = useMutation({
    mutationFn: (providerOffline: boolean) =>
      api<InvoicingSettingsDto>('/invoicing/settings', {
        method: 'PATCH',
        body: { providerOffline },
      }),
    onSuccess: (updated) => {
      toast.success(
        updated.providerOffline
          ? 'Contingencia activada: los comprobantes toman número y quedan encolados'
          : 'Contingencia desactivada: los envíos vuelven a salir al PSE',
      );
      refresh();
    },
    onError,
  });

  const sweep = useMutation({
    mutationFn: () => api<{ sent: number }>('/invoicing/send-pending', { method: 'POST' }),
    onSuccess: (result) => {
      toast.success(
        result.sent === 0
          ? 'No había nada pendiente de enviar'
          : `Se reintentaron ${result.sent} documentos`,
      );
      refresh();
    },
    onError,
  });

  const s = settings.data;
  const pending = alerts.data?.pending ?? 0;
  if (!s) return null;
  // Nada que decir: proveedor en línea, configurado y sin cola.
  if (!s.providerOffline && s.providerConfigured && pending === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Estado del envío al PSE</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!s.providerConfigured && (
          <Alert>
            <AlertDescription>
              No hay proveedor de facturación configurado. Los comprobantes se emiten y toman número
              igual —el despacho no se detiene—, pero quedan pendientes de envío hasta que se
              configuren las credenciales.
            </AlertDescription>
          </Alert>
        )}
        {s.providerOffline && (
          <Alert>
            <AlertDescription>
              <strong>Contingencia activada.</strong> No se está llamando al PSE. Los comprobantes
              siguen tomando correlativo y habilitando el despacho; el envío se reintenta cuando se
              desactive.
            </AlertDescription>
          </Alert>
        )}
        <p className="text-muted-foreground">
          Proveedor: {s.providerName}. {pending === 0 ? 'Sin' : pending} documento
          {pending === 1 ? '' : 's'} pendiente{pending === 1 ? '' : 's'} de aceptación. Se avisa a
          partir de las {s.alertAfterHours} horas.
        </p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={s.providerOffline ? 'default' : 'outline'}
              size="sm"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate(!s.providerOffline);
              }}
            >
              {s.providerOffline ? 'Desactivar contingencia' : 'Activar contingencia'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={sweep.isPending || pending === 0}
              onClick={() => {
                sweep.mutate();
              }}
            >
              Reintentar pendientes ahora
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
