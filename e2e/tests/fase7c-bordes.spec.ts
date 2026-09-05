import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createUser, getJson } from '../helpers/api';
import { fiscalEmissionAllowed, FISCAL_EMISSION_REASON, getDocument } from '../helpers/invoicing';
import {
  batchErrors,
  batchWarnings,
  csvOf,
  daysFromToday,
  documentNumber,
  fiscalDocumentRows,
  getImportBatch,
  importCorrelative,
  importDocument,
  importSeriesCode,
  patchImportRow,
  previewFiscalImport,
  rowStatuses,
  uploadImport,
} from '../helpers/imports';
import { createCustomer, type CustomerDto } from '../helpers/sales';
import { loginAndSetPassword } from '../helpers/ui';

/**
 * Fase 7c — bordes de la importación de comprobantes (RF-71, RF-72; D-105..D-109).
 *
 * Casi todos se quedan en la **previsualización**: suben la planilla, leen los errores y no
 * confirman nada, así que no crean ningún comprobante ni tocan numeración. La excepción es
 * el que prueba que un importado no se da de baja: para eso hace falta tener uno, y tenerlo
 * es exactamente lo que el test demuestra que no se puede deshacer.
 *
 * Por esa excepción —y porque cualquier confirmación acá empujaría numeración real— la
 * suite comparte la compuerta de `fase7c.spec.ts` y **se salta entera** donde no se puede
 * gastar numeración fiscal.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;
const fiscalEmission = fiscalEmissionAllowed();

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

interface DocumentListItem {
  id: string;
  number: string | null;
  docType: string;
  status: string;
  origin: 'ISSUED_HERE' | 'IMPORTED';
}

/** Un RUC bien formado que **no** está en el maestro: el que la planilla no debería tener. */
async function unknownDocNumber(api: APIRequestContext): Promise<string> {
  const customers = await getJson<CustomerDto[]>(api, '/api/customers');
  const known = new Set(customers.map((c) => c.docNumber));
  for (let i = 0; i < 50; i += 1) {
    const candidate = `20${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    if (!known.has(candidate)) return candidate;
  }
  throw new Error('No se pudo construir un RUC que no exista en el maestro');
}

test.describe.configure({ timeout: 240_000 });

test.describe('Fase 7c — bordes de la importación de comprobantes', () => {
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
  let customer: CustomerDto;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    customer = await createCustomer(api);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('si las líneas no suman el total declarado, el comprobante entero queda inválido', async () => {
    const series = importSeriesCode();
    const correlative = importCorrelative();
    // 2 × 100 + 3 × 50 + IGV = 413.00, pero el archivo declara 500.00.
    const batch = await previewFiscalImport(
      api,
      fiscalDocumentRows({
        series,
        correlative,
        customerDocNumber: customer.docNumber,
        totalPen: '500.00',
        lines: [
          { qty: '2', unitPricePen: '100.00' },
          { qty: '3', unitPricePen: '50.00' },
        ],
      }),
    );

    // El error dice **los dos números**: sin el calculado, el usuario sabe que no cuadra
    // pero no por cuánto ni dónde buscar.
    const mismatch = `Las líneas del comprobante ${documentNumber(series, correlative)} suman 413.00 y el archivo declara 500.00`;
    expect(batchErrors(batch)).toEqual([mismatch, mismatch]);
    // Las dos filas caen juntas: un comprobante no se importa a medias.
    expect(rowStatuses(batch)).toEqual(['INVALID', 'INVALID']);

    // Y no hay nada que confirmar: el lote entero es inválido.
    const refused = await api.post(`/api/imports/${batch.id}/confirm`);
    expect(refused.status()).toBe(400);
    expect(await refused.text()).toContain('No hay filas válidas para confirmar');
  });

  test('la cabecera tiene que decir lo mismo en todas las líneas del comprobante', async () => {
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const rows = fiscalDocumentRows({
      series,
      correlative,
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { qty: '2', unitPricePen: '100.00' },
        { qty: '3', unitPricePen: '50.00' },
      ],
    });
    // La segunda línea dice que el comprobante se emitió otro día. No se sabe cuál de las
    // dos versiones del documento se está importando, así que no entra ninguna.
    rows[1]!['Fecha de emisión'] = daysFromToday(-1);

    const batch = await previewFiscalImport(api, rows);
    const conflict = `Las líneas del comprobante ${documentNumber(series, correlative)} no coinciden en la fecha de emisión`;
    expect(batchErrors(batch)).toEqual([conflict, conflict]);
    expect(rowStatuses(batch)).toEqual(['INVALID', 'INVALID']);
  });

  test('un cliente que no está en el maestro no se da de alta importando comprobantes', async () => {
    const docNumber = await unknownDocNumber(api);
    const batch = await previewFiscalImport(
      api,
      fiscalDocumentRows({
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: docNumber,
        totalPen: '118.00',
        lines: [{ qty: '1', unitPricePen: '100.00' }],
      }),
    );

    // El mensaje dice qué hacer, no solo qué pasó: el maestro se importa con su propio
    // archivo y su propia pantalla (RF-52).
    expect(batchErrors(batch)).toContain(`Cliente no encontrado: ${docNumber} (impórtalo primero)`);
    expect(rowStatuses(batch)).toEqual(['INVALID']);
  });

  test('una nota de crédito cuyo documento afectado no existe no entra', async () => {
    const affected = documentNumber(importSeriesCode(), importCorrelative());
    const batch = await previewFiscalImport(
      api,
      fiscalDocumentRows({
        docType: 'NOTA_CREDITO',
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        affectedNumber: affected,
        creditNoteReason: 'DEVOLUCION_ITEM',
        lines: [{ qty: '1', unitPricePen: '100.00' }],
      }),
    );

    expect(batchErrors(batch)).toContain(
      `El comprobante afectado ${affected} no existe: impórtalo antes que su nota`,
    );
    expect(rowStatuses(batch)).toEqual(['INVALID']);
  });

  test('una fecha de emisión en el futuro es siempre un error de tipeo', async () => {
    const future = daysFromToday(1);
    const batch = await previewFiscalImport(
      api,
      fiscalDocumentRows({
        series: importSeriesCode(),
        correlative: importCorrelative(),
        customerDocNumber: customer.docNumber,
        issueDate: future,
        totalPen: '118.00',
        lines: [{ qty: '1', unitPricePen: '100.00' }],
      }),
    );

    expect(batchErrors(batch)).toContain(`La fecha de emisión ${future} está en el futuro`);
    expect(rowStatuses(batch)).toEqual(['INVALID']);
  });

  test('corregir una línea revalida el comprobante entero, no solo la fila editada', async () => {
    const series = importSeriesCode();
    const correlative = importCorrelative();
    const number = documentNumber(series, correlative);
    // El papel dice 413.00; la segunda línea está tecleada a 60 en vez de 50, así que las
    // líneas suman 380 + IGV = 448.40. El error es **del grupo**: aparece en las dos filas,
    // incluida la que está bien escrita.
    const rows = fiscalDocumentRows({
      series,
      correlative,
      customerDocNumber: customer.docNumber,
      totalPen: '413.00',
      lines: [
        { qty: '2', unitPricePen: '100.00' },
        { qty: '3', unitPricePen: '60.00' },
      ],
    });

    const batch = await previewFiscalImport(api, rows);
    const mismatch = `Las líneas del comprobante ${number} suman 448.40 y el archivo declara 413.00`;
    expect(rowStatuses(batch)).toEqual(['INVALID', 'INVALID']);
    expect(batch.rows[0]?.errors).toContain(mismatch);
    expect(batch.rows[1]?.errors).toContain(mismatch);

    // Se corrige **una** fila, la que estaba mal tecleada.
    const broken = batch.rows[1]!;
    await patchImportRow(api, batch.id, broken.id, {
      ...broken.data,
      unitPricePen: '50.00',
    });

    // Y el error se va de las dos: la primera fila nunca cambió, pero el comprobante al que
    // pertenece dejó de estar roto. Sin revalidar el grupo, seguiría marcada en rojo.
    const revalidated = await getImportBatch(api, batch.id);
    expect(rowStatuses(revalidated)).toEqual(['VALID', 'VALID']);
    expect(batchErrors(revalidated)).toEqual([]);

    // Nada se confirma: el borde termina en la previsualización.
    expect(revalidated.status).toBe('PARSED');
  });

  test('un comprobante importado no ofrece baja ni nota de crédito, y el API las rechaza (D-105)', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    // El único escenario de esta suite que crea un comprobante. No se limpia al final —no
    // hay cómo, y esa es justamente la regla que verifica: la baja de un importado se hace
    // donde se emitió y el resultado se vuelve a importar.
    const imported = await importDocument(api, {
      series: importSeriesCode(),
      correlative: importCorrelative(),
      customerDocNumber: customer.docNumber,
      totalPen: '118.00',
      lines: [{ description: 'E2E línea de un importado', qty: '1', unitPricePen: '100.00' }],
    });

    await page.goto(`/comprobantes/${imported.documentId}`);
    await expect(page.getByRole('heading', { name: imported.number })).toBeVisible();
    // El aviso lo dice una vez y arriba, en vez de dejar que el usuario lo descubra botón
    // por botón.
    await expect(page.getByText(/se importó ya emitido/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dar de baja' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nota de crédito' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar envío' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Consultar estado' })).toHaveCount(0);
    // Lo que sí se puede hacer con él sigue en pie: cobrarlo.
    await expect(page.getByRole('button', { name: 'Registrar cobro' })).toBeVisible();

    // Y el API no depende de que la pantalla esconda el botón.
    const refusedVoid = await api.post(`/api/invoicing/documents/${imported.documentId}/void`, {
      data: { reason: 'Intento de baja de un importado (prueba E2E)' },
    });
    expect(refusedVoid.status()).toBe(400);
    expect(await refusedVoid.text()).toContain('se importó ya emitido');

    const refusedNote = await api.post(
      `/api/invoicing/documents/${imported.documentId}/credit-note`,
      { data: { reason: 'ANULACION_OPERACION', issueDate: daysFromToday(0) } },
    );
    expect(refusedNote.status()).toBe(400);
    expect(await refusedNote.text()).toContain('se importó ya emitido');

    // Nada de eso lo movió: sigue aceptado y debiendo lo suyo.
    const untouched = await getDocument(api, imported.documentId);
    expect(untouched.status).toBe('ACCEPTED');
    expect(untouched.balancePen).toBe('118.0000');
  });

  test('no se reimporta un comprobante que emitió el ERP (RF-72)', async () => {
    // Solo se reimporta lo que se importó. Montar el caso desde cero exigiría **emitir** un
    // comprobante de verdad, que gasta un correlativo de una serie real y, sin PSE, deja un
    // documento sin estado terminal (D-072). Así que se reusa uno que ya exista en la base;
    // si no hay ninguno, el escenario se salta en vez de quemar numeración.
    const emitted = (
      await getJson<DocumentListItem[]>(api, '/api/invoicing/documents?origin=ISSUED_HERE')
    ).filter((d) => d.number !== null && d.status !== 'DRAFT');
    test.skip(
      emitted.length === 0,
      'No hay ningún comprobante emitido por el ERP en esta base, y montar uno exigiría ' +
        'emitir de verdad: eso gasta un correlativo de una serie real y, sin PSE, deja un ' +
        'documento que no se puede llevar a ningún estado terminal (D-072).',
    );

    const target = emitted[0]!;
    const [series, correlativeText] = target.number!.split('-');
    const batch = await previewFiscalImport(
      api,
      fiscalDocumentRows({
        series: series!,
        correlative: Number(correlativeText),
        customerDocNumber: customer.docNumber,
        totalPen: '118.00',
        lines: [{ qty: '1', unitPricePen: '100.00' }],
      }),
    );

    expect(batchErrors(batch)).toContain(
      `El comprobante ${target.number} lo emitió el ERP: no se puede reemplazar`,
    );
    expect(batchWarnings(batch)).toEqual([]);
    expect(rowStatuses(batch)).toEqual(['INVALID']);

    // El comprobante emitido acá no se tocó.
    const after = await getDocument(api, target.id);
    expect(after.origin).toBe('ISSUED_HERE');
    expect(after.archivedAt).toBeNull();
  });

  /**
   * La regresión que este tramo encontró y arregló: `parseSpreadsheet` leía el archivo sin
   * `cellDates`, así que una fecha en un `.csv` —y también una celda de fecha de Excel—
   * llegaba al adaptador como el número de serie de la hoja (`2026-09-05` → `46270`) y se
   * rechazaba por formato. Con eso **ninguna planilla exportada por otro sistema se podía
   * importar**: entraba solo un archivo con la columna formateada como texto.
   *
   * Ninguna entidad importable anterior tenía columna de fecha, así que el defecto llevaba
   * ahí desde RF-52 sin que nada lo tocara.
   */
  test('una planilla csv con la fecha en AAAA-MM-DD entra sin errores de formato', async () => {
    const rows = fiscalDocumentRows({
      series: importSeriesCode(),
      correlative: importCorrelative(),
      customerDocNumber: customer.docNumber,
      totalPen: '118.00',
      lines: [{ qty: '1', unitPricePen: '100.00' }],
    });

    const batch = await uploadImport(api, 'FISCAL_DOCUMENTS', csvOf(rows));
    expect(batchErrors(batch)).toEqual([]);
    // No se confirma: al importador le alcanza con haber leído bien el archivo.
    expect(batch.status).toBe('PARSED');
  });
});
