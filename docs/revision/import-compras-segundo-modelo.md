# Revisión de segundo modelo (Sonnet, contexto limpio) — sigue siendo un modelo, no una persona

**Entrega:** importador de compras y piezas asociadas (D-348 a D-353), rama `feat/importador-compras`.
**Comparado contra:** `origin/main` (`git diff origin/main...HEAD`).
**Alcance de la revisión:** todo el diff de la entrega — 62 archivos, ~6980 inserciones. Solo
lectura: no se editó código ni se corrió `git add`/`commit`.
**Método:** lectura directa del diff completo, del `schema.prisma`/migración, y de los archivos
núcleo de mayor riesgo (transacciones, `SAVEPOINT`, idempotencia, locks) por quien firma este
informe, más cuatro subrevisiones enfocadas (D-348; D-349+D-350; D-351/352 backend; D-351 web +
D-353) hechas en paralelo sobre el mismo diff, cuyos hallazgos se consolidan y contrastan acá.
Varios hallazgos fueron encontrados de forma independiente por más de una pasada — se anota dónde.

**Resultado global: sin P0.** Ningún antipatrón de los que el brief pedía cazar explícitamente
apareció en su forma clásica: no hay `prisma.purchase.create`/`$executeRaw` directo saltándose
`createInTx`, no hay un `try/catch` de `P2002` sin traducir dentro de una transacción interactiva
que luego siga leyendo con `tx`, no hay I/O externo (padrón, SUNAT) dentro de una transacción
abierta, la migración coincide exactamente con `schema.prisma`, y `Decimal` se usa de punta a
punta en el importador. Hay **5 hallazgos P1** que conviene corregir o, en dos casos, resolver
con una decisión explícita del dueño (regla dura 16 / D-230) antes del deploy, y un grupo de P2.

---

## Resumen de severidades

| #   | Severidad | Pieza     | Hallazgo                                                                                                                                                                                                                                                                                                                                                                                                                          | Archivo:línea                                                                               |
| --- | --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | **P1**    | D-348     | El `FOR UPDATE` del guard de edición no cubre `InventoryMovement`/`InventoryBalance`/`Reservation`/`QuotationReservation` (polimórficas, sin FK real a `products`): una recepción de compra o una reserva de pedido concurrente no queda serializada contra el cambio de estructura.                                                                                                                                              | `apps/api/src/catalog/catalog.service.ts:507`, `apps/api/src/catalog/product-real-usage.ts` |
| 2   | **P1**    | D-348     | El criterio de "cotización vencida" usa directamente la columna `status` (`EXPIRED`) en vez del patrón ya establecido (`isQuotationExpired`/`effectiveStatus()`), que sí se recalcula contra `validUntil` porque el job diario puede quedar atrasado.                                                                                                                                                                             | `apps/api/src/catalog/product-real-usage.ts:22-28`                                          |
| 3   | **P1**    | D-351/352 | El "todo o nada" de `confirm()` es **por lote completo**, no por comprobante como describe el encargo/brief: si un comprobante falla, se revierten también los que ya tenían su `SAVEPOINT` liberado. Es una decisión de diseño defendible, pero contradice la redacción del brief y el docstring del propio archivo — corresponde una decisión explícita del dueño (D-230) y, según lo que decida, ajustar el texto o el código. | `apps/api/src/imports/purchase-import.service.ts:378-443` (línea 414 en particular)         |
| 4   | **P1**    | D-350     | El bloqueo de la purga por "tiene pedido" y por "tiene reserva temporal no liberada" solo está probado con mocks (`quotation-purge.spec.ts`); el E2E (`purga-cotizaciones-d350.spec.ts`) solo cubre el bloqueo por estado. Es un borrado físico e irreversible sobre datos reales — antes de la primera corrida `--execute --confirm-production` conviene un caso E2E real para cada uno de esos dos bloqueos.                    | `e2e/tests/purga-cotizaciones-d350.spec.ts`                                                 |
| 5   | **P1**    | D-351 web | "Deshacer lote" anula todas las compras del lote con un solo click, sin el `ReasonDialog` de confirmación que el resto de la app exige para la misma operación de dominio (`PurchasesService.cancel`, comparar con `compra-detalle-view.tsx`).                                                                                                                                                                                    | `apps/web/src/app/(app)/compras/importar/importar-compras-view.tsx:334-349`                 |

P2 y notas de cobertura, agrupados por pieza, más abajo.

---

## D-348 — editar subtipo/espesor/color de un accesorio sin uso real

### P1-1 — Race condition: el lock no cubre kardex, saldos ni reservas

`catalog.service.ts:507` toma `SELECT "id" FROM "products" WHERE "id" = ${id}::uuid FOR UPDATE`
antes de llamar `describeProductRealUsage(tx, before)` (línea 508). El comentario del código dice
que "una línea nueva de pedido, cotización o compra toma un lock de clave sobre esta fila por su
FK" — cierto para `PurchaseItem`, `QuotationItem`, `SalesOrderItem`, `FiscalDocumentItem`,
`DispatchItem` y `ProductionOrder`, que sí tienen `@relation` real a `Product` y por lo tanto
Postgres toma `FOR KEY SHARE` sobre la fila del producto al insertar.

Pero `describeProductRealUsage` también cuenta `InventoryMovement`, `InventoryBalance`,
`Reservation` y `QuotationReservation`, las cuatro con el patrón polimórfico `itemType`/`itemId`
**sin** FK a `products`. Un `INSERT` ahí no toma ningún lock sobre la fila de `products`, así que
no queda serializado contra el `FOR UPDATE` del guard. Se verificó además que
`InventoryService.record()` toma su propio `FOR UPDATE`, pero sobre la fila de
`inventory_balances`, no sobre `products` — no ayuda acá.

**Escenario concreto:** la transacción A (edición de estructura) toma el lock y lee "0 usos
reales"; en paralelo, la transacción B (una recepción de compra que llama a
`InventoryService.record()`, o la creación de una reserva de pedido) inserta un
`InventoryMovement`/`Reservation` para el mismo producto sin bloquearse, y comitea. A también
comitea el cambio de SKU/subtipo/espesor/color. Queda un movimiento de kardex (o una reserva
viva) grabado bajo la forma **anterior** del producto — exactamente lo que el guard existe para
impedir, y el mismo tipo de hueco que D-347 ya documentó como riesgo residual y cerró
**solo para el único escritor identificado entonces** (`InitialInventoryProductImportService`).
D-348 reintroduce la misma exposición para los escritores normales (recepción de compra,
reservas de pedido) que nunca fueron el foco de aquel parche.

**Sugerencia:** un lock explícito por `productId` que también tomen `InventoryService.record()` y
la creación de reservas (`pg_advisory_xact_lock(hashtext(productId))`, o agregar FK real a esas
cuatro tablas), o como mínimo volver a correr `describeProductRealUsage` bajo un lock que sí las
cubra, inmediatamente antes del `product.update()`.

### P1-2 — "Vencida" no usa el patrón ya establecido

`product-real-usage.ts:22-28` filtra `status NOT IN (CANCELLED, EXPIRED)` directamente contra la
columna guardada. `QuotationStatus.EXPIRED` solo lo escribe el job diario de pg-boss
(`quotation-expiry.job.ts`, corre 05:00 UTC), que puede quedar atrasado si Cloud Run escaló a
cero — motivo por el cual el resto del sistema (`quotations.service.ts`, `sales-orders.service.ts`)
nunca confía solo en `status` y usa `isQuotationExpired(validUntil, businessToday())` /
`effectiveStatus()`. D-348 sí confía solo en `status`.

**Consecuencia:** una cotización con `validUntil` ya pasado pero `status` todavía `EMITTED`
(porque el job no corrió) se trata como viva y bloquea una edición que el negocio dice que debería
estar permitida ("vencidas no cuentan"). Sobre-bloquea, no corrompe datos, pero contradice el
brief y diverge del criterio ya establecido en el propio repo para la misma pregunta. Ningún test
(`product-real-usage.spec.ts`, `accesorio-edicion-m5.spec.ts`) cubre una cotización con
`validUntil` vencido y `status` todavía vivo.

**Sugerencia:** traer también `validUntil` en las consultas de `product-real-usage.ts` y aplicar
el mismo criterio de `isQuotationExpired`/`effectiveStatus()`, no solo el `status` persistido.

### P2 — Duplicar cotización con producto borrado (D-347) pierde el mensaje claro

`quotations.service.ts` (~línea 626): si el producto de una línea fue borrado físicamente
(D-347) entre la cotización original y el duplicado, `productShapes.get(i.productId)` es
`undefined` y el loop de `duplicateShapeChange` simplemente sigue sin lanzar el error específico.
La duplicación sí termina fallando más abajo en `resolveSalesLines`
(`NotFoundException('${at}: producto no encontrado')`) — no es un crash — pero el mensaje es
genérico, no dice que el producto fue eliminado. Ningún test cubre este escenario puntual.
Si el 404 genérico se acepta como suficiente, dejarlo documentado con un test; si no, un mensaje
propio ("el producto de la línea N ya no existe en el catálogo").

### P2 — Huecos de cobertura en `describeProductRealUsage`/`productsRealUsage`

Solo se prueban con valor > 0 las ramas `movements`, `balances`, `orders` (pedidos) y
cotizaciones vivas. Nunca con valor no-cero: `purchaseItems`, `fiscalItems`, `dispatchItems`,
`productionOrders`, `reservations` (reserva de pedido), la rama "reservas temporales sin línea
encontrada" (comentario propio "no debería pasar") ni el pool de bobinas en `productsRealUsage`.
Riesgo bajo (espeja el patrón ya probado de D-347) pero un error de copiar/pegar en cualquiera de
esas cinco ramas no lo detecta la suite.

### Verificado sin hallazgos

- Separación D-347 (`product-usage.ts`, toda cotización cuenta) vs D-348
  (`product-real-usage.ts`, solo vivas) — funciones separadas, sin reuso cruzado incorrecto;
  `catalog.service.ts` expone `canDelete` desde una y `canEditStructure`/`structureLockReason`
  desde la otra.
- El SKU se recalcula server-side (`assertAccessorySku`) desde color/espesor/subtipo reales en
  BD; el navegador no puede forzar un SKU arbitrario. Errores de SKU usan `skuFieldError()`
  (400 con `errors.sku`), nunca un 500 genérico.
- `Decimal` sin `number` suelto en las comparaciones tocadas.
- La auditoría corre dentro de la misma transacción que el `update()`.
- `duplicate-shape.ts` usa `detailsLengths`/`isAccessory` correctamente, sin mezclar con
  `sellsByLength`/`isMadeToMeasure` (D-131/D-343).
- E2E `accesorio-edicion-m5.spec.ts`: selectores por rol/label/testid, cubre el flujo completo
  (bloqueado con cotización viva → anular → desbloqueado → cambiar subtipo → error de SKU
  forzado → guardar con SKU nuevo).

---

## D-349 — catálogo oculta inactivos por defecto

Sin P0/P1. El "ocultar por defecto" es **comportamiento de cliente, no del API**: la UI sigue
pidiendo `GET /catalog` sin `?active=` (trae activos e inactivos igual que antes) y filtra recién
en el render (`catalogo-view.tsx:199-211`). Esto es una decisión explícita y documentada en
`docs/ARQUITECTURA.md` (D-349: "sin el parámetro, todos — como antes"), no un descuido, y se
verificó que ningún llamador existente (`sales-document-form.tsx`, `purchase-form.tsx`,
`new-order-cards.tsx`, `nueva-orden-view.tsx`, `importar-view.tsx`) pasa `active=`, así que nada
se rompe.

**P2** — al no filtrar en el API, D-349 no reduce el payload/tiempo de carga; es puramente
visual. Vale que quede explícito que es "ocultar en la UI", no "no traer del API", si el catálogo
crece.

**P2** — deep-link `?bajoPiso=<id>` a un producto inactivo: la búsqueda no filtra por activo, pero
el `scrollIntoView` apunta a una fila que el chip apagado ya sacó del DOM — no pasa nada, sin
aviso. Caso raro pero confuso si ocurre. Sugerencia: si el producto deep-linked es inactivo,
forzar `inactivos=1`.

**P2** — `catalog.controller.spec.ts` no cubre `active=''` (string vacío) explícitamente, aunque
el comportamiento (400, mismo camino que cualquier valor no reconocido) es correcto por
inspección.

E2E (`catalogo-inactivos-d349.spec.ts`) usa selectores estables (`getByRole`, `aria-pressed`) y
cubre: oculto por defecto, aparece buscando por SKU con el chip apagado, el chip lo muestra,
persiste en `?inactivos=1` tras reload, y valida el filtro real del API por separado.

---

## D-350 — CLI de purga de cotizaciones anuladas

Diseño sólido: `executeQuotationPurge` toma `SELECT … FOR UPDATE` sobre las filas por `seq`,
vuelve a correr `planQuotationPurge` bajo ese lock y compara contra lo planeado en el dry-run; si
difiere, no borra nada. El razonamiento de locks (FK de `SalesOrder`/`QuotationReservation` hacia
`quotations.id` toma `FOR KEY SHARE` sobre la fila padre, que choca con el `FOR UPDATE` ya
tomado) es el mismo patrón ya usado en D-347/D-348 y no se encontró ventana de carrera teórica.

### P1 — Los dos bloqueos más importantes solo están probados con mocks

`e2e/tests/purga-cotizaciones-d350.spec.ts` solo ejercita el camino feliz y el bloqueo por
estado (no ANULADA). **No hay ningún E2E que cree un pedido real sobre una cotización anulada** ni
uno que **deje una reserva temporal viva** y verifique que la purga los bloquea contra Postgres
real — esos dos casos hoy solo están cubiertos por `quotation-purge.spec.ts` con `tx` mockeado,
que asume que la forma de las consultas Prisma coincide con el schema real sin probarlo. Dado que
esta CLI eventualmente corre `--execute --confirm-production` sobre `production`, y que un falso
negativo acá borra físicamente e irreversiblemente una cotización con pedido o reserva viva,
conviene cerrar esto con dos casos E2E reales antes del deploy.

### P2 — Notas, sin bloquear

- Sin test de concurrencia real (dos conexiones, una sosteniendo el lock) para la ventana de
  carrera — el razonamiento es sólido y sigue un patrón ya aceptado, pero es la clase de garantía
  que vale la pena demostrar antes de un `--execute` real, no solo argumentar.
- `audit_log` guarda un `before` deliberadamente mínimo (`code`, `customerId`, `customerName`),
  no el snapshot completo que sí guarda D-347 para el borrado de productos — decisión documentada
  del dueño en `docs/ARQUITECTURA.md`, pero vale reconfirmarla una vez más antes de la primera
  corrida real: es un borrado físico e irreversible y, sin el snapshot completo, la única traza
  en base de lo que se borró es el número y el cliente.
- La CLI (`purge-cancelled-quotations-cli.ts`) instancia `new PrismaClient()` +
  `new AuditService(prisma as unknown as PrismaService)` a mano, en vez de
  `NestFactory.createApplicationContext` (patrón de D-142/D-206). Inofensivo hoy (`AuditService.write`
  recibe `tx` como parámetro y nunca toca `this.prisma`), pero es una desviación silenciosa: si
  `AuditService` gana una dependencia nueva, este CLI se rompe en runtime sin que el compilador
  avise. Sugerencia: dejar un comentario explícito de por qué se evitó `NestFactory`.
- Borrado de reservas `RELEASED`, orden de deletes contra el FK `Restrict` de
  `SalesPriceChange.quotation`, y que no toca R2: verificados sin hallazgos.
- No se encontró ninguna interacción nueva con D-348 (no agrega tablas ni cambia la forma de
  `quotation_items`/`sales_price_changes`/`quotation_reservations`, que son exactamente las
  tablas que la purga ya cubre).

---

## D-351/D-352 — importador masivo de compras (backend)

Pieza de mayor riesgo de la entrega; se le dedicó la mayor profundidad. Verificación directa
propia y una subrevisión enfocada llegaron a la misma conclusión de forma independiente.

### P1 — El "todo o nada" documentado es ambiguo y el código implementa "por lote", no "por comprobante"

`purchase-import.service.ts:378-443` (`confirm`). El `SAVEPOINT`/`RELEASE`/`ROLLBACK TO SAVEPOINT`
por comprobante (líneas 393-412) permite que un `createInTx` fallido no deje la transacción en
estado abortado, así que el resto de comprobantes se puede seguir evaluando para **acumular todos
los errores en un solo mensaje**. Pero al final del bucle:

```ts
if (Object.keys(errors).length > 0) throw notImported(errors, validated.length);
```

este `throw` ocurre dentro del callback de `this.prisma.$transaction(...)`, así que Prisma hace
`ROLLBACK` de la transacción **externa completa** — incluidos los comprobantes cuyo `SAVEPOINT` ya
se había liberado con éxito. `RELEASE SAVEPOINT` no es un commit parcial. Esto está confirmado por
el propio test (`purchase-import.service.spec.ts:170`, título "todo o nada: un comprobante que el
servicio rechaza revierte a su savepoint y no entra ninguno") y por el mensaje de error
("no se importó ninguno, corrígelos y vuelve a enviar").

Es una decisión de diseño defendible — evita dejar en producción un lote a medias, con
proveedores y numeración parcialmente aplicados — y probablemente sea justo lo que conviene para
datos financieros. Pero **el encargo de esta entrega la describe como "todo o nada" por
comprobante** ("SAVEPOINT por comprobante, todo o nada"), y el docstring del propio archivo
(línea 59) es ambiguo sobre el alcance. Por la regla dura 16 (ambigüedad → detenerse y confirmar
con el dueño, D-230), esto merece una confirmación explícita antes del deploy: ¿el comportamiento
correcto es "el archivo entero entra o no entra nada" (lo que hoy hace el código), o se esperaba
poder confirmar los comprobantes buenos y dejar fuera solo los malos? Si la respuesta es la
primera, alcanza con aclarar el docstring y el nombre de la garantía ("atómico por lote, con
diagnóstico completo por comprobante").

### Verificado sin hallazgos (antipatrones que el brief pedía cazar)

- **`SAVEPOINT`**: sintaxis correcta, nombres únicos por índice, `ROLLBACK TO SAVEPOINT` solo
  para errores de dominio (`instanceof HttpException`); un error que no lo es se relanza sin
  rollback al savepoint y aborta todo — intencional y testeado.
- **`P2002` dentro de transacción interactiva**: tanto `PurchasesService.createInTx` como
  `SuppliersService.createInTx` (vía `createSuppliers`) traducen `P2002` a
  `ConflictException`/`BadRequestException` (`HttpException`) **antes** de volver a tocar `tx`, y
  sin ninguna consulta adicional entre el catch y el `throw` — el `ROLLBACK TO SAVEPOINT` que
  sigue en el llamador es válido. No hay ningún `create` + `catch(P2002)` crudo sin traducir.
- **Idempotencia**: usa `claimIdempotencyKey` (D-182) con `INSERT ... ON CONFLICT DO NOTHING`
  dentro de la misma transacción — ningún mecanismo ad-hoc.
- **Undo de lote**: reutiliza `PurchasesService.cancel()` por cada compra (nunca borra filas
  directo); como una compra en BORRADOR nunca tiene bobinas (se crean recién en `receive()`), el
  caso "lote parcialmente usado" no puede darse en este camino — si ya fue recibida, `undo` no la
  toca y delega a `cancel()` individual, que tiene sus propios guardrails.
- **Doble conteo contra la carga inicial (D-352)**: `initialLoadMatch` se recalcula siempre
  server-side (normalizando mayúsculas/espacios/ceros a la izquierda, con tests); el flag que
  manda el navegador (`confirmedNotInitialLoad`) no decide si hay coincidencia, solo si bloquea, y
  queda auditado con `actorId`.
- **Proveedor nuevo desde el padrón**: la consulta a apis.net ocurre en `loadContext`, antes de
  abrir la transacción de `confirm`; el nombre viene siempre del padrón, nunca del navegador (el
  input del cliente no tiene ni campo de razón social); el código corto es editable pero se
  revalida contra formato y unicidad tanto en validate como otra vez en confirm.
- **Decimal vs number**: parseo mantiene `string`, toda la aritmética usa `Decimal`/`toDecimal`/
  `money` de `@ayr/shared`; sin `number()`/`parseFloat` persistido, sin `as any`/`@ts-ignore` en
  los archivos núcleo.
- **`operationDate`**: el importador solo crea compras en BORRADOR; el hecho fechado real
  (kardex, bobinas) sigue ocurriendo únicamente en `receive()`, no tocado salvo para propagar
  `externalCode`.
- **Migración vs `schema.prisma`**: `20260927200000_d351_importador_de_compras/migration.sql` (2
  `ALTER TABLE ADD COLUMN` nullable + 1 `CREATE INDEX`) coincide exactamente con el diff de
  `schema.prisma` (`Purchase.importBatchId`, `PurchaseItem.externalCode`,
  `@@index([importBatchId])`). Genuinamente aditiva.
- **Roles**: mismos roles que `PurchasesController.create` para el importador; `undo` restringido
  además a ADMINISTRADOR tanto en el decorador como con chequeo redundante en el servicio.
- **`create()`/`SuppliersService.create()` públicos**: los únicos callers existentes
  (`purchases.controller.ts:107`, `suppliers.controller.ts`) siguen invocando la misma firma
  pública sin cambios; el refactor a `createInTx` preserva side-effects (mismo `$transaction`,
  mismo manejo de `P2002`, misma auditoría).

### P2 — Idempotencia pierde `createdSuppliers` en un reintento

`purchase-import.service.ts:385` — `if (!claim.claimed) return this.batchResult(tx,
claim.resourceId, []);`. En un reintento con el mismo `idempotencyKey` (doble click, reintento de
red) después de que el primer intento ya creó proveedores nuevos, la segunda respuesta trae las
compras correctas pero `createdSuppliers: []` siempre. No es una inconsistencia de datos (los
proveedores existen igual), solo una respuesta incompleta al cliente que reintentó. Sin test que
cubra este caso con proveedor nuevo + reintento.

### P2 — `resolveExchangeRate` ahora corre antes de validar proveedor/línea en `create()` público

`purchases.service.ts:158-166`. Antes del refactor, `resolveExchangeRate` (que puede llamar a
SUNAT) se invocaba después de validar que el proveedor y la línea de negocio existen. Ahora se
invoca primero, así que una compra con proveedor inexistente o línea inválida igual dispara la
llamada a SUNAT antes de fallar. No rompe nada funcionalmente (mismo caller, mismo resultado
final), pero es I/O externo innecesario en el camino de error — el propio comentario del código lo
justifica (no sostener una conexión del pool esperando a un tercero), razón válida, pero vale
confirmarlo como cambio de orden intencional y no un efecto colateral del refactor.

### P2 — Nota operativa: transacción de `confirm` hasta 5 minutos

`{ timeout: 300_000, maxWait: 20_000 }` para hasta 1000 filas. Coherente con el volumen a
soportar, pero quien opere el deploy debería saber que una importación grande sostiene una
conexión del pool varios minutos.

### Huecos de test adicionales

- Ningún test de `confirm()` con **múltiples** comprobantes donde uno usa un proveedor nuevo y
  otro uno existente, para confirmar explícitamente que un fallo en cualquiera revierte también
  al proveedor recién creado (se infiere correctamente del mecanismo de transacción, pero no hay
  aserción directa).
- La sintaxis SQL exacta de `SAVEPOINT` solo queda validada contra Postgres real en el E2E (los
  specs unitarios mockean `$executeRawUnsafe`); el nombre generado (`compra_${index}`) no
  incorpora datos del usuario, sin riesgo de inyección.

---

## D-351 — importador de compras, web

### P1 — "Deshacer lote" sin confirmación explícita

`importar-compras-view.tsx:334-349`. El botón llama `undo.mutate(result.batchId)` directo en
`onClick`, sin ningún paso intermedio de confirmación. Contrasta con el patrón ya establecido en
el propio repo para la misma operación de dominio: `compra-detalle-view.tsx` usa `ReasonDialog`
para anular una compra individual, y el comentario de `reason-dialog.tsx:17-20` dice
explícitamente que toda anulación de Fase 2b (merma, partido, bobina, compra) exige guardar el
motivo, así que la UI no puede dejarla confirmar sin escribirlo. "Deshacer lote" anula por dentro
con un motivo generado por el sistema (`'Deshacer el lote de importación ' + batchId'`), sin que
el usuario lo escriba ni confirme.

**Escenario:** usuario confirma un lote de 20 compras, hace click en "Deshacer lote" pensando que
abre un diálogo (como el resto de la app) y en realidad ya anuló las 20.

**Sugerencia:** envolver el click en el mismo `ReasonDialog` que usa `compra-detalle-view.tsx`,
pidiendo motivo explícito antes de invocar `undo.mutate`.

### Verificado sin hallazgos

- **Código corto del proveedor nuevo**: sugerido y editable por el cliente, pero el servidor lo
  revalida siempre contra `newSupplierCodeSchema` (`^[A-Z]{3,6}$`) y contra colisión, tanto en
  validate como en confirm; `createSuppliers` además atrapa `P2002` como red de seguridad ante
  una carrera.
- **Botón "Crear las compras"**: `disabled` cubre lista vacía, bloqueos, cambios sin revalidar y
  pending; usa `pending`/`pendingText="Importando…"` — protegido contra doble click.
- **`idempotencyKey`**: hook compartido `useIdempotencyKey`, huella = `JSON.stringify(documents)`
  recalculada en cada intento; cambia si el payload cambia, se reutiliza si el intento anterior
  quedó incierto (5xx/red) y se descarta en éxito o 4xx (D-182).
- **"Es otra compra"**: el servidor decide `initialLoadMatch` de forma independiente del cliente;
  el flag del navegador solo decide si el hallazgo bloquea o no, y la confirmación queda auditada
  con el actor. El cliente no puede fabricar ni ocultar una coincidencia.
- **Errores por comprobante**: se mapean por clave (`doc.key`) y se muestran en la cabecera de
  cada acordeón — coherente con el "todo o nada por lote" (ver hallazgo P1 de la sección backend):
  la UI y el texto del README ("Confirmar crea todas las compras o ninguna") ya asumen ese
  comportamiento, así que no hay una discrepancia adicional del lado web — el ajuste, si el dueño
  lo pide, es uno solo (backend + este texto).
- **E2E** (`importar-compras-d351.spec.ts`): números de comprobante derivados de `Date.now()` (no
  fijos), RUC al azar, protegido contra correr en prod, sin `waitForTimeout` (usa `toBeVisible`
  con timeout de estado real).

### P2 — Cobertura E2E de D-352 ("Es otra compra") solo a nivel de servicio

El E2E cubre preview→corregir→confirmar→recibir→deshacer, pero no ejercita el checkbox "Es otra
compra" ni el bloqueo por coincidencia con la carga inicial (sí está bien probado en
`purchase-import-validate.spec.ts` y `purchase-import.service.spec.ts`, incluida la auditoría).
No bloquea deploy.

### P2 — Aviso de "servicio sin vínculo" sin verificación E2E

`docs/plantillas/README-importar-compras.md:37` menciona el aviso; no se encontró verificación
E2E de que aparezca en pantalla. Menor.

---

## D-353 — "Recibir seleccionadas"

**Sin hallazgos P0/P1.**

- Cada recepción es independiente: `receiveSequentially` (`receive-batch.ts:15-35`) llama
  `receive(target.id)` en un `for` secuencial con `try/catch` por ítem — una falla no detiene a
  las demás ni envuelve nada en una transacción nueva. Bien probado en `receive-batch.spec.ts`
  (una falla en medio, las otras dos igual se procesan). Coincide exactamente con el brief.
- Una compra ya no recibible: el error de `POST /purchases/:id/receive` se captura por ítem y se
  muestra con su propio mensaje en la fila correspondiente; las demás seleccionadas se siguen
  procesando.
- Doble click: el botón "Recibir seleccionadas (N)" y los checkboxes de selección quedan
  deshabilitados durante el pending (`receiveMany.isPending`), con `pending`/`pendingText`.
- Sin reimplementación de kardex: `receive-batch.ts` (44 líneas) es puro orquestador de llamadas
  HTTP secuenciales, cero lógica de Decimal/kardex/inventario. `PurchasesService.receive()` no
  tuvo cambios de lógica en este diff — los únicos cambios en `purchases.service.ts` son la
  extracción `create()`→`createInTx()` (D-351) y el campo `externalCode` al crear bobinas (D-351),
  ninguno de los dos toca la recepción/kardex de D-353.

---

## Nota metodológica

Los hallazgos P1 #3 (todo-o-nada por lote) y el diseño de `SAVEPOINT`/idempotencia de D-351/352
fueron verificados de forma independiente dos veces (por quien firma este informe, leyendo el
código directamente, y por una subrevisión enfocada) con la misma conclusión — se reporta una
sola vez en la tabla de resumen para no duplicar. El hallazgo P1 #1 (race del `FOR UPDATE` en
D-348) fue razonado primero por quien firma este informe como "probablemente cubierto de forma
transitiva por las FK existentes" y luego **refutado** por la subrevisión enfocada, que encontró
evidencia concreta (`InventoryService.record()` bloquea `inventory_balances`, no `products`) de
que no lo está — se deja la versión corregida (con race real) en este informe.

---

## Respuesta de la sesión (2026-09-27)

| Hallazgo                                   | Estado                            | Qué se hizo                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 lock de D-348 sin tablas polimórficas | **Documentado, sin cambio**       | Es el riesgo residual que D-347 ya dejó escrito: los escritores de kardex conocidos de un producto pasan antes por una fila con FK (línea de compra, pedido, OP) que ya cuenta como uso, y la carga inicial toma el mismo lock a mano (M6). Anotado en el comentario del lock y en el handoff.                                                                                          |
| P1-2 vencida por fecha                     | **Corregido**                     | Una EMITIDA con `validUntil` pasado cuenta como vencida aunque el job no la haya marcado (`liveQuotation()`); test.                                                                                                                                                                                                                                                                     |
| P1-3 todo o nada por lote                  | **Sin cambio (no es ambigüedad)** | El brief dice «todo o nada, SAVEPOINT por comprobante con el error de cada uno», el mismo contrato del importador de cotizaciones (D-152/D-147): el SAVEPOINT es para juntar el error de cada comprobante sin abortar la transacción, y el lote entra entero o no entra.                                                                                                                |
| P1-4 purga sin E2E real de los bloqueos    | **Corregido en parte**            | El E2E de la purga suma una cotización anulada **con pedido** real (confirmada contra el escenario de coberturas, pedido anulado y cotización anulada) y verifica que el dry-run la bloquea y el execute no la toca. El bloqueo por reserva temporal viva sigue solo en unitarios (una cotización anulada libera sus reservas; no hay forma limpia de producir el caso contra la base). |
| P1-5 deshacer lote sin motivo              | **Corregido**                     | `POST …/undo` exige `reason` (`undoPurchaseImportSchema`) y la pantalla usa `ReasonDialog`; la anulación lleva el motivo y el lote. E2E actualizado.                                                                                                                                                                                                                                    |
| P2                                         | Anotados                          | En el handoff (idempotencia sin `createdSuppliers` en el reintento, TC antes de validar en `create()`, filtro de inactivos solo en la UI, CLI sin `NestFactory`, etc.).                                                                                                                                                                                                                 |
