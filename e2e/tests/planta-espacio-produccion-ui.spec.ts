import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
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
 * - **«Guardar y cerrar»** (D-159): reporte + cierre + liberación de la bobina en una sola
 *   transacción, que es lo que permite el caso del último test —dos órdenes del mismo pedido
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
  await page.getByRole('button', { name: `Buscar una bobina para ${orderCode}` }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText(`Bobinas para ${orderCode}`)).toBeVisible();
  await modal.getByLabel('Filtrar opciones').fill(coilCode);
  await modal.getByRole('button', { name: `Montar ${coilCode}`, exact: true }).click();
  await expect(modal).toHaveCount(0);
}

test.describe('D-155/D-159/D-160 — el espacio de producción', () => {
  test('siembra el reporte con el plan que falta, deja borrar una línea, corta en el tope del plan, avisa de la desviación de kg sin bloquear, guarda orden por orden y cierra la que se quedó sin bobina', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    // Segunda cobertura a medida del mismo acabado y color (la línea 2 del pedido) y una
    // segunda bobina: acá cada orden rola de la suya. Que **dos órdenes compartan un rollo**
    // es el último test de este archivo, y es otra cosa.
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
      // La línea A lleva un solo largo y la B **dos**: es la que permite borrar una línea
      // sembrada sin quedarse sin nada que reportar.
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
      // La ruta vieja sigue viva como redirección y **conserva el `?pedido=`**: el detalle del
      // pedido y el de la orden apuntaban ahí, y cualquiera pudo dejarla guardada.
      await page.goto(`/planta/producir?pedido=${order.id}`);
      // Mismo motivo que en el login: esta ruta se compila en el primer visitante.
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page).toHaveURL(new RegExp(`/planta\\?pedido=${order.id}$`));

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
      // Sin bobina montada **no hay editor**: reportar exige material (D-086), y ofrecer las
      // filas antes de tenerlo era invitar a transcribir algo que no se puede guardar.
      await expect(panelA.getByLabel('Largo 1 en metros')).toHaveCount(0);
      await expect(
        panelA.getByText('Monta una bobina y las líneas del plan que falta aparecen acá'),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 3. Montar desde el modal de búsqueda (D-159), con su filtro.
      // ---------------------------------------------------------------------
      // Las dos bobinas del escenario sirven para esta orden (mismo acabado, color y espesor),
      // así que el modal tiene dos filas y el filtro es el que deja una sola.
      await panelA.getByRole('button', { name: `Buscar una bobina para ${codeA}` }).click();
      const modal = page.getByRole('dialog');
      await expect(modal.getByText(`Bobinas para ${codeA}`)).toBeVisible();
      await expect(modal.getByRole('button', { name: `Montar ${second.coil.code}` })).toBeVisible();
      await modal.getByLabel('Filtrar opciones').fill(scenario.coil.code);
      await expect(modal.getByRole('button', { name: `Montar ${second.coil.code}` })).toHaveCount(
        0,
      );
      await modal
        .getByRole('button', { name: `Montar ${scenario.coil.code}`, exact: true })
        .click();
      await expect(modal).toHaveCount(0);

      await expect(tabA).toContainText('Lista');
      // La bobina montada queda a la vista con su botón de bajarla mientras no haya rolado.
      await expect(
        panelA.getByRole('button', { name: `Bajar la bobina ${scenario.coil.code} de ${codeA}` }),
      ).toBeEnabled();

      // ---------------------------------------------------------------------
      // 4. D-159: el editor llega **sembrado** con lo que el plan todavía debe.
      // ---------------------------------------------------------------------
      const lengthA = panelA.getByLabel('Largo 1 en metros');
      const qtyA = panelA.getByLabel('Planchas del largo 1');
      await expect(lengthA).toHaveValue('4.000');
      await expect(qtyA).toHaveValue('10');
      // Y como cubre exactamente lo que falta, la pantalla lo dice y ofrece cerrar de una vez.
      await expect(panelA.getByText('Con esto el plan queda cubierto')).toBeVisible();
      await expect(
        panelA.getByText(/10 × 4\.00 m · 40\.000 m · 161\.600 kg teóricos/),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 5. El tope del plan (D-146) sigue siendo duro y se aplica en la pantalla.
      // ---------------------------------------------------------------------
      const saveA = panelA.getByRole('button', { name: `Guardar ${codeA}` });
      const saveAndCloseA = panelA.getByRole('button', { name: 'Guardar y cerrar' });
      await qtyA.fill('11'); // 44 m sobre un plan de 40
      await expect(
        panelA.getByText(/Del plan quedan 40\.000 m y esto suma 44\.000 m/),
      ).toBeVisible();
      await expect(saveA).toBeDisabled();
      await expect(saveAndCloseA).toBeDisabled();

      // Una fila con largo y sin cantidad tampoco pasa, y el editor lo dice **por fila**: el
      // operario necesita saber cuál de las cinco líneas es la que le falta (`lib/pieces.ts`).
      await qtyA.fill('');
      await expect(
        panelA.getByText('Fila 1: la cantidad de planchas es un entero mayor a cero.'),
      ).toBeVisible();
      await expect(saveA).toBeDisabled();

      await qtyA.fill('10');
      await expect(saveA).toBeEnabled();

      // ---------------------------------------------------------------------
      // 6. D-154: el kg declarado muy por encima del teórico **avisa y deja guardar**.
      // ---------------------------------------------------------------------
      await panelA.getByLabel(`Kilos consumidos de ${codeA}`).fill('900');
      await expect(panelA.getByText(/⚠ Consumo declarado 900\.000 kg/)).toBeVisible();
      // **Lo que cambió con D-154:** hasta esa decisión el API devolvía 400 y el dato de planta
      // había que falsearlo para poder guardarlo. Ahora entra y queda anotado.
      await expect(saveA).toBeEnabled();
      // Se guarda **sin** cerrar a propósito: es el reporte parcial, y deja la orden abierta
      // con su bobina montada para comprobar abajo que la pestaña hermana no se tocó.
      await saveA.click();

      // ---------------------------------------------------------------------
      // 7. Guardado por orden: la pestaña queda reportada y el progreso avanza.
      // ---------------------------------------------------------------------
      await expect(tabA).toContainText('Reportada');
      await expect(page.getByText('1 de 2 órdenes con su plan cubierto')).toBeVisible();
      await expect(progress).toHaveAttribute('aria-valuenow', '1');
      await expect(panelA.getByText('El plan ya está cubierto.')).toBeVisible();
      // El editor se vuelve a sembrar de lo que falta, que ahora es nada: una fila en blanco.
      await expect(lengthA).toHaveValue('');
      // Y con kilos ya reportados aparece el cierre suelto, que **no** exige que quede algo
      // por reportar: la orden ya produjo y hay que poder cerrarla sin inventar largos.
      await expect(
        panelA.getByRole('button', { name: `Cerrar ${codeA} sin reportar más` }),
      ).toBeVisible();
      // Y el ⚠ **sigue a la vista** con el campo de kilos ya limpio: es justo cuando la
      // desviación pasó de ser algo que se estaba tipeando a un hecho registrado, y
      // desaparecer ahí era perderla de vista en el único momento en que importa.
      await expect(panelA.getByText(/⚠ Consumo declarado 900\.000 kg/)).toBeVisible();
      // La otra pestaña no se tocó: cada orden se guarda por su cuenta.
      await expect(tabB).toContainText('Sin bobina');

      // ---------------------------------------------------------------------
      // 8. La segunda orden: montar, bajar por error, volver a montar.
      // ---------------------------------------------------------------------
      await tabB.click();
      const panelB = page.getByRole('tabpanel', { name: codeB });
      await expect(panelB.getByText('Faltan 5 × 6.00 m, 2 × 3.00 m')).toBeVisible();

      await mountFromModal(page, codeB, second.coil.code);
      await expect(tabB).toContainText('Lista');

      // Bajarla mientras no roló nada (D-155: la pestaña conoce la asignación, no solo la
      // bobina) devuelve la orden a "Sin bobina", y con ella se va el editor sembrado.
      await panelB
        .getByRole('button', { name: `Bajar la bobina ${second.coil.code} de ${codeB}` })
        .click();
      await expect(tabB).toContainText('Sin bobina');
      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveCount(0);

      await mountFromModal(page, codeB, second.coil.code);
      await expect(tabB).toContainText('Lista');

      // ---------------------------------------------------------------------
      // 9. D-159: **borrar una línea sembrada** antes de guardar.
      // ---------------------------------------------------------------------
      // El plan pide dos largos y de la roladora salió solo el primero. Quitar la fila que no
      // salió es la operación normal de quien roló la mitad, no una corrección rara.
      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveValue('6.000');
      await expect(panelB.getByLabel('Planchas del largo 1')).toHaveValue('5');
      await expect(panelB.getByLabel('Largo 2 en metros')).toHaveValue('3.000');
      await expect(panelB.getByLabel('Planchas del largo 2')).toHaveValue('2');

      await panelB.getByRole('button', { name: 'Quitar el largo de la fila 2' }).click();
      await expect(panelB.getByLabel('Largo 2 en metros')).toHaveCount(0);
      await expect(
        panelB.getByText(/5 × 6\.00 m · 30\.000 m · 121\.200 kg teóricos/),
      ).toBeVisible();
      // 30 de 36: esto **no** cubre el plan, así que la pantalla no promete cerrarlo.
      await expect(panelB.getByText('Con esto el plan queda cubierto')).toHaveCount(0);

      await panelB.getByRole('button', { name: `Guardar ${codeB}` }).click();
      await expect(panelB.getByText('Faltan 2 × 3.00 m')).toBeVisible();
      await expect(tabB).toContainText('Lista');
      await expect(progress).toHaveAttribute('aria-valuenow', '1');

      // ---------------------------------------------------------------------
      // 10. **La bobina se acabó**: cerrar sin reportar los 6 m que faltan.
      // ---------------------------------------------------------------------
      // El editor vuelve a sembrarse con lo que el plan todavía debe —listo por si de verdad
      // se rola—, pero la corrida terminó: el rollo se acabó a los 30 de 36 m.
      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveValue('3.000');
      await expect(panelB.getByLabel('Planchas del largo 1')).toHaveValue('2');

      // Con kilos reportados el cierre suelto existe **aunque el plan no esté cubierto**, y lo
      // dice en el propio botón. Atado a "plan cubierto", la única salida era bajar el plan a
      // mano hasta que diera cero o reportar 6 m que nadie produjo.
      const closeB = panelB.getByRole('button', {
        name: `Cerrar ${codeB} sin reportar más`,
      });
      await expect(closeB).toContainText('(la bobina se acabó)');

      // D-089: los kilos que la bobina consumió **en toda la corrida**. Sin ellos el cierre
      // asume despunte cero; con 130 sobre los 120 teóricos, los 10 de diferencia salen del
      // inventario como despunte (10/130 = 7.7 %, por debajo del umbral que exige motivo).
      const closeKgB = panelB.getByLabel(`Kilos consumidos al cerrar ${codeB}`);
      await closeKgB.fill('100');
      await expect(
        panelB.getByText(/Las planchas reportadas ya consumieron 121\.200 kg/),
      ).toBeVisible();
      await expect(closeB).toBeDisabled();

      // **Cada cierre valida contra su propio piso, y este es el caso que lo prueba.** El
      // editor sigue sembrado con las dos planchas que faltan (24.24 kg), pero este botón no
      // las manda: su piso son los 121.2 kg ya reportados, no 145.44. Con un solo piso —el de la
      // versión con reporte— declarar los 130 kg que la bobina de verdad consumió apagaba el
      // botón, y el caso que el botón vino a resolver quedaba sin salida.
      await closeKgB.fill('130');
      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveValue('3.000');
      await expect(panelB.getByText('Despunte al cerrar ahora: 8.800 kg.')).toBeVisible();
      await expect(closeB).toBeEnabled();

      // Y la ✕ de la **única** fila vacía el editor en vez de estar apagada: sin eso había que
      // borrar el largo y la cantidad campo por campo.
      const dropRow = panelB.getByRole('button', { name: 'Quitar el largo de la fila 1' });
      await expect(dropRow).toBeEnabled();
      await dropRow.click();
      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveValue('');
      await expect(panelB.getByLabel('Planchas del largo 1')).toHaveValue('');

      await closeB.click();

      // Cerrada, la orden sale de la lista de abiertas: queda la pestaña de la que sigue viva.
      await expect(tabs.getByRole('tab')).toHaveCount(1);
      await expect(page.getByText('1 de 1 orden con su plan cubierto')).toBeVisible();

      // ---------------------------------------------------------------------
      // 11. Y el kardex confirma que lo que la pantalla dice se escribió de verdad.
      // ---------------------------------------------------------------------
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      // 30 m, no 36: los 6 que faltaban no se produjeron y nadie los inventó.
      expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('30.000');
      // Las bobinas salieron por el kilo **teórico** (4 kg/m), no por los 900 declarados:
      // 40 m × 4 en la primera; en la segunda, 30 m × 4 más los 10 kg de despunte del cierre.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1838.400');
      expect((await balanceOf(api, 'COIL', second.coil.id)).qty).toBe('1870.000');

      // Y el kg declarado quedó guardado con su aviso (D-146 + D-154).
      const reportA = await lastActiveReport(api, created.created[0]!.orderId);
      expect(reportA.consumedKg).toBe('900.000');
      expect(reportA.rawMaterialWarning).toContain('Consumo declarado 900.000 kg');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('el plan de corte de una cobertura a medida se ajusta desde el panel, y el tope del reporte se mueve con él', async ({
    page,
    baseURL,
  }) => {
    /**
     * D-159: **el techo se mide en obra**. El plan que la cotización copió sale del papel, y
     * cuando el largo real es otro hay que corregirlo antes de rolar. Hasta esta sesión eso
     * obligaba a irse a la terminal —la otra mitad del flujo que esta pantalla vino a juntar—,
     * y el plan es además el tope duro de lo que se puede reportar (D-146): sin poder editarlo
     * acá, la única salida era reportar largos que no son los que salieron.
     *
     * Lo que el caso comprueba es justamente el encadenado: el plan cambia, el editor del
     * reporte se **vuelve a sembrar** del plan nuevo, y lo que antes el tope rechazaba ahora
     * entra al kardex con los largos de verdad.
     *
     * Ojo con la ambigüedad: con el plan en edición hay **dos** editores de largos a la vista
     * —el del plan y el del reporte— y sus `aria-label` son los mismos. Se los distingue por el
     * `id`, que lleva el prefijo de cada uno (`plan-…` / `reporte-…`).
     */
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
      const panel = page.getByRole('tabpanel', { name: op.code });
      // Por "Faltan …" y por los metros entre paréntesis, y no por el desglose suelto: ese
      // texto aparece dos veces —en la tarjeta del plan y en la línea de lo que falta— y una
      // búsqueda por él sola es ambigua.
      await expect(panel.getByText('Faltan 10 × 4.00 m')).toBeVisible();
      await expect(panel.getByText('(40.000 m)')).toBeVisible();

      await mountFromModal(page, op.code, scenario.coil.code);
      await expect(panel.getByLabel('Largo 1 en metros')).toHaveValue('4.000');

      // Con el plan de 40 m, 9 planchas de 4.20 (37.800 m) entran; **10** de 4.20 (42 m) no.
      // Se comprueba primero el rechazo para que quede claro que el tope no se aflojó: lo que
      // lo mueve es cambiar el plan, no reportar por encima.
      await panel.getByLabel('Largo 1 en metros').fill('4.20');
      await expect(
        panel.getByText(/Del plan quedan 40\.000 m y esto suma 42\.000 m/),
      ).toBeVisible();
      await expect(panel.getByRole('button', { name: `Guardar ${op.code}` })).toBeDisabled();

      // --- El plan, editado desde el propio panel ---
      await panel.getByRole('button', { name: `Ajustar el plan de corte de ${op.code}` }).click();
      // Llega con el plan vigente adentro, no en blanco: corregir es editar, no transcribir.
      const planLength = panel.locator(`#plan-${op.orderId}-largo-0`);
      const planQty = panel.locator(`#plan-${op.orderId}-cant-0`);
      await expect(planLength).toHaveValue('4.000');
      await expect(planQty).toHaveValue('10');
      await planLength.fill('4.20');
      await planQty.fill('9');
      await panel.getByRole('button', { name: 'Guardar plan' }).click();

      await expect(panel.getByText('Faltan 9 × 4.20 m')).toBeVisible();
      await expect(panel.getByText('(37.800 m)')).toBeVisible();
      // El editor del reporte se sembró **del plan nuevo**: lo que había era el viejo.
      await expect(panel.getByLabel('Largo 1 en metros')).toHaveValue('4.200');
      await expect(panel.getByLabel('Planchas del largo 1')).toHaveValue('9');
      await expect(panel.getByText(/9 × 4\.20 m · 37\.800 m · 152\.712 kg teóricos/)).toBeVisible();

      await panel.getByRole('button', { name: 'Guardar y cerrar' }).click();
      await expect(page.getByText('Este pedido no tiene órdenes abiertas')).toBeVisible();

      // El kardex sale por los largos de verdad: 37.8 m de producto y 151.2 kg de bobina.
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('37.800');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1847.288');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('una corrida de planchas ajusta su plan en planchas y captura los largos, y son las planchas tipeadas las que entran al kardex', async ({
    page,
    baseURL,
  }) => {
    /**
     * D-118 + D-159: una **plancha de catálogo** tiene el largo en el SKU, así que su plan se
     * ajusta pidiendo **solo la cantidad**. Ofrecer el editor de largos completo sería un campo
     * cuya única respuesta correcta el sistema ya conoce, y aceptar otro largo dejaría el plan
     * diciendo algo que el catálogo contradice.
     *
     * Lo que se comprueba después no es el texto sino el **saldo**: la conversión planchas→ML
     * es el punto ciego de toda la pantalla —si estuviera mal, reportar 3 planchas entraría al
     * kardex y al costo con otra cantidad y nadie se enteraría—, así que 3 planchas de 4 m
     * tienen que dejar 3 `NIU` en el producto y 48 kg menos en la bobina.
     *
     * **De dónde nace la orden cambió con D-171, y el resto del caso no.** Se llamaba «corrida
     * a stock» porque bajo D-140 una plancha se producía sin pedido detrás (`productId` +
     * `targetPieces`); esa ruta dejó de existir y ahora la OP nace de la reserva del pedido,
     * igual que cualquier otra cobertura. El plan de arranque sigue siendo el mismo —el largo
     * del SKU repetido hasta la cantidad pedida, 5 × 4.00 m— porque lo deriva la misma función.
     *
     * Se sigue entrando a `/planta` **sin** `?pedido=`: lo que este caso mira es el panel de una
     * orden encontrada en la lista de todas las abiertas, no el espacio de un pedido.
     */
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
      // D-171: cinco planchas cotizadas y confirmadas. El valor por metro (D-161) es holgado
      // respecto del piso de D-163: el material de una plancha son 16.16 kg a S/ 5.
      const quotation = await postJson<{ id: string }>(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: scenario.product.id, qty: '5', valuePerMeterPen: '60.0000' }],
      });
      trail.quotationIds = [quotation.id];
      await postJson(api, `/api/sales/quotations/${quotation.id}/emit`);
      const salesOrder = await postJson<{ id: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds = [salesOrder.id];

      const reservation = (await reservationsOf(api, salesOrder.id)).find(
        (r) => r.status === 'ACTIVE',
      )!;
      expect(reservation.itemType).toBe('RAW_MATERIAL');
      const op = await roofingOrder(api, reservation.id);
      trail.productionOrderIds = [op.id];
      // El plan es el largo del SKU repetido hasta la cantidad pedida: 5 × 4.00 m = 20 ML.
      expect(op.items).toEqual([{ lineNumber: 1, lengthMm: '4000.00', qty: 5 }]);

      await loginAsAdmin(page);
      await page.goto('/planta');
      await expect(page.getByRole('heading', { name: 'Producción', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      // Sin `?pedido=` la pantalla lista **todas** las órdenes abiertas de la base, y por
      // encima de `MAX_ORDER_TABS` el selector deja de ser pestañas y pasa a lista lateral:
      // los botones pierden `role="tab"` a propósito (una lista no cumple la navegación por
      // flechas que la semántica de pestañas promete) y el panel pierde con ellos su
      // `role="tabpanel"`. Se los busca entonces por contenedor y por id, que no cambian entre
      // los dos modos, para que el caso no dependa de cuántas órdenes haya abiertas cuando
      // corra — la base local acumula las de los tests anteriores.
      const picker = page.locator('[aria-label="Órdenes del pedido"]');
      const tab = picker.locator('button').filter({ hasText: op.code });
      await expect(tab).toHaveCount(1);
      await tab.click();
      const panel = page.locator(`#panel-${op.id}`);

      // Sin bobina no se reporta; se monta desde la propia pestaña, igual que contra pedido.
      await expect(tab).toContainText('Sin bobina');
      await mountFromModal(page, op.code, scenario.coil.code);
      await expect(tab).toContainText('Lista');

      // --- El plan, en planchas: el largo no se pregunta (D-118) ---
      await panel.getByRole('button', { name: `Ajustar el plan de corte de ${op.code}` }).click();
      const planSheets = panel.getByLabel(`Planchas del plan de ${op.code}`);
      await expect(planSheets).toHaveValue('5');
      // No hay editor de largos en esta forma: el único campo es la cantidad.
      await expect(panel.locator(`#plan-${op.id}-largo-0`)).toHaveCount(0);
      await planSheets.fill('6');
      await panel.getByRole('button', { name: 'Guardar plan' }).click();
      // Por "Faltan …" y por los metros: el desglose suelto está también en la tarjeta del
      // plan, y buscarlo por sí solo encuentra los dos.
      await expect(panel.getByText('Faltan 6 × 4.00 m')).toBeVisible();
      await expect(panel.getByText('(24.000 m)')).toBeVisible();

      // --- El reporte, sembrado del plan nuevo y recortado a lo que de verdad salió ---
      const sheets = panel.getByLabel('Planchas del largo 1');
      await expect(panel.getByLabel('Largo 1 en metros')).toHaveValue('4.000');
      await expect(sheets).toHaveValue('6');

      // Media plancha no existe: la cantidad va entera.
      const save = panel.getByRole('button', { name: `Guardar ${op.code}` });
      await sheets.fill('2.5');
      await expect(
        panel.getByText(/la cantidad de planchas es un entero mayor a cero/),
      ).toBeVisible();
      await expect(save).toBeDisabled();

      // 3 planchas de 4 m = 12 ML ⇒ 48.48 kg teóricos con el 1 % de D-165. Es la conversión que
      // el kardex confirma.
      await sheets.fill('3');
      await expect(panel.getByText(/3 × 4\.00 m · 12\.000 m · 48\.480 kg teóricos/)).toBeVisible();
      await expect(save).toBeEnabled();
      await save.click();

      // Quedan 3 planchas del plan ampliado: la orden sigue abierta y lo dice.
      await expect(panel.getByText('Faltan 3 × 4.00 m')).toBeVisible();

      // ---------------------------------------------------------------------
      // Lo que de verdad protege este caso: el saldo, no el texto.
      // ---------------------------------------------------------------------
      const product = await balanceOf(api, 'PRODUCT', scenario.product.id);
      // **3 planchas, no 12 (los metros) ni 1 (la línea del plan).** Y en `NIU`: una plancha
      // de catálogo no entra al kardex en metros.
      expect(product.qty).toBe('3.000');
      expect(product.unit).toBe('NIU');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1951.520');

      const report = await lastActiveReport(api, op.id);
      expect(report.pieces).toBe(3);
      expect(report.theoreticalKg).toBe('48.480');
      // D-083: el producto se cuenta en piezas, así que el reporte no lleva metros.
      expect(report.metersM).toBeNull();
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('dos órdenes del mismo pedido rolan del MISMO rollo: la primera cierra con «Guardar y cerrar» y la segunda lo monta sin salir de la pantalla', async ({
    page,
    baseURL,
  }) => {
    /**
     * **El caso que justifica que «Guardar y cerrar» exista** (D-159).
     *
     * Un pedido de coberturas genera una OP por línea (D-084/D-148) y en la planta real las
     * dos se rolan **del mismo rollo**: se monta, se rola la primera, se cambia el plan de la
     * roladora y se sigue con la segunda. Eso era imposible hasta esta sesión —
     * `assertStripsNotAssigned` rechazaba la bobina mientras la orden 1 siguiera abierta con
     * ella montada— y el cierre vivía en **otra** pantalla, así que el operario tenía que
     * irse al detalle de la orden, cerrarla ahí y volver. Con el cierre en el mismo botón que
     * el reporte, y en una sola transacción, la bobina queda libre en el acto y la hermana la
     * monta sin moverse de la pestaña de al lado.
     *
     * Aritmética a mano: 1 000 mm × 0.50 mm y densidad 8.0 ⇒ 4 kg por metro lineal.
     *   línea 1: 10 × 4.00 m = 40 m → 160 kg
     *   línea 2:  5 × 6.00 m = 30 m → 120 kg
     *   la bobina de 2 000 kg tiene que terminar en 2 000 − 280 = 1 720 kg.
     */
    const api = await adminApi(baseURL!);
    // **Una sola bobina**, y bien holgada: lo que se prueba es que las dos órdenes la usen,
    // no que el material alcance justo.
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
      expect(created.created).toHaveLength(2);
      trail.productionOrderIds = created.created.map((c) => c.orderId);
      const codeA = created.created[0]!.code;
      const codeB = created.created[1]!.code;

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      const tabs = page.getByRole('tablist', { name: 'Órdenes del pedido' });
      await expect(tabs.getByRole('tab')).toHaveCount(2);

      // --- Orden 1: montar, y cerrar en el mismo acto que el reporte ---
      const panelA = page.getByRole('tabpanel', { name: codeA });
      await mountFromModal(page, codeA, scenario.coil.code);
      await expect(panelA.getByLabel('Largo 1 en metros')).toHaveValue('4.000');
      await expect(panelA.getByLabel('Planchas del largo 1')).toHaveValue('10');
      await expect(panelA.getByText('Con esto el plan queda cubierto')).toBeVisible();
      await panelA.getByRole('button', { name: 'Guardar y cerrar' }).click();

      // La orden cerrada sale de la lista y la hermana queda sola y seleccionada.
      await expect(tabs.getByRole('tab')).toHaveCount(1);
      const panelB = page.getByRole('tabpanel', { name: codeB });
      await expect(panelB.getByText('Faltan 5 × 6.00 m')).toBeVisible();

      // --- Orden 2: **la misma bobina**, sin salir de la pantalla ---
      // Antes de D-159 esto era un 400: la bobina seguía asignada a la orden 1, que solo se
      // liberaba cerrándola desde otra pantalla.
      await mountFromModal(page, codeB, scenario.coil.code);
      await expect(
        panelB.getByRole('button', { name: `Bajar la bobina ${scenario.coil.code} de ${codeB}` }),
      ).toBeVisible();
      // Y llega con **lo que quedó del rollo**, no con los 2 000 originales: la primera orden
      // ya se llevó sus 161.6 kg (40 m × 4.04 kg/m, D-165).
      await expect(panelB.getByText('pendiente 1,838.400 kg')).toBeVisible();

      await expect(panelB.getByLabel('Largo 1 en metros')).toHaveValue('6.000');
      await expect(panelB.getByLabel('Planchas del largo 1')).toHaveValue('5');
      await expect(
        panelB.getByText(/5 × 6\.00 m · 30\.000 m · 121\.200 kg teóricos/),
      ).toBeVisible();
      await panelB.getByRole('button', { name: 'Guardar y cerrar' }).click();

      // Sin órdenes abiertas, el pedido lo dice en vez de dejar el panel en blanco.
      await expect(page.getByText('Este pedido no tiene órdenes abiertas')).toBeVisible();

      // ---------------------------------------------------------------------
      // El kardex de las dos: es lo único que prueba que el rollo se usó dos veces.
      // ---------------------------------------------------------------------
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('40.000');
      expect((await balanceOf(api, 'PRODUCT', other.id)).qty).toBe('30.000');
      // 2 000 − 160 − 120: los dos consumos salieron de la **misma** bobina.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1717.200');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
