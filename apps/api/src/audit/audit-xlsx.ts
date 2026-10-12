import {
  AUDIT_SOURCE_LABELS,
  auditActionLabel,
  auditDetailText,
  auditEntityTypeLabel,
  type AuditEventDto,
  type Role,
} from '@ayr/shared';
import { listXlsx, type ListColumn } from '../common/list-xlsx';

/** `2026-10-12T14:05:09.000Z` → `2026-10-12 09:05:09`, la hora de Lima (UTC−5 fijo). */
export function limaDateTime(iso: string): string {
  const lima = new Date(new Date(iso).getTime() - 5 * 60 * 60 * 1000);
  return lima.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * cc48 (D-634): las columnas del Excel de la auditoría, las de la pantalla: la entidad con su
 * código legible (D-633) y, aparte, el id completo; el detalle como «Campo: antes → después».
 */
export const AUDIT_XLSX_COLUMNS: readonly ListColumn<AuditEventDto>[] = [
  { header: 'Fecha y hora (Lima)', width: 20, cell: (e) => limaDateTime(e.occurredAt) },
  { header: 'Acción', width: 32, cell: (e) => auditActionLabel(e.action, e.source) },
  { header: 'Fuente', width: 24, cell: (e) => AUDIT_SOURCE_LABELS[e.source] },
  { header: 'Tipo de entidad', width: 22, cell: (e) => auditEntityTypeLabel(e.entityType) },
  {
    header: 'Entidad',
    width: 28,
    cell: (e) =>
      // «Eliminado · …» ya lo dice; un código guardado de una entidad borrada, no.
      e.entityCode === null
        ? null
        : e.entityDeleted && !e.entityCode.startsWith('Eliminado')
          ? `${e.entityCode} (eliminado)`
          : e.entityCode,
  },
  { header: 'Id', width: 38, cell: (e) => e.entityId },
  {
    header: 'Usuario',
    width: 24,
    cell: (e) => (e.actorKind === 'SYSTEM' ? 'Sistema' : e.actorName),
  },
  { header: 'Motivo', width: 40, cell: (e) => e.reason },
  { header: 'Detalle', width: 60, cell: (e) => auditDetailText(e) },
];

export function auditXlsx(
  rows: readonly AuditEventDto[],
  role: Role,
  today: string,
): { buffer: Buffer; filename: string } {
  return listXlsx({
    sheetName: 'Auditoría',
    columns: AUDIT_XLSX_COLUMNS,
    rows,
    role,
    noun: { singular: 'evento', plural: 'eventos' },
    filename: `auditoria-${today}.xlsx`,
  });
}
