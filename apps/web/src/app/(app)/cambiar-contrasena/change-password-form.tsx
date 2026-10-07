'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Circle } from 'lucide-react';
import { changePasswordSchema, type AuthUser, type ChangePasswordInput } from '@ayr/shared';
import { api } from '@/lib/api';
import { errorMessage, toast } from '@/lib/notify';
import { ME_QUERY_KEY, useSession } from '@/lib/session';
import { AuthCard } from '@/components/auth-card';
import { PasswordInput } from '@/components/password-input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

/** El mínimo de `passwordSchema` (`@ayr/shared`); se muestra como regla que se marca al escribir. */
const MIN_LENGTH = 8;

/**
 * cc31: «Cambiar contraseña» en sus dos formas.
 *
 * - **Primer ingreso** (contraseña temporal): pantalla completa sin menú, «Elige tu contraseña»,
 *   reglas que se marcan al escribir y un enlace para salir e ingresar con otro usuario.
 * - **Desde el menú de usuario**: la misma tarjeta dentro de la app.
 */
export function ChangePasswordScreen() {
  const { user } = useSession();
  if (user.mustChangePassword) {
    return (
      <AuthCard title="Elige tu contraseña" subtitle={user.email}>
        <ChangePasswordForm firstLogin />
      </AuthCard>
    );
  }
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Cambiar contraseña</h1>
        <p className="text-muted-foreground">Elige una contraseña nueva.</p>
      </div>
      <Card className="max-w-md">
        <CardContent className="pt-6">
          <ChangePasswordForm firstLogin={false} />
        </CardContent>
      </Card>
    </>
  );
}

function Rule({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li
      className={
        ok
          ? 'flex items-center gap-1.5 text-tone-done-foreground'
          : 'flex items-center gap-1.5 text-muted-foreground'
      }
    >
      {ok ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Circle className="size-3.5" aria-hidden />
      )}
      <span>{children}</span>
      <span className="sr-only">{ok ? '(cumplida)' : '(pendiente)'}</span>
    </li>
  );
}

function ChangePasswordForm({ firstLogin }: { firstLogin: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { logout, isLoggingOut } = useSession();
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const [newPassword, confirmPassword] = useWatch({
    control: form.control,
    name: ['newPassword', 'confirmPassword'],
  });

  async function onSubmit(values: ChangePasswordInput) {
    try {
      await api('/auth/change-password', { method: 'POST', body: values });
      if (firstLogin) {
        // En el primer ingreso la pantalla cambia de marco (sin menú → con menú) al marcar la
        // sesión, y ese cambio se comía la navegación del router: el usuario quedaba en
        // «Cambiar contraseña». Una carga completa del Panel no depende de ese orden.
        window.location.replace('/');
        return;
      }
      // Primero se marca la sesión como ya cambiada y se navega; la recarga del usuario va
      // después. Al revés, la pantalla se redibujaba en modo normal antes de navegar y el
      // primer ingreso se quedaba en «Cambiar contraseña».
      queryClient.setQueryData<AuthUser>(ME_QUERY_KEY, (u) =>
        u ? { ...u, mustChangePassword: false } : u,
      );
      toast.success('Contraseña actualizada');
      router.replace('/');
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    } catch (err) {
      form.setError('root', {
        message: errorMessage(err, 'No se pudo cambiar la contraseña. Intenta de nuevo.'),
      });
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
        {firstLogin && (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              Entraste con una contraseña temporal. Cámbiala para continuar.
            </AlertDescription>
          </Alert>
        )}
        {form.formState.errors.root && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{form.formState.errors.root.message}</AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{firstLogin ? 'Contraseña temporal' : 'Contraseña actual'}</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Contraseña nueva</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Repite la contraseña nueva</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <ul className="grid gap-1 text-xs" aria-label="Requisitos de la contraseña">
          <Rule
            ok={newPassword.length >= MIN_LENGTH}
          >{`Al menos ${String(MIN_LENGTH)} caracteres`}</Rule>
          <Rule ok={newPassword.length > 0 && newPassword === confirmPassword}>
            Las dos contraseñas coinciden
          </Rule>
        </ul>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting
            ? 'Guardando…'
            : firstLogin
              ? 'Guardar y entrar'
              : 'Guardar contraseña'}
        </Button>
        {firstLogin && (
          <button
            type="button"
            className="text-center text-xs text-primary hover:underline"
            disabled={isLoggingOut}
            onClick={logout}
          >
            Salir e ingresar con otro usuario
          </button>
        )}
      </form>
    </Form>
  );
}
