/* eslint-disable no-console -- guion de diagnostico: su salida ES la consola. */
/**
 * Diagnóstico de solo lectura del catálogo de coberturas (D-127).
 *
 * Las reglas nuevas —subtipo obligatorio, largo fijo obligatorio en `PLANCHA`, unidad coherente
 * con el subtipo— son un cambio **no aditivo** sobre datos existentes, que es exactamente lo
 * que D-123 dice verificar contra la población completa y no contra una muestra. Este guion
 * lista los productos que quedarían bloqueados para cualquier edición, antes de desplegar.
 *
 * No escribe nada. Uso: `node scripts/check-roofing-catalog.mjs --branch production`.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { isPlausiblePieceLength, PIECE_LENGTH_RANGE_LABEL } from '@ayr/shared';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const label = process.env.AYR_BRANCH_LABEL ?? 'la rama configurada';
  const products = await prisma.product.findMany({
    where: { businessLine: { code: 'METALLIC_ROOFING' } },
    select: {
      sku: true,
      name: true,
      unit: true,
      lengthMm: true,
      roofingKind: true,
      isActive: true,
    },
    orderBy: { sku: 'asc' },
  });

  console.log(`Catálogo de coberturas en ${label}: ${products.length} producto(s).`);

  const sinSubtipo = products.filter((p) => p.roofingKind === null);
  const planchaSinLargo = products.filter(
    (p) => p.roofingKind === 'PLANCHA' && p.lengthMm === null,
  );
  // El servicio exige `NIU` para `PLANCHA` y `MTR` para `A_MEDIDA`; el CHECK de la base es más
  // laxo. Lo que queda en el medio es lo que se puede editar en la base pero no por la app.
  const unidadIncoherente = products.filter(
    (p) =>
      (p.roofingKind === 'A_MEDIDA' && p.unit !== 'MTR') ||
      (p.roofingKind === 'PLANCHA' && p.unit !== 'NIU'),
  );
  // D-166: el largo que **está** pero no se puede creer. El campo del catálogo pide
  // milímetros y el resto de la pantalla de coberturas trabaja en metros, así que un "3" por
  // 3 000 entra sin que nada avise — y D-161 multiplica el precio por ese número, dejando la
  // cotización mil veces más barata. Estos ya no se pueden cotizar (el API los rechaza) y hay
  // que corregirlos a mano en el catálogo.
  const largoImposible = products.filter(
    (p) =>
      p.roofingKind === 'PLANCHA' &&
      p.lengthMm !== null &&
      !isPlausiblePieceLength(p.lengthMm.toFixed(2)),
  );

  const report = (title: string, rows: typeof products) => {
    if (rows.length === 0) {
      console.log(`  ok  ${title}: ninguno.`);
      return;
    }
    console.log(`  ATENCIÓN  ${title}: ${rows.length}`);
    for (const p of rows) {
      console.log(
        `          ${p.sku} — ${p.name} (unidad ${p.unit}, largo ${p.lengthMm?.toFixed(2) ?? 'sin'}, subtipo ${p.roofingKind ?? 'sin'}${p.isActive ? '' : ', desactivado'})`,
      );
    }
  };

  report('sin subtipo', sinSubtipo);
  report('PLANCHA sin largo fijo (no se van a poder editar)', planchaSinLargo);
  report('con unidad incoherente con su subtipo', unidadIncoherente);
  report(
    `PLANCHA con largo IMPOSIBLE — no se pueden cotizar, el largo va entre ${PIECE_LENGTH_RANGE_LABEL} (D-166)`,
    largoImposible,
  );
  if (largoImposible.length > 0) {
    console.log('');
    console.log('  El campo del catálogo va en MILÍMETROS: una plancha de 3 metros son 3000.');
    console.log('  Corrígelos en Catálogo antes de cotizarlos; el largo de arriba está en mm.');
  }

  if (
    sinSubtipo.length +
      planchaSinLargo.length +
      unidadIncoherente.length +
      largoImposible.length ===
    0
  ) {
    console.log('Nada que corregir.');
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
