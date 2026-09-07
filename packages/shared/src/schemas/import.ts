import { z } from 'zod';
import {
  BUSINESS_LINES,
  COIL_ADJUST_DATES,
  COIL_IMPORT_MODES,
  CoilAdjustDate,
  CoilImportMode,
  IMPORT_BATCH_STATUSES,
  IMPORT_ENTITIES,
  IMPORT_ROW_STATUSES,
} from '../enums';

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

/**
 * Opciones del lote (D-137): lo que el usuario elige para **todo** el archivo y no viene en
 * ninguna fila.
 *
 * Viven en el lote y no repetidas en cada fila porque son una decisión del import y no un
 * dato del Excel: repetirlas por fila abriría la puerta a un archivo con la mitad en modo
 * replay y la mitad en modo ajuste, que no significa nada.
 */
export const importOptionsSchema = z.object({
  /** Solo `COILS_HISTORY`: el Excel del dueño no trae la línea de negocio. */
  businessLine: z.enum(BUSINESS_LINES).optional(),
  /** Solo `COILS_HISTORY`: qué hacer con la diferencia entre peso de compra y stock actual. */
  mode: z.enum(COIL_IMPORT_MODES).default(CoilImportMode.REPLAY),
  /** Solo con `mode = ADJUST`: con qué fecha se registra la salida de ajuste. */
  adjustDate: z.enum(COIL_ADJUST_DATES).default(CoilAdjustDate.PURCHASE_DATE),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const importBatchSchema = z.object({
  id: z.string().uuid(),
  entity: z.enum(IMPORT_ENTITIES),
  fileName: z.string(),
  status: z.enum(IMPORT_BATCH_STATUSES),
  options: importOptionsSchema.nullable(),
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

/**
 * Corrección que vale para **todas las filas de un grupo** (D-141).
 *
 * Existe porque el toggle "entregado / pendiente" es una decisión del **documento**, no de
 * una de sus líneas: aplicarlo fila por fila dejaba un comprobante a medio marcar entre dos
 * peticiones, y la validación de grupo —que se corre en cada `PATCH`— habría visto ese
 * estado incoherente y marcado las filas que todavía no se habían tocado.
 *
 * `data` se **mezcla** sobre lo que cada fila ya tiene: solo cambia las claves que trae, así
 * que el SKU corregido de una línea no se pierde al marcar el documento como pendiente.
 */
export const updateImportGroupSchema = z.object({
  /** Clave del grupo tal como la calcula el adaptador (en ventas, `F001-00000123`). */
  groupKey: z.string().trim().min(1).max(64),
  data: z.record(z.string(), z.unknown()),
});
export type UpdateImportGroupInput = z.infer<typeof updateImportGroupSchema>;

/**
 * Reporte de saldo vs objetivo de una carga de bobinas en modo `REPLAY` (D-137).
 *
 * Existe porque el modo replay hace una promesa que hay que poder comprobar: la bobina entra
 * con el peso de compra y el stock que el Excel dice tener hoy queda **anotado como
 * objetivo**, no aplicado. Sin este reporte, "cargá los consumos y después fijate si cuadra"
 * sería un ejercicio a mano sobre cientos de bobinas.
 */
export const coilImportCheckRowSchema = z.object({
  rowNumber: z.number().int(),
  coilId: z.string().uuid().nullable(),
  coilCode: z.string().nullable(),
  /** Lo que el Excel decía que debía quedar. */
  targetKg: z.string(),
  /** Lo que el kardex dice hoy. */
  currentKg: z.string(),
  /** `currentKg − targetKg`. Cero es cuadrado. */
  differenceKg: z.string(),
  matches: z.boolean(),
});
export type CoilImportCheckRowDto = z.infer<typeof coilImportCheckRowSchema>;

export const coilImportCheckSchema = z.object({
  batchId: z.string().uuid(),
  mode: z.enum(COIL_IMPORT_MODES),
  rows: z.array(coilImportCheckRowSchema),
  matching: z.number().int(),
  mismatching: z.number().int(),
});
export type CoilImportCheckDto = z.infer<typeof coilImportCheckSchema>;
