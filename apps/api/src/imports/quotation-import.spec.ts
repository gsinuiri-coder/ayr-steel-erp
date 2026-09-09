import {
  defaultRoofingPlan,
  EXTERNAL_INVOICE_NOTES_PREFIX,
  isImportedQuotation,
  keepImportMarker,
  importDocTypeOf,
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
