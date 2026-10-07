import type { Metadata } from 'next';
import { AdminDashboard } from './admin-dashboard';
import { PanelHeader, PanelToday } from './panel-today';
import { PlantDashboard } from './plant-dashboard';
import { PriceFloorSummaryCard } from './price-floor-summary-card';
import { OrdersShortfallCard } from './orders-shortfall-card';
import { StockShortagesCard } from './stock-shortages-card';
import { SellerSalesCard } from './seller-sales-card';

export const metadata: Metadata = { title: 'Panel' };

/**
 * cc31 (ESPEC §3): el Panel arranca por lo que hay que atender hoy —cada tarjeta lleva a su lista
 * filtrada— y sigue con las cifras del rol. El saludo de «Fase 0» se fue.
 */
export default function HomePage() {
  return (
    <>
      <PanelHeader />
      <PanelToday />
      {/* cc27 (D-457): el mes del vendedor, solo VENDEDOR y solo lo suyo. */}
      <SellerSalesCard />
      {/* cc26 (D-440): las cifras del mes, solo ADMINISTRADOR; cada una abre su reporte. */}
      <AdminDashboard />
      {/* cc26 (D-440): la planta del día, solo SUPERVISOR_PLANTA. */}
      <PlantDashboard />
      {/* D-188: solo se pinta si hay algo que avisar — la tarjeta ES el aviso. Las de
          «Para atender hoy» del administrador llevan aquí (`#cotizaciones-sin-stock`…). */}
      <StockShortagesCard />
      {/* D-341: pedidos confirmados con faltante por un administrador; mismo criterio. */}
      <OrdersShortfallCard />
      {/* RF-S3/M4 (D-224): mismo criterio, solo ADMINISTRADOR. */}
      <PriceFloorSummaryCard />
    </>
  );
}
