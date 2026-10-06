import {
  ARQUEO_METHOD,
  PaymentMethod,
  POS_PAYMENT_METHODS,
  PosSaleStatus,
  cashSessionCode,
  cents,
  createPosSaleSchema,
  expectedCash,
  posSaleCode,
  toDecimal,
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

  it('tampoco cuenta una venta que se está anulando (D-100)', () => {
    // `VOIDING` es el reclamo de la cadena de reversas: desde ese instante el dinero de esa
    // venta ya no cuenta para el arqueo, que es lo que impide que un cierre concurrente
    // congele un esperado con una venta cuyo cobro ya se revirtió.
    const result = expectedCash('10.0000', [
      sale({ totalPen: '90.0000', status: PosSaleStatus.VOIDING }),
      sale({ totalPen: '5.0000' }),
    ]);
    expect(result.toFixed(4)).toBe('15.0000');
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

  it('redondea al céntimo una sola vez, después de sumar (P-14)', () => {
    // 3 × 33.3350 = 100.0050 → 100.01. Redondear cada venta antes de sumar daría 3 × 33.34 =
    // 100.02: el redondeo va al final, sobre la suma.
    const result = expectedCash('0.0000', [
      sale({ totalPen: '33.3350' }),
      sale({ totalPen: '33.3350' }),
      sale({ totalPen: '33.3350' }),
    ]);
    expect(result.toFixed(4)).toBe('100.0100');
  });

  it('un esperado con fracción de céntimo cuadra con el contado en céntimos (P-14)', () => {
    // La venta guardó 412.3456 (4 decimales); el cajón tiene 412.35. Sin el redondeo, el
    // arqueo marcaba un sobrante de S/ 0.0044 imposible de cuadrar con billetes.
    const expected = expectedCash('0.0000', [sale({ totalPen: '412.3456' })]);
    expect(expected.toFixed(4)).toBe('412.3500');
    expect(cents(toDecimal('412.35').minus(expected)).isZero()).toBe(true);
    // Medio céntimo sube (HALF_UP).
    expect(expectedCash('0.0000', [sale({ totalPen: '10.0050' })]).toFixed(4)).toBe('10.0100');
    expect(expectedCash('0.0000', [sale({ totalPen: '10.0049' })]).toFixed(4)).toBe('10.0000');
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

  it('no tiene forma de pedir material a medida: un campo que no existe es un 400 (D-098, cc28)', () => {
    // cc28 (A-2 de cc27): el ítem es estricto. Antes Zod descartaba en silencio lo que no
    // declaraba; ahora lo rechaza, así que tampoco hay bobina que pedir por la puerta de atrás.
    const result = createPosSaleSchema.safeParse({
      ...base,
      items: [{ ...base.items[0], reserveFromCoilId: '22222222-2222-4222-8222-222222222222' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it('un campo de precio desconocido no cae al precio de lista: 400 (A-2 de cc27)', () => {
    const result = createPosSaleSchema.safeParse({
      ...base,
      items: [{ ...base.items[0], unitPriceWithTaxPen: '59.00' }],
    });
    expect(result.success).toBe(false);
  });

  it('acepta el precio con IGV tipeado en caja, pero no junto al valor sin IGV (D-452)', () => {
    const item = base.items[0];
    const withIgv = createPosSaleSchema.parse({
      ...base,
      items: [{ ...item, unitPriceWithIgvPen: '59.00' }],
    });
    expect(withIgv.items[0]?.unitPriceWithIgvPen).toBe('59.0000');
    const both = createPosSaleSchema.safeParse({
      ...base,
      items: [{ ...item, unitPricePen: '50.00', unitPriceWithIgvPen: '59.00' }],
    });
    expect(both.success).toBe(false);
    if (!both.success) {
      expect(both.error.issues[0]?.message).toContain('no los dos');
    }
  });
});
