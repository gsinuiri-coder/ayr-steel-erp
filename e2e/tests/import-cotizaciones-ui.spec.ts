import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems } from '../helpers/api';
import { createCatalogProduct, randomLetters } from '../helpers/production';
import { createCustomer, createSellableProduct } from '../helpers/sales';
import { chooseOption, chosenLabelOf, expectChosen } from '../helpers/ui';

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
 * **El badge "Nuevo — se creará desde padrón" sí se ejercita** (antes decía acá que era
 * imposible). El padrón se consulta del lado del **API**, así que un `page.route()` nunca lo
 * interceptaba; ahora `e2e/padron-stub.mjs` corre como tercer `webServer` y el API lo usa vía
 * `APIS_NET_PE_BASE_URL`. El stub responde 200 al documento que **termina en dígito par** y 404
 * al que termina en impar, así que un caso elige a propósito de qué lado del padrón cae cada
 * comprobante. No es "probar el mock": lo que se prueba es la rama del ERP que solo se activa
 * cuando el padrón responde, y el contraste vive en el mismo archivo con la misma corrida.
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
     * El documento inventado (`20999999999`) **termina en impar**, así que el stub del padrón
     * lo devuelve como 404 y la rama de D-158 —el badge "Nuevo — se creará desde padrón"— no
     * se activa: el comprobante queda con su error normal. Que la última cifra sea impar no es
     * casualidad y no se puede cambiar sin romper el caso.
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

  test('el comprobante cuyo RUC está en el padrón se marca «Nuevo — se creará desde padrón» y el del RUC que el padrón no conoce queda con su error', async ({
    page,
    baseURL,
  }) => {
    /**
     * **D-158, la rama que hasta ahora ningún E2E podía ejercitar.**
     *
     * Dos comprobantes en **el mismo archivo**, idénticos salvo por la última cifra del RUC:
     * uno par —el stub del padrón lo devuelve— y uno impar —el stub responde 404—. Ninguno
     * está en el maestro. Ese es todo el contraste, y por eso van juntos: si el badge
     * apareciera por "el documento no está en el maestro" en vez de por "el padrón lo
     * devolvió", los dos lo mostrarían.
     *
     * Lo que se afirma, además del badge:
     *
     * - **El nombre lo pone el servidor.** El archivo trae una razón social inventada y el
     *   request que sale del navegador manda `newCustomer` con **solo el documento** —dos
     *   claves, sin `name`—. Es la aserción que protege la decisión de forma de D-158: sin
     *   ella, aceptar el nombre del navegador dejaría dar de alta "PROVEEDOR S.A.C." bajo un
     *   RUC ajeno editando el request, que es la creación de datos inventados que D-152
     *   prohibió. Y el cliente que queda en el maestro tiene la razón social del padrón, no
     *   la del Excel.
     * - **El comprobante del padrón no es un problema**: no se abre solo, su badge de estado
     *   dice "Lista" y no bloquea el botón. El único que bloquea es el del RUC que no existe.
     */
    const api = await adminApi(baseURL!);
    const created: string[] = [];

    /** RUC de 11 dígitos con la última cifra elegida: par existe en el stub, impar no. */
    const ruc = (exists: boolean): string => {
      const middle = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      return `20${middle}${exists ? '4' : '7'}`;
    };
    const rucEnPadron = ruc(true);
    const rucFueraDelPadron = ruc(false);
    // Lo que dice el papel, y que no tiene que llegar a la base: el nombre lo decide SUNAT.
    const NOMBRE_DEL_EXCEL = 'RAZON SOCIAL INVENTADA DEL EXCEL S.A.C.';

    try {
      const delMaestro = await createCustomer(api);
      const product = await createCatalogProduct(api, {
        source: 'PURCHASED',
        name: PRODUCT_NAME,
      });
      const keyPadron = `FFA1-${randomLetters(4)}`;
      const keySinPadron = `FFA1-${randomLetters(4)}`;
      const line = (over: Partial<SheetRow>): SheetRow => ({
        issueDate: '03/08/2026',
        docType: 'Factura',
        documentKey: '',
        customer: '',
        sku: product.sku,
        productName: PRODUCT_NAME,
        unit: 'UNIDAD',
        qty: '10.000',
        netAmount: '1000.00',
        ...over,
      });

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });
      await uploadCsv(page, [
        line({ documentKey: keyPadron, customer: `${rucEnPadron} - ${NOMBRE_DEL_EXCEL}` }),
        line({ documentKey: keySinPadron, customer: `${rucFueraDelPadron} - ${NOMBRE_DEL_EXCEL}` }),
      ]);

      // ---------------------------------------------------------------------
      // 1. El que sí está en el padrón: badge con la razón social **del padrón**.
      // ---------------------------------------------------------------------
      await expect(
        page.getByText(`Nuevo — se creará desde padrón: PADRON STUB ${rucEnPadron}`),
      ).toBeVisible();
      // El nombre del papel no es el que se muestra como decidido: en la cabecera aparece
      // como referencia de lo que traía el archivo, pero el badge dice el del padrón.
      await expect(
        page.getByText(`Nuevo — se creará desde padrón: ${NOMBRE_DEL_EXCEL}`),
      ).toHaveCount(0);
      // No es un problema: no se abre solo y su estado es "Lista".
      const togglePadron = documentToggle(page, keyPadron);
      await expect(togglePadron).toHaveAttribute('aria-expanded', 'false');
      await expect(togglePadron.locator('..').getByText('Lista', { exact: true })).toBeVisible();
      // Y el aviso de arriba lo cuenta como alta, en singular: es **uno** solo.
      await expect(
        page.getByText(
          'Un comprobante trae un cliente que no está en el maestro y sí en el padrón',
        ),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 2. El que no está: sin badge, con su error de siempre y con el alta
      //    express al lado (D-156). El botón queda bloqueado por este y solo
      //    por este.
      // ---------------------------------------------------------------------
      await expect(
        page.getByText(`Nuevo — se creará desde padrón: PADRON STUB ${rucFueraDelPadron}`),
      ).toHaveCount(0);
      await expect(documentToggle(page, keySinPadron)).toHaveAttribute('aria-expanded', 'true');
      await expect(
        page.getByText('Elige el cliente del comprobante o créalo con el botón de al lado.'),
      ).toHaveCount(1);
      await expect(page.getByText('Un comprobante tiene algo sin resolver')).toBeVisible();
      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();
      await expect(page.getByRole('button', { name: '+ Crear cliente' })).toHaveCount(2);

      // ---------------------------------------------------------------------
      // 3. Se resuelve eligiendo un cliente del maestro y el resumen queda
      //    diciendo cuántos clientes se van a dar de alta.
      // ---------------------------------------------------------------------
      const etiquetaMaestro = `${delMaestro.docNumber} — ${delMaestro.name}`;
      const campoSinPadron = page.getByLabel(`Cliente de ${keySinPadron}`, { exact: true });
      await chooseOption(page, campoSinPadron, etiquetaMaestro);
      await expectChosen(campoSinPadron, etiquetaMaestro);
      await expect(submit).toBeEnabled();
      await expect(
        page.getByText(
          'Se crearán 2 cotizaciones en borrador con 2 líneas, y 1 clientes nuevos desde el padrón.',
        ),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 4. Enviar. **Lo que viaja** es lo que protege D-158: el documento y
      //    nada más.
      // ---------------------------------------------------------------------
      const enviado = page.waitForRequest(
        (r) =>
          r.url().includes('/api/imports/quotations') &&
          !r.url().includes('preview') &&
          r.method() === 'POST',
      );
      const confirmed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/imports/quotations') &&
          !r.url().includes('preview') &&
          r.request().method() === 'POST',
      );
      await submit.click();

      const body = (await enviado).postDataJSON() as {
        rows: {
          documentKey: string;
          customerId: string | null;
          newCustomer?: Record<string, unknown>;
        }[];
      };
      const filaPadron = body.rows.find((r) => r.documentKey === keyPadron);
      const filaMaestro = body.rows.find((r) => r.documentKey === keySinPadron);
      expect(filaPadron?.customerId).toBeNull();
      // Dos claves exactas: `docType` y `docNumber`. Si mañana alguien agrega `name` acá, este
      // caso se cae — que es justo lo que tiene que pasar.
      expect(filaPadron?.newCustomer).toEqual({ docType: 'RUC', docNumber: rucEnPadron });
      // Y el nombre del papel no viaja por ningún otro campo del request.
      expect(JSON.stringify(body)).not.toContain(NOMBRE_DEL_EXCEL);
      // El comprobante resuelto a mano manda el id y **no** pide alta: son excluyentes.
      expect(filaMaestro?.customerId).toBe(delMaestro.id);
      expect(filaMaestro?.newCustomer).toBeUndefined();

      const response = await confirmed;
      expect(response.ok(), `la importación falló: ${await response.text()}`).toBe(true);
      const result = (await response.json()) as {
        quotations: number;
        codes: string[];
        createdCustomers: string[];
      };
      expect(result.quotations).toBe(2);
      // El alta se informa con la razón social del padrón, que es la que se escribió.
      expect(result.createdCustomers).toEqual([`${rucEnPadron} — PADRON STUB ${rucEnPadron}`]);
      await expect(
        page.getByText(`Y se dieron de alta 1 clientes desde el padrón: ${rucEnPadron}`),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 5. Lo que quedó escrito: el cliente nuevo con el nombre del padrón y
      //    cada cotización a nombre de quien corresponde.
      // ---------------------------------------------------------------------
      const enMaestro = await getItems<{ id: string; docNumber: string; name: string }>(
        api,
        `/api/customers?search=${rucEnPadron}`,
      );
      const nuevo = enMaestro.find((c) => c.docNumber === rucEnPadron);
      expect(nuevo, 'el importador no dio de alta al cliente del padrón').toBeDefined();
      expect(nuevo!.name).toBe(`PADRON STUB ${rucEnPadron}`);
      // El RUC que el padrón no conoce **no** se dio de alta: se resolvió eligiendo otro.
      const noCreado = await getItems<{ docNumber: string }>(
        api,
        `/api/customers?search=${rucFueraDelPadron}`,
      );
      expect(noCreado.filter((c) => c.docNumber === rucFueraDelPadron)).toHaveLength(0);

      const all = await getItems<QuotationListItem>(api, '/api/sales/quotations');
      const mine = all.filter((q) => result.codes.includes(q.code));
      created.push(...mine.map((q) => q.id));
      expect(mine).toHaveLength(2);
      const detalles = await Promise.all(
        mine.map((q) =>
          api
            .get(`/api/sales/quotations/${q.id}`)
            .then((r) => r.json() as Promise<QuotationDetail>),
        ),
      );
      const delPadron = detalles.find((d) => d.notes?.includes(keyPadron));
      const delOtro = detalles.find((d) => d.notes?.includes(keySinPadron));
      expect(delPadron?.customerName).toBe(`PADRON STUB ${rucEnPadron}`);
      expect(delOtro?.customerName).toBe(delMaestro.name);
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
