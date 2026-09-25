'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

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

  /**
   * D-153: el modo con el que viene pre-seleccionado el terminal de un borrador mientras dura
   * la migración desde la otra app. **No decide nada por sí solo** — los dos botones siguen a
   * la vista en cada comprobante; esto solo evita elegir el mismo modo setenta veces.
   */
  const toggleManual = useMutation({
    mutationFn: (manualByDefault: boolean) =>
      api<InvoicingSettingsDto>('/invoicing/settings', {
        method: 'PATCH',
        body: { manualByDefault },
      }),
    onSuccess: (updated) => {
      toast.success(
        updated.manualByDefault
          ? 'Los comprobantes vienen preparados para registro manual'
          : 'Los comprobantes vuelven a venir preparados para emisión electrónica',
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
  const pendingCount = alerts.data?.pending ?? 0;
  const busy = toggle.isPending || toggleManual.isPending || sweep.isPending;
  if (!s) return null;
  // Nada que decir: proveedor en línea, configurado, sin cola y sin nadie que pueda tocar
  // las series. Para un administrador la tarjeta se queda: las series son lo primero que
  // hay que mirar cuando el PSE rechaza por forma.
  if (
    s.pseEnabled &&
    !s.providerOffline &&
    s.providerConfigured &&
    pendingCount === 0 &&
    !isAdmin
  ) {
    return null;
  }

  // D-292: el bloque que encabezaba `/comprobantes` pasa a un modal detrás de ⓘ; en la cabecera
  // quedan solo los badges. Lo que es aviso de negocio condicional —la contingencia activada—
  // sigue a la vista como badge (criterio de D-178: ocultar detrás de un clic un aviso que
  // pide acción es el error).
  return (
    <div className="flex items-center gap-2" data-testid="pse-status">
      <Badge variant={s.pseEnabled ? 'done' : 'outline'}>
        Emisión electrónica: {s.pseEnabled ? 'activa' : 'apagada'}
      </Badge>
      {s.providerOffline && <Badge variant="warning">Contingencia activada</Badge>}
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Estado del envío al PSE">
            <Info aria-hidden />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Estado del envío al PSE</DialogTitle>
            <DialogDescription>
              Emisión electrónica, contingencia y series del punto de emisión.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {!s.pseEnabled && (
              <Alert>
                <AlertDescription>
                  <strong>Emisión electrónica no habilitada.</strong> Este entorno tiene el PSE
                  apagado a propósito: toda emisión, anulación o guía electrónica se rechaza antes
                  de tomar correlativo. Los comprobantes manuales no se ven afectados.
                </AlertDescription>
              </Alert>
            )}
            {s.pseEnabled && !s.providerConfigured && (
              <Alert>
                <AlertDescription>
                  No hay proveedor de facturación configurado. Los comprobantes se emiten y toman
                  número igual —el despacho no se detiene—, pero quedan pendientes de envío hasta
                  que se configuren las credenciales.
                </AlertDescription>
              </Alert>
            )}
            {s.providerOffline && (
              <Alert>
                <AlertDescription>
                  <strong>Contingencia activada.</strong> No se está llamando al PSE. Los
                  comprobantes siguen tomando correlativo y habilitando el despacho; el envío se
                  reintenta cuando se desactive.
                </AlertDescription>
              </Alert>
            )}
            {s.manualByDefault && (
              <Alert>
                <AlertDescription>
                  <strong>Modo manual por defecto.</strong> Los borradores vienen preparados para
                  registrarse con el número del comprobante emitido en la otra app. Los dos botones
                  siguen disponibles en cada comprobante: esto solo cambia cuál viene destacado.
                </AlertDescription>
              </Alert>
            )}
            {isAdmin && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={s.manualByDefault}
                  disabled={busy}
                  onChange={(e) => {
                    if (busy) return;
                    toggleManual.mutate(e.target.checked);
                  }}
                />
                Registro manual por defecto (mientras dure la migración desde la otra app)
              </label>
            )}
            <p className="text-muted-foreground">
              Proveedor: {s.providerName}. {pendingCount === 0 ? 'Sin' : pendingCount} documento
              {pendingCount === 1 ? '' : 's'} pendiente{pendingCount === 1 ? '' : 's'} de
              aceptación. Se avisa a partir de las {s.alertAfterHours} horas.
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
                        {s.affectedDocType
                          ? ` sobre ${FISCAL_DOC_TYPE_LABELS[s.affectedDocType]}`
                          : ''}
                        {' · '}
                        {s.correlative === 0 ? 'sin emitir' : `último ${s.correlative}`}
                        {s.isActive ? '' : ' · inactiva'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Tienen que coincidir con las que el PSE autorizó para este RUC. Si no coinciden,
                  se dan de alta las correctas desde el API (<code>POST /invoicing/series</code>) y
                  la anterior queda inactiva.
                </p>
              </div>
            )}
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={s.providerOffline ? 'default' : 'outline'}
                  size="sm"
                  disabled={busy}
                  pending={toggle.isPending}
                  onClick={() => {
                    if (busy) return;
                    toggle.mutate(!s.providerOffline);
                  }}
                >
                  {s.providerOffline ? 'Desactivar contingencia' : 'Activar contingencia'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || pendingCount === 0 || !s.pseEnabled}
                  title={s.pseEnabled ? undefined : 'Emisión electrónica no habilitada'}
                  pending={sweep.isPending}
                  pendingText="Reintentando…"
                  onClick={() => {
                    if (busy) return;
                    sweep.mutate();
                  }}
                >
                  Reintentar pendientes ahora
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
