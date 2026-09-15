import {
  coilExportSkipReason,
  fromCoilExportRow,
  isCoilExport,
} from './initial-inventory-import.service';

// Ventana V-4: la recarga sube el export de `pnpm export:coils`, no la plantilla.
const exportRow = {
  'CÓDIGO SISTEMA': 'TREAMP-ALZ-ROJO-3020-0.28-4786-1',
  'CÓDIGO CLIENTE': '',
  ACABADO: 'ALZ-ROJO-3020',
  'KILOS INICIALES': '4786',
  'KILOS ACTUALES': '1200.5',
  ESTADO: 'OPEN',
  COMPROBANTE: 'F001-13071',
  'FECHA DE COMPROBANTE': '2026-04-01',
};

describe('carga inicial desde el export de bobinas', () => {
  it('reconoce el export y no confunde la plantilla con él', () => {
    expect(isCoilExport(exportRow)).toBe(true);
    expect(isCoilExport({ 'CÓDIGO BOBINA': 'B-1', ACABADO: 'GALV' })).toBe(false);
  });

  it('mapea código de sistema y comprobante a las columnas de la plantilla', () => {
    const row = fromCoilExportRow(exportRow);
    expect(row['CÓDIGO BOBINA']).toBe('TREAMP-ALZ-ROJO-3020-0.28-4786-1');
    expect(row['FACTURA DE REFERENCIA']).toBe('F001-13071');
    expect(row['FECHA DE REFERENCIA']).toBe('2026-04-01');
    // La apertura es la foto: KILOS ACTUALES, no los iniciales (mapeo del dueño, V-4).
    expect(row['KILOS INICIALES']).toBe('1200.5');
  });

  it('omite cerradas y sin kilos; carga las abiertas aunque estén consumidas en parte', () => {
    expect(coilExportSkipReason(exportRow)).toBeNull();
    expect(coilExportSkipReason({ ...exportRow, ESTADO: 'CLOSED' })).toBe('bobina cerrada');
    expect(coilExportSkipReason({ ...exportRow, 'KILOS ACTUALES': '0.000' })).toBe(
      'sin kilos actuales',
    );
  });
});
