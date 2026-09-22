// Datos de demo de accesorios de cobertura (D-242) — M4 de la sesión ACC-demo.
//
// Crea, **por HTTP contra el API** (nunca SQL: todo pasa por servicios de dominio), el
// escenario mínimo para mostrar el flujo completo en vivo:
//
//   1. color y acabado prepintado de demo;
//   2. dos SKU de accesorio (cumbrera y canaleta) con su desarrollo;
//   3. un proveedor y una bobina recibida con saldo, para tener qué rolar;
//   4. un cliente de prueba rotulado y un pedido confirmado, que deja su OP en cola.
//
// **Todo lo que crea lleva el prefijo `DEMO-ACC`** y el cliente se llama
// «CLIENTE DEMO ACCESORIOS» (ajuste 2 del dueño): la rama `demo` es copia de datos reales y
// nada de esto puede confundirse con un cliente o un SKU de verdad.
//
// Credenciales y destino **por entorno, nunca por argv** (regla dura 5 y §3.1):
//
//   AYR_API_URL       http://localhost:3000 por defecto
//   AYR_ADMIN_EMAIL   admin@ayr.local por defecto (Docker local)
//   AYR_ADMIN_PASSWORD
//
// Uso, desde la raíz del repo:  node scripts/oneoff/20260922-demo-accesorios.mjs
import { randomUUID } from 'node:crypto';

const API = process.env.AYR_API_URL ?? 'http://localhost:3000';
const EMAIL = process.env.AYR_ADMIN_EMAIL ?? 'admin@ayr.local';
const PASSWORD = process.env.AYR_ADMIN_PASSWORD ?? 'AyrLocal-2026!';

/**
 * Marca única de la corrida: dos siembras seguidas no chocan por SKU ni por código. Al azar y
 * no por hora — dos corridas dentro del mismo minuto chocaban, que es exactamente lo que pasa
 * cuando se ensaya la demo dos veces seguidas.
 */
const TAG = randomUUID().slice(0, 4).toUpperCase();
const PREFIX = 'DEMO-ACC';

/**
 * La sesión del API son **cookies httpOnly** (RF-03), no un bearer: el login las deja en la
 * respuesta y cada llamada siguiente las manda de vuelta. Se guardan acá y nunca se imprimen.
 */
let cookies = '';

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies } : {}),
      // Las operaciones repetibles del dominio piden clave de idempotencia (§3.4).
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  }
  const text = await res.text();
  if (!res.ok) {
    // Sin repetir el cuerpo enviado: puede traer datos del escenario y no hace falta para
    // entender el fallo. El mensaje del API ya dice qué rechazó.
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

const post = (path, body) => call('POST', path, body);
const get = (path) => call('GET', path);

function today() {
  // Día de negocio en Lima (D-124). El API lo resuelve igual, pero las fechas que este
  // script manda tienen que ser del mismo día o el guardrail cronológico las corta.
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function main() {
  console.log(`Sembrando datos de demo de accesorios contra ${API}`);

  await post('/auth/login', { email: EMAIL, password: PASSWORD });
  if (!cookies) throw new Error('El login no dejó cookie de sesión');

  const lines = await get('/business-lines');
  const roofing = lines.find((l) => l.code === 'metallic-roofing');
  if (!roofing) throw new Error('No existe la línea metallic-roofing');

  // 1. Color y acabado -----------------------------------------------------
  const color = await post('/colors', {
    code: `${PREFIX}-ROJO${TAG}`,
    name: `Rojo demo accesorios ${TAG}`,
    hexColor: '#c8102e',
  });
  const finish = await post('/finishes', {
    // D-203: el acabado lleva su línea por **código** y su color adentro; el color de la
    // bobina sale de acá y no del ítem de compra.
    businessLine: 'metallic-roofing',
    code: `${PREFIX}-PREP${TAG}`,
    name: `Prepintado demo accesorios ${TAG}`,
    densityFactor: '7.8500',
    kind: 'PREPINTADO',
    colorId: color.id,
  });

  // 2. Los SKU de accesorio ------------------------------------------------
  //
  // Bobina de 1 200 mm: la cumbrera de 300 mm da 4 piezas por pasada y la canaleta de 400,
  // 3. Son los dos números que el cliente va a ver en pantalla.
  const skus = [
    { sku: `${PREFIX}-CUMB-300`, name: 'Cumbrera demo 300 mm', developmentMm: '300.00' },
    { sku: `${PREFIX}-CANA-400`, name: 'Canaleta demo 400 mm', developmentMm: '400.00' },
  ];
  const products = [];
  for (const s of skus) {
    const product = await post('/catalog', {
      businessLineId: roofing.id,
      sku: `${s.sku}-${TAG}`,
      name: `${s.name} (DEMO)`,
      unit: 'MTR',
      source: 'MANUFACTURED',
      listPricePen: '28',
      finishId: finish.id,
      colorId: color.id,
      thicknessMm: '0.30',
      widthMm: '1200.00',
      roofingKind: 'ACCESORIO',
      developmentMm: s.developmentMm,
    });
    products.push(product);
    console.log(
      `  SKU ${product.sku}: desarrollo ${product.developmentMm} mm → ` +
        `${product.piecesPerPass} piezas por pasada · ${product.theoreticalKgPerUnit} kg/m`,
    );
  }

  // 3. Proveedor y bobina con saldo ---------------------------------------
  const supplier = await post('/suppliers', {
    // El código de proveedor son 3 a 6 **letras**, sin números: de ahí el tag en letras.
    code: `DMO${randomUUID()
      .replace(/[^a-z]/g, '')
      .slice(0, 3)
      .toUpperCase()}`,
    docType: 'RUC',
    docNumber: `20${Math.floor(100000000 + Math.random() * 899999999)}`,
    name: `PROVEEDOR ${PREFIX} ${TAG}`,
    creditDays: 0,
  });
  const purchase = await post('/purchases', {
    supplierId: supplier.id,
    businessLine: 'metallic-roofing',
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F900',
    number: String(Math.floor(100000 + Math.random() * 899999)),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [
      {
        description: 'Bobina prepintada demo para accesorios',
        qty: '1500',
        unit: 'KGM',
        unitPrice: '5.20',
        finishId: finish.id,
        widthMm: '1200',
        thicknessMm: '0.30',
        coilStatus: 'OPEN',
      },
    ],
  });
  await post(`/purchases/${purchase.id}/receive`, {});
  const coils = await get(`/coils?supplierId=${supplier.id}`);
  const coil = (coils.items ?? coils).find((c) => c.purchaseId === purchase.id);
  if (!coil) throw new Error('La compra no dejó ninguna bobina');
  console.log(`  Bobina ${coil.code}: ${coil.widthMm} mm × ${coil.thicknessMm} mm, 1500 kg`);

  // 4. Cliente de demo y pedido -------------------------------------------
  //
  // Ajuste 2 del dueño: rotulado, nunca un cliente real de la copia de producción.
  const customer = await post('/customers', {
    docType: 'RUC',
    docNumber: `20${Math.floor(100000000 + Math.random() * 899999999)}`,
    name: 'CLIENTE DEMO ACCESORIOS',
    creditDays: 0,
  });

  // 12 cumbreras de 3 m = 36 ML. Con 4 piezas por pasada son 3 pasadas de 3 m.
  const rows = [{ lengthMm: '3000.00', qty: 12 }];
  const meters = '36.000';
  const quotation = await post('/sales/quotations', {
    customerId: customer.id,
    issueDate: today(),
    items: [
      {
        productId: products[0].id,
        qty: meters,
        unitPricePen: '32',
        pieces: rows,
      },
    ],
  });
  const order = await post(`/sales/quotations/${quotation.id}/confirm`, {});
  const reservation = order.reservations?.[0];
  console.log(`  Cotización ${quotation.code} → pedido ${order.code} (${meters} ML)`);
  console.log(
    `  OP en cola: ${reservation?.productionOrderId ?? 'sin OP (revisar la reserva)'} · ` +
      `reserva ${reservation?.qty ?? '?'} ${reservation?.unit ?? ''}`,
  );

  console.log('\nListo. Para la demo:');
  console.log(`  · Catálogo → buscar "${PREFIX}"`);
  console.log(`  · Planta → pedido ${order.code} → montar la bobina ${coil.code}`);
  console.log(
    '  · Reportar 3 pasadas de 3.00 m → 12 piezas, 36 ML, 25.689 kg (lo mismo que reservó)',
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
