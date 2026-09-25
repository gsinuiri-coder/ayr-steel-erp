'use client';

import type { ComponentProps, ReactNode } from 'react';
import { FormControl, FormItem, FormLabel, useFormField } from '@/components/ui/form';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * D-293: el modelo de formularios. Una **grilla de 12 columnas** con separación fija, en la que
 * cada campo (`FormCell`) tiene la misma anatomía —rótulo de altura fija, control, y un área de
 * ayuda/error con altura mínima reservada— y todo se alinea arriba (`items-start`).
 *
 * Por qué así. Los formularios crecían por copia: cada uno decidía a mano sus columnas, y un
 * texto de ayuda o de error debajo de un campo empujaba a sus vecinos —los controles de la misma
 * fila quedaban a distinta altura y, con la ayuda larga, se pisaban—. Con el rótulo y el área de
 * ayuda de tamaño reservado, la posición de un control **no depende** de lo que diga el
 * vecino: agregar o quitar un mensaje no mueve nada de la fila.
 *
 * Solo presentación: ningún componente de acá guarda estado ni valida nada.
 */

/** Ocupación de columnas de una celda (de 12). */
export type CellSpan = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * Se listan enteros para que Tailwind los vea como literales (una clase armada con `${}` no se
 * genera). Sin `md:`: el sistema es solo de escritorio (D-179).
 */
const SPAN: Record<CellSpan, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
  5: 'col-span-5',
  6: 'col-span-6',
  7: 'col-span-7',
  8: 'col-span-8',
  9: 'col-span-9',
  10: 'col-span-10',
  11: 'col-span-11',
  12: 'col-span-12',
};

/**
 * Ancho del control por token. Sin `size` el control ocupa toda la celda; los campos numéricos
 * usan un token (`w-24`, `w-32`, `w-40`) para que una cifra no se vea perdida en 300 px de
 * campo y las columnas de cifras de filas distintas midan lo mismo.
 */
export type ControlSize = 'sm' | 'md' | 'lg' | 'full';
const CONTROL_WIDTH: Record<ControlSize, string> = {
  sm: 'w-24',
  md: 'w-32',
  lg: 'w-40',
  full: 'w-full',
};

/** La grilla: 12 columnas, separación fija y todo alineado arriba. */
export function FormGrid({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="form-grid"
      className={cn('grid grid-cols-12 items-start gap-x-3 gap-y-1', className)}
      {...props}
    />
  );
}

/**
 * Una fila de la grilla: agrupa sus celdas y ocupa las 12 columnas. Es una grilla propia (no
 * una subgrilla) para que la separación de las celdas sea la misma dentro y fuera de ella.
 */
export function FormRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="form-row"
      className={cn('col-span-12 grid grid-cols-12 items-start gap-x-3', className)}
      {...props}
    />
  );
}

/** El área bajo el control: ayuda o error, con altura mínima siempre reservada. */
function HelpArea({
  id,
  error,
  help,
}: {
  id?: string;
  error?: string | null | undefined;
  help?: ReactNode;
}) {
  return (
    <div
      data-slot="form-cell-help"
      className="mt-1 min-h-4 w-full text-[11px] leading-4 break-words"
      id={id}
    >
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : help ? (
        <div className="text-muted-foreground">{help}</div>
      ) : null}
    </div>
  );
}

const CELL_CLASS = 'flex min-w-0 flex-col items-start';
/** Rótulo de altura fija: con `h-4` la fila arranca los controles a la misma altura. */
const LABEL_CLASS = 'mb-1 h-4 leading-4';

interface CellProps {
  /** Columnas de la grilla que ocupa (de 12). Por defecto 6. */
  span?: CellSpan;
  label: ReactNode;
  /** Ayuda estática bajo el control. Un error la reemplaza mientras exista. */
  help?: ReactNode;
  /** Ancho del control por token (`sm` 6 rem, `md` 8, `lg` 10, `full` toda la celda). */
  size?: ControlSize;
  /** Cifras alineadas en columnas (`tabular-nums`) y a la derecha. */
  numeric?: boolean;
  className?: string;
  children: ReactNode;
}

function controlClass(size: ControlSize, numeric: boolean): string {
  return cn(CONTROL_WIDTH[size], 'max-w-full', numeric && 'tabular-nums [&_input]:text-right');
}

/**
 * Celda de un formulario **sin react-hook-form** (estado local, como los formularios de
 * documento): `htmlFor` enlaza el rótulo con el control y `error` reemplaza a la ayuda.
 */
export function FormCell({
  span = 6,
  label,
  htmlFor,
  help,
  error,
  size = 'full',
  numeric = false,
  className,
  children,
}: CellProps & { htmlFor?: string; error?: string | null }) {
  return (
    <div data-slot="form-cell" className={cn(CELL_CLASS, SPAN[span], className)}>
      <Label htmlFor={htmlFor} className={LABEL_CLASS}>
        {label}
      </Label>
      <div className={controlClass(size, numeric)}>{children}</div>
      <HelpArea error={error} help={help} />
    </div>
  );
}

/** Ayuda/error de una celda con react-hook-form: el error sale del campo, no de una prop. */
function RhfHelp({ help }: { help?: ReactNode }) {
  const { error, formDescriptionId, formMessageId } = useFormField();
  return (
    <HelpArea
      id={error ? formMessageId : formDescriptionId}
      error={error ? (error.message ?? '') : null}
      help={help}
    />
  );
}

/**
 * Celda de un formulario **con react-hook-form**: va dentro de `<FormField render>`, en el lugar
 * de `FormItem`. El control se pasa con `<FormControl>` como hijo, igual que antes.
 *
 * (En la especificación de las correcciones 03 se llama `FormField`; se llama `FormCell` porque
 * `FormField` ya es el `Controller` de react-hook-form en `ui/form`, y los dos conviven en cada
 * formulario.)
 */
export function FormFieldCell({
  span = 6,
  label,
  help,
  size = 'full',
  numeric = false,
  className,
  children,
}: CellProps) {
  return (
    <FormItem data-slot="form-cell" className={cn(CELL_CLASS, 'gap-0', SPAN[span], className)}>
      <FormLabel className={LABEL_CLASS}>{label}</FormLabel>
      <div className={controlClass(size, numeric)}>{children}</div>
      <RhfHelp help={help} />
    </FormItem>
  );
}

export { FormControl };
