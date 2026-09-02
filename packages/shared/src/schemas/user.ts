import { z } from 'zod';
import { ROLES } from '../enums';
import { emailSchema, passwordSchema } from './auth';

export const userSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
  name: z.string(),
  role: z.enum(ROLES),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserDto = z.infer<typeof userSchema>;

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(120, 'Máximo 120 caracteres');
const roleSchema = z.enum(ROLES, { errorMap: () => ({ message: 'Rol inválido' }) });

export const createUserSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  role: roleSchema,
  /** Contraseña temporal; el usuario deberá cambiarla al primer ingreso. */
  password: passwordSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: nameSchema,
    role: roleSchema,
    active: z.boolean(),
    /** Si se envía, resetea la contraseña y fuerza cambio al siguiente ingreso. */
    password: passwordSchema,
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
