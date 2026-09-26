import {
  COIL_SORT_KEYS,
  CUSTOMER_SORT_KEYS,
  DISPATCH_SORT_KEYS,
  FISCAL_DOCUMENT_SORT_KEYS,
  PURCHASE_SORT_KEYS,
  QUOTATION_SORT_KEYS,
  SALES_ORDER_SORT_KEYS,
} from '@ayr/shared';
import {
  coilOrderBy,
  customerOrderBy,
  dispatchOrderBy,
  fiscalDocumentOrderBy,
  purchaseOrderBy,
  quotationOrderBy,
  salesOrderOrderBy,
} from './list-orderings';

/**
 * D-323 — el orden por columna de cada listado paginado. Cada clave declarada tiene que producir un
 * orden distinto del de siempre en los dos sentidos, y sin `sort` queda el orden por defecto.
 */

const DEFAULTS = {
  quotation: [{ seq: 'desc' }],
  salesOrder: [{ seq: 'desc' }],
  coil: [{ operationDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  customer: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
  purchase: [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  fiscalDocument: [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  dispatch: [{ dispatchDate: 'desc' }, { seq: 'desc' }],
};

const cases = [
  ['cotizaciones', quotationOrderBy, QUOTATION_SORT_KEYS, DEFAULTS.quotation],
  ['pedidos', salesOrderOrderBy, SALES_ORDER_SORT_KEYS, DEFAULTS.salesOrder],
  ['bobinas', coilOrderBy, COIL_SORT_KEYS, DEFAULTS.coil],
  ['clientes', customerOrderBy, CUSTOMER_SORT_KEYS, DEFAULTS.customer],
  ['compras', purchaseOrderBy, PURCHASE_SORT_KEYS, DEFAULTS.purchase],
  ['comprobantes', fiscalDocumentOrderBy, FISCAL_DOCUMENT_SORT_KEYS, DEFAULTS.fiscalDocument],
  ['despachos', dispatchOrderBy, DISPATCH_SORT_KEYS, DEFAULTS.dispatch],
] as const;

describe.each(cases)('orden de %s', (_name, orderBy, keys, defaults) => {
  const build = orderBy as (q: { sort?: string; dir?: 'asc' | 'desc' }) => unknown[];

  it('sin sort deja el orden de siempre', () => {
    expect(build({})).toEqual(defaults);
  });

  it.each(keys as readonly string[])(
    '«%s» ordena en los dos sentidos y desempata con el orden de siempre',
    (key) => {
      const asc = build({ sort: key, dir: 'asc' });
      const desc = build({ sort: key, dir: 'desc' });
      // La columna elegida va primero y el orden de siempre desempata detrás.
      expect(asc.slice(-defaults.length)).toEqual(defaults);
      expect(desc.slice(-defaults.length)).toEqual(defaults);
      expect(asc.length).toBeGreaterThan(defaults.length);
      expect(asc).not.toEqual(desc);
    },
  );

  it('dir ausente es ascendente', () => {
    const [key] = keys as readonly string[];
    expect(build({ sort: key })).toEqual(build({ sort: key, dir: 'asc' }));
  });
});

describe('detalles por columna', () => {
  it('el número de una compra ordena por serie y por correlativo', () => {
    expect(purchaseOrderBy({ sort: 'number', dir: 'desc' }).slice(0, 2)).toEqual([
      { series: 'desc' },
      { number: 'desc' },
    ]);
  });

  it('«Estado» de clientes pone a los activos primero en ascendente', () => {
    expect(customerOrderBy({ sort: 'status', dir: 'asc' })[0]).toEqual({ isActive: 'desc' });
    expect(customerOrderBy({ sort: 'status', dir: 'desc' })[0]).toEqual({ isActive: 'asc' });
  });

  it('el cliente de un despacho se ordena por el nombre del cliente de su pedido', () => {
    expect(dispatchOrderBy({ sort: 'customer', dir: 'asc' })[0]).toEqual({
      salesOrder: { customer: { name: 'asc' } },
    });
  });
});
