import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { confirmFilmOpen, openQueuedOrder } from '../helpers/ui';
import { balanceOf, today, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  buyRoofingCoil,
  createRoofingProduct,
  lastActiveReport,
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  reservationsOf,
  roofingOrder,
  roofingOrdersFromSalesOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * El espacio de producción **por pantalla**: `/planta`, con y sin pedido (D-155, D-159, D-160).
 *
 * cc35: «Producir una OP» pasó al **modelo M** —un bloque por bobina, guardado solo en el
 * borrador, «Registrar producción» y «Registrar y cerrar» con «Qué va a pasar»—. Los cuatro
 * escenarios y sus cuentas de kardex se conservan; lo que cambió es cómo se escriben.
 *
 * Sucesor de `planta-producir-ui.spec.ts`, y el cambio de nombre no es cosmético: hasta D-160
 * había **dos** pantallas para producir —`/planta` (la terminal, una orden por vez, que montaba
 * y cerraba pero no veía a las hermanas del pedido) y `/planta/producir` (el espacio del pedido,
 * que veía a las hermanas pero no cerraba)—. Quien producía un pedido de cuatro líneas iba y
 * venía entre las dos. Se fundieron en `/planta`, que acepta `?pedido=` como filtro y `?op=`
 * para enfocar una orden; las rutas viejas quedaron como redirecciones.
 *
 * `planta-espacio-produccion.spec.ts` cubre las reglas por API. Lo que prueban estos casos es lo
 * que solo existe en la pantalla:
 *
 * - **montar la bobina desde el modal de búsqueda** (D-159), con su filtro, y bajarla mientras
 *   no haya rolado;
 * - que montar **siembre el editor de largos con el plan que falta** — el caso normal es rolar
 *   lo que el pedido pide, y transcribirlo largo por largo era copiar lo que la pantalla ya
 *   tenía en la mano— y que las líneas sembradas se puedan **borrar** antes de guardar, que es
 *   lo primero que hace quien roló solo la mitad;
 * - que el **plan de corte se edite desde el propio panel** (el techo se mide en obra y el largo
 *   cambia), en sus dos formas: el editor de largos de una cobertura a medida y la sola cantidad
 *   de una plancha de catálogo, cuyo largo lo trae el SKU (D-118);
 * - el tope duro del plan (D-146), que sigue apagando el botón sin ir al servidor;
 * - el aviso de desviación del kilo declarado (D-154), que **avisa y deja guardar**;
 * - **D-191: el borrador de reportes.** Lo tipeado se agrega a un borrador server-side (no mueve
 *   kardex, sobrevive a recargar) y «Ejecutar» lo graba todo junto;
 * - **«Ejecutar y cerrar»** (antes «Guardar y cerrar», D-159): reporte + cierre + liberación de
 *   la bobina en una sola transacción, que es lo que permite el caso del último test —dos órdenes del mismo pedido
 *   rolando del **mismo rollo**—;
 * - **«Cerrar … sin reportar más»** con los kilos de la corrida (D-089), que es el caso más
 *   común de todos: la bobina se acabó a los 30 m de un plan de 36 y hay que cerrar sin
 *   inventar los 6 que faltan, para devolverle el rollo a la orden hermana;
 * - y que el estado de cada pestaña y la barra de progreso sigan lo que se guardó.
 *
 * Dos campos que se parecen y no son lo mismo, y por eso se los nombra siempre completos:
 * `Kilos consumidos de <OP>` es el kg declarado de **ese** reporte (D-146, dato de planta que
 * no toca el kardex), y `Kilos consumidos al cerrar <OP>` es lo que la bobina consumió en
 * **toda** la corrida (D-089), de donde sale el despunte que sí sale del inventario.
 *
 * Cada test es deliberadamente **uno largo** y no seis: son estados sucesivos de la misma
 * pantalla y el escenario (compras, bobinas, pedido, órdenes) cuesta varios segundos de API que
 * no tiene sentido repetir.
 *
 * Aritmética a ojo, la de Fase 6: 1 000 mm × 0.50 mm con densidad 8.0 ⇒ 4 kg por metro lineal,
 * así que una plancha de 4 m son 16 kg y una de 6 m, 24.
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

/**
 * Monta una bobina desde el modal de búsqueda (D-159): el selector dejó de ser una lista de
 * tarjetas —lo que decide cuál montar son cuatro cifras que hay que **comparar entre filas**—
 * y filtrar por el código es además lo que hace que el caso no dependa de cuántas bobinas
 * candidatas haya en la base cuando corra.
 */
async function mountFromModal(page: Page, orderCode: string, coilCode: string): Promise<void> {
  await page.getByRole('button', { name: `Montar bobinas en ${orderCode}` }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText(`Montar bobinas en ${orderCode}`)).toBeVisible();
  await modal.getByLabel('Filtrar opciones').fill(coilCode);
  // D-328: la bobina del escenario nace sellada y montarla pide confirmar que se abre; una que
  // ya se abrió (montada antes en otra orden y bajada, o compartida) se monta directo.
  await modal.getByRole('checkbox', { name: `Elegir ${coilCode}`, exact: true }).click();
  await modal.getByRole('button', { name: `Montar la bobina elegida en ${orderCode}` }).click();
  // No se decide antes de hacer clic: la lista del selector se refresca y puede traer un instante
  // el film de la consulta anterior. Se espera a lo que pasa: el paso de confirmación o el cierre.
  const step = modal.getByTestId('film-open-step');
  await expect
    .poll(async () => (await step.count()) > 0 || (await page.getByRole('dialog').count()) === 0)
    .toBe(true);
  if ((await step.count()) > 0) await confirmFilmOpen(modal);
  await expect(modal).toHaveCount(0);
}

/** El bloque de una bobina en el modelo M (cc35). */
function blockOf(panel: Locator, coilCode: string): Locator {
  return panel.getByTestId(`bloque-${coilCode}`);
}

async function waitSaved(panel: Locator): Promise<void> {
  await expect(panel.getByText('Todo lo escrito está guardado')).toBeVisible({ timeout: 30_000 });
}

/** «Registrar y cerrar»: «Qué va a pasar» y su confirmación. */
async function registerAndClose(panel: Locator, code: string): Promise<Locator> {
  await panel.getByRole('button', { name: `Registrar y cerrar ${code}` }).click();
  const preview = panel.getByTestId('que-va-a-pasar');
  await expect(preview).toContainText(`${code} queda cerrada`, { timeout: 60_000 });
  return preview;
}

test.describe('D-155/D-159/D-160 + cc35 — el espacio de producción con el modelo M', () => {
  test('cada orden con su bobina: el último bloque trae lo que falta, el tope del plan y la desviación avisan en el bloque, lo escrito sobrevive a recargar, se registra orden por orden y se cierra la que se quedó sin bobina', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
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
      const planA = pieces([4, 10]);
      const planB = pieces([6, 5], [3, 2]);
      expect(metersOf(planA)).toBe('40.000');
      expect(metersOf(planB)).toBe('36.000');
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: planA },
          { productId: other.id, rows: planB },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const created = await roofingOrdersFromSalesOrder(api, order.id);
      expect(created.created).toHaveLength(2);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const codeA = created.created[0]!.code;
      const codeB = created.created[1]!.code;

      await loginAsAdmin(page);
      // La ruta vieja sigue viva como redirección y conserva el `?pedido=`.
      await page.goto(`/planta/producir?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${order.id}$`));
      await openQueuedOrder(page, codeA);
      await openQueuedOrder(page, codeB);
      const tabs = page.getByRole('tablist', { name: 'Órdenes del pedido' });
      const tabA = tabs.getByRole('tab').filter({ hasText: codeA });
      const tabB = tabs.getByRole('tab').filter({ hasText: codeB });
      await expect(tabs.getByRole('tab')).toHaveCount(2);
      await tabA.click();
      await expect(tabA).toContainText('Sin bobina');
      await expect(tabB).toContainText('Sin bobina');
      // cc35 (D-558): el avance del pedido va en el subtítulo.
      await expect(page.getByText('0 de 2 órdenes cubiertas')).toBeVisible();

      const panelA = page.getByRole('tabpanel', { name: codeA });
      await expect(panelA.getByText('La orden no tiene ninguna bobina montada')).toBeVisible();

      // --- Montar desde el modal, con su búsqueda ---
      await panelA.getByRole('button', { name: `Montar bobinas en ${codeA}` }).click();
      const modal = page.getByRole('dialog');
      await expect(
        modal.getByRole('checkbox', { name: `Elegir ${second.coil.code}` }),
      ).toBeVisible();
      await modal.getByLabel('Filtrar opciones').fill(scenario.coil.code);
      await expect(modal.getByRole('checkbox', { name: `Elegir ${second.coil.code}` })).toHaveCount(
        0,
      );
      await modal
        .getByRole('checkbox', { name: `Elegir ${scenario.coil.code}`, exact: true })
        .click();
      await modal.getByRole('button', { name: `Montar la bobina elegida en ${codeA}` }).click();
      await confirmFilmOpen(modal);
      await expect(modal).toHaveCount(0);
      await expect(tabA).toContainText('Lista');

      // --- El bloque de la única bobina llega lleno con lo que falta ---
      const blockA = blockOf(panelA, scenario.coil.code);
      const qtyA = blockA.getByLabel(/Planchas del corte 1 de/);
      await expect(blockA.getByLabel(/Largo del corte 1 de/)).toHaveValue('4.00');
      await expect(qtyA).toHaveValue('10');
      await expect(blockA.getByText('40.000 m · teórico 161.600 kg')).toBeVisible();
      await expect(panelA.getByTestId('cuadre-plan')).toContainText('10 de 10 planchas');
      // El largo se elige de la lista del plan.
      await expect(blockA.getByLabel(/Largo del corte 1 de/).locator('option')).toHaveText([
        'Elige el largo…',
        '4.00 m',
      ]);

      // --- El tope del plan (D-146) avisa en el bloque ---
      await qtyA.fill('11'); // 44 m sobre un plan de 40
      await expect(blockA.getByRole('alert')).toContainText('tiene un plan de 40.000 m', {
        timeout: 30_000,
      });
      // Media plancha no existe.
      await qtyA.fill('2.5');
      await expect(blockA.getByRole('alert')).toContainText(
        'la cantidad de planchas es un entero mayor a cero',
      );
      await qtyA.fill('10');

      // --- D-154: el kg declarado muy por encima del teórico avisa y deja guardar ---
      await blockA.getByLabel(/kg consumidos de/).fill('900');
      await expect(blockA.getByText(/⚠ Consumo declarado 900\.000 kg/)).toBeVisible();
      await waitSaved(panelA);
      await expect(blockA.getByRole('alert')).toHaveCount(0);
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');

      // El borrador es server-side: sobrevive a recargar.
      await page.reload();
      await openQueuedOrder(page, codeA);
      await expect(
        blockOf(page.getByRole('tabpanel', { name: codeA }), scenario.coil.code).getByLabel(
          /kg consumidos de/,
        ),
      ).toHaveValue('900.000', { timeout: 60_000 });
      await openQueuedOrder(page, codeB);
      await tabA.click();

      // Registrar **sin** cerrar: la orden queda abierta con su bobina montada.
      await panelA.getByRole('button', { name: `Registrar producción de ${codeA}` }).click();
      await expect(tabA).toContainText('Reportada', { timeout: 60_000 });
      await expect(page.getByText('1 de 2 órdenes cubiertas')).toBeVisible();
      await expect(blockA.getByText(/ya registrado 161\.600 kg/)).toBeVisible();
      // La otra pestaña no se tocó: cada orden se registra por su cuenta.
      await expect(tabB).toContainText('Sin bobina');

      // --- La segunda orden: montar, bajar por error, volver a montar ---
      await tabB.click();
      const panelB = page.getByRole('tabpanel', { name: codeB });
      await mountFromModal(page, codeB, second.coil.code);
      await expect(tabB).toContainText('Lista');
      const blockB = blockOf(panelB, second.coil.code);
      await blockB
        .getByRole('button', { name: `Bajar la bobina ${second.coil.code} de ${codeB}` })
        .click();
      await expect(tabB).toContainText('Sin bobina');
      await expect(blockB).toHaveCount(0);
      await mountFromModal(page, codeB, second.coil.code);
      await expect(tabB).toContainText('Lista');

      // --- La bobina se acabó: de la roladora salió solo el primer largo ---
      await expect(blockB.getByLabel(/Largo del corte 1 de/)).toHaveValue('6.00');
      await expect(blockB.getByLabel(/Planchas del corte 1 de/)).toHaveValue('5');
      await expect(blockB.getByLabel(/Largo del corte 2 de/)).toHaveValue('3.00');
      await blockB.getByRole('button', { name: /Quitar el corte 2 de/ }).click();
      await expect(blockB.getByText('30.000 m · teórico 121.200 kg')).toBeVisible();
      await expect(panelB.getByTestId('cuadre-plan')).toContainText('5 de 7 planchas');
      // Con su fila en el borrador, la bobina ya no se baja.
      await waitSaved(panelB);
      await expect(blockB.getByRole('button', { name: /Bajar la bobina/ })).toHaveCount(0);

      // D-089 por bobina (cc34): 130 kg consumidos sobre 121.2 teóricos ⇒ 8.8 kg de despunte.
      await blockB.getByLabel(/kg consumidos de/).fill('130');
      await expect(blockB.getByText('Despunte 8.800 kg')).toBeVisible();
      await waitSaved(panelB);
      const preview = await registerAndClose(panelB, codeB);
      await expect(preview).toContainText(`8.800 kg de ${second.coil.code}`);
      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();

      // Cerrada, la orden sale de la lista de abiertas.
      await expect(tabs.getByRole('tab')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByText('1 de 1 orden cubierta')).toBeVisible();

      // --- El kardex confirma lo que la pantalla dijo ---
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      // 30 m, no 36: los 6 que faltaban no se produjeron y nadie los inventó.
      expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('30.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1838.400');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('1870.000');
      const reportA = await lastActiveReport(api, created.created[0]!.orderId);
      expect(reportA.consumedKg).toBe('900.000');
      expect(reportA.rawMaterialWarning).toContain('Consumo declarado 900.000 kg');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('el plan de corte de una cobertura a medida se ajusta en su diálogo con los mismos metros, y el bloque se vuelve a llenar con el plan nuevo', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const created = await roofingOrdersFromSalesOrder(api, order.id);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const op = created.created[0]!;

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      await openQueuedOrder(page, op.code);
      const panel = page.getByRole('tabpanel', { name: op.code });
      await mountFromModal(page, op.code, scenario.coil.code);
      const block = blockOf(panel, scenario.coil.code);
      await expect(block.getByLabel(/Planchas del corte 1 de/)).toHaveValue('10');

      // --- El plan, en su diálogo: mismos metros, ni más ni menos ---
      await panel.getByRole('button', { name: `Ajustar el plan de corte de ${op.code}` }).click();
      const planDialog = page.getByRole('dialog', { name: `Ajustar el plan de ${op.code}` });
      const planLength = planDialog.getByLabel('Largo 1 del plan en metros');
      const planQty = planDialog.getByLabel('Planchas del largo 1 del plan');
      await expect(planLength).toHaveValue('4.00');
      await expect(planQty).toHaveValue('10');
      await planLength.fill('4.20');
      await planQty.fill('9');
      await expect(planDialog.getByTestId('plan-cuadre')).toContainText('Faltan 2.200 m');
      await planDialog.getByRole('button', { name: 'Guardar el plan' }).click();
      await expect(planDialog.getByRole('alert')).toContainText('faltan 2.200 m');
      await planDialog.getByRole('button', { name: '+ Agregar largo' }).click();
      await planDialog.getByLabel('Largo 2 del plan en metros').fill('2.20');
      await planDialog.getByLabel('Planchas del largo 2 del plan').fill('1');
      await expect(planDialog.getByTestId('plan-cuadre')).toContainText('Cuadra ✓');
      await expect(planDialog.getByText('Se agrega 2.20 m × 1.')).toBeVisible();
      await planDialog.getByRole('button', { name: 'Guardar el plan' }).click();
      await expect(planDialog).toHaveCount(0);

      // El bloque se vuelve a llenar con el plan nuevo; salieron solo las 9 de 4.20.
      await expect(block.getByLabel(/Largo del corte 1 de/)).toHaveValue('4.20', {
        timeout: 30_000,
      });
      await expect(block.getByLabel(/Planchas del corte 1 de/)).toHaveValue('9');
      await expect(block.getByLabel(/Largo del corte 2 de/)).toHaveValue('2.20');
      await block.getByRole('button', { name: /Quitar el corte 2 de/ }).click();
      await expect(block.getByText('37.800 m · teórico 152.712 kg')).toBeVisible();
      await waitSaved(panel);

      const preview = await registerAndClose(panel, op.code);
      await preview.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect(page.getByText('Este pedido no tiene órdenes abiertas')).toBeVisible({
        timeout: 60_000,
      });

      // El kardex sale por los largos de verdad: 37.8 m de producto y 151.2 kg de bobina.
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('37.800');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1847.288');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('una corrida de planchas de catálogo ajusta su cantidad y su bloque captura unidades, y son esas planchas las que entran al kardex', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    // Plancha de catálogo de 4 m (`NIU`, largo fijo en el SKU) y una bobina de 2 000 kg.
    const scenario = await setupRoofingScenario(api, {
      weightKg: '2000',
      pieceLengthMm: '4000',
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      expect(scenario.product.unit).toBe('NIU');
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: scenario.product.id, qty: '5', valuePerMeterPen: '60.0000' }],
      });
      trail.quotationIds = [quotation.id];
      const salesOrder = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [salesOrder.id];
      const reservation = (await reservationsOf(api, salesOrder.id)).find(
        (r) => r.status === 'ACTIVE',
      )!;
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      expect(op.items).toEqual([{ lineNumber: 1, lengthMm: '4000.00', qty: 5 }]);

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole('link', { name: `Producir ${op.salesOrderCode!}`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${salesOrder.id}$`));
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      const tab = picker.locator('button').filter({ hasText: op.code });
      await tab.click();
      const panel = page.locator(`#panel-${op.id}`);
      await expect(tab).toContainText('Sin bobina');
      await mountFromModal(page, op.code, scenario.coil.code);
      await expect(tab).toContainText('Lista');

      // --- El plan, en planchas: el largo no se pregunta (D-118); la cantidad es libre (D-545) ---
      await panel.getByRole('button', { name: `Ajustar el plan de corte de ${op.code}` }).click();
      const planDialog = page.getByRole('dialog', { name: `Ajustar el plan de ${op.code}` });
      const planSheets = planDialog.getByLabel('Planchas del largo 1 del plan');
      await expect(planSheets).toHaveValue('5');
      await expect(planDialog.getByLabel('Largo 1 del plan en metros')).toBeDisabled();
      await planSheets.fill('6');
      await planDialog.getByRole('button', { name: 'Guardar el plan' }).click();
      await expect(planDialog).toHaveCount(0);

      // --- Un solo largo por orden: el bloque lleva una fila, con las unidades ---
      const block = blockOf(panel, scenario.coil.code);
      await expect(block.getByText('Plancha 4.00 m')).toBeVisible();
      const units = block.getByLabel(/Unidades del corte 1 de/);
      await expect(units).toHaveValue('6', { timeout: 30_000 });
      await expect(panel.getByTestId('cuadre-plan')).toContainText('6 de 6 und');
      // 3 planchas de 4 m = 12 ML ⇒ 48.48 kg teóricos con el 1 % de D-165.
      await units.fill('3');
      await expect(block.getByText('12.000 m · teórico 48.480 kg')).toBeVisible();
      await waitSaved(panel);
      await panel.getByRole('button', { name: `Registrar producción de ${op.code}` }).click();
      await expect(block.getByText(/ya registrado 48\.480 kg/)).toBeVisible({ timeout: 60_000 });

      // Lo que de verdad protege este caso: el saldo, no el texto.
      const product = await balanceOf(api, 'PRODUCT', scenario.product.id);
      expect(product.qty).toBe('3.000');
      expect(product.unit).toBe('NIU');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1951.520');
      const report = await lastActiveReport(api, op.id);
      expect(report.pieces).toBe(3);
      expect(report.theoreticalKg).toBe('48.480');
      expect(report.metersM).toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('dos órdenes del mismo pedido rolan del MISMO rollo: la primera se registra y cierra, y la segunda lo monta sin salir de la pantalla', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const { product: other } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, other.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 10]) },
          { productId: other.id, rows: pieces([6, 5]) },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const created = await roofingOrdersFromSalesOrder(api, order.id);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const codeA = created.created[0]!.code;
      const codeB = created.created[1]!.code;

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      await openQueuedOrder(page, codeA);
      await openQueuedOrder(page, codeB);
      const tabs = page.getByRole('tablist', { name: 'Órdenes del pedido' });
      await tabs.getByRole('tab').filter({ hasText: codeA }).click();

      // --- Orden 1: montar, registrar y cerrar en el mismo acto ---
      const panelA = page.getByRole('tabpanel', { name: codeA });
      await mountFromModal(page, codeA, scenario.coil.code);
      await expect(
        blockOf(panelA, scenario.coil.code).getByLabel(/Planchas del corte 1 de/),
      ).toHaveValue('10');
      const previewA = await registerAndClose(panelA, codeA);
      await previewA.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();

      // La orden cerrada sale de la lista y la hermana queda sola y seleccionada.
      await expect(tabs.getByRole('tab')).toHaveCount(1, { timeout: 60_000 });
      const panelB = page.getByRole('tabpanel', { name: codeB });

      // --- Orden 2: la misma bobina, con lo que quedó del rollo ---
      await mountFromModal(page, codeB, scenario.coil.code);
      const blockB = blockOf(panelB, scenario.coil.code);
      await expect(blockB.getByText(/saldo 1,838\.400 kg/)).toBeVisible();
      await expect(blockB.getByLabel(/Planchas del corte 1 de/)).toHaveValue('5');
      await expect(blockB.getByText('30.000 m · teórico 121.200 kg')).toBeVisible();
      const previewB = await registerAndClose(panelB, codeB);
      await previewB.getByRole('button', { name: 'Confirmar: registrar y cerrar' }).click();
      await expect(page.getByText('Este pedido no tiene órdenes abiertas')).toBeVisible({
        timeout: 60_000,
      });

      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('30.000');
      // 2 000 − 161.6 − 121.2: los dos consumos salieron de la misma bobina.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1717.200');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
