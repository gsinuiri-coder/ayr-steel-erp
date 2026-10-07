import * as React from 'react';

import { normalizeDecimalInput } from '@/lib/decimal-input';
import { cn } from '@/lib/utils';

/**
 * cc31: un campo `inputMode="decimal"` acepta coma decimal y separadores al escribir; al salir se
 * normaliza (`normalizeDecimalInput`) y se avisa como un cambio más, así el formulario —React Hook
 * Form o un `useState`— recibe el valor normalizado por su `onChange` de siempre.
 */
function normalizeOnBlur(input: HTMLInputElement) {
  const next = normalizeDecimalInput(input.value);
  if (next === input.value) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * El blur llega tarde para dos casos: un botón que se habilita según la validez del campo (con
 * «12,5» seguía apagado al bajar el mouse y el primer clic se perdía) y Enter dentro del campo
 * (enviaba la coma sin normalizar). Por eso también se normaliza el campo activo al bajar el
 * puntero en cualquier lado y al pulsar Enter, en captura, antes que nadie. Se instala una vez.
 */
let earlyNormalizeInstalled = false;
function installEarlyNormalize() {
  if (earlyNormalizeInstalled || typeof document === 'undefined') return;
  earlyNormalizeInstalled = true;
  const normalizeActive = () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && el.inputMode === 'decimal') normalizeOnBlur(el);
  };
  document.addEventListener('pointerdown', normalizeActive, true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') normalizeActive();
    },
    true,
  );
}

function Input({ className, type, onBlur, ...props }: React.ComponentProps<'input'>) {
  React.useEffect(() => {
    if (props.inputMode === 'decimal') installEarlyNormalize();
  }, [props.inputMode]);
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-[13px] dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      onBlur={(e) => {
        if (props.inputMode === 'decimal') normalizeOnBlur(e.currentTarget);
        onBlur?.(e);
      }}
      {...props}
    />
  );
}

/**
 * cc31: un campo con su unidad adentro («kg», «m», «S/»), a la derecha. La unidad es parte del
 * campo y no un texto suelto al lado: se lee junto a la cifra y no corre la grilla.
 *
 * cc32 (P3 de cc31): la unidad también entra en el nombre accesible —un lector de pantalla oía
 * «Peso» sin «kg»—. Con `aria-label` se le agrega; con una etiqueta `<label for>`, el campo se
 * nombra con la etiqueta y la unidad (`aria-labelledby`). La unidad visible sigue oculta para el
 * lector, así no se lee dos veces.
 */
/** El nombre con la unidad, salvo que ya la diga («Peso (kg) de la línea 1») o no haya unidad. */
function withUnit(label: string | undefined, unit: string): string | undefined {
  if (label === undefined || unit === '' || label.includes(`(${unit})`)) return label;
  return `${label} (${unit})`;
}

function InputWithUnit({
  unit,
  className,
  ref,
  ...props
}: React.ComponentProps<'input'> & { unit: string }) {
  const unitId = React.useId();
  const inner = React.useRef<HTMLInputElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      inner.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const named = props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined;
  React.useEffect(() => {
    const input = inner.current;
    if (!input || named) return;
    const label = input.id
      ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`)
      : input.closest('label');
    if (!label || unit === '' || label.textContent?.includes(`(${unit})`)) return;
    if (!label.id) label.id = `${unitId}-label`;
    input.setAttribute('aria-labelledby', `${label.id} ${unitId}`);
  }, [named, unitId, unit, props.id]);
  return (
    <div className="relative w-full">
      <Input
        ref={setRef}
        className={cn('pr-9', className)}
        {...props}
        aria-label={withUnit(props['aria-label'], unit)}
      />
      <span id={unitId} hidden>
        ({unit})
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground"
      >
        {unit}
      </span>
    </div>
  );
}

export { Input, InputWithUnit };
