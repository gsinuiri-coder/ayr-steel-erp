import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard } from '@/components/auth-card';
import { DemoNotice } from '@/components/environment';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Ingresar' };

/** cc31: el ingreso — tarjeta centrada con el sello, el formulario y, en demo, el aviso. */
export default function LoginPage() {
  return (
    <AuthCard title="Ingresar" subtitle="Ingresa con tu correo y contraseña.">
      <DemoNotice />
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
