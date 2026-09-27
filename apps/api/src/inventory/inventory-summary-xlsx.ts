import { BUSINESS_LINE_LABELS, type InventorySummaryDto } from '@ayr/shared';
import { build, num, type Sheet } from '../reports/reports-xlsx';

/**
 * D-356 — «Bobinas por tipo» de Inventario en xlsx, del mismo DTO que la pantalla y con el mismo
 * enmascarado: costo y valorizado solo viajan si el rol los ve (`null` en el DTO). Lleva el
 * metro lineal teórico del disponible, sumado bobina por bobina.
 */
export function inventoryCoilTypesXlsx(summary: InventorySummaryDto): {
  buffer: Buffer;
  filename: string;
} {
  const showsCost = summary.totalValuePen !== null;
  const sheet: Sheet = {
    name: 'Bobinas por tipo',
    header: [
      'Tipo (acabado-espesor)',
      'Descripción',
      'Ítems',
      'Físico (kg)',
      'Reservado (kg)',
      'Disponible (kg)',
      'ML teórico (disponible)',
      ...(showsCost ? ['Costo prom. (S/)', 'Valorizado (S/)'] : []),
    ],
    widths: [24, 34, 7, 14, 15, 16, 22, ...(showsCost ? [16, 16] : [])],
    rows: summary.coils.map((r) => [
      r.key,
      r.name,
      r.itemCount,
      num(r.qty),
      num(r.reservedQty),
      num(r.availableQty),
      num(r.theoreticalMeters ?? null),
      ...(showsCost ? [num(r.avgCostPen ?? null), num(r.totalValuePen ?? null)] : []),
    ]),
  };
  const line = BUSINESS_LINE_LABELS[summary.businessLine]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  return { buffer: build([sheet]), filename: `bobinas-por-tipo-${line}.xlsx` };
}
