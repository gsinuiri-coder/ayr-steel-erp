'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Advertencia de retrofecha fuera de orden (D-124).
 *
 * El API corta cuando lo que se está registrando queda **por detrás** de movimientos que el
 * ítem ya tiene, porque el saldo corrido del kardex se construye en el orden en que las
 * cosas se grabaron y ahí las dos vistas dejan de coincidir. La regla de la casa es cargar
 * el histórico en orden cronológico; esto es la salida de emergencia, y por eso repite el
 * detalle que mandó el API en vez de resumirlo: quien confirma tiene que ver contra qué.
 */
export function BackdateConfirmDialog({
  open,
  onOpenChange,
  detail,
  pending = false,
  costMismatch = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** El mensaje tal cual lo mandó el API: ítem, fecha pedida y fecha del más reciente. */
  detail: string;
  pending?: boolean;
  /**
   * cc52 (D-648): lo que se confirma es una **salida atrasada que cambiaría de costo**: sale al
   * promedio de hoy y no al que el ítem tenía a esa fecha. Solo un ADMINISTRADOR la registra igual.
   */
  costMismatch?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {costMismatch ? 'La salida cambiaría de costo' : 'La fecha queda fuera de orden'}
          </DialogTitle>
          <DialogDescription>{detail}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {costMismatch
            ? 'Hasta que exista el recosteo por fecha, el kardex valoriza la salida al promedio de hoy: el costo de ventas de esa fecha quedaría con el promedio equivocado. Solo un administrador puede registrarla igual, y queda en la auditoría con los dos costos.'
            : 'Registrarlo igual deja el kardex ordenado por fecha mostrando, para ese día, un saldo que no fue el de ese día. Lo recomendable es cancelar y cargar primero lo más antiguo.'}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            pending={pending}
            pendingText="Procesando…"
            onClick={() => {
              // F8-S1/M1: mismo guard que ReasonDialog — cubre el doble Enter, que el
              // `disabled` del DOM no atrapa si llega antes del repintado.
              if (pending) return;
              onConfirm();
            }}
          >
            Registrar igual
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
