import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  businessToday,
  coilMonthReportQuerySchema,
  productionXlsxSearchSchema,
  reportXlsxSearchSchema,
  type ProductionXlsxSearch,
  type ReportXlsxSearch,
  coilWasteQuerySchema,
  productionSummaryQuerySchema,
  type ProductionSummaryDto,
  type ProductionSummaryQuery,
  inventoryValuationQuerySchema,
  kardexPepsQuerySchema,
  kardexSheetQuerySchema,
  receivablesAgingQuerySchema,
  salesByMaterialQuerySchema,
  salesMarginQuerySchema,
  Role,
  type AdminDashboardDto,
  type PlantDashboardDto,
  type SellerDashboardDto,
  type DocumentProfitabilityDto,
  type SalesByMaterialDto,
  type SalesByMaterialQuery,
  type CoilMonthReportDto,
  type CoilMonthReportQuery,
  type CoilWasteDto,
  type CoilWasteQuery,
  type InventoryValuationDto,
  type InventoryValuationQuery,
  type KardexPepsQuery,
  type KardexPepsReportDto,
  type KardexSheetQuery,
  type ReceivablesAgingDto,
  type ReceivablesAgingQuery,
  type SalesMarginDto,
  type SalesMarginQuery,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { buildCoilMonthReportPdf } from '../coils/coil-pdf';
import { sendXlsx } from '../common/list-export';
import { AdminDashboardService } from './admin-dashboard.service';
import { PlantDashboardService } from './plant-dashboard.service';
import { productionSummaryXlsx } from './production-summary-xlsx';
import { ProductionSummaryService } from './production-summary.service';
import { SellerDashboardService } from './seller-dashboard.service';
import { coilMonthXlsx } from './coil-month-xlsx';
import { coilWasteXlsx } from './coil-waste-xlsx';
import { CoilWasteService } from './coil-waste.service';
import { DocumentProfitabilityService } from './document-profitability.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { kardexPepsToDto } from './kardex-peps-dto';
import { kardexPepsXlsx } from './kardex-peps-xlsx';
import { KardexPepsService } from './kardex-peps.service';
import { kardexSheetXlsx } from './kardex-sheet-xlsx';
import { KardexSheetService } from './kardex-sheet.service';
import {
  inventoryValuationXlsx,
  salesMarginXlsx,
  searchNoteRows,
  unsearchedNoteRows,
} from './reports-xlsx';
import {
  searchCoilMonth,
  searchCoilWaste,
  searchInventory,
  searchProduction,
  searchReceivables,
  searchSalesByMaterial,
} from './report-xlsx-search';
import { receivablesAgingXlsx } from './receivables-aging-xlsx';
import { ReceivablesAgingService } from './receivables-aging.service';
import { ReportsService } from './reports.service';
import { salesByMaterialXlsx } from './sales-by-material-xlsx';
import { SalesByMaterialService } from './sales-by-material.service';
import { SalesMarginService } from './sales-margin.service';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Reportes con corte mensual. Solo lectura.
 *
 * Los costos se enmascaran por rol con el mismo criterio que `/inventory` y `/coils`: un
 * VENDEDOR ve las cantidades que necesita para vender y no cuánto costó comprar el rollo.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly inventoryValuation: InventoryValuationService,
    private readonly salesMargin: SalesMarginService,
    private readonly salesByMaterial: SalesByMaterialService,
    private readonly kardexPeps: KardexPepsService,
    private readonly kardexSheet: KardexSheetService,
    private readonly documentProfitability: DocumentProfitabilityService,
    private readonly receivablesAging: ReceivablesAgingService,
    private readonly coilWaste: CoilWasteService,
    private readonly productionSummary: ProductionSummaryService,
    private readonly adminDashboard: AdminDashboardService,
    private readonly plantDashboard: PlantDashboardService,
    private readonly sellerDashboard: SellerDashboardService,
  ) {}

  // El reporte es de planta: el menú ya lo restringe a estos dos roles (`nav.ts`) y la ruta
  // dice lo mismo, en vez de dejar que difieran. No es el caso de `/inventory`, que §3.4 sí le
  // abre al vendedor.
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('coils')
  coils(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(coilMonthReportQuerySchema)) query: CoilMonthReportQuery,
  ): Promise<CoilMonthReportDto> {
    return this.reports.coilsByMonth(query, canSeeCosts(actor));
  }

  /** D-355. El Excel del reporte mensual, del mismo DTO y con el mismo enmascarado por rol. */
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('coils/xlsx')
  async coilsXlsxFile(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(coilMonthReportQuerySchema)) query: CoilMonthReportQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    const report = searchCoilMonth(
      await this.reports.coilsByMonth(query, canSeeCosts(actor)),
      search,
    );
    // Dos tablas recortadas a la vez: la nota no mezcla sus cuentas.
    sendXlsx(res, coilMonthXlsx(report, searchNoteRows(search), unsearchedNoteRows(search)));
  }

  /** D-355. El PDF del reporte mensual, del mismo DTO y con el mismo enmascarado por rol. */
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('coils/pdf')
  async coilsPdfFile(
    @CurrentUser() actor: RequestUser,
    @Query(new ZodValidationPipe(coilMonthReportQuerySchema)) query: CoilMonthReportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.reports.coilsByMonth(query, canSeeCosts(actor));
    const buffer = await buildCoilMonthReportPdf(report, businessToday());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="reporte-bobinas-${report.month}${report.businessLine === null ? '' : `-${report.businessLine}`}.pdf"`,
    );
    res.send(buffer);
  }

  /**
   * RF-S4a/M1. **Solo ADMINISTRADOR**, y a diferencia de `/reports/coils` no enmascara nada:
   * un reporte de costeo sin costos no es un reporte, así que en vez de vaciar columnas se
   * cierra la ruta entera. Lo mismo vale para `/reports/sales-margin`.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('inventory-valuation')
  inventoryValuationReport(
    // cc23: la pestaña de la línea (D-391), validada contra la matriz; fuera de ella, 400.
    @Query(new ZodValidationPipe(inventoryValuationQuerySchema)) query: InventoryValuationQuery,
  ): Promise<InventoryValuationDto> {
    return this.inventoryValuation.valuation(query);
  }

  /**
   * RF-S4a/M2. Solo ADMINISTRADOR, por el mismo motivo. cc23: `businessLine` es la pestaña de
   * la línea (D-391), validada contra la matriz; una línea fuera de ella es 400.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-margin')
  salesMarginReport(
    @Query(new ZodValidationPipe(salesMarginQuerySchema)) query: SalesMarginQuery,
  ): Promise<SalesMarginDto> {
    return this.salesMargin.salesMargin(query);
  }

  /**
   * RF-S4a/M3. El xlsx sale del **mismo DTO** que la pantalla, no de una segunda consulta:
   * dos caminos hasta la base para la misma pregunta es cómo el archivo y la pantalla
   * terminan diciendo números distintos.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('inventory-valuation/xlsx')
  async inventoryValuationXlsxFile(
    // cc39 (D-580): la pestaña de la línea, con el mismo esquema que la pantalla.
    @Query(new ZodValidationPipe(inventoryValuationQuerySchema)) query: InventoryValuationQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    const report = searchInventory(await this.inventoryValuation.valuation(query), search);
    // Grupos y productos se recortan a la vez: la nota no mezcla sus cuentas.
    sendXlsx(
      res,
      inventoryValuationXlsx(
        report,
        query.businessLine,
        searchNoteRows(search),
        unsearchedNoteRows(search),
      ),
    );
  }

  /** RF-S4a/M3. */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-margin/xlsx')
  async salesMarginXlsxFile(
    @Query(new ZodValidationPipe(salesMarginQuerySchema)) query: SalesMarginQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    // cc39 (D-580, reemplaza a D-396 en el Excel): el Excel de la pestaña que se ve, con el mismo
    // DTO que la pantalla; sin línea, el de «Todas» de siempre.
    const report = await this.salesMargin.salesMargin(query);
    sendXlsx(res, salesMarginXlsx(report, query.businessLine, search));
  }

  /**
   * D-354. Ventas por material. Solo ADMINISTRADOR: lleva costos. cc24 (D-406, D-407):
   * `businessLine` es la pestaña (Coberturas Aluzinc o Drywall); sin ella, Coberturas Aluzinc.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-by-material')
  salesByMaterialReport(
    @Query(new ZodValidationPipe(salesByMaterialQuerySchema)) query: SalesByMaterialQuery,
  ): Promise<SalesByMaterialDto> {
    return this.salesByMaterial.report(query);
  }

  /** D-354. El xlsx sale del mismo DTO que la pantalla, con los mismos filtros. */
  @Roles(Role.ADMINISTRADOR)
  @Get('sales-by-material/xlsx')
  async salesByMaterialXlsxFile(
    @Query(new ZodValidationPipe(salesByMaterialQuerySchema)) query: SalesByMaterialQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    // cc39 (D-580, reemplaza a D-416): el Excel de la pestaña que se ve, con sus filtros; sin
    // línea, Coberturas Aluzinc, como la pantalla.
    const full = await this.salesByMaterial.report(query);
    const report = searchSalesByMaterial(full, search);
    const count = (r: SalesByMaterialDto) => r.products?.rows.length ?? r.rows.length;
    sendXlsx(res, salesByMaterialXlsx(report, searchNoteRows(search, count(report), count(full))));
  }

  /**
   * cc25 (D-421..D-423). Cuentas por cobrar por antigüedad, por cliente. Solo ADMINISTRADOR
   * (D-426): un vendedor ve sus cobranzas en /cobranzas, no la cartera de todos.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('receivables-aging')
  receivablesAgingReport(
    @Query(new ZodValidationPipe(receivablesAgingQuerySchema)) query: ReceivablesAgingQuery,
  ): Promise<ReceivablesAgingDto> {
    return this.receivablesAging.report(query);
  }

  /** cc25 (D-426, M3). El xlsx sale del mismo DTO que la pantalla, con el mismo vendedor. */
  @Roles(Role.ADMINISTRADOR)
  @Get('receivables-aging/xlsx')
  async receivablesAgingXlsxFile(
    @Query(new ZodValidationPipe(receivablesAgingQuerySchema)) query: ReceivablesAgingQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    const full = await this.receivablesAging.report(query);
    const report = searchReceivables(full, search);
    sendXlsx(
      res,
      receivablesAgingXlsx(
        report,
        searchNoteRows(search, report.customers.length, full.customers.length),
      ),
    );
  }

  /**
   * cc25 (D-424, D-425). Merma por bobina en un rango. Solo ADMINISTRADOR (D-426).
   * `businessLine` es la pestaña (Coberturas Aluzinc o Drywall); otra línea es 400.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('coil-waste')
  coilWasteReport(
    @Query(new ZodValidationPipe(coilWasteQuerySchema)) query: CoilWasteQuery,
  ): Promise<CoilWasteDto> {
    return this.coilWaste.report(query);
  }

  /** cc39 (D-580). El xlsx de Merma por bobina, del mismo DTO que la pantalla y su pestaña. */
  @Roles(Role.ADMINISTRADOR)
  @Get('coil-waste/xlsx')
  async coilWasteXlsxFile(
    @Query(new ZodValidationPipe(coilWasteQuerySchema)) query: CoilWasteQuery,
    // cc40 (D-588): la búsqueda de la pantalla; el archivo trae las mismas filas.
    @Query(new ZodValidationPipe(reportXlsxSearchSchema)) { search = '' }: ReportXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    const full = await this.coilWaste.report(query);
    const report = searchCoilWaste(full, search);
    sendXlsx(
      res,
      coilWasteXlsx(report, searchNoteRows(search, report.rows.length, full.rows.length)),
    );
  }

  /**
   * cc29 (M2, D-464, D-468). Reporte de producción por OP en un rango, por pestaña (Coberturas
   * Aluzinc o Drywall). Administrador y supervisor de planta; los costos, solo el administrador
   * (el supervisor recibe el mismo reporte sin ellos).
   */
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('production-summary')
  productionSummaryReport(
    @Query(new ZodValidationPipe(productionSummaryQuerySchema)) query: ProductionSummaryQuery,
    @CurrentUser() actor: RequestUser,
  ): Promise<ProductionSummaryDto> {
    return this.productionSummary.report(query, actor.role === Role.ADMINISTRADOR);
  }

  /** cc29 (M2). El xlsx sale del mismo DTO que la pantalla, con el mismo alcance de costos. */
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('production-summary/xlsx')
  async productionSummaryXlsxFile(
    @Query(new ZodValidationPipe(productionSummaryQuerySchema)) query: ProductionSummaryQuery,
    @CurrentUser() actor: RequestUser,
    // cc40 (D-588): la búsqueda de la pantalla y su «Ver por», que decide qué se busca.
    @Query(new ZodValidationPipe(productionXlsxSearchSchema))
    { search = '', ver = 'orden' }: ProductionXlsxSearch,
    @Res() res: Response,
  ): Promise<void> {
    const full = await this.productionSummary.report(query, actor.role === Role.ADMINISTRADOR);
    const report = searchProduction(full, search, ver);
    const count = (r: ProductionSummaryDto) =>
      ver === 'pedido' ? r.groups.length : r.groups.reduce((n, g) => n + g.orders.length, 0);
    sendXlsx(
      res,
      productionSummaryXlsx(report, searchNoteRows(search, count(report), count(full))),
    );
  }

  /**
   * cc26 (D-440, M4). El Panel del administrador: los totales de ventas y margen, CxC,
   * inventario valorizado y merma, leídos con las mismas funciones que esos reportes y para los
   * rangos que sus enlaces llevan. Solo ADMINISTRADOR, como cada uno de ellos.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('admin-dashboard')
  adminDashboardReport(): Promise<AdminDashboardDto> {
    return this.adminDashboard.dashboard();
  }

  /**
   * cc26 (D-440, M5). El Panel del supervisor de planta: la cola y las bobinas montadas de
   * `/planta`, lo consumido en producción hoy y en la semana y las bobinas por terminarse. Los
   * roles son los de esas lecturas (`/production`, `/coils`: administrador y planta). Del reporte
   * de merma, que es solo del administrador, toma únicamente los kilos consumidos, que planta ya
   * ve en su kardex (D-449): ni costos, ni teórico, ni merma.
   */
  @Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
  @Get('plant-dashboard')
  plantDashboardReport(@CurrentUser() actor: RequestUser): Promise<PlantDashboardDto> {
    return this.plantDashboard.dashboard(actor);
  }

  /**
   * cc27 (M4, D-457). El Panel del vendedor: sus ventas del mes sin IGV y su conversión de
   * cotización a pedido. Solo VENDEDOR y **solo lo suyo**: el alcance lo pone el servidor con las
   * mismas reglas que sus listas de comprobantes y cotizaciones. Sin costos ni márgenes.
   */
  @Roles(Role.VENDEDOR)
  @Get('seller-dashboard')
  sellerDashboardReport(@CurrentUser() actor: RequestUser): Promise<SellerDashboardDto> {
    return this.sellerDashboard.dashboard(actor);
  }

  /**
   * C06. Rentabilidad de un comprobante, línea por línea. Solo ADMINISTRADOR: lleva costos (un
   * VENDEDOR recibe 403, D-244). Nunca va en el PDF ni en lo que se envía a SUNAT: es otra ruta.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('documents/:id/profitability')
  documentProfitabilityReport(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentProfitabilityDto> {
    return this.documentProfitability.profitability(id);
  }

  /**
   * D-298. El Excel del kardex de un ítem con el formato del cliente (Fecha, Detalle, ENTRADAS,
   * SALIDAS, SALDO), en el método elegido. Solo ADMINISTRADOR: lleva costos. Compone el kardex
   * y el reporte PEPS que ya existen; no calcula nada nuevo.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('kardex/xlsx')
  async kardexSheetXlsxFile(
    @Query(new ZodValidationPipe(kardexSheetQuerySchema)) query: KardexSheetQuery,
    @Res() res: Response,
  ): Promise<void> {
    sendXlsx(res, kardexSheetXlsx(await this.kardexSheet.sheet(query)));
  }

  /**
   * D-296. El mismo kardex PEPS, en JSON, para verlo en pantalla junto al costo promedio.
   * Sale del mismo servicio que el Excel (`KardexPepsService.report`): no recalcula nada. Solo
   * ADMINISTRADOR, como el Excel.
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('kardex-peps')
  async kardexPepsJson(
    @Query(new ZodValidationPipe(kardexPepsQuerySchema)) query: KardexPepsQuery,
  ): Promise<KardexPepsReportDto> {
    return kardexPepsToDto(await this.kardexPeps.report(query));
  }

  /**
   * D-279. Kardex PEPS de un producto o una bobina en el formato 13.1 de SUNAT. Solo
   * ADMINISTRADOR: es un reporte de costos. No cambia la valorización del sistema (D-028).
   */
  @Roles(Role.ADMINISTRADOR)
  @Get('kardex-peps/xlsx')
  async kardexPepsXlsxFile(
    @Query(new ZodValidationPipe(kardexPepsQuerySchema)) query: KardexPepsQuery,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.kardexPeps.report(query);
    sendXlsx(res, kardexPepsXlsx(report));
  }
}

function canSeeCosts(actor: RequestUser): boolean {
  return actor.role === Role.ADMINISTRADOR || actor.role === Role.SUPERVISOR_PLANTA;
}
