# RF-S4b — Revisión cruzada (PR #14)

Fecha: 2026-09-23. Objeto: `git diff origin/main...origin/rf-s4b` sobre `7c0f124` (69 archivos).
Revisor: una sesión nueva de Claude Code que no escribió esta rama. Trabajé en un worktree aparte
(`ayr-steel-erp-rf-s4b-revision`, desanclado en `origin/rf-s4b`) y no modifiqué código de la rama.

> **Sobre la independencia (AGENTS.md §2.2).** El pedido la llama «revisión cruzada independiente».
> Hay que tener presente que es el mismo modelo que escribió el código, y que el arranque incluyó
> leer el handoff de implementación (lo pedía el prompt). Si esto vale como pase independiente o
> sigue siendo autorrevisión lo decide el dueño; este documento no se da por aprobado solo.

## Qué corrí

| Qué                               | Resultado                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI de `7c0f124` (run 35936319712) | **Verde** en los cuatro jobs (lint/typecheck/unit, E2E en Postgres del runner, smoke + migración en Neon `ci`, análisis estático) y en el quality gate de SonarCloud    |
| `pnpm --filter @ayr/api test:cov` | 929/929, 71 suites; `fix-lcov-paths` reescribió 33 rutas                                                                                                                |
| `pnpm --filter @ayr/web test`     | 11/11. La primera corrida falló por infraestructura: el `dist/` de `@ayr/shared` no estaba compilado en el worktree nuevo; con `pnpm --filter @ayr/shared build`, verde |
| `pnpm typecheck`, `pnpm lint`     | verdes                                                                                                                                                                  |
| Spec descartable (no commiteado)  | reproduce en ejecución los dos escenarios de P1-1 (ver abajo)                                                                                                           |

No corrí E2E en local ni nada contra Neon.

## Hallazgos

Orden: P1 primero (no hay P0), después P2. Hay dos tipos de «verificado». **En ejecución** quiere
decir que lo reproduje. **Leyendo** quiere decir que lo saqué del código y no lo corrí.

### P1-1 — El barrido empareja el papel con la línea solo por posición y nunca compara el producto

- **Dónde:** `apps/api/src/imports/imported-documents-sweep.service.ts:339-348` (`review`),
  `:373` (`coilish`) y `:437-444` (`fixQuotation`).
- **Qué pasa:** la línea `i` del documento se compara con la fila `i` del archivo. La única
  protección es que coincida la cantidad; el SKU o el producto no se comparan en ningún lado.
- **Escenario A (pedido; lo reproduje):** PED importado con L1 `PLA-X` de 100 u por S/ 5 000 y L2
  `PLA-Y` de 100 u por S/ 300. En el archivo, las filas del mismo comprobante están en el otro
  orden. Resultado: el execute llama a `restorePaperAmountsInTx` con **300 para L1 y 5 000 para
  L2**, y el pedido termina facturable con los importes cruzados.
- **Escenario B (cotización; lo reproduje):** una línea común (`PLA-X`, 100) cae en la misma
  posición que una fila `BOB38AZUL` de 100 del papel. Por ejemplo, alguien corrigió a mano el
  producto de esa fila cuando importó en agosto. `productFinding` la marca como (a) y
  `fixQuotation` la reescribe como **venta de 100 kg de la bobina azul**, en silencio. En un
  pedido no pasa: `updateItemCoilInTx` rebota porque el producto no tiene pool.
- **Agravante:** el dry-run no muestra el SKU del papel en (a) y tampoco muestra ningún SKU en
  (b). Con esa salida el dueño no tiene cómo notar el cruce antes de aprobar el execute.
- **Sugerencia:**
  - Emparejar por fila del papel y exigir, antes de proponer (a) o (b), que el producto de la
    línea corresponda al de esa fila. Sirve el SKU exacto, el mismo pool canónico o que la línea
    ya venda una bobina de ese pool.
  - Si no corresponde, mandar el documento a (c) con el motivo.
  - Imprimir en el dry-run el SKU de la línea y el del papel para cada hallazgo.

### P1-2 — Las CLI levantan la aplicación entera contra producción con las colas encendidas y la configuración local

- **Dónde:** `scripts/run-api-cli.mjs:47-60` (el `env` del hijo hereda `process.env` y solo
  pisa la base), `apps/api/prisma/*-cli.ts` (`import 'dotenv/config'` y
  `NestFactory.createApplicationContext(AppModule)`) y `apps/api/src/config/env.ts:33-36`
  (`JOBS_ENABLED` vale `true` por defecto).
- **Qué pasa:** al arrancar, `createApplicationContext` corre los `onModuleInit`. Con eso:
  - `JobsService` arranca pg-boss sobre el `DIRECT_URL` de **producción**.
  - `InvoicingSendJob` corre su «barrido de arranque» (`sendPending()`) y programa el reintento
    cada 15 min mientras la CLI viva.
  - `QuotationExpiryJob` queda programado.
  - En el barrido, `QuotationsService.update` sube el PDF regenerado a R2.
  - Todo eso toma PSE y R2 de lo que tenga `apps/api/.env` en la máquina de quien corre la CLI.
    `scripts/dev-demo.mjs:37-51` ya documenta que ese archivo puede traer el bucket real y
    `PSE_ENABLED`/`JOBS_ENABLED` en `true`, y por eso los apaga para demo. `run-api-cli` no los
    apaga.
- **Escenario:** el jueves, `pnpm sweep:imported … --branch production --execute`. Si el
  `.env` local tiene `PSE_ENABLED=true` con la cuenta demo de Nubefact, el barrido de arranque
  toma los comprobantes pendientes de **producción** y los manda a la cuenta equivocada. Además,
  los PDF de cotizaciones de producción terminan en el bucket que diga el `.env` local.
- **Límite de lo verificado:** no revisé qué trae `apps/api/.env`, porque AGENTS.md §3.1 prohíbe
  leerlo. El riesgo depende de su contenido.
- **Contexto:** `import:initial-inventory` (D-206) usa el mismo patrón, así que el problema es
  anterior a esta rama. Esta rama lo reutiliza para escribir documentos abiertos.
- **Sugerencia:** en `run-api-cli.mjs`, forzar `JOBS_ENABLED=false` y `PSE_ENABLED=false`, y
  fijar R2 de forma explícita (o vaciarlo: `generatePdf` ya tolera el fallo), como hace
  `dev-demo.mjs`.

### P1-3 — Un VENDEDOR puede marcar una cotización como «importada» y saltarse el piso; esta rama además le suma la venta parcial de bobina

- **Dónde:** `packages/shared/src/schemas/sales.ts:594` (`notes` es texto libre),
  `packages/shared/src/schemas/quotation-import.ts:435` (`isImportedQuotation` solo mira el
  prefijo) y `apps/api/src/sales/quotations.service.ts:224-238` (la edición toma `imported` de
  las observaciones guardadas).
- **Cómo se hace:** el VENDEDOR crea una cotización con observaciones `Factura externa: X`. El
  alta sí aplica el piso. Después la edita con precio bajo: como `imported` es verdadero, se
  saltea `priceFloor` y entra por `exactAmounts`.
- **Lo que suma RF-S4b:** con `exactAmounts`, una línea `saleCoilId` puede vender **cualquier
  cantidad ≤ saldo** (`sales-lines.ts:257-276`). D-116 exige vender el rollo completo. Al
  confirmar, el pedido hereda la marca y D-256 lo deja exento.
- **La premisa de D-163 no vale para este rol.** D-163 aceptó el riesgo diciendo que «el mismo
  usuario podía cambiar el margen mínimo», pero `PATCH /pricing/:businessLineId` es solo
  ADMINISTRADOR (`pricing.controller.ts:25-26`). Para un VENDEDOR es un bypass real.
- **Lo que sí está bien:** el precio del pedido lo edita solo ADMINISTRADOR
  (`sales.controller.ts:374-375`), así que por ese lado D-256 no amplía nada. Ningún documento
  gana la marca por la API si no la trae ya en las observaciones.
- **Límite de lo verificado:** lo verifiqué leyendo, sin reproducirlo con un usuario VENDEDOR.
- **Sugerencia:** en el alta y la edición por HTTP, rechazar las observaciones que empiecen con
  `EXTERNAL_INVOICE_NOTES_PREFIX` salvo que el documento ya la tenga (`keepImportMarker` la
  conserva). La otra opción es que el dueño vuelva a aceptar el riesgo como `D-nnn`, esta vez con
  la premisa correcta.

### P1-4 — Después del execute de la normalización, volver la API atrás deja de ser seguro, y el plan de la ventana dice lo contrario

- **Dónde:** `docs/handoff/rf-s4b.md:117-119` (Rollback). La API vieja, en `main`, resuelve el
  producto con `coilSkuFromTypeKey` (el SKU viejo) en `sales-lines.ts` y `coils.service.ts`.
- **Qué pasa:** la migración sí es aditiva y convive con la API vieja; eso lo confirmé. Pero una
  vez corrido `normalize:coil-skus --execute`, los productos quedan renombrados al canónico.
- **Escenario:** si después del execute hay que volver al SHA anterior:
  - Toda venta de bobina rebota con «no existe el producto de venta directa (BOBALZ-…0.38)».
  - Cada bobina que se reciba vuelve a crear con `upsert` el producto con SKU viejo, así que el
    catálogo se duplica.
  - No hay herramienta para revertir la normalización. «Deshacer desde la auditoría» implicaría
    SQL a mano contra producción, que la regla 3 prohíbe. Restaurar la rama de respaldo pierde
    todo lo cargado después.
- **Sugerencia:**
  - Escribir en el runbook que el execute es un **punto de no retorno** para la API.
  - Poner un smoke de solo lectura de la API nueva **antes** de los execute. Hoy el paso 8, el
    `smoke:prod`, va después.
  - Si se quiere retorno, hace falta una reversa por servicio (renombre y des-unión auditados)
    lista antes de la ventana.

### P2

| #   | Dónde                                                                              | Escenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sugerencia                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sales-lines.ts:257-276`, `quotation-import.service.ts:710`                        | **D-254 solo lo aplica el servidor en la edición de pedido** (`updateItemCoilInTx` exige estar en `coilPoolFor`). En el confirm del importador y en la edición de una cotización importada, una línea del papel acepta **cualquier** bobina abierta, sin montar y con disponible ≥ cantidad. Queda afuera el espesor exacto, el color, estar sin reserva de otro y no estar atada a otra cotización abierta. Un request armado a mano (o un preview viejo) ata «BOB38AZUL 1 000 kg» a una bobina 0.45 ROJO, y el producto facturado sale de esa bobina. | En la rama del papel, recalcular el pool de la fila (o de la línea) y exigir que la bobina sea parte de él.                                                           |
| 2   | `coil-sale-product.ts:397-423`, `sales-order-edits.service.ts:354-375`             | **Concurrencia.** No hay lock ni constraint entre previews ni al confirmar cotizaciones: dos importaciones con los previews abiertos a la vez eligen sola la misma bobina y confirman las dos. Entre pedidos, `createReservations` bloquea la bobina y compara el disponible, así que el kardex no se sobre-reserva. Pero con cantidades parciales dos pedidos pueden reservar partes del mismo rollo, en contra de «una bobina, un documento».                                                                                                         | Aceptarlo como está (el kardex está protegido) o revalidar la exclusividad dentro del lock de `reserveLines`. Se puede anotar en D-254.                               |
| 3   | `coil-sku-normalization.service.ts:329-360` y `product-merge.ts:126-142`           | El dry-run no predice la parada «producto a unir con saldo o reservas propias»: la detecta `mergeProductInto` recién en el execute. El dry-run sale limpio, el execute se cae entero (hace rollback, sin estado parcial) y la ventana se frena sin haberlo visto venir.                                                                                                                                                                                                                                                                                 | Contar movimientos y reservas de tipo PRODUCT en `buildPlan` y listarlos como paradas.                                                                                |
| 4   | `imported-documents-sweep.service.ts:224`, `coil-sku-normalization.service.ts:130` | Los dos execute **recalculan** el plan en vez de ejecutar el que el dueño aprobó. Si algo cambia entre el dry-run y el execute (por ejemplo, un vendedor edita), se aplica una lista que nadie vio.                                                                                                                                                                                                                                                                                                                                                     | Imprimir un resumen o un hash del plan en el dry-run y exigir que el execute lo reciba y coincida.                                                                    |
| 5   | `imported-documents-sweep.service.ts:463`                                          | En las cotizaciones, lo que corrige el barrido queda auditado como un `sales.quotation.update` común, sin el motivo «Barrido…». En los pedidos sí lleva `reason`. Después no se puede separar el barrido de una edición manual.                                                                                                                                                                                                                                                                                                                         | Pasar el motivo a la auditoría de la edición, o escribir un evento propio.                                                                                            |
| 6   | `nubefact-payload.ts:155-158`                                                      | `subtotal`, `igv` y `total` salen como `Number(...)` con 3-4 decimales (el trío del papel guarda `2239.169`). El mismo manual que cita D-255 dice «hasta con 2 decimales». `precio_unitario` a 10 decimales por `Number` pierde precisión con importes grandes. El PSE está apagado en producción, así que hoy no pega.                                                                                                                                                                                                                                 | Antes de encender el PSE, `pnpm e2e:pse` en demo con una línea importada de 3 decimales. Ya figura como pendiente en la autorrevisión; acá queda el caso concreto.    |
| 7   | `coil-sale-product.ts:316`, `catalog.service.ts:236`                               | `openCoilCodesInPool` solo mira bobinas `OPEN`, y D-116 también vende `CLOSED` con saldo. Si solo quedan cerradas con saldo, el `BOB…` se deja desactivar y esas bobinas quedan sin producto de venta. Antes de la normalización, desactivar el viejo también se rechaza aunque el canónico siga activo.                                                                                                                                                                                                                                                | Incluir `CLOSED` con saldo en el rechazo.                                                                                                                             |
| 8   | `quotation-import.service.ts:393-396, 411-414`                                     | Cualquier fila con «BOBINA» en la descripción entra por el camino de bobina, aunque su código no sea `BOB…` (un servicio «CORTE DE BOBINA», por ejemplo). Queda en error en vez de resolver a su producto. Con cantidad ilegible, el pool se calcula para 0 kg y puede elegir solo.                                                                                                                                                                                                                                                                     | Decidir por el código, con la descripción solo como respaldo cuando el código ya es `BOB…`. Con cantidad ilegible, no elegir solo.                                    |
| 9   | `sales.ts:173-184, 285`                                                            | `paperTriplet` admite ±0.01 de IGV por línea, así que un cliente de la API puede recortar un céntimo por línea (acotado por `MAX_SALES_ITEMS`). También rechaza IGV 0, y eso contradice el comentario de `moneyAmountSchema` («línea inafecta»).                                                                                                                                                                                                                                                                                                        | Documentar la tolerancia en D-255 y corregir el comentario, o apretar a la precisión del papel.                                                                       |
| 10  | `apps/api/prisma/coil-sku-report.ts:44`                                            | `pnpm check:coil-skus` sigue armando el SKU con `coilSkuFromTypeKey`. Después de la normalización, va a reportar cada tipo como «sin producto»: es un diagnóstico falso, y justo el caso que advierte el punto 1 del handoff («armar el SKU en otro lado reabre D-168»).                                                                                                                                                                                                                                                                                | Pasarlo a `coilSaleSkus` o retirarlo.                                                                                                                                 |
| 11  | `.gitignore:47`                                                                    | `/tmp/` se ignora «porque el dueño deja exports reales en tmp/». AGENTS.md §3.3 dice que los datos reales viven solo en `local-data/` y nunca sueltos en la raíz.                                                                                                                                                                                                                                                                                                                                                                                       | Sacar la regla, o registrarla como excepción `D-nnn`.                                                                                                                 |
| 12  | Barrido y normalización: pruebas                                                   | «Los reportes de RF-S4a dan igual» está probado con un **fixture mínimo**: un color, un tipo, una venta y un `BOB…` suelto (`normalizacion-bobinas-rf-s4b.spec.ts`). No hay ensayo con muchos grupos ni con datos con forma de producción. El diseño hace que el riesgo sea bajo (no se toca ninguna FK ni el kardex, y hay autocomprobación de kilos dentro de la transacción), pero eso no está medido.                                                                                                                                               | Ensayar dry-run + execute de las dos herramientas sobre `demo` restablecida desde producción, o sobre una rama Neon del respaldo previo, y comparar los dos reportes. |

## Respuestas punto por punto

1. **Bobina → producto y elección (D-254).**
   - Las candidatas de `coilPoolFor` cumplen todo: espesor exacto por igualdad de `Decimal`, el
     mismo token de color comercial o de tipo, saldo ≥ cantidad, y excluye reservadas, montadas
     y las atadas a otra cotización abierta.
   - Pero el servidor solo lo aplica en la **edición de pedido**. En el importador y en la
     edición de cotización manda el selector del web (P2-1).
   - Concurrencia: en pedidos, `createReservations` (`SELECT … FOR UPDATE` sobre la bobina y
     comparación del disponible) evita la sobre-reserva. En cotizaciones no hay nada (P2-2).
   - La elección automática es correcta: solo pasa con candidata única o con un único saldo
     exacto, nunca por orden. Las repetidas dentro del archivo o del barrido quedan para revisión.
2. **Importes (D-255).**
   - Encontré tres lugares que antes usaban el unitario de 4 decimales y ahora usan
     `derivedUnitValue` a 10: el comprobante parcial, la NC parcial y el payload al PSE. Lo
     mismo el cambio de cantidad y el duplicado. No encontré otra cuenta sobre `unit_price_pen`.
   - Qué significa «cuadran»: valor + IGV = total **exacto**, y el IGV a ≤ 0.01 del 18 %.
   - Si no cuadran: en el importador se guarda solo el valor y el IGV se calcula. Por la API es
     un 400.
   - El P0 del IGV quedó **cerrado en todas las entradas públicas**: todas pasan por
     `resolveSalesLines` → `amountBasisOf` (alta y edición de cotización, pedido directo,
     agregar ítems, confirm del importador). `restorePaperAmountsInTx` no valida el trío, pero
     no tiene ruta HTTP: solo lo llama el barrido, con valores que ya pasaron `paperTriplet`.
   - Exención del piso: **sí** se puede marcar como importado un documento que no lo es (P1-3).
3. **Unión (D-253/D-257).**
   - Está bien: CHECK en la base; sin cadenas, con `FOR UPDATE` en orden de id; sin
     reactivación (400); kardex intacto (la unión no escribe movimientos y se niega si el
     producto tiene movimientos o reservas propias); rechazo al desactivar un `BOB…` con pool
     abierto.
   - Lo que falta: el dry-run no ve la parada de saldo propio (P2-3), y el rechazo al desactivar
     no mira las bobinas `CLOSED` (P2-7).
4. **Herramientas.**
   - Dry-run por defecto: sí, y el gate está dentro de la CLI.
   - Idempotencia: sí, por lectura. Un segundo execute del barrido no encuentra hallazgos en lo
     que ya corrigió, y la normalización sale sin grupos.
   - Transacciones: la normalización es todo o nada. El barrido corrige un documento por
     transacción; si se corta a mitad, lo corregido queda y re-correrlo completa el resto.
   - Solo documentos abiertos: sí. Auditoría: completa en pedidos; en cotizaciones sin el motivo
     del barrido (P2-5).
   - Datos realistas: no (P2-12). El emparejamiento del barrido es el riesgo principal (P1-1).
5. **Roles y costos (RF-S3c).**
   - `GET /sales/coil-pool` no devuelve costo, margen ni valuación: solo código, ancho y saldo.
   - El «Costo promedio» del formulario viene de D-170 (no es de esta rama) y sale de
     `sellable-coils`, donde el servidor solo pone `avgCostPen` si el rol es ADMINISTRADOR.
   - `PATCH …/coil` exige ser dueño del pedido; el precio del pedido es solo ADMINISTRADOR. Sin
     hallazgo.
6. **Migración.** Es aditiva: columna nullable, índice, FK RESTRICT y un CHECK que las filas
   actuales cumplen. La API vieja convive con ella, y el smoke de CI la aplicó sobre Neon `ci`.
   Volver la API atrás es viable **hasta** el execute de la normalización (P1-4).
7. **Infra de tests.**
   - `jest.config.js` y `fix-lcov-paths.mjs` no tocan el build ni el runtime: ni `nest build`
     ni `tsconfig` cambiaron. Hay dos efectos secundarios:
     - Los unitarios ya no ejercitan el `dist/` de `@ayr/shared`, que es lo que carga
       producción. Lo cubren el typecheck y el E2E.
     - Los comentarios se contradicen: `jest.config.js:10-11` dice que el lcov sale relativo a
       la raíz, y `fix-lcov-paths.mjs:4` dice que sale relativo a `apps/api`.
   - El 80.6 % de Sonar mide las líneas que ejecutan los unitarios de API y `shared`, con Prisma
     simulado: cuenta líneas, no prueba el comportamiento contra la base.
   - El código nuevo del web (~1 190 líneas en 4 archivos) no tiene unitarios. Según el propio
     análisis del handoff, no entra en ese número; su cobertura es el E2E, y el handoff reconoce
     que los selectores nuevos no tienen E2E de UI.

## Veredicto: **go con condiciones**

La pieza está bien construida. R2 (importes) está correcto y cerrado en todas las entradas. La
unión y la migración son sólidas, y las CI y los unitarios están en verde. Los cuatro P1 son
acotados y ninguno exige rediseño. Según el propio handoff, la ventana necesita el pase sin P1
abiertos, así que el go depende de estas condiciones:

1. **P1-1:** corregir el emparejamiento del barrido antes de `sweep:imported --execute`. Si no
   llega, la ventana puede ir sin ese execute: deploy, migración y normalización. COT-000002 y
   FFA1-1355 se corrigen a mano con «Cambiar bobina» o convirtiendo a venta de bobina, y el
   barrido queda para otro día.
2. **P1-2:** las dos CLI corren contra producción con `JOBS_ENABLED=false` y `PSE_ENABLED=false`
   y con R2 decidido de forma explícita, sea en el wrapper o en el entorno del comando.
3. **P1-3:** corregir el prefijo en la API, o que el dueño vuelva a aceptar el riesgo como
   `D-nnn` con la premisa correcta.
4. **P1-4:** el runbook marca el execute de la normalización como punto de no retorno para la API
   y agrega un smoke de solo lectura de la API nueva antes de los execute.
5. **Recomendado, no bloqueante:** ensayar dry-run + execute de las dos herramientas sobre `demo`
   restablecida desde producción, o sobre la rama de respaldo, antes de hacerlo en producción
   (P2-12).
