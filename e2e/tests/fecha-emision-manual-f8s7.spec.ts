import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, postJson } from '../helpers/api';
import { apiAs } from '../helpers/production';
import {
  addPayment,
  annulImported,
  createInvoice,
  freeLine,
  getDocument,
  createInvoiceableCustomer,
  reversePayment,
  type FiscalDocumentDto,
} from '../helpers/invoicing';
import { isoDaysFromToday, type CustomerDto } from '../helpers/sales';

/**
 * F8-S7/M1 — corregir la fecha de emisión de un comprobante **manual** (D-211).
 *
 * El papel salió de la otra app con su fecha impresa y al tipearlo se puede errar. Hasta
 * esta sesión la fecha quedaba fija al crear el borrador y no había ninguna puerta para
 * corregirla. Lo que estos casos protegen:
 *
 * - **Solo un manual.** Un `ISSUED_HERE` mandó su fecha al PSE y la tiene en un CDR firmado:
 *   cambiarla acá la desalinearía de lo que SUNAT sabe, en silencio.
 * - **El vencimiento se corre los mismos días**, conservando el plazo pactado. Dejarlo
 *   quieto convierte una factura a 30 días en una a 25 sin que nadie lo pida, y eso sale
 *   después en un reporte de mora como si el cliente se hubiera atrasado. Y como es un
 *   efecto colateral, **sin confirmarlo no se toca nada**.
 * - **Solo ADMINISTRADOR**: toda llamada acá es una corrección de un hecho ya registrado.
 * - **La emisión no puede saltar por encima de un cobro ya registrado**: un cobro anterior
 *   a la emisión es una incoherencia que ningún otro camino del sistema sabe crear.
 * - **Queda historial en el propio comprobante**, no solo en `audit_log`: la fecha de un
 *   papel es un dato que el cliente coteja contra el documento físico.
 *
 * Los casos **no tocan el PSE**: un manual nace `ACCEPTED` sin salir a Nubefact (D-153), así
 * que la corrida no gasta cupo de la cuenta demo ni numeración del ERP.
 *
 * Todos escriben (comprobantes, cobros): nunca contra producción (regla dura 9, D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea comprobantes y cobros: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

/**
 * El historial de correcciones (D-211). Vive acá y no en `helpers/invoicing.ts` porque es
 * lo único que este spec le agrega al DTO compartido: el resto de la suite no lo mira.
 */
interface IssueDateChangeDto {
  id: string;
  beforeIssueDate: string;
  afterIssueDate: string;
  beforeDueDate: string | null;
  afterDueDate: string | null;
  reason: string;
  changedByName: string | null;
  changedAt: string;
}

type DocumentWithChanges = FiscalDocumentDto & { issueDateChanges: IssueDateChangeDto[] };

/** Serie del talonario de la otra app. `F9xx` para no chocar con ninguna serie del ERP. */
function manualSeries(): string {
  return `F9${String(Math.floor(Math.random() * 90) + 10)}`;
}

function manualCorrelative(): number {
  return Math.floor(Math.random() * 90_000) + 1_000;
}

/**
 * `YYYY-MM-DD` corrido `days` días. Negativo va al pasado.
 *
 * Mismo criterio que `isoDaysFromToday` (D-112): se parte del **mediodía** UTC y se lee con
 * el formateador de Lima. A medianoche UTC son las 19:00 del día anterior en Lima, así que
 * desplazar desde ahí corre el resultado un día.
 */
function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Días de calendario entre dos fechas `YYYY-MM-DD` (el plazo de crédito, en días). */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}

/** Fecha de negocio de hace `days` días, en Lima. */
function daysAgo(days: number): string {
  return isoDaysFromToday(-days);
}

interface ManualInvoiceInput {
  customerId: string;
  issueDate: string;
  paymentTerms?: 'CONTADO' | 'CREDITO';
  dueDate?: string;
}

/**
 * Factura manual lista para corregir: borrador con líneas libres y el número del papel.
 *
 * Es el escenario **mínimo** que ejercita D-211: la corrección de fecha no mira el pedido
 * ni el despacho, así que armar bobina, compra y reserva solo agregaría ruido y minutos.
 */
async function manualInvoice(
  api: APIRequestContext,
  input: ManualInvoiceInput,
): Promise<FiscalDocumentDto> {
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: input.customerId,
    issueDate: input.issueDate,
    paymentTerms: input.paymentTerms ?? 'CONTADO',
    ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
    items: [freeLine('2', '50.00', 'corrección de fecha')],
  });
  expect(draft.status).toBe('DRAFT');
  expect(draft.origin).toBe('ISSUED_HERE');
  const registered = await postJson<FiscalDocumentDto>(
    api,
    `/api/invoicing/documents/${draft.id}/register-manual`,
    { series: manualSeries(), correlative: manualCorrelative() },
  );
  expect(registered.origin).toBe('MANUAL');
  expect(registered.status).toBe('ACCEPTED');
  return registered;
}

interface IssueDateBody {
  issueDate: string;
  reason: string;
  confirmDueDateShift?: boolean;
}

async function patchIssueDate(
  api: APIRequestContext,
  id: string,
  body: IssueDateBody,
): Promise<{ status: number; message: string; document: DocumentWithChanges | null }> {
  const res = await api.patch(`/api/invoicing/documents/${id}/issue-date`, { data: body });
  const parsed = (await res.json()) as { message?: string | string[] } & DocumentWithChanges;
  const message = Array.isArray(parsed.message)
    ? parsed.message.join(', ')
    : (parsed.message ?? '');
  return {
    status: res.status(),
    message,
    document: res.ok() ? parsed : null,
  };
}

/**
 * Deshace lo que el caso dejó vivo **sin gastar PSE**: revierte los cobros y anula el
 * manual por dentro (D-153/D-110), que es su reversa propia. `purgeInvoicingTrail` no sirve
 * acá: intentaría la baja ante SUNAT —que un manual no admite— y caería en emitir una nota
 * de crédito real contra la cuenta demo de Nubefact por cada comprobante del archivo.
 * Nunca lanza: es limpieza de `finally`.
 */
async function cleanupDocuments(api: APIRequestContext, ids: string[]): Promise<void> {
  const reason = 'Limpieza de prueba E2E';
  for (const id of ids) {
    const document = await api
      .get(`/api/invoicing/documents/${id}`)
      .then((r) => (r.ok() ? (r.json() as Promise<FiscalDocumentDto>) : null))
      .catch(() => null);
    if (!document) continue;
    for (const payment of document.payments.filter((p) => p.reversedAt === null)) {
      await reversePayment(api, id, payment.id, reason).catch(() => undefined);
    }
    if (document.status === 'DRAFT') {
      await api.delete(`/api/invoicing/documents/${id}`).catch(() => undefined);
      continue;
    }
    await annulImported(api, id, reason).catch(() => undefined);
  }
}

test.describe('D-211 — corrección de la fecha de emisión de un comprobante manual', () => {
  let api: APIRequestContext;
  let customer: CustomerDto;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    customer = await createInvoiceableCustomer(api);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('corregir la fecha de un manual la cambia y deja el cambio en el historial del comprobante', async () => {
    const issueDate = daysAgo(5);
    const corrected = daysAgo(3);
    const trail: string[] = [];

    try {
      const manual = await manualInvoice(api, { customerId: customer.id, issueDate });
      trail.push(manual.id);
      expect(manual.issueDate).toBe(issueDate);

      const reason = 'El papel dice otra fecha (prueba E2E)';
      const result = await patchIssueDate(api, manual.id, { issueDate: corrected, reason });
      expect(result.status, result.message).toBe(200);
      expect(result.document?.issueDate).toBe(corrected);

      // El detalle es lo que mira quien coteja contra el papel: la fecha nueva **y** de
      // dónde vino. Un cambio que solo viviera en `audit_log` no lo respondería.
      const detail = (await getDocument(api, manual.id)) as DocumentWithChanges;
      expect(detail.issueDate).toBe(corrected);
      expect(detail.issueDateChanges).toHaveLength(1);
      expect(detail.issueDateChanges[0]).toMatchObject({
        beforeIssueDate: issueDate,
        afterIssueDate: corrected,
        reason,
      });
      // Quién la corrigió: sin nombre el historial no sirve para lo único que existe.
      expect(detail.issueDateChanges[0]!.changedByName).not.toBeNull();

      // Al contado no hay vencimiento que correr, y el historial lo dice en vez de inventar uno.
      expect(detail.dueDate).toBeNull();
      expect(detail.issueDateChanges[0]!.beforeDueDate).toBeNull();
      expect(detail.issueDateChanges[0]!.afterDueDate).toBeNull();

      // Lo que la corrección **no** toca: el número del papel y el saldo siguen intactos.
      expect(detail.number).toBe(manual.number);
      expect(detail.status).toBe('ACCEPTED');
      expect(detail.balancePen).toBe(manual.balancePen);
    } finally {
      await cleanupDocuments(api, trail);
    }
  });

  test('un comprobante a crédito no se corrige sin confirmar el corrimiento del vencimiento', async () => {
    const issueDate = daysAgo(20);
    const dueDate = shiftDays(issueDate, 30);
    const trail: string[] = [];

    try {
      const manual = await manualInvoice(api, {
        customerId: customer.id,
        issueDate,
        paymentTerms: 'CREDITO',
        dueDate,
      });
      trail.push(manual.id);
      expect(manual.dueDate).toBe(dueDate);

      const target = daysAgo(25);
      const refused = await patchIssueDate(api, manual.id, {
        issueDate: target,
        reason: 'Corrección sin confirmar (prueba E2E)',
      });
      expect(refused.status).toBe(409);
      // El mensaje tiene que decir **a dónde** se mueve el vencimiento: es lo que la pantalla
      // muestra antes de pedir la confirmación, y un 409 sin el dato no se puede confirmar.
      expect(refused.message).toContain(shiftDays(dueDate, -5));

      // Y no dejó nada a medias: ni la emisión, ni el vencimiento, ni una fila de historial.
      const detail = (await getDocument(api, manual.id)) as DocumentWithChanges;
      expect(detail.issueDate).toBe(issueDate);
      expect(detail.dueDate).toBe(dueDate);
      expect(detail.issueDateChanges).toHaveLength(0);
    } finally {
      await cleanupDocuments(api, trail);
    }
  });

  test('confirmado el corrimiento, el vencimiento se mueve los mismos días y el plazo se conserva', async () => {
    const issueDate = daysAgo(20);
    const dueDate = shiftDays(issueDate, 30);
    const trail: string[] = [];

    try {
      const manual = await manualInvoice(api, {
        customerId: customer.id,
        issueDate,
        paymentTerms: 'CREDITO',
        dueDate,
      });
      trail.push(manual.id);

      const target = daysAgo(27);
      const result = await patchIssueDate(api, manual.id, {
        issueDate: target,
        reason: 'El papel está fechado una semana antes (prueba E2E)',
        confirmDueDateShift: true,
      });
      expect(result.status, result.message).toBe(200);

      const expectedDue = shiftDays(dueDate, -7);
      expect(result.document?.issueDate).toBe(target);
      expect(result.document?.dueDate).toBe(expectedDue);

      // **Lo que de verdad protege este caso**: el plazo pactado no cambió. Mover la emisión
      // y dejar el vencimiento quieto convertiría una factura a 30 días en una a 23, y el
      // cliente aparecería en mora una semana antes sin que nadie lo haya decidido.
      expect(daysBetween(target, expectedDue)).toBe(daysBetween(issueDate, dueDate));

      const detail = (await getDocument(api, manual.id)) as DocumentWithChanges;
      expect(detail.dueDate).toBe(expectedDue);
      expect(detail.issueDateChanges[0]).toMatchObject({
        beforeIssueDate: issueDate,
        afterIssueDate: target,
        beforeDueDate: dueDate,
        afterDueDate: expectedDue,
      });
    } finally {
      await cleanupDocuments(api, trail);
    }
  });

  test('un comprobante que no es manual no admite corrección: su fecha viajó al PSE', async () => {
    const issueDate = daysAgo(4);
    const trail: string[] = [];

    try {
      // Un borrador del ERP ya es `ISSUED_HERE`, que es exactamente el origen que la guarda
      // rechaza. Se prueba sobre el borrador y no sobre uno emitido a propósito: emitir
      // gastaría un correlativo de una serie real y un comprobante de la cuenta demo del PSE
      // para ejercitar la **misma** línea, que corta por `origin` antes que por cualquier otra
      // cosa.
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        issueDate,
        items: [freeLine('1', '30.00', 'electrónico')],
      });
      trail.push(draft.id);
      expect(draft.origin).toBe('ISSUED_HERE');

      const refused = await patchIssueDate(api, draft.id, {
        issueDate: daysAgo(2),
        reason: 'Intento sobre un electrónico (prueba E2E)',
      });
      expect(refused.status).toBe(409);
      expect(refused.message).toContain('manual');

      // El rechazo no lo movió: la fecha sigue siendo la que se tipeó al crearlo.
      expect((await getDocument(api, draft.id)).issueDate).toBe(issueDate);
    } finally {
      await cleanupDocuments(api, trail);
    }
  });

  test('un VENDEDOR no puede corregir la fecha de emisión: es de ADMINISTRADOR', async ({
    baseURL,
  }) => {
    const issueDate = daysAgo(6);
    const trail: string[] = [];
    let seller: APIRequestContext | null = null;

    try {
      const manual = await manualInvoice(api, { customerId: customer.id, issueDate });
      trail.push(manual.id);

      seller = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
      const refused = await seller.patch(`/api/invoicing/documents/${manual.id}/issue-date`, {
        data: { issueDate: daysAgo(3), reason: 'Intento de un vendedor (prueba E2E)' },
      });
      expect(refused.status()).toBe(403);

      // Y la puerta cerrada no dejó rastro en el comprobante.
      const detail = (await getDocument(api, manual.id)) as DocumentWithChanges;
      expect(detail.issueDate).toBe(issueDate);
      expect(detail.issueDateChanges).toHaveLength(0);
    } finally {
      await seller?.dispose();
      await cleanupDocuments(api, trail);
    }
  });

  test('la emisión no puede quedar después de un cobro ya registrado', async () => {
    const issueDate = daysAgo(30);
    const paymentDate = daysAgo(25);
    const trail: string[] = [];

    try {
      const manual = await manualInvoice(api, { customerId: customer.id, issueDate });
      trail.push(manual.id);

      const paid = await addPayment(api, manual.id, { amountPen: '10.00', date: paymentDate });
      expect(paid.payments).toHaveLength(1);
      expect(paid.payments[0]!.date).toBe(paymentDate);

      // Mover la emisión al 20 dejaría un cobro del 25 **antes** de que el comprobante
      // existiera: una incoherencia que ningún otro camino del sistema sabe crear, así que
      // este tampoco.
      const refused = await patchIssueDate(api, manual.id, {
        issueDate: daysAgo(20),
        reason: 'Corrección por encima de un cobro (prueba E2E)',
      });
      expect(refused.status).toBe(409);
      expect(refused.message).toContain(paymentDate);

      const detail = (await getDocument(api, manual.id)) as DocumentWithChanges;
      expect(detail.issueDate).toBe(issueDate);
      expect(detail.issueDateChanges).toHaveLength(0);

      // La otra dirección **sí** entra: hacia atrás el cobro sigue siendo posterior a la
      // emisión, que es la única condición que la regla pide.
      const earlier = daysAgo(28);
      const accepted = await patchIssueDate(api, manual.id, {
        issueDate: earlier,
        reason: 'Corrección hacia atrás (prueba E2E)',
      });
      expect(accepted.status, accepted.message).toBe(200);
      expect(accepted.document?.issueDate).toBe(earlier);
    } finally {
      await cleanupDocuments(api, trail);
    }
  });
});
