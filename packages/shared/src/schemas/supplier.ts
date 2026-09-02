import { z } from 'zod';
import { DOC_TYPES } from '../enums';
import {
  docNumberLengths,
  partyCreditDaysSchema,
  partyEmailSchema,
  partyNameSchema,
  partyOptionalText,
} from './customer';

/** Proveedores (RF-81, RF-83), incluido si presta corte tercerizado (D-033/P-10). */
export const supplierSchema = z.object({
  id: z.string().uuid(),
  /** Código corto único, primer segmento del código de bobina (RF-13). */
  code: z.string(),
  docType: z.enum(DOC_TYPES),
  docNumber: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  creditDays: z.number().int(),
  providesCuttingService: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupplierDto = z.infer<typeof supplierSchema>;

/** 3-6 letras, único: es el primer segmento del código de bobina (RF-13). */
export const supplierCodeSchema = z
  .string({ required_error: 'El código del proveedor es obligatorio' })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,6}$/, 'El código debe tener entre 3 y 6 letras, sin espacios ni números');

export const createSupplierSchema = z
  .object({
    code: supplierCodeSchema,
    docType: z.enum(DOC_TYPES, { errorMap: () => ({ message: 'Tipo de documento inválido' }) }),
    docNumber: z
      .string({ required_error: 'El número de documento es obligatorio' })
      .trim()
      .regex(/^[A-Z0-9]+$/i, 'Solo letras y números'),
    name: partyNameSchema,
    address: partyOptionalText(240),
    email: partyEmailSchema,
    phone: partyOptionalText(30),
    creditDays: partyCreditDaysSchema,
    providesCuttingService: z.boolean().default(false),
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
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    code: supplierCodeSchema,
    name: partyNameSchema,
    address: partyOptionalText(240),
    email: partyEmailSchema,
    phone: partyOptionalText(30),
    creditDays: partyCreditDaysSchema,
    providesCuttingService: z.boolean(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
