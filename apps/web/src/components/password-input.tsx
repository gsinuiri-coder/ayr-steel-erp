'use client';

import { forwardRef, useState, type ComponentProps, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * cc31: campo de contraseña con «Mostrar» y aviso de Bloq Mayús. El aviso sale mientras el campo
 * tiene el foco y la tecla está activa: una contraseña rechazada por las mayúsculas era el error
 * más difícil de ver.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<ComponentProps<'input'>, 'type'>>(
  function PasswordInput({ className, onKeyDown, onKeyUp, onBlur, id, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    const [capsLock, setCapsLock] = useState(false);
    const track = (e: KeyboardEvent<HTMLInputElement>) => {
      setCapsLock(e.getModifierState('CapsLock'));
    };
    return (
      <div className="grid gap-1">
        <div className="relative">
          <Input
            ref={ref}
            id={id}
            type={visible ? 'text' : 'password'}
            className={cn('pr-16', className)}
            onKeyDown={(e) => {
              track(e);
              onKeyDown?.(e);
            }}
            onKeyUp={(e) => {
              track(e);
              onKeyUp?.(e);
            }}
            onBlur={(e) => {
              setCapsLock(false);
              onBlur?.(e);
            }}
            {...props}
          />
          <button
            type="button"
            className="absolute inset-y-0 right-0 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-label={visible ? 'Ocultar la contraseña' : 'Mostrar la contraseña'}
            aria-pressed={visible}
            onClick={() => {
              setVisible((v) => !v);
            }}
          >
            {visible ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>
        {capsLock && (
          <p role="status" className="text-xs text-tone-warning-foreground">
            Bloq Mayús está activado.
          </p>
        )}
      </div>
    );
  },
);
