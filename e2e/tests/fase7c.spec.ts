import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, createUser, getJson } from '../helpers/api';
import {
  createInvoiceableCustomer,
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  getDocument,
  listSeries,
} from '../helpers/invoicing';
import {
  documentNumber,
  fiscalDocumentRows,
  importCorrelative,
  importDocument,
  importSeriesCode,
  spreadsheetOf,
  today,
  type SheetRow,
} from '../helpers/imports';
import { createCustomer } from '../helpers/sales';
import { loginAndSetPassword } from '../helpers/ui';

/**
 * Fase 7c — importación de comprobantes **ya emitidos** (RF-71, RF-72; D-105..D-109).
 *
 * Lo que estos tests protegen, en una línea: **un comprobante importado es el mismo
 * comprobante de siempre, con un origen distinto y sin contraparte del otro lado** (D-105).
 * Por eso cada aserción se hace sobre lo de siempre —el listado, el saldo, el cobro, la
 * cuenta por cobrar— y no sobre nada propio del importador: si importar hubiera abierto una
 * tabla paralela, ninguna de estas comprobaciones cerraría.
 *
 * **La suite entera se salta cuando no se puede gastar numeración fiscal.** No emite contra
 * el PSE, pero hace el mismo daño que emitir: empuja el correlativo de la serie (D-106) —o
 * crea una serie nueva—, y deja un comprobante `ACCEPTED` que **no se puede dar de baja**
 * desde el ERP (D-105). Contra producción eso sería numeración quemada y una cuenta por
 * cobrar inventada que ninguna purga puede deshacer.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
const fiscalEmission = fiscalEmissionAllowed();

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

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
  itemCount: number;
}

async function documentsByNumber(
  api: APIRequestContext,
  number: string,
  options: { includeArchived?: boolean } = {},
): Promise<DocumentListItem[]> {
  const archived = options.includeArchived ? '&includeArchived=true' : '';
  const all = await getJson<DocumentListItem[]>(
    api,
    `/api/invoicing/documents?search=${number}${archived}`,
  );
  return all.filter((d) => d.number === number);
}

/** Abre el diálogo de importación de `/comprobantes` con la planilla ya cargada. */
async function openImportDialog(page: Page, rows: SheetRow[]) {
  await page.goto('/comprobantes');
  await expect(page.getByRole('heading', { name: 'Comprobantes' })).toBeVisible();
  await page.getByRole('button', { name: 'Importar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /Importar comprobantes/i })).toBeVisible();
  const file = spreadsheetOf(rows);
  await dialog.locator('input[type="file"]').setInputFiles(file);
  return dialog;
}

/** Busca un número en el listado y devuelve su fila. */
async function findListRow(page: Page, number: string) {
  await page.getByPlaceholder('Buscar por número, cliente o documento…').fill(number);
  const row = page.getByRole('row').filter({ hasText: number });
  await expect(row).toHaveCount(1);
  return row;
}

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7c — importación de comprobantes ya emitidos', () => {
  test.skip(
    !allowWrites,
    'Escrituras contra producción deshabilitadas: exporta E2E_ALLOW_WRITES=1',
  );
  test.skip(
    !fiscalEmission,
    `${FISCAL_EMISSION_REASON} Importar hace el mismo daño sin llegar a emitir: empuja el ` +
      'correlativo de la serie (D-106) y deja un comprobante aceptado que no se puede dar de ' +
      'baja desde el ERP (D-105), así que no hay forma de limpiarlo después.',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('una factura de dos líneas entra por planilla, nace aceptada y con su cuenta por cobrar (RF-71)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const number = documentNumber(series, correlative);

    // 2 × 100 = 200 y 3 × 50 = 150 → subtotal 350, IGV 63, total 413.00. El total lo
    // escribe la planilla: que las líneas lo sumen es justamente lo que el importador
    // comprueba, así que acá va tecleado y no calculado.
    const rows = fiscalDocumentRows({
      series,
      correlative,
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
        { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
      ],
    });

    const dialog = await openImportDialog(page, rows);

    // La previsualización: dos filas, ningún error, y el comprobante entero listo.
    await expect(dialog.getByText('2 de 2 líneas listas para confirmar.')).toBeVisible();
    await expect(dialog.getByText('Con errores')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Confirmar 2 líneas' }).click();
    await expect(page.getByText('2 de 2 líneas importadas')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toBeHidden();

    // En el listado: el número que decía la planilla, marcado como importado, aceptado, y
    // debiendo el total entero (todavía nadie lo cobró).
    const row = await findListRow(page, number);
    await expect(row).toContainText('Importado');
    await expect(row).toContainText('Aceptado');
    await expect(row).toContainText(customer.name);
    await expect(row.getByText('S/ 413.00')).toHaveCount(2);

    // Y por debajo: el comprobante es uno de verdad, con sus dos líneas y su saldo.
    const listed = await documentsByNumber(api, number);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      status: 'ACCEPTED',
      origin: 'IMPORTED',
      totalPen: '413.0000',
      balancePen: '413.0000',
      itemCount: 2,
      archivedAt: null,
      supersedesDocumentId: null,
    });

    const document = await getDocument(api, listed[0]!.id);
    expect(document.docType).toBe('FACTURA');
    expect(document.issueDate).toBe(today());
    expect(document.paymentTerms).toBe('CONTADO');
    // Al contado no hay vencimiento, y el importado no arrastra pedido ni despacho: entró
    // por planilla, no por una venta del ERP.
    expect(document.dueDate).toBeNull();
    expect(document.salesOrderId).toBeNull();
    expect(document.dispatchId).toBeNull();
    expect(document.subtotalPen).toBe('350.0000');
    expect(document.igvPen).toBe('63.0000');
    expect(document.items).toHaveLength(2);
    expect(document.items[0]).toMatchObject({
      lineNumber: 1,
      description: 'E2E plancha importada',
      qty: '2.000',
      unit: 'NIU',
      unitPricePen: '100.0000',
    });
    // El ERP no vio ninguna aceptación: no hay PDF, XML ni CDR que mostrar (D-105).
    expect(document.hasPdf || document.hasXml || document.hasCdr).toBe(false);
    expect(document.sendAttempts).toBe(0);

    // D-106: la serie del importado se crea **inactiva**, con el correlativo del papel. Así
    // importar histórico no habilita a emitir por una serie que nadie configuró.
    const created = (await listSeries(api)).find((s) => s.series === series);
    expect(created, 'el importador crea la serie que no existía').toBeDefined();
    expect(created).toMatchObject({ docType: 'FACTURA', isActive: false, correlative });
  });

  test('un comprobante importado se cobra como cualquier otro y su saldo baja a cero (RF-86)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const customer = await createCustomer(api);
    const imported = await importDocument(api, {
      series: importSeriesCode(),
      correlative: importCorrelative(),
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
        { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
      ],
    });

    // La cuenta por cobrar es lo que justifica importar: antes del cobro, el comprobante
    // aparece en "solo con saldo" como cualquier factura emitida acá.
    const pending = await getJson<DocumentListItem[]>(
      api,
      `/api/invoicing/documents?pendingOnly=true&search=${imported.number}`,
    );
    expect(pending.map((d) => d.id)).toContain(imported.documentId);

    await page.goto(`/comprobantes/${imported.documentId}`);
    await expect(page.getByRole('heading', { name: imported.number })).toBeVisible();
    await expect(page.getByText('Importado', { exact: true })).toBeVisible();
    await expect(page.getByText('S/ 413.00').first()).toBeVisible();

    await page.getByRole('button', { name: 'Registrar cobro' }).click();
    const dialog = page.getByRole('dialog');
    // El diálogo llega con el saldo pendiente ya escrito: se cobra el total.
    await expect(dialog).toContainText('El saldo pendiente es S/ 413.00');
    await dialog.getByRole('button', { name: 'Registrar cobro' }).click();
    await expect(page.getByText('Cobro registrado')).toBeVisible();
    await expect(page.getByText('S/ 0.00').first()).toBeVisible();

    const settled = await getDocument(api, imported.documentId);
    expect(settled.balancePen).toBe('0.0000');
    expect(settled.paidPen).toBe('413.0000');
    expect(settled.payments).toHaveLength(1);
    expect(settled.payments[0]?.reversedAt).toBeNull();
    expect(settled.status).toBe('ACCEPTED');

    // Ya no debe nada: sale de las cuentas por cobrar.
    const stillPending = await getJson<DocumentListItem[]>(
      api,
      `/api/invoicing/documents?pendingOnly=true&search=${imported.number}`,
    );
    expect(stillPending.map((d) => d.id)).not.toContain(imported.documentId);
  });

  test('una nota de crédito importada acredita a su factura importada y le baja el saldo (RF-71)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    // Cliente facturable reutilizado a propósito: la nota y su afectado tienen que ser del
    // mismo cliente, y así el escenario se lee igual que en las suites de 5b.
    const customer = await createInvoiceableCustomer(api);
    const invoice = await importDocument(api, {
      series: importSeriesCode(),
      correlative: importCorrelative(),
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
        { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
      ],
    });

    // La nota devuelve una de las dos planchas: 1 × 100 + IGV = 118.00.
    const note = await importDocument(api, {
      docType: 'NOTA_CREDITO',
      series: importSeriesCode(),
      correlative: importCorrelative(),
      customerDocNumber: customer.docNumber,
      totalPen: '118.00',
      affectedNumber: invoice.number,
      creditNoteReason: 'DEVOLUCION_ITEM',
      lines: [{ description: 'E2E devolución de una plancha', qty: '1', unitPricePen: '100.00' }],
    });

    const creditNote = await getDocument(api, note.documentId);
    expect(creditNote.docType).toBe('NOTA_CREDITO');
    expect(creditNote.origin).toBe('IMPORTED');
    expect(creditNote.status).toBe('ACCEPTED');
    expect(creditNote.affectedDocumentId).toBe(invoice.documentId);
    expect(creditNote.affectedDocumentNumber).toBe(invoice.number);
    expect(creditNote.totalPen).toBe('118.0000');

    // El afectado: la nota le baja el saldo sin tocar el total ni el estado. 413 − 118 = 295.
    const affected = await getDocument(api, invoice.documentId);
    expect(affected.totalPen).toBe('413.0000');
    expect(affected.creditedPen).toBe('118.0000');
    expect(affected.balancePen).toBe('295.0000');
    expect(affected.creditNotes.map((n) => n.id)).toContain(note.documentId);

    await page.goto(`/comprobantes/${invoice.documentId}`);
    await expect(page.getByRole('heading', { name: invoice.number })).toBeVisible();
    await expect(page.getByText('S/ 295.00')).toBeVisible();
    await expect(page.getByRole('link', { name: note.number })).toBeVisible();
  });

  test('reimportar el mismo número archiva la versión anterior en vez de pisarla (RF-72)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const customer = await createCustomer(api);
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const first = await importDocument(api, {
      series,
      correlative,
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { description: 'E2E plancha importada', qty: '2', unitPricePen: '100.00' },
        { description: 'E2E servicio importado', qty: '3', unitPricePen: '50.00' },
      ],
    });

    // La segunda versión del mismo papel: otras líneas y otro total. 1 × 500 + IGV = 590.00.
    const rows = fiscalDocumentRows({
      series,
      correlative,
      customerDocNumber: customer.docNumber,
      totalPen: '590.00',
      lines: [{ description: 'E2E plancha corregida', qty: '1', unitPricePen: '500.00' }],
    });
    const dialog = await openImportDialog(page, rows);

    // El aviso de RF-72: no es un error —la fila entra igual— pero hay que verlo antes de
    // confirmar, porque archiva algo que ya existe.
    await expect(
      dialog.getByText(`Reimportación: archiva la versión anterior de ${first.number}`),
    ).toBeVisible();
    await expect(dialog.getByText('Con errores')).toHaveCount(0);
    await expect(dialog.getByText('1 de 1 líneas listas para confirmar.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Confirmar 1 líneas' }).click();
    await expect(page.getByText('1 de 1 líneas importadas')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toBeHidden();

    // En el listado queda **una sola** fila con ese número, y es la nueva.
    const row = await findListRow(page, first.number);
    await expect(row).toContainText('S/ 590.00');
    await expect(row).toContainText('Importado');

    const live = await documentsByNumber(api, first.number);
    expect(live).toHaveLength(1);
    const current = live[0]!;
    expect(current.id).not.toBe(first.documentId);
    expect(current.totalPen).toBe('590.0000');
    expect(current.balancePen).toBe('590.0000');
    expect(current.supersedesDocumentId).toBe(first.documentId);

    // La anterior no se borró: quedó archivada, fuera del listado, con su historial.
    const archived = await getDocument(api, first.documentId);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.supersededByDocumentId).toBe(current.id);
    expect(archived.totalPen).toBe('413.0000');
    expect(archived.items).toHaveLength(2);

    const withArchived = await documentsByNumber(api, first.number, { includeArchived: true });
    expect(withArchived.map((d) => d.id).sort()).toEqual([current.id, first.documentId].sort());

    // Y se llega a ella desde el detalle de la vigente, que es el único camino (D-108).
    await page.goto(`/comprobantes/${current.id}`);
    await page.getByRole('link', { name: 'Ver la versión que reemplazó' }).click();
    await expect(page).toHaveURL(new RegExp(`/comprobantes/${first.documentId}$`));
    await expect(page.getByText('Versión archivada', { exact: true })).toBeVisible();
    // El saldo de una archivada se sigue calculando, pero ya no suma en cobranzas: sin esta
    // línea la cifra se lee como una deuda viva.
    await expect(page.getByText('Versión archivada: no cuenta en cobranzas')).toBeVisible();
    await expect(page.getByRole('link', { name: 'ver la versión vigente' })).toBeVisible();
  });
});
