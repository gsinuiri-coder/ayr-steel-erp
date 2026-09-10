// Stub local de apis.net.pe para la suite E2E. **Solo escucha en 127.0.0.1.**
//
// Existe porque el padrón se consulta del lado del **API**, no del navegador (D-158: la fila
// manda el documento y el nombre lo trae el servidor). Un `page.route()` de Playwright no
// intercepta esa petición —nunca sale del navegador— así que el badge «Nuevo — se creará desde
// padrón» era la única rama de D-158 que ningún E2E podía ejercitar.
//
// Sirve los tres caminos que el ERP usa del proveedor: el padrón de RUC (D-067), el de DNI y el
// tipo de cambio SUNAT (D-029).
//
// **Qué documentos existen y cuáles no**, que es lo que hace útil al stub: un documento
// responde 200 con su razón social cuando termina en dígito **par**, y 404 cuando termina en
// **impar**. Así un test elige a propósito «este existe en el padrón» o «este no» sin listas
// que mantener, y la rama del alta express (D-156) se sigue pudiendo probar.
//
// Uso: node e2e/padron-stub.mjs [puerto]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3002);

/** Razón social determinística, para que el test pueda afirmar el texto exacto. */
function nameFor(docNumber) {
  return `PADRON STUB ${docNumber}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/v1/tipo-cambio-sunat') {
    // Mismo contrato que el real (verificado contra la API en la Fase 1): `compra`/`venta`.
    send(200, { fecha: url.searchParams.get('fecha'), compra: 3.7, venta: 3.75 });
    return;
  }

  const isRuc = url.pathname === '/v1/ruc';
  const isDni = url.pathname === '/v1/dni';
  if (!isRuc && !isDni) {
    send(404, { message: 'ruta no servida por el stub' });
    return;
  }

  const numero = url.searchParams.get('numero') ?? '';
  const lastDigit = Number(numero.slice(-1));
  if (!/^\d+$/.test(numero) || Number.isNaN(lastDigit) || lastDigit % 2 !== 0) {
    // 404 es lo que el servicio real devuelve para un documento que no está en el padrón, y
    // `DocumentLookupService` lo traduce a `NOT_FOUND` sin lanzar.
    send(404, { message: 'No se encontró el documento' });
    return;
  }

  send(
    200,
    isRuc
      ? {
          numeroDocumento: numero,
          razonSocial: nameFor(numero),
          direccion: 'AV STUB 123',
          estado: 'ACTIVO',
          condicion: 'HABIDO',
        }
      : {
          numeroDocumento: numero,
          nombres: nameFor(numero),
          apellidoPaterno: '',
          apellidoMaterno: '',
        },
  );
});

server.listen(port, '127.0.0.1', () => {
  console.warn(`Stub del padrón escuchando en http://127.0.0.1:${String(port)}`);
});
