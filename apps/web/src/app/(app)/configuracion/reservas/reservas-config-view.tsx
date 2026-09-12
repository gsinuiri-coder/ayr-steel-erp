'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MAX_TEMPORARY_RESERVATION_BUSINESS_DAYS, Role, type SalesSettingsDto } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

const SETTINGS_QUERY_KEY = ['sales-settings'] as const;

/** D-185: cuántos días hábiles dura una reserva temporal. Solo ADMINISTRADOR la cambia. */
export function ReservasConfigView() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api<SalesSettingsDto>('/sales/settings'),
  });
  const [days, setDays] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (value: number) =>
      api<SalesSettingsDto>('/sales/settings', {
        method: 'PUT',
        body: { temporaryReservationBusinessDays: value },
      }),
    onSuccess: (updated) => {
      toast.success(
        `Las reservas temporales nuevas duran ${String(updated.temporaryReservationBusinessDays)} días hábiles`,
      );
      setDays(null);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar la configuración'),
  });

  if (settings.isPending) return <Skeleton className="h-40 w-full" />;
  if (settings.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No se pudo cargar la configuración.</AlertDescription>
      </Alert>
    );
  }

  const value = days ?? String(settings.data.temporaryReservationBusinessDays);
  const parsed = Number(value);
  const valid =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TEMPORARY_RESERVATION_BUSINESS_DAYS;

  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Duración de la reserva temporal</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Una cotización reservada aparta su material hasta el final del último día hábil (lunes a
            viernes) contado desde el día en que se reservó. Cambiar este número solo afecta a las
            reservas que se hagan desde ahora.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="reservation-days">Días hábiles</Label>
            <Input
              id="reservation-days"
              inputMode="numeric"
              className="w-32"
              value={value}
              onChange={(e) => {
                setDays(e.target.value);
              }}
            />
            {!valid && (
              <p className="text-sm text-destructive">
                Un número entero de 1 a {MAX_TEMPORARY_RESERVATION_BUSINESS_DAYS}.
              </p>
            )}
          </div>
          <Button
            className="justify-self-start"
            disabled={!valid || days === null}
            pending={save.isPending}
            pendingText="Guardando…"
            onClick={() => {
              if (save.isPending || !valid) return;
              save.mutate(parsed);
            }}
          >
            Guardar
          </Button>
        </CardContent>
      </Card>
    </RoleGate>
  );
}
