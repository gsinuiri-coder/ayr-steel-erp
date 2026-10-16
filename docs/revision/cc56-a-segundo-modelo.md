# cc56 corte A — revisión de segundo modelo

Modelo: Sonnet (contexto limpio). Diff revisado: `origin/main...origin/cc56-a-cobranzas` (14 archivos, commit ec5e96fd). Solo lectura; no se corrió nada contra producción ni se leyó ningún `.env*`. No se ejecutaron las pruebas: la revisión es de lectura.

## Resumen

- **P0: ninguno.**
- **P1: ninguno.** La ruta de dinero es correcta en los casos revisados. Todo el lote va en una transacción, el sobrepago lo vuelve a validar `addPaymentInTx` con la cuenta bloqueada, y el candado vista previa → ejecución compara el plan dentro de la transacción antes del commit.
- **P2: 4 hallazgos.** Restos sub-céntimo, el tope de 600 s, el tipo de cambio por defecto y el bloqueo fuera de orden en el segundo plan.
- **P3: 6 hallazgos.**
- **Plantilla:** el ejemplo es ficticio (RUC `2000000000x`, «CLIENTE DE EJEMPLO SAC»). No hay datos reales en el diff. Las plantillas prellenadas y las vistas previas van a `local-data/cc56/`.
- **Refactor:** `addPaymentInTx` y `reversePaymentInTx` en compras y `reversePaymentInTx` en cobranzas conservan el mismo orden (claim → bloqueo → relectura → saldo → creación → auditoría). No hay regresión visible.

## P2

### P2-1. Restos sub-céntimo: se registra un pago de S/ 0.01 que no corresponde, o el lote se rechaza sin motivo

- **Archivos:** `apps/api/src/imports/opening-balances-plan.ts:154-156, 308, 328, 366`; `opening-balances.service.ts:146, 203`.
- **Cuentas por cobrar.**
  - `before = net − pagado` lleva cuatro decimales, y `cents()` lo redondea **hacia arriba**.
  - Un comprobante con resto de 0.0004 (el caso D-377: total importado con cola de diezmilésimas, `hasCollectibleBalance` = false) da `cents = 0.01`. `payableNow` también da 0.01, porque `payableBalance` redondea con ROUND_CEIL.
  - Con «faltantes pagado», o con un saldo declarado de 0, se registra **un cobro de S/ 0.01** sobre un comprobante que la app ya consideraba saldado.
  - Es un cobro espurio, que ensucia la cobranza y los reportes.
- **Cuentas por pagar.**
  - `payableNow` sale de `purchaseBalance`, que usa `money()` (a 2 decimales) y la tolerancia `CLOSING_TOLERANCE`. `before` sale de `p.total − paid`, sin `money()`.
  - Con total 100.0040 y nada pagado: `cents(before) = 100.01`, `payableNow = 100.00`, `room = 100.00`.
  - Una fila «saldo al corte = 0» calcula `toRegister = 100.01 > room`. El lote se rechaza con «habría que registrar 100.01 y hoy solo se puede 100.00», un mensaje que confunde.
- **Arreglo.**
  - Construir `before` con la misma regla que el saldo vigente del lado. En cobranzas, si `!hasCollectibleBalance(before)`, tratarlo como 0. En compras, `money()` más la tolerancia.
  - Un solo helper `owedAtCutoff(account)`, usado por `room`, `toRegister` y `outcome`.
  - Prueba: comprobante con total 118.0004 pagado 118.00; compra con total 100.0040.

### P2-2. El tope de 600 s de la transacción puede no alcanzar con volumen real contra Neon desde la PC

- **Archivo:** `apps/api/prisma/import-opening-balances-cli.ts:185, 250`; `opening-balances.service.ts:283-331`.
- **Escenario.** En una sola transacción, `run` ejecuta:
  - 2 planes completos, más `supplierAccounts` una tercera vez para la metadata;
  - por cada pago de cobranza: unas 5 a 7 consultas (claim, lock, lectura con include, create, audit);
  - por cada pago de compra: lo mismo.
  - A ~60-100 ms de RTT (la PC a Neon ya pasó el tope de 5 s en cc52), un lote de ~1000 pagos son 8-10 minutos.
  - Si se pasa, el `$transaction` revienta tras haber hecho casi todo el trabajo. El dry-run falla igual y el dueño no tiene vista previa.
- **Arreglo.**
  - Medir en demo con un lote del tamaño real antes de la ventana.
  - Subir el tope o avisar si `plan.payments.length` es mayor que un umbral (por ejemplo 400).
  - Reducir las 3 lecturas completas a una por lado, reutilizando el resultado.

### P2-3. Tipo de cambio por defecto de un pago en USD = el de la compra, no el de la fecha del pago

- **Archivo:** `opening-balances.service.ts:462-468` y `:344`.
- **Escenario.**
  - `addPayment` normal resuelve el TC por `rateFor(paymentDate)`. El importador usa el de la compra, o el de la fila si el Excel lo trae.
  - El monto va en la moneda de la compra, así que el saldo no cambia.
  - Pero `supplier_payments.exchange_rate` se persiste. Cualquier reporte que convierta el pago a soles (flujo de caja, estado de cuenta en PEN) quedaría con un TC distinto al de la fecha.
  - Es una decisión de negocio que no está registrada.
- **Arreglo.**
  - Dejarla escrita en D-668 y en la hoja «Instrucciones». O avisar (warning) por cada pago USD sin TC en la fila.
  - Verificar qué reportes leen `supplier_payments.exchange_rate`.

### P2-4. Bloqueo fuera de orden posible entre el primer y el segundo plan

- **Archivo:** `opening-balances.service.ts:295-299`.
- **Escenario.**
  - `lockDocuments` bloquea solo los comprobantes del **primer** plan.
  - El segundo plan se lee ya con el bloqueo, pero puede traer cuentas que el primero no traía. Por ejemplo, un NC o un cobro concurrente reabrió un comprobante entre las dos lecturas.
  - Esas cuentas se bloquean después, en `addPaymentInTx`, en orden de id pero detrás de las ya tomadas: el orden total deja de ser ascendente.
  - Con un cobro concurrente de la app que tome esos documentos en otro orden, hay riesgo de deadlock (la red NOWAIT no aplica aquí).
  - Es muy improbable (CLI de un solo operador), pero la regla 17 pide el conjunto completo al inicio.
- **Arreglo.**
  - Bloquear la unión de ids de comprobantes de **todas** las cuentas candidatas con fila en el Excel o con la política «pagado». Después, un solo plan.
  - O validar que el conjunto del segundo plan esté contenido en el primero, y si no, volver a empezar.
  - Las compras (`FOR UPDATE` por compra, en orden de id) quedan después de los comprobantes. Eso es coherente con «la compra es una rama aparte», pero conviene dejarlo escrito.

## P3

1. **Saldo declarado con más de dos decimales** (`opening-balances-plan.ts:206-212, 366`).
   - `parseRow` valida los decimales del monto de cobro pero no los del saldo.
   - `declared = 100.005` da `toRegister = 99.995`, que `toFixed(2)` redondea a `100.00`, con un cobro de céntimo desfasado.
   - Arreglo: aplicar el mismo `decimalPlaces() > 2` al saldo.
2. **El corte puede ser anterior a `HISTORICAL_LOAD_START`** (`opening-balances-plan.ts` y CLI).
   - Los cobros con fecha propia se validan contra el piso.
   - Los pagos de «saldo» y de «faltante» usan `date = cutoff` sin validar. `resolve()` los rechaza dentro de `addPaymentInTx` con un 400 genérico, en mitad del lote.
   - Arreglo: en el CLI, error temprano si `corte < historicalLoadStart`.
3. **Carrera entre dos ejecuciones simultáneas** (`opening-balances.service.ts:283-291`).
   - `liveBatches` y el chequeo de choque no están serializados.
   - Dos `--execute` simultáneos podrían pasar los dos. El segundo vería saldos ya cobrados, pero con «faltantes pagado» puede duplicar parcialmente.
   - Arreglo: `pg_advisory_xact_lock` al inicio de `run` y de `undo`.
4. **Lote «vivo» con todos los pagos ya revertidos a mano** (`liveBatches`).
   - Sigue contando como vivo y bloquea otro lote hasta pasar por `--deshacer`. Es seguro, pero conviene anotarlo en la salida o en el handoff.
5. **El deshacer falla entero si una compra se anuló después** (`reversePaymentInTx` de compras lanza «La compra está anulada»).
   - El lote no se deshace y el mensaje no dice qué compra es.
   - Arreglo: capturar y listar la cuenta, o saltarla con aviso.
6. **Huecos de pruebas.** No hay prueba para:
   - restos sub-céntimo (P2-1);
   - una compra en USD de punta a punta con el TC por defecto, en la `db-spec`;
   - el dry-run que revierte (nada queda en la base) a nivel de servicio;
   - el deshacer con una compra anulada;
   - el tope de tiempo con volumen;
   - el segundo plan con cuentas nuevas (P2-4).

## Verificado sin hallazgo

- **Dinero:** todo con `Decimal`. La suma de filas contra `room` impide el sobrepago, y `addPaymentInTx` revalida con la cuenta bloqueada.
- **Cobros ya hechos:** cobros y NC con fecha hasta el corte descuentan, y los posteriores solo acotan por `payableNow`. La NC posterior al corte tiene prueba.
- **Montos de fila:** `parseAmount` falla seguro con `1.234` (3 decimales, error) y con montos de más de 2 decimales.
- **Medio de pago:** el vacío cae en «Otro» con aviso.
- **Moneda y TC:** compras en soles ignoran el TC con aviso. El monto va en la moneda de la compra, sin conversión.
- **Duplicados:** un lote vivo del mismo lado bloquea otro, y las claves de idempotencia incluyen el id del lote.
- **Deshacer:** usa las reversas de dominio (la fila no se borra, D-061). Salta lo ya revertido y verifica que estén todos los ids del lote.
- **Candado de la ejecución:** `--execute` exige vista previa de la misma rama, commit limpio, mismos archivos (sha-256) y menos de 24 h. Compara el plan dentro de la transacción y revierte si difiere. La huella ignora el id del lote.
- **Seguridad:** sin credenciales en argv, el CLI pasa por `runApiCli` y `assertExecuteAllowed`, y no hay SQL contra producción. El kardex no se toca, así que el centinela no aplica.

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
