# cc56 corte C (D-670) — AUTORREVISIÓN

Revisor: subagente nuevo, sin leer el handoff de implementación. **Es una lista de riesgos, no una
aprobación ni un pase cruzado.**

Alcance: `git diff origin/main...origin/cc56-c-cierre` (13 archivos, +684), leído desde
`origin/cc56-c-cierre`. No corrí nada contra ninguna base; lo que sigue es lectura de código.

Resumen: el corte es de solo lectura de verdad (un `findMany` y la llamada a `salesMargin`; no
toca ningún cálculo existente, el diff de `sales-margin.service.ts` es vacío). Permisos bien en
JSON y Excel. El riesgo está en **qué cuenta como «salió»**: se mira solo el despacho
**declarado** (`Dispatch.invoiceId`) y solo su fecha, nunca la cantidad. Eso da falsos «Todavía
sin salida» y falsos «todo salió».

---

## P1

### P1-1 — Un despacho normal no declarado se lee como «Todavía sin salida»

`apps/api/src/reports/undispatched-at-close.service.ts:38-41`, `undispatched-at-close.ts:41-45`.

`Dispatch.invoiceId` lo escriben solo el mostrador (D-099), D-213 al facturar (si el despacho ya
existía y se eligió), D-278/D-285 «a la fecha del comprobante» y el importador fiscal. El caso
típico de «facturado y no despachado» es el contrario: **la factura sale primero y el despacho se
crea después** desde el pedido (`DispatchesService.create`), y ese despacho queda con
`invoice_id = NULL` (D-205: el pedido, no el comprobante). Además un despacho solo puede declarar
un comprobante, así que con dos facturas cubiertas por un mismo despacho una de las dos nunca tiene
declarado.

Qué pasa: una factura de septiembre despachada el 20-09 por el flujo normal sale en el informe
como `SIN_SALIDA` («Todavía sin salida»), suma su venta al total y deja ver al contador mercadería
«en inventario al cierre» que salió el 20-09. Lo mismo con una despachada el 05-10: `SIN_SALIDA`
en vez de `DESPACHADO_DESPUES`. No se midió cuántas hay en producción; D-361 midió 0 sin declarar
**fuera del motor**, pero las líneas del motor (Coberturas Aluzinc) no entraban en esa medida.

Arreglo: medir primero en producción (lectura) cuántos comprobantes del mes tienen pedido con
despachos vivos y ningún despacho declarado. Después, decisión del dueño (regla 16): o un estado
aparte `SIN_DESPACHO_DECLARADO` con las fechas de los despachos vivos **del pedido**, rotulado como
del pedido (como `orderDispatches` de D-358), o el reparto de lo despachado entre comprobantes que
ya existe (`allocateUndispatched`, D-278). Inferir en silencio va contra D-205.

### P1-2 — La salida se decide por fechas, no por cantidades: un despacho parcial dentro del mes saca al comprobante entero

`apps/api/src/reports/undispatched-at-close.ts:41-45`.

`if (dates.length > 0 && after.length === 0) continue;` — basta **un** despacho declarado con fecha
≤ cierre para que el comprobante desaparezca, aunque haya cubierto una sola de sus líneas o parte de
la cantidad. Escenario: F con dos líneas; DES declarado el 20-09 lleva la línea 1; la línea 2 sigue
en almacén el 30-09 (y hoy). El informe no la lista. Ventas y margen sí lo sabe (`pendingDispatchByOrder`
compara facturado vs despachado por línea de pedido y marca `PARCIAL`), pero ese dato no viaja al DTO
por comprobante y este corte no lo vuelve a calcular. Simétricamente, `PARCIAL` («Parte salió
después del cierre») supone que el resto salió dentro, sin comprobarlo.

Arreglo: decidir por cantidad a la fecha de cierre: facturado por línea del comprobante (neto de NC
que acreditan cantidad, como `QTY_REASONS`) contra lo despachado con `dispatchDate <= to` en
despachos vivos. Con test unitario del caso «dos líneas, una despachada dentro».

---

## P2

### P2-1 — El «costo estimado» de un `PARCIAL` incluye lo que ya salió dentro del período

`undispatched-at-close.ts:53` (`estimatedCostPen: ... doc.costPen`).

`costPen` de Ventas y margen es el costo de **todos** los despachos declarados del comprobante
(y, con D-667, el de su OP). En `PARCIAL`, la parte despachada el 20-09 ya no está en el inventario
al cierre, pero su costo entra a la columna y al total, y el texto de la pantalla y del Excel dice
«esa mercadería todavía figura en el inventario al cierre». El total sobrestima.
Arreglo: costo por despacho (el `SUM` de `SALE` agrupado también por `d.id` y su fecha) y sumar solo
los de fecha > cierre; o rotular que en `PARCIAL` el costo es del comprobante entero. En las líneas
costeadas por el motor (D-667) no hay costo por despacho: decidir con el dueño.

### P2-2 — Comprobantes que nunca pueden «salir» quedan para siempre como «Todavía sin salida»

`undispatched-at-close.service.ts:27-37`.

- Comprobante sin pedido (venta directa / manual, bucket `doc:<id>`): no hay despacho posible.
- Comprobante solo de Servicios (`NOOP`, D-392) o de líneas «Sin línea» (D-398/D-419): no mueve
  kardex.
  Los dos inflan `totals.salesPen` y el recuento sin ser inventario. Arreglo: filtrar por líneas que
  llevan inventario (`carriesInventory` / `inventory_strategy <> 'NOOP'`) y sumar solo esa venta, o
  separarlos con su propio estado.

### P2-3 — Una NC del mismo período que anula o devuelve la factura no la saca

`undispatched-at-close.service.ts:30` (solo `FACTURA`/`BOLETA`).

F de 1 000 emitida el 10-09 y su NC 01 «anulación de la operación» o de devolución total el 15-09:
F sale como `SIN_SALIDA` por 1 000 aunque ya no hay nada vendido. Arreglo: netear la venta (y la
cantidad, junto con P1-2) con las NC vivas del período que referencian al comprobante, según su
motivo (D-663); como mínimo, una columna «NC» o excluir el comprobante acreditado entero.

### P2-4 — `withoutCostCount` mezcla «sin salida» con «no comparable / no rastreable»

`undispatched-at-close.ts:53, 61-70`; textos en `undispatched-at-close-xlsx.ts:45` y
`undispatched-at-close.tsx:117-119`.

Ventas y margen devuelve `costPen = null` también para los pedidos `NO_COMPARABLE` y `NO_RASTREABLE`
(`inTotals = false`). Un comprobante con despacho después del cierre en un pedido así sale
`DESPACHADO_DESPUES` con costo «—», se cuenta en `withoutCostCount`, y el pie dice «N sin salida (sin
costo)», que es falso: sí salió. Arreglo: contar aparte (`withoutCostCount` solo para `SIN_SALIDA`,
otro contador para «costo no comparable») y decirlo en el pie.

### P2-5 — Un despacho del mes revertido después del cierre borra la salida que hubo al cierre

`undispatched-at-close.service.ts:39` (`status: ISSUED`).

El informe es «a hoy», no «al cierre». Despacho declarado el 15-09, revertido el 05-10 (D-124: la
reversa va con fecha de hoy; además la reversa pone `invoiceId = null`,
`dispatches.service.ts:855`): al 30-09 la mercadería **no** estaba en el inventario, pero el informe
la muestra como `SIN_SALIDA` «todavía figura en el inventario al cierre». La reversa de re-fechado
(D-288, misma fecha) sí debe quedar fuera. Arreglo: considerar también los `REVERSED` cuya reversa
tiene fecha de operación > cierre (la fecha del movimiento inverso, no `reversedAt`); como el enlace
se borra al revertir, haría falta leerlo de la auditoría o del `ref_id` de los movimientos `SALE` —
si es demasiado, documentar la limitación en la nota.

### P2-6 — En el inventario valorizado faltan los comprobantes de meses anteriores aún no despachados

`apps/web/src/components/reports/undispatched-at-close.tsx:145-166`; comentario en
`inventario-valorizado-view.tsx:360`.

El comentario dice «qué parte del inventario al cierre de un mes ya estaba facturada», pero la
sección solo trae lo **facturado en ese mes**. Una factura de agosto que sigue sin salir el 30-09
también es inventario vendido al cierre de septiembre y no aparece. En Ventas y margen la pregunta
«del período» es correcta; en el inventario valorizado no. Arreglo: o el rango `from` = inicio del
histórico (`HISTORICAL_LOAD_START`) y `to` = fin del mes para esta vista (con el costo de
rendimiento que eso implica, ver P3-1), o cambiar el texto para que diga «facturado en el mes».

---

## P3

- **P3-1 Rendimiento** — `undispatched-at-close.service.ts:25`: recalcula `salesMargin` del período
  completo (≈10 consultas, incluido el motor) aunque la página de Ventas y margen ya lo acaba de
  pedir: dos veces por carga. Sin presupuesto de consultas probado por test (§3.4 / §6 lo piden
  para lecturas agregadas). Medir con el log de Prisma; si se adopta P2-6 con rango histórico, puede
  pesar. Arreglo mínimo: test de conteo (salesMargin + 1).
- **P3-2 Filtro «A costo»** — `ventas-margen-view.tsx:397`: la sección ignora `atCost`; con el
  filtro puesto muestra todo el período. Pasarlo o esconder la sección con el filtro.
- **P3-3 Descarga fuera de «Más opciones»** — `undispatched-at-close.tsx:52-56`: botón «Descargar
  Excel» suelto, con el `href` armado a mano en vez de `xlsxHref`; el estándar de cc47b (D-623..D-626)
  manda las descargas a `HeaderActions`. Como es una sección, puede ser aceptable; que lo decida el
  dueño.
- **P3-4 Mes vacío** — `undispatched-at-close.tsx:147,163`: si se borra el campo «Cierre de», la
  sección desaparece sin mensaje. `useState(previousMonth)` con `businessToday()` corre en SSR y en
  cliente; en el cambio de mes puede dar un desajuste de hidratación (despreciable).
- **P3-5 Despachos sin movimiento** — un despacho «entregado antes del inventario inicial» (D-278) o
  uno con línea sin salida de kardex (D-285) cuenta como «salida» por su fecha, aunque el kardex no
  la tenga; el texto dice «sale del kardex». Inofensivo en el sentido del informe, pero el rótulo es
  inexacto.
- **P3-6 Costo del motor oculto en `SIN_SALIDA`** — `undispatched-at-close.ts:53`: con D-667 un
  comprobante de Coberturas producido y sin despachar sí tiene costo de OP en Ventas y margen; se
  fuerza a `null`. Es justamente mercadería fabricada que está en inventario: el costo serviría.
  Decisión del dueño.
- **P3-7 Pruebas** — los unitarios cubren el armado puro, el día del cierre (≤ `to` es dentro), el
  orden, el Excel y el filtro de NC del servicio. Faltan: un db-spec con despachos reales (declarado,
  no declarado, revertido, dos líneas con un despacho parcial), el permiso 403 del VENDEDOR por HTTP
  (solo se lee el metadato de `@Roles`), y en el E2E los estados de error, vacío, `SIN_SALIDA` («—»)
  y el pie. El E2E con `page.route` no prueba el cálculo (lo dice), así que P1-1 y P1-2 no los
  atraparía ninguna prueba actual.

## Lo que está bien (comprobado leyendo)

- Solo lectura: `findMany` + `salesMargin`; ni el servicio de margen ni el inventario valorizado
  cambian (sus diffs son de 3 líneas de JSX).
- `@Roles(Role.ADMINISTRADOR)` en JSON y Excel, con test de metadato; las dos páginas que lo
  montan están en `RoleGate` solo ADMINISTRADOR.
- Fechas: `dispatchDate` es `@db.Date`, leído con `fromDateOnly` (UTC → `YYYY-MM-DD`), comparado
  como cadena con `to`; `formatDate` no usa `Date`. El despacho escribe su `SALE` con
  `operationDate = dispatchDate` (`dispatches.service.ts:418,465`), así que «fecha del despacho» =
  «fecha de salida del kardex» para los despachos con movimiento.
- Anulados, `REJECTED`, `DRAFT`, archivados y guías quedan fuera por heredar el filtro de Ventas y
  margen (`LIVE_DOCUMENT_STATUSES`, `archived_at IS NULL`, `doc_type <> GUIA`).
- Venta y costo son los de Ventas y margen «Todas» (sin `businessLine`), así que coinciden con el
  comprobante en ese reporte; `Decimal` en los totales; `@@index([invoiceId])` existe.
- Validación `from <= to` en el esquema; la sección de Ventas y margen solo con período válido y en
  «Todas».

## Resolución (cc56, antes del despliegue)

- **P1 de las dos (despachos no declarados y fechas en vez de cantidades):** el armado se rehízo **por cantidades** por línea
  de pedido: lo facturado hasta el cierre (factura y boleta vivas, también de meses anteriores) menos lo despachado hasta el
  cierre (despachos vivos, **declarados o no**, D-205). Lo pendiente se reparte desde la factura más reciente hacia atrás.
  Un comprobante del período entra si alguna línea queda pendiente; las líneas sin línea de pedido (servicios, ajustes) no
  cuentan, así que un comprobante solo de servicios no aparece.
- **PARCIAL sobrestimaba (P2):** el costo estimado es el de Ventas y margen en la proporción pendiente (por subtotal de las
  líneas); la venta sigue siendo la del comprobante completo y la nota lo dice.
- **Costo nulo mal rotulado (P2):** el pie dice «sin costo estimado» (incluye los no comparables).
- **Alcance de «del mes» (segundo modelo P1-1, autorrevisión P2-6):** el brief pide los comprobantes del mes; los de meses
  anteriores todavía pendientes cuentan para repartir lo despachado pero no se listan. Queda escrito en D-670.
- **Anotados sin cambio (P3):** un despacho del mes revertido después del cierre no cuenta como salida (el despacho no guarda
  la fecha de su reversa); una NC que acredita cantidad no se netea de lo facturado; `salesMargin` se calcula otra vez para
  la sección (sin presupuesto de consultas); la sección ignora «A costo» y la pestaña de línea (se muestra solo en «Todas»);
  el Excel va como botón propio de la sección, fuera de «Más opciones»; el mes inválido oculta la sección sin mensaje.
