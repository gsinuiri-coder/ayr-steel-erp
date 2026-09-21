import type { Metadata } from 'next';
import { HomeGreeting } from './home-greeting';
import { PriceFloorSummaryCard } from './price-floor-summary-card';
import { StockShortagesCard } from './stock-shortages-card';
import { SellerDashboardCards } from './seller-dashboard-cards';

export const metadata: Metadata = { title: 'Panel' };

export default function HomePage() {
  return (
    <>
      <h1 className="text-lg font-semibold">Panel</h1>
      <HomeGreeting />
      <SellerDashboardCards />
      {/* D-188: solo se pinta si hay algo que avisar — la tarjeta ES el aviso. */}
      <StockShortagesCard />
      {/* RF-S3/M4 (D-224): mismo criterio, solo ADMINISTRADOR. */}
      <PriceFloorSummaryCard />
    </>
  );
}
