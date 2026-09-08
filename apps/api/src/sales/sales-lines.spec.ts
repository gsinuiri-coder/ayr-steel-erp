import { RoofingProductKind } from '@prisma/client';
import { Unit } from '@ayr/shared';
import { isMadeToMeasure, sellsByLength } from './sales-lines';

/**
 * **Centinela de D-131.** Las dos preguntas que ya se confundieron dos veces, con la tabla
 * completa de combinaciones para que la próxima confusión sea un test rojo y no un defecto.
 *
 * - *¿La línea necesita el detalle de largos?* → la decide la **unidad** (`sellsByLength`), y
 *   vale para cualquier línea de negocio.
 * - *¿Se fabrica contra pedido desde materia prima?* → la decide el **subtipo**
 *   (`isMadeToMeasure`), y es exclusiva de Metallic Roofing.
 *
 * La primera vez que se respondió una con la otra, el mostrador pasó a poder vender material a
 * medida (D-131). La segunda, el importador de cotizaciones dejó pasar sin marca toda línea en
 * `MTR` que no fuera `A_MEDIDA` (D-152). Las dos veces el compilador no dijo nada, porque las
 * dos funciones devuelven `boolean`.
 */
describe('D-131 — subítems por unidad, fabricación por subtipo', () => {
  const cases = [
    { unit: Unit.MTR, roofingKind: RoofingProductKind.A_MEDIDA, byLength: true, made: true },
    // El caso que rompió el importador: se vende por metro pero no se fabrica a medida.
    { unit: Unit.MTR, roofingKind: RoofingProductKind.PLANCHA, byLength: true, made: false },
    // El caso que rompió el mostrador: un producto en MTR fuera de coberturas.
    { unit: Unit.MTR, roofingKind: null, byLength: true, made: false },
    { unit: Unit.NIU, roofingKind: RoofingProductKind.PLANCHA, byLength: false, made: false },
    { unit: Unit.NIU, roofingKind: null, byLength: false, made: false },
    // Imposible por el maestro, pero si alguna vez existiera: el subtipo no crea subítems.
    { unit: Unit.KGM, roofingKind: RoofingProductKind.A_MEDIDA, byLength: false, made: true },
  ];

  for (const c of cases) {
    it(`${c.unit} + ${c.roofingKind ?? 'sin subtipo'}: largos=${String(c.byLength)}, a medida=${String(c.made)}`, () => {
      expect(sellsByLength({ unit: c.unit })).toBe(c.byLength);
      expect(isMadeToMeasure({ roofingKind: c.roofingKind })).toBe(c.made);
    });
  }

  it('las dos preguntas no son la misma: hay un producto donde una dice sí y la otra no', () => {
    // La aserción va contra **las funciones**, no contra la tabla de arriba: si alguien
    // "simplifica" una definiéndola en términos de la otra, esto se cae. Una versión anterior
    // de este caso filtraba el array literal y por lo tanto no podía fallar nunca.
    const plancha = { unit: Unit.MTR, roofingKind: RoofingProductKind.PLANCHA };
    expect(sellsByLength(plancha)).toBe(true);
    expect(isMadeToMeasure(plancha)).toBe(false);
    expect(sellsByLength(plancha)).not.toBe(isMadeToMeasure(plancha));
  });
});
