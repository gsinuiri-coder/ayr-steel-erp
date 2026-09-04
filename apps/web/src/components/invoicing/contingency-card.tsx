'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FISCAL_DOC_TYPE_LABELS,
  Role,
  type FiscalSeriesDto,
  type InvoicingSettingsDto,
} from '@ayr/shared';
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
  // Las series son de ADMINISTRADOR; para el resto la consulta ni se hace.
  const series = useQuery({
    queryKey: ['invoicing-series'],
    queryFn: () => api<FiscalSeriesDto[]>('/invoicing/series'),
    enabled: isAdmin,
  });

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }
  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['invoicing-series'] });
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
  // Nada que decir: proveedor en línea, configurado, sin cola y sin nadie que pueda tocar
  // las series. Para un administrador la tarjeta se queda: las series son lo primero que
  // hay que mirar cuando el PSE rechaza por forma.
  if (!s.providerOffline && s.providerConfigured && pending === 0 && !isAdmin) return null;

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
        {/*
          Las series se muestran acá porque es donde se nota el problema: si el PSE no
          tiene autorizada la que usamos, **cada emisión se rechaza y gasta un
          correlativo**, y el mensaje que devuelve ("no puedes emitir comprobantes con esta
          serie") no dice dónde mirar. La autorización es por emisor, así que la serie es
          configuración, no una constante del sistema (D-072).
        */}
        {isAdmin && (series.data?.length ?? 0) > 0 && (
          <div className="space-y-1">
            <div className="text-muted-foreground">Series del punto de emisión</div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {(series.data ?? []).map((s) => (
                <li key={s.id} className={s.isActive ? undefined : 'text-muted-foreground'}>
                  <span className="font-medium">{s.series}</span>{' '}
                  <span className="text-muted-foreground">
                    {FISCAL_DOC_TYPE_LABELS[s.docType]}
                    {s.affectedDocType ? ` sobre ${FISCAL_DOC_TYPE_LABELS[s.affectedDocType]}` : ''}
                    {' · '}
                    {s.correlative === 0 ? 'sin emitir' : `último ${s.correlative}`}
                    {s.isActive ? '' : ' · inactiva'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Tienen que coincidir con las que el PSE autorizó para este RUC. Si no coinciden, se
              dan de alta las correctas desde el API (<code>POST /invoicing/series</code>) y la
              anterior queda inactiva.
            </p>
          </div>
        )}
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
