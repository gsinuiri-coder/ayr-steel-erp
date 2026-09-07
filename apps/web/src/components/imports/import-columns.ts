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
  /**
   * RF-71: una fila **por línea**, con la cabecera repetida. Las siete primeras columnas
   * describen el comprobante y tienen que decir lo mismo en todas sus líneas; las cinco
   * últimas son de la línea.
   */
  FISCAL_DOCUMENTS: [
    { key: 'docType', label: 'Tipo (FACTURA/BOLETA/NOTA_CREDITO)' },
    { key: 'series', label: 'Serie' },
    { key: 'correlative', label: 'Correlativo' },
    { key: 'issueDate', label: 'Fecha de emisión' },
    { key: 'customerDocNumber', label: 'Cliente (RUC/DNI)' },
    { key: 'paymentTerms', label: 'Condición de pago (CONTADO/CREDITO)' },
    { key: 'dueDate', label: 'Fecha de vencimiento' },
    { key: 'totalPen', label: 'Total del comprobante' },
    { key: 'affectedNumber', label: 'Documento afectado (NC)' },
    { key: 'creditNoteReason', label: 'Motivo de la NC' },
    { key: 'notes', label: 'Notas' },
    { key: 'sku', label: 'SKU' },
    { key: 'description', label: 'Descripción' },
    { key: 'qty', label: 'Cantidad' },
    { key: 'unit', label: 'Unidad' },
    { key: 'unitPricePen', label: 'Precio unitario sin IGV' },
  ],
  /**
   * D-137: el Excel real de bobinas. Se muestran las columnas que **se corrigen** —el
   * acabado y el color que no mapearon, el RUC, los pesos— y no las quince del archivo: un
   * preview de quince columnas no entra en pantalla y ninguna de las otras se edita.
   */
  COILS_HISTORY: [
    { key: 'supplierRuc', label: 'RUC' },
    { key: 'supplierName', label: 'Proveedor' },
    { key: 'finishText', label: 'Acabado (archivo)' },
    { key: 'finishCode', label: 'Acabado' },
    { key: 'colorCode', label: 'Color' },
    { key: 'purchaseDate', label: 'Fecha de compra' },
    { key: 'thicknessMm', label: 'Espesor (mm)' },
    { key: 'widthMm', label: 'Ancho (mm)' },
    { key: 'weightKg', label: 'Peso compra (kg)' },
    { key: 'stockKg', label: 'Stock actual (kg)' },
    { key: 'unitCostPerKg', label: 'Costo por kg (S/)' },
    { key: 'status', label: 'Estado' },
  ],
  /**
   * D-138: el export real de ventas. Una fila por línea, agrupadas por SERIE-NÚMERO. Igual
   * que arriba: solo lo que se lee o se corrige.
   */
  SALES_HISTORY: [
    { key: 'issueDate', label: 'F. emisión' },
    { key: 'docTypeText', label: 'Tipo' },
    { key: 'documentNumber', label: 'Serie - número' },
    { key: 'customerText', label: 'Cliente' },
    { key: 'adjustedDocument', label: 'Doc. ajustado' },
    { key: 'sku', label: 'SKU' },
    { key: 'productName', label: 'Producto' },
    { key: 'unit', label: 'Unidad' },
    { key: 'qty', label: 'Cantidad' },
    { key: 'netPen', label: 'Valor de venta' },
    { key: 'igvPen', label: 'IGV' },
    { key: 'grossPen', label: 'Precio de venta' },
    // D-141: solo sirve en un documento **pendiente** con una línea a medida, y es opcional
    // incluso ahí. `fulfillment` no está en esta lista a propósito: es una decisión del
    // documento entero y se edita en la cabecera de su grupo, no celda por celda.
    { key: 'piecesText', label: 'Largos (m x cant.)' },
  ],
};
