# cc34 corte 4 — autorrevisión

**Esto es una autorrevisión** (subagente nuevo, sin leer el handoff de implementación). Es una
lista de riesgos, no una aprobación ni un pase cruzado.

Alcance: commits `41977d4f` (fecha del TC, rótulo «Crédito sin vencimiento» en el estado de
cuenta del proveedor, aviso de comprobante duplicado con/sin ceros en el importador) y
`928bfba7` (`dashboards.db-spec` compara sentencias además del conteo). Revisado con
`git show <sha>:<ruta>`: el worktree `ayr-steel-erp-cc34` está en la rama `cc34-c3` y los dos
commits viven solo en `cc34-c4`, así que **no corrí jest** (habría probado el código de c3, no
el de c4, y la consigna prohíbe cambiar de rama). Los specs nuevos se revisaron leyéndolos.

## P0

Ninguno.

## P1

### P1-1 — `dashboards.db-spec`: causa probable de la diferencia de una consulta (evento `query` que llega después de que la promesa resolvió), sin corregir

- `apps/api/src/reports/dashboards.db-spec.ts:58-75` (`CountingPrisma`, `measure`), con
  `apps/api/src/reports/admin-dashboard.service.ts` (`Promise.all` de los seis reportes) y
  `plant-dashboard.service.ts:41` (`Promise.all` de cola, órdenes, bobinas y merma).
- Prisma 6.19.3 con `prisma-client-js` sin `engineType` usa el motor _library_ (node-api). Los
  eventos `log: [{ emit: 'event', level: 'query' }]` los emite el motor Rust desde su hilo por una
  _threadsafe function_ propia, y la respuesta de la consulta vuelve por **otra** cola de
  node-api. Entre las dos no hay orden garantizado: el resultado puede resolver la promesa (y
  `measure` hacer `slice`) antes de que el callback del log se ejecute.
- Por qué encaja con lo observado, y no una consulta condicional a los datos:
  1. **El signo es siempre el mismo**: el Panel queda **una** por debajo (24/25 y 15/16), en los
     dos tests. Una consulta condicional a datos cambiantes daría a veces +1; con `--runInBand`
     (`apps/api/package.json`, `test:db`) no hay otra suite escribiendo a la vez, `JOBS_ENABLED`
     está apagado y `pg-boss` mockeado (`jobs.service.ts`, `invoicing-send.job.ts`,
     `quotation-expiry.job.ts` salen por el `catch` sin consultar), y no hay ningún `void
this.prisma…` suelto en `apps/api/src` que pueda colarse en una ventana.
  2. **Solo pega en la medición en paralelo.** En los reportes medidos uno por uno, un evento
     tardío del reporte k cae en la ventana del k+1 y el total de reportes no cambia (salvo el
     último, que caería en la ventana del Panel y daría Panel **+1**, nunca visto). En el Panel,
     con decenas de consultas en vuelo dentro de `Promise.all`, las señales de las dos colas se
     juntan en la misma vuelta del event loop y libuv atiende los _handles_ `uv_async` en orden de
     registro, no de señal: si el de respuestas va antes que el de logs, el evento de la
     **última** consulta del Panel se procesa después de que `measure` ya cortó. Las anteriores no
     se pierden porque llegan dentro de la ventana.
  3. **Depende de la máquina**: en local (más núcleos, otro pool —`connection_limit` por defecto
     es `núcleos × 2 + 1`— y otra latencia) las señales casi no coinciden; en el runner de 2–4
     núcleos sí, ~1 de cada 2.
  4. Ninguna de las seis lecturas tiene una rama que dependa del reloj ni del orden de las
     suites: `sales-margin.service.ts` (138-290), `coil-waste.service.ts` (80-124) y
     `receivables-aging.service.ts` (23) solo saltan consultas por listas vacías, y esas listas
     salen de datos que no cambian entre las dos mediciones; `businessToday()` en
     `receivables-aging.service.ts:33` e `inventory-valuation.service.ts:293` solo arma el DTO;
     no hay `findUnique` (el único método que Prisma agrupa en el mismo tick), todo es `findMany`
     o `$queryRaw`.
- Grado de certeza: **hipótesis fuerte, no demostrada** (no reproduje en CI). Lo que la
  confirmaría: con el `statementDiff` nuevo, la próxima falla debería decir `1 → 0: <sentencia>`
  con una sentencia **distinta** de una corrida a otra (la que más tardó), en vez de siempre la
  misma (que sería una rama condicional).
- Propuesta (corrige sin relajar): cerrar cada medición con una **cerca**. Tras `await run()`,
  mandar `prisma.$queryRawUnsafe('SELECT 1 AS measure_fence')` y esperar (bucle con
  `await new Promise((r) => setImmediate(r))`, con tope) hasta que esa sentencia aparezca en
  `statements`; los eventos salen por una única cola FIFO, así que todo log anterior ya está
  adentro. Cortar en la posición de la cerca y descartarla. El conteo y el multiconjunto siguen
  exigiéndose exactos. Hasta entonces, el test sigue rojo ~50 % en CI y el commit `928bfba7`
  solo mejora el mensaje: **no cierra el pedido 4** («encontrar la causa y corregirla»).

## P2

### P2-1 — El aviso de duplicado no reconoce el mismo tipo escrito distinto (`Factura` / `01`)

- `apps/api/src/imports/purchase-import.service.ts:113`: la clave usa
  `doc.docType.trim().toUpperCase()`. El agrupado de filas (`purchase-import-parse.ts:68-71`,
  `documentKeyOf`) y la validación (`purchaseDocTypeOf`, `purchase-import.ts:258`) sí pliegan
  `Factura`/`FACTURA`/`01` y `Boleta`/`Boleta de venta`/`03`.
- Escenario: fila 1 `01 | F001-00012`, fila 2 `Factura | F001-12`, mismo RUC. Son dos
  comprobantes en la vista previa, el segundo choca al confirmar
  (`purchase-document-clash.ts`) y **no hay aviso**.
- Propuesta: `purchaseDocTypeOf(doc.docType) ?? doc.docType.trim().toUpperCase()` en la clave, y
  un caso en el spec.

### P2-2 — Un aviso que garantiza que la confirmación falla, en un lote de todo o nada

- `purchase-import.service.ts:391-450` (`confirm`): solo los `error` bloquean antes de la
  transacción; el segundo gemelo entra a `createInTx`, `assertNoLiveDocumentClash` lanza 409 y
  `notImported` tira **el lote entero**. El aviso lo anticipa («el segundo choca con el
  primero»), pero no dice que no se importa nada.
- No es un defecto si la elección de aviso (D-543) fue del dueño; es un riesgo de UX: el usuario
  puede confirmar sabiendo que «un» comprobante chocará y perder todo el lote. Propuesta: o
  completar el mensaje («…y la importación no entra hasta corregirlo»), o confirmar con el dueño
  que D-543 contempló el todo o nada.

## P3

- **P3-1** `purchase-import.service.ts:113`: con el proveedor elegido a mano (`supplierId`) y
  `supplierRuc` vacío, dos comprobantes de proveedores **distintos** con la misma serie y número
  comparten clave (`|FACTURA|F001|12`) y se avisan como gemelos. Usar
  `doc.supplierId ?? doc.supplierRuc` (o la misma tupla de `livePurchaseKey`).
- **P3-2** El texto «(el mismo número sin ceros a la izquierda)» es falso si los dos están
  escritos igual. Desde la vista previa del archivo no pasa (se agrupan en uno), pero sí en la
  revalidación de comprobantes editados (`validate` recibe documentos del cliente) si el usuario
  edita uno para que quede idéntico a otro. Texto neutro: «el mismo comprobante».
- **P3-3** La serie entra sin `trim()` a la clave (`doc.series.toUpperCase()`); igual que
  `livePurchaseKey`, así que es coherente, pero `documentKeyOf` sí recorta. Sin efecto si el
  parser ya recorta la serie.
- **P3-4** `packages/shared/src/schemas/purchase.ts` (`supplierStatementSchema`, comentario de
  `overdueDays`): sigue diciendo «null si es al contado»; ahora null también es crédito sin
  vencimiento.
- **P3-5** `e2e/tests/cc34-estado-cuenta-credito.spec.ts`: la fila a crédito se fabrica
  interceptando la respuesta, así que el E2E prueba el rótulo del web, no que la API devuelva
  `overdueDays: null` para un CREDITO sin `dueDate` (lo hace, `purchases.service.ts:1563`, pero no
  hay test que lo fije). El total del encabezado tampoco suma la fila fabricada (no se afirma
  sobre él, así que no rompe).
- **P3-6** Fuera de alcance, solo para registro: `supplierStatement` calcula la antigüedad con
  `startOfDayUtc(new Date())`, no con el día de negocio de Lima (`businessToday`); entre las 19:00
  y las 24:00 de Lima la antigüedad de compras va un día adelantada.

## Verificado sin hallazgos

- **Fecha del TC** (`packages/shared/src/schemas/exchange-rate.ts`): reutiliza
  `isCalendarDate` de `operation.ts` (sin import circular: `operation.ts` solo importa
  `business-date`). La guarda `!regex || isCalendarDate` evita el doble mensaje, porque en Zod 3
  el `refine` corre aunque el `regex` haya fallado. Sigue siendo `ZodObject` en los dos schemas:
  `ZodValidationPipe` del controlador y el `zodResolver` de `tipo-cambio-view.tsx` no cambian de
  tipo. El spec cubre 31 de febrero/septiembre, día 32, mes 13, el 29 de febrero bisiesto y el
  mensaje de formato.
- **Estado de cuenta** (`estado-cuenta-view.tsx:146`): `noDueDateLabel` existe en `enums.ts:322`
  y se exporta; `paymentTerms` está en el DTO de la fila (`purchaseListItemSchema`); el
  comentario de línea dentro del paréntesis del ternario es JSX/TS válido. El resto de pantallas
  ya usan el helper o la misma regla (`cobranzas-view`, `comprobantes-view`,
  `cuentas-por-cobrar-view`).
- **E2E del estado de cuenta**: el endpoint interceptado coincide con el del `useQuery`
  (`/purchases/suppliers/:id/statement`, consulta en el navegador); el estado de cuenta incluye
  borradores (`status: { not: CANCELLED }`), así que `purchases[0]` existe; la regex de la fila al
  contado excluye `-CR` por _lookahead_ y el número es literal; limpia con anulación en `finally`
  y se salta contra producción.
- **Aviso de gemelos** (`purchase-import.service.ts:107-140`): el `Map` por identidad de objeto
  es correcto porque `validateAll` recorre los mismos objetos; aviso en los dos nombrando al
  otro; no cambia el agrupado; el spec fija los dos avisos y que el tercero no tenga ninguno.
  Corre igual en `preview`, `validate` y `confirm`.
- **`statementDiff`** (`dashboards.db-spec.ts:82-93`): el multiconjunto es más estricto que el
  conteo (dos sentencias distintas que se compensan ya no pasan); el `expect(... ).toEqual([])`
  da la diferencia legible; techos intactos.

## Qué se hizo con cada hallazgo

| Hallazgo                                         | Resolución                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 `dashboards.db-spec`                        | Corregido con la propuesta: cada medición termina con una consulta marcadora (`SELECT 1 AS measure_fence_n`) y la lista se corta cuando llega su evento; los eventos salen en orden entre sí, así que para entonces llegaron todos los de la medición. La igualdad exacta no cambia y el test compara además las sentencias. La causa (evento `query` del motor _library_ sin orden respecto del resultado) es la más probable y la única compatible con «siempre −1, solo en CI»; en local no se reprodujo (0 eventos tardíos en 30 mediciones ni con 16 Paneles en paralelo). Si volviera a fallar, `statementDiff` dirá la sentencia. |
| P2 tipo crudo en el aviso                        | Corregido: la clave usa `purchaseDocTypeOf` (como `documentKeyOf`), el proveedor elegido o el RUC, y la serie con `trim`. Test con «01» y «Factura» y con otro RUC (no avisa).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P2 aviso que garantiza el fallo                  | Corregido el texto: dice que la importación es todo o nada y que no entra ninguno. Se mantiene aviso (no error): es lo pedido («la vista previa avisa», D-543).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P3 proveedor elegido sin RUC / texto «sin ceros» | Corregido con la clave por proveedor elegido y el texto nuevo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P3 comentario de `overdueDays`                   | Corregido.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P3 test del API para `overdueDays: null`         | Sin cambio: el cálculo no cambió (sale de `dueDate`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P3 antigüedad en UTC                             | Fuera de la pieza.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
