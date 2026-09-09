import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { balanceOf, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createRoofingProduct,
  lastActiveReport,
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  roofingOrdersFromSalesOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * El espacio de producción **por pantalla** (D-155): `/planta/producir`, con y sin pedido.
 *
 * Reemplaza a `planta-tanda-ui.spec.ts`. La tanda de D-147 dejaba transcribir los metros de N
 * órdenes de una sentada pero **no montaba la bobina**, así que el encargado tenía que entrar
 * orden por orden a la terminal para montar y recién después volver a la tanda a reportar; y
 * el guardado todo-o-nada obligaba a rehacer las ocho filas cuando la séptima tenía un número
 * mal tipeado. Acá una orden es una **pestaña** con su ciclo completo y cada una se guarda por
 * su cuenta.
 *
 * `planta-producir.spec.ts` cubre las reglas por API. Lo que prueba este caso es lo que solo
 * existe en la pantalla:
 *
 * - montar la bobina de cada orden **desde su pestaña**, y bajarla mientras no haya rolado;
 * - el reparto ML→largos (`piecesFromPlanMeters`), que desde D-155 lo hace el navegador: el
 *   API ya no recibe metros, recibe largos;
 * - el tope de metros del plan (D-146), que sigue apagando el botón sin ir al servidor;
 * - el aviso de desviación del kilo declarado (D-154), que **avisa y deja guardar** — era un
 *   400 hasta esta sesión;
 * - que el estado de cada pestaña y la barra de progreso sigan lo que se guardó;
 * - y la captura en **planchas** de una corrida a stock (segundo caso), donde la pantalla
 *   convierte la cantidad tipeada a metros antes de repartirla.
 *
 * El primero es deliberadamente **un solo test largo** y no seis: son estados sucesivos de la
 * misma pantalla y el escenario (dos compras, dos bobinas, un pedido de dos líneas, dos OP)
 * cuesta varios segundos de API que no tiene sentido repetir.
 *
 * Aritmética a ojo, la de Fase 6: 1 000 mm × 0.50 mm con densidad 8.0 ⇒ 4 kg por metro
 * lineal, y una plancha de 4 m son 16 kg.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, bobinas, pedidos y órdenes de producción: nunca contra producción (D-126, regla dura 9).',
);

// Arma el escenario entero por API y encima navega a una ruta que el servidor de Next en
// modo dev (Turbopack) compila recién al primer visitante: el timeout default no alcanza.
test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  // El `expect.timeout` de 10 s del config no alcanza acá: con el App Router la URL recién
  // cambia cuando llega el RSC del destino, y en modo dev el tablero se compila en el primer
  // visitante de la corrida. El minuto es holgura de compilación, no de la app.
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-155 — la pantalla de producir', () => {
  test('monta la bobina de cada orden, reparte los metros en planchas, avisa de la desviación de kg sin bloquear y guarda orden por orden', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    // Segunda cobertura a medida del mismo acabado y color (la línea 2 del pedido) y una
    // segunda bobina: una bobina montada en una orden no se puede montar en otra.
    const { product: other } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const second = await buyRoofingCoil(api, {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      weightKg: '2000',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, other.id],
      coilIds: [scenario.coil.id, second.coil.id],
      purchaseIds: [scenario.purchaseId, second.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      // ---------------------------------------------------------------------
      // 1. El escenario, por API: un pedido de dos líneas con sus dos órdenes.
      // ---------------------------------------------------------------------
      // Un solo largo por línea a propósito: el desglose de 40 m es entonces uno solo
      // (10 × 4.00 m) y la aserción no depende de en qué orden el repartidor de
      // `piecesFromPlanMeters` elija los largos.
      const planA = pieces([4, 10]);
      const planB = pieces([6, 5]);
      expect(metersOf(planA)).toBe('40.000');
      expect(metersOf(planB)).toBe('30.000');
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: planA },
          { productId: other.id, rows: planB },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      // D-148: las dos órdenes de una vez, que es lo que el botón "Producir (2)" del detalle
      // del pedido hace antes de mandar a esta pantalla.
      const created = await roofingOrdersFromSalesOrder(api, order.id);
      expect(created.created).toHaveLength(2);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const codeA = created.created[0]!.code;
      const codeB = created.created[1]!.code;

      // ---------------------------------------------------------------------
      // 2. La pantalla: una pestaña por orden, las dos sin bobina.
      // ---------------------------------------------------------------------
      await loginAsAdmin(page);
      await page.goto(`/planta/producir?pedido=${order.id}`);
      // Mismo motivo que en el login: esta ruta se compila en el primer visitante.
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });

      const tabs = page.getByRole('tablist', { name: 'Órdenes del pedido' });
      const tabA = tabs.getByRole('tab').filter({ hasText: codeA });
      const tabB = tabs.getByRole('tab').filter({ hasText: codeB });
      await expect(tabs.getByRole('tab')).toHaveCount(2);
      await expect(tabA).toContainText('Sin bobina');
      await expect(tabB).toContainText('Sin bobina');

      const progress = page.getByRole('progressbar', { name: 'Órdenes reportadas' });
      await expect(page.getByText('0 de 2 órdenes con su plan cubierto')).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', '0');
      await expect(progress).toHaveAttribute('aria-valuemax', '2');

      // La primera pestaña se elige sola. Su panel dice lo que el plan pide y lo que falta.
      // El panel se nombra por su pestaña (`aria-labelledby`), así que el nombre accesible es
      // el texto del botón: el código de la orden alcanza para identificarlo.
      const panelA = page.getByRole('tabpanel', { name: codeA });
      await expect(panelA.getByText('Faltan 10 × 4.00 m')).toBeVisible();
      const metersA = page.getByLabel(`Metros nuevos de ${codeA}`);
      // Sin bobina montada no se puede ni tipear: reportar exige material (D-086).
      await expect(metersA).toBeDisabled();

      // ---------------------------------------------------------------------
      // 3. Montar la bobina desde la propia pestaña (lo que la tanda no hacía).
      // ---------------------------------------------------------------------
      await panelA
        .getByRole('button', { name: `Montar la bobina ${scenario.coil.code} en ${codeA}` })
        .click();
      await expect(tabA).toContainText('Lista');
      await expect(metersA).toBeEnabled();
      // La bobina montada queda a la vista con su botón de bajarla mientras no haya rolado.
      await expect(
        panelA.getByRole('button', { name: `Bajar la bobina ${scenario.coil.code} de ${codeA}` }),
      ).toBeEnabled();

      // ---------------------------------------------------------------------
      // 4. El tope del plan (D-146) y el reparto ML→largos, en la fila.
      // ---------------------------------------------------------------------
      const saveA = panelA.getByRole('button', { name: `Guardar ${codeA}` });
      await expect(saveA).toBeDisabled(); // sin metros no hay nada que guardar

      // 44 sobre un plan de 40: el tope se aplica en la pantalla, sin ir al servidor.
      await metersA.fill('44');
      await expect(panelA.getByText(/Del plan quedan 40\.000 m/)).toBeVisible();
      await expect(saveA).toBeDisabled();

      // 10 m no salen de ninguna cantidad entera de planchas de 4 m. Media plancha no existe,
      // así que la pantalla se niega en vez de inventar un largo (lo que D-147 protegía en el
      // API y desde D-155 resuelve el navegador con la misma función de `@ayr/shared`).
      await metersA.fill('10');
      await expect(panelA.getByText(/no salen de un número entero de planchas/)).toBeVisible();
      await expect(saveA).toBeDisabled();

      // 40 sí: el desglose aparece solo, con el kilo teórico de la bobina montada.
      await metersA.fill('40');
      await expect(panelA.getByText(/10 × 4\.00 m · 160\.000 kg teóricos/)).toBeVisible();
      await expect(saveA).toBeEnabled();

      // ---------------------------------------------------------------------
      // 5. D-154: el kg declarado muy por encima del teórico **avisa y deja guardar**.
      // ---------------------------------------------------------------------
      await page.getByLabel(`Kilos consumidos de ${codeA}`).fill('900');
      await expect(panelA.getByText(/⚠ Consumo declarado 900\.000 kg/)).toBeVisible();
      // **Lo que cambió con D-154:** hasta esta sesión el API devolvía 400 y el dato de planta
      // había que falsearlo para poder guardarlo. Ahora entra y queda anotado.
      await expect(saveA).toBeEnabled();
      await saveA.click();

      // ---------------------------------------------------------------------
      // 6. Guardado por orden: la pestaña queda reportada y el progreso avanza.
      // ---------------------------------------------------------------------
      await expect(tabA).toContainText('Reportada');
      await expect(page.getByText('1 de 2 órdenes con su plan cubierto')).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', '1');
      await expect(panelA.getByText('El plan ya está cubierto.')).toBeVisible();
      await expect(metersA).toHaveValue('');
      // Y el ⚠ **sigue a la vista** con el campo de kilos ya limpio: es justo cuando la
      // desviación pasó de ser algo que se estaba tipeando a un hecho registrado, y
      // desaparecer ahí era perderla de vista en el único momento en que importa.
      await expect(panelA.getByText(/⚠ Consumo declarado 900\.000 kg/)).toBeVisible();
      // La otra pestaña no se tocó: cada orden se guarda por su cuenta.
      await expect(tabB).toContainText('Sin bobina');

      // ---------------------------------------------------------------------
      // 7. La segunda orden: montar, bajar por error, volver a montar y reportar.
      // ---------------------------------------------------------------------
      await tabB.click();
      const panelB = page.getByRole('tabpanel', { name: codeB });
      await expect(panelB.getByText('Faltan 5 × 6.00 m')).toBeVisible();

      await panelB
        .getByRole('button', { name: `Montar la bobina ${second.coil.code} en ${codeB}` })
        .click();
      await expect(tabB).toContainText('Lista');

      // Bajarla mientras no roló nada (D-155: la pestaña conoce la asignación, no solo la
      // bobina) devuelve la orden a "Sin bobina".
      await panelB
        .getByRole('button', { name: `Bajar la bobina ${second.coil.code} de ${codeB}` })
        .click();
      await expect(tabB).toContainText('Sin bobina');

      // Sin bobina montada el selector se abre solo —no hay nada más que hacer en esa orden—,
      // así que la bobina bajada se puede volver a montar sin ningún clic intermedio.
      await panelB
        .getByRole('button', { name: `Montar la bobina ${second.coil.code} en ${codeB}` })
        .click();
      await expect(tabB).toContainText('Lista');

      await page.getByLabel(`Metros nuevos de ${codeB}`).fill('30');
      await expect(panelB.getByText(/5 × 6\.00 m · 120\.000 kg teóricos/)).toBeVisible();
      await panelB.getByRole('button', { name: `Guardar ${codeB}` }).click();

      await expect(tabB).toContainText('Reportada');
      await expect(page.getByText('2 de 2 órdenes con su plan cubierto')).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', '2');

      // ---------------------------------------------------------------------
      // 8. Y el kardex confirma que lo que la pantalla dice se escribió de verdad.
      // ---------------------------------------------------------------------
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('30.000');
      // Las bobinas salieron por el kilo **teórico** (4 kg/m), no por los 900 declarados.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1840.000');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('1880.000');

      // Y el kg declarado quedó guardado con su aviso (D-146 + D-154).
      const reportA = await lastActiveReport(api, created.created[0]!.orderId);
      expect(reportA.consumedKg).toBe('900.000');
      expect(reportA.rawMaterialWarning).toContain('Consumo declarado 900.000 kg');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('una corrida a stock se captura en planchas, y las planchas tipeadas son las que entran al kardex', async ({
    page,
    baseURL,
  }) => {
    /**
     * D-140 + D-155: una **plancha de catálogo** se cuenta en planchas, no en metros.
     *
     * La pantalla captura la cantidad, la convierte a metros con el largo del plan y recién
     * ahí la reparte con `piecesFromPlanMeters`. Esa multiplicación es el punto ciego de toda
     * la pantalla: si estuviera mal, escribir `3` reportaría otra cantidad **sin ningún
     * error** —entra al kardex, entra al costo y nadie se entera—, así que lo que se comprueba
     * no es el texto sino el saldo: 3 planchas tipeadas ⇒ 3 `NIU` en el producto y 48 kg
     * menos en la bobina (3 × 4 m × 4 kg/m).
     *
     * Va sin `?pedido=`: una corrida a stock no cuelga de ningún pedido, así que solo aparece
     * en la lista de todas las órdenes abiertas.
     */
    const api = await adminApi(baseURL!);
    // Plancha de catálogo de 4 m (`NIU`, largo fijo en el SKU) y una bobina de 2 000 kg.
    const scenario = await setupRoofingScenario(api, {
      weightKg: '2000',
      pieceLengthMm: '4000',
    });
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
    };

    try {
      expect(scenario.product.unit).toBe('NIU');
      // La orden nace del producto y de una meta, no de una reserva (D-140): el plan es el
      // largo del SKU repetido hasta la meta, o sea 5 × 4.00 m = 20 ML.
      const op = await postJson<ProductionOrderDto>(api, '/api/production/roofing', {
        productId: scenario.product.id,
        targetPieces: 5,
      });
      trail.productionOrderIds = [op.id];
      expect(op.items).toEqual([{ lineNumber: 1, lengthMm: '4000.00', qty: 5 }]);

      await loginAsAdmin(page);
      await page.goto('/planta/producir');
      await expect(page.getByRole('heading', { name: 'Producir', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      // Sin `?pedido=` la pantalla lista **todas** las órdenes abiertas de la base, y por
      // encima de `MAX_ORDER_TABS` el selector deja de ser pestañas y pasa a lista lateral:
      // los botones pierden `role="tab"` a propósito (una lista no cumple la navegación por
      // flechas que la semántica de pestañas promete). Se lo busca entonces por su contenedor,
      // que se llama igual en los dos modos, para que el caso no dependa de cuántas órdenes
      // haya abiertas cuando corra — la base local acumula las de corridas anteriores.
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      const tab = picker.locator('button').filter({ hasText: op.code });
      await expect(tab).toHaveCount(1);
      await tab.click();
      // El panel sí conserva `role="tabpanel"` en los dos modos, y se nombra por su botón.
      const panel = page.getByRole('tabpanel', { name: op.code });

      // Sin bobina no se reporta; se monta desde la propia pestaña, igual que contra pedido.
      await expect(tab).toContainText('Sin bobina');
      await panel
        .getByRole('button', { name: `Montar la bobina ${scenario.coil.code} en ${op.code}` })
        .click();
      await expect(tab).toContainText('Lista');

      // **El campo cambia de unidad con el producto**: acá se piden planchas, no metros.
      await expect(panel.getByText('Planchas nuevas', { exact: true })).toBeVisible();
      await expect(panel.getByText('ML nuevo', { exact: true })).toHaveCount(0);
      const sheets = page.getByLabel(`Planchas nuevas de ${op.code}`);
      const save = panel.getByRole('button', { name: `Guardar ${op.code}` });

      // Media plancha no existe: la cantidad va entera.
      await sheets.fill('2.5');
      await expect(panel.getByText(/Las planchas se cuentan en enteros/)).toBeVisible();
      await expect(save).toBeDisabled();

      // Y el tope del plan (D-146) se dice **en planchas**, no en metros: decirle "quedan
      // 20.000 m" a quien está contando planchas es hacerle la división a mano.
      await sheets.fill('9');
      await expect(panel.getByText(/Del plan quedan 5 planchas/)).toBeVisible();
      await expect(panel.getByText(/Del plan quedan .* m:/)).toHaveCount(0);
      await expect(save).toBeDisabled();

      // 3 planchas de 4 m = 12 ML ⇒ 48 kg teóricos. Es la conversión que el kardex va a
      // confirmar abajo.
      await sheets.fill('3');
      await expect(panel.getByText(/3 × 4\.00 m · 48\.000 kg teóricos/)).toBeVisible();
      await expect(save).toBeEnabled();
      await save.click();

      // Quedan 2 planchas del plan: la orden sigue abierta y lo dice.
      await expect(panel.getByText('Faltan 2 × 4.00 m')).toBeVisible();
      await expect(sheets).toHaveValue('');

      // ---------------------------------------------------------------------
      // Lo que de verdad protege este caso: el saldo, no el texto.
      // ---------------------------------------------------------------------
      const product = await balanceOf(api, 'PRODUCT', scenario.product.id);
      // **3 planchas, no 12 (los metros) ni 1 (la línea del plan).** Y en `NIU`: una plancha
      // de catálogo no entra al kardex en metros.
      expect(product.qty).toBe('3.000');
      expect(product.unit).toBe('NIU');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1952.000');

      const report = await lastActiveReport(api, op.id);
      expect(report.pieces).toBe(3);
      expect(report.theoreticalKg).toBe('48.000');
      // D-083: el producto se cuenta en piezas, así que el reporte no lleva metros.
      expect(report.metersM).toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
