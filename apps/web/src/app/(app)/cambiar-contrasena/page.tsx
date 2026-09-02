import type { Metadata } from 'next';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Cambiar contraseña' };

export default function ChangePasswordPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Cambiar contraseña</h1>
        <p className="text-sm text-muted-foreground">
          Elige una contraseña nueva de al menos 8 caracteres.
        </p>
      </div>
      <ChangePasswordForm />
    </>
  );
}
