import { z } from 'zod';
import { ROLES } from '../enums';

export const emailSchema = z
  .string({ required_error: 'El correo es obligatorio' })
  .trim()
  .toLowerCase()
  .email('Correo inválido')
  .max(160, 'Máximo 160 caracteres');

export const passwordSchema = z
  .string({ required_error: 'La contraseña es obligatoria' })
  .min(8, 'Mínimo 8 caracteres')
  .max(128, 'Máximo 128 caracteres');

export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ required_error: 'La contraseña es obligatoria' })
    .min(1, 'La contraseña es obligatoria'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Ingresa tu contraseña actual'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirma la nueva contraseña'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Las contraseñas no coinciden',
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    path: ['newPassword'],
    message: 'La nueva contraseña debe ser distinta a la actual',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Perfil del usuario autenticado (respuesta de GET /auth/me y POST /auth/login). */
export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
  name: z.string(),
  role: z.enum(ROLES),
  mustChangePassword: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;
