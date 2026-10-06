# cc25 — Revisión de segundo modelo

Revisor: segundo modelo (Sonnet, contexto limpio). Alcance: `git diff 6d25cfea..HEAD` de la rama `cc25-cxc-merma` (M0 a M3 y el E2E), contra D-420..D-433 y las reglas duras de AGENTS.md. Esto no es la aprobación del dueño (AGENTS.md §2.2.3).

Verificado: `npx jest` de `coil-waste`, `receivables-aging` y `reports.controller` (4 suites, 34 pruebas, verdes) y `tsc --noEmit` de `apps/api` (sin errores). No se corrió E2E ni se levantó ningún servidor.

Conteo: P0 0, P1 1, P2 3, P3 6.

## Qué se comprobó y está bien

- **Escritura del kardex.** `PRODUCTION` de bobina es `OUT` con `refId` = reporte (`production.service.ts:717`, `roofing-production.service.ts:1290`). `SCRAP` del cierre de la OP es `OUT` con `refId` = orden (`production.service.ts:1072`, `roofing-production.service.ts:2147`) y la merma manual de RF-17 es `OUT` con `refId` = bobina (`coil-operations.service.ts:449`). `CLOSE_ADJUSTMENT` es `OUT` (faltante) o `IN` (sobrante) con `refId` = bobina (`coil-operations.service.ts:779`). La separación despunte/manual por a qué apunta `refId` (`coil-waste.ts`) es correcta, y el signo `IN` resta, `OUT` suma. Los `PRODUCTION` de producto terminado son `itemType PRODUCT`, así que el filtro `itemType: 'COIL'` los excluye.
- **Anulados.** `reversalOfId: null` más `reversals: { none: {} }` es el mismo criterio de «vivo» de D-291 (`production.service.ts:1660`). Cubre la anulación y el original. La venta entera usa el mismo filtro.
- **Auditoría de tolerancia.** `entity 'production_orders'`, `entityId` = orden y la acción coinciden con lo que escribe `roofing-production.service.ts:1416` y lo que lee el detalle de la OP.
- **CxC.** El saldo es el de cobranzas: la misma función, sin redondear de nuevo. Los tramos y los bordes (0, 30, 31, 60, 61, 90, 91) están bien. «Contado» vence en la emisión y el día de vencimiento no está vencido. `businessToday()` usa Lima y las fechas `@db.Date` se leen en UTC sin desfase. La regla del céntimo (`hasCollectibleBalance`) se aplica en la lectura compartida, así que el total coincide con las tarjetas de /cobranzas (el E2E lo comprueba, y `workers: 1` evita carreras).
- **Refactor de cobranzas.** `addPaymentInTx` usa `documentOwnerId` y `documentBalanceOf`, sin cambio de comportamiento. `loadCustomerSummaries` filtra lo mismo que antes. El saldo y el filtro `archivedAt` son idénticos al código anterior.
- **Seguridad.** Las tres rutas nuevas llevan `@Roles(Role.ADMINISTRADOR)` en la API, y el `sellerId` y las líneas se validan con Zod (400). La web usa `RoleGate` y el menú es solo de administrador.
- **Compatibilidad.** Ninguna parte de `apps/web`, `packages` ni `e2e` lee `roofingSalesPen` (grep vacío), así que quitar el alias no rompe a la web ya desplegada. Las rutas y campos nuevos son aditivos. API primero y luego web es seguro: una web vieja no los llama, y una web nueva contra una API vieja solo tendría 404 en pantallas nuevas.
- **Sin migración, sin escrituras.** Los reportes solo leen y el centinela de kardex no tiene escritores nuevos.

## Hallazgos

### P1-1. El teórico del reporte ya lleva el 1 % estándar: «% de merma contra el 1 % estándar» no mide lo que dice

`packages/shared/src/schemas/coil-waste.ts:26`, `apps/api/src/reports/coil-waste.ts` (`wastePct`, `overStandard`), `merma-view.tsx` (texto de cabecera y `PctBadge`), D-430.

D-165 (`production.ts:131-183`) calcula el kilo teórico de cada reporte con la densidad estándar (`densidad × 1,01`), es decir, con el 1 % de merma normal ya dentro. `NORMAL_SCRAP_RATE_PCT` está en el comentario de D-165: el kilo teórico «es lo que la bobina entrega de menos, no lo que la pieza pesa». Además, un reporte saca de la bobina exactamente su teórico (`mountedKgForReport`, D-246), así que `consumido − teórico` es 0 en el caso normal y el porcentaje del reporte se reduce a (despunte + ajuste de cierre) ÷ teórico.

Escenario: una bobina que se usó sin ninguna pérdida adicional muestra 0,00 %. Una con 1,5 % de pérdida adicional (2,5 % real contra la pieza) muestra 1,50 % y se pinta en rojo. Una con 0,9 % adicional (1,9 % real) no se marca. La etiqueta dice «contra el 1,00 % estándar», que da a entender que 1 % es el límite de la pérdida total, y no lo es: el 1 % ya se descontó dentro del teórico. Esto es una premisa de la D-430 («igual que el factor estándar 1,01 × teórico»), no un error de código, pero el umbral rojo y el texto pueden llevar al dueño a una lectura equivocada.

Sugerencia: antes del deploy, confirmar con el dueño qué quiere decir el umbral. Opciones: (a) rotular «merma adicional al 1 % estándar ya incluido en el teórico» y mantener el umbral; (b) comparar la merma total contra el teórico sin el 1 % (teórico ÷ 1,01). Registrar la respuesta como `D-nnn`. Si se mantiene, ajustar el texto de la pantalla para que no diga «contra el 1 % estándar» a secas.

### P2-1. Despunte y ajuste de cierre de una bobina se pierden si ese mes no tuvo producción de ella

`apps/api/src/reports/coil-waste.service.ts` (`production`/`coilIds`), `coil-waste.ts` (`byCoil` solo con `productionCoilIds`), D-425, D-429.

Una bobina se produce en septiembre y se cierra (despunte de la OP y `CLOSE_ADJUSTMENT`) en octubre sin producir en octubre. D-429 dice que el ajuste de cierre «aparece en el rango en que se cerró la bobina», pero D-425 solo deja entrar a la bobina con producción en el rango. En octubre la bobina no entra y su despunte y ajuste no aparecen en ninguna fila, ni se declaran como la bobina vendida. En septiembre la bobina entra, pero con su merma sin el cierre. El caso es normal: el cierre de una OP o de una bobina suele ser posterior a su última producción. No es inexacto (no se estima nada), pero es una omisión silenciosa que contradice D-429.

Sugerencia: declarar, igual que `soldWhole`, el total de despunte y ajuste de cierre del rango de bobinas sin producción en el rango (cantidad de bobinas, kg y códigos), sin meterlas en las filas. O registrar la decisión como `D-nnn`: el cierre solo cuenta con la bobina cuando también produjo en el rango.

### P2-2. El E2E de merma puede ser vacuo y no cubre el cuadre con el kardex en la base de la suite

`e2e/tests/reportes-cxc-merma-cc25.spec.ts` (test «merma: el consumo de cada bobina…»).

La base de E2E se recrea y la mayoría de las corridas no tendrá producción con rango desde 2026-01-01 en ambas líneas. Con `rows` vacío, los dos `for` no ejecutan ninguna aserción, y el test pasa sin demostrar el requisito del dueño. Además solo se revisan 8 bobinas por línea y el consumo se compara con el listado de movimientos de la API (otro código), no con un conteo independiente.

Sugerencia: que el spec cree una producción mínima (o falle si `rows.length === 0` en la línea que sí debería tener datos), y mantener las pruebas unitarias del ensamblador como la garantía principal. Que el rango del E2E no dependa de una fecha fija en 2026.

### P2-3. Efecto indirecto de D-421 sobre cobranzas: las tarjetas y la lista cargan ahora el pedido y el despacho de cada comprobante

`apps/api/src/invoicing/collectible-documents.ts:35-37` (el `include` común), `receivables.service.ts` (`loadCustomerSummaries`).

El `include` se compartió para el reporte, pero /cobranzas (`receivables()` y `totals()`, que se llaman en cada visita) no usa `salesOrder` ni `dispatch`. Prisma resuelve cada relación con una consulta adicional con `IN`, así que /cobranzas hizo dos o tres consultas más sobre el historial completo de comprobantes vivos. Es un número fijo, no una consulta por fila, y no cambia ningún resultado, pero es un costo nuevo en una pantalla que no cambió. La documentación (`collectible-documents.ts` y D-432) dice «una consulta», cuando son varias (una por relación).

Sugerencia: pasar un parámetro opcional `withOwner` a `loadCollectibleDocuments` y activarlo solo en el reporte; o medir el costo con el log de Prisma y dejarlo anotado. Corregir el texto «una consulta» a «una lectura».

### P3-1. El reporte de CxC pierde los selectores y las cifras mientras cambia el vendedor

`cuentas-por-cobrar-view.tsx` (`useQuery`, `queryKey` con el vendedor).

Al elegir un vendedor, la `queryKey` cambia y `data` queda `undefined`: desaparecen la tira de totales y las opciones del selector, y el `Select` queda con un valor que no está en la lista (en blanco) hasta que llega la respuesta. Lo mismo pasa si el `?vendedor=` de la URL es un id válido que ya no tiene saldo: el selector queda en blanco, no en «Todos». Sugerencia: `placeholderData: keepPreviousData`, y si el id no está en `data.sellers`, mostrarlo como «Vendedor sin saldo» o volver a «todos».

### P3-2. El nombre del vendedor sin usuario difiere entre el filtro y el detalle

`receivables-aging.ts` (`sellers`: «Usuario sin nombre»; `sellerName`: `null`). La opción del filtro y la columna «Vendedor» (guion) dicen cosas distintas para el mismo usuario inexistente. Unificar.

### P3-3. `overStandard` se calcula en la API y la web lo recalcula con `Number`

`merma-view.tsx` (`PctBadge`) usa `Number(pct) > Number(std)` y no `row.overStandard`. Funciona con dos decimales, pero son dos fuentes para la misma regla, y el total no tiene bandera propia. Usar `overStandard` en las filas y exponer lo mismo en los totales. Además la bandera se calcula sobre el porcentaje ya redondeado: 1,004 % se muestra como 1,00 % y no se marca (aceptable, pero conviene que D-430 lo diga).

### P3-4. `loadCollectibleDocuments` lee todos los comprobantes vivos, pagados o no

`collectible-documents.ts:50-63`. El filtro de saldo es en memoria, como ya hacía cobranzas, así que no es una regresión. Cuando el historial crezca, el reporte (que no pagina) arrastrará todo. Dejarlo anotado como deuda conocida junto al presupuesto de consultas.

### P3-5. El detalle de producción en la web usa el índice como clave para producciones sin reporte

`merma-view.tsx` (`key={p.reportId ?? \`sin-reporte-${i}\`}`). Es estable porque la lista llega ordenada y no se reordena en cliente, pero dos reportes distintos no pueden coincidir con el mismo id. Sin impacto actual.

### P3-6. El Excel convierte los importes a `number`

`receivables-aging-xlsx.ts` usa `num()` para celdas de dinero. Es el patrón de los demás reportes (`reports-xlsx.ts`) y es solo presentación, pero la suma de los tramos del Excel puede diferir en el último decimal del total de la pantalla si se suma en Excel. Sin acción si el dueño lo acepta.

## Veredicto

Sin P0. El cuadre pedido por el dueño se cumple en el código: el total de CxC es el de cobranzas por construcción (misma lectura, misma regla de céntimo y sin redondear dos veces), y el consumo de merma sale de los movimientos vivos `PRODUCTION` con el signo correcto. La seguridad (rol en la API), la compatibilidad de versiones y el refactor de cobranzas están bien.

**Aprobable para el deploy cuando se resuelva el P1-1**: no por un error de código, sino porque el umbral del 1 % se compara contra un teórico que ya contiene ese 1 %, y el dueño debe confirmar la lectura antes de que la pantalla marque bobinas en rojo. Los P2 (omisión declarada del cierre sin producción, E2E vacuo, costo extra de cobranzas) deberían entrar en esta entrega o registrarse como deuda con fecha. Los P3 son cosméticos.

## Resolución (sesión cc25)

- **P1-1:** confirmado en el código (D-165). El dueño decidió D-434: el porcentaje es «sobre el
  estándar», con un aviso de que el teórico ya incluye el 1 %, y el rojo aparece solo pasado el 1 %.
- **P2-1:** el dueño decidió D-435: la bobina entra también por despunte o por ajuste de cierre en
  el rango.
- **P2-2:** el E2E ahora compara el consumo de toda la línea contra el kardex de producción del
  rango, además de bobina por bobina. Sigue sin aserciones de merma si la base no tiene
  producción: la cifra con datos reales es el UAT del dueño en demo. Queda anotado.
- **P2-3:** el comentario dice ahora «un número fijo de consultas». Cobranzas suma relaciones
  fijas, no una consulta por comprobante. Se mide en demo.
- **P3-1:** `keepPreviousData` en CxC.
- **P3-2:** el mismo nombre de vendedor en el filtro y en el detalle.
- **P3-3:** la web usa `overStandard`, que ahora también está en los totales.
- **P3-4, P3-5 y P3-6:** anotados, sin cambio (P3-6 es el patrón de todos los Excel).
