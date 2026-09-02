import { z } from 'zod';
import { decimalStringSchema } from '../decimal';

/** Acabados de bobina (RF-25), con su factor de densidad (Decimal 10,4 — D-003). */
export const finishSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  densityFactor: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FinishDto = z.infer<typeof finishSchema>;

const codeSchema = z
  .string({ required_error: 'El código es obligatorio' })
  .trim()
  .toUpperCase()
  .min(1, 'Mínimo 1 carácter')
  .max(20, 'Máximo 20 caracteres')
  .regex(/^[A-Z0-9-]+$/, 'Solo letras, números y guiones');
const nameSchema = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(120, 'Máximo 120 caracteres');

export const createFinishSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  densityFactor: decimalStringSchema('RATE', { positive: true }),
});
export type CreateFinishInput = z.infer<typeof createFinishSchema>;

export const updateFinishSchema = z
  .object({
    name: nameSchema,
    densityFactor: decimalStringSchema('RATE', { positive: true }),
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateFinishInput = z.infer<typeof updateFinishSchema>;
