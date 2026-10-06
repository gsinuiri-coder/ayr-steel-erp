# cc25: autorrevisión (CxC y merma)

> **Autorrevisión: lista de riesgos, no aprobación.** La hizo un subagente nuevo que no leyó el
> handoff de implementación (AGENTS.md §2.2, criterio de D-248). No vale como pase cruzado ni
> como revisión independiente.

- Rama: `cc25-cxc-merma`. Diff revisado: `6d25cfea..HEAD` (5 commits, 27 archivos).
- Contrato: D-420..D-433 (`docs/ARQUITECTURA.md` §0.2).
- Verificado en el repo: cómo se escriben `PRODUCTION`, `SCRAP` y `CLOSE_ADJUSTMENT` sobre `COIL`
  (`production/production.service.ts:709-722, 1064-1080`, `production/roofing-production.service.ts:1283-1300, 2140-2160`,
  `coils/coil-operations.service.ts:442-455, 769-782`), el reparto de `allocateStripKg`
  (`production/production-math.ts:35-71`) y la auditoría de tolerancia
  (`roofing-production.service.ts:1416-1420`).
- Corridas: `npx jest` sobre `coil-waste`, `receivables-aging*` y `reports.controller`: 4 suites,
  34 tests en verde. `tsc --noEmit` de `apps/api`: exit 0. No se corrió E2E ni se levantaron
  servidores.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 1        |
| P2        | 3        |
| P3        | 9        |

Sin P0. CxC cuadra con cobranzas por construcción: las dos usan `loadCollectibleDocuments`, y el
refactor de `ReceivablesService` da lo mismo que antes (el mismo `where`, el mismo `toFixed(4)`
antes de `hasCollectibleBalance` y la misma suma por cliente). El rol queda validado en la API
con `@Roles(ADMINISTRADOR)` en las tres rutas, y está probado en `reports.controller.spec.ts`.
Las consultas son fijas: 2 en CxC y como máximo 6 en merma. Ningún servicio nuevo escribe.
El riesgo principal está en qué movimientos de merma entran al rango.

---

## P1: debe corregirse (o decidirse) antes del deploy

### P1-1. El ajuste de cierre, el despunte y la merma manual de un rango sin producción de esa bobina no salen en ningún rango

- **Dónde:** `apps/api/src/reports/coil-waste.ts:67-70` y `:97-100` (`productionCoilIds` filtra
  todos los movimientos por «la bobina tuvo PRODUCTION en el rango»), y
  `apps/api/src/reports/coil-waste.service.ts:71-82` (sin producción, devuelve vacío). El test
  `apps/api/src/reports/coil-waste.service.spec.ts:281` lo deja fijado.
- **Contra el contrato:** D-429 dice que «dos rangos seguidos suman exacto» y que «el ajuste de
  cierre aparece en el rango en que se cerró la bobina». D-431 solo excluye a la bobina que
  tiene **solo merma manual**. No dice nada del ajuste de cierre ni del despunte.
- **Escenario:** la bobina B tiene su última producción el 28/09. La OP se cierra el 01/10 con
  15 kg de despunte (`SCRAP`, `refId` = OP), y la bobina se cierra el 02/10 con un
  `CLOSE_ADJUSTMENT` de 8 kg. En el rango de septiembre, B sale sin despunte ni ajuste (los dos
  movimientos son de octubre). En el de octubre, B no entra porque no tiene producción. Los
  23 kg no aparecen en ningún rango. Es el caso normal: casi siempre se cierra una bobina
  después de su última producción, y a menudo otro día.
- **Sugerencia:** pedirle la decisión al dueño (D-230). Hay dos opciones:
  1. Que entre al reporte toda bobina con `PRODUCTION`, `SCRAP` (de OP) o `CLOSE_ADJUSTMENT` en
     el rango. Si en ese rango no tiene teórico, se declara «sin producción en el rango»: su
     merma queda fuera del porcentaje, pero sus kilos se ven y entran a los totales de despunte
     y de ajuste.
  2. Corregir el texto de D-429 para decir que esas cifras solo se ven cuando cae producción en
     el mismo rango.

  Sea cual sea la decisión, hay que agregar un test con un ajuste fechado fuera del rango de la
  producción.

---

## P2: debería corregirse

### P2-1. El numerador y el denominador de la merma pueden ser de producciones distintas

- **Dónde:** `apps/api/src/reports/coil-waste.ts:116-129`.
- **Escenario:** la OP-1 sacó de la bobina B en septiembre (teórico 500 kg) y se cerró el 02/10
  con 20 kg de despunte. En octubre, la OP-2 sacó 100 kg de B (teórico 100). La merma de octubre
  queda en (0 + 20)/100 = 20 %, y lleva la marca «sobre el estándar», aunque el despunte es de
  otra producción. Al revés, en septiembre la OP-1 aparece sin su despunte y con una merma más
  baja de la real.
- **Por qué importa:** el porcentaje por bobina es la cifra que se va a mirar, y con esto un
  rango corto produce falsos rojos y falsos verdes. Es una consecuencia de D-429, pero el
  contrato no la menciona.
- **Sugerencia:** decírselo al dueño junto con P1-1. Como mínimo, en el detalle de la bobina,
  mostrar el despunte por OP (con su `refId`) para que se vea de qué orden viene. Otra opción es
  marcar la bobina cuando el despunte del rango es de una OP sin reportes en el rango.

### P2-2. Totales en dos bases distintas en la misma fila: «Consumido» es de todas las bobinas, y «Teórico», «Diferencia» y «Merma» solo de las comparables

- **Dónde:** `apps/web/src/app/(app)/reportes/merma/merma-view.tsx:130-134` (StatStrip) y
  `:224-231` (pie de tabla). `totals.comparableConsumedKg` viene en el DTO y no se muestra.
- **Escenario:** dos bobinas: A con 100 kg consumidos y 99 de teórico, y B con 50 kg
  consumidos y una producción sin teórico atribuible. El pie de tabla muestra Consumido 150,
  Teórico 99 y Diferencia 1, y quien lee espera 150 − 99 = 51. El aviso «N de M bobinas» sale en
  el pie, pero no en el StatStrip, que pone «Consumido en producción 150» al lado de «Teórico 99».
- **Sugerencia:** en el pie, mostrar `comparableConsumedKg` debajo del consumido total
  («de las comparables: …»), o calcular la diferencia contra ese valor de forma visible. En el
  StatStrip, rotular «Teórico (N de M)» cuando `missingCount > 0`.

### P2-3. Una bobina con producción a la que después se le vende el saldo «entera» sale del reporte, también en los rangos pasados

- **Dónde:** `apps/api/src/reports/coil-waste.service.ts:112-123` (cualquier `OUT SALE` vivo, sin
  fecha) y `apps/api/src/reports/coil-waste.ts:106-112`.
- **Escenario:** la bobina B se usó en producción en septiembre. En noviembre se vende el saldo
  como reventa: §7 dice que la reventa «se vende entera por su saldo vigente». Desde ese día, el
  reporte de septiembre ya no muestra la merma de B. Solo la declara en el aviso de «vendidas
  enteras», con su consumo. Un informe que ya se miró cambia después.
- **Sugerencia:** confirmar con el dueño si D-424 («la bobina vendida entera no entra») piensa
  en la bobina sin procesar o también en el saldo de una bobina ya usada. Si es solo la sin
  procesar, se excluye solo la bobina que no tiene `PRODUCTION` previa a la venta, o se excluye
  únicamente la salida `SALE` y la producción se deja.

---

## P3: menores

1. **Una bobina que no está en `coils` se cuenta como «vendida entera».**
   `apps/api/src/reports/coil-waste.ts:106`. En la práctica no debería pasar (la bobina sale de
   `coilIds`), pero si pasa, el aviso dice algo falso. Es mejor declararla aparte o fallar.
2. **«Vencido» en cobranzas y los tramos de CxC no coinciden para el contado (D-428).**
   `apps/api/src/invoicing/receivables.service.ts:273` no cuenta como vencido al contado, y
   `apps/api/src/reports/receivables-aging.ts:51` lo ubica en un tramo. El saldo total sí
   coincide. Lo «vencido» de las tarjetas de /cobranzas va a ser menor que la suma de los
   tramos 1–30 a «Más de 90». Está decidido, pero conviene una línea en la pantalla de CxC
   («vencido incluye contado; en Cobranzas no») para que nadie lo reporte como descuadre.
3. **El Excel muestra días negativos donde la pantalla dice «Por vencer».**
   `apps/api/src/reports/receivables-aging-xlsx.ts:78` escribe `d.daysOverdue` (por ejemplo,
   −15), y la pantalla (`cuentas-por-cobrar-view.tsx:303-309`) muestra «Por vencer». Hay que
   elegir uno de los dos criterios: 0 o vacío con el tramo al lado, o rotular «Días (− = por
   vencer)».
4. **Un vendedor en la URL que ya no tiene saldo deja el Select en blanco.**
   `cuentas-por-cobrar-view.tsx:92-107`. Las opciones salen solo de los vendedores con saldo, así
   que con `?vendedor=<uuid>` de alguien que ya cobró todo, el trigger queda vacío. El mensaje de
   la tabla sí lo dice. Se puede agregar la opción con el nombre «(sin saldo)» o volver a «Todos».
5. **`PctBadge` compara con `Number()`.** `merma-view.tsx:388`. Es solo presentación, pero el DTO
   ya trae `overStandard` por fila. Conviene usarlo en las filas y agregar un `overStandard` a los
   totales, en lugar de comparar en coma flotante (D-003 en espíritu).
6. **La API de merma no tiene tope de rango.** `coilWasteQuerySchema`
   (`packages/shared/src/schemas/coil-waste.ts`) acepta `from=2000-01-01`, que lee todo el kardex
   de producción de la línea. Es solo para el administrador y son consultas fijas, pero sin
   límite de filas. Se puede poner un tope (por ejemplo, 12 meses) o, por lo menos, medirlo.
7. **`loadCollectibleDocuments` sigue trayendo todos los comprobantes vivos, incluidos los ya
   pagados, con sus cobros y ahora también con `salesOrder` y `dispatch`.**
   `apps/api/src/invoicing/collectible-documents.ts:55-70`. Viene de antes (cobranzas ya lo
   hacía), pero cc25 le suma dos joins que /cobranzas paga sin usarlos y la lista crece con la
   historia. No es N+1. Conviene medir el tiempo en demo antes del deploy.
8. **El refactor de `ReceivablesService` no tiene spec propio.** El cuadre se prueba de forma
   indirecta en `receivables-aging.service.spec.ts:148`, pero ningún test unitario nuevo cubre
   `addPaymentInTx` con `documentBalanceOf` y `documentOwnerId`. El cambio es mecánico y lo leí
   línea por línea (`receivables.service.ts:148, 164`). Confirmar que el E2E de cobranzas corrió
   en la suite completa.
9. **E2E frágil o vacuo.** `e2e/tests/reportes-cxc-merma-cc25.spec.ts:62-66` compara el total de
   CxC con el de cobranzas en dos requests separados. Si otro spec en paralelo registra un cobro
   entre los dos, falla. El de merma (`:118-131`) pasa sin verificar nada si la base no tiene
   producción en el rango. Se puede afirmar `report.rows.length > 0` en al menos una línea, o
   sembrar un reporte. Tampoco hay un E2E de 403 para un no administrador (solo el unitario de
   decoradores). En drywall, la columna «Despunte» lleva la «merma de proceso» del cierre de OP
   (`production.service.ts:1072`): es una diferencia de rótulo que conviene confirmar con el
   dueño.

---

## Revisado sin hallazgos

- **Filtro de movimientos vivos:** `reversalOfId: null` y `reversals: { none: {} }`, el mismo
  criterio de `ProductionService.reportCoils` (D-291). La reapertura de una bobina revierte el
  `CLOSE_ADJUSTMENT` (`coil-operations.service.ts:847`), así que queda fuera.
- **Signos:** las salidas suman y las entradas restan. Un `CLOSE_ADJUSTMENT IN` (sobrante) resta
  (D-430), y `ADJUST` cuenta 0.
- **Despunte frente a merma manual:** se separan por `refId` (la OP o la bobina), y así lo
  confirman todos los escritores de `SCRAP` sobre `COIL` (hay tres).
- **D-433, reparto en varias bobinas:** `allocateStripKg` reparte exactamente
  `roundTo(needed, KG)`, y el `theoreticalKg` del reporte se graba con el mismo redondeo. Por
  eso `total.eq(theoretical)` se cumple siempre que no haya tope (D-246), y con tope cae en
  `SPLIT_NOT_THEORETICAL`, como pide el contrato.
- **Fechas:** `issueDate`, `dueDate` y `operationDate` son `@db.Date`, así que
  `toISOString().slice(0, 10)` es correcto. `businessToday()` es de Lima. Los bordes de los
  tramos (0/30/60/90) están probados.
- **CxC frente a cobranzas:** la misma lectura, el mismo umbral de medio céntimo, la misma
  exclusión de archivados y de notas de crédito archivadas, y `documentOwnerId` es idéntico a
  la regla en línea anterior.
- **M0:** no queda ninguna referencia a `roofingSalesPen` en `apps`, `packages` ni `e2e`. La web
  de `main` ya lee `lineSalesPen`, así que el orden API → web no rompe nada.
- **Seguridad:** `sellerId` se valida como uuid (400 en otro caso). Ninguna de las dos pantallas
  manda parámetros sin validar a la API.

## Resolución (sesión cc25)

- **P1-1:** D-435, decisión del dueño: la bobina entra por producción, despunte o ajuste de cierre.
- **P2-1:** consecuencia aceptada de D-429, escrita en D-435.
- **P2-2:** el pie de la tabla muestra cuánto consumieron las bobinas comparables.
- **P2-3:** D-436, decisión del dueño: la reventa no saca la bobina. Se retiró la consulta de
  ventas.
- **P3-1:** ya no aplica, porque no queda la rama «vendida». La bobina sin fila (imposible, por la
  FK) se salta.
- **P3-2:** la pantalla aclara que Cobranzas no cuenta el contado como vencido.
- **P3-4:** un vendedor sin saldo en la URL vuelve a «todos».
- **P3-5:** se usa `overStandard`.
- **P3-9 (E2E de merma):** reforzado con el total de la línea contra el kardex. En drywall, la
  columna se rotula «Merma de proceso».
- **P3-3, P3-6, P3-7 y P3-8:** anotados, sin cambio.
