/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Exporta a xlsx las bobinas **actuales** de una rama — SOLO LECTURA, no toca `coils` ni
 * `inventory_movements`. "Actuales" = `kind=COIL` (sin flejes) y `status != CANCELLED`; una
 * anulada no es una bobina que el cliente tenga físicamente, que es la pregunta que responde
 * este reporte (misma noción que `go-live-inventory.ts` usa para "no anulada").
 *
 * Los "KILOS ACTUALES" salen de `inventory_balances` (RF-lo-que-sea del kardex), no de
 * `weightKg` — esa columna es el peso con el que la bobina **entró**, no lo que le queda. Una
 * bobina sin fila de saldo (nunca tuvo movimiento, no debería pasar) cae a `weightKg` con un
 * aviso en la columna NOTAS para que se vea a simple vista.
 *
 * Uso: `node scripts/export-coils.mjs --branch production --out local-data/bobinas.xlsx`
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();

function formatOperationDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error('Falta la ruta de salida (la resuelve scripts/export-coils.mjs).');
    process.exitCode = 1;
    return;
  }
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';

  // D-206 (`external_code`) puede no estar desplegada todavía en la rama consultada — se
  // acumula para la ventana V-4 (docs/PROGRESO.md). Sin esa columna, ninguna bobina real pudo
  // entrar por la carga inicial: `externalCode` sale `null` en todas, que es la verdad.
  interface CoilRow {
    id: string;
    code: string;
    externalCode: string | null;
    businessLine: { name: string };
    finish: { code: string };
    color: { name: string } | null;
    thicknessMm: { toString(): string };
    widthMm: { toString(): string };
    weightKg: { toString(): string };
    unitCostPerKg: { toString(): string };
    currency: string;
    exchangeRate: { toString(): string };
    supplier: { name: string };
    status: string;
    operationDate: Date;
    notes: string | null;
    // Null en una bobina que no nace de una compra directa (hija de partido, de corte
    // tercerizado, o de la carga inicial D-206): esas no tienen "comprobante" propio.
    purchase: { series: string; number: string; issueDate: Date } | null;
  }
  let coils: CoilRow[];
  try {
    coils = await prisma.coil.findMany({
      where: { kind: 'COIL', status: { not: 'CANCELLED' } },
      // PEPS: la más antigua primero, que es el orden en que se consume el stock.
      orderBy: [{ operationDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        code: true,
        externalCode: true,
        businessLine: { select: { name: true } },
        finish: { select: { code: true } },
        color: { select: { name: true } },
        thicknessMm: true,
        widthMm: true,
        weightKg: true,
        unitCostPerKg: true,
        currency: true,
        exchangeRate: true,
        supplier: { select: { name: true } },
        status: true,
        operationDate: true,
        notes: true,
        purchase: { select: { series: true, number: true, issueDate: true } },
        id: true,
      },
    });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('external_code')) throw err;
    console.log(`  (${label}: sin la columna external_code todavía — D-206 no está desplegada)`);
    const withoutExternalCode = await prisma.coil.findMany({
      where: { kind: 'COIL', status: { not: 'CANCELLED' } },
      orderBy: [{ operationDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        code: true,
        businessLine: { select: { name: true } },
        finish: { select: { code: true } },
        color: { select: { name: true } },
        thicknessMm: true,
        widthMm: true,
        weightKg: true,
        unitCostPerKg: true,
        currency: true,
        exchangeRate: true,
        supplier: { select: { name: true } },
        status: true,
        operationDate: true,
        notes: true,
        purchase: { select: { series: true, number: true, issueDate: true } },
        id: true,
      },
    });
    coils = withoutExternalCode.map((c) => ({ ...c, externalCode: null }));
  }

  const balances = await prisma.inventoryBalance.findMany({
    where: { itemType: 'COIL', itemId: { in: coils.map((c) => c.id) } },
    select: { itemId: true, qty: true },
  });
  const qtyByCoilId = new Map(balances.map((b) => [b.itemId, b.qty]));

  const rows = coils.map((c) => {
    const currentQty = qtyByCoilId.get(c.id);
    const noBalance = currentQty === undefined;
    return {
      'CÓDIGO SISTEMA': c.code,
      'CÓDIGO CLIENTE': c.externalCode ?? '',
      LÍNEA: c.businessLine.name,
      ACABADO: c.finish.code,
      COLOR: c.color?.name ?? '',
      'ESPESOR (MM)': c.thicknessMm.toString(),
      'ANCHO (MM)': c.widthMm.toString(),
      'KILOS INICIALES': c.weightKg.toString(),
      'KILOS ACTUALES': (noBalance ? c.weightKg : currentQty).toString(),
      'COSTO UNITARIO (S/KG SIN IGV)': c.unitCostPerKg.toString(),
      MONEDA: c.currency,
      'TIPO DE CAMBIO': c.exchangeRate.toString(),
      PROVEEDOR: c.supplier.name,
      ESTADO: c.status,
      'FECHA DE OPERACIÓN': formatOperationDate(c.operationDate),
      COMPROBANTE: c.purchase ? `${c.purchase.series}-${c.purchase.number}` : '',
      'FECHA DE COMPROBANTE': c.purchase ? formatOperationDate(c.purchase.issueDate) : '',
      NOTAS: [c.notes, noBalance ? 'SIN FILA DE SALDO — revisar' : null]
        .filter(Boolean)
        .join(' | '),
    };
  });

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Bobinas');
  XLSX.writeFile(workbook, outPath);

  console.log(`Bobinas actuales en ${label}: ${rows.length} → ${outPath}`);
  const sinSaldo = rows.filter((r) => r.NOTAS.includes('SIN FILA DE SALDO'));
  if (sinSaldo.length > 0) {
    console.log(
      `  !!  ${sinSaldo.length} bobina(s) sin fila de saldo — revisar antes de confiar en su kilaje.`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
