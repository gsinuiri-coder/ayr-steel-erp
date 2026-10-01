import {
  defaultRoofingPlan,
  derivedUnitValue,
  EXTERNAL_INVOICE_NOTES_PREFIX,
  importQuotationsSchema,
  importRowNetPen,
  importUnitPriceText,
  isImportedQuotation,
  keepImportMarker,
  importDocTypeOf,
  lineAmounts,
  MAX_PIECE_LENGTH_MM,
  piecesMeters,
  suggestedRoofingPlanText,
} from '@ayr/shared';

/**
 * Lo que el importador de cotizaciones decide **sin base de datos** (D-152): el plan de corte
 * por defecto. Es la única aritmética de la puerta nueva, y es justo donde el dueño eligió que
 * el importador **falle en vez de inventar**.
 */
describe('defaultRoofingPlan (D-152)', () => {
  it('una línea que entra en una plancha se convierte en 1 × sus metros', () => {
    const plan = defaultRoofingPlan('12.500');
    expect(plan.ok).toBe(true);
    if (plan.ok !== true) return;
    expect(plan.pieces).toEqual([{ lengthMm: '12500.00', qty: 1 }]);
    // Y los metros del plan son los de la línea: es la invariante que el alta vuelve a exigir.
    expect(piecesMeters(plan.pieces).toFixed(3)).toBe('12.500');
  });

  it('el borde exacto de una plancha entra', () => {
    const plan = defaultRoofingPlan(String(MAX_PIECE_LENGTH_MM / 1000));
    expect(plan.ok).toBe(true);
  });

  it('un metro más que el tope ya no: el plan se escribe a mano', () => {
    // El caso real del archivo de agosto: 23 de las 27 líneas en metro lineal se pasan, y una
    // llega a 1 832 m. Repartirlas en planchas de 6 m habría escrito en el plan de corte —que
    // después es el tope duro de lo que planta puede reportar (D-146)— un dato que el Excel no
    // dice en ninguna parte.
    const plan = defaultRoofingPlan('81.900');
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.reason).toContain('1 × 81.90 m');
    expect(plan.reason).toContain('escribe el plan de corte real');
  });

  it('una cantidad en cero o negativa no deriva ningún plan', () => {
    expect(defaultRoofingPlan('0').ok).toBe(false);
    expect(defaultRoofingPlan('-3').ok).toBe(false);
  });

  it('un largo por debajo del mínimo tampoco: eso es un recorte, no una plancha', () => {
    const plan = defaultRoofingPlan('0.05');
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.reason).toContain('no baja de');
  });
});

/**
 * La sugerencia que el preview escribe en la celda del plan.
 *
 * Es lo que hace que corregir una línea imposible sea **editar un número** y no transcribir
 * la cifra del papel a mano. Lo que **no** hace es volver válido lo que no lo es: una línea
 * de 81.9 m sigue sin caber en una plancha y la celda lo dice — la regla de D-152 sigue viva,
 * y `defaultRoofingPlan` (arriba) es su centinela.
 */
describe('suggestedRoofingPlanText', () => {
  it('siempre es 1 × los metros de la línea', () => {
    expect(suggestedRoofingPlanText('12.500')).toBe('1x12.5');
    expect(suggestedRoofingPlanText('4.000')).toBe('1x4');
  });

  it('sugiere igual lo que no cabe en una plancha: la celda avisa, no se queda vacía', () => {
    // La línea más larga del archivo de agosto. `defaultRoofingPlan` la rechaza y así queda:
    // lo único que cambia es que el campo llega con `1x1832` en vez de en blanco.
    expect(suggestedRoofingPlanText('1832.000')).toBe('1x1832');
    expect(defaultRoofingPlan('1832.000').ok).toBe(false);
  });

  it('sin cantidad no hay nada que sugerir', () => {
    expect(suggestedRoofingPlanText('0')).toBe('');
  });
});

/**
 * D-158 — a qué padrón se le pregunta por un documento del archivo.
 *
 * El carné de extranjería no está en ningún padrón consultable y su longitud se solapa con
 * todo, así que no se deriva: esa fila se resuelve con el alta express.
 */
describe('importDocTypeOf (D-158)', () => {
  it('once dígitos son RUC y ocho son DNI', () => {
    expect(importDocTypeOf('20606364335')).toBe('RUC');
    expect(importDocTypeOf('41234567')).toBe('DNI');
  });

  it('cualquier otra cosa no se consulta: gastaría cuota para recibir un 404', () => {
    expect(importDocTypeOf('123456')).toBeNull();
    expect(importDocTypeOf('X0123456')).toBeNull();
    expect(importDocTypeOf('')).toBeNull();
  });
});

/**
 * La marca de procedencia del comprobante externo (D-152), y por qué sobrevive a una edición
 * (D-163).
 *
 * De ella dependen dos cosas que no se ven: el aviso de reimportación del preview, y que el
 * piso duro de precio **no** se le aplique a un documento histórico. El `PUT` reemplazaba las
 * observaciones con lo que viniera en el cuerpo, así que editar una cotización importada sin
 * reenviarlas la dejaba sin marca — y el **segundo** guardado, con el mismo precio histórico,
 * rebotaba contra el piso. Un documento que se vuelve inválido por haberlo guardado dos veces.
 */
describe('la marca del comprobante externo (D-152/D-163)', () => {
  const MARKER = `${EXTERNAL_INVOICE_NOTES_PREFIX}F001-000123`;

  it('reconoce una cotización importada por el prefijo, y solo por el prefijo', () => {
    expect(isImportedQuotation(MARKER)).toBe(true);
    expect(isImportedQuotation(`${MARKER}\nRevisada por ventas`)).toBe(true);
    expect(isImportedQuotation(null)).toBe(false);
    expect(isImportedQuotation('Observaciones del vendedor')).toBe(false);
    // No alcanza con nombrarla en el medio: la marca es un prefijo.
    expect(isImportedQuotation(`Nota: ${MARKER}`)).toBe(false);
  });

  it('una edición que borra las observaciones no borra la marca', () => {
    expect(keepImportMarker(MARKER, null)).toBe(MARKER);
    expect(keepImportMarker(MARKER, '   ')).toBe(MARKER);
  });

  it('la marca queda primero y el texto del vendedor debajo', () => {
    expect(keepImportMarker(MARKER, 'Cliente pidió reponer')).toBe(
      `${MARKER}\nCliente pidió reponer`,
    );
  });

  it('si el texto nuevo ya trae la marca no se duplica', () => {
    const withMarker = `${MARKER}\nYa venía`;
    expect(keepImportMarker(MARKER, withMarker)).toBe(withMarker);
  });

  it('una cotización que no es importada no gana ninguna marca', () => {
    expect(keepImportMarker(null, 'Observaciones')).toBe('Observaciones');
    expect(keepImportMarker('Observaciones viejas', null)).toBeNull();
  });

  it('lo que se recorta al tope de la columna es el texto, nunca la marca', () => {
    const long = 'x'.repeat(600);
    const result = keepImportMarker(MARKER, long);
    expect(result?.length).toBe(500);
    expect(result?.startsWith(MARKER)).toBe(true);
    // Y sigue siendo reconocible como importada después del recorte, que es todo el punto.
    expect(isImportedQuotation(result)).toBe(true);
  });
});

describe('P14 §3.5 — el unitario de la fila conserva sus decimales', () => {
  /** El caso del dueño: 146 × 16.28928, valor de venta 2 378.23488 → 2 378.2349. */
  const QTY = '146.000';
  const UNIT = '16.28928';
  const NET = '2378.2349';

  const row = (unitPricePen: string) => ({
    rowNumber: 1,
    documentKey: 'FFA1-0146',
    issueDate: '2026-09-30',
    customerId: '11111111-1111-4111-8111-111111111111',
    productId: '22222222-2222-4222-8222-222222222222',
    qty: QTY,
    unitPricePen,
  });

  it('el texto del unitario muestra hasta diez decimales y nunca menos de cuatro', () => {
    expect(importUnitPriceText('16.28928')).toBe('16.28928');
    expect(importUnitPriceText('100')).toBe('100.0000');
    expect(importUnitPriceText('2.5')).toBe('2.5000');
    // 4179.13 ÷ 3500 = 1.19403714285…: diez decimales, al medio hacia arriba.
    expect(importUnitPriceText(derivedUnitValue('3500', '4179.13'))).toBe('1.1940371429');
  });

  it('la fila editada da el mismo importe que la intacta: 146 × 16.28928 = 2 378.2349', () => {
    expect(importRowNetPen(QTY, UNIT)).toBe(NET);
    // Con el unitario cortado a cuatro —lo de antes— la fila editada se separaba del papel.
    expect(importRowNetPen(QTY, '16.2893')).toBe('2378.2378');
    expect(importRowNetPen(QTY, '16,28928')).toBeNull();
    expect(importRowNetPen('', UNIT)).toBeNull();
  });

  it('el confirm acepta el unitario con diez decimales y no lo corta a cuatro', () => {
    const parsed = importQuotationsSchema.parse({ rows: [row(UNIT)] });
    const [first] = parsed.rows;
    expect(first?.unitPricePen).toBe(UNIT);
    expect(first).not.toHaveProperty('netAmountPen');
    // Lo que hace el alta con la fila sin importe del papel (`unitValuePen`, D-255).
    const amounts = lineAmounts(first?.qty ?? '', { unitValuePen: first?.unitPricePen ?? '' });
    expect(amounts.subtotal.toFixed(4)).toBe(NET);
    // Y es el mismo subtotal que la fila intacta, que viaja con el importe del papel.
    expect(lineAmounts(QTY, { netAmountPen: NET }).subtotal.toFixed(4)).toBe(NET);
  });

  it('más de diez decimales se redondean a diez; cero, negativo o ilegible se rechazan', () => {
    const parsed = importQuotationsSchema.parse({ rows: [row('16.289280000049')] });
    expect(parsed.rows[0]?.unitPricePen).toBe('16.28928');
    for (const bad of ['0', '-1', '16,28928', 'abc']) {
      expect(importQuotationsSchema.safeParse({ rows: [row(bad)] }).success).toBe(false);
    }
  });
});
