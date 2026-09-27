import { AuditActorKind, type Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';

/**
 * D-344 — retirada de las recetas de drywall.
 *
 * Drywall deja de usar receta: el espesor y el ancho del fleje son del SKU. La tabla
 * `product_boms` **no se borra** (las órdenes de producción históricas la referencian por
 * `bom_id`), pero nadie la escribe ni la lee, y la base rechaza una receta activa
 * (`product_boms_none_active_ck`, migración `d344_drywall_sin_receta`).
 *
 * Antes de aplicar esa migración en una base que todavía tenga recetas activas hay que
 * desactivarlas: esta función es esa operación, hecha por el servicio de dominio y **auditada**
 * (una fila `production.bom.retire` por receta, actor de sistema), no por SQL. Dry-run por
 * defecto en la CLI (`pnpm retire:boms`).
 */

export interface ActiveBomRow {
  id: string;
  productId: string;
  productSku: string;
  kind: string;
  inputThicknessMm: string;
  inputWidthMm: string | null;
}

/** Lo que la retirada necesita del cliente de Prisma: se puede probar con un doble. */
export type BomRetirementClient = Pick<Prisma.TransactionClient, 'productBom'>;

/** Las recetas que todavía están activas. Solo lectura. */
export async function findActiveBoms(client: BomRetirementClient): Promise<ActiveBomRow[]> {
  const rows = await client.productBom.findMany({
    where: { isActive: true },
    select: {
      id: true,
      productId: true,
      kind: true,
      inputThicknessMm: true,
      inputWidthMm: true,
      product: { select: { sku: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productSku: r.product.sku,
    kind: r.kind,
    inputThicknessMm: r.inputThicknessMm.toFixed(2),
    inputWidthMm: r.inputWidthMm?.toFixed(2) ?? null,
  }));
}

export interface BomRetirementResult {
  retired: number;
  skus: string[];
}

/**
 * Desactiva **todas** las recetas activas, dentro de la transacción que recibe, y deja su
 * auditoría en la misma. Idempotente: una segunda corrida no encuentra nada.
 */
export async function retireActiveBoms(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'write'>,
): Promise<BomRetirementResult> {
  const active = await findActiveBoms(tx);
  const retired: string[] = [];
  for (const bom of active) {
    // El `where` repite `isActive: true`: si otra sesión la desactivó entre la lectura y acá, no
    // se audita un cambio que no hicimos, y tampoco se cuenta como propio.
    const { count } = await tx.productBom.updateMany({
      where: { id: bom.id, isActive: true },
      data: { isActive: false },
    });
    if (count === 0) continue;
    retired.push(bom.productSku);
    await audit.write(tx, {
      actorId: null,
      actorKind: AuditActorKind.SYSTEM,
      action: 'production.bom.retire',
      entity: 'product_boms',
      entityId: bom.id,
      before: {
        productId: bom.productId,
        sku: bom.productSku,
        kind: bom.kind,
        inputThicknessMm: bom.inputThicknessMm,
        inputWidthMm: bom.inputWidthMm,
        isActive: true,
      },
      after: { isActive: false },
      reason: 'D-344: drywall deja de usar receta; el espesor y el ancho del fleje son del SKU',
    });
  }
  return { retired: retired.length, skus: retired };
}
