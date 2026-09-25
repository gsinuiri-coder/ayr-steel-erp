import { INVENTORY_REF_TYPE_LABELS } from './enums';
import type { InventoryMovementDto } from './schemas/inventory';
import type { KardexPepsReportDto } from './schemas/report';

/**
 * D-298: el kardex de un ítem **con el formato del cliente**, igual para los dos métodos de
 * costeo (Promedio y PEPS) y para la pantalla y el Excel: cabecera Producto / Código / Método;
 * columnas Fecha, Detalle, ENTRADAS (cantidad, C.U., monto), SALIDAS (idem) y SALDO (idem).
 *
 * Es **presentación de números que ya existen**: ningún cálculo nuevo. El promedio sale del
 * kardex (`InventoryMovementDto`, que ya trae el saldo corrido) y PEPS del reporte de D-279
 * (`KardexPepsReportDto`). Todo viaja como string (D-003); `null` es celda vacía.
 */
export type KardexMethod = 'AVERAGE' | 'PEPS';

/** «Todo» en PEPS y en el Excel: el formato declara un período, así que se lee desde el principio de los tiempos. */
export const KARDEX_ALL_FROM = '2000-01-01';

export const KARDEX_METHOD_LABELS: Record<KardexMethod, string> = {
  AVERAGE: 'Promedio',
  PEPS: 'PEPS',
};

export interface KardexSheetRow {
  /** Clave estable de la fila (movimiento y, en PEPS, capa). */
  key: string;
  /** `YYYY-MM-DD`; vacío en el saldo inicial. */
  date: string;
  detail: string;
  inQty: string | null;
  inUnitCost: string | null;
  inTotal: string | null;
  outQty: string | null;
  outUnitCost: string | null;
  outTotal: string | null;
  /**
   * El saldo **después del movimiento**. En PEPS, una salida que consume varias capas se abre en
   * una fila por capa y el saldo va solo en la última: es el de todo el movimiento, no de la capa.
   */
  balanceQty: string | null;
  balanceUnitCost: string | null;
  balanceTotal: string | null;
  /** Fila de saldo inicial o de totales: se pinta distinta. */
  kind: 'movement' | 'opening' | 'totals';
}

export interface KardexSheet {
  method: KardexMethod;
  itemCode: string;
  itemDescription: string;
  /** `YYYY-MM-DD`; vacío si el rango no está acotado. */
  from: string;
  to: string;
  unit: string | null;
  rows: KardexSheetRow[];
}

const EMPTY: Pick<
  KardexSheetRow,
  | 'inQty'
  | 'inUnitCost'
  | 'inTotal'
  | 'outQty'
  | 'outUnitCost'
  | 'outTotal'
  | 'balanceQty'
  | 'balanceUnitCost'
  | 'balanceTotal'
> = {
  inQty: null,
  inUnitCost: null,
  inTotal: null,
  outQty: null,
  outUnitCost: null,
  outTotal: null,
  balanceQty: null,
  balanceUnitCost: null,
  balanceTotal: null,
};

/**
 * El kardex a **costo promedio** (el del sistema) en la hoja del cliente. Un ajuste de costo
 * (`ADJUST`, D-043) mueve valor sin cantidad: su monto va en entradas si suma y en salidas si
 * resta, sin cantidad ni costo unitario.
 */
export function movementsToKardexSheet(
  movements: readonly InventoryMovementDto[],
  meta: {
    itemCode: string;
    itemDescription: string;
    from: string;
    to: string;
    unit: string | null;
  },
): KardexSheet {
  const rows: KardexSheetRow[] = movements.map((m) => {
    const adjust = m.type === 'ADJUST';
    const total = m.totalCost ?? null;
    const negative = total?.startsWith('-') ?? false;
    const label = INVENTORY_REF_TYPE_LABELS[m.refType];
    const detail = [
      m.reversalOfId ? `${label} (anulación)` : adjust ? `${label} (ajuste de costo)` : label,
      m.notes,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      ...EMPTY,
      key: m.id,
      date: m.operationDate,
      detail,
      kind: 'movement',
      ...(m.type === 'IN' || (adjust && !negative)
        ? {
            inQty: adjust ? null : m.qty,
            inUnitCost: adjust ? null : (m.unitCost ?? null),
            inTotal: total,
          }
        : {
            outQty: adjust ? null : m.qty,
            outUnitCost: adjust ? null : (m.unitCost ?? null),
            outTotal: adjust && total !== null ? total.replace(/^-/, '') : total,
          }),
      balanceQty: m.balanceQty,
      balanceUnitCost: m.balanceAvgCost ?? null,
      balanceTotal: m.balanceTotalCost ?? null,
    };
  });
  // «Todo» viaja como 2000-01-01 (el formato exige período): en la hoja es «sin cota», como en PEPS.
  return { method: 'AVERAGE', ...meta, from: meta.from === KARDEX_ALL_FROM ? '' : meta.from, rows };
}

/**
 * El kardex **PEPS** (D-279/D-296) en la hoja del cliente: saldo inicial, cada movimiento —una
 * fila por capa consumida en las salidas— y los totales.
 */
export function pepsToKardexSheet(report: KardexPepsReportDto): KardexSheet {
  const rows: KardexSheetRow[] = [
    {
      ...EMPTY,
      key: 'opening',
      date: report.from === KARDEX_ALL_FROM ? '' : report.from,
      detail: 'Saldo inicial',
      kind: 'opening',
      balanceQty: report.opening.qty,
      balanceUnitCost: report.opening.unitCost,
      balanceTotal: report.opening.total,
    },
  ];
  for (const row of report.rows) {
    const number = [row.series, row.number].filter(Boolean).join('-');
    const document = number
      ? row.docTypeCode !== '00'
        ? `${row.docTypeCode} ${number}`
        : number
      : null;
    const detail = [document, row.operationLabel, row.observation].filter(Boolean).join(' · ');
    const layers = row.outLayers ?? [];
    if (layers.length > 1) {
      // Una salida sobre varias capas: una fila por capa, con el saldo del movimiento en la última.
      layers.forEach((layer, i) => {
        const last = i === layers.length - 1;
        rows.push({
          ...EMPTY,
          key: `${row.movementId}:${String(i)}`,
          date: row.operationDate,
          detail,
          kind: 'movement',
          outQty: layer.qty,
          outUnitCost: layer.unitCost,
          outTotal: layer.total,
          ...(last
            ? {
                balanceQty: row.balanceQty,
                balanceUnitCost: row.balanceUnitCost,
                balanceTotal: row.balanceTotal,
              }
            : {}),
        });
      });
      continue;
    }
    rows.push({
      key: row.movementId,
      date: row.operationDate,
      detail,
      kind: 'movement',
      inQty: row.inQty,
      inUnitCost: row.inUnitCost,
      inTotal: row.inTotal,
      outQty: row.outQty,
      outUnitCost: row.outUnitCost,
      outTotal: row.outTotal,
      balanceQty: row.balanceQty,
      balanceUnitCost: row.balanceUnitCost,
      balanceTotal: row.balanceTotal,
    });
  }
  rows.push({
    ...EMPTY,
    key: 'totals',
    date: '',
    detail: 'Totales',
    kind: 'totals',
    inQty: report.totals.inQty,
    inTotal: report.totals.inTotal,
    outQty: report.totals.outQty,
    outTotal: report.totals.outTotal,
    balanceQty: report.closing.qty,
    balanceUnitCost: report.closing.unitCost,
    balanceTotal: report.closing.total,
  });
  return {
    method: 'PEPS',
    itemCode: report.itemCode,
    itemDescription: report.itemDescription,
    from: report.from === KARDEX_ALL_FROM ? '' : report.from,
    to: report.to,
    unit: report.unitCode,
    rows,
  };
}
