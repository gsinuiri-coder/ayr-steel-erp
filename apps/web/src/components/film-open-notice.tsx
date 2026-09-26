import type { CoilDto } from '@ayr/shared';

/**
 * D-328: el aviso de que continuar **abre** una bobina sellada. Lo llevan las cuatro operaciones
 * que usan la bobina por primera vez —montarla en una OP, mermarla, partirla, enviarla a corte—:
 * confirmar el diálogo en el que está es confirmar la apertura, y por eso el texto va pegado al
 * botón y dice qué va a pasar con el film (la reversa: bajarla de la OP o cancelar el envío sin
 * que nada haya salido la vuelve a sellar sola).
 *
 * Solo se muestra para una bobina vigente y sellada: una abierta —o una terminada— no tiene nada
 * que confirmar.
 */
export function FilmOpenNotice({
  coils,
  className,
}: {
  coils: Pick<CoilDto, 'code' | 'status' | 'film'>[];
  className?: string;
}) {
  const sealed = coils.filter((c) => c.status === 'OPEN' && c.film === 'SEALED');
  if (sealed.length === 0) return null;
  const single = sealed.length === 1;
  return (
    <p
      role="note"
      data-testid="film-open-notice"
      className={className ?? 'rounded-md bg-tone-warning p-3 text-sm text-tone-warning-foreground'}
    >
      {single ? (
        <>
          Esta bobina está sellada (<span className="font-mono">{sealed[0]?.code}</span>): al
          continuar se abre.
        </>
      ) : (
        <>
          {sealed.length} bobinas están selladas (
          <span className="font-mono">{sealed.map((c) => c.code).join(', ')}</span>): al continuar
          se abren.
        </>
      )}
    </p>
  );
}
