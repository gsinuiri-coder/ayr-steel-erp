import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LIST_XLSX_MAX_ROWS,
  paginationQuerySchema,
  Role,
  type ReceivableSummaryDto,
} from '@ayr/shared';
import { receivablesXlsx } from './receivables-xlsx';
import { ReceivablesService } from './receivables.service';

/**
 * cc26 M2 (D-provisional): el Excel de «Por cliente» en /cobranzas trae las mismas filas que la
 * tabla —todas las páginas, en el mismo orden— y su fila de total dice lo mismo que las tarjetas
 * de la pantalla (`receivables/summary`): vencido, por cobrar y cantidad de clientes.
 */

const D = (v: string) => new Prisma.Decimal(v);

function doc(k: number, customer: number, totalPen: string, dueDate: string | null) {
  return {
    id: `d-${String(k)}`,
    status: 'ACCEPTED',
    docType: 'FACTURA',
    totalPen: D(totalPen),
    dueDate: dueDate === null ? null : new Date(`${dueDate}T00:00:00Z`),
    customerId: `c-${String(customer)}`,
    customer: {
      id: `c-${String(customer)}`,
      name: `Cliente ${String(customer)}`,
      docNumber: `20${String(100000000 + customer)}`,
    },
    // La mitad, con un cobro parcial: el saldo es el total menos lo cobrado.
    payments: k % 2 === 0 ? [{ amountPen: D('10.0050'), reversedAt: null }] : [],
    creditNotes: [],
    createdById: 'u-1',
    salesOrder: null,
    dispatch: null,
  };
}

describe('ReceivablesService.exportReceivables — el Excel es la tabla entera (cc26 M2)', () => {
  let docs: ReturnType<typeof doc>[];
  let findMany: jest.Mock;
  let svc: ReceivablesService;

  beforeEach(() => {
    // Nueve clientes, con vencidos (2020), por vencer (2999) y al contado.
    docs = Array.from({ length: 23 }, (_, k) =>
      doc(
        k,
        k % 9,
        `${String(100 + k * 7)}.${String(k % 10)}333`,
        k % 3 === 0 ? '2020-01-15' : k % 3 === 1 ? '2999-12-31' : null,
      ),
    );
    findMany = jest.fn(() => Promise.resolve(docs));
    svc = Object.create(ReceivablesService.prototype) as ReceivablesService;
    Object.assign(svc, { prisma: { fiscalDocument: { findMany } } });
  });

  async function allPages() {
    const out: ReceivableSummaryDto[] = [];
    let total = 0;
    for (let page = 1; ; page += 1) {
      const result = await svc.receivables(
        paginationQuerySchema.parse({ page: String(page), pageSize: '4' }),
      );
      total = result.total;
      out.push(...result.items);
      if (result.items.length === 0 || out.length >= total) break;
    }
    return { items: out, total };
  }

  it('las filas son las de todas las páginas, en el mismo orden', async () => {
    const list = await allPages();
    const exported = await svc.exportReceivables();
    expect(exported).toHaveLength(list.total);
    expect(exported).toEqual(list.items);
  });

  it('la fila de total coincide con las tarjetas de la pantalla (summary)', async () => {
    const exported = await svc.exportReceivables();
    const totals = await svc.totals();
    const file = receivablesXlsx(exported, Role.ADMINISTRADOR, '2026-10-06');
    const book = XLSX.read(file.buffer, { type: 'buffer' });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['Por cliente']!, { header: 1 });
    const header = grid[0] as string[];
    const totalRow = grid.at(-1)!;
    expect(grid).toHaveLength(1 + exported.length + 1);
    expect(totalRow[0]).toBe(`Total (${String(totals.customerCount)} clientes)`);
    expect(totalRow[header.indexOf('Saldo (S/)')]).toBe(Number(totals.totalBalancePen));
    expect(totalRow[header.indexOf('Vencido (S/)')]).toBe(Number(totals.totalOverduePen));
    expect(file.filename).toBe('cobranzas-por-cliente-2026-10-06.xlsx');
  });

  it('una sola consulta, crezca o no la tabla', async () => {
    await svc.exportReceivables();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it(`más de ${String(LIST_XLSX_MAX_ROWS)} clientes: 400, nunca un archivo recortado`, async () => {
    docs = Array.from({ length: LIST_XLSX_MAX_ROWS + 1 }, (_, k) => doc(k, k, '50.0000', null));
    await expect(svc.exportReceivables()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('receivablesXlsx — columnas y celdas', () => {
  it('la fila dice lo que dice la pantalla: contado sin vencimiento, vencido y saldo', () => {
    const row: ReceivableSummaryDto = {
      customerId: '00000000-0000-4000-8000-000000000001',
      customerName: 'Cliente',
      customerDocNumber: '20123456789',
      documentCount: 3,
      balancePen: '250.5000',
      overduePen: '0.0000',
      nextDueDate: null,
      creditWithoutDueCount: 0,
    };
    const book = XLSX.read(receivablesXlsx([row], Role.ADMINISTRADOR, '2026-10-06').buffer, {
      type: 'buffer',
    });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['Por cliente']!, { header: 1 });
    expect(grid[0]).toEqual([
      'Cliente',
      'Documento',
      'Comprobantes',
      'Vencimiento más próximo',
      'Vencido (S/)',
      'Saldo (S/)',
    ]);
    expect(grid[1]).toEqual(['Cliente', '20123456789', 3, 'Contado', 0, 250.5]);
  });

  it('D-537 (cc33 N8): un crédito sin vencimiento se rotula como tal, no como contado', () => {
    const row: ReceivableSummaryDto = {
      customerId: '00000000-0000-4000-8000-000000000001',
      customerName: 'Cliente',
      customerDocNumber: '20123456789',
      documentCount: 1,
      balancePen: '100.0000',
      overduePen: '0.0000',
      nextDueDate: null,
      creditWithoutDueCount: 1,
    };
    const book = XLSX.read(receivablesXlsx([row], Role.ADMINISTRADOR, '2026-10-06').buffer, {
      type: 'buffer',
    });
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['Por cliente']!, { header: 1 });
    expect(grid[1]?.[3]).toBe('Crédito sin vencimiento');
  });
});
