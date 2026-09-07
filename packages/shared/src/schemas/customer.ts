import { z } from 'zod';
import { DOC_TYPES } from '../enums';
import { paginationQuerySchema } from './pagination';

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
  /**
   * D-137: lo creó una importación con el padrón de SUNAT caído, así que su nombre es el
   * que traía el archivo y le falta todo lo demás. **Se expone** porque la carga de un mes
   * crea decenas de estos, y "cuáles hay que completar" es una pregunta que alguien va a
   * hacer semanas después, cuando ya nadie recuerde qué import los creó.
   */
  needsReview: z.boolean(),
  /**
   * D-077: cliente sembrado por el sistema ("PÚBLICO EN GENERAL"). Viaja al web para que
   * la UI no ofrezca editarlo ni darlo de baja; el API lo rechaza igual, esto es la
   * cortesía de no mostrar un botón que va a fallar.
   */
  isSystem: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerDto = z.infer<typeof customerSchema>;

/**
 * Listado paginado de clientes (Fase 7d, D-113). El filtro de texto se mueve al servidor
 * junto con la paginación: filtrar en el navegador solo funciona mientras se trae la tabla
 * entera, que es exactamente lo que dejó de pasar. Los inactivos se siguen trayendo (el
 * orden ya los manda al final): son los que un administrador tiene que poder reactivar.
 */
export const customerQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
});
export type CustomerQuery = z.infer<typeof customerQuerySchema>;

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
