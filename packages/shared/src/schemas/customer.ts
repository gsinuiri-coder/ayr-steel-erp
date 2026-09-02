import { z } from 'zod';
import { DOC_TYPES } from '../enums';

/** Cadena vacía tras `trim()` se guarda como `null`, no como `''`. */
function emptyToNull(v: string | undefined): string | null {
  if (!v) return null;
  return v;
}

/** Clientes (RF-80, RF-82). */
export const customerSchema = z.object({
  id: z.string().uuid(),
  docType: z.enum(DOC_TYPES),
  docNumber: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  creditDays: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerDto = z.infer<typeof customerSchema>;

export const partyNameSchema = z
  .string()
  .trim()
  .min(2, 'Mínimo 2 caracteres')
  .max(160, 'Máximo 160 caracteres');
const nameSchema = partyNameSchema;
export const partyOptionalText = (max: number) =>
  z.string().trim().max(max, `Máximo ${max} caracteres`).optional().transform(emptyToNull);
const optionalText = partyOptionalText;
export const partyEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Correo inválido')
  .max(160)
  .optional()
  .or(z.literal(''))
  .transform(emptyToNull);
export const partyCreditDaysSchema = z.coerce
  .number()
  .int()
  .min(0, 'No puede ser negativo')
  .max(365, 'Máximo 365 días');
const creditDaysSchema = partyCreditDaysSchema;

export const docNumberLengths: Record<(typeof DOC_TYPES)[number], { min: number; max: number }> = {
  DNI: { min: 8, max: 8 },
  RUC: { min: 11, max: 11 },
  CE: { min: 6, max: 12 },
};

export const partySchema = z
  .object({
    docType: z.enum(DOC_TYPES, { errorMap: () => ({ message: 'Tipo de documento inválido' }) }),
    docNumber: z
      .string({ required_error: 'El número de documento es obligatorio' })
      .trim()
      .regex(/^[A-Z0-9]+$/i, 'Solo letras y números'),
    name: nameSchema,
    address: optionalText(240),
    email: partyEmailSchema,
    phone: optionalText(30),
    creditDays: creditDaysSchema,
  })
  .superRefine((d, ctx) => {
    const { min, max } = docNumberLengths[d.docType];
    if (d.docNumber.length < min || d.docNumber.length > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docNumber'],
        message:
          min === max
            ? `${d.docType} debe tener ${min} dígitos`
            : `${d.docType} debe tener entre ${min} y ${max} caracteres`,
      });
    }
  });

export const createCustomerSchema = partySchema;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: nameSchema,
    address: optionalText(240),
    email: partyEmailSchema,
    phone: optionalText(30),
    creditDays: creditDaysSchema,
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
