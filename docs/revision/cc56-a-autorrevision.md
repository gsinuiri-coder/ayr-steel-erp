# cc56 corte A (D-668): autorrevisión

**Es una autorrevisión** de un subagente con contexto nuevo, que no leyó el handoff. Sirve como lista de riesgos y **no** como aprobación ni como pase cruzado.

Alcance: `git diff origin/main...origin/cc56-a-cobranzas`, leído con `git show origin/cc56-a-cobranzas:<ruta>`. No ejecuté pruebas ni comandos contra ninguna base.

## Resumen

| Sev | #   | Tema                                                                                                                                                                                                                                                                                                    |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | 0   | —                                                                                                                                                                                                                                                                                                       |
| P1  | 1   | Filas de cobro sumadas a cobros que ya están en la app con fecha hasta el corte: duplicado silencioso                                                                                                                                                                                                   |
| P2  | 6   | Cola sub-céntimo (D-377) con «pagado» / saldo 0 · fila vacía de un documento posterior al corte bloquea la plantilla prellenada · encabezados ausentes = todo «vacío» · total de proveedores que mezcla monedas · TC por defecto = el de la compra · compra con cola de diezmilésimas que rompe el lote |
| P3  | 9   | Orden de bloqueos y relectura (proveedores, cuentas fuera del primer plan), lotes concurrentes, corte anterior al piso, parseo, una sola opción de faltantes para los dos lados, cobertura                                                                                                              |

---

## P1

### P1-1. En modo «filas de cobro», los cobros ya registrados en la app con fecha ≤ corte se cuentan dos veces

- **Dónde:** `apps/api/src/imports/opening-balances-plan.ts:401-424` (rama de filas). `before = netAtCutoff − paidUpToCutoff` (`:308`) y las filas se registran **encima** de `paidUpToCutoff`.
- **Escenario:** la factura F1 es de S/ 1000. En la app ya hay un cobro de S/ 300 del 20/09, registrado desde el día D. El corte es el 30/09. El dueño llena la planilla con **todos** los cobros hasta el corte, que es lo que piden las instrucciones (`opening-balances-sheets.ts:228`: «Lo cobrado hasta la fecha de corte… una fila por cada uno»): 300 del 20/09 y 200 del 25/09. Entonces `before = 700`, `total = 500 ≤ room` y se registran 300 + 200. Queda cobrado 800 al corte cuando lo real es 500. No sale error ni aviso. Lo mismo pasa en compras.
- **Por qué es probable:** producción tiene cobros reales registrados desde 2026-09-07. Ni las instrucciones ni la plantilla prellenada le dicen al dueño que excluya lo que ya está en la app. La plantilla muestra «Saldo en la app» de **hoy**, pero no «Cobrado en la app hasta el corte». El modo saldo (B) sí está bien: descuenta `paidUpToCutoff`, y lo prueba `plan.spec.ts:140`. El modo filas no tiene prueba con `paidUpToCutoff > 0`.
- **Arreglo sugerido:** elegir una semántica y hacerla explícita. Una opción es (a) tratar las filas como la **historia completa** hasta el corte y registrar solo lo que falta, emparejando por fecha y monto con los cobros existentes y avisando de lo que no empareje. La otra es (b) mantener «solo lo que falta en la app»: en ese caso las instrucciones y la plantilla prellenada lo dicen, con una columna «Cobrado en la app hasta el corte» y sus cobros, y el plan emite **aviso** (o error) cuando una cuenta con `paidUpToCutoff > 0` trae filas de cobro. Hay que sumar un caso de plan y uno de db-spec.

---

## P2

### P2-1. Restos sub-céntimo (D-377): «pagado al corte» y «saldo 0» registran cobros de S/ 0.01 que no son deuda

- **Dónde:** `opening-balances-plan.ts:328` (`room = min(cents(before), payableNow)` con ROUND_CEIL), `:331-351` y `:363-398`.
- **Escenario:** un comprobante ya cobrado tiene un resto de 0.0001 (total de 4 decimales cobrado con 2). D-377 dice que eso no es deuda (`hasCollectibleBalance` con HALF_UP lo da en 0). Pero `cents(0.0001) = 0.01` y `payableBalance = 0.01`. Con `--faltantes pagado`, o con «Saldo pendiente al corte = 0», el plan registra un cobro de **S/ 0.01** en cada uno de esos comprobantes. `addPaymentInTx` lo acepta porque 0.01 ≤ payable, y el comprobante queda sobrecobrado en 0.0099. En la vista previa sale con «Saldo al corte antes 0.00 · Se registra 0.01».
- **Arreglo:** si `!hasCollectibleBalance(before)` (o del saldo de hoy), no se registra nada: el tratamiento es «sin saldo». En modo saldo, `toRegister` se calcula sobre el saldo redondeado HALF_UP cuando el declarado es 0. Hay que sumar el caso al spec del plan, que hoy solo prueba la cola hacia arriba (`plan.spec.ts:126`).

### P2-2. En la plantilla prellenada, una fila **vacía** de un documento emitido después del corte rechaza el lote entero

- **Dónde:** `opening-balances-plan.ts:292-299`, que marca error **antes** de ver si la fila está vacía. La plantilla prellenada trae todos los comprobantes y compras vivos sin filtrar por corte (`opening-balances.service.ts:110-161` y `:164-217`, usados en `import-opening-balances-cli.ts:156-157`).
- **Escenario:** el dueño genera la plantilla con `--corte 2026-09-30`. El 16/10 ya hay comprobantes emitidos en octubre. No los toca y devuelve el archivo. Cada fila vacía de octubre da «emitido el …, después del corte», así que hay N errores y no se registra nada. El spec (`plan.spec.ts:189`) solo prueba esa fila con `balance: '0'`.
- **Arreglo:** que una fila `EMPTY` de un documento posterior al corte se ignore (con aviso o sin él), o bien que la plantilla prellenada excluya lo emitido después de `--corte`. Mejor hacer las dos cosas.

### P2-3. No se verifican los encabezados: un Excel sin las columnas de monto y saldo pasa como «todo vacío»

- **Dónde:** `opening-balances-sheets.ts:42-72`. `getField` devuelve `''` cuando falta la columna y `required` nunca se comprueba. En el plan, `:180-184` y `:323` convierten esas filas en «no aparece».
- **Escenario:** el dueño usa su propio Excel con encabezado «Monto» o «Saldo» en vez de «Monto cobrado S/» o «Saldo pendiente al corte S/». Todas las filas quedan `EMPTY`. Con `--faltantes pagado` **se registra todo como cobrado entero**, sin un solo aviso; con `pendiente` el lote no hace nada y sale «sin errores». La vista previa solo lo deja ver en los conteos por tratamiento.
- **Arreglo:** antes de planear, exigir que estén el encabezado de la clave y al menos uno de los de monto o saldo. Y emitir un aviso por cada fila que trae clave pero solo medio o referencia, porque hoy cuenta como vacía y se pierde el dato (ver P3-6).

### P2-4. El total de pagos a proveedor suma soles y dólares en una sola cifra

- **Dónde:** `opening-balances-plan.ts:427` (`totalRegistered`), `opening-balances-report.ts:93` («por moneda de la compra X»), `opening-balances.service.ts:371` (`suppliersTotal` en la auditoría). La tabla de pagos del informe (`report.ts:111-116`) tampoco tiene columna de moneda.
- **Escenario:** se registran un pago de USD 1000 y uno de S/ 5900. La vista previa que aprueba el dueño dice «por 6900.00», y lo mismo queda en `audit_log`.
- **Arreglo:** totales por moneda (que el plan reciba la moneda de cada cuenta en `OpeningAccount`), columna de moneda en la tabla y en la auditoría.

### P2-5. El TC por defecto del pago en dólares es el de la **compra**, no el del día del pago

- **Dónde:** `opening-balances.service.ts:462-468` (`paymentRate`).
- **Escenario:** una compra en USD del 05/08 con TC 3.70, pagada el 20/09, sin TC en la fila. El pago queda con TC 3.70. El alta normal (`PurchasesService.addPayment`) usa `rateFor(paymentDate, USD)`. El saldo en dólares no cambia, pero el `exchange_rate` guardado del pago no es el del día. Si algún reporte, ahora o más adelante (flujo de caja en soles, diferencia de cambio), convierte pagos con su TC, va a leer otro número que un pago hecho por la pantalla. Además, para «pagado al corte» y para el modo saldo la fecha del pago es el corte, no la fecha real.
- **Arreglo:** usar el mismo `rateFor(date, currency)` que el alta normal (sin servicio externo, de la tabla de TC) o, como mínimo, emitir un aviso «TC de la compra» por pago y dejarlo registrado como decisión.

### P2-6. Una compra con resto de diezmilésimas rompe el lote con un error genérico

- **Dónde:** `opening-balances.service.ts:203` (`payableNow = payableBalance(purchaseBalance)`, ROUND_CEIL) frente a `purchases.service.ts`, `addPaymentInTx`, que compara `applied.gt(balance)` con el saldo **sin** redondear al céntimo.
- **Escenario:** una compra con `total = 1000.0050` (columna de 4 decimales, por ejemplo por la conversión de un pago cruzado o por un total importado). Entonces `room = 1000.01`, el plan registra 1000.01 y `addPaymentInTx` lanza `BadRequestException('El pago excede el saldo pendiente…')`. Como no es un `OpeningBatchRejected`, la CLI no escribe el informe RECHAZADO y solo muestra el mensaje. No corrompe datos (todo se revierte), pero bloquea la carga sin decir qué compra fue.
- **Arreglo:** en compras usar el piso al céntimo (ROUND_FLOOR o `money` a 2 hacia abajo) para `payableNow`, o alinear la comparación de `addPaymentInTx` con la de cobranzas (D-169). Envolver los errores de dominio por cuenta en `OpeningBatchRejected` con la clave.

---

## P3

1. **Regla 17 / D-474, proveedores sin bloqueo antes de releer.** En `opening-balances.service.ts:293-299` se bloquean solo los comprobantes y el plan de proveedores se relee **sin** las compras bloqueadas. Después, cada `addPaymentInTx` bloquea la suya y revalida contra el saldo de hoy, no contra el saldo al corte. Si entra un pago de compra concurrente con fecha ≤ corte entre el plan y el bloqueo, el cálculo al corte queda viejo. Arreglo: bloquear las compras del plan en orden de id al inicio y recién entonces volver a planear.
2. **Cuentas que aparecen solo en el segundo plan.** `service.ts:299` bloquea las del primer plan. Si el segundo plan trae otra cuenta, `addPaymentInTx` la bloquea después, posiblemente con un id menor que los ya tomados, lo que rompe el orden. Arreglo: rechazar si `second ⊄ first`, o repetir hasta que el conjunto se estabilice.
3. **Dos ejecuciones concurrentes.** `liveBatches` (`service.ts:220-241`) lee `audit_log` sin serializar. En cobranzas, el bloqueo y la relectura tapan casi todo. En compras (punto 1), dos `--execute` simultáneos pueden duplicar pagos si caben en el saldo de hoy. Arreglo: `pg_advisory_xact_lock` con una clave fija al inicio de `run` y de `undo`.
4. **Regla 17: falta el par concurrente.** El importador es un camino nuevo que toma documentos y no suma su par en `lock-order.db-spec.ts`, como pide la regla. Además toma comprobante → compra; conviene dejar escrito ese orden.
5. **Corte anterior al piso histórico.** La CLI (`import-opening-balances-cli.ts:202-204`) no lo valida. Los pagos `MISSING_PAID` y `BALANCE` van fechados al corte y no pasan por la comprobación del piso (`plan.ts:239`, que solo mira las filas). Fallan después en `operationDate.resolve` con un error genérico. Arreglo: validar `cutoff ≥ historicalFloor` en la CLI y en el plan.
6. **Parseo.** Hay seis casos:
   - Una fila que solo trae medio o referencia se toma como vacía, en silencio (`plan.ts:180-184`).
   - `S/.` (habitual en Perú) no se limpia y da «monto inválido» (`plan.ts:107`).
   - Un monto que sale de una fórmula con ruido binario (`295.00000000000006`) da «más de dos decimales» y obliga a redondear a mano.
   - El saldo declarado no valida decimales (`plan.ts:207`).
   - `rowNumber = i + 2` no coincide con la fila real cuando hay filas en blanco intermedias, porque `sheet_to_json` las salta (`sheets.ts:45`).
   - `parseSpreadsheet` corta en 2000 filas, que una planilla con varias filas por comprobante puede pasar.
7. **Una sola opción de faltantes para los dos lados.** `--faltantes` es la misma para cobranzas y pagos (`OpeningBatchInput.missing`). Si el dueño corre los dos archivos juntos con «pagado», también da por pagadas todas las compras ausentes. Hay que separarla por lado o advertirlo en la vista previa.
8. **La vista previa se reusa después de deshacer.** Tras `--deshacer`, la misma VISTA-PREVIA (de menos de 24 h) vuelve a habilitar `--execute`, y la huella coincide porque el estado volvió al de antes. Puede ser intencional; conviene dejarlo escrito o invalidarla al ejecutar (renombrarla o marcarla).
9. **Cobertura.** Falta probar lo siguiente:
   - P1-1 y P2-1 a P2-6.
   - «pagado al corte» contra una base real (el db-spec solo usa `PENDING`).
   - Una compra en USD en el db-spec.
   - `undo` con un pago ya revertido contra la base.
   - La CLI: candado, huella dentro de la transacción y deshacer en dry-run.
   - El par de bloqueos.

## Lo que revisé y no encontré roto

- **Refactor de `PurchasesService.addPayment` → `addPaymentInTx`:** hace lo mismo (monto aplicado con la moneda de la compra bloqueada, saldo revalidado bajo `FOR UPDATE`, idempotencia, auditoría D-638). `operationDate.resolve` se llama dos veces con la misma entrada, sin efecto.
- **Refactor de `reversePayment` → `reversePaymentInTx` en compras y en cobranzas:** el cuerpo es idéntico y los envoltorios conservan la transacción y el `findOne`.
- **Saldo al corte en cobranzas:** usa la misma regla que `documentBalanceOf` (NC vivas no archivadas, cobros no revertidos). Las NC posteriores al corte quedan fuera del neto y el tope `payableNow` evita sobrecobrar (con prueba en el db-spec).
- **Lote atómico:** un error de plan o de dominio revierte todo. Las claves de idempotencia caben en VarChar(100) y las referencias se recortan a 120 y 80, igual que las columnas.
- **Candado vista previa → ejecución:** compara rama, sha limpio, 24 h y sha-256 de los archivos, y vuelve a comparar la huella del plan dentro de la transacción antes del commit. El dry-run es el defecto, pasa por `assertExecuteAllowed` y `assertExternalOutputsOff`.
- **Deshacer:** usa la reversa de dominio, salta lo ya revertido, verifica el conteo y audita.

## Resolución (cc56, antes del despliegue)

Las dos revisiones del corte A se resolvieron así (commit «fix(cc56-a): hallazgos de las revisiones»):

- **P1-1 (autorrevisión), cobros contados dos veces:** si la cuenta ya tiene cobros (pagos) en la app con fecha hasta el
  corte, las filas de cobro son error y se pide «saldo pendiente al corte»; lo dicen también las instrucciones de la
  plantilla. Prueba en `opening-balances-plan.spec.ts`.
- **Restos de fracciones de céntimo (P2-1 en las dos):** un saldo al corte sin deuda cobrable (`hasCollectibleBalance`,
  D-377) cuenta como 0: no se registra un cobro de 0,01. En compras, lo que hoy se puede pagar se redondea hacia abajo
  (P2-6): el resto menor de un céntimo ya cuenta como saldado y `addPaymentInTx` no lo rechaza.
- **Plantilla prellenada devuelta sin tocar (P2-2):** la plantilla trae solo lo emitido hasta el corte, y una fila vacía
  de una cuenta posterior al corte se ignora.
- **Encabezados (P2-3):** sin la columna clave y al menos una de monto o saldo, la lectura se detiene con un mensaje.
- **Soles y dólares (P2-4):** totales por moneda en la vista previa y en la auditoría del lote; columna «Moneda».
- **TC por defecto (P2-5 / segundo modelo P2-3):** se guarda el de la compra (no cambia el saldo); cada pago en dólares
  sin TC en la fila deja un aviso, y queda escrito en D-668.
- **Bloqueos (segundo modelo P2-4, autorrevisión P3):** al inicio se toman todos los comprobantes que el lote puede tocar
  (emitidos hasta el corte con saldo), en orden, y un candado asesor serializa dos ejecuciones.
- **Rechazos de dominio:** nombran la cuenta que los causó.
- **P3 tomados:** corte anterior a `HISTORICAL_LOAD_START` se rechaza en la CLI; `S/.` se lee como monto.
- **Anotados sin cambio:** tope de 600 s con volumen alto (el lote real son ~135 cuentas; se mide en el dry-run real),
  lote con todos sus pagos revertidos a mano que sigue «vivo» (se deshace con `--deshacer`, que salta lo revertido),
  deshacer con una compra anulada después (falla entero y no escribe), `--faltantes` único para los dos lados (se puede
  correr un lado por vez), pruebas de USD de punta a punta y de la CLI.
