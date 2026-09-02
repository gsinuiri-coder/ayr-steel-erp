'use client';

import type { ReactNode } from 'react';
import type { Role } from '@ayr/shared';
import { useSession } from '@/lib/session';

/**
 * Corta la vista si el rol no está permitido (§3.4). El menú lateral ya oculta lo que
 * no corresponde, pero una URL escrita a mano llegaba a la pantalla completa y solo
 * fallaba al pedir los datos: mejor decirlo de entrada que mostrar botones que dan 403.
 * No reemplaza al guard del API, que es el que manda.
 */
export function RoleGate({ allow, children }: { allow: readonly Role[]; children: ReactNode }) {
  const { user } = useSession();
  if (!allow.includes(user.role)) {
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        No tienes permiso para ver esta sección.
      </div>
    );
  }
  return <>{children}</>;
}
