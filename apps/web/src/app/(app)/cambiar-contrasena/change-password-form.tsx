'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { changePasswordSchema, type ChangePasswordInput } from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { ME_QUERY_KEY, useSession } from '@/lib/session';
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
import { Input } from '@/components/ui/input';

export function ChangePasswordForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  async function onSubmit(values: ChangePasswordInput) {
    try {
      await api('/auth/change-password', { method: 'POST', body: values });
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      toast.success('Contraseña actualizada');
      router.replace('/');
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'No se pudo cambiar la contraseña. Intenta de nuevo.';
      form.setError('root', { message });
    }
  }

  return (
    <Card className="max-w-md">
      <CardContent className="pt-6">
        {user.mustChangePassword && (
          <Alert className="mb-4">
            <AlertDescription>
              Debes cambiar tu contraseña temporal antes de continuar.
            </AlertDescription>
          </Alert>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" noValidate>
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
                  <FormLabel>Contraseña actual</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="current-password" {...field} />
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
                  <FormLabel>Nueva contraseña</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
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
                  <FormLabel>Confirmar nueva contraseña</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? 'Guardando…' : 'Guardar contraseña'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
