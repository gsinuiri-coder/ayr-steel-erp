// Proxy TCP con latencia fija delante del Postgres local (F8-R1).
//
// Docker responde en ~0 ms, así que una regresión que vive en «cantidad de round-trips» no se
// ve en local y aparece recién contra Neon (CI, producción). Este proxy le suma un retardo fijo
// a cada tramo en cada sentido para reproducir esa latencia de forma **repetible**: Neon varía
// hasta el doble entre corridas del mismo día y no sirve para comparar dos commits.
//
// El retardo se aplica por tramo y respetando el orden: un tramo nunca sale antes que el
// anterior del mismo sentido, así que el protocolo de Postgres (que puede encadenar mensajes)
// llega intacto.
//
// **Calibración en Windows.** `setTimeout` redondea a la granularidad del reloj del sistema
// (~15,6 ms), así que el retardo pedido no es el que se obtiene: medido con `SELECT 1` por
// Prisma, `--delay 1` da ~28 ms por consulta y `--delay 15` da ~57. Para simular ~30 ms de
// ida y vuelta (Neon desde us-central1) se usa `--delay 1`. Medir antes de confiar en un valor.
//
// **Contador de round-trips.** Además cuenta los mensajes que el cliente manda al servidor.
// Prisma usa el protocolo extendido y cierra cada consulta con un `Sync` ('S'); una consulta
// simple es un 'Q'. `syncs + simpleQueries` es la cantidad de idas y vueltas, que es lo que la
// latencia multiplica. Con `--stats-port` se leen por HTTP:
//   GET  http://127.0.0.1:<stats-port>/        → { syncs, simpleQueries, connections, open }
//   POST http://127.0.0.1:<stats-port>/reset   → pone los contadores en cero
//
// Uso: node scripts/latency-proxy.mjs [--listen 5435] [--target 5434] [--delay 1] [--stats-port 5499]
// Ver docs/ENTORNOS.md («E2E con latencia»).
import http from 'node:http';
import net from 'node:net';
import { DB_HOST, DB_PORT } from './local-docker-env.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

const LISTEN = arg('listen', 5435);
const TARGET = arg('target', DB_PORT);
const DELAY_MS = arg('delay', 1);
const STATS_PORT = arg('stats-port', 0);

const stats = { syncs: 0, simpleQueries: 0, connections: 0, open: 0 };

/** Reenvía `from` → `to` con `DELAY_MS` por tramo, sin reordenar. */
function pipeWithDelay(from, to, onChunk) {
  let lastDue = 0;
  from.on('data', (chunk) => {
    onChunk?.(chunk);
    const due = Math.max(Date.now() + DELAY_MS, lastDue);
    lastDue = due;
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, due - Date.now());
  });
  from.on('end', () => setTimeout(() => to.end(), Math.max(0, lastDue - Date.now())));
  from.on('error', () => to.destroy());
}

/**
 * Parser incremental de los mensajes cliente → servidor. El primer mensaje (startup, o el
 * pedido de SSL) no lleva byte de tipo: solo largo. Después, cada mensaje es tipo + int32.
 */
function clientMessageCounter() {
  let buf = Buffer.alloc(0);
  let startup = true;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (startup) {
        if (buf.length < 4) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = len >= 8 ? buf.readInt32BE(4) : 0;
        buf = buf.subarray(len);
        // 80877103 = SSLRequest: después viene otro startup sin tipo.
        if (code !== 80877103) startup = false;
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      if (type === 'S') stats.syncs += 1;
      else if (type === 'Q') stats.simpleQueries += 1;
      buf = buf.subarray(1 + len);
    }
  };
}

const server = net.createServer((client) => {
  const upstream = net.connect(TARGET, DB_HOST);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  stats.connections += 1;
  stats.open += 1;
  pipeWithDelay(client, upstream, clientMessageCounter());
  pipeWithDelay(upstream, client);
  const done = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('close', () => {
    stats.open -= 1;
    done();
  });
  upstream.on('close', done);
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(
    `Proxy de latencia: 127.0.0.1:${LISTEN} → ${DB_HOST}:${TARGET}, +${DELAY_MS} ms por sentido`,
  );
});

if (STATS_PORT) {
  http
    .createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/reset') {
        stats.syncs = 0;
        stats.simpleQueries = 0;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stats));
    })
    .listen(STATS_PORT, '127.0.0.1', () => {
      console.log(`Contadores en http://127.0.0.1:${STATS_PORT}/`);
    });
}

process.on('SIGINT', () => {
  console.log(`Cerrando proxy (${stats.open} conexiones abiertas)`);
  process.exit(0);
});
