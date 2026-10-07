import type { Metadata } from 'next';
import { ChangePasswordScreen } from './change-password-form';

export const metadata: Metadata = { title: 'Cambiar contraseña' };

export default function ChangePasswordPage() {
  return <ChangePasswordScreen />;
}
