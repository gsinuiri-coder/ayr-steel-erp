import { z } from 'zod';
import { IMPORT_BATCH_STATUSES, IMPORT_ENTITIES, IMPORT_ROW_STATUSES } from '../enums';

/**
 * Importación masiva desde planilla (RF-52), base reutilizable para RF-12 y RF-71.
 * Flujo: subir archivo → previsualizar fila por fila con errores → editar filas
 * inválidas → confirmar solo las filas válidas.
 */
export const importRowSchema = z.object({
  id: z.string().uuid(),
  rowNumber: z.number().int(),
  data: z.record(z.string(), z.unknown()),
  errors: z.array(z.string()).nullable(),
  /** RF-72: lo que hay que ver antes de confirmar y no bloquea la confirmación. */
  warnings: z.array(z.string()).nullable(),
  status: z.enum(IMPORT_ROW_STATUSES),
  createdEntityId: z.string().nullable(),
});
export type ImportRowDto = z.infer<typeof importRowSchema>;

export const importBatchSchema = z.object({
  id: z.string().uuid(),
  entity: z.enum(IMPORT_ENTITIES),
  fileName: z.string(),
  status: z.enum(IMPORT_BATCH_STATUSES),
  createdById: z.string().uuid(),
  createdAt: z.string(),
});
export type ImportBatchDto = z.infer<typeof importBatchSchema>;

export const importBatchWithRowsSchema = importBatchSchema.extend({
  rows: z.array(importRowSchema),
});
export type ImportBatchWithRowsDto = z.infer<typeof importBatchWithRowsSchema>;

export const updateImportRowSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});
export type UpdateImportRowInput = z.infer<typeof updateImportRowSchema>;
