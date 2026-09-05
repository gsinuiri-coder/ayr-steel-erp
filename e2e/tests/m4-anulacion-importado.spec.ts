import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, createUser, getJson, type CreatedUser } from '../helpers/api';
import {
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  addPayment,
  getDocument,
  reversePayment,
} from '../helpers/invoicing';
import {
  annulImported,
  annulImportedTrail,
  importCorrelative,
  importDocument,
  importSeriesCode,
} from '../helpers/imports';
import { createCustomer, type CustomerDto } from '../helpers/sales';
import { loginAndSetPassword } from '../helpers/ui';

/**
 * Sesión M-4 — anulación **interna** de un comprobante importado (D-110).
 *
 * Lo que estos tests protegen, en una línea: **un importado que no debió entrar tiene vuelta,
 * y la vuelta no le miente a nadie**. Hasta acá un `fiscal_document` con `origin = IMPORTED`
 * nacía `ACCEPTED` con su cuenta por cobrar y no tenía ningún camino de regreso —el PSE no lo
 * conoce como nuestro (D-105), así que ni la baja ni la nota de crédito lo alcanzaban—, o sea
 * deuda falsa permanente.
 *
 * Por eso cada aserción se hace sobre **lo de siempre** —el saldo, el listado con saldo, las
 * cuentas por cobrar— y no sobre nada propio de la anulación: lo que importa no es que la fila
 * cambie de estado, sino que deje de deber en los tres lugares donde se lee una deuda. Y el
 * estado es `ANNULLED` y no `VOIDED` a propósito: `VOIDED` afirmaría ante una auditoría que
 * SUNAT aceptó una baja que nunca ocurrió.
 *
 * **La suite entera se salta cuando no se puede gastar numeración fiscal**, igual que las dos
 * de la Fase 7c: para anular un importado hay que importarlo primero, y eso empuja el
 * correlativo de una serie real (D-106) aunque nunca se emita contra el PSE.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
const fiscalEmission = fiscalEmissionAllowed();

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';
/** Contraseña definitiva de los usuarios efímeros que solo se usan por API. */
const ROLE_PASSWORD = 'ClaveRolE2E-2026';

/** Lo que el listado devuelve por comprobante; la lista no trae líneas ni cobros. */
interface DocumentListItem {
  id: string;
  number: string | null;
  status: string;
  origin: 'ISSUED_HERE' | 'IMPORTED';
  totalPen: string;
  balancePen: string;
  archivedAt: string | null;
  supersedesDocumentId: string | null;
  supersededByDocumentId: string | null;
}

/** Cuentas por cobrar agregadas por cliente (RF-88). */
interface ReceivableSummary {
  customerId: string;
  customerName: string;
  documentCount: number;
  balancePen: string;
  overduePen: string;
}

/** El saldo que las cuentas por cobrar le atribuyen a un cliente; `0.0000` si ya no aparece. */
async function receivableOf(
  api: APIRequestContext,
  customerId: string,
): Promise<ReceivableSummary> {
  const all = await getJson<ReceivableSummary[]>(api, '/api/invoicing/receivables');
  return (
    all.find((r) => r.customerId === customerId) ?? {
      customerId,
      customerName: '',
      documentCount: 0,
      balancePen: '0.0000',
      overduePen: '0.0000',
    }
  );
}

/**
 * El día **de Lima** de un instante, en `AAAA-MM-DD`. Misma cuenta que `businessToday` del
 * API y que `formatTimestampDate` del web: la fecha de negocio no es la de UTC, y cortar el
 * ISO en el décimo carácter adelanta un día todo lo que pase después de las 19:00 locales.
 */
function limaDayOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Los comprobantes con saldo (`pendingOnly`) que coinciden con un número. */
async function pendingByNumber(
  api: APIRequestContext,
  number: string,
): Promise<DocumentListItem[]> {
  return getJson<DocumentListItem[]>(
    api,
    `/api/invoicing/documents?pendingOnly=true&search=${number}`,
  );
}

/** Los comprobantes vivos (sin archivados) con ese número exacto. */
async function documentsByNumber(
  api: APIRequestContext,
  number: string,
): Promise<DocumentListItem[]> {
  const all = await getJson<DocumentListItem[]>(api, `/api/invoicing/documents?search=${number}`);
  return all.filter((d) => d.number === number);
}

/**
 * Contexto de API autenticado como un usuario recién creado. El primer ingreso obliga a
 * cambiar la contraseña temporal (RF-01); la sesión actual sobrevive al cambio. Mismo patrón
 * que `m2-reversa-pago.spec.ts`, que es donde se probó el otro guardrail de rol.
 */
async function apiAs(baseURL: string, user: CreatedUser): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL });
  const login = await api.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  if (!login.ok()) {
    throw new Error(`Login de ${user.role} falló: ${login.status()} ${await login.text()}`);
  }
  const changed = await api.post('/api/auth/change-password', {
    data: {
      currentPassword: user.password,
      newPassword: ROLE_PASSWORD,
      confirmPassword: ROLE_PASSWORD,
    },
  });
  if (!changed.ok()) {
    throw new Error(
      `Cambio de contraseña de ${user.role} falló: ${changed.status()} ${await changed.text()}`,
    );
  }
  return api;
}

/**
 * Ingreso por la UI de un usuario que **ya** cambió su contraseña temporal. `apiAs` la cambia
 * por API para poder crear el contexto, así que `loginAndSetPassword` ya no aplica: el
 * segundo ingreso va derecho al inicio y esperar el redirect a /cambiar-contrasena colgaría.
 */
async function loginUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Anula por la UI el importado abierto en pantalla, con su motivo. */
async function annulFromUi(page: Page, number: string, reason: string): Promise<void> {
  await page.getByRole('button', { name: 'Anular internamente' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: `Anular ${number} internamente` }),
  ).toBeVisible();
  // El diálogo dice lo que la operación **no** hace, que es la mitad que se malinterpreta.
  await expect(dialog).toContainText('no comunica ninguna baja');
  await dialog.getByLabel('Motivo').fill(reason);
  // El botón del diálogo y el de la pantalla se llaman igual: sin acotar al diálogo, el
  // locator encuentra dos y el test falla por ambigüedad, no por un defecto.
  await dialog.getByRole('button', { name: 'Anular internamente' }).click();
  await expect(page.getByText('Comprobante importado anulado')).toBeVisible();
}

test.describe.configure({ timeout: 240_000 });

test.describe('Sesión M-4 — anulación interna de un comprobante importado', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );
  test.skip(
    !fiscalEmission,
    `${FISCAL_EMISSION_REASON} Para anular un importado hay que importarlo primero, y eso hace ` +
      'el mismo daño sin llegar a emitir: empuja el correlativo de la serie (D-106) y crea la ' +
      'serie que no exista. La anulación limpia el saldo, pero no devuelve la numeración.',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('una factura importada se anula por la UI, su saldo pasa a cero y el número queda libre para reimportar (D-110)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR', { name: 'Admin M4 Ciclo' });
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const created: string[] = [];

    try {
      // 2 × 100 + 3 × 50 = 350 de subtotal, 63 de IGV, 413.00 de total.
      const imported = await importDocument(api, {
        series,
        correlative,
        customerDocNumber: customer.docNumber,
        totalPen: '413.00',
        lines: [
          { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
          { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
        ],
      });
      created.push(imported.documentId);

      // Antes de anular es deuda: aparece en el listado con saldo, que es lo que hace útil
      // importar y —cuando el papel no debía entrar— lo que la anulación tiene que borrar.
      expect((await pendingByNumber(api, imported.number)).map((d) => d.id)).toContain(
        imported.documentId,
      );

      await page.goto(`/comprobantes/${imported.documentId}`);
      await expect(page.getByRole('heading', { name: imported.number })).toBeVisible();
      await expect(page.getByText('Aceptado', { exact: true })).toBeVisible();
      await expect(page.getByText('S/ 413.00').first()).toBeVisible();

      const reason = 'Se importó por error: el papel era de otro cliente';
      await annulFromUi(page, imported.number, reason);

      // El badge cambia de verbo: «Anulado internamente» y no «Anulado ante SUNAT», porque
      // SUNAT no se enteró de nada. La diferencia es el punto entero de D-110.
      await expect(page.getByText('Anulado internamente', { exact: true })).toBeVisible();
      await expect(page.getByText('Anulado ante SUNAT')).toHaveCount(0);
      // Y el saldo, que es la mitad que hace útil a la anulación.
      await expect(page.getByText('S/ 0.00').first()).toBeVisible();
      // Ya no se ofrece anular de nuevo ni cobrar algo que no debe nada.
      await expect(page.getByRole('button', { name: 'Anular internamente' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Registrar cobro' })).toHaveCount(0);

      const annulled = await getDocument(api, imported.documentId);
      expect(annulled.status).toBe('ANNULLED');
      expect(annulled.balancePen).toBe('0.0000');
      // El total no se toca: el papel decía lo que decía. Lo que desaparece es la deuda.
      expect(annulled.totalPen).toBe('413.0000');
      expect(annulled.annulReason).toBe(reason);
      expect(annulled.annulledByName).toBe('Admin M4 Ciclo');
      expect(annulled.annulledAt).not.toBeNull();

      // La constancia en pantalla: quién, cuándo y por qué. El día se calcula **en Lima** a
      // partir del instante que devuelve el API, no cortando el ISO en el décimo carácter:
      // ese corte es UTC y Lima va cinco horas detrás, así que una anulación de las 20:00
      // salía fechada al día siguiente. La primera corrida de esta suite encontró ahí un
      // defecto de la pantalla (D-069, arreglado con `formatTimestampDate`), y comparar
      // contra la fecha de Lima es lo que hace que el test lo vuelva a ver si reaparece.
      const [y, m, dd] = limaDayOf(annulled.annulledAt!).split('-');
      await expect(
        page.getByText(`Anulado internamente el ${dd}/${m}/${y} por Admin M4 Ciclo — ${reason}`),
      ).toBeVisible();

      // Y el número vuelve a estar disponible: reimportar el mismo comprobante archiva la
      // versión anulada y deja la nueva vigente, debiendo lo suyo. Sin esto, anular habría
      // dejado el número inutilizable, que es media solución.
      const reimported = await importDocument(api, {
        series,
        correlative,
        customerDocNumber: customer.docNumber,
        totalPen: '590.00',
        lines: [{ description: 'E2E plancha corregida', qty: '1', unitPricePen: '500.00' }],
      });
      created.push(reimported.documentId);
      expect(reimported.documentId).not.toBe(imported.documentId);

      const live = await documentsByNumber(api, imported.number);
      expect(live, 'con ese número queda una sola fila viva').toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: reimported.documentId,
        status: 'ACCEPTED',
        origin: 'IMPORTED',
        totalPen: '590.0000',
        balancePen: '590.0000',
        supersedesDocumentId: imported.documentId,
      });

      // La anulada no se borró ni se "desanuló" al archivarse: sigue siendo el papel que
      // alguien anuló, ahora además fuera del listado.
      const archived = await getDocument(api, imported.documentId);
      expect(archived.status).toBe('ANNULLED');
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.supersededByDocumentId).toBe(reimported.documentId);
      expect(archived.annulReason).toBe(reason);
    } finally {
      await annulImportedTrail(api, created);
    }
  });

  test('un importado con un cobro vigente no se anula hasta que el cobro se revierte (D-110)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR', { name: 'Admin M4 Cobro' });
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const customer = await createCustomer(api);
    const created: string[] = [];

    try {
      const imported = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        lines: [{ description: 'E2E línea importada', qty: '1', unitPricePen: '100.00' }],
      });
      created.push(imported.documentId);

      const paid = await addPayment(api, imported.documentId, { amountPen: '118.00' });
      expect(paid.balancePen).toBe('0.0000');
      const paymentId = paid.payments[0]!.id;

      // Anular con el cobro en pie dejaría dinero recibido sin causa. El API lo corta, y no
      // depende de que la pantalla esconda el botón.
      const blocked = await annulImported(api, imported.documentId, 'Intento con cobro vigente');
      expect(blocked.status()).toBe(400);
      expect(await blocked.text()).toContain(
        'El comprobante tiene cobros vigentes: revierte los cobros antes de anularlo',
      );

      // La pantalla tampoco lo ofrece. (Lo que sí falta es **decir por qué**: el aviso que
      // explica el bloqueo está condicionado a `voidPath === 'VOID'`, que en un importado
      // siempre es null, así que sobre un importado con cobro no se muestra nada. Reportado
      // como defecto de la app; el test no lo tapa ni lo da por bueno.)
      await page.goto(`/comprobantes/${imported.documentId}`);
      await expect(page.getByRole('heading', { name: imported.number })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Anular internamente' })).toHaveCount(0);

      // Nada de eso lo movió.
      const untouched = await getDocument(api, imported.documentId);
      expect(untouched.status).toBe('ACCEPTED');
      expect(untouched.annulledAt).toBeNull();

      // Revertido el cobro, el camino se abre: el botón aparece y la anulación procede.
      const reversed = await reversePayment(
        api,
        imported.documentId,
        paymentId,
        'Reversa para poder anular (prueba E2E)',
      );
      expect(reversed.balancePen).toBe('118.0000');

      await page.reload();
      await annulFromUi(page, imported.number, 'Cobro revertido: el comprobante no debió entrar');
      await expect(page.getByText('Anulado internamente', { exact: true })).toBeVisible();

      const annulled = await getDocument(api, imported.documentId);
      expect(annulled.status).toBe('ANNULLED');
      expect(annulled.balancePen).toBe('0.0000');
      // El cobro revertido sigue en la fila: revertir no borra (RF-87, el patrón de M-2).
      expect(annulled.payments).toHaveLength(1);
      expect(annulled.payments[0]?.reversedAt).not.toBeNull();
    } finally {
      await annulImportedTrail(api, created);
    }
  });

  test('un importado anulado deja de sumar en cuentas por cobrar, en el listado con saldo y en su propio balance (RF-88)', async () => {
    // Cliente nuevo y solo suyos los dos comprobantes: así el total de cuentas por cobrar
    // del cliente es exactamente la suma de este test y la resta se puede leer sin ruido.
    const customer: CustomerDto = await createCustomer(api);
    const created: string[] = [];

    try {
      const wrong = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '413.00',
        lines: [
          { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
          { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
        ],
      });
      created.push(wrong.documentId);
      const good = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        lines: [{ description: 'E2E línea correcta', qty: '1', unitPricePen: '100.00' }],
      });
      created.push(good.documentId);

      const before = await receivableOf(api, customer.id);
      expect(before.documentCount).toBe(2);
      expect(before.balancePen).toBe('531.0000');

      const annulled = await annulImported(api, wrong.documentId, 'No correspondía a este cliente');
      expect(annulled.status()).toBe(201);

      // 1. Cuentas por cobrar: el total del cliente baja **exactamente** el importe anulado.
      const after = await receivableOf(api, customer.id);
      expect(after.documentCount).toBe(1);
      expect(after.balancePen).toBe('118.0000');
      expect(Number(before.balancePen) - Number(after.balancePen)).toBeCloseTo(413, 4);

      // 2. El listado con saldo: el anulado sale, el otro se queda.
      expect((await pendingByNumber(api, wrong.number)).map((d) => d.id)).not.toContain(
        wrong.documentId,
      );
      expect((await pendingByNumber(api, good.number)).map((d) => d.id)).toContain(good.documentId);

      // 3. Su propio balance. No está archivado —sigue en el listado general con su estado—,
      //    así que el cero tiene que venir del estado y no de haber desaparecido.
      const document = await getDocument(api, wrong.documentId);
      expect(document.balancePen).toBe('0.0000');
      expect(document.archivedAt).toBeNull();
      const listed = await documentsByNumber(api, wrong.number);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ status: 'ANNULLED', balancePen: '0.0000' });
    } finally {
      await annulImportedTrail(api, created);
    }
  });

  test('la anulación interna no alcanza a un comprobante que emitió el ERP (D-110)', async () => {
    // Montar el caso desde cero exigiría **emitir** de verdad, que gasta un correlativo de una
    // serie real y, sin PSE, deja un documento sin estado terminal (D-072). Se reusa uno que ya
    // exista en la base, igual que `fase7c-bordes.spec.ts`; si no hay ninguno, se salta.
    const emitted = (
      await getJson<DocumentListItem[]>(api, '/api/invoicing/documents?origin=ISSUED_HERE')
    ).filter((d) => d.number !== null);
    test.skip(
      emitted.length === 0,
      'No hay ningún comprobante emitido por el ERP en esta base, y montar uno exigiría emitir ' +
        'de verdad: eso gasta un correlativo de una serie real y, sin PSE, deja un documento ' +
        'que no se puede llevar a ningún estado terminal (D-072).',
    );

    const target = emitted[0]!;
    const before = await getDocument(api, target.id);

    const refused = await annulImported(
      api,
      target.id,
      'Intento de anulación interna sobre un emitido (prueba E2E)',
    );
    expect(refused.status()).toBe(400);
    // El motivo, no solo el rechazo: su camino es el fiscal, y el mensaje tiene que decirlo.
    expect(await refused.text()).toContain(
      'Este comprobante lo emitió el ERP: se deshace con una baja o una nota de crédito ante SUNAT, no con una anulación interna',
    );

    // Y no lo movió: ni el estado, ni la constancia de anulación, ni el saldo.
    const after = await getDocument(api, target.id);
    expect(after.status).toBe(before.status);
    expect(after.origin).toBe('ISSUED_HERE');
    expect(after.annulledAt).toBeNull();
    expect(after.annulReason).toBeNull();
    expect(after.balancePen).toBe(before.balancePen);
  });

  test('anular dos veces el mismo importado devuelve 409 la segunda (D-052)', async () => {
    const customer = await createCustomer(api);
    const created: string[] = [];

    try {
      const imported = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        lines: [{ description: 'E2E línea importada', qty: '1', unitPricePen: '100.00' }],
      });
      created.push(imported.documentId);

      const first = await annulImported(api, imported.documentId, 'Primera anulación');
      expect(first.status()).toBe(201);

      // 409 y no 400: lo que impide la operación es el estado del recurso, y el segundo
      // intento no vuelve a anular ni finge que hizo algo.
      const second = await annulImported(api, imported.documentId, 'Segunda anulación');
      expect(second.status()).toBe(409);
      expect(await second.text()).toContain(`El comprobante ${imported.number} ya está anulado`);

      // El motivo sigue siendo el de la primera: el segundo intento no pisó la constancia.
      const document = await getDocument(api, imported.documentId);
      expect(document.annulReason).toBe('Primera anulación');
      expect(document.status).toBe('ANNULLED');
    } finally {
      await annulImportedTrail(api, created);
    }
  });

  test('un vendedor no ve el botón de anular y el API le responde 403 (RF-02)', async ({
    page,
    baseURL,
  }) => {
    const customer = await createCustomer(api);
    const created: string[] = [];
    let sellerApi: APIRequestContext | null = null;

    try {
      const imported = await importDocument(api, {
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        lines: [{ description: 'E2E línea importada', qty: '1', unitPricePen: '100.00' }],
      });
      created.push(imported.documentId);

      const seller = await createUser(api, 'VENDEDOR', { name: 'Vendedor M4' });
      sellerApi = await apiAs(baseURL!, seller);

      const refused = await annulImported(
        sellerApi,
        imported.documentId,
        'Intento de un vendedor (prueba E2E)',
      );
      expect(refused.status()).toBe(403);

      // La pantalla del vendedor: ve el comprobante —cobrar es parte de su trabajo— pero no
      // el botón. El heading confirma que la ausencia es del botón y no de la página entera.
      await loginUi(page, seller.email, ROLE_PASSWORD);
      await page.goto(`/comprobantes/${imported.documentId}`);
      await expect(page.getByRole('heading', { name: imported.number })).toBeVisible();
      await expect(page.getByText('Importado', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Anular internamente' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Registrar cobro' })).toBeVisible();

      // Y nada de eso lo movió.
      const untouched = await getDocument(api, imported.documentId);
      expect(untouched.status).toBe('ACCEPTED');
      expect(untouched.annulledAt).toBeNull();
    } finally {
      await annulImportedTrail(api, created);
      await sellerApi?.dispose();
    }
  });
});
