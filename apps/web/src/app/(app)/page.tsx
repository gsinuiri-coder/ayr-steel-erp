import type { Metadata } from 'next';
import { HomeGreeting } from './home-greeting';
import { AdminDashboard } from './admin-dashboard';
import { PlantDashboard } from './plant-dashboard';
import { PriceFloorSummaryCard } from './price-floor-summary-card';
import { OrdersShortfallCard } from './orders-shortfall-card';
import { StockShortagesCard } from './stock-shortages-card';
import { SellerDashboardCards } from './seller-dashboard-cards';
import { SellerSalesCard } from './seller-sales-card';

export const metadata: Metadata = { title: 'Panel' };

export default function HomePage() {
  return (
    <>
      <h1 className="text-xl font-semibold">Panel</h1>
      <HomeGreeting />
      <SellerDashboardCards />
      {/* cc27 (D-457): el mes del vendedor, solo VENDEDOR y solo lo suyo. */}
      <SellerSalesCard />
      {/* cc26 (D-440): las cifras del mes, solo ADMINISTRADOR; cada una abre su reporte. */}
      <AdminDashboard />
      {/* cc26 (D-440): la planta del día, solo SUPERVISOR_PLANTA. */}
      <PlantDashboard />
      {/* D-188: solo se pinta si hay algo que avisar — la tarjeta ES el aviso. */}
      <StockShortagesCard />
      {/* D-341: pedidos confirmados con faltante por un administrador; mismo criterio. */}
      <OrdersShortfallCard />
      {/* RF-S3/M4 (D-224): mismo criterio, solo ADMINISTRADOR. */}
      <PriceFloorSummaryCard />
    </>
  );
}
