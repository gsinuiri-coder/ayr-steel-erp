// Deja el inventario de producción sin el stock que dejaron los E2E.
//
// Fase 2a no podía hacer esto: el kardex es append-only (§3.2) y deshacer una compra
// recibida exige el movimiento inverso, que es de Fase 2b. Con `reverse` ya construido,
// una compra `RECEIVED` de un proveedor `E2E …` se anula por el mismo endpoint que usa
// el dueño, con motivo y auditoría; el kardex conserva el rastro completo y el
// inventario valorizado (RF-51) deja de sumar bobinas de prueba.
//
// Solo toca lo que cuelga de un proveedor cuyo nombre empieza con `E2E `. No borra
// nada: anula por API, igual que lo haría un administrador desde la pantalla. Corre
// contra el API desplegado, no contra la base, para pasar por las mismas validaciones.
//
// Uso: pnpm prod:purge-e2e [--base-url https://...] [--dry-run]
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const DEFAULT_BASE_URL = 'https://ayr-steel-erp-web.vercel.app';
const E2E_ADMIN_EMAIL = 'e2e-admin@ayr.test';
const REASON = 'Limpieza de datos de prueba E2E';

const idx = process.argv.indexOf('--base-url');
const baseUrl = idx > -1 ? process.argv[idx + 1] : DEFAULT_BASE_URL;
const dryRun = process.argv.includes('--dry-run');

readEnvFile(); // valida que .env.setup exista antes de tocar producción

const apiDir = resolve(ROOT, 'apps/api');
const dbEnv = {
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
};
const password = `E2E-${randomBytes(18).toString('base64url')}`;

function run(cwd, command, args, extraEnv = {}) {
  const res = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...dbEnv, ...extraEnv },
    stdio: 'inherit',
    shell: true, // `pnpm` es un .cmd en Windows y spawn sin shell falla con EINVAL
  });
  return res.status ?? 1;
}

const cleanupAdmin = () =>
  run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/cleanup-e2e-users.ts'], { ALLOW_E2E_CLEANUP: '1' });

/** Cliente HTTP con la cookie de sesión del admin efímero. */
function createClient() {
  let cookie = '';
  const call = async (path, options = {}) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) {
      cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, body: json };
  };
  return call;
}

console.log(`Limpieza de datos E2E en ${baseUrl}${dryRun ? ' (simulación)' : ''}`);

const created = run(apiDir, 'pnpm', ['exec', 'tsx', 'prisma/e2e-admin.ts'], {
  ALLOW_E2E_ADMIN: '1',
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: password,
});
if (created !== 0) {
  cleanupAdmin();
  throw new Error('No se pudo crear el admin efímero');
}

let failed = false;
try {
  const call = createClient();
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: E2E_ADMIN_EMAIL, password },
  });
  if (!login.ok) throw new Error(`Login del admin efímero falló (${login.status})`);

  // `GET /suppliers` devuelve también los desactivados, que es justo donde quedan los
  // proveedores de prueba tras la limpieza que hace cada spec en su `finally`.
  const suppliers = await call('/suppliers');
  const e2eSupplierIds = new Set(
    (Array.isArray(suppliers.body) ? suppliers.body : [])
      .filter((s) => typeof s.name === 'string' && s.name.startsWith('E2E'))
      .map((s) => s.id),
  );
  console.log(`Proveedores E2E: ${e2eSupplierIds.size}`);

  // -1.75) Ciclo fiscal y logístico de Fase 5b (D-072..D-075). Va **primero de todo** —
  //        antes de las órdenes de producción y de los pedidos, ver el bloque de abajo— y
  //        el orden interno importa tanto como el externo:
  //
  //        1. Los **cobros** primero: un comprobante con cobros vigentes no se da de baja
  //           (un documento anulado no debe nada, así que la baja dejaría dinero recibido
  //           contra algo que dejó de existir).
  //        2. Los **comprobantes** después: mientras uno esté aceptado y facture las
  //           líneas de un despacho, la reversa de ese despacho está bloqueada (D-074).
  //        3. Las **guías**, por el mismo motivo: la guía es el papel que dice que esa
  //           mercadería salió.
  //        4. Los **despachos** al final: revertirlos devuelve el stock y baja el pedido de
  //           "atendido", que es lo que permite que el paso siguiente lo anule — un pedido
  //           ya atendido no se anula.
  //
  //        Los comprobantes **no se borran**: se dan de baja. Un comprobante que el PSE
  //        aceptó existe, y el rastro que esta purga persigue es el de **stock y saldo**,
  //        no el del papel: producción tiene que quedar sin material de prueba y sin cuentas
  //        por cobrar inventadas, con los documentos anulados y a la vista.
  const isE2eCustomer = (name) => typeof name === 'string' && name.startsWith('E2E ');
  // Una boleta a "público en general" (D-077) sale a nombre del cliente sembrado, no del
  // cliente de prueba: el filtro por nombre no la ve. Por eso los tests le ponen la marca
  // en observaciones, y por eso acá se mira también ahí.
  const isE2eDocument = (d) =>
    isE2eCustomer(d.customerName) || (typeof d.notes === 'string' && d.notes.startsWith('E2E '));

  const documents = await call('/invoicing/documents');
  const e2eDocuments = (Array.isArray(documents.body) ? documents.body : []).filter(
    (d) => isE2eDocument(d) && d.status !== 'VOIDED' && d.status !== 'REJECTED',
  );
  console.log(`Comprobantes E2E vivos: ${e2eDocuments.length}`);

  // 1. Cobros vigentes.
  for (const document of e2eDocuments) {
    const detail = await call(`/invoicing/documents/${document.id}`);
    const livePayments = (Array.isArray(detail.body?.payments) ? detail.body.payments : []).filter(
      (payment) => payment.reversedAt === null,
    );
    for (const payment of livePayments) {
      if (dryRun) {
        console.log(`  [simulado] revertir cobro de ${payment.amountPen} en ${document.number}`);
        continue;
      }
      const res = await call(`/invoicing/documents/${document.id}/payments/${payment.id}/reverse`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  cobro de ${payment.amountPen} en ${document.number} revertido`
          : `  cobro en ${document.number} NO se pudo revertir: ${res.body?.message ?? res.status}`,
      );
    }
  }

  // 2 y 3. Los documentos: primero las notas de crédito (para que el afectado quede sin
  //        notas vivas y se pueda dar de baja), después el resto.
  const byVoidOrder = [...e2eDocuments].sort((a, b) => {
    const rank = (d) =>
      d.docType === 'NOTA_CREDITO' ? 0 : d.docType === 'GUIA_REMISION_REMITENTE' ? 2 : 1;
    return rank(a) - rank(b);
  });
  for (const document of byVoidOrder) {
    if (dryRun) {
      console.log(`  [simulado] dar de baja ${document.number ?? 'borrador'}`);
      continue;
    }
    if (document.status === 'DRAFT') {
      // Un borrador nunca tomó correlativo (D-072), así que no hay baja que comunicar a
      // SUNAT: se descarta. Es lo único de este módulo que se borra de verdad, y puede
      // serlo justamente porque no existe fiscalmente.
      const res = await call(`/invoicing/documents/${document.id}`, { method: 'DELETE' });
      console.log(
        res.ok
          ? `  borrador de ${document.docType} descartado`
          : `  borrador de ${document.docType} NO se pudo descartar: ${res.body?.message ?? res.status}`,
      );
      continue;
    }
    const res = await call(`/invoicing/documents/${document.id}/void`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  ${document.number} dado de baja`
        : `  ${document.number} NO se pudo dar de baja: ${res.body?.message ?? res.status}`,
    );
  }

  // 4. Despachos: devuelven el stock y bajan el pedido de "atendido".
  const dispatches = await call('/dispatches?status=ISSUED');
  const e2eDispatches = (Array.isArray(dispatches.body) ? dispatches.body : []).filter((d) =>
    isE2eCustomer(d.customerName),
  );
  console.log(`Despachos E2E vivos: ${e2eDispatches.length}`);
  for (const dispatch of e2eDispatches) {
    if (dryRun) {
      console.log(`  [simulado] revertir el despacho ${dispatch.code} y devolver su stock`);
      continue;
    }
    const res = await call(`/dispatches/${dispatch.id}/reverse`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  despacho ${dispatch.code} revertido; su stock vuelve al almacén`
        : `  despacho ${dispatch.code} NO se pudo revertir: ${res.body?.message ?? res.status}`,
    );
  }

  // -1.6) Órdenes de producción E2E (Fase 4, D-060; coberturas, D-087). Mientras una OP
  //     tenga flejes tomados, el guardrail de D-060 bloquea la reversa de la recepción de
  //     corte, la anulación de la bobina y la de la compra — y mientras tenga reportes
  //     vigentes, el producto terminado conserva piezas de prueba en el inventario
  //     valorizado (RF-51). Se deshace en el orden inverso al que se construyó: reabrir
  //     el cierre, revertir los reportes del más nuevo al más viejo y anular la orden,
  //     que libera los flejes sin tocar el kardex.
  //
  //     **Va después del despacho, no primero (Fase 7b).** Hasta la Fase 7 esta pasada
  //     abría el script, y alcanzaba mientras ningún E2E despachara un producto que la
  //     propia purga acababa de fabricar. La primera cobertura despachada lo rompió:
  //     `reverseReport` bloquea si el producto terminado tuvo movimientos posteriores
  //     vivos que no sean `IN` (roofing-production.service.ts), y la salida del despacho
  //     es exactamente eso — así que la orden quedaba **reabierta a medias**, con su
  //     reporte vigente y sin poder anularse, y la reversa del despacho que venía después
  //     devolvía los metros al almacén sin que nada volviera a sacarlos: saldo fantasma en
  //     el kardex del producto terminado, que es justo el rastro que esta purga persigue.
  //     Con el despacho ya revertido, ese `OUT` deja de estar vivo, la reserva vuelve al
  //     producto (D-088) y reabrir → revertir el reporte → anular pasa en una sola corrida.
  //     Sigue antes de los pedidos (-1.5): una OP viva bloquea la anulación del pedido.
  const productionOrders = await call('/production');
  const e2eProductionOrders = (
    Array.isArray(productionOrders.body) ? productionOrders.body : []
  ).filter(
    (o) =>
      // Con separador, igual que los proveedores `E2E …`: `E2E` a secas alcanzaría a un
      // SKU legítimo del cliente que empiece con esas tres letras, y esto corre contra
      // producción reabriendo órdenes y revirtiendo reportes.
      typeof o.productSku === 'string' &&
      o.productSku.startsWith('E2E-') &&
      o.status !== 'CANCELLED',
  );
  console.log(`Órdenes de producción E2E vivas: ${e2eProductionOrders.length}`);
  for (const order of e2eProductionOrders) {
    if (dryRun) {
      console.log(`  [simulado] deshacer y anular la orden de producción ${order.code}`);
      continue;
    }
    // D-087: las mutaciones de una orden de coberturas cuelgan de `/production/roofing`.
    // El listado es uno solo, así que la clase la decide el `kind` de cada fila.
    const base =
      order.kind === 'ROOFING' ? `/production/roofing/${order.id}` : `/production/${order.id}`;
    if (order.status === 'CLOSED') {
      const res = await call(`${base}/reopen`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  ${order.code} reabierta`
          : `  ${order.code} NO se pudo reabrir: ${res.body?.message ?? res.status}`,
      );
    }
    const detail = await call(`/production/${order.id}`);
    const active = (Array.isArray(detail.body?.reports) ? detail.body.reports : []).filter(
      (r) => r.status === 'ACTIVE',
    );
    // Del más nuevo al más viejo: la reversa solo acepta el último reporte vigente.
    for (const report of [...active].reverse()) {
      const res = await call(`${base}/reports/${report.id}/reverse`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  ${order.code}: reporte de ${report.pieces} piezas revertido`
          : `  ${order.code}: reporte de ${report.pieces} piezas NO se pudo revertir: ${res.body?.message ?? res.status}`,
      );
    }
    const cancelled = await call(`${base}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      cancelled.ok
        ? `  ${order.code} anulada; su material queda libre`
        : `  ${order.code} NO se pudo anular: ${cancelled.body?.message ?? cancelled.status}`,
    );
  }

  // -1.5) Pedidos y cotizaciones E2E (Fase 5a, D-054/D-066). Van después de las órdenes
  //       de producción —una OP viva fabricando con material reservado bloquea la
  //       anulación del pedido— y **antes** de todo lo demás: una reserva `ACTIVA` hace
  //       fallar la anulación de la bobina, la de su compra, el envío a corte y el cierre.
  //       Es el mismo tipo de bloqueo transversal que D-060 introdujo con los flejes.
  //
  //       Anular el pedido libera sus reservas; anular la cotización cierra el documento.
  //       El orden importa: una cotización confirmada no se anula hasta que su pedido lo
  //       está (el API lo exige, y con razón: es lo que libera el material).
  const salesOrders = await call('/sales/orders');
  const e2eSalesOrders = (Array.isArray(salesOrders.body) ? salesOrders.body : []).filter(
    // Con separador, mismo criterio que los proveedores `E2E …` y los SKU `E2E-`: `E2E` a
    // secas alcanzaría a un cliente real cuyo nombre empiece con esas tres letras, y esto
    // corre contra producción liberando material.
    (o) =>
      typeof o.customerName === 'string' &&
      o.customerName.startsWith('E2E ') &&
      o.status !== 'CANCELLED',
  );
  console.log(`Pedidos E2E vivos: ${e2eSalesOrders.length}`);
  for (const order of e2eSalesOrders) {
    if (dryRun) {
      console.log(`  [simulado] anular el pedido ${order.code} y liberar sus reservas`);
      continue;
    }
    const res = await call(`/sales/orders/${order.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  pedido ${order.code} anulado; sus reservas quedan liberadas`
        : `  pedido ${order.code} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  const quotations = await call('/sales/quotations');
  const e2eQuotations = (Array.isArray(quotations.body) ? quotations.body : []).filter(
    (q) =>
      typeof q.customerName === 'string' &&
      q.customerName.startsWith('E2E ') &&
      q.status !== 'CANCELLED',
  );
  console.log(`Cotizaciones E2E vivas: ${e2eQuotations.length}`);
  for (const quotation of e2eQuotations) {
    if (dryRun) {
      console.log(`  [simulado] anular la cotización ${quotation.code}`);
      continue;
    }
    const res = await call(`/sales/quotations/${quotation.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  cotización ${quotation.code} anulada`
        : `  cotización ${quotation.code} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  // Quedan reservas sueltas si un pedido no se pudo anular; se liberan una por una para
  // que ninguna bloquee los pasos siguientes, y el log dice cuáles fueron.
  const reservations = await call('/sales/reservations?status=ACTIVE');
  const e2eReservations = (Array.isArray(reservations.body) ? reservations.body : []).filter(
    (r) => typeof r.customerName === 'string' && r.customerName.startsWith('E2E '),
  );
  if (e2eReservations.length > 0) {
    console.log(`Reservas E2E todavía activas: ${e2eReservations.length}`);
    for (const reservation of e2eReservations) {
      if (dryRun) {
        console.log(`  [simulado] liberar la reserva de ${reservation.itemLabel}`);
        continue;
      }
      const res = await call(`/sales/reservations/${reservation.id}/release`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  reserva de ${reservation.itemLabel} (${reservation.salesOrderCode}) liberada`
          : `  reserva de ${reservation.itemLabel} NO se pudo liberar: ${res.body?.message ?? res.status}`,
      );
    }
  }

  /**
   * Revierte las mermas de prueba vivas sobre flejes E2E (Fase 3b: el E2E de "reversa
   * bloqueada por fleje consumido" registra una merma a propósito).
   *
   * Se llama **dos veces**: antes de revertir las recepciones de corte, porque esa merma
   * es justo lo que bloquea la reversa ("el fleje X ya tiene movimientos posteriores"), y
   * otra vez antes de anular bobinas, porque RF-21 exige que el fleje no tenga movimientos
   * posteriores a su ingreso. Con una sola pasada al final, cuatro recepciones de corte se
   * quedaban sin revertir y sus compras sin anular.
   */
  async function revertTestScraps() {
    const openForScrap = await call('/coils?status=OPEN');
    // **Bobinas y flejes**, no solo flejes: Fase 3b solo dejaba mermas de prueba sobre
    // flejes, pero el test de la invariante de Fase 5a (D-066) registra una merma sobre una
    // bobina madre para comprobar que lo reservado la bloquea. Con el filtro por `STRIP`,
    // esa madre quedaba con saldo y sin poder anularse — un residuo en producción.
    const scrapped = (Array.isArray(openForScrap.body) ? openForScrap.body : []).filter((c) =>
      e2eSupplierIds.has(c.supplierId),
    );
    for (const strip of scrapped) {
      const movements = await call(`/inventory/movements?itemType=COIL&itemId=${strip.id}`);
      const liveScrap = (Array.isArray(movements.body) ? movements.body : []).find(
        (m) =>
          m.refType === 'SCRAP' && m.type === 'OUT' && m.reversalOfId === null && !m.reversedById,
      );
      if (!liveScrap) continue;
      if (dryRun) {
        console.log(`  [simulado] revertir merma de prueba en ${strip.code}`);
        continue;
      }
      const res = await call(`/coils/scraps/${liveScrap.id}/cancel`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  merma de prueba en ${strip.code} revertida`
          : `  merma de prueba en ${strip.code} NO se pudo revertir: ${res.body?.message ?? res.status}`,
      );
    }
  }

  // -1.5) Mermas de prueba sobre flejes, antes de tocar las recepciones de corte: son
  //       exactamente lo que hace fallar a la reversa de D-052.
  await revertTestScraps();

  // -1) Recepciones de corte E2E ya recibidas (Fase 3b, D-052): mientras la bobina
  //     madre tenga el movimiento CUTTING de esa recepción, ni el paso 1 (anular
  //     compra) ni el paso 2 (anular bobina) la alcanzan — es justo el residuo que
  //     Fase 3 dejó documentado y que esta reversa existe para resolver. Si la madre
  //     además tiene un partido local posterior (RF-15), se revierte primero: el
  //     guardrail de la reversa (D-052) bloquea si la madre se movió después de la
  //     recepción que se quiere deshacer.
  const allCuttingOrders = await call('/cutting');
  const e2eReceivedOrders = (
    Array.isArray(allCuttingOrders.body) ? allCuttingOrders.body : []
  ).filter(
    (o) =>
      e2eSupplierIds.has(o.supplierId) &&
      (o.status === 'RECEIVED' || o.status === 'PARTIALLY_RECEIVED'),
  );
  console.log(`Órdenes de corte E2E con recepciones vivas: ${e2eReceivedOrders.length}`);
  for (const order of e2eReceivedOrders) {
    const detail = await call(`/cutting/${order.id}`);
    const receivedRows = (Array.isArray(detail.body?.coils) ? detail.body.coils : []).filter(
      (c) => c.status === 'RECEIVED',
    );
    for (const row of receivedRows) {
      if (dryRun) {
        console.log(`  [simulado] revertir recepción de ${row.coilCode} (orden ${order.id})`);
        continue;
      }
      const splits = await call(`/coils/${row.coilId}/splits`);
      const activeSplits = (Array.isArray(splits.body) ? splits.body : []).filter(
        (s) => s.status === 'ACTIVE',
      );
      for (const split of activeSplits) {
        const r = await call(`/coils/splits/${split.id}/revert`, {
          method: 'POST',
          body: { reason: REASON },
        });
        console.log(
          r.ok
            ? `  partido local de ${row.coilCode} revertido`
            : `  partido local de ${row.coilCode} NO se pudo revertir: ${r.body?.message ?? r.status}`,
        );
      }
      const res = await call(`/cutting/${order.id}/coils/${row.coilId}/reverse`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  recepción de ${row.coilCode} revertida (orden ${order.id})`
          : `  recepción de ${row.coilCode} NO se pudo revertir: ${res.body?.message ?? res.status}`,
      );
    }
  }

  // 0) Órdenes de corte pendientes (Fase 3, D-050): una bobina enviada a un tercero
  //    queda IN_THIRD_PARTY sin movimiento de kardex, así que ni el paso 1 (anular
  //    compra) ni el paso 2 (anular bobina abierta) la alcanzan. Cancelar lo pendiente
  //    la devuelve a OPEN antes de que los pasos siguientes puedan tocarla — incluidas
  //    las órdenes que el paso anterior acaba de dejar con una fila SENT de nuevo.
  const cuttingOrders = await call('/cutting');
  const pendingCuttingOrders = (Array.isArray(cuttingOrders.body) ? cuttingOrders.body : []).filter(
    (o) =>
      e2eSupplierIds.has(o.supplierId) &&
      (o.status === 'SENT' || o.status === 'PARTIALLY_RECEIVED'),
  );
  console.log(`Órdenes de corte E2E pendientes: ${pendingCuttingOrders.length}`);
  for (const order of pendingCuttingOrders) {
    if (dryRun) {
      console.log(`  [simulado] cancelar lo pendiente de la orden ${order.id}`);
      continue;
    }
    const res = await call(`/cutting/${order.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  orden de corte ${order.id} — lo pendiente quedó cancelado`
        : `  orden de corte ${order.id} NO se pudo cancelar: ${res.body?.message ?? res.status}`,
    );
  }

  // 0.7) Pagos vigentes de compras E2E (Sesión M-2, cierra D-039: "anular un pago se
  //      resuelve en Fase 2b junto con el resto de anulaciones", nunca construido hasta
  //      ahora). Una compra con un pago vivo no se puede anular — mismo guardrail que el
  //      paso 1 de abajo, ahora correcto: antes contaba cualquier pago, vivo o no, así
  //      que una compra pagada quedaba bloqueada para siempre y esta purga nunca podía
  //      dejarla anulada. Se revierte cada pago vigente primero, con motivo y auditoría,
  //      igual que cualquier otra reversa.
  const purchases = await call('/purchases');
  const e2ePurchases = (Array.isArray(purchases.body) ? purchases.body : []).filter(
    (p) => e2eSupplierIds.has(p.supplierId) && p.status !== 'CANCELLED',
  );
  const withLivePayments = e2ePurchases.filter((p) => Number.parseFloat(p.paidAmount) > 0);
  console.log(`Compras E2E con pagos vigentes: ${withLivePayments.length}`);
  for (const purchase of withLivePayments) {
    if (dryRun) {
      console.log(`  [simulado] revertir pagos de ${purchase.documentLabel}`);
      continue;
    }
    // La lista no trae el detalle de los pagos; hay que pedirlo por compra.
    const detail = await call(`/purchases/${purchase.id}`);
    const livePayments = (Array.isArray(detail.body?.payments) ? detail.body.payments : []).filter(
      (payment) => !payment.reversedAt,
    );
    for (const payment of livePayments) {
      const res = await call(`/purchases/${purchase.id}/payments/${payment.id}/reverse`, {
        method: 'POST',
        body: { reason: REASON },
      });
      console.log(
        res.ok
          ? `  pago de ${purchase.documentLabel} (${payment.amount} ${payment.currency}) revertido`
          : `  pago de ${purchase.documentLabel} NO se pudo revertir: ${res.body?.message ?? res.status}`,
      );
    }
  }

  // 1) Compras de proveedores E2E. Anular una `RECEIVED` revierte su kardex y anula sus
  //    bobinas de una vez; una `DRAFT` no movió nada, pero igual queda como documento de
  //    prueba en `/compras` (los tests de rol dejan facturas de servicio sin recibir), así
  //    que también se anula. Las que tienen un pago vigente se resisten (paso 0.7 debería
  //    haberlas destrabado ya), y el mensaje lo dice.
  const received = e2ePurchases;
  for (const purchase of received) {
    if (dryRun) {
      console.log(`  [simulado] anular compra ${purchase.documentLabel}`);
      continue;
    }
    const res = await call(`/purchases/${purchase.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  compra ${purchase.documentLabel} anulada`
        : `  compra ${purchase.documentLabel} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  // 1.5) Segunda pasada de mermas: la primera (antes de las reversas de corte) puede
  //      haber dejado alguna fuera si el fleje todavía estaba tomado por una OP.
  await revertTestScraps();

  // 2) Bobinas que quedaron con saldo y no cuelgan de una compra (alta por planilla,
  //    RF-12): se anulan una por una con el mismo endpoint de RF-21.
  const coils = await call('/coils?status=OPEN');
  const orphans = (Array.isArray(coils.body) ? coils.body : []).filter(
    (c) => e2eSupplierIds.has(c.supplierId) && Number.parseFloat(c.availableKg) > 0,
  );
  for (const coil of orphans) {
    if (dryRun) {
      console.log(`  [simulado] anular bobina ${coil.code}`);
      continue;
    }
    const res = await call(`/coils/${coil.id}/cancel`, {
      method: 'POST',
      body: { reason: REASON },
    });
    console.log(
      res.ok
        ? `  bobina ${coil.code} anulada`
        : `  bobina ${coil.code} NO se pudo anular: ${res.body?.message ?? res.status}`,
    );
  }

  // 2.5) Clientes E2E (Fase 5a): baja lógica, igual que la de proveedores y acabados que
  //      cada spec hace en su `finally`. Van al final porque un cliente desactivado no
  //      impide anular sus documentos, pero un documento vivo sí deja al cliente en uso.
  const customers = await call('/customers');
  const e2eCustomers = (Array.isArray(customers.body) ? customers.body : []).filter(
    (c) => typeof c.name === 'string' && c.name.startsWith('E2E ') && c.isActive,
  );
  console.log(`Clientes E2E activos: ${e2eCustomers.length}`);
  for (const customer of e2eCustomers) {
    if (dryRun) {
      console.log(`  [simulado] desactivar el cliente ${customer.name}`);
      continue;
    }
    const res = await call(`/customers/${customer.id}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    console.log(
      res.ok
        ? `  cliente ${customer.name} desactivado`
        : `  cliente ${customer.name} NO se pudo desactivar: ${res.body?.message ?? res.status}`,
    );
  }

  // 2.8) Productos E2E. La purga desactivaba proveedores, acabados y clientes pero **no**
  //      productos: quedaban activos en el catálogo del cliente, visibles en `/catalogo` y
  //      en el desplegable de toda cotización. Va antes de los colores porque el API se
  //      niega a desactivar un color que un producto activo todavía use.
  //
  //      Solo los del prefijo con separador (`E2E-`), nunca los `BOB…` de venta directa
  //      (D-037), que el alta de una bobina crea sola y que pueden ser del cliente.
  const catalog = await call('/catalog');
  const e2eCatalog = (Array.isArray(catalog.body) ? catalog.body : []).filter(
    (p) => typeof p.sku === 'string' && p.sku.startsWith('E2E-') && p.isActive,
  );
  console.log(`Productos E2E activos: ${e2eCatalog.length}`);
  for (const product of e2eCatalog) {
    if (dryRun) {
      console.log(`  [simulado] desactivar el producto ${product.sku}`);
      continue;
    }
    const res = await call(`/catalog/${product.id}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    console.log(
      res.ok
        ? `  ${product.sku} desactivado`
        : `  ${product.sku} NO se pudo desactivar: ${res.body?.message ?? res.status}`,
    );
  }

  // 2.85) Proveedores y acabados E2E. Los desactiva cada spec en su `finally`, así que
  //       hasta ahora la purga solo los leía para filtrar; los que sobrevivían eran los de
  //       un test que murió antes de llegar a su limpieza, y quedaban activos en
  //       `/proveedores` y `/acabados` a la vista del cliente. Van después de anular
  //       bobinas y compras: antes, el API se niega.
  const activeSuppliers = (Array.isArray(suppliers.body) ? suppliers.body : []).filter(
    (x) => e2eSupplierIds.has(x.id) && x.isActive,
  );
  console.log(`Proveedores E2E activos: ${activeSuppliers.length}`);
  for (const supplier of activeSuppliers) {
    if (dryRun) {
      console.log(`  [simulado] desactivar el proveedor ${supplier.code}`);
      continue;
    }
    const res = await call(`/suppliers/${supplier.id}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    console.log(
      res.ok
        ? `  ${supplier.code} desactivado`
        : `  ${supplier.code} NO se pudo desactivar: ${res.body?.message ?? res.status}`,
    );
  }

  const finishes = await call('/finishes');
  const activeFinishes = (Array.isArray(finishes.body) ? finishes.body : []).filter(
    (f) => typeof f.name === 'string' && f.name.startsWith('Acabado E2E') && f.isActive,
  );
  console.log(`Acabados E2E activos: ${activeFinishes.length}`);
  for (const finish of activeFinishes) {
    if (dryRun) {
      console.log(`  [simulado] desactivar el acabado ${finish.code}`);
      continue;
    }
    const res = await call(`/finishes/${finish.id}`, {
      method: 'PATCH',
      body: { isActive: false },
    });
    console.log(
      res.ok
        ? `  ${finish.code} desactivado`
        : `  ${finish.code} NO se pudo desactivar: ${res.body?.message ?? res.status}`,
    );
  }

  // 2.9) Colores E2E (Fase 6, D-085). Van **al final** de las desactivaciones: el API se
  //      niega a desactivar un color que un producto activo o una bobina viva todavía use,
  //      así que solo funciona cuando ya se desactivaron los productos y se anularon las
  //      bobinas de prueba. Si alguno queda activo, el log lo dice con el motivo.
  const colors = await call('/colors');
  const e2eColors = (Array.isArray(colors.body) ? colors.body : []).filter(
    (c) => typeof c.code === 'string' && c.code.startsWith('E2E') && c.isActive,
  );
  console.log(`Colores E2E activos: ${e2eColors.length}`);
  for (const color of e2eColors) {
    if (dryRun) {
      console.log(`  [simulado] desactivar el color ${color.code} — ${color.name}`);
      continue;
    }
    const res = await call(`/colors/${color.id}`, { method: 'PATCH', body: { isActive: false } });
    console.log(
      res.ok
        ? `  ${color.code} desactivado`
        : `  ${color.code} NO se pudo desactivar: ${res.body?.message ?? res.status}`,
    );
  }

  // 3) Estado final del valorizado, para dejarlo por escrito en el log.
  const remaining = await call('/coils?status=OPEN');
  const withStock = (Array.isArray(remaining.body) ? remaining.body : []).filter(
    (c) => Number.parseFloat(c.availableKg) > 0,
  );
  console.log(`Bobinas abiertas con saldo tras la limpieza: ${withStock.length}`);
  for (const coil of withStock) {
    console.log(`  ${coil.code} — ${coil.supplierName} — ${coil.availableKg} kg`);
  }
  // Una reserva viva sobreviviente es el residuo más caro de esta fase: bloquea merma,
  // corte, cierre y anulación de la bobina, así que se deja dicho explícitamente.
  const e2eProducts = await call('/catalog');
  const withProductStock = [];
  for (const p of (Array.isArray(e2eProducts.body) ? e2eProducts.body : []).filter(
    (p) => typeof p.sku === 'string' && p.sku.startsWith('E2E-'),
  )) {
    const balances = await call(`/inventory/balances?itemType=PRODUCT&itemId=${p.id}`);
    const balance = Array.isArray(balances.body) ? balances.body[0] : undefined;
    if (balance && Number.parseFloat(balance.qty) > 0) {
      withProductStock.push(`${p.sku} — ${balance.qty} ${balance.unit}`);
    }
  }
  console.log(`Productos E2E con saldo tras la limpieza: ${withProductStock.length}`);
  for (const line of withProductStock) console.log(`  ${line}`);

  const stillReserved = await call('/sales/reservations?status=ACTIVE');
  const liveReservations = Array.isArray(stillReserved.body) ? stillReserved.body : [];
  console.log(`Reservas activas en producción tras la limpieza: ${liveReservations.length}`);
  for (const r of liveReservations) {
    console.log(`  ${r.itemLabel} — ${r.qty} ${r.unit} — ${r.salesOrderCode} (${r.customerName})`);
  }
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  cleanupAdmin();
}

process.exit(failed ? 1 : 0);
