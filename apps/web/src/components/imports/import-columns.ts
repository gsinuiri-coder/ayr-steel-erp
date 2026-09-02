import type { ImportEntity } from '@ayr/shared';

/**
 * Columnas editables del preview de importación (RF-52), en el mismo orden que
 * espera cada adaptador del API (`apps/api/src/imports/adapters`). La clave
 * coincide con `ImportRow.data` (inglés, D-003); la etiqueta es lo que ve el usuario.
 */
export const IMPORT_COLUMNS: Record<ImportEntity, { key: string; label: string }[]> = {
  PRODUCTS: [
    { key: 'businessLineCode', label: 'Línea' },
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: 'Nombre' },
    { key: 'unit', label: 'Unidad' },
    { key: 'source', label: 'Origen (MANUFACTURED/PURCHASED)' },
  ],
  CUSTOMERS: [
    { key: 'docType', label: 'Tipo de documento (DNI/RUC/CE)' },
    { key: 'docNumber', label: 'Número de documento' },
    { key: 'name', label: 'Nombre / razón social' },
    { key: 'address', label: 'Dirección' },
    { key: 'email', label: 'Correo' },
    { key: 'phone', label: 'Teléfono' },
    { key: 'creditDays', label: 'Días de crédito' },
  ],
  COILS: [
    { key: 'businessLineCode', label: 'Línea' },
    { key: 'supplierCode', label: 'Proveedor (código)' },
    { key: 'finishCode', label: 'Acabado' },
    { key: 'weightKg', label: 'Peso (kg)' },
    { key: 'widthMm', label: 'Ancho (mm)' },
    { key: 'thicknessMm', label: 'Espesor (mm)' },
    { key: 'currency', label: 'Moneda (PEN/USD)' },
    { key: 'unitCostPerKg', label: 'Costo por kg sin IGV' },
    { key: 'exchangeRate', label: 'Tipo de cambio' },
  ],
};
