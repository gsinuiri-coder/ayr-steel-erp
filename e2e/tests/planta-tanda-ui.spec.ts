import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { balanceOf, type ProductionOrderDto } from '../helpers/production';
import { createCustomer } from '../helpers/sales';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * Captura en tanda **por pantalla** (D-146/D-147): `/planta/tanda`.
 *
 * `planta-tanda.spec.ts` cubre las reglas por API —el tope del plan, el todo o nada, el
 * desglose exacto—. Lo que falta y prueba este caso es que la pantalla que el encargado usa
 * de verdad las **muestre antes de dejar escribir**: que la fila diga qué prometió el plan y
 * qué queda, que el desglose en planchas aparezca mientras se tipea, que un número que se
 * pasa del restante marque la fila y bloquee el botón —sin llegar al servidor— y que al
 * enviar la tanda la fila quede con el reportado nuevo.
 *
 * Es deliberadamente **un solo test largo** y no cinco: los cinco pasos son estados
 * sucesivos de la misma pantalla y el escenario (compra, bobina, pedido, OP montada) cuesta
 * varios segundos de API que no tiene sentido repetir cinco veces.
 *
 * Aritmética a ojo, la misma de Fase 6: bobina de 1 000 mm × 0.50 mm con densidad 8.0 ⇒
 * 4 kg por metro lineal, y una plancha de 4 m son 16 kg.
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
  // visitante de la corrida. Una corrida vio justo eso y falló en esta línea con el login ya
  // aceptado. El minuto es holgura de compilación, no de la app.
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-147 — la pantalla de tanda', () => {
  test('muestra el plan de la orden, desglosa los metros en planchas, corta lo que se pasa del restante y registra la tanda', async ({
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
      // ---------------------------------------------------------------------
      // 1. El escenario, por API: una sola orden abierta con bobina montada.
      // ---------------------------------------------------------------------
      // Plan de 10 planchas de 4 m = 40 ML. Un único largo a propósito: el desglose de
      // 16 m es entonces uno solo (4 × 4.00 m) y la aserción no depende de en qué orden
      // el repartidor de `piecesFromPlanMeters` elija los largos.
      const plan = pieces([4, 10]);
      expect(metersOf(plan)).toBe('40.000');
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows: plan,
      });
      trail.orderIds = [order.id];
      trail.quotationIds = [quotation.id];

      const reservation = (await reservationsOf(api, order.id)).find((r) => r.status === 'ACTIVE');
      const op = await roofingOrder(api, reservation!.id);
      trail.productionOrderIds = [op.id];
      // Montar es de planta (D-086): sin bobina la fila deshabilita el input de metros, así
      // que el escenario tiene que dejarla montada antes de abrir la pantalla.
      await postJson<ProductionOrderDto>(api, `/api/production/roofing/${op.id}/coils`, {
        coilId: scenario.coil.id,
      });

      // ---------------------------------------------------------------------
      // 2. La fila, en pantalla: ML plan, reportado y restante.
      // ---------------------------------------------------------------------
      await loginAsAdmin(page);
      await page.goto('/planta/tanda');
      // Mismo motivo que en el login: `/planta/tanda` se compila en el primer visitante.
      await expect(page.getByRole('heading', { name: 'Reportar producción en tanda' })).toBeVisible(
        { timeout: 60_000 },
      );

      // La base local acumula las órdenes de los demás tests de la corrida: el filtro por
      // código deja la tabla en la fila de esta orden y en ninguna otra.
      await page.getByLabel('Filtrar por orden, producto, pedido o cliente').fill(op.code);
      const row = page.getByRole('row').filter({ hasText: op.code });
      await expect(row).toHaveCount(1);

      // Las tres columnas de progreso del plan (D-146), en el orden de la cabecera:
      // Orden · Ítem · ML plan · ML reportado · ML restante · ML nuevo · kg consumido.
      await expect(row.getByRole('cell').nth(2)).toHaveText('40.000');
      await expect(row.getByRole('cell').nth(3)).toHaveText('0.000');
      await expect(row.getByRole('cell').nth(4)).toHaveText('40.000');
      // Y lo que el plan todavía debe, en planchas.
      await expect(row.getByText('Faltan 10 × 4.00 m')).toBeVisible();

      const metersInput = page.getByLabel(`Metros nuevos de ${op.code}`);
      const submit = page.getByRole('button', { name: 'Registrar la tanda' });
      // Sin ninguna fila con metros no hay nada que enviar.
      await expect(submit).toBeDisabled();

      // ---------------------------------------------------------------------
      // 3. Unos metros que sí salen de planchas enteras: el desglose aparece solo.
      // ---------------------------------------------------------------------
      await metersInput.fill('16');
      // `describePieces` con el reparto que el API va a volver a calcular al guardar: la
      // pantalla no adivina, corre la misma función de `@ayr/shared`.
      await expect(row.getByText('4 × 4.00 m', { exact: true })).toBeVisible();
      await expect(page.getByText(/16\.000 m en la tanda/)).toBeVisible();
      await expect(submit).toBeEnabled();

      // ---------------------------------------------------------------------
      // 4. Un valor que se pasa del restante: error en la fila y botón bloqueado.
      // ---------------------------------------------------------------------
      // 44 sobre un plan de 40. El tope de D-146 se aplica en la fila, sin ir al servidor.
      await metersInput.fill('44');
      await expect(row.getByText(/Del plan quedan 40\.000 m/)).toBeVisible();
      // El desglose del paso anterior desaparece con el error: la fila no ofrece un reparto
      // que no se puede grabar. (`exact` deja fuera el "Faltan 10 × 4.00 m" del ítem.)
      await expect(row.getByText('4 × 4.00 m', { exact: true })).toHaveCount(0);
      await expect(
        page.getByText('1 fila tiene un error: corrígelas antes de enviar.'),
      ).toBeVisible();
      await expect(submit).toBeDisabled();

      // ---------------------------------------------------------------------
      // 5. Corregido, la tanda entra y la fila queda con el reportado nuevo.
      // ---------------------------------------------------------------------
      await metersInput.fill('16');
      await expect(row.getByText(/Del plan quedan/)).toHaveCount(0);
      await expect(submit).toBeEnabled();
      await submit.click();

      // El toast trae lo que quedó escrito: 1 orden, 4 planchas de 4 m, 16 m.
      await expect(
        page.getByText(/Tanda registrada: 1 órdenes .* 4 planchas .* 16\.000 m/),
      ).toBeVisible();

      // Y la tabla se recarga sola: reportado 16, restante 24, y el input vuelve a vacío.
      await expect(row.getByRole('cell').nth(3)).toHaveText('16.000');
      await expect(row.getByRole('cell').nth(4)).toHaveText('24.000');
      await expect(metersInput).toHaveValue('');
      await expect(row.getByText('Faltan 6 × 4.00 m')).toBeVisible();

      // Y el kardex confirma que lo que la pantalla dice se escribió de verdad: 16 m de
      // producto terminado entraron, y la bobina salió por los 64 kg teóricos (4 kg/m).
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('16.000');
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1936.000');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
