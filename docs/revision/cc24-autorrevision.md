# cc24 — Autorrevisión del diff de reportes por línea

> **AUTORREVISIÓN.** La hizo un subagente nuevo que no escribió el cambio ni leyó el handoff de implementación (AGENTS.md §2, regla 2.1, criterio de D-248). Es una **lista de riesgos**, no un pase cruzado ni una aprobación. La revisión que cierra es la del dueño.

## Diff revisado

- `git diff cf9cc32..HEAD -- apps packages e2e` en la rama `cc24-reportes-linea` (HEAD `33769e96`),
  28 archivos, +1914/−161. Commits `fbc7ebf3` (D-412), `d590450a` (D-409), `d44536d9`
  (D-406/D-407/D-413..D-416), `96e04b1b` (D-417), `33769e96` (D-408/D-418).
- Contexto leído: filas D-398..D-418 de `docs/ARQUITECTURA.md` §0.2 y `AGENTS.md` §3. No se
  leyeron `docs/handoff/` ni `docs/PROGRESO.md`.
- También se leyó el código vecino que el diff usa sin cambiarlo: `costsByOrder` y
  `resolveCostStatus` de ventas y margen, las consultas 2 a 4 del motor de D-354
  (`factsByItem`, `coilUsage`), la escritura de kardex de la producción de Drywall
  (`production.service.ts`, `PRODUCTION`/`SCRAP`) y `useLineTab`/`useUrlState`.

## Corridas

| Comando                      | Dónde      | Resultado                           |
| ---------------------------- | ---------- | ----------------------------------- |
| `pnpm exec jest src/reports` | `apps/api` | 16 suites, 162 tests, todos verdes  |
| `pnpm exec vitest run`       | `apps/web` | 15 archivos, 96 tests, todos verdes |

No se corrió E2E (fuera del alcance de este pase).

## Resumen

| Severidad | Cantidad | Hallazgos                                                                                                                                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0        | 0        | —                                                                                                                                                                                                                |
| P1        | 0        | —                                                                                                                                                                                                                |
| P2        | 3        | P2-1 aviso de costeo falso en UPVC y Reventa; P2-2 pedido de solo Servicios contado como «fuera de los totales»; P2-3 «sin Servicios» frente a servicios sin producto                                            |
| P3        | 4        | P3-1 «Total del rango» del Excel sin rótulo; P3-2 deriva de redondeo en el cuadre por producto; P3-3 «Sin línea» de la pantalla frente al de ventas y margen; P3-4 «Total general» de bobinas ahora es por línea |

Lo que se verificó y **no** dio hallazgo:

- **Coberturas Aluzinc sin regresión.** `inEngine(METALLIC_ROOFING)` arma el mismo SQL que el
  `IN_ENGINE` anterior. `toInvoiceLine` solo cambia la rama cuando `product_line = 'drywall'`.
  El Excel lee `lineSalesPen`, que vale lo mismo que el viejo `roofingSalesPen`, y el
  controlador descarta `businessLine`. La rentabilidad de un comprobante (C06) sigue
  filtrando por `in_engine`: una línea de Drywall no entra al motor aunque ahora reciba
  `kind = 'PERFIL'`.
- **«Todas» de ventas y margen (D-409/D-412).** Con un pedido excluido que tiene Servicios,
  `salesPen` suma esa venta una vez por `addNoCostSales`, y `excludedSalesPen` y
  `untraceableSalesPen` llevan solo el resto. La pestaña Servicios (`inTotals` verdadero)
  suma lo mismo. Se mantiene «pestañas + Sin línea = Todas». El margen
  (`salesPen − noCostSalesPen − costPen`) coincide con la suma de los márgenes de las filas
  de «Totales por línea» sin la de Servicios. El costo no cambia.
- **Signos.** Las notas de crédito restan en las tres consultas nuevas (`productLines`,
  `noLineSales` y la reutilizada `LINE_COLUMNS`), y el costo del despacho se toma neto de
  reversas por `COALESCE(m.reversal_of_id, m.id)`, igual que en `costsByOrder`. Un despacho
  anulado sale de la cantidad por `status = 'ISSUED'`, y su costo queda en cero porque la
  salida y su reversa se netean.
- **Joins.** `LINE_JOINS` y la CTE `cost` no duplican filas: `fiscal_document_items` llega a
  `sales_order_items` y `coils` por clave única, y cada movimiento llega a un solo
  `dispatch_items` por `movement_id`. El `FULL JOIN qty/cost` es por
  (comprobante, producto).
- **Perfil de Drywall (D-414).** `factsByItem` y `coilUsage` leen bien la producción de
  Drywall: la OP lleva `reservation_id`, el reporte escribe `PRODUCTION` con
  `refId = report.id` (salida de fleje `COIL` y entrada `PRODUCT` en piezas) y el cierre
  escribe `SCRAP` con `refId = orderId`. El `ADJUST` del cierre lleva `refId = orderId` y no
  entra a «producido». La base es en piezas, contra lo facturado en piezas. Sobre el teórico,
  `perfilTheoreticalKg × kgShare` suma exactamente piezas × `piece_weight_kg`.
- **Permisos.** `sales-by-material` y su `xlsx` siguen con `@Roles(ADMINISTRADOR)`. El
  reporte de bobinas sigue enmascarado para SUPERVISOR_PLANTA: `businessLine` no es dato de
  costo.
- **Decimal.** No hay `number` para dinero, kilos ni cantidades. Los `Number(...)` que quedan
  ordenan espesores en la UI o leen `order_count`.
- **URL.** Se mantiene la pestaña con `push` y los filtros con `replace`. `keep` conserva el
  rango (ventas por material) y el mes (bobinas) y descarta tipo, espesor y color. Una línea
  inválida se corrige con `replace`.

## Hallazgos

### P2-1 — En Coberturas (UPVC) y Reventa, la pantalla dice que el costo sale de las bobinas consumidas

`apps/web/src/app/(app)/reportes/ventas-material/ventas-material-view.tsx:165` y `:268`.

El subtítulo («peso real y costo de las bobinas que consumió la producción») y
`PROFIT_SOURCES_NOTICE` («Ventas por material … costean con los kilos de bobina consumidos.
Ventas y margen costea con el costo promedio del producto…») se muestran en las cuatro
pestañas. En las pestañas por producto (D-417) el costo es justamente la salida de kardex del
despacho, el mismo origen que ventas y margen. El aviso explica una diferencia que en esas
pestañas no tiene esa causa: si las cifras difieren, es porque solo cuentan los despachos que
**declaran** el comprobante.

**Escenario:** el dueño abre Reventa, ve una utilidad distinta de la de ventas y margen y el
aviso le dice que es por los «kilos de bobina». La causa real es un despacho que no declara
comprobante y que acá va a «No trazable».

**Arreglo sugerido:** cuando `byProduct` es verdadero, usar un subtítulo y un aviso propios.
Por ejemplo: «costo de kardex de los despachos que declaran el comprobante; lo que ningún
despacho declara va a No trazable».

### P2-2 — Un pedido de solo Servicios con comprobantes fuera del rango cuenta como «fuera de los totales» aunque toda su venta sume

`apps/api/src/reports/sales-margin.service.ts:517-531`, junto con `resolveCostStatus`
(`:695-707`).

Servicios no deja salidas `SALE` (NOOP), así que `costByDocument` nunca tiene sus
comprobantes. Un pedido que solo tiene Servicios y que se factura en dos meses
(`hasOutside`) termina en `NO_COMPARABLE`. En «Todas», D-412 suma toda su venta arriba, pero
el pedido igual entra a `excludedOrderCount += 1` con `excludedSales += 0` y se lista en
«Facturación parcial en el rango». El Excel también lo cuenta en «Pedidos fuera de los
totales».

**Escenario:** un servicio facturado en dos cuotas, en septiembre y en octubre. En el reporte
de octubre aparece «1 pedido fuera de los totales» con «venta excluida: S/ 0,00», y su fila
muestra la venta entera. El texto agregado (`SERVICES_STILL_COUNT`) lo explica a medias, pero
el contador y la sección siguen diciendo que el pedido quedó fuera.

**Arreglo sugerido:** en «Todas», cuando `sales.minus(noCost)` es cero, no contar el pedido ni
listarlo como excluido (o marcarlo `inTotals: true`, como en la pestaña Servicios). Sumar un
test unitario de un pedido de solo Servicios con `hasOutside`.

### P2-3 — «Margen (sin Servicios)» sigue incluyendo los servicios escritos a mano

`apps/web/src/app/(app)/reportes/ventas-margen/ventas-margen-view.tsx:161-166` y
`sales-margin.service.ts:575-581`.

`noCostSalesPen` lleva solo la línea de negocio `services`. Una línea libre del comprobante,
como un servicio escrito a mano, cae en «Sin línea (servicios y ajustes)» (D-398) y sigue
dentro del margen con costo 0. Así la infla igual que lo hacía Servicios antes de D-409. El
rótulo «sin Servicios», al lado de un grupo que se llama «…servicios y ajustes», se presta a
leer que se excluyó todo servicio.

**Escenario:** una factura con una línea libre «Instalación» por S/ 500 sube el «Margen % (sin
Servicios)», aunque el rótulo diga que los servicios no están.

**Arreglo sugerido:** decisión del dueño (D-230). Las opciones son precisar el rótulo («sin la
línea Servicios») o excluir también «Sin línea» de la base del margen. No se toca sin una
`D-nnn`.

### P3-1 — En el Excel, la fila «Total del rango» muestra un margen que no es venta − costo

`apps/api/src/reports/reports-xlsx.ts:239-251`.

La fila lleva la venta con Servicios, el costo y el margen sin Servicios, bajo el encabezado
«Margen (S/)». La fila siguiente lo aclara, pero quien haga la resta en la planilla ve una
diferencia sin explicación en la misma fila.

**Arreglo sugerido:** rotular la fila «Total del rango (margen sin Servicios)», o agregar la
columna «Venta con costo».

### P3-2 — El cuadre por producto puede apartarse en 0,0001 con despacho parcial

`apps/api/src/reports/sales-by-product.ts:148-170`.

Con `fraction` no exacta (por ejemplo 1/3), la venta trazada (sumada por SKU y redondeada una
vez) y la no trazable (redondeada por comprobante) pueden sumar 0,0001 más o menos que
`lineSalesPen`. Ese es el mismo cuadre que el E2E `reportes-por-linea-cc24.spec.ts:157` exige
**exacto** con `toFixed(4)`. Con los datos de E2E no pasa. Con datos reales, puede fallar o
mostrar un céntimo fantasma. El motor de D-354 tiene el mismo riesgo desde antes.

**Arreglo sugerido:** calcular la parte no trazable como `g.sales − parte trazada` ya
redondeada, o dar al E2E una tolerancia de 0,0001 por línea, con el criterio de D-402.

### P3-3 — El aviso de «venta sin línea» no coincide con la fila «Sin línea» de ventas y margen

`apps/api/src/reports/sales-by-material.service.ts` (`noLineSales`) frente a `lineTotals` de
ventas y margen.

`noLineSalesPen` suma las líneas libres de **todos** los comprobantes del rango. En ventas y
margen, la fila «Sin línea» de «Totales por línea» solo suma las de los pedidos dentro de los
totales: las de un pedido excluido quedan en la venta excluida. El aviso lleva a ventas y
margen, donde esa cifra no aparece tal cual.

**Arreglo sugerido:** decir «… incluida la de pedidos que ventas y margen deja fuera de sus
totales», o no prometer la cifra.

### P3-4 — «Total general» del reporte de bobinas ahora es el total de la pestaña

`apps/web/src/app/(app)/reportes/bobinas/reporte-bobinas-view.tsx` (StatStrip
`aria-label="Total general"` y el comentario de D-355 «El total general sigue siendo el de
todas»).

Desde D-418 la cifra es la de la línea elegida, y ya no hay una vista con las dos líneas
juntas en pantalla (la API sin `businessLine` todavía la da). El rótulo y el comentario quedaron
de cuando había un solo total.

**Arreglo sugerido:** rotular «Total de {línea}» y ajustar el comentario.
