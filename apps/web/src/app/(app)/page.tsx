import type { Metadata } from 'next';
import { HomeGreeting } from './home-greeting';
import { AdminDashboard } from './admin-dashboard';
import { PriceFloorSummaryCard } from './price-floor-summary-card';
import { OrdersShortfallCard } from './orders-shortfall-card';
import { StockShortagesCard } from './stock-shortages-card';
import { SellerDashboardCards } from './seller-dashboard-cards';

export const metadata: Metadata = { title: 'Panel' };

export default function HomePage() {
  return (
    <>
      <h1 className="text-lg font-semibold">Panel</h1>
      <HomeGreeting />
      <SellerDashboardCards />
      {/* cc26 (D-440): las cifras del mes, solo ADMINISTRADOR; cada una abre su reporte. */}
      <AdminDashboard />
      {/* D-188: solo se pinta si hay algo que avisar — la tarjeta ES el aviso. */}
      <StockShortagesCard />
      {/* D-341: pedidos confirmados con faltante por un administrador; mismo criterio. */}
      <OrdersShortfallCard />
      {/* RF-S3/M4 (D-224): mismo criterio, solo ADMINISTRADOR. */}
      <PriceFloorSummaryCard />
    </>
  );
}
