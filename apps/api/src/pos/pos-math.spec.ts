import {
  ARQUEO_METHOD,
  PaymentMethod,
  POS_PAYMENT_METHODS,
  PosSaleStatus,
  cashSessionCode,
  createPosSaleSchema,
  expectedCash,
  posSaleCode,
  totalsByMethod,
  type CashSaleLike,
} from '@ayr/shared';

/**
 * Aritmética del arqueo de caja (D-101) y forma de la venta de mostrador (D-098, D-099).
 *
 * Todo en soles y con `Decimal` (D-003): el arqueo es dinero, y una diferencia calculada
 * con `number` es exactamente el tipo de centavo que hace que una caja no cuadre.
 */

const sale = (over: Partial<CashSaleLike> = {}): CashSaleLike => ({
  method: PaymentMethod.CASH,
  totalPen: '100.0000',
  status: PosSaleStatus.ACTIVE,
  ...over,
});

describe('expectedCash (D-101)', () => {
  it('suma la apertura y las ventas en efectivo del turno', () => {
    const result = expectedCash('200.0000', [sale({ totalPen: '150.5000' }), sale()]);
    expect(result.toFixed(4)).toBe('450.5000');
  });

  it('no cuenta los medios que no ponen billetes en el cajón', () => {
    const result = expectedCash('100.0000', [
      sale({ method: PaymentMethod.CARD, totalPen: '900.0000' }),
      sale({ method: PaymentMethod.WALLET, totalPen: '80.0000' }),
      sale({ method: PaymentMethod.TRANSFER, totalPen: '500.0000' }),
      sale({ totalPen: '25.0000' }),
    ]);
    expect(result.toFixed(4)).toBe('125.0000');
  });

  it('no cuenta una venta anulada: su cobro se revirtió y el dinero salió del cajón', () => {
    const result = expectedCash('50.0000', [
      sale({ totalPen: '300.0000', status: PosSaleStatus.VOIDED }),
      sale({ totalPen: '20.0000' }),
    ]);
    expect(result.toFixed(4)).toBe('70.0000');
  });

  it('un turno sin ventas espera exactamente su apertura', () => {
    expect(expectedCash('0.0000', []).toFixed(4)).toBe('0.0000');
    expect(expectedCash('123.4500', []).toFixed(4)).toBe('123.4500');
  });

  it('acumula sin error de coma flotante', () => {
    // 0.10 × 3 en `number` da 0.30000000000000004; con Decimal, no (D-003).
    const centavos = [
      sale({ totalPen: '0.1000' }),
      sale({ totalPen: '0.1000' }),
      sale({ totalPen: '0.1000' }),
    ];
    expect(expectedCash('0.0000', centavos).toFixed(4)).toBe('0.3000');
  });

  it('el medio del arqueo es el efectivo y solo el efectivo', () => {
    expect(ARQUEO_METHOD).toBe(PaymentMethod.CASH);
  });
});

describe('totalsByMethod (D-101)', () => {
  it('reparte las ventas vigentes por medio y deja el resto en cero', () => {
    const totals = totalsByMethod([
      sale({ totalPen: '10.0000' }),
      sale({ method: PaymentMethod.CARD, totalPen: '30.0000' }),
      sale({ method: PaymentMethod.CARD, totalPen: '5.0000' }),
      sale({ method: PaymentMethod.WALLET, totalPen: '99.0000', status: PosSaleStatus.VOIDED }),
    ]);
    expect(totals[PaymentMethod.CASH].toFixed(4)).toBe('10.0000');
    expect(totals[PaymentMethod.CARD].toFixed(4)).toBe('35.0000');
    expect(totals[PaymentMethod.WALLET].toFixed(4)).toBe('0.0000');
    expect(totals[PaymentMethod.CHECK].toFixed(4)).toBe('0.0000');
  });
});

describe('códigos legibles', () => {
  it('rellena a seis dígitos como el resto del proyecto', () => {
    expect(cashSessionCode(1)).toBe('CAJA-000001');
    expect(cashSessionCode(123456)).toBe('CAJA-123456');
    expect(posSaleCode(7)).toBe('MOS-000007');
  });
});

describe('createPosSaleSchema (D-098, D-099)', () => {
  const base = {
    method: PaymentMethod.CASH,
    items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: '2.000' }],
  };

  it('acepta la venta mínima: un producto, efectivo y cliente genérico implícito', () => {
    const parsed = createPosSaleSchema.parse(base);
    expect(parsed.customerId).toBeUndefined();
    expect(parsed.forceGenericCustomer).toBe(false);
  });

  it('rechaza un carrito vacío', () => {
    expect(createPosSaleSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });

  it('rechaza el mismo producto dos veces: juntos podrían llevarse más de lo que hay', () => {
    const result = createPosSaleSchema.safeParse({
      ...base,
      items: [...base.items, ...base.items],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('ya está en el carrito');
    }
  });

  it('rechaza un medio de pago que el mostrador no ofrece', () => {
    expect(createPosSaleSchema.safeParse({ ...base, method: PaymentMethod.CHECK }).success).toBe(
      false,
    );
  });

  it('ofrece exactamente los cuatro medios de mostrador', () => {
    expect([...POS_PAYMENT_METHODS]).toEqual([
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.WALLET,
      PaymentMethod.TRANSFER,
    ]);
  });

  it('no tiene forma de pedir material a medida: los campos no existen (D-098)', () => {
    const parsed = createPosSaleSchema.parse({
      ...base,
      items: [{ ...base.items[0], reserveFromCoilId: '22222222-2222-4222-8222-222222222222' }],
    });
    // Zod descarta lo que el esquema no declara: la línea llega al API sin bobina, así que
    // `resolveSalesLines` la resuelve contra el propio producto y nunca contra un insumo.
    expect(parsed.items[0]).not.toHaveProperty('reserveFromCoilId');
  });
});
