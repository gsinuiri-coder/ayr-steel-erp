import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  adminApi,
  adminCredentials,
  createFinish,
  createSupplier,
  getItems,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from '../helpers/api';
import { today, uniqueDocumentNumber } from '../helpers/production';

/**
 * **D-164 por pantalla**: el diálogo de cierre de bobina (`/bobinas/[id]`, `coil-close-dialog.tsx`).
 *
 * `cierre-bobina-d164.spec.ts` ya fija las reglas **por API** —qué se liquida, con qué valor,
 * qué rechaza el schema, cómo se deshace al reabrir—. Lo que faltaba, y es lo único que hay
 * acá, es que la pantalla que planta usa de verdad:
 *
 * - **pregunte cuántos kilos quedan y no lo dé por sabido.** El campo arranca vacío a
 *   propósito: prellenarlo con la baja total convertía el cierre en una baja de inventario de
 *   un clic, que es justo lo que D-164 vino a impedir.
 * - **muestre la liquidación antes de confirmarla**, en kilos y en soles, con el mismo
 *   promedio con el que el kardex la va a sacar. Prometer un número que el API después calcula
 *   de otra fuente es el defecto de D-163, y este diálogo tiene las dos ramas donde eso puede
 *   pasar.
 * - **no deje cerrar sin motivo** cuando hay algo que liquidar, en los dos sentidos: la merma
 *   y el sobrante. Que el sobrante lo exija igual no es simetría decorativa — da de alta
 *   inventario.
 * - **deje el movimiento visible en el kardex de la bobina**, que es donde alguien lo va a
 *   buscar tres meses después.
 *
 * El escenario se monta por API (compra + recepción) y solo el cierre pasa por la pantalla:
 * lo que se prueba es el diálogo, no la carga de una bobina.
 *
 * Escribe kardex (append-only, §3.2): contra producción solo con `E2E_ALLOW_WRITES=1`
 * (D-024, regla dura 9).
 */
const isProduction = !!process.env.E2E_BASE_URL;
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

/** Línea con inventario (`STOCK`), igual que el spec de API de D-164. */
const LINE = 'drywall';

// Monta el escenario por API y encima navega a una ruta que el Next de desarrollo compila
// recién en el primer visitante: el timeout por defecto no alcanza.
test.describe.configure({ timeout: 240_000 });

interface CoilRow {
  id: string;
  code: string;
  status: string;
  availableKg: string;
  avgCostPen: string;
  purchaseId: string | null;
}

const purchaseIds: string[] = [];

/** Una bobina abierta de `weightKg` kilos a `unitPrice` por kilo, ya ingresada al kardex. */
async function buyCoil(
  api: APIRequestContext,
  input: { supplier: CreatedSupplier; finish: CreatedFinish; weightKg: string; unitPrice: string },
): Promise<CoilRow> {
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId: input.supplier.id,
    businessLine: LINE,
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina E2E para el cierre por pantalla (D-164)',
        qty: input.weightKg,
        unit: 'KGM',
        unitPrice: input.unitPrice,
        finishId: input.finish.id,
        widthMm: '1220',
        thicknessMm: '0.50',
        // D-117: sin esto la bobina nace CLOSED y no se puede operar.
        coilStatus: 'OPEN',
      },
    ],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  purchaseIds.push(purchase.id);
  const coils = await getItems<CoilRow>(api, `/api/coils?supplierId=${input.supplier.id}`);
  const coil = coils.find((c) => c.purchaseId === purchase.id);
  expect(coil, 'La compra no dejó ninguna bobina').toBeDefined();
  return coil!;
}

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/**
 * El valor de una fila «etiqueta · valor» de las tarjetas de la bobina (Material, Costo).
 *
 * No hay rol ni `label` que agarrar —son dos `<span>` hermanos—, así que se busca por el texto
 * visible de la etiqueta y se lee el contenedor. Se afirma sobre el contenedor y no sobre la
 * página entera a propósito: `900.000 kg` aparece en la tarjeta, en el diálogo y en el kardex,
 * y un `getByText` suelto daría verde con el número equivocado en la tarjeta correcta.
 */
function datoDeTarjeta(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('..');
}

/** La fila del kardex que emitió el cierre. Hay una sola por bobina en estos escenarios. */
function filaDeCierre(page: Page): Locator {
  return page.getByRole('row').filter({ hasText: 'Cierre de bobina' });
}

/** Abre el diálogo de cierre desde el detalle de la bobina. */
async function abrirDialogoDeCierre(page: Page, coil: CoilRow): Promise<Locator> {
  await page.goto(`/bobinas/${coil.id}`);
  await expect(page.getByRole('heading', { name: coil.code })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: `Cerrar ${coil.code}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('D-164 — cerrar una bobina con saldo desde la pantalla', () => {
  test.skip(skipWrites, 'Escribe kardex: contra producción solo con E2E_ALLOW_WRITES=1 (D-024)');

  let api: APIRequestContext;
  let supplier: CreatedSupplier;
  let finish: CreatedFinish;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    supplier = await createSupplier(api);
    finish = await createFinish(api);
  });

  test.afterAll(async () => {
    // Contra producción se deshace lo que el dominio deja deshacer; en local la base se vacía
    // en cada corrida y no hace falta.
    if (isProduction) {
      for (const purchaseId of purchaseIds) {
        await api
          .post(`/api/purchases/${purchaseId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api
        .patch(`/api/suppliers/${supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
    await api.dispose();
  });

  test('el diálogo exige declarar los kilos y un motivo, y la merma anormal queda en el kardex de la bobina con sus kilos y su valor', async ({
    page,
  }) => {
    // 1 000 kg a S/ 4: el rollo se terminó dejando 940 kg de verdad, así que 60 kg del saldo
    // teórico son material que se perdió y nadie registró. Números redondos para que la
    // liquidación se pueda comprobar a ojo: 60 × 4 = S/ 240.
    const coil = await buyCoil(api, { supplier, finish, weightKg: '1000', unitPrice: '4' });
    expect(coil.availableKg).toBe('1000.000');

    await loginAsAdmin(page);
    const dialog = await abrirDialogoDeCierre(page, coil);

    // -----------------------------------------------------------------------
    // 1. El diálogo dice contra qué se compara antes de pedir nada, y el campo
    //    **arranca vacío**: la baja total no es el valor por defecto.
    // -----------------------------------------------------------------------
    await expect(dialog).toContainText('El kardex tiene 1,000.000 kg de saldo');
    await expect(dialog).toContainText('valorizados en S/ 4,000.00');
    const kilos = dialog.getByLabel('Kilos que quedan en el rollo');
    await expect(kilos).toHaveValue('');
    // Con el campo vacío no hay liquidación que anunciar y el motivo es opcional.
    await expect(dialog.getByLabel('Motivo (opcional)')).toBeVisible();
    const cerrar = dialog.getByRole('button', { name: 'Cerrar bobina' });
    await expect(cerrar).toBeDisabled();

    // -----------------------------------------------------------------------
    // 2. Declarados los kilos, la pantalla anuncia **qué se va a liquidar**,
    //    en kilos y en soles, antes de confirmar.
    // -----------------------------------------------------------------------
    await kilos.fill('940');
    await expect(dialog).toContainText('Se liquidan 60.000 kg como merma');
    await expect(dialog).toContainText('S/ 240.00 de menos en el inventario valorizado');

    // -----------------------------------------------------------------------
    // 3. **Sin motivo no cierra.** El campo deja de ser opcional —el "(opcional)"
    //    desaparece de la etiqueta— y el botón queda bloqueado hasta que haya un
    //    motivo escrito de verdad, no dos letras.
    // -----------------------------------------------------------------------
    await expect(dialog.getByLabel('Motivo (opcional)')).toHaveCount(0);
    const motivo = dialog.getByLabel('Motivo', { exact: true });
    await expect(motivo).toBeVisible();
    await expect(cerrar).toBeDisabled();
    await motivo.fill('ok');
    await expect(cerrar).toBeDisabled();
    await motivo.fill('El rollo se terminó en la corrida del martes (prueba E2E)');
    await expect(cerrar).toBeEnabled();

    // -----------------------------------------------------------------------
    // 4. Cerrar: la bobina queda CERRADA y el saldo baja al conteo real.
    // -----------------------------------------------------------------------
    await cerrar.click();
    await expect(page.getByText('Bobina cerrada')).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByText('Cerrada', { exact: true })).toBeVisible();
    await expect(datoDeTarjeta(page, 'Disponible')).toContainText('940.000 kg');
    // Y el inventario valorizado deja de contar el material que ya no existe, que es el
    // defecto entero que D-164 vino a cerrar: 940 × 4 = S/ 3,760.
    await expect(datoDeTarjeta(page, 'Saldo valorizado')).toContainText('S/ 3,760.00');

    // -----------------------------------------------------------------------
    // 5. El movimiento está en el kardex de la bobina, con su origen propio
    //    —no como una merma de RF-17— y con el motivo que se tipeó.
    // -----------------------------------------------------------------------
    const fila = filaDeCierre(page);
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText('Salida');
    await expect(fila).toContainText('60.000 kg');
    // El saldo corrido que deja el movimiento.
    await expect(fila).toContainText('940.000 kg');
    await expect(fila).toContainText('El rollo se terminó en la corrida del martes');
    // El ajuste del cierre **no** se anula por RF-18: se deshace reabriendo (D-164), así que
    // la fila no ofrece "Anular merma".
    await expect(fila.getByRole('button', { name: 'Anular merma' })).toHaveCount(0);

    // -----------------------------------------------------------------------
    // 6. **El valor** vive en el kardex completo, que es adonde lleva el botón
    //    de la tarjeta: la tabla del detalle muestra kilos y saldo, no soles.
    // -----------------------------------------------------------------------
    await page.getByRole('link', { name: 'Ver kardex completo' }).click();
    await expect(page.getByRole('heading', { name: 'Kardex' })).toBeVisible({ timeout: 60_000 });
    const filaCompleta = filaDeCierre(page);
    await expect(filaCompleta).toHaveCount(1);
    await expect(filaCompleta).toContainText('60.000 kg');
    // Sale al costo promedio vigente (D-028/D-040), como toda salida.
    await expect(filaCompleta).toContainText('S/ 4.0000');
    await expect(filaCompleta).toContainText('S/ 240.00');
  });

  test('el conteo que da de más entra al kardex como sobrante, exige motivo igual y la pantalla corta los kilos que la bobina nunca tuvo', async ({
    page,
  }) => {
    // 200 kg a S/ 4, con 100 kg ya consumidos: queda un saldo vivo de 100 kg. Declarar 150
    // es el conteo que da **de más** que el kardex, sobre un promedio vigente que sí existe
    // (el sobrante sobre saldo cero se valoriza distinto y eso lo cubre el spec de API).
    const coil = await buyCoil(api, { supplier, finish, weightKg: '200', unitPrice: '4' });
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '100',
      reason: 'Consumo de la corrida (prueba E2E)',
    });

    await loginAsAdmin(page);
    const dialog = await abrirDialogoDeCierre(page, coil);
    await expect(dialog).toContainText('El kardex tiene 100.000 kg de saldo');
    const kilos = dialog.getByLabel('Kilos que quedan en el rollo');
    const cerrar = dialog.getByRole('button', { name: 'Cerrar bobina' });

    // -----------------------------------------------------------------------
    // 1. Un rollo no puede tener más kilos de los que entraron: la pantalla lo
    //    dice antes de mandarlo, en vez de dejar tipear y rebotar con un 400.
    // -----------------------------------------------------------------------
    await kilos.fill('250');
    await expect(dialog).toContainText('La bobina entró con 200.000 kg: no puede quedarle más.');
    await expect(cerrar).toBeDisabled();

    // -----------------------------------------------------------------------
    // 2. El sobrante: 50 kg que el kardex no conocía, valorizados al promedio
    //    vigente (50 × 4 = S/ 200), y el motivo es obligatorio **porque da de
    //    alta inventario**, no por simetría.
    // -----------------------------------------------------------------------
    await kilos.fill('150');
    await expect(dialog).toContainText('Entran 50.000 kg al kardex por S/ 200.00');
    await expect(dialog).toContainText('Da de alta material, así que el motivo es obligatorio.');
    await expect(cerrar).toBeDisabled();
    await dialog
      .getByLabel('Motivo', { exact: true })
      .fill('Quedaban 50 kg que la corrida no descontó (prueba E2E)');
    await expect(cerrar).toBeEnabled();

    await cerrar.click();
    await expect(page.getByText('Bobina cerrada')).toBeVisible();

    // -----------------------------------------------------------------------
    // 3. La bobina queda cerrada **con más kilos** de los que tenía, y el
    //    movimiento es una entrada.
    // -----------------------------------------------------------------------
    await expect(page.getByText('Cerrada', { exact: true })).toBeVisible();
    await expect(datoDeTarjeta(page, 'Disponible')).toContainText('150.000 kg');
    await expect(datoDeTarjeta(page, 'Saldo valorizado')).toContainText('S/ 600.00');

    const fila = filaDeCierre(page);
    await expect(fila).toHaveCount(1);
    await expect(fila).toContainText('Entrada');
    await expect(fila).toContainText('50.000 kg');
    await expect(fila).toContainText('150.000 kg');
    await expect(fila).toContainText('Quedaban 50 kg que la corrida no descontó');

    await page.getByRole('link', { name: 'Ver kardex completo' }).click();
    await expect(page.getByRole('heading', { name: 'Kardex' })).toBeVisible({ timeout: 60_000 });
    const filaCompleta = filaDeCierre(page);
    await expect(filaCompleta).toContainText('50.000 kg');
    await expect(filaCompleta).toContainText('S/ 200.00');
  });
});
