import {
  kardexPepsQuerySchema,
  kardexSheetQuerySchema,
  type InventoryMovementDto,
} from '@ayr/shared';
import { KardexSheetService } from './kardex-sheet.service';
import { ReportsModule } from './reports.module';
import type { InventoryService } from '../inventory/inventory.service';
import type { KardexPepsService } from './kardex-peps.service';

// D-298: el servicio compone lo que ya existe; no calcula costos.
const ITEM = { itemType: 'COIL' as const, itemId: '00000000-0000-4000-8000-000000000001' };

function build() {
  const inventory = {
    resolveItem: jest.fn().mockResolvedValue({
      ...ITEM,
      code: 'BOB-1',
      description: 'Bobina 0.38',
      inactive: false,
    }),
    findMovements: jest.fn(),
  };
  const peps = { report: jest.fn() };
  const service = new KardexSheetService(
    inventory as unknown as InventoryService,
    peps as unknown as KardexPepsService,
  );
  return { service, inventory, peps };
}

const query = { ...ITEM, from: '2026-09-01', to: '2026-09-30' };

describe('KardexSheetService', () => {
  it('promedio: lee el kardex del ítem con costos y arma la hoja', async () => {
    const { service, inventory, peps } = build();
    inventory.findMovements.mockResolvedValue({
      items: [
        {
          id: '1',
          type: 'IN',
          qty: '10.000',
          unit: 'KGM',
          unitCost: '5.0000',
          totalCost: '50.0000',
          refType: 'PURCHASE',
          notes: null,
          reversalOfId: null,
          operationDate: '2026-09-02',
          balanceQty: '10.000',
          balanceAvgCost: '5.0000',
          balanceTotalCost: '50.0000',
        } as InventoryMovementDto,
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    const sheet = await service.sheet({ ...query, method: 'AVERAGE' });
    expect(inventory.findMovements).toHaveBeenCalledWith(
      { itemType: 'COIL', itemId: ITEM.itemId, from: '2026-09-01', to: '2026-09-30' },
      true,
    );
    expect(peps.report).not.toHaveBeenCalled();
    expect(sheet).toMatchObject({
      method: 'AVERAGE',
      itemCode: 'BOB-1',
      itemDescription: 'Bobina 0.38',
      unit: 'KGM',
    });
    expect(sheet.rows[0]).toMatchObject({ inQty: '10.000', balanceTotal: '50.0000' });
  });

  it('PEPS: sale del reporte de D-279, sin tocar el kardex a promedio', async () => {
    const { service, inventory, peps } = build();
    peps.report.mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-30',
      itemCode: 'BOB-1',
      itemDescription: 'Bobina',
      unitCode: '01 - KILOGRAMOS',
      peps: {
        opening: { qty: '0.000', unitCost: '0.0000', total: '0.0000', layers: [] },
        rows: [],
        closing: { qty: '0.000', unitCost: '0.0000', total: '0.0000', layers: [] },
        totals: { inQty: '0.000', inTotal: '0.0000', outQty: '0.000', outTotal: '0.0000' },
        warnings: [],
      },
      documents: new Map(),
    });
    const sheet = await service.sheet({ ...query, method: 'PEPS' });
    expect(inventory.findMovements).not.toHaveBeenCalled();
    expect(sheet.method).toBe('PEPS');
    expect(sheet.rows.map((r) => r.kind)).toEqual(['opening', 'totals']);
  });
});

describe('esquemas de consulta del kardex', () => {
  it('el Excel del cliente exige rango ordenado y usa Promedio por defecto', () => {
    const ok = kardexSheetQuerySchema.parse({ ...query });
    expect(ok.method).toBe('AVERAGE');
    expect(kardexSheetQuerySchema.safeParse({ ...query, from: '2026-10-01' }).success).toBe(false);
    expect(kardexSheetQuerySchema.safeParse({ ...query, itemType: 'RAW_MATERIAL' }).success).toBe(
      false,
    );
    expect(kardexSheetQuerySchema.safeParse({ ...query, method: 'FIFO' }).success).toBe(false);
  });

  it('el PEPS también rechaza un ítem que no es producto ni bobina y un rango al revés', () => {
    expect(kardexPepsQuerySchema.safeParse({ ...query, itemType: 'RAW_MATERIAL' }).success).toBe(
      false,
    );
    expect(kardexPepsQuerySchema.safeParse({ ...query, from: '2026-10-01' }).success).toBe(false);
    expect(kardexPepsQuerySchema.safeParse(query).success).toBe(true);
  });
});

describe('ReportsModule', () => {
  it('registra el servicio de la hoja del kardex', () => {
    expect(ReportsModule).toBeDefined();
    const providers = Reflect.getMetadata('providers', ReportsModule) as unknown[];
    expect(providers).toContain(KardexSheetService);
  });
});
