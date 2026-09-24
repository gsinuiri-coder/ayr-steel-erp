import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryItemType, ReservationStatus, type Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';

/**
 * **Renombre y unión de productos (D-253, RF-S4b).** Los dos únicos caminos por los que cambia la
 * identidad de un producto que ya tiene historia.
 *
 * - **Renombre**: el producto conserva su id —y con él toda su historia, que apunta por FK— y
 *   cambia su SKU. Auditado con el antes y el después. No se crea ningún producto.
 * - **Unión**: el producto sobrante **no se borra**. Queda inactivo, con su SKU viejo y con
 *   `mergedIntoId` apuntando al principal. La historia cerrada (ventas, cotizaciones,
 *   comprobantes) sigue apuntándole; nadie lo vuelve a ofrecer ni a resolver, porque todo
 *   selector y toda resolución filtra por activo.
 *
 * **Sin cadenas.** El principal tiene que estar activo y sin `mergedIntoId`, y un producto que ya
 * tiene otros unidos a él no se une a un tercero: así `mergedIntoId` es siempre un solo salto y
 * nadie tiene que recorrer una lista para saber cuál es el principal. El CHECK de la migración
 * cubre la mitad que se puede decir de una sola fila (unido ⇒ inactivo y distinto de sí mismo);
 * lo demás lo impone esta función, que es la única que escribe la columna.
 *
 * **El kardex no se toca.** Un producto de venta de bobina no tiene saldo propio —el saldo vive
 * en cada bobina (D-116/D-170)—, así que unirlo no mueve kilos. Si un producto a unir tuviera
 * movimientos o reservas propias, la unión se detiene: ese caso lo decide el dueño (D-230).
 */

export interface MergeActor {
  id: string;
}

/** Renombra el SKU de un producto, con auditoría. El SKU destino no puede existir en su línea. */
export async function renameProductSku(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'write'>,
  actor: MergeActor,
  /** `requestId` agrupa los eventos de una corrida de la normalización (su reversa lo usa). */
  input: { productId: string; newSku: string; reason: string; requestId?: string },
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true, businessLineId: true, isActive: true, mergedIntoId: true },
  });
  if (!product) throw new NotFoundException('Producto no encontrado');
  if (!product.isActive || product.mergedIntoId !== null) {
    throw new BadRequestException(`${product.sku} está inactivo o unido a otro: no se renombra`);
  }
  if (product.sku === input.newSku) return;
  const taken = await tx.product.findFirst({
    where: { businessLineId: product.businessLineId, sku: input.newSku },
    select: { sku: true, isActive: true },
  });
  if (taken) {
    throw new BadRequestException(
      `El SKU ${input.newSku} ya existe en la línea${taken.isActive ? '' : ' (inactivo)'}: no se renombra ${product.sku} encima`,
    );
  }
  await tx.product.update({ where: { id: product.id }, data: { sku: input.newSku } });
  await audit.write(tx, {
    actorId: actor.id,
    action: 'catalog.product-rename-sku',
    entity: 'products',
    entityId: product.id,
    before: { sku: product.sku },
    after: { sku: input.newSku },
    reason: input.reason,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
}

/**
 * Une `sourceId` a `targetId` (el principal). Rechaza, nombrando el motivo:
 * - unirlo a sí mismo o a un producto de otra línea;
 * - un principal inactivo o ya unido a otro (cadena hacia adelante);
 * - un producto a unir que ya tiene otros unidos a él (cadena hacia atrás);
 * - un producto a unir con movimientos o reservas vivas propias (parada del dueño).
 */
export async function mergeProductInto(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'write'>,
  actor: MergeActor,
  input: { sourceId: string; targetId: string; reason: string; requestId?: string },
): Promise<void> {
  if (input.sourceId === input.targetId) {
    throw new BadRequestException('Un producto no se une a sí mismo');
  }
  // Las dos filas bloqueadas, en orden de id: dos uniones simultáneas (A→B y B→C) leerían las
  // dos «B sin unir» y armarían la cadena que esta función existe para impedir.
  await tx.$queryRaw`
    SELECT "id" FROM "products"
    WHERE "id" IN (${input.sourceId}::uuid, ${input.targetId}::uuid)
    ORDER BY "id" FOR UPDATE
  `;
  const [source, target] = await Promise.all([
    tx.product.findUnique({
      where: { id: input.sourceId },
      select: {
        id: true,
        sku: true,
        businessLineId: true,
        isActive: true,
        mergedIntoId: true,
        _count: { select: { mergedFrom: true } },
      },
    }),
    tx.product.findUnique({
      where: { id: input.targetId },
      select: { id: true, sku: true, businessLineId: true, isActive: true, mergedIntoId: true },
    }),
  ]);
  if (!source) throw new NotFoundException('Producto a unir no encontrado');
  if (!target) throw new NotFoundException('Producto principal no encontrado');
  if (source.businessLineId !== target.businessLineId) {
    throw new BadRequestException(`${source.sku} y ${target.sku} son de líneas distintas`);
  }
  if (!target.isActive || target.mergedIntoId !== null) {
    throw new BadRequestException(
      `El principal ${target.sku} tiene que estar activo y sin unir a otro: no se arman cadenas de unión`,
    );
  }
  if (source.mergedIntoId !== null) {
    throw new BadRequestException(`${source.sku} ya está unido a otro producto`);
  }
  if (source._count.mergedFrom > 0) {
    throw new BadRequestException(
      `${source.sku} tiene ${String(source._count.mergedFrom)} producto(s) unidos a él: no se une a un tercero (sin cadenas)`,
    );
  }
  const [movements, reservations] = await Promise.all([
    tx.inventoryMovement.count({
      where: { itemType: InventoryItemType.PRODUCT, itemId: source.id },
    }),
    tx.reservation.count({
      where: {
        itemType: InventoryItemType.PRODUCT,
        itemId: source.id,
        status: ReservationStatus.ACTIVE,
      },
    }),
  ]);
  if (movements > 0 || reservations > 0) {
    throw new BadRequestException(
      `${source.sku} tiene saldo propio (${String(movements)} movimientos de kardex, ${String(reservations)} reservas vivas): la unión se detiene y la decide el dueño`,
    );
  }

  await tx.product.update({
    where: { id: source.id },
    data: { isActive: false, mergedIntoId: target.id },
  });
  await audit.write(tx, {
    actorId: actor.id,
    action: 'catalog.product-merge',
    entity: 'products',
    entityId: source.id,
    before: { sku: source.sku, isActive: source.isActive, mergedIntoId: null },
    after: { isActive: false, mergedIntoId: target.id, mergedIntoSku: target.sku },
    reason: input.reason,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
}
