import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems } from '../helpers/api';
import { createCatalogProduct, randomLetters } from '../helpers/production';
import { createCustomer, createSellableProduct } from '../helpers/sales';

/**
 * Importador masivo de cotizaciones **por pantalla**: `/cotizaciones/importar`
 * (D-152, D-156, D-158).
 *
 * `import-cotizaciones.spec.ts` cubre las reglas por API —el todo o nada, el cliente que no
 * está en el maestro, la nota de crédito excluida, la cotización sin vencimiento de D-157—. Lo
 * que falta y prueban estos casos es que la pantalla que el administrador usa de verdad
 * **muestre el problema antes de dejar escribir** y que lo que se envía sea lo que quedó en la
 * tabla, no lo que decía el archivo. Ese último punto es el que justifica el archivo entero: el
 * preview no persiste nada (D-152), así que entre el archivo y las cotizaciones creadas **la
 * única fuente es el estado del navegador**; si la edición no viajara, el defecto no lo vería
 * ningún test de API.
 *
 * Dos cosas cambiaron de forma desde la versión anterior de este spec y hay que tenerlas
 * presentes al leerlo:
 *
 * - **D-156: un acordeón por comprobante**, no una tabla plana de 141 filas. Solo se abre solo
 *   el que tiene algo sin resolver, que es el único donde hay trabajo que hacer; el resto se
 *   despliega a mano. Las líneas de un comprobante viven en su `region` "Líneas de <clave>".
 * - **D-158: el cliente es del comprobante, no de la línea.** Una factura es de un solo
 *   cliente, así que el campo vive en la cabecera (`Cliente de <clave>`) y sus diez líneas lo
 *   heredan. `Cliente de la fila N` ya no existe, y pedirlo por línea era además la única forma
 *   de armar un documento que el API no acepta.
 *
 * Lo que **no** se puede ejercitar acá: el badge "Nuevo — se creará desde padrón". Depende de
 * apis.net.pe y el entorno local no tiene token, así que un documento que el maestro no conoce
 * cae siempre en la rama del error normal. Montar un mock sería probar el mock.
 *
 * El archivo se arma como CSV en el propio test —mismos encabezados exactos que el export de
 * ventas detalladas— y se entrega con `setInputFiles` desde un buffer, sin tocar el disco ni
 * depender de ninguna librería de xlsx.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea clientes, productos y cotizaciones: nunca contra producción (D-126, regla dura 9).',
);

// Monta el escenario por API y encima navega a una ruta que el Next de desarrollo compila
// recién en el primer visitante: el timeout por defecto no alcanza.
test.describe.configure({ timeout: 240_000 });

/** Nombre propio para el producto: es la mitad de la etiqueta de su opción en el desplegable. */
const PRODUCT_NAME = 'Perfil E2E del importador por pantalla';

const HEADERS = [
  'F. EMISIÓN',
  'TIPO COMPROBANTE',
  'SERIE - NÚMERO',
  'CLIENTE',
  'MONEDA',
  'TIPOCAMBIO',
  'DOCUMENTO AJUSTADO',
  'CÓDIGO PRODUCTO',
  'NOMBRE PRODUCTO',
  'UNIDAD MEDIDA',
  'CANTIDAD',
  'VALOR DE VENTA',
];

interface SheetRow {
  issueDate: string;
  docType: string;
  documentKey: string;
  customer: string;
  currency?: string;
  exchangeRate?: string;
  adjusted?: string;
  sku: string;
  productName: string;
  unit: string;
  qty: string;
  netAmount: string;
}

function csvOf(rows: readonly SheetRow[]): string {
  const body = rows.map((r) =>
    [
      r.issueDate,
      r.docType,
      r.documentKey,
      r.customer,
      r.currency ?? 'Soles',
      r.exchangeRate ?? '',
      r.adjusted ?? '',
      r.sku,
      r.productName,
      r.unit,
      r.qty,
      r.netAmount,
    ].join(','),
  );
  return [HEADERS.join(','), ...body].join('\n');
}

interface QuotationListItem {
  id: string;
  code: string;
  status: string;
}

interface QuotationDetail {
  status: string;
  notes: string | null;
  customerName: string;
  items: { productId: string; qty: string; unitPricePen: string; pieces: unknown[] | null }[];
}

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
  // Con el App Router la URL cambia recién cuando llega el RSC del destino, y en modo dev el
  // tablero se compila en el primer visitante de la corrida: el minuto es holgura de
  // compilación, no de la app.
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

async function uploadCsv(page: Page, rows: readonly SheetRow[]): Promise<void> {
  await page.getByLabel('Excel o CSV del sistema de facturación').setInputFiles({
    name: 'ventas-detalladas.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvOf(rows), 'utf8'),
  });
  await expect(page.getByText(`${String(rows.length)} filas leídas`)).toBeVisible();
}

/** El disparador del acordeón de un comprobante: es el único botón que lleva `aria-expanded`. */
function documentToggle(page: Page, documentKey: string): Locator {
  return page.locator('button[aria-expanded]').filter({ hasText: documentKey });
}

/** Las líneas de un comprobante, que solo existen mientras su acordeón está abierto. */
function documentLines(page: Page, documentKey: string): Locator {
  return page.getByRole('region', { name: `Líneas de ${documentKey}` });
}

/*
 * Los campos de maestro de esta pantalla son `SearchSelectField` (D-156) y **cambian de forma
 * según cuántas opciones tengan**: hasta `SEARCH_SELECT_THRESHOLD` son un `<select>` y por
 * encima un botón que abre el modal de búsqueda. Los tres helpers de abajo existen por eso, y
 * no por gusto:
 *
 * - **Cuál de las dos formas toca no se sabe de antemano.** La base local acumula clientes y
 *   productos entre corridas —`reset-test-db.ts` vacía inventario, compras y usuarios, pero no
 *   los maestros—, así que la misma pantalla es un `<select>` en una base recién creada y un
 *   modal en la de una máquina que ya corrió la suite veinte veces.
 * - **Y la forma cambia bajo los pies.** Mientras el maestro viaja hay cero opciones, o sea un
 *   `<select>` vacío que un instante después puede volverse el botón del modal. Mirar la forma
 *   una sola vez es una carrera que falla con "Element is not a <select> element", un error que
 *   no se parece en nada a su causa. Por eso todo va por `expect.poll`.
 */

async function isNativeSelect(field: Locator): Promise<boolean> {
  return (await field.evaluate((el) => el.tagName.toLowerCase())) === 'select';
}

/**
 * Lo que el campo muestra como elegido, sea cual sea su forma. En el `<select>` es el texto de
 * la opción seleccionada y en el botón su propio texto; con nada elegido, los dos dicen el
 * placeholder, así que "no hay nada elegido" también se comprueba con esta función.
 */
async function chosenLabelOf(field: Locator): Promise<string> {
  return field.evaluate((el) =>
    el instanceof HTMLSelectElement
      ? (el.selectedOptions[0]?.textContent?.trim() ?? '')
      : (el.textContent?.trim() ?? ''),
  );
}

async function expectChosen(field: Locator, label: string): Promise<void> {
  await expect.poll(() => chosenLabelOf(field), { timeout: 20_000 }).toBe(label);
}

/** Elige una opción por su etiqueta visible, en cualquiera de las dos formas del campo. */
async function chooseOption(page: Page, field: Locator, optionLabel: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await chosenLabelOf(field)) === optionLabel) return true;
        try {
          if (await isNativeSelect(field)) {
            await field.selectOption({ label: optionLabel }, { timeout: 2_000 });
          } else {
            await field.click({ timeout: 2_000 });
            const modal = page.getByRole('dialog');
            await modal.getByLabel('Filtrar opciones').fill(optionLabel, { timeout: 2_000 });
            await modal
              .getByRole('button', { name: `Seleccionar ${optionLabel}`, exact: true })
              .click({ timeout: 2_000 });
          }
        } catch {
          // El maestro todavía no llegó (la opción no existe) o el campo cambió de forma
          // entre el sondeo y el clic: se reintenta con la forma que tenga en el intento
          // siguiente, que es exactamente lo que haría una persona mirando la pantalla.
          return false;
        }
        return (await chosenLabelOf(field)) === optionLabel;
      },
      { timeout: 30_000, intervals: [300, 700, 1_500] },
    )
    .toBe(true);
}

test.describe('D-152/D-156/D-158 — la pantalla del importador de cotizaciones', () => {
  test('agrupa por comprobante, abre solo el que tiene algo sin resolver, deja corregirlo, descuenta la línea que se quita e importa lo que quedó', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const created: string[] = [];

    try {
      // ---------------------------------------------------------------------
      // 1. Los maestros, por API: el importador no da de alta ninguno solo.
      // ---------------------------------------------------------------------
      const customer = await createCustomer(api);
      const product = await createCatalogProduct(api, {
        source: 'PURCHASED',
        name: PRODUCT_NAME,
      });

      const goodKey = `FFA1-${randomLetters(4)}`;
      const brokenKey = `FFA1-${randomLetters(4)}`;
      const missingSku = `NOEXISTE-${randomLetters(5)}`;
      const line = (over: Partial<SheetRow>): SheetRow => ({
        issueDate: '03/08/2026',
        docType: 'Factura',
        documentKey: '',
        customer: `${customer.docNumber} - ${customer.name}`,
        sku: product.sku,
        productName: PRODUCT_NAME,
        unit: 'UNIDAD',
        qty: '10.000',
        netAmount: '1000.00',
        ...over,
      });

      // ---------------------------------------------------------------------
      // 2. La pantalla, como administrador, con dos comprobantes: uno sano y
      //    uno cuyo SKU no está en el catálogo.
      // ---------------------------------------------------------------------
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      // Igual que el login: esta ruta se compila en el primer visitante.
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });
      await uploadCsv(page, [
        line({ documentKey: goodKey }),
        line({ documentKey: brokenKey, sku: missingSku }),
      ]);

      // ---------------------------------------------------------------------
      // 3. D-156: un acordeón por comprobante y **solo se abre el que hay que
      //    tocar**. Con 48 facturas de tres líneas, abrirlas todas es la tabla
      //    plana que esta pantalla vino a reemplazar.
      // ---------------------------------------------------------------------
      await expect(documentToggle(page, goodKey)).toHaveAttribute('aria-expanded', 'false');
      await expect(documentToggle(page, brokenKey)).toHaveAttribute('aria-expanded', 'true');
      await expect(documentLines(page, goodKey)).toHaveCount(0);

      // ---------------------------------------------------------------------
      // 4. El comprobante roto: dice qué le falta y bloquea el botón.
      // ---------------------------------------------------------------------
      const brokenLines = documentLines(page, brokenKey);
      const brokenProduct = brokenLines.getByLabel('Producto de la fila 2', { exact: true });
      await expectChosen(brokenProduct, 'Elige el producto');
      await expect(
        brokenLines.getByText('Elige el producto o créalo con el botón de al lado.'),
      ).toBeVisible();
      // Y muestra el SKU que traía el papel, para que se vea cuál es el que no existe.
      await expect(brokenLines.getByText(missingSku)).toBeVisible();

      await expect(page.getByText('Un comprobante tiene algo sin resolver')).toBeVisible();
      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();
      await expect(
        page.getByText('Se crearán 2 cotizaciones en borrador con 2 líneas.'),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 5. D-158: el cliente está en la **cabecera**, una vez por comprobante.
      // ---------------------------------------------------------------------
      const customerLabel = `${customer.docNumber} — ${customer.name}`;
      await expectChosen(page.getByLabel(`Cliente de ${goodKey}`, { exact: true }), customerLabel);
      await expectChosen(
        page.getByLabel(`Cliente de ${brokenKey}`, { exact: true }),
        customerLabel,
      );
      // El problema del comprobante roto está acotado a su línea: la cabecera no reclama nada,
      // porque el archivo sí resolvió el cliente.
      await expect(
        page.getByText('Elige el cliente del comprobante o créalo con el botón de al lado.'),
      ).toHaveCount(0);
      // Y el campo por línea desapareció: pedir diez veces el mismo dato era la única forma de
      // armar una factura con dos clientes.
      await expect(page.getByLabel('Cliente de la fila 1')).toHaveCount(0);

      // ---------------------------------------------------------------------
      // 6. El comprobante sano, desplegado a mano: llega con todo resuelto.
      // ---------------------------------------------------------------------
      await documentToggle(page, goodKey).click();
      const goodLines = documentLines(page, goodKey);
      await expectChosen(
        goodLines.getByLabel('Producto de la fila 1', { exact: true }),
        product.sku,
      );
      // El unitario **no viene en el archivo**: sale de valor de venta ÷ cantidad.
      await expect(goodLines.getByLabel('Cantidad de la fila 1')).toHaveValue('10.000');
      await expect(goodLines.getByLabel('Precio unitario de la fila 1')).toHaveValue('100.0000');
      // Línea simple: no se vende por metro lineal, así que no pide plan de corte (D-131).
      await expect(goodLines.getByLabel('Plan de corte de la fila 1')).toHaveCount(0);

      // ---------------------------------------------------------------------
      // 7. Corregido a mano, el botón se habilita **sin volver al servidor**.
      // ---------------------------------------------------------------------
      await chooseOption(page, brokenProduct, product.sku);
      await expectChosen(brokenProduct, product.sku);
      await expect(
        brokenLines.getByText('Elige el producto o créalo con el botón de al lado.'),
      ).toHaveCount(0);
      await expect(page.getByText('Un comprobante tiene algo sin resolver')).toHaveCount(0);
      await expect(submit).toBeEnabled();

      // ---------------------------------------------------------------------
      // 8. Quitar la única línea del otro comprobante: el resumen baja la cuenta
      //    **de líneas y de cotizaciones**, porque un comprobante sin líneas no
      //    se crea.
      // ---------------------------------------------------------------------
      await goodLines.getByRole('button', { name: 'Quitar' }).click();
      await expect(goodLines.getByText('Fila quitada de la importación.')).toBeVisible();
      await expect(
        page.getByText('Se crearán 1 cotizaciones en borrador con 1 líneas.'),
      ).toBeVisible();
      await expect(submit).toBeEnabled();

      // ---------------------------------------------------------------------
      // 9. Enviar: toast, aviso con los códigos y una sola cotización creada.
      // ---------------------------------------------------------------------
      const confirmed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/imports/quotations') &&
          !r.url().includes('preview') &&
          r.request().method() === 'POST',
      );
      await submit.click();
      const response = await confirmed;
      expect(response.ok(), `la importación falló: ${await response.text()}`).toBe(true);
      const result = (await response.json()) as {
        quotations: number;
        rows: number;
        codes: string[];
        createdCustomers: string[];
      };
      expect(result).toMatchObject({ quotations: 1, rows: 1 });
      // D-158: no se dio de alta ningún cliente — los dos comprobantes traían uno del maestro.
      expect(result.createdCustomers).toEqual([]);

      // Los ids se buscan apenas se conocen los códigos: si algo falla más abajo, el `finally`
      // ya tiene qué anular.
      const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
      const mine = all.filter((q) => result.codes.includes(q.code));
      created.push(...mine.map((q) => q.id));
      expect(mine).toHaveLength(1);

      const code = result.codes[0]!;
      await expect(page.getByText('1 cotizaciones creadas en borrador')).toBeVisible();
      await expect(
        page.getByText(`Se crearon 1 cotizaciones en borrador a partir de 1 líneas: ${code}.`),
      ).toBeVisible();
      // El preview se vacía al confirmar: no queda una tabla que se pueda volver a enviar.
      await expect(submit).toHaveCount(0);

      // Y lo que se escribió es la fila corregida —la del comprobante roto, con el producto
      // elegido a mano— y no la que se quitó.
      const detail = await api
        .get(`/api/sales/quotations/${mine[0]!.id}`)
        .then((r) => r.json() as Promise<QuotationDetail>);
      expect(detail.status).toBe('DRAFT');
      expect(detail.notes).toContain(`Factura externa: ${brokenKey}`);
      expect(detail.notes).not.toContain(goodKey);
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0]!.productId).toBe(product.id);
      expect(detail.items[0]!.qty).toBe('10.000');
    } finally {
      for (const id of created) {
        await api
          .post(`/api/sales/quotations/${id}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api.dispose();
    }
  });

  test('un comprobante cuyo cliente no está en el maestro se resuelve eligiéndolo en la cabecera', async ({
    page,
    baseURL,
  }) => {
    /**
     * Este caso estuvo en `fixme` toda la vida anterior del archivo, y no por capricho: la
     * pantalla pedía `/customers?pageSize=500`, el API topa `pageSize` en 200
     * (`paginationQuerySchema`, D-113) y la consulta devolvía un 400. El desplegable quedaba
     * **vacío**, así que la única salida que la pantalla ofrecía para un comprobante sin
     * cliente —elegirlo a mano— estaba muerta y había que quitar la fila.
     *
     * D-158 lo arregló paginando de a `MAX_PAGE_SIZE`, así que el caso se puede correr. Y el
     * campo se mudó a la cabecera: `Cliente de <clave>`, uno por comprobante.
     *
     * El documento inventado (`20999999999`) tampoco existe en el padrón, así que la rama de
     * D-158 —el badge "Nuevo — se creará desde padrón"— no se activa y el comprobante queda
     * con su error normal. Es el mismo camino que el entorno local recorre siempre: sin token
     * del padrón, no hay alta automática.
     */
    const api = await adminApi(baseURL!);
    const created: string[] = [];

    try {
      const customer = await createCustomer(api);
      const product = await createCatalogProduct(api, {
        source: 'PURCHASED',
        name: PRODUCT_NAME,
      });
      const documentKey = `FFA1-${randomLetters(4)}`;

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });
      await uploadCsv(page, [
        {
          issueDate: '03/08/2026',
          docType: 'Factura',
          documentKey,
          customer: '20999999999 - CLIENTE QUE NO EXISTE S.A.C.',
          sku: product.sku,
          productName: PRODUCT_NAME,
          unit: 'UNIDAD',
          qty: '10.000',
          netAmount: '1000.00',
        },
      ]);

      // El comprobante se abre solo —tiene algo sin resolver— y lo dice en su cabecera.
      await expect(documentToggle(page, documentKey)).toHaveAttribute('aria-expanded', 'true');
      await expect(
        page.getByText('Elige el cliente del comprobante o créalo con el botón de al lado.'),
      ).toBeVisible();
      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();
      // El alta express está al lado, que es la otra salida del callejón (D-156).
      await expect(page.getByRole('button', { name: '+ Crear cliente' })).toBeVisible();

      // **Lo que el defecto impedía:** el maestro está en el campo y se puede elegir.
      const field = page.getByLabel(`Cliente de ${documentKey}`, { exact: true });
      const label = `${customer.docNumber} — ${customer.name}`;
      await chooseOption(page, field, label);
      await expectChosen(field, label);
      await expect(
        page.getByText('Elige el cliente del comprobante o créalo con el botón de al lado.'),
      ).toHaveCount(0);
      await expect(submit).toBeEnabled();

      // Y el cliente elegido a mano es el que se guarda, no el texto del papel.
      const confirmed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/imports/quotations') &&
          !r.url().includes('preview') &&
          r.request().method() === 'POST',
      );
      await submit.click();
      const response = await confirmed;
      expect(response.ok(), `la importación falló: ${await response.text()}`).toBe(true);
      const result = (await response.json()) as { codes: string[]; createdCustomers: string[] };
      expect(result.createdCustomers).toEqual([]);

      const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
      const mine = all.filter((q) => result.codes.includes(q.code));
      created.push(...mine.map((q) => q.id));
      expect(mine).toHaveLength(1);
      const detail = await api
        .get(`/api/sales/quotations/${mine[0]!.id}`)
        .then((r) => r.json() as Promise<QuotationDetail>);
      expect(detail.customerName).toBe(customer.name);
    } finally {
      for (const id of created) {
        await api
          .post(`/api/sales/quotations/${id}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api.dispose();
    }
  });

  test('una línea que se vende por metro lineal llega con el plan de corte sugerido, y la sugerencia que no cabe en una plancha se marca', async ({
    page,
    baseURL,
  }) => {
    /**
     * D-158 sobre D-152: el plan de corte de una línea a medida **llega relleno** con
     * `1 × los ML de la línea`, escrito en el mismo formato que se tipea.
     *
     * Es una sugerencia, no un plan válido: el archivo del dueño tiene líneas de 81.9 m y una
     * plancha llega a 20, así que la celda muestra su error de siempre y hay que corregirla.
     * **La regla de D-152 sigue viva**: el importador no reparte esos metros en planchas por su
     * cuenta, porque el plan es después el tope duro de lo que planta puede reportar (D-146).
     * Lo único que cambia —y lo que este caso protege— es que corregirlo sea **editar un
     * número** en vez de transcribir la cifra del papel a mano, que es de donde salían los
     * errores de tipeo sobre un dato que la pantalla ya tenía.
     */
    const api = await adminApi(baseURL!);
    const created: string[] = [];

    try {
      const customer = await createCustomer(api);
      // Por metro lineal (`MTR`): es la unidad —no el subtipo— la que decide si la línea
      // necesita el detalle de largos (D-131, regla dura 14).
      const product = await createSellableProduct(api, { lineCode: 'roofing', unit: 'MTR' });
      const documentKey = `FFA1-${randomLetters(4)}`;

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });
      await uploadCsv(page, [
        {
          issueDate: '03/08/2026',
          docType: 'Factura',
          documentKey,
          customer: `${customer.docNumber} - ${customer.name}`,
          sku: product.sku,
          productName: product.name.replace(/,/g, ' '),
          unit: 'METRO LINEAL',
          qty: '81.900',
          netAmount: '819.00',
        },
      ]);

      const lines = documentLines(page, documentKey);
      const plan = lines.getByLabel('Plan de corte de la fila 1');
      // **Relleno, no vacío**: la cifra del papel ya está adentro.
      await expect(plan).toHaveValue('1x81.9');
      // Y marcado, porque 81.9 m no salen de una sola plancha.
      await expect(lines.getByText(/El largo va entre 0\.10 y 20\.00 metros/)).toBeVisible();
      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();

      // Un reparto que **no** suma los metros de la línea tampoco pasa: los largos y la
      // cantidad son el mismo dato dicho dos veces (D-083).
      await plan.fill('4x20');
      await expect(
        lines.getByText('Los largos suman 80.000 m y la línea dice 81.900 m.'),
      ).toBeVisible();
      await expect(submit).toBeDisabled();

      // El reparto real: 4 planchas de 20 m y una de 1.90.
      await plan.fill('4x20, 1x1.9');
      await expect(lines.getByText('4 × 20.00 m, 1 × 1.90 m · 81.900 m')).toBeVisible();
      await expect(submit).toBeEnabled();

      const confirmed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/imports/quotations') &&
          !r.url().includes('preview') &&
          r.request().method() === 'POST',
      );
      await submit.click();
      const response = await confirmed;
      expect(response.ok(), `la importación falló: ${await response.text()}`).toBe(true);
      const result = (await response.json()) as { quotations: number; codes: string[] };
      expect(result.quotations).toBe(1);

      const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
      const mine = all.filter((q) => result.codes.includes(q.code));
      created.push(...mine.map((q) => q.id));
      expect(mine).toHaveLength(1);
      const detail = await api
        .get(`/api/sales/quotations/${mine[0]!.id}`)
        .then((r) => r.json() as Promise<QuotationDetail>);
      // Los largos corregidos llegaron al API: es lo que el estado del navegador manda.
      expect(detail.items[0]!.qty).toBe('81.900');
      expect(detail.items[0]!.pieces).toHaveLength(2);
    } finally {
      for (const id of created) {
        await api
          .post(`/api/sales/quotations/${id}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api.dispose();
    }
  });
});
