import { z } from 'zod';
import { BusinessLine } from '../enums';

/**
 * cc23 (D-390, D-391): qué líneas de negocio tiene cada reporte. Es la única fuente de la
 * matriz: la API valida el filtro contra ella y la web pinta una pestaña por cada línea de la
 * lista, en este orden. Una línea que no está en la lista de un reporte no tiene pestaña
 * (D-394) y la API la rechaza con 400 (D-396).
 *
 * - Coberturas Aluzinc (con el accesorio) y Drywall: inventario, ventas y margen, bobinas.
 * - Coberturas (UPVC) y Reventa (con la bobina entera): inventario y ventas y margen.
 * - Servicios: solo ventas y margen, sin costo (D-392).
 */
export const SALES_MARGIN_LINES = [
  BusinessLine.DRYWALL,
  BusinessLine.METALLIC_ROOFING,
  BusinessLine.ROOFING,
  BusinessLine.SERVICES,
  BusinessLine.TRADING,
] as const;

export const INVENTORY_VALUATION_LINES = [
  BusinessLine.DRYWALL,
  BusinessLine.METALLIC_ROOFING,
  BusinessLine.ROOFING,
  BusinessLine.TRADING,
] as const;

export const COIL_REPORT_LINES = [BusinessLine.DRYWALL, BusinessLine.METALLIC_ROOFING] as const;

/**
 * cc24 (D-406, D-407): las pestañas de «Ventas por material», sin «Todas» y con Coberturas
 * Aluzinc primera y por defecto. Coberturas Aluzinc y Drywall agrupan por material (tipo o
 * color comercial × espesor); Coberturas (UPVC) y Reventa, por producto (`SALES_BY_PRODUCT_LINES`).
 */
export const SALES_BY_MATERIAL_LINES = [
  BusinessLine.METALLIC_ROOFING,
  BusinessLine.DRYWALL,
  BusinessLine.ROOFING,
  BusinessLine.TRADING,
] as const;
export type SalesByMaterialLine = (typeof SALES_BY_MATERIAL_LINES)[number];

/**
 * cc24 (D-406, D-417): las pestañas de «Ventas por material» que agrupan por producto, sin
 * bobina: el costo es el de kardex de los despachos que declaran el comprobante.
 */
export const SALES_BY_PRODUCT_LINES: readonly SalesByMaterialLine[] = [
  BusinessLine.ROOFING,
  BusinessLine.TRADING,
];

/** D-392: líneas cuyo reporte de ventas declara «sin costo registrado» en vez de un margen. */
export const NO_COST_REPORT_LINES: readonly BusinessLine[] = [BusinessLine.SERVICES];

export const inventoryValuationQuerySchema = z.object({
  businessLine: z.enum(INVENTORY_VALUATION_LINES).optional(),
});
export type InventoryValuationQuery = z.infer<typeof inventoryValuationQuerySchema>;
