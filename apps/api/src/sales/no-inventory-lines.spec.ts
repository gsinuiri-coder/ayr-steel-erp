import { InventoryItemType, InventoryStrategy, type Prisma } from '@prisma/client';
import { carriesInventory, Unit } from '@ayr/shared';
import { resolveSalesLines } from './sales-lines';

/**
 * **Centinela de D-167**: una línea de negocio sin inventario se cotiza.
 *
 * La exención la decide el **atributo** `inventoryStrategy` de la línea de negocio, nunca su
 * código ni su nombre: agregar «Fletes» o «Montaje» como línea `NOOP` tiene que funcionar sin
 * tocar una sola condición. Por eso el test no nombra `services` en ningún lado.
 *
 * Lo que se comprueba de verdad son las dos mitades del defecto, que son distintas:
 *
 * 1. la línea **entra** (antes moría con «es de una línea sin inventario: no se cotiza»);
 * 2. un producto físico **sin saldo** sigue entrando igual que siempre — el rechazo por falta
 *    de stock nunca estuvo acá, vive en `createReservations` y no se movió. Si alguien
 *    "arreglara" esto poniendo el chequeo de disponible en la resolución de líneas, este caso
 *    se cae.
 */

interface FakeProduct {
  id: string;
  sku: string;
  name: string;
  unit: string;
  isActive: boolean;
  businessLineId: string;
  listPricePen: { toFixed: (n: number) => string } | null;
  roofingKind: null;
  lengthMm: null;
  thicknessMm: null;
  widthMm: null;
  colorId: null;
  color: null;
  finish: null;
  businessLine: { inventoryStrategy: InventoryStrategy };
}

function product(overrides: Partial<FakeProduct> & Pick<FakeProduct, 'id' | 'sku'>): FakeProduct {
  return {
    name: overrides.sku,
    unit: Unit.NIU,
    isActive: true,
    businessLineId: 'bl-1',
    listPricePen: null,
    roofingKind: null,
    lengthMm: null,
    thicknessMm: null,
    widthMm: null,
    colorId: null,
    color: null,
    finish: null,
    businessLine: { inventoryStrategy: InventoryStrategy.STOCK },
    ...overrides,
  };
}

/**
 * Lo mínimo de `tx` que `resolveSalesLines` toca cuando no hay líneas de bobina ni de
 * cobertura a medida y no se pide el piso de precio: una sola consulta de productos.
 */
function txWith(products: FakeProduct[]): Prisma.TransactionClient {
  return {
    product: { findMany: jest.fn().mockResolvedValue(products) },
  } as unknown as Prisma.TransactionClient;
}

describe('D-167 — una línea de negocio sin inventario se cotiza', () => {
  it('`carriesInventory` responde por el atributo de la línea, no por su código', () => {
    expect(carriesInventory({ inventoryStrategy: InventoryStrategy.NOOP })).toBe(false);
    expect(carriesInventory({ inventoryStrategy: InventoryStrategy.STOCK })).toBe(true);
  });

  it('un servicio se cotiza con su precio y sin prometer existencias', async () => {
    const servicio = product({
      id: 'p-servicio',
      sku: 'CONFORMADO',
      name: 'SERVICIO DE CONFORMADO',
      unit: Unit.TNE,
      businessLineId: 'bl-servicios',
      businessLine: { inventoryStrategy: InventoryStrategy.NOOP },
    });

    const [line] = await resolveSalesLines(txWith([servicio]), [
      { productId: 'p-servicio', qty: '2.000', unitPricePen: '150.0000' },
    ]);

    expect(line).toBeDefined();
    expect(line?.productSku).toBe('CONFORMADO');
    expect(line?.subtotalPen).toBe('300.0000');
    expect(line?.igvPen).toBe('54.0000');
    // Las coordenadas de reserva se guardan igual —las columnas no son nulables— y apuntan al
    // propio producto. Quien no abre la fila de reserva es `createReservations`, que salta las
    // líneas `NOOP`: acá lo que importa es que la línea **existe** y que no promete kilos de
    // ninguna materia prima, que es lo que la mandaría a producción.
    expect(line?.reserveItemType).toBe(InventoryItemType.PRODUCT);
    expect(line?.reserveItemId).toBe('p-servicio');
    expect(line?.reserveUnit).toBe(Unit.TNE);
  });

  it('el importador de históricos cotiza el mismo servicio por el mismo camino', async () => {
    // D-152 no tiene una resolución de líneas propia: confirma con `resolveSalesLines`, así
    // que arreglarlo en un solo lugar arregla la cotización manual y el archivo a la vez.
    // Lo que el importador sí trae distinto es el valor unitario derivado del papel, con sus
    // cuatro decimales.
    const servicio = product({
      id: 'p-servicio',
      sku: 'CONFORMADO',
      unit: Unit.TNE,
      businessLine: { inventoryStrategy: InventoryStrategy.NOOP },
    });

    const [line] = await resolveSalesLines(txWith([servicio]), [
      { productId: 'p-servicio', qty: '1.250', unitPricePen: '183.0508' },
    ]);

    expect(line?.subtotalPen).toBe('228.8135');
  });

  it('un producto físico sin saldo se sigue cotizando: el disponible se mira al confirmar', async () => {
    const fisico = product({ id: 'p-fisico', sku: 'PERFIL-60', unit: Unit.NIU });

    const [line] = await resolveSalesLines(txWith([fisico]), [
      { productId: 'p-fisico', qty: '10.000', unitPricePen: '12.0000' },
    ]);

    expect(line?.productSku).toBe('PERFIL-60');
    expect(line?.reserveQty).toBe('10.000');
  });

  it('un servicio desactivado se sigue rechazando: la exención es del inventario, no del maestro', async () => {
    const servicio = product({
      id: 'p-servicio',
      sku: 'CONFORMADO',
      isActive: false,
      businessLine: { inventoryStrategy: InventoryStrategy.NOOP },
    });

    await expect(
      resolveSalesLines(txWith([servicio]), [
        { productId: 'p-servicio', qty: '1.000', unitPricePen: '100.0000' },
      ]),
    ).rejects.toThrow('está desactivado');
  });
});
