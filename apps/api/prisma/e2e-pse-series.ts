/** Lee el último correlativo respaldado por una respuesta del PSE en Docker E2E. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from './test-db-guard';

const PSE_SERIES = ['F001', 'B001', 'FC01', 'T001'];

function providerBacked(document: {
  status: string;
  sendAttempts: number;
  lastSendError: string | null;
  providerResponse: unknown;
}): boolean {
  if (['ACCEPTED', 'VOID_PENDING', 'VOIDED'].includes(document.status)) return true;
  if (
    !['ISSUED', 'REJECTED'].includes(document.status) ||
    document.sendAttempts < 1 ||
    document.lastSendError
  ) {
    return false;
  }
  const response = document.providerResponse;
  return typeof response === 'object' && response !== null && Object.keys(response).length > 0;
}

async function main(): Promise<void> {
  assertTestDatabase();
  const bases = JSON.parse(process.env.E2E_PSE_BASES ?? 'null') as Record<string, number> | null;
  if (!bases || PSE_SERIES.some((series) => !Number.isSafeInteger(bases[series]))) {
    throw new Error('Faltan bases PSE para cotejar Docker E2E');
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.fiscalSeries.findMany({
      select: {
        series: true,
        isActive: true,
        correlative: true,
        documents: {
          where: { correlative: { not: null } },
          select: {
            correlative: true,
            status: true,
            sendAttempts: true,
            lastSendError: true,
            providerResponse: true,
          },
        },
      },
    });
    const blocked = rows.find((row) => row.series === 'BC01');
    if (!blocked || blocked.isActive || blocked.documents.length > 0) {
      throw new Error('BC01 debe estar inactiva y sin emisiones en el gate PSE');
    }
    const enabled = rows.filter((row) => row.series !== 'BC01');
    if (
      enabled.length !== PSE_SERIES.length ||
      enabled.some((row) => !PSE_SERIES.includes(row.series) || !row.isActive)
    ) {
      throw new Error('Las series de Docker E2E no coinciden con el gate PSE');
    }
    const observed: Record<string, number> = {};
    for (const row of enabled) {
      const base = bases[row.series];
      if (typeof base !== 'number' || !Number.isSafeInteger(base)) {
        throw new Error(`Falta base PSE para ${row.series}`);
      }
      if (row.correlative < base || row.correlative > base + 99) {
        throw new Error(`La serie ${row.series} salió del bloque de 100 correlativos`);
      }
      const unconfirmed = row.documents.filter((document) => !providerBacked(document));
      if (unconfirmed.length > 0) {
        throw new Error(
          `Hay ${unconfirmed.length} documento(s) de ${row.series} sin respuesta del PSE`,
        );
      }
      observed[row.series] = Math.max(
        base,
        ...row.documents
          .filter(providerBacked)
          .flatMap((document) => (document.correlative === null ? [] : [document.correlative])),
      );
    }
    process.stdout.write(JSON.stringify(observed));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
