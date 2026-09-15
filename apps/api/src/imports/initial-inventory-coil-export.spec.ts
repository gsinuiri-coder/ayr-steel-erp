import { getField } from './parse-spreadsheet';
import {
  coilExportSkipReason,
  fromCoilExportRow,
  isCoilExport,
  sameColorName,
  withOpeningKg,
} from './initial-inventory-import.service';

// Ventana V-4: la recarga sube el export de `pnpm export:coils` o el Excel depurado del dueño.
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

const openingKg = (row: Record<string, unknown>): string =>
  getField(withOpeningKg(row), { key: 'weightKg', header: 'KILOS INICIALES', required: true });

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
  });

  it('omite cerradas y sin kilos; carga las abiertas aunque estén consumidas en parte', () => {
    expect(coilExportSkipReason(exportRow)).toBeNull();
    expect(coilExportSkipReason({ ...exportRow, ESTADO: 'CLOSED' })).toBe('bobina cerrada');
    expect(coilExportSkipReason({ ...exportRow, 'KILOS ACTUALES': '0.000' })).toBe(
      'sin kilos actuales',
    );
  });
});

describe('kilos de apertura: la foto, no la historia', () => {
  it('con KILOS ACTUALES en el archivo, mandan los actuales', () => {
    expect(openingKg(exportRow)).toBe('1200.5');
  });

  it('sin esa columna (Excel depurado del dueño), KILOS INICIALES ya es la foto', () => {
    expect(openingKg({ 'CÓDIGO BOBINA': 'B-1', 'KILOS INICIALES': '3500' })).toBe('3500');
  });

  it('no se deja ganar por una variante de encabezado de los iniciales', () => {
    expect(openingKg({ 'Kilos Iniciales': '4786', 'kilos actuales': '1200.5' })).toBe('1200.5');
  });
});

describe('cruce de color contra el acabado', () => {
  it("'ROJO' del archivo y 'Rojo' del catálogo (D-203) son el mismo color", () => {
    expect(sameColorName('Rojo', 'ROJO ')).toBe(true);
    expect(sameColorName('Rojo', 'Azul')).toBe(false);
  });
});
