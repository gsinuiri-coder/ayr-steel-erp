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
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** El mensaje tal cual lo mandó el API: ítem, fecha pedida y fecha del más reciente. */
  detail: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>La fecha queda fuera de orden</DialogTitle>
          <DialogDescription>{detail}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Registrarlo igual deja el kardex ordenado por fecha mostrando, para ese día, un saldo que
          no fue el de ese día. Lo recomendable es cancelar y cargar primero lo más antiguo.
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
            onClick={() => {
              onConfirm();
            }}
          >
            {pending ? 'Procesando…' : 'Registrar igual'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
