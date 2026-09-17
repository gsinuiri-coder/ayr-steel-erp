'use client';

import Link from 'next/link';
import { History } from 'lucide-react';
import { Role, type AuditEntityType } from '@ayr/shared';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';

/**
 * "Historial" (M4/D-218, sacrificable — se llegó a tiempo): enlaza al detalle de un pedido,
 * cotización, bobina o comprobante con el visor de auditoría ya filtrado a esa entidad.
 * D-225/RF-S2-INTEGRA: también desde precios de lista (un SKU) y la carga masiva, donde no hay
 * una entidad puntual — sin `entityId` filtra solo por tipo. Solo
 * ADMINISTRADOR: es el único rol que puede entrar a `/auditoria` (`RoleGate` ahí corta al
 * resto), así que mostrarlo a otro rol sería un link que su propio destino rebota.
 */
export function AuditHistoryLink({
  entityType,
  entityId,
}: {
  entityType: AuditEntityType;
  entityId?: string;
}) {
  const { user } = useSession();
  if (user.role !== Role.ADMINISTRADOR) return null;

  return (
    <Button variant="outline" size="sm" asChild>
      <Link
        href={
          entityId === undefined
            ? `/auditoria?entityType=${entityType}`
            : `/auditoria?entityType=${entityType}&entityId=${entityId}`
        }
      >
        <History />
        Historial
      </Link>
    </Button>
  );
}
