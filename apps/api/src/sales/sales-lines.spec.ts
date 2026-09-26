import { RoofingProductKind } from '@prisma/client';
import { sellsByFixedLength, Unit } from '@ayr/shared';
import {
  detailsLengths,
  isAccessory,
  isMadeToMeasure,
  isMadeToOrder,
  sellsByLength,
} from './sales-lines';

/**
 * **Centinela de D-131, ampliado por D-161.** Las preguntas que ya se confundieron dos veces,
 * con la tabla completa de combinaciones para que la próxima confusión sea un test rojo y no
 * un defecto.
 *
 * **D-343 — las preguntas ahora son cinco, y una de ellas se partió en dos.** El accesorio se
 * vende en metros lineales de bobina y **no** desglosa largos: dos cosas que hasta entonces
 * coincidían.
 *
 * - *¿La unidad de venta es el metro lineal?* → la decide **solo la unidad** (`sellsByLength`):
 *   cantidad, precio, kardex y unidad SUNAT en metros. **No conoce el subtipo.**
 * - *¿La línea lleva desglose de largos?* → `detailsLengths`: la **unidad `MTR` y que no sea un
 *   accesorio**. Depende de las dos cosas y de ninguna sola.
 * - *¿Es un accesorio?* → `isAccessory`: el **subtipo `ACCESORIO`**, y nada más.
 * - Las otras tres, como antes; `isMadeToOrder` suma el accesorio **en metros**.
 *
 * Los casos del final de este archivo fallan si alguien define `detailsLengths` solo con la unidad
 * o `sellsByLength` con el subtipo.
 *
 * - *¿La línea necesita el detalle de largos?* → (antes de D-343) la decidía la **unidad**
 *   (`sellsByLength`), y valía para cualquier línea de negocio.
 * - *¿Se cotiza a la medida del cliente?* → la decide el **subtipo `A_MEDIDA`**
 *   (`isMadeToMeasure`), y es exclusiva de Metallic Roofing. Desde D-171 responde por la
 *   **forma de la línea**, no por el origen del material.
 * - *¿Se fabrica desde bobina contra el pedido?* → `isMadeToOrder` (D-171): la cobertura a
 *   medida **y** la plancha con largo fijo usable. **No** es «tener subtipo»: una `PLANCHA` en
 *   `KGM` o sin largo no sabe decir cuántos metros pide, así que sigue saliendo del saldo.
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
      details: true,
      made: true,
      order: true,
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
      details: true,
      made: false,
      order: false,
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
      details: false,
      made: false,
      order: false,
      fixed: false,
    },
    // El caso que rompió el mostrador: un producto en MTR fuera de coberturas.
    {
      unit: Unit.MTR,
      roofingKind: null,
      lengthMm: LARGO,
      byLength: true,
      details: true,
      made: false,
      order: false,
      fixed: false,
    },
    // La plancha normal: cuenta en planchas y cotiza por metro.
    {
      unit: Unit.NIU,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
      byLength: false,
      details: false,
      made: false,
      order: true,
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
      details: false,
      made: false,
      order: false,
      fixed: false,
    },
    // Un perfil de drywall tiene largo y no es plancha: el largo solo no alcanza.
    {
      unit: Unit.NIU,
      roofingKind: null,
      lengthMm: LARGO,
      byLength: false,
      details: false,
      made: false,
      order: false,
      fixed: false,
    },
    {
      unit: Unit.NIU,
      roofingKind: null,
      lengthMm: null,
      byLength: false,
      details: false,
      made: false,
      order: false,
      fixed: false,
    },
    // D-343: el accesorio. Se vende en metros (la unidad es `MTR`) y se produce contra el pedido,
    // pero **no desglosa largos**: es el único caso donde `sellsByLength` y `detailsLengths`
    // discrepan. Tampoco es «a medida» ni cotiza por largo fijo.
    {
      unit: Unit.MTR,
      roofingKind: RoofingProductKind.ACCESORIO,
      lengthMm: null,
      byLength: true,
      details: false,
      made: false,
      order: true,
      fixed: false,
    },
    // Un largo cargado por error en un accesorio no lo vuelve plancha ni le crea largos.
    {
      unit: Unit.MTR,
      roofingKind: RoofingProductKind.ACCESORIO,
      lengthMm: LARGO,
      byLength: true,
      details: false,
      made: false,
      order: true,
      fixed: false,
    },
    // Imposible por el CHECK (`ACCESORIO ⇒ MTR`), pero la garantía del CHECK no viaja con el
    // predicado: en `KGM` la cantidad no son metros de bobina, así que **no** se produce (la
    // misma lección de D-171 con la plancha legada), y tampoco lleva largos.
    {
      unit: Unit.KGM,
      roofingKind: RoofingProductKind.ACCESORIO,
      lengthMm: null,
      byLength: false,
      details: false,
      made: false,
      order: false,
      fixed: false,
    },
    // Imposible por el maestro, pero si alguna vez existiera: el subtipo no crea subítems.
    {
      unit: Unit.KGM,
      roofingKind: RoofingProductKind.A_MEDIDA,
      lengthMm: null,
      byLength: false,
      details: false,
      made: true,
      order: true,
      fixed: false,
    },
  ];

  for (const c of cases) {
    it(`${c.unit} + ${c.roofingKind ?? 'sin subtipo'} + largo ${c.lengthMm ?? 'null'}: largos=${String(c.byLength)}, a medida=${String(c.made)}, por metro=${String(c.fixed)}, se produce=${String(c.order)}`, () => {
      expect(sellsByLength({ unit: c.unit })).toBe(c.byLength);
      // D-343: la pregunta partida en dos, y el subtipo por su cuenta.
      expect(detailsLengths({ unit: c.unit, roofingKind: c.roofingKind })).toBe(c.details);
      expect(isAccessory({ roofingKind: c.roofingKind })).toBe(
        c.roofingKind === RoofingProductKind.ACCESORIO,
      );
      expect(isMadeToMeasure({ roofingKind: c.roofingKind })).toBe(c.made);
      expect(
        isMadeToOrder({ roofingKind: c.roofingKind, unit: c.unit, lengthMm: c.lengthMm }),
      ).toBe(c.order);
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

    // **D-171: `isMadeToOrder` contra `isMadeToMeasure`.** El par nuevo, y el más peligroso de
    // los cuatro: responder «¿se produce contra el pedido?» con `isMadeToMeasure` devuelve la
    // plancha al modelo viejo —reserva producto terminado, el mostrador vuelve a pedir «0.000
    // NIU disponibles»— y el compilador no dice nada.
    expect(isMadeToOrder(plancha)).toBe(true);
    expect(isMadeToMeasure(plancha)).toBe(false);
    expect(isMadeToOrder(plancha)).not.toBe(isMadeToMeasure(plancha));

    // **Y contra `roofingKind !== null`, que fue la primera versión de `isMadeToOrder` y estaba
    // mal.** El `CHECK` de la base admite una `PLANCHA` en `KGM` —hay SKU legados— y ahí la
    // cantidad son kilos, no planchas de un largo conocido: con «tener subtipo» a secas, mil
    // kilos se leían como mil planchas y la línea reservaba catorce toneladas de bobina. Esa
    // plancha **no** se produce; sale del saldo, como antes de D-171.
    const planchaLegada = {
      unit: Unit.KGM,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: LARGO,
    };
    expect(planchaLegada.roofingKind !== null).toBe(true);
    expect(isMadeToOrder(planchaLegada)).toBe(false);

    // Lo mismo con una plancha sin largo: no hay por qué multiplicar.
    const planchaSinLargo = {
      unit: Unit.NIU,
      roofingKind: RoofingProductKind.PLANCHA,
      lengthMm: null,
    };
    expect(planchaSinLargo.roofingKind !== null).toBe(true);
    expect(isMadeToOrder(planchaSinLargo)).toBe(false);

    // Contra `sellsByFixedLength`: una cobertura a medida se produce y **no** cotiza por largo
    // fijo. Son la unión y una de sus mitades, así que tienen que diferir en la otra mitad.
    expect(isMadeToOrder(aMedida)).toBe(true);
    expect(sellsByFixedLength(aMedida)).toBe(false);
    expect(isMadeToOrder(aMedida)).not.toBe(sellsByFixedLength(aMedida));

    // Fuera de coberturas nada se produce en la roladora, se mida como se mida.
    const perfil = { unit: Unit.NIU, roofingKind: null, lengthMm: LARGO };
    expect(isMadeToOrder(perfil)).toBe(false);
    expect(sellsByFixedLength(perfil)).toBe(false);
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

/**
 * **D-343 — el centinela de la pregunta partida.** Fallan si alguien define `detailsLengths` solo
 * con la unidad (la vuelve idéntica a `sellsByLength` y el accesorio pide largos), `detailsLengths`
 * solo con el subtipo (deja sin editor a un SKU legado en `MTR` sin subtipo), o `sellsByLength` con
 * el subtipo (deja de responder solo por la unidad y un accesorio dejaría de medirse en metros).
 *
 * Las aserciones van contra **las funciones** y contra implementaciones equivocadas escritas acá
 * mismo: si la definición real se acerca a una de ellas, el caso correspondiente se cae.
 */
describe('D-343 — detailsLengths y sellsByLength no se pueden confundir', () => {
  const LARGO_PRUEBA = '3600.00';
  const KINDS = [null, ...Object.values(RoofingProductKind)] as const;
  const UNITS = [Unit.MTR, Unit.NIU, Unit.KGM] as const;
  const everyCombination = UNITS.flatMap((unit) =>
    KINDS.map((roofingKind) => ({ unit, roofingKind })),
  );

  // Las tres definiciones equivocadas, a propósito y a la vista.
  const wrongDetailsByUnitOnly = (p: { unit: string }): boolean => p.unit === Unit.MTR;
  const wrongDetailsBySubtypeOnly = (p: { roofingKind: string | null }): boolean =>
    p.roofingKind !== RoofingProductKind.ACCESORIO;
  const wrongSellsWithSubtype = (p: { unit: string; roofingKind: string | null }): boolean =>
    p.unit === Unit.MTR && p.roofingKind !== RoofingProductKind.ACCESORIO;

  it('sellsByLength responde solo por la unidad: el subtipo no la mueve', () => {
    for (const kind of KINDS) {
      // El parámetro de `sellsByLength` es solo `{ unit }`: pasarle el subtipo no puede cambiarle
      // la respuesta, y si algún día lo leyera, este caso se caería.
      const sells = (unit: string) =>
        sellsByLength({ unit, roofingKind: kind } as unknown as { unit: string });
      expect(sells(Unit.MTR)).toBe(true);
      expect(sells(Unit.NIU)).toBe(false);
      expect(sells(Unit.KGM)).toBe(false);
    }
  });

  it('detailsLengths depende de la unidad Y del subtipo, y de ninguna sola', () => {
    // La unidad importa: fuera de `MTR` ningún subtipo lleva largos.
    for (const kind of KINDS) {
      expect(detailsLengths({ unit: Unit.NIU, roofingKind: kind })).toBe(false);
      expect(detailsLengths({ unit: Unit.KGM, roofingKind: kind })).toBe(false);
    }
    // El subtipo importa: en `MTR`, el accesorio no y todo lo demás sí (incluido el SKU legado
    // sin subtipo, que sigue teniendo su editor de largos).
    expect(detailsLengths({ unit: Unit.MTR, roofingKind: RoofingProductKind.ACCESORIO })).toBe(
      false,
    );
    expect(detailsLengths({ unit: Unit.MTR, roofingKind: RoofingProductKind.A_MEDIDA })).toBe(true);
    expect(detailsLengths({ unit: Unit.MTR, roofingKind: RoofingProductKind.PLANCHA })).toBe(true);
    expect(detailsLengths({ unit: Unit.MTR, roofingKind: null })).toBe(true);
  });

  it('el accesorio en metros es el único caso donde las dos preguntas discrepan', () => {
    const discrepancies = everyCombination.filter((p) => sellsByLength(p) !== detailsLengths(p));
    expect(discrepancies).toEqual([{ unit: Unit.MTR, roofingKind: RoofingProductKind.ACCESORIO }]);
  });

  it('FALLARÍA si detailsLengths se definiera solo con la unidad', () => {
    const differs = everyCombination.some((p) => wrongDetailsByUnitOnly(p) !== detailsLengths(p));
    expect(differs).toBe(true);
    // Esa definición daría lo mismo que `sellsByLength` en toda la tabla: la pregunta partida
    // volvería a ser una sola.
    expect(everyCombination.every((p) => wrongDetailsByUnitOnly(p) === sellsByLength(p))).toBe(
      true,
    );
  });

  it('FALLARÍA si detailsLengths se definiera solo con el subtipo', () => {
    expect(everyCombination.some((p) => wrongDetailsBySubtypeOnly(p) !== detailsLengths(p))).toBe(
      true,
    );
  });

  it('FALLARÍA si sellsByLength aprendiera el subtipo', () => {
    expect(everyCombination.some((p) => wrongSellsWithSubtype(p) !== sellsByLength(p))).toBe(true);
    expect(
      wrongSellsWithSubtype({ unit: Unit.MTR, roofingKind: RoofingProductKind.ACCESORIO }),
    ).not.toBe(sellsByLength({ unit: Unit.MTR }));
  });

  it('las cinco preguntas dan una huella distinta para cada subtipo en su unidad natural', () => {
    const answers = (p: { unit: string; roofingKind: RoofingProductKind | null }) =>
      [
        sellsByLength(p),
        detailsLengths(p),
        isMadeToMeasure(p),
        sellsByFixedLength({ ...p, lengthMm: LARGO_PRUEBA }),
        isMadeToOrder({ ...p, lengthMm: LARGO_PRUEBA }),
      ].join('|');
    // Si dos preguntas se confundieran, dos de estas filas colapsarían en la misma huella.
    const fingerprints = [
      { unit: Unit.MTR, roofingKind: RoofingProductKind.A_MEDIDA },
      { unit: Unit.MTR, roofingKind: RoofingProductKind.ACCESORIO },
      { unit: Unit.NIU, roofingKind: RoofingProductKind.PLANCHA },
      { unit: Unit.MTR, roofingKind: null },
    ].map(answers);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});
