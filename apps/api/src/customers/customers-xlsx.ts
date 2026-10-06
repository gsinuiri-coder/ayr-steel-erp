import { DOC_TYPE_LABELS, type CustomerDto, type Role } from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';

/**
 * cc26 M2 (D-provisional): las columnas del Excel de la lista de clientes, las de la pantalla
 * (`clientes-view.tsx`) con sus mismas etiquetas. «Por completar» (D-137) es la marca que la
 * pantalla pinta al lado del nombre.
 *
 * El maestro de clientes no trae costos ni márgenes: ninguna columna es `adminOnly` y todos los
 * roles de la lista reciben las mismas. Sin importes, la fila final solo cuenta clientes.
 */
export const CUSTOMER_LIST_COLUMNS: readonly ListColumn<CustomerDto>[] = [
  { header: 'Tipo de documento', width: 10, cell: (c) => DOC_TYPE_LABELS[c.docType] },
  { header: 'Documento', width: 14, cell: (c) => c.docNumber },
  { header: 'Nombre', width: 40, cell: (c) => c.name },
  { header: 'Por completar', width: 12, cell: (c) => (c.needsReview ? 'Sí' : '') },
  // Como la pantalla: el correo y, sin correo, el teléfono.
  { header: 'Contacto', width: 28, cell: (c) => c.email ?? c.phone ?? '' },
  { header: 'Días de crédito', width: 10, cell: (c) => c.creditDays },
  { header: 'Estado', width: 10, cell: (c) => (c.isActive ? 'Activo' : 'Inactivo') },
];

export function customersXlsx(
  rows: readonly CustomerDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Clientes',
    columns: CUSTOMER_LIST_COLUMNS,
    rows,
    role,
    noun: { singular: 'cliente', plural: 'clientes' },
    filename: `clientes-${today}.xlsx`,
  });
}
