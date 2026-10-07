'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type AuthUser, type LoginInput } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { crumbsFor } from '@/lib/breadcrumb';
import { errorMessage } from '@/lib/notify';
import { PasswordInput } from '@/components/password-input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

/** Segundos que se espera tras «demasiados intentos» (el límite del API es por minuto). */
const THROTTLE_WAIT_S = 60;

/** `next` solo si es una ruta propia: nada de `//otro-sitio` ni barras invertidas. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/';
}

/** El nombre de la pantalla a la que se vuelve, para el aviso de sesión vencida. */
export function screenName(path: string): string | null {
  const crumbs = crumbsFor(path.split('?')[0] ?? path);
  if (crumbs.leaf && crumbs.leaf !== 'document') return crumbs.leaf.title;
  if (crumbs.leaf === 'document' && crumbs.list) return `un documento de ${crumbs.list.title}`;
  return crumbs.list?.title ?? null;
}

/**
 * cc31: el texto propio de cada rechazo del ingreso. El API dice «Credenciales inválidas» y
 * «Usuario desactivado. Contacta al administrador.»; aquí se dice qué hacer.
 */
function loginErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return 'El correo o la contraseña no coinciden. Revisa y vuelve a intentar.';
    }
    if (err.status === 403) {
      return 'Tu usuario está desactivado. Pídele al administrador que lo active.';
    }
  }
  return errorMessage(err, 'No se pudo iniciar sesión. Intenta de nuevo.');
}

function countdown(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const next = safeNext(params.get('next'));
  // La sesión se cortó sin que el usuario saliera (`SessionProvider` agrega `expired=1`).
  const returnTo = params.get('expired') === '1' && next !== '/' ? screenName(next) : null;

  useEffect(() => {
    if (waitUntil === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setWaitUntil(null);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [waitUntil]);

  async function onSubmit(values: LoginInput) {
    setError(null);
    try {
      const { user } = await api<{ user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: values,
        noRefresh: true,
      });
      router.replace(user.mustChangePassword ? '/cambiar-contrasena' : next);
      router.refresh();
    } catch (err) {
      setError(loginErrorText(err));
      if (err instanceof ApiError && err.status === 429) {
        setWaitUntil(Date.now() + THROTTLE_WAIT_S * 1000);
      }
    }
  }

  const waiting = waitUntil !== null && remaining > 0;
  const submitting = form.formState.isSubmitting;
  let label = 'Ingresar';
  if (submitting) label = 'Ingresando…';
  else if (waiting) label = `Ingresar en ${countdown(remaining)}`;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!error && returnTo && (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              Tu sesión venció. Ingresa de nuevo y vuelves a <b>{returnTo}</b>.
            </AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Correo electrónico</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="username" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Contraseña</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={submitting || waiting}>
          {label}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          ¿Olvidaste tu contraseña? Pídele una temporal al administrador.
        </p>
      </form>
    </Form>
  );
}
