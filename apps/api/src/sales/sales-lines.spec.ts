import { RoofingProductKind } from '@prisma/client';
import { sellsByFixedLength, Unit } from '@ayr/shared';
import { isMadeToMeasure, sellsByLength } from './sales-lines';

/**
 * **Centinela de D-131, ampliado por D-161.** Las preguntas que ya se confundieron dos veces,
 * con la tabla completa de combinaciones para que la próxima confusión sea un test rojo y no
 * un defecto.
 *
 * - *¿La línea necesita el detalle de largos?* → la decide la **unidad** (`sellsByLength`), y
 *   vale para cualquier línea de negocio.
 * - *¿Se fabrica contra pedido desde materia prima?* → la decide el **subtipo**
 *   (`isMadeToMeasure`), y es exclusiva de Metallic Roofing.
 * - *¿El precio se negocia por metro contra el largo fijo del SKU?* → la deciden el **subtipo
 *   y el largo juntos** (`sellsByFixedLength`), y es exclusiva de la plancha de catálogo.
 *
 * La primera vez que se respondió una con la otra, el mostrador pasó a poder vender material a
 * medida (D-131). La segunda, el importador de cotizaciones dejó pasar sin marca toda línea en
 * `MTR` que no fuera `A_MEDIDA` (D-152). Las tres veces el compilador no dijo nada, porque las
 * tres funciones devuelven `boolean`.
 */
describe('D-131/D-161 — subítems por unidad, fabricación por subtipo, precio por metro por largo fijo', () => {
  const LARGO = '3600.00';
  const cases = [
    {
      unit: Unit.MTR,
      roofingKind: RoofingProductKind.A_MEDIDA,
      lengthMm: null,
      byLength: true,
      made: true,
      fixed: false,
    },
    // El caso que rompió el importador: se vende por metro pero no se fabrica a medida.
    // **No** cotiza por largo fijo: la cantidad de la línea ya está en metros, así que
    // multiplicarla otra vez por el largo la contaría dos veces. Es la combinación que el
    // CHECK de la base prohíbe (`roofing_kind='PLANCHA' AND unit<>'MTR'`) y aun así el
    // predicado tiene que responder bien, porque la garantía del CHECK no viaja con él.
    {
      unit: Unit.MTR,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
      byLength: true,
      made: false,
      fixed: false,
    },
    // D-161, el caso que la revisión encontró: el CHECK solo prohíbe `MTR`, así que una
    // PLANCHA en `KGM` es legal y el catálogo la admite (SKU legados). Se vende por kilo, y
    // multiplicar el largo por el precio ahí no significa nada: el importe saldría ×3.6.
    {
      unit: Unit.KGM,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
      byLength: false,
      made: false,
      fixed: false,
    },
    // El caso que rompió el mostrador: un producto en MTR fuera de coberturas.
    {
      unit: Unit.MTR,
      roofingKind: null,
      lengthMm: LARGO,
      byLength: true,
      made: false,
      fixed: false,
    },
    // La plancha normal: cuenta en planchas y cotiza por metro.
    {
      unit: Unit.NIU,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
      byLength: false,
      made: false,
      fixed: true,
    },
    // D-161: una plancha **sin largo en el catálogo** no se puede multiplicar por nada, así
    // que cae en el camino viejo (valor unitario tipeado). Las hay: ver
    // `roofing-catalog-report.ts`.
    {
      unit: Unit.NIU,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: null,
      byLength: false,
      made: false,
      fixed: false,
    },
    // Un perfil de drywall tiene largo y no es plancha: el largo solo no alcanza.
    {
      unit: Unit.NIU,
      roofingKind: null,
      lengthMm: LARGO,
      byLength: false,
      made: false,
      fixed: false,
    },
    {
      unit: Unit.NIU,
      roofingKind: null,
      lengthMm: null,
      byLength: false,
      made: false,
      fixed: false,
    },
    // Imposible por el maestro, pero si alguna vez existiera: el subtipo no crea subítems.
    {
      unit: Unit.KGM,
      roofingKind: RoofingProductKind.A_MEDIDA,
      lengthMm: null,
      byLength: false,
      made: true,
      fixed: false,
    },
  ];

  for (const c of cases) {
    it(`${c.unit} + ${c.roofingKind ?? 'sin subtipo'} + largo ${c.lengthMm ?? 'null'}: largos=${String(c.byLength)}, a medida=${String(c.made)}, por metro=${String(c.fixed)}`, () => {
      expect(sellsByLength({ unit: c.unit })).toBe(c.byLength);
      expect(isMadeToMeasure({ roofingKind: c.roofingKind })).toBe(c.made);
      expect(
        sellsByFixedLength({ roofingKind: c.roofingKind, unit: c.unit, lengthMm: c.lengthMm }),
      ).toBe(c.fixed);
    });
  }

  it('las tres preguntas son distintas: ningún par coincide en toda la tabla', () => {
    // Las aserciones van contra **las funciones**, no contra la tabla de arriba: si alguien
    // "simplifica" una definiéndola en términos de otra, esto se cae. Una versión anterior de
    // este caso filtraba el array literal y por lo tanto no podía fallar nunca.
    const planchaEnMetros = {
      unit: Unit.MTR,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
    };
    expect(sellsByLength(planchaEnMetros)).toBe(true);
    expect(isMadeToMeasure(planchaEnMetros)).toBe(false);
    expect(sellsByLength(planchaEnMetros)).not.toBe(isMadeToMeasure(planchaEnMetros));

    // `sellsByFixedLength` contra `sellsByLength`: la plancha de catálogo normal cotiza por
    // metro y **no** lleva detalle de largos. Confundirlas le pediría al vendedor componer
    // largos de un producto que tiene uno solo.
    const plancha = { unit: Unit.NIU, roofingKind: RoofingProductKind.PLANCHA, lengthMm: LARGO };
    expect(sellsByFixedLength(plancha)).toBe(true);
    expect(sellsByLength(plancha)).toBe(false);
    expect(sellsByFixedLength(plancha)).not.toBe(sellsByLength(plancha));

    // `sellsByFixedLength` contra `isMadeToMeasure`: las dos miran el subtipo y dan **lo
    // contrario** en Metallic Roofing. Es el par más fácil de confundir de los tres.
    const aMedida = { unit: Unit.MTR, roofingKind: RoofingProductKind.A_MEDIDA, lengthMm: null };
    expect(isMadeToMeasure(aMedida)).toBe(true);
    expect(sellsByFixedLength(aMedida)).toBe(false);
    expect(sellsByFixedLength(aMedida)).not.toBe(isMadeToMeasure(aMedida));
  });

  it('una plancha con largo cero no se cotiza por metro: multiplicar por cero dejaría la línea en S/ 0', () => {
    expect(
      sellsByFixedLength({
        roofingKind: RoofingProductKind.PLANCHA,
        unit: Unit.NIU,
        lengthMm: '0.00',
      }),
    ).toBe(false);
  });
});
