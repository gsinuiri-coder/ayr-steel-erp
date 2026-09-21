'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Clock, Factory, Truck } from 'lucide-react';
import type { DashboardDto } from '@ayr/shared';

export function SellerDashboardCards() {
  const { user } = useSession();

  // Disponible para VENDEDOR, ADMINISTRADOR, SUPERVISOR_PLANTA (ya filtrados en el backend)
  const allowed = ['VENDEDOR', 'ADMINISTRADOR', 'SUPERVISOR_PLANTA'].includes(user.role);

  const q = useQuery({
    queryKey: ['seller-dashboard'],
    queryFn: () => api<DashboardDto>('/sales/dashboard'),
    enabled: allowed,
    refetchInterval: 60_000,
  });

  if (!allowed || q.isPending || q.isError || !q.data) return null;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">Cotizaciones por vencer</CardTitle>
          <Clock className="w-4 h-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{q.data.expiringQuotations}</div>
          <p className="text-xs text-muted-foreground">En los próximos 3 días hábiles</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">Reservas por expirar</CardTitle>
          <AlertCircle className="w-4 h-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{q.data.expiringReservations}</div>
          <p className="text-xs text-muted-foreground">En los próximos 3 días calendario</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">Pedidos en producción</CardTitle>
          <Factory className="w-4 h-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{q.data.productionOrders}</div>
          <p className="text-xs text-muted-foreground">Con OP viva en progreso o draft</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">Pedidos listos</CardTitle>
          <Truck className="w-4 h-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{q.data.readyOrders}</div>
          <p className="text-xs text-muted-foreground">Listos para despacho o entrega</p>
        </CardContent>
      </Card>
    </div>
  );
}
