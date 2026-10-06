import { Role, sum, toFixedString } from '@ayr/shared';
import { build, num, type Sheet } from '../reports/reports-xlsx';

/**
 * cc26 (D-provisional): el Excel de un listado, con el patrón de los reportes (`Sheet`, `build`,
 * `num`). Cada listado declara sus columnas; este módulo arma la hoja, quita las columnas que el
 * rol no ve y agrega la fila de total.
 *
 * - **Columnas por rol en la API, no en la web.** Una columna `adminOnly` (costo, margen, piso de
 *   precio: lo que la pantalla le oculta a quien no es ADMINISTRADOR) no llega al archivo de otro
 *   rol. Esconderla en la web dejaría el dato en la respuesta.
 * - **La fila de total suma con `Decimal`.** Una columna con `amount` es un importe que la lista
 *   muestra; su total es la suma exacta de los strings de las filas (D-003) y `num()` solo
 *   convierte al escribir la celda, igual que en los reportes.
 */
export interface ListColumn<T> {
  header: string;
  width: number;
  /** La celda, tal como la muestra la pantalla (etiquetas en español, montos con `num()`). */
  cell: (row: T) => string | number | null;
  /** Importe que suma en la fila de total. El string con su escala, sin pasar por `number`. */
  amount?: (row: T) => string;
  /** Costo, margen o piso: solo ADMINISTRADOR. */
  adminOnly?: boolean;
}

/** Las columnas que ve un rol. */
export function columnsFor<T>(columns: readonly ListColumn<T>[], role: Role): ListColumn<T>[] {
  return columns.filter((c) => !c.adminOnly || role === Role.ADMINISTRADOR);
}

/**
 * La hoja del listado: encabezados, una fila por DTO en el orden recibido (el del servidor) y la
 * fila «Total (N <plural>)» con la suma de cada columna de importe; las demás quedan vacías.
 */
export function listSheet<T>(
  name: string,
  columns: readonly ListColumn<T>[],
  rows: readonly T[],
  noun: { singular: string; plural: string },
): Sheet {
  const label = `Total (${String(rows.length)} ${rows.length === 1 ? noun.singular : noun.plural})`;
  // La etiqueta va en la primera columna, que en todo listado es su código o número (nunca un
  // importe).
  const totals = columns.map((c, i) => {
    const amount = c.amount;
    if (amount) return num(toFixedString(sum(rows.map((r) => amount(r))), 'MONEY'));
    return i === 0 ? label : null;
  });
  return {
    name,
    header: columns.map((c) => c.header),
    widths: columns.map((c) => c.width),
    rows: [...rows.map((r) => columns.map((c) => c.cell(r))), totals],
  };
}

/** El archivo de un listado: una hoja, con las columnas del rol. */
export function listXlsx<T>(options: {
  sheetName: string;
  columns: readonly ListColumn<T>[];
  rows: readonly T[];
  role: Role;
  noun: { singular: string; plural: string };
  filename: string;
}): { buffer: Buffer; filename: string } {
  const sheet = listSheet(
    options.sheetName,
    columnsFor(options.columns, options.role),
    options.rows,
    options.noun,
  );
  return { buffer: build([sheet]), filename: options.filename };
}
