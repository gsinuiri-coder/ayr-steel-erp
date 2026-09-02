import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Iniciar sesión' };

export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase">
            AYR Steel
          </p>
          <h1 className="text-2xl font-semibold">Iniciar sesión</h1>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
