import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getItems } from '../helpers/api';
import { createCatalogProduct, randomLetters } from '../helpers/production';
import { createCustomer } from '../helpers/sales';

/**
 * Importador masivo de cotizaciones **por pantalla** (D-152): `/cotizaciones/importar`.
 *
 * `import-cotizaciones.spec.ts` cubre las reglas por API —el todo o nada, el cliente que no
 * está en el maestro, la nota de crédito excluida—. Lo que falta y prueba este caso es que la
 * pantalla que el administrador usa de verdad **muestre el problema antes de dejar escribir**:
 * que la tabla del preview traiga una fila por línea del archivo, que la línea con un SKU que
 * no existe diga qué le falta y deje el botón de confirmar bloqueado, que elegir el producto a
 * mano lo desbloquee sin volver al servidor, que quitar una fila baje la cuenta del resumen y
 * que lo que se envía sea lo que quedó en la tabla, no lo que decía el archivo.
 *
 * Ese último punto es el que justifica el caso entero: el preview no persiste nada (D-152), así
 * que entre el archivo y las cotizaciones creadas **la única fuente es el estado del navegador**.
 * Si la edición de la tabla no viajara, el defecto no lo vería ningún test de API.
 *
 * Es deliberadamente un solo test largo y no seis: los seis pasos son estados sucesivos de la
 * misma pantalla, y volver a subir el archivo en cada uno no probaría nada nuevo.
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
  items: { productId: string; qty: string; unitPricePen: string }[];
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
  // compilación, no de la app (mismo motivo que en `planta-tanda-ui.spec.ts`).
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-152 — la pantalla del importador de cotizaciones', () => {
  test('lee el archivo en una tabla, bloquea la línea sin producto, deja corregirla, descuenta la que se quita e importa lo que quedó', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const created: string[] = [];

    try {
      // ---------------------------------------------------------------------
      // 1. Los maestros, por API: el importador no da de alta ninguno.
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
      const csv = csvOf([
        line({ documentKey: goodKey }),
        // La segunda fila apunta a un SKU que no está en el catálogo: es la que la pantalla
        // tiene que frenar.
        line({ documentKey: brokenKey, sku: missingSku }),
      ]);

      // ---------------------------------------------------------------------
      // 2. La pantalla, como administrador.
      // ---------------------------------------------------------------------
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      // Igual que el login: esta ruta se compila en el primer visitante.
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });

      // ---------------------------------------------------------------------
      // 3. El archivo, desde un buffer: dos líneas, una buena y una rota.
      // ---------------------------------------------------------------------
      await page.getByLabel('Excel o CSV del sistema de facturación').setInputFiles({
        name: 'ventas-detalladas.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf8'),
      });
      await expect(page.getByText('2 filas leídas')).toBeVisible();

      // ---------------------------------------------------------------------
      // 4. El preview: una fila por línea, la rota marcada y el botón bloqueado.
      // ---------------------------------------------------------------------
      const goodRow = page.getByRole('row').filter({ hasText: goodKey });
      const brokenRow = page.getByRole('row').filter({ hasText: brokenKey });
      await expect(goodRow).toHaveCount(1);
      await expect(brokenRow).toHaveCount(1);

      // La fila que sí resolvió llega con su producto ya elegido, y con el unitario que el
      // archivo **no** trae: 1000 de valor de venta ÷ 10 de cantidad.
      // (Esperar el valor del desplegable es además lo que garantiza que el catálogo ya
      // cargó: un `<select>` no puede mostrar un id cuya opción todavía no existe.)
      //
      // El desplegable de cliente no se comprueba acá **a propósito**: hoy llega siempre
      // vacío por un defecto de la pantalla —pide `/customers?pageSize=500` y el API topa
      // `pageSize` en 200—, así que muestra "Elige el cliente" aunque la fila haya resuelto.
      // El caso que lo persigue está más abajo, marcado con `test.fixme`.
      await expect(goodRow.getByLabel('Producto de la fila 1')).toHaveValue(product.id);
      await expect(goodRow.getByLabel('Cantidad de la fila 1')).toHaveValue('10.000');
      await expect(goodRow.getByLabel('Precio unitario de la fila 1')).toHaveValue('100.0000');
      // Línea simple: no es una cobertura a medida, así que no pide plan de corte (D-083/D-127).
      await expect(goodRow.getByLabel('Plan de corte de la fila 1')).toHaveCount(0);

      // La rota queda sin producto, dice qué le falta en su propia celda y muestra el código
      // que el archivo traía, para que se vea cuál es el SKU que no existe.
      const brokenProduct = brokenRow.getByLabel('Producto de la fila 2');
      await expect(brokenProduct).toHaveValue('');
      await expect(
        brokenRow.getByText('Elige el producto: no se crea ninguno desde el importador.'),
      ).toBeVisible();
      await expect(brokenRow.getByText(missingSku)).toBeVisible();
      // Y el problema está acotado a esa celda: la del cliente no reclama nada, porque el
      // archivo sí lo resolvió.
      await expect(
        brokenRow.getByText('Elige el cliente: no se crea ninguno desde el importador.'),
      ).toHaveCount(0);

      await expect(page.getByText('Una línea tiene algo sin resolver')).toBeVisible();
      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();
      await expect(
        page.getByText('Se crearán 2 cotizaciones en borrador con 2 líneas.'),
      ).toBeVisible();

      // ---------------------------------------------------------------------
      // 5. Corregida a mano en el desplegable, el botón se habilita.
      // ---------------------------------------------------------------------
      // Por etiqueta visible, que es como el usuario la encuentra: `SKU — nombre`.
      await brokenProduct.selectOption({ label: `${product.sku} — ${PRODUCT_NAME}` });
      await expect(brokenProduct).toHaveValue(product.id);
      // El aviso se apaga en el navegador, sin ir y volver al API.
      await expect(
        brokenRow.getByText('Elige el producto: no se crea ninguno desde el importador.'),
      ).toHaveCount(0);
      await expect(page.getByText('Una línea tiene algo sin resolver')).toHaveCount(0);
      await expect(submit).toBeEnabled();

      // ---------------------------------------------------------------------
      // 6. Quitar la otra fila: el resumen baja la cuenta.
      // ---------------------------------------------------------------------
      await goodRow.getByRole('button', { name: 'Quitar' }).click();
      await expect(goodRow.getByText('Fila quitada de la importación.')).toBeVisible();
      await expect(
        page.getByText('Se crearán 1 cotizaciones en borrador con 1 líneas.'),
      ).toBeVisible();
      await expect(submit).toBeEnabled();

      // ---------------------------------------------------------------------
      // 7. Enviar: toast, aviso con los códigos y una sola cotización creada.
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
      };
      expect(result).toMatchObject({ quotations: 1, rows: 1 });

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

  /**
   * **Defecto abierto de la pantalla, no del test.**
   *
   * `importar-view.tsx` carga los clientes con `/customers?pageSize=500` y el API topa
   * `pageSize` en 200 (`paginationQuerySchema`, D-113): la consulta responde
   * `400 {"errors":{"pageSize":["Number must be less than or equal to 200"]}}`, la lista
   * queda vacía y el desplegable de cliente **nunca** tiene una opción que elegir.
   *
   * Consecuencia: la única salida que la pantalla ofrece para una fila cuyo cliente no
   * resolvió —elegirlo a mano— está muerta, y hay que quitar la fila. Además, una fila que
   * sí resolvió muestra igual "Elige el cliente", porque un `<select>` no puede seleccionar
   * un id cuya opción no existe. (Eso último es solo cosmético: lo que se envía sale del
   * estado, no del `<select>`, así que el importado no se corrompe.)
   *
   * Queda en `fixme` en vez de borrado para que el día que se arregle el caso ya esté
   * escrito: sacar el `.fixme` y correrlo.
   */
  test.fixme('el desplegable de cliente lista el maestro, así una fila sin cliente se puede corregir a mano', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    try {
      const customer = await createCustomer(api);
      const product = await createCatalogProduct(api, {
        source: 'PURCHASED',
        name: PRODUCT_NAME,
      });
      const csv = csvOf([
        {
          issueDate: '03/08/2026',
          docType: 'Factura',
          documentKey: `FFA1-${randomLetters(4)}`,
          // Un documento que no está en el maestro: la fila tiene que pedir el cliente.
          customer: '20999999999 - CLIENTE QUE NO EXISTE S.A.C.',
          sku: product.sku,
          productName: PRODUCT_NAME,
          unit: 'UNIDAD',
          qty: '10.000',
          netAmount: '1000.00',
        },
      ]);

      await loginAsAdmin(page);
      await page.goto('/cotizaciones/importar');
      await expect(page.getByRole('heading', { name: 'Importar cotizaciones' })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByLabel('Excel o CSV del sistema de facturación').setInputFiles({
        name: 'ventas-detalladas.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf8'),
      });
      await expect(page.getByText('1 filas leídas')).toBeVisible();

      const submit = page.getByRole('button', { name: 'Crear las cotizaciones' });
      await expect(submit).toBeDisabled();

      const select = page.getByLabel('Cliente de la fila 1');
      await select.selectOption({ label: `${customer.docNumber} — ${customer.name}` });
      await expect(select).toHaveValue(customer.id);
      await expect(submit).toBeEnabled();
    } finally {
      await api.dispose();
    }
  });
});
