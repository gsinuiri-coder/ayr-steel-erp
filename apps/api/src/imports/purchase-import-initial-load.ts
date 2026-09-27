import { InventoryItemType, InventoryRefType, type Prisma } from '@prisma/client';
import { comparableDocument } from '@ayr/shared';

/**
 * **D-352 — las facturas de referencia de la carga inicial (D-206/D-207).**
 *
 * La carga inicial no guardó el comprobante como dato: lo dejó como texto libre en las notas de
 * la bobina y del movimiento de kardex (`Saldo inicial de inventario · factura ref: F001-13071 ·
 * …`), sin proveedor ni tipo. Este lector saca ese texto y lo pasa a la forma comparable de un
 * comprobante (`comparableDocument`), para que el importador de compras pueda avisar que un papel
 * **podría** ser el mismo que ya entró en el saldo inicial. Como el proveedor no se guardó, es un
 * aviso que el usuario confirma («Es otra compra»), no un rechazo.
 */

const REFERENCE = /factura ref:\s*([^·]+?)\s*(?:·|$)/i;

/** `…· factura ref: F001-13071 · …` → `F001-13071`. `null` si la nota no trae referencia. */
export function referenceOf(notes: string | null): string | null {
  if (notes === null) return null;
  const match = REFERENCE.exec(notes);
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

/** Forma comparable de la referencia → las bobinas o SKU que entraron con ella. */
export async function initialLoadReferencesOf(
  db: Prisma.TransactionClient,
): Promise<Map<string, string[]>> {
  const [coils, movements] = await Promise.all([
    db.coil.findMany({
      where: { notes: { contains: 'factura ref:', mode: 'insensitive' } },
      select: { code: true, notes: true },
    }),
    db.inventoryMovement.findMany({
      where: {
        refType: InventoryRefType.IMPORT,
        itemType: InventoryItemType.PRODUCT,
        notes: { contains: 'factura ref:', mode: 'insensitive' },
      },
      select: { itemId: true, notes: true },
    }),
  ]);
  const products =
    movements.length === 0
      ? []
      : await db.product.findMany({
          where: { id: { in: [...new Set(movements.map((m) => m.itemId))] } },
          select: { id: true, sku: true },
        });
  const skuOf = new Map(products.map((p) => [p.id, p.sku]));

  const byReference = new Map<string, string[]>();
  const add = (notes: string | null, label: string | undefined) => {
    const reference = referenceOf(notes);
    if (reference === null || label === undefined) return;
    const key = comparableDocument(reference);
    const items = byReference.get(key) ?? [];
    if (!items.includes(label)) items.push(label);
    byReference.set(key, items);
  };
  for (const c of coils) add(c.notes, c.code);
  for (const m of movements) add(m.notes, skuOf.get(m.itemId));
  return byReference;
}
