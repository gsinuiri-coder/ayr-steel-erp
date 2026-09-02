'use client';

import { ROLE_LABELS } from '@ayr/shared';
import { useSession } from '@/lib/session';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function HomeGreeting() {
  const { user } = useSession();
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Hola, {user.name}</CardTitle>
        <CardDescription>Tu rol: {ROLE_LABELS[user.role]}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Fase 0: autenticación y usuarios. Los módulos de bobinas, producción y ventas se activarán
        en las siguientes fases.
      </CardContent>
    </Card>
  );
}
