import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import type { OpeningRow } from './opening-balances-plan';
import {
  batchReference,
  OPENING_BATCH_ACTION,
  OPENING_UNDO_ACTION,
  OpeningBalancesImporter,
  OpeningBatchRejected,
  paymentRate,
} from './opening-balances.service';
import { planFingerprint, previewRejection, renderOpeningPreview } from './opening-balances-report';

jest.mock('../inventory/document-locks', () => ({
  lockDocuments: jest.fn(() => Promise.resolve()),
}));

const D = (v: string) => new Prisma.Decimal(v);
const date = (v: string) => new Date(`${v}T00:00:00.000Z`);
const actor = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

function fakeTx(audit: { action: string; entityId: string; after: unknown; at: Date }[] = []) {
  return {
    $queryRaw: jest.fn(() => Promise.resolve([])),
    fiscalDocument: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'doc-b',
            number: 'F1-2',
            status: 'ACCEPTED',
            issueDate: date('2026-08-10'),
            dueDate: null,
            totalPen: D('295'),
            customer: { name: 'ACME', docNumber: '20111' },
            payments: [
              { amountPen: D('45'), reversedAt: null, date: date('2026-08-15') },
              { amountPen: D('10'), reversedAt: null, date: date('2026-10-02') },
              { amountPen: D('99'), reversedAt: new Date(), date: date('2026-08-16') },
            ],
            creditNotes: [
              { totalPen: D('5'), issueDate: date('2026-08-20') },
              { totalPen: D('7'), issueDate: date('2026-10-03') },
            ],
          },
          {
            id: 'doc-a',
            number: 'F1-1',
            status: 'ACCEPTED',
            issueDate: date('2026-08-10'),
            dueDate: date('2026-09-09'),
            totalPen: D('100'),
            customer: { name: 'ACME', docNumber: '20111' },
            payments: [],
            creditNotes: [],
          },
        ]),
      ),
    },
    purchase: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'pur-1',
            series: 'F001',
            number: '9',
            issueDate: date('2026-08-05'),
            currency: 'USD',
            exchangeRate: D('3.7'),
            total: D('1000'),
            supplier: { name: 'PROV', docNumber: '20999' },
            payments: [
              {
                amount: D('370'),
                currency: 'PEN',
                exchangeRate: D('3.7'),
                reversedAt: null,
                // Posterior al corte: baja el saldo de hoy, no el del corte.
                date: date('2026-10-05'),
              },
            ],
          },
          {
            id: 'pur-0',
            series: 'F001',
            number: '8',
            issueDate: date('2026-08-05'),
            currency: 'PEN',
            exchangeRate: D('1'),
            total: D('50'),
            supplier: { name: 'PROV', docNumber: '20999' },
            payments: [],
          },
        ]),
      ),
    },
    auditLog: {
      findMany: jest.fn(() => Promise.resolve(audit)),
      findFirstOrThrow: jest.fn(() => Promise.resolve(audit[0])),
    },
    customerPayment: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 'cp1', documentId: 'doc-a', reversedAt: null },
          { id: 'cp2', documentId: 'doc-b', reversedAt: new Date() },
        ]),
      ),
    },
    supplierPayment: {
      findMany: jest.fn(() =>
        Promise.resolve([{ id: 'sp1', purchaseId: 'pur-1', reversedAt: null }]),
      ),
    },
  };
}

function importer() {
  let id = 0;
  const receivables = {
    addPaymentInTx: jest.fn((..._args: unknown[]) => Promise.resolve(`c${String(++id)}`)),
    reversePaymentInTx: jest.fn((..._args: unknown[]) => Promise.resolve()),
  };
  const purchases = {
    addPaymentInTx: jest.fn((..._args: unknown[]): Promise<string | null> =>
      Promise.resolve(`s${String(++id)}`),
    ),
    reversePaymentInTx: jest.fn((..._args: unknown[]) => Promise.resolve()),
  };
  const audit = { write: jest.fn((..._args: unknown[]) => Promise.resolve()) };
  return {
    receivables,
    purchases,
    audit,
    service: new OpeningBalancesImporter(receivables, purchases, audit, '2026-08-01'),
  };
}

let n = 1;
const row = (key: string, over: Partial<OpeningRow> = {}): OpeningRow => ({
  rowNumber: ++n,
  key,
  date: '',
  amount: '',
  method: '',
  reference: '',
  balance: '',
  ...over,
});

type Tx = Parameters<OpeningBalancesImporter['plan']>[0];

describe('OpeningBalancesImporter', () => {
  it('arma las cuentas al corte: NC y cobros vivos hasta el corte, y el saldo de hoy', async () => {
    const { service } = importer();
    const { accounts, template } = await service.customerAccounts(
      fakeTx() as unknown as Tx,
      '2026-09-30',
    );
    const b = accounts.find((a) => a.key === 'F1-2');
    expect(b?.netAtCutoff.toString()).toBe('290');
    expect(b?.paidUpToCutoff.toString()).toBe('45');
    // 295 − 45 − 10 − 5 − 7 = 228
    expect(b?.payableNow.toFixed(2)).toBe('228.00');
    expect(template.find((t) => t.number === 'F1-1')).toMatchObject({
      dueDate: '2026-09-09',
      balancePen: '100.00',
    });

    const suppliers = await service.supplierAccounts(fakeTx() as unknown as Tx, '2026-09-30');
    const p = suppliers.accounts.find((a) => a.id === 'pur-1');
    expect(p).toMatchObject({ key: '20999 · F001-9' });
    expect(p?.paidUpToCutoff.toString()).toBe('0');
    expect(p?.payableNow.toFixed(2)).toBe('900.00');
    expect(suppliers.meta.get('pur-1')).toEqual({ currency: 'USD', exchangeRate: '3.7000' });
  });

  it('registra por las puertas de dominio, en orden de cuenta, y audita el lote', async () => {
    const { service, receivables, purchases, audit } = importer();
    const tx = fakeTx();
    const done = await service.run(tx as unknown as Tx, actor, {
      cutoff: '2026-09-30',
      missing: 'PAID',
      customers: [row('F1-2', { balance: '17', reference: 'saldo' })],
      suppliers: [
        row('20999 · F001-9', { amount: '100', date: '2026-09-01', exchangeRate: '3.8' }),
      ],
    });
    // F1-1 no está en el Excel → pagado al corte; F1-2 → saldo 17. Primero doc-a, después doc-b.
    expect(
      receivables.addPaymentInTx.mock.calls.map((c) => [
        c[2],
        (c[3] as { amountPen: string }).amountPen,
      ]),
    ).toEqual([
      ['doc-a', '100.00'],
      ['doc-b', '228.00'], // 290 − 45 − 17 (cabe en lo de hoy: 228)
    ]);
    const tag = `SI ${done.batchId.slice(0, 8)}`;
    expect((receivables.addPaymentInTx.mock.calls[1]?.[3] as { reference: string }).reference).toBe(
      `${tag} · saldo`,
    );
    expect(
      purchases.addPaymentInTx.mock.calls.map((c) => [
        c[2],
        (c[3] as { exchangeRate: string }).exchangeRate,
      ]),
    ).toEqual([
      ['pur-0', '1.0000'],
      ['pur-1', '3.8000'],
    ]);
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: OPENING_BATCH_ACTION,
        entityId: done.batchId,
        after: expect.objectContaining({
          customerPaymentIds: ['c1', 'c2'],
          supplierPaymentIds: ['s3', 's4'],
        }),
      }),
    );
  });

  it('con un error no registra nada y devuelve el plan', async () => {
    const { service, receivables } = importer();
    const error = await service
      .run(fakeTx() as unknown as Tx, actor, {
        cutoff: '2026-09-30',
        missing: 'PENDING',
        customers: [row('NO-EXISTE', { balance: '0' })],
        suppliers: null,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpeningBatchRejected);
    expect((error as OpeningBatchRejected).result?.customers?.plan.errors).toHaveLength(1);
    expect(receivables.addPaymentInTx).not.toHaveBeenCalled();
  });

  it('un tipo de cambio inválido es error; en una compra en soles, se ignora con aviso', async () => {
    const { service } = importer();
    const result = await service.plan(fakeTx() as unknown as Tx, {
      cutoff: '2026-09-30',
      missing: 'PENDING',
      customers: null,
      suppliers: [
        row('20999 · F001-9', { amount: '10', date: '2026-09-01', exchangeRate: 'tres' }),
        row('20999 · F001-8', { amount: '10', date: '2026-09-01', exchangeRate: '3.8' }),
      ],
    });
    expect(result.suppliers?.plan.errors.map((e) => e.message)).toEqual([
      'tipo de cambio inválido: «tres»',
    ]);
    expect(result.suppliers?.plan.warnings.map((w) => w.message)).toContain(
      'compra en soles: el tipo de cambio de la fila no se usa',
    );
  });

  it('un pago de compra que ya estaba registrado detiene el lote', async () => {
    const { service, purchases } = importer();
    purchases.addPaymentInTx.mockResolvedValueOnce(null);
    await expect(
      service.run(fakeTx() as unknown as Tx, actor, {
        cutoff: '2026-09-30',
        missing: 'PENDING',
        customers: null,
        suppliers: [row('20999 · F001-8', { balance: '0' })],
      }),
    ).rejects.toThrow(/ya estaba registrado/);
  });

  it('no corre con un lote vivo del mismo lado; sí con uno deshecho o del otro lado', async () => {
    const live = (customer: string[], supplier: string[]) => ({
      action: OPENING_BATCH_ACTION,
      entityId: 'lote-1',
      after: { customerPaymentIds: customer, supplierPaymentIds: supplier },
      at: new Date('2026-10-16T12:00:00Z'),
    });
    const input = {
      cutoff: '2026-09-30',
      missing: 'PENDING' as const,
      customers: [],
      suppliers: null,
    };
    const { service } = importer();
    await expect(
      service.run(fakeTx([live(['x'], [])]) as unknown as Tx, actor, input),
    ).rejects.toThrow(/Ya hay un lote/);
    await expect(
      service.run(fakeTx([live([], ['y'])]) as unknown as Tx, actor, input),
    ).resolves.toBeDefined();
    const undone = fakeTx([
      live(['x'], []),
      { action: OPENING_UNDO_ACTION, entityId: 'lote-1', after: {}, at: new Date() },
    ]);
    expect(await service.liveBatches(undone as unknown as Tx)).toEqual([]);
  });

  it('deshace: revierte lo vivo, salta lo ya revertido y audita', async () => {
    const { service, receivables, purchases, audit } = importer();
    const tx = fakeTx([
      {
        action: OPENING_BATCH_ACTION,
        entityId: 'lote-1',
        after: { customerPaymentIds: ['cp1', 'cp2'], supplierPaymentIds: ['sp1'] },
        at: new Date(),
      },
    ]);
    expect(
      await service.undo(tx as unknown as Tx, actor, 'lote-1', 'cargué el archivo equivocado'),
    ).toEqual({
      reversed: 2,
      alreadyReversed: 1,
    });
    expect(receivables.reversePaymentInTx).toHaveBeenCalledWith(
      tx,
      actor,
      'doc-a',
      'cp1',
      expect.stringMatching(/lote lote-1/),
    );
    expect(purchases.reversePaymentInTx).toHaveBeenCalledWith(
      tx,
      actor,
      'pur-1',
      'sp1',
      expect.anything(),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: OPENING_UNDO_ACTION }),
    );
    await expect(service.undo(fakeTx() as unknown as Tx, actor, 'otro', 'motivo')).rejects.toThrow(
      /No hay un lote vivo/,
    );
  });

  it('deshacer falla si faltan pagos del lote', async () => {
    const { service } = importer();
    const tx = fakeTx([
      {
        action: OPENING_BATCH_ACTION,
        entityId: 'lote-1',
        after: { customerPaymentIds: ['cp1', 'cp2', 'cp3'], supplierPaymentIds: ['sp1'] },
        at: new Date(),
      },
    ]);
    await expect(service.undo(tx as unknown as Tx, actor, 'lote-1', 'motivo')).rejects.toThrow(
      /lista 4 pagos/,
    );
  });
});

describe('helpers del lote', () => {
  it('la referencia lleva el lote y se recorta', () => {
    expect(batchReference('0123456789abcdef', null, 80)).toBe('SI 01234567');
    expect(batchReference('0123456789abcdef', 'x'.repeat(100), 20)).toHaveLength(20);
  });

  it('el tipo de cambio: soles 1, dólares el de la fila o el de la compra', () => {
    expect(
      paymentRate({ exchangeRate: '3.9' }, { currency: 'PEN', exchangeRate: '1' }).toString(),
    ).toBe('1');
    expect(
      paymentRate({ exchangeRate: '3.9' }, { currency: 'USD', exchangeRate: '3.7' }).toString(),
    ).toBe('3.9');
    expect(
      paymentRate({ exchangeRate: null }, { currency: 'USD', exchangeRate: '3.7' }).toString(),
    ).toBe('3.7');
  });
});

describe('vista previa', () => {
  const result = {
    batchId: 'b'.repeat(36),
    cutoff: '2026-09-30',
    missing: 'PAID' as const,
    customers: {
      paymentIds: [],
      plan: {
        payments: [
          {
            accountId: 'a',
            key: 'F1-1',
            date: '2026-09-30',
            amount: '100.00',
            method: 'OTHER' as const,
            reference: null,
            exchangeRate: null,
            source: 'MISSING_PAID' as const,
            rowNumbers: [],
          },
        ],
        errors: [{ rowNumber: 3, key: 'X', message: 'malo' }],
        warnings: [{ rowNumber: null, key: null, message: 'ojo' }],
        accounts: [
          {
            key: 'F1-1',
            issueDate: '2026-08-10',
            balanceAtCutoffBefore: '100.00',
            registered: '100.00',
            balanceAtCutoffAfter: '0.00',
            treatment: 'MISSING_PAID' as const,
          },
        ],
        totalRegistered: '100.00',
        totalsByCurrency: { PEN: '100.00' },
      },
    },
    suppliers: null,
  };
  const preview = {
    branch: 'local',
    gitSha: 'abc',
    generatedAtIso: '2026-10-16T12:00:00.000Z',
    files: { customers: 'h1', suppliers: null },
    result,
    executed: false,
  };

  it('se escribe en markdown con errores, avisos y tablas', () => {
    const md = renderOpeningPreview(preview);
    expect(md).toMatch(/vista previa \(dry-run\) en local/);
    expect(md).toMatch(/pagado al corte/);
    expect(md).toMatch(/fila 3 · X: malo/);
    expect(md).toMatch(/\(sin clave\): ojo/);
    expect(md).toMatch(/\| F1-1 \| 2026-09-30 \| 100.00 \| PEN \| Otro \|/);
    expect(md).toMatch(/Pagos: no vino archivo/);
    expect(renderOpeningPreview({ ...preview, executed: true })).toMatch(/EJECUCIÓN/);
  });

  it('la huella ignora el id del lote', () => {
    expect(planFingerprint(result)).toBe(planFingerprint({ ...result, batchId: 'otro' }));
    expect(planFingerprint(result)).not.toBe(planFingerprint({ ...result, cutoff: '2026-09-29' }));
  });

  it('--execute solo con una vista previa válida', () => {
    const now = {
      branch: 'local',
      gitSha: 'abc',
      at: new Date('2026-10-16T13:00:00Z'),
      files: preview.files,
    };
    expect(previewRejection(preview, now)).toBeNull();
    expect(previewRejection(null, now)).toMatch(/no hay vista previa/);
    expect(previewRejection({ ...preview, executed: true }, now)).toMatch(/ejecución/);
    expect(previewRejection({ ...preview, branch: 'demo' }, now)).toMatch(/es de demo/);
    expect(previewRejection(preview, { ...now, gitSha: 'def' })).toMatch(/commit/);
    expect(previewRejection(preview, { ...now, gitSha: 'abc+cambios' })).toMatch(/commit/);
    expect(previewRejection(preview, { ...now, at: new Date('2026-10-18T13:00:00Z') })).toMatch(
      /máximo 24 h/,
    );
    expect(
      previewRejection(preview, { ...now, files: { customers: 'h2', suppliers: null } }),
    ).toMatch(/archivos/);
  });
});
