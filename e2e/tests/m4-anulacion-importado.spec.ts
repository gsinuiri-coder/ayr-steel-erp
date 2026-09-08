import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, getItems } from '../helpers/api';
import { annulImported, getDocument } from '../helpers/invoicing';

/**
 * Anulación **interna** de un comprobante importado (D-110), lo que queda tras D-150.
 *
 * La sesión M-4 dejó acá seis casos que cubrían el ciclo entero: importar, anular, ver el
 * saldo caer en las tres lecturas de deuda, el guardrail del cobro vigente, la idempotencia
 * del segundo intento y el permiso del vendedor. **Cinco se fueron con el importador de
 * comprobantes**: los seis empezaban importando, y ese camino ya no existe.
 *
 * El que sobrevive es el único que no necesitaba importar nada, y no es el menos importante:
 * comprueba que la anulación interna **no alcanza a un comprobante que emitió el ERP**. Ese
 * guardrail es el que impide que `annulImported` —que se conserva justamente para poder dar
 * de baja las filas que ya entraron— se convierta en una puerta trasera para deshacer una
 * venta real sin pasar por SUNAT, que es lo que de verdad no puede pasar.
 *
 * Lo que ya no tiene cobertura E2E, y queda anotado: el camino feliz de la anulación, sus dos
 * guardrails (cobro vigente y nota de crédito viva), la idempotencia y el 403 del vendedor.
 * Solo se podrían volver a montar importando, o emitiendo de verdad contra el PSE.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

/** Lo que el listado devuelve por comprobante; la lista no trae líneas ni cobros. */
interface DocumentListItem {
  id: string;
  number: string | null;
  status: string;
  origin: 'ISSUED_HERE' | 'IMPORTED';
}

test.describe('D-110 — la anulación interna no toca lo que emitió el ERP', () => {
  test.skip(
    !allowWrites,
    'Escribe sobre comprobantes: contra una URL externa exige E2E_ALLOW_WRITES=1 (D-024).',
  );

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la anulación interna no alcanza a un comprobante que emitió el ERP (D-110)', async () => {
    // Montar el caso desde cero exigiría **emitir** de verdad, que gasta un correlativo de una
    // serie real y, sin PSE, deja un documento sin estado terminal (D-072). Se reusa uno que ya
    // exista en la base; si no hay ninguno, se salta.
    const emitted = (
      await getItems<DocumentListItem>(api, '/api/invoicing/documents?origin=ISSUED_HERE')
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
});
