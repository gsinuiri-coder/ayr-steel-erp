# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                         | Estado                  | Cierre                                                   |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 0 — Bootstrap                                | ✅ Cerrada (2026-09-02) | Login E2E verde en prod, CI verde                        |
| 1 — Maestros, catálogo, precios, importación | ✅ Cerrada (2026-09-02) | E2E de Fase 1 verdes en local + CI, deploy en producción |
| 2a — Kardex + compras + alta de bobinas      | ✅ Cerrada (2026-09-03) | 16/16 E2E verdes en producción, CI verde, deploy hecho   |
| 2b — Partido, merma, cierre, anulación       | ✅ Cerrada (2026-09-04) | 30/30 E2E verdes en producción, CI verde, deploy hecho   |
| 3 — Corte tercerizado + flejes               | ✅ Cerrada (2026-09-02) | 34/34 E2E verdes en producción, CI verde, deploy hecho   |
| 4 — Producción + `/planta`                   | ⚪ Pendiente            | —                                                        |
| 5 — Cotizaciones y ventas                    | ⚪ Pendiente            | —                                                        |
| 6 — Facturación Nubefact                     | ⚪ Pendiente            | —                                                        |
| 7 — Auditoría, reportes, UAT                 | ⚪ Pendiente            | —                                                        |

## Fase 0 — detalle

| #   | Entregable                                                   | Estado                                                                                                                       |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | CLAUDE.md                                                    | ✅                                                                                                                           |
| 2   | docs/PROGRESO.md, docs/DECISIONES.md, docs/handoff/          | ✅                                                                                                                           |
| 3   | Monorepo pnpm + Turborepo (api, web, shared, eslint-config)  | ✅ `pnpm build/lint/typecheck/test` en verde                                                                                 |
| 4   | Prisma v0 (User, Session, AuditLog) + migración inicial      | ✅ `20260902160054_init` + `20260902170000_refresh_grace_and_audit_append_only`                                              |
| 5   | Neon ramas dev/ci + migración en dev + seed admin            | ✅ ramas `dev` y `ci` creadas; migraciones y seed aplicados en `dev`, `ci` y `production`                                    |
| 6   | Auth D-010 + CRUD usuarios + GET /health                     | ✅ revisado por `revisor` y `auditor-seguridad`; hallazgos corregidos                                                        |
| 7   | Web: login, cambio de contraseña, sidebar por rol, /usuarios | ✅                                                                                                                           |
| 8   | Tests unit (Jest) + E2E Playwright                           | ✅ 23 unit; 7 E2E en local (Neon `dev`); 6 E2E de auth verdes contra producción, incluidos los 4 escenarios exigidos (D-024) |
| 9   | CI GitHub Actions + SonarCloud/Semgrep                       | ✅ corrida 33660853547 verde: calidad, SonarCloud, E2E (Neon `ci`)                                                           |
| 10  | Deploy Cloud Run + Vercel, login verificado en prod          | ✅ API en Cloud Run, web en Vercel, login real de administrador verificado en producción                                     |
| 11  | UptimeRobot (API /health, Web /)                             | ✅ ambos monitores activos (API v3 de UptimeRobot)                                                                           |
| 12  | Subagentes revisor, auditor-seguridad, qa                    | ✅ `.claude/agents/`; ejecutados sobre Fase 0                                                                                |
| 13  | Cierre: handoff, decisiones, commit, push                    | ✅ `docs/handoff/fase-0.md`; varios commits en `main`, CI verde                                                              |

## Fase 1 — detalle

| #   | Entregable                                                                                                              | Estado                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Decisiones D-025..D-034, §5 resuelta, §3.7 reordenado, RF-80..94 (§4.7/§4.8)                                            | ✅ `docs/ARQUITECTURA.md`, `docs/DECISIONES.md`                                                                   |
| 2   | Prisma: business_lines, finishes, products, customers, suppliers, pricing_settings, exchange_rates, import_batches/rows | ✅ migración `20260902195110_fase1_maestros_catalogo_importacion` aplicada en `dev`, `ci` (vía CI) y `production` |
| 3   | API: business-lines, finishes, catalog, customers, suppliers, pricing, exchange-rates, documents, imports               | ✅ auditoría + roles en cada mutación; revisado por `revisor` y `auditor-seguridad`, hallazgos corregidos         |
| 4   | Importación genérica (RF-52) con adaptadores products/customers                                                         | ✅ sube a R2, valida fila por fila (tolerante a tildes), detecta duplicados intra-archivo, confirma fila por fila |
| 5   | Web: /lineas, /acabados, /catalogo, /clientes, /proveedores, /configuracion/{margenes,tipo-cambio}                      | ✅ CRUD + baja lógica + búsqueda (RF-84) donde aplica; probado a mano en Chrome contra Neon `dev`                 |
| 6   | Tests unit (exchange-rates, pricing) + E2E (`e2e/tests/fase1.spec.ts`)                                                  | ✅ 35 unit; 12 E2E locales (Fase 0 + Fase 1); CI verde (corridas 33682260101, 33682674374, 33683077599)           |
| 7   | Deploy: API a Cloud Run, migración+seed en `production`, web vía push a `main`                                          | ✅ `pnpm db:prod`, `pnpm deploy:api`                                                                              |
| 8   | E2E de Fase 1 contra producción                                                                                         | ✅ `pnpm e2e:prod` corre ahora `auth.spec.ts` + `fase1.spec.ts` (11/11); cada test revierte lo que crea/cambia    |
| 9   | Cierre: handoff, decisiones, commit, push                                                                               | ✅ `docs/handoff/fase-1.md`                                                                                       |

**Hallazgos de seguridad corregidos en Fase 1:** `xlsx@0.18.5` tenía 2 CVE high sin parche en npm (prototype pollution, ReDoS) → reemplazado por el build oficial `0.20.3` de `cdn.sheetjs.com`; el nombre de archivo subido en `imports` se saneaba antes de ir a la key de R2 y a la columna `file_name`; los errores de Prisma ya no se exponen crudos en el preview de importación.

**E2E de Fase 1 contra producción (D-024, extendido).** `e2e/tests/fase1.spec.ts` ahora corre contra producción bajo el mismo gate `E2E_ALLOW_WRITES=1` que `auth.spec.ts`, orquestado por el mismo `pnpm e2e:prod` (que ahora ejecuta ambos specs en una sola corrida con el mismo admin efímero). A diferencia de los usuarios (borrados por `cleanup-e2e-users.ts`), estos tests tocan entidades reales (`finishes`, `products`, `pricing_settings`) que no tienen borrado físico: cada test revierte lo suyo en un `finally` —el acabado y los productos creados quedan `isActive:false` (identificables por su código/SKU con prefijo `E2E`/`SKU-`/`IMP-`), y el margen de Drywall vuelve exactamente al valor que tenía antes del test—, así que corre limpio pase lo que pase. Verificado a mano tras la corrida: `pricing` de Drywall en `20.0000`/`10.0000` (el valor sembrado) y las 4 entidades de prueba en `isActive:false`.

**Hallazgos de seguridad diferidos a Fase 7 (hardening), riesgo bajo dado que `imports` es ADMINISTRADOR-only:**

- `parse-spreadsheet.ts` aplica el límite de 2000 filas después de que SheetJS ya descomprimió el archivo completo en memoria; un `.xlsx` diseñado como zip bomb podría agotar memoria antes del chequeo. Mitigación futura: acotar el tamaño descomprimido o mover el parseo a un worker con límite de memoria.
- El `ContentType` guardado en R2 para el archivo de origen es el `mimetype` que declara el cliente, no uno derivado del contenido real. Hoy no hay endpoint que sirva ese objeto de vuelta, así que no es explotable; si se agrega un endpoint de descarga, fijar el `ContentType` según el tipo detectado por el parser.

## Fase 2a — detalle

| #   | Entregable                                                                                                                                                                     | Estado                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | Decisiones D-035..D-042, RF-15, §4.8 reescrita (RF-90..94), §3.7 partida en 2a/2b                                                                                              | ✅ `docs/ARQUITECTURA.md` §0.2, `docs/DECISIONES.md`                                  |
| 2   | Referencia UBL 2.1 + catálogos SUNAT 01/03/06                                                                                                                                  | ✅ `docs/referencias/ubl21-factura.md` (subagente `investigador` vía `agy`)           |
| 3   | Prisma: `inventory_movements`, `inventory_balances`, `purchases`, `purchase_items`, `supplier_payments`, `coils`; `suppliers.code`/`coilSeq`; `pricing_settings.overheadPerKg` | ✅ migración `20260903120000_fase2a_kardex_compras_bobinas`, aplicada en `dev`        |
| 4   | Kardex: `InventoryService.record` como único escritor, promedio ponderado, NOOP explícito                                                                                      | ✅ trigger append-only y `CHECK qty > 0` en la base; saldo bloqueado con `FOR UPDATE` |
| 5   | Compras: 4 tipos, recepción, pagos parciales, saldo y estado de cuenta                                                                                                         | ✅ `apps/api/src/purchases/`; aritmética separada en `purchase-math.ts`               |
| 6   | Bobinas: código RF-13, typeKey RF-14, SKU D-037, alta por compra / XML / planilla                                                                                              | ✅ `apps/api/src/coils/`, `invoice-xml.ts`, `imports/adapters/coils.adapter.ts`       |
| 7   | Web: `/compras`, `/compras/nueva`, `/compras/[id]`, `/proveedores/[id]/estado-cuenta`, `/bobinas`, `/bobinas/nueva-xml`, `/bobinas/importar`                                   | ✅                                                                                    |
| 8   | Tests unit (kardex, códigos de bobina, parser XML, aritmética de compras)                                                                                                      | ✅ 83 unit en verde                                                                   |
| 9   | Revisión de `revisor` y `auditor-seguridad`                                                                                                                                    | ✅ 1 bloqueante + 4 altos corregidos; ver abajo                                       |
| 10  | E2E de Fase 2a                                                                                                                                                                 | 🟡 en curso                                                                           |
| 11  | Deploy y migración en `production`                                                                                                                                             | ⚪ pendiente                                                                          |
| 12  | Cierre: handoff, commit, push                                                                                                                                                  | ⚪ pendiente                                                                          |

**Hallazgos corregidos en esta fase (revisor + auditor-seguridad).**

- **Bloqueante.** Un pago en soles contra una compra en dólares resolvía el tipo de cambio de la moneda del _pago_ (PEN → 1.0000) en vez de la de la compra, así que S/ 500 cancelaban USD 500 y el pago quedaba persistido con ese TC. Corregido: el TC se resuelve siempre contra la moneda extranjera en juego.
- **Alto.** El kardex guardaba el costo en la moneda del documento y no tiene columna de moneda: comprar el mismo ítem en USD y en PEN mezclaba dos escalas en el promedio ponderado y el valorizado sumaba monedas distintas. Corregido con **D-042** (el kardex se lleva en soles).
- **Alto.** `receive` y `addPayment` validaban estado y saldo _fuera_ de la transacción: dos recepciones simultáneas duplicaban movimientos de kardex y dos pagos simultáneos podían sobrepagar. Corregido con un `updateMany` condicionado a `DRAFT` y un `SELECT ... FOR UPDATE` respectivamente.
- **Alto.** Una compra `COIL`/`FINISHED_GOOD` sobre la línea `services` (NOOP) creaba bobinas cuyo movimiento el kardex descartaba en silencio. Ahora se rechaza al registrar la compra.
- **Alto (preexistente, fuera del diff de la fase).** El tracker del rate limit tomaba el primer salto de `X-Forwarded-For`, que el cliente controla y que Cloud Run _añade_ en vez de reemplazar: rotando esa cabecera se anulaba el límite de 10/min de `/auth/login`. Ahora usa `req.ip` (Express con `trust proxy`) y, en el login, el correo. **Queda pendiente para Fase 7** el bloqueo temporal de cuenta tras N intentos fallidos, que el auditor recomendó junto con esto.
- **Medios/bajos corregidos:** el listado mezclado de movimientos cortaba por los más antiguos presentándolos como recientes; `thicknessMm` e `igvRate` sin validar daban 500 o totales absurdos; `sourceXmlKey` aceptaba cualquier ruta de R2; el saldo nunca llegaba a cero con pagos en otra moneda; el kardex admitía mezclar unidades en un mismo saldo; el código corto del proveedor se podía cambiar con bobinas ya emitidas; `imports` tragaba el error real al confirmar una fila; se avisa cuando el XML mezcla tasas de IGV o cuando sus precios unitarios no reproducen su propio valor de venta. Roles: compras y bobinas salen del alcance de VENDEDOR (exponen costos y cuentas por pagar) y el estado de cuenta queda solo para ADMINISTRADOR; la subida de XML gana throttle propio, filtro de extensión y tope de 200 líneas por compra.

**E2E de Fase 2a contra producción.** `pnpm e2e:prod` corre ahora `auth.spec.ts` + `fase1.spec.ts` + `fase2a.spec.ts` con el mismo administrador efímero (16/16 verdes tras el deploy). Fase 2a solo puede revertir lo que el modelo permite revertir; verificado a mano con `node scripts/prod-e2e-leftovers.mjs` (script de solo lectura) justo después de la corrida:

- Proveedores E2E: 5, **ninguno activo**. Acabados E2E: 5, ninguno activo. Productos `BOB…` de `trading` (D-037): 4, ninguno activo.
- Compras: `F001-390520723` COIL RECEIVED, `F001-390545867` COIL **CANCELLED** (la del XML, revertida por el test), `F001-390581293` SERVICE DRAFT (tiene un pago, por eso no se puede anular), `F001-390595797` EXPENSE RECEIVED.
- 4 bobinas OPEN y **4 movimientos de kardex en total**: 2 de la compra COIL recibida y 2 de la importación por planilla. La compra EXPENSE recibida no generó ninguno — la prueba de D-030 se cumple también en producción, no solo en local.

Una compra ya recibida, sus bobinas y sus movimientos no se pueden deshacer hasta Fase 2b: el kardex es append-only por diseño (§3.2) y anular exige el movimiento inverso, que es alcance de 2b. Todo eso queda bajo proveedores desactivados y con nombres `E2E …`, identificable a simple vista en `/proveedores` y `/compras`.

**Diferido a Fase 2b o posterior (anotado por el revisor, no es un bug):**

- `receive` hace N+1 dentro de la transacción (proveedor, acabado y línea de negocio se consultan por cada línea) mientras mantiene el lock del correlativo del proveedor. Con compras de pocas líneas no es un problema; conviene precargar antes del bucle cuando 2b agregue más operaciones sobre bobinas.
- `previewFromXml` sube el XML a R2 antes de que el usuario confirme: cada preview abandonado deja un objeto huérfano bajo `purchases/xml/`. Necesita una regla de expiración en R2 o un job de limpieza (va junto con la limpieza de `imports/` ya anotada para Fase 7).
- Anular una compra ya recibida y revertir sus movimientos es de Fase 2b: hoy `cancel` solo acepta compras en `DRAFT` y sin pagos.

## Fase 2b — detalle

| #   | Entregable                                                                                                              | Estado                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Decisiones D-043 (landed cost, cierra P-12), D-044 (RF-22 pasa a Fase 3), D-045 (edición de costo), D-046 (quién anula) | ✅ `docs/ARQUITECTURA.md` §0.2, §4.2, §5; contexto largo en `docs/DECISIONES.md` |
| 2   | Prisma: `coil_splits`, `inventory_movements.notes`, `coils.split_id`/`notes`, `purchases.related_purchase_id`           | ✅ migración `20260904120000_fase2b_reversa_partido_merma_landed_cost` en `dev`  |
| 3   | `InventoryService.reverse` y `adjustCost` — base de toda la fase                                                        | ✅ idempotente por el índice único de `reversal_of_id`; reversa por valor        |
| 4   | Partido (RF-15) y su reversa (RF-16): `coil-split-math.ts` + `CoilOperationsService`                                    | ✅ prorrateo por ancho sobre el ancho de la madre                                |
| 5   | Merma (RF-17) y anulación (RF-18, D-040); abrir/cerrar (RF-19); editar (RF-20, D-045); anular bobina (RF-21)            | ✅ `apps/api/src/coils/coil-operations.service.ts`                               |
| 6   | Anular compra recibida + landed cost (D-043) en `purchases`                                                             | ✅ reversa de todos sus movimientos; prorrateo por kg como `ADJUST`              |
| 7   | Web: `/inventario`, `/bobinas/[id]`, `/kardex`, anulación de compra con motivo, vínculo de landed cost                  | ✅                                                                               |
| 8   | Tests unit (reverse, ajuste de costo, partido, prorrateo)                                                               | ✅ 111 unit en verde                                                             |
| 9   | Revisión de `revisor` (API y web) y `auditor-seguridad`                                                                 | ✅ 3 bloqueantes + 7 altos corregidos; ver abajo                                 |
| 10  | E2E de Fase 2b                                                                                                          | ✅ 14 tests nuevos; 31/31 en local y 30/30 contra producción                     |
| 11  | Deploy y migración en `production`                                                                                      | ✅ migración aplicada y API redesplegado en Cloud Run                            |
| 12  | Cierre: handoff, commit, push                                                                                           | ✅ CI verde (corrida 33707954677)                                                |

**Modelo del partido (RF-15).** Se parte una porción del **largo** del rollo: la madre conserva su ancho y pierde peso. El peso que entra al partido se reparte por ancho **sobre el ancho de la madre**, no sobre la suma de los anchos de las hijas. Todo lo que las hijas no cubren —el kerf declarado más el recorte de borde— es `kerfLossKg`, pérdida real del corte. Las hijas entran al kardex al costo promedio vigente de la madre, así que el valor del inventario solo pierde lo que se lleva esa merma.

**Hallazgos corregidos en esta fase (revisor + auditor-seguridad).**

- **Bloqueante.** Ni la anulación de bobina (RF-21), ni la edición de costo (RF-20), ni la anulación de compra excluían los **pares movimiento+reversa**. Registrar una merma y anularla dejaba la bobina y su compra bloqueadas para siempre, con un mensaje que pedía anular movimientos que el usuario ya había anulado. Corregido con `liveMovements`, que descarta lo que se cancela entre sí.
- **Bloqueante.** Cambiar la moneda de una bobina de PEN a USD sin mandar tipo de cambio heredaba el `1.0000` de la bobina en soles: el recosteo entraba al kardex a un sexto de su valor real, en silencio, y la segunda corrección quedaba bloqueada por el hallazgo anterior. El schema ahora exige el TC cuando la moneda pasa a extranjera.
- **Alto.** El partido prorrateaba el peso sobre `Σ anchos + kerf`. Con tiras que no cubrían todo el ancho, la última hija se llevaba los kilos de la bobina entera —un peso imposible para su ancho— y el recorte de borde desaparecía del kardex sin darse de baja. Ahora el reparto va sobre el ancho de la madre, con ancho mínimo de hija (5 mm) y un piso de aprovechamiento del 80 % para que un partido no se pueda usar como baja encubierta de la bobina.
- **Alto (seguridad).** El landed cost (D-043) era alcanzable por SUPERVISOR_PLANTA: bastaba registrar una compra `SERVICE` de flete con monto arbitrario y vincularla a una compra `COIL` para mover el costo promedio del inventario sin tope, y sin poder revertirlo después (anular es de ADMINISTRADOR y se bloquea en cuanto la bobina se mueve). Ahora vincular exige ADMINISTRADOR y la misma línea de negocio.
- **Alto.** `applyLandedCost` leía los saldos sin bloquear las bobinas y descartaba el `null` de `adjustCost`: un consumo concurrente dejaba el `unitCostPerKg` inflado sin movimiento de kardex detrás, imposible de revertir. Ahora bloquea las filas antes de prorratear y solo toca el documento si el kardex aceptó el ajuste. Además, si ninguna bobina tiene saldo, la recepción **no aborta**: la deuda con el proveedor del flete existe igual y tiene que llegar a la cuenta por pagar (D-030).
- **Alto.** La reversa de un `ADJUST` devolvía el monto completo aunque parte del stock ya hubiera salido, dejando el promedio por debajo del costo real. Ahora prorratea por los kilos que sobreviven.
- **Medio (seguridad).** `/inventory/*` no declaraba roles, así que VENDEDOR veía `avgCost`, `unitCost` y el valorizado por línea, justo lo que `coils` y `purchases` le ocultan. §3.4 le da "inventario (lectura)", que son cantidades: ahora los campos de costo viajan en `null` para su rol y la UI muestra un guion.
- **Medios corregidos:** el saldo corrido con filtro de fechas arrancaba en cero y no cuadraba con `inventory_balances` (ahora parte del saldo de apertura); los pagos se verificaban fuera de la transacción de anulación; el `unitCostPerKg` que mueve el landed cost no quedaba auditado por bobina; una reversa que dejaba valor negativo se recortaba a cero en silencio (ahora falla con el detalle); `revertSplit` intentaba reversar movimientos ya revertidos; el mensaje para una compra vinculada **anulada** mandaba a recibirla, que es imposible.
- **Bajos corregidos:** el id de movimiento admitía valores fuera del rango de `int8` (500 en vez de 400); los `Decimal` de entrada no tenían tope de magnitud y desbordaban la columna con un 500; `lockBalance` no validaba que el saldo fuera de la línea de negocio del movimiento.

**Hallazgos del web (revisión aparte del API).** Las vistas nuevas se revisaron después, y el kardex volvió a ser el punto delicado:

- **Bloqueante.** El diálogo de edición conservaba el `1.0000` heredado al pasar una bobina de soles a dólares y lo enviaba tal cual: el recosteo de D-045 entraba al kardex —que va en soles (D-042)— a un sexto de su valor real, sin error y sin forma de corregirlo después. El tipo de cambio se vacía al salir de soles y el guardado queda bloqueado hasta escribirlo.
- **Alto.** Las tablas de partidos y de kardex del detalle no cubrían `isPending`/`isError`: una consulta caída dejaba `data` en `undefined`, no se pintaba ni una fila ni el mensaje de vacío, y un kardex roto se veía igual que una bobina sin movimientos. Justo la tabla desde la que se decide anular algo.
- **Alto.** `Number.parseFloat` sobre kilos y sobre el saldo de una compra, contra la regla dura 1 (D-003).
- **Alto.** La edición comparaba los costos como texto contra un DTO de escala fija (`"3.4500"`), así que retipear `3.45` contaba como cambio y disparaba un recosteo real —reversa del ingreso más un ingreso nuevo en un kardex append-only— por nada.
- La previsualización del partido replicaba solo dos de las cinco validaciones del API y repartía cada tira por separado en vez de por acumulado: el caso cotidiano mostraba verde y terminaba en un 400, con milésimas distintas a las que devolvía el servidor. Las constantes del partido (`MIN_CHILD_WIDTH_MM`, `MIN_SPLIT_YIELD`, topes) se movieron a `@ayr/shared` para que web y API validen contra una sola definición.
- Medios y bajos: el partido enviaba filas de ancho vacío; `relatedPurchaseId` sobrevivía invisible a un cambio de servicio o de línea; el kardex de la bobina imprimía `IN`/`SPLIT` crudos; invalidación cruzada incompleta entre bobina y compra; `colSpan` mayor que las columnas reales; `itemType` de la URL sin validar; el diálogo de anular compra perdía el motivo si el API rechazaba; y a VENDEDOR se le mostraban tres columnas de guiones en vez de ocultarle los costos.

**Hallazgo de `qa` sobre el API.** Anular una compra recibida revertía **todos** sus movimientos sin filtrar los ya revertidos: un recosteo (D-045) o una bobina anulada individualmente (RF-21) dejan bajo el mismo `refId` un ingreso revertido más su reversa, así que el bucle intentaba anular una anulación y la compra quedaba sin poder anularse nunca. Es el mismo defecto que el revisor encontró en las otras tres validaciones, en el único lugar que había quedado sin `liveMovements`.

**Rendimiento del partido y de la anulación.** Un partido creaba una bobina con ~8 consultas cada una, incluido un `UPDATE suppliers` que retiene el lock del proveedor hasta el commit: 60 hijas eran cientos de viajes a Neon bloqueando cualquier otra alta de ese proveedor. Ahora el máximo es 20 hijas, y proveedor, acabado, producto de catálogo y los N correlativos se resuelven una sola vez (`CoilsService.prepareBatch`). La anulación de una compra revierte hasta 200 movimientos en una transacción: se le subió el timeout a 120 s. Si el volumen crece, la salida es moverla a un job de pg-boss con estado `CANCELLING`.

**E2E de Fase 2b contra producción.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` con el mismo administrador efímero (30/30 verdes tras el deploy; 31/31 en local, donde además corre `usuarios.spec.ts`). Los 14 tests de 2b cubren el partido y su reversa, la merma y su anulación, la anulación de compra bloqueada y desbloqueada, el landed cost verificado en `/inventario`, el piso de aprovechamiento del partido, las dos regresiones del bug de `cancel`, el reparto de permisos de D-046 (supervisor puede / no puede, vendedor sin costos) y el ciclo de vida RF-19/20/21.

**Producción queda sin stock de prueba.** Es lo que Fase 2a no podía hacer y dejó anotado: con `reverse` construido, `pnpm prod:purge-e2e` anula por API —el mismo endpoint del dueño, con motivo y auditoría— las compras `RECEIVED` y las bobinas con saldo que cuelgan de un proveedor `E2E …`. Hacía falta: tras la corrida, `/inventario` mostraba S/ 113 000 de stock de prueba en Drywall, justo lo que la pantalla nueva no tiene que mostrar. Verificado después de ejecutarlo: **0 bobinas abiertas con saldo**, las 34 de prueba en `CANCELLED`, y el kardex conservando las 92 filas del rastro (§3.2). El script admite `--dry-run` y borra el administrador efímero al terminar. Conviene correrlo después de cada `pnpm e2e:prod`.

Lo que sigue sin cubrirse por E2E: operar el partido, la merma y las anulaciones **desde los diálogos de la UI** (hoy se hacen por API y la UI se verifica en lectura) y `/kardex?item=` con filtro de fechas, cuyo saldo de apertura se verificó a mano contra `inventory_balances` en Neon `dev`.

**Diferido a fases posteriores:**

- `findMovements` de un ítem lee hasta 10 000 movimientos para calcular el saldo corrido. Sirve de sobra hoy; con años de historia hay que paginar hacia atrás desde un saldo de apertura, que ya está implementado para el filtro por fechas.
- El prorrateo de landed cost es siempre **por kg** (D-043). Si aparece un seguro que se cobra sobre el valor CIF, se agrega el criterio como campo de la compra.
- RF-22 (cancelar plan de corte) es de Fase 3 por D-044: en 2b no existe todavía el plan de corte.

## Fase 3 — detalle

| #   | Entregable                                                                                                                       | Estado                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Decisiones D-047..D-050 (P-13 resuelta), §3.7 reordenado (D-048), §4 con RF-22 anotado                                           | ✅ `docs/ARQUITECTURA.md` §0.2, §3.7, §5; espejo en `docs/DECISIONES.md`           |
| 2   | Prisma: `coils.kind`, `CoilStatus.IN_THIRD_PARTY`, `cutting_orders`, `cutting_order_coils`, `purchases.related_cutting_order_id` | ✅ migración `20260903031603_fase3_corte_flejes`, aplicada en `dev` y `production` |
| 3   | Módulo `cutting`: envío (RF-40), recepción parcial por bobina (RF-41), cancelación (RF-22)                                       | ✅ `apps/api/src/cutting/`                                                         |
| 4   | Costo del servicio de corte: prorrateo por kg entre flejes recibidos (RF-41)                                                     | ✅ `applyCuttingOrderCost` en `purchases.service.ts`, mismo patrón D-043           |
| 5   | Web: `/corte`, `/corte/nueva`, `/corte/[id]`, `/flejes` (RF-42)                                                                  | ✅                                                                                 |
| 6   | Tests unit (plan de corte, prorrateo, cancelación parcial)                                                                       | ✅ 5 en `cutting-math.spec.ts` (121 unit en total)                                 |
| 7   | Revisión de `revisor`, `auditor-seguridad`, `qa`                                                                                 | ✅ 1 alto + 3 medios/bajos + 1 bloqueante de `qa` corregidos; ver abajo            |
| 8   | E2E de Fase 3                                                                                                                    | ✅ 4 tests nuevos; 35/35 en local y 34/34 contra producción                        |
| 9   | Deploy y migración en `production`                                                                                               | ✅ migración aplicada y API redesplegado en Cloud Run; web por push a `main`       |
| 10  | Cierre: handoff, commit, push                                                                                                    | ✅ `docs/handoff/fase-3.md`                                                        |

**Hallazgos corregidos en esta fase (`revisor`).**

- **Alto.** `widthPlanSchema` (`packages/shared/src/schemas/cutting.ts`) topaba anchos por fila y filas por plan, pero no el total de tiras: a diferencia de `createCoilSplitSchema` (RF-15), un `receive()` podía pedir cientos de flejes en una sola transacción con lock. Corregido con el mismo `superRefine` de tope total (`MAX_SPLIT_CHILDREN`) que ya tenía el partido interno.
- **Medio.** `/flejes` sumaba el valorizado total con `Number`/`+` en vez de `Decimal` (D-003). Corregido.
- **Medio.** La previsualización de recepción (`cutting-receive-dialog.tsx`) solo replicaba el presupuesto de ancho de `receive()`, no el ancho mínimo por fleje ni el piso de aprovechamiento del 80% que `planCoilSplit` también exige ahí — el mismo hueco que el partido interno tuvo en Fase 2b antes de corregirse. Corregido.
- **Bajos.** `nueva-orden-view.tsx` no cubría `isError` de sus queries; `CoilOperationsService.lockCoil` y el `lockCoil` propio de `CuttingService` eran una copia textual — se unificó como `CoilsService.lockCoil`, que ambos ahora reusan.

**Auditoría de seguridad (`auditor-seguridad`, con segunda opinión de `agy`).** Sin hallazgos críticos ni altos: `$queryRaw` nuevos parametrizados vía tagged template (sin inyección), `assertCuttingOrderLinkIsValid` exige ADMINISTRADOR igual que el landed cost de D-043, `GET /cutting/strips` oculta costos a VENDEDOR igual que `/inventory/*`, sin escritura de kardex fuera de `InventoryService`.

**Hallazgo de `qa` sobre el API (bloqueante, corregido).** `registerScrap`, `cancel` y `setStatus` de bobina (`coil-operations.service.ts`) solo bloqueaban `CoilStatus.CANCELLED`; como D-050 hace que enviar una bobina a corte (`IN_THIRD_PARTY`) no genere movimiento de kardex, esos tres endpoints trataban una bobina en poder de un tercero como si estuviera disponible: se le podía registrar merma, anularla o cambiarle el estado sin que la orden de corte se enterara, dejando `cutting_order_coils` apuntando a una bobina que ya cambió por debajo. La misma falla existía en `PurchasesService.cancel()`: anular la compra original de una bobina enviada a corte la cancelaba igual (sin movimiento "posterior" que lo bloqueara, porque el envío no deja rastro en el kardex). Los cuatro sitios ahora bloquean también `IN_THIRD_PARTY`, con un mensaje que distingue por qué la bobina no está disponible.

**E2E de Fase 3 contra producción.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` + `fase3` con el mismo administrador efímero (34/34 verdes tras el deploy; 35/35 en local, donde además corre `usuarios.spec.ts`). Los 4 tests de Fase 3 cubren el flujo completo (enviar → bloqueo de partido local mientras está en el tercero → recibir con merma y prorrateo → `/cutting/strips` → compra de servicio que sube el costo → cancelar lo pendiente), la validación del plan de anchos, la cancelación parcial de una orden con dos bobinas, y los permisos de D-046/D-043 (supervisor opera, solo administrador vincula la factura del servicio).

**Producción queda casi sin stock de prueba, con un residual acotado y documentado.** `pnpm prod:purge-e2e` ganó un paso previo (D-050) que cancela las órdenes de corte E2E que quedaron `SENT`/`PARTIALLY_RECEIVED` antes de intentar anular compras y bobinas — necesario porque, a diferencia de una compra o un partido, enviar a corte no deja ningún movimiento de kardex que bloquee nada, así que sin este paso una bobina `IN_THIRD_PARTY` quedaba fuera del alcance de los dos pasos siguientes. Tras la corrida quedan **3 bobinas madre con material sin poder anularse** (una con 2 000 kg de saldo, dos ya `CLOSED` sin saldo): son las que el test de Fase 3 recibió parcialmente, y su compra `COIL` original queda bloqueada porque la bobina ya tiene un movimiento `CUTTING` posterior a su ingreso — la misma regla que protege cualquier bobina que ya se movió (RF-21, `cancel` de compra). **No existe una reversa de recepción de corte** (RF-40..42 solo definen RF-22, cancelar el plan _antes_ de recibir): es el mismo hueco que tuvo Fase 2a antes de que 2b construyera `reverse`, aplicado ahora a la recepción de corte. Queda anotado como pendiente para cuando haga falta (ver "Diferido a fases posteriores"); todo lo demás (proveedores, acabados, productos `BOB…`, el resto de compras y bobinas) quedó desactivado/anulado y verificado con `node scripts/prod-e2e-leftovers.mjs`.

**Diferido a fases posteriores:**

- No hay endpoint para revertir una recepción de corte tercerizado (deshacer RF-41 después de recibida): si un operario recibe mal una bobina, hoy no hay forma de deshacerlo — solo de corregirlo hacia adelante (otra merma, otro partido). Simétrico a lo que RF-16 resuelve para el partido interno; se agrega si el negocio lo pide.
- `findMovements`/`applyCuttingOrderCost` heredan las mismas limitaciones ya anotadas para landed cost en Fase 2b (paginación de historial largo, prorrateo siempre por kg).

## Bloqueos

Ninguno abierto. B-01 (facturación GCP) fue resuelta por el dueño el 2026-09-02; ver "B-01 — resuelta" abajo para el detalle de cómo se cerró y qué se aprendió en el proceso.

### B-01 — RESUELTA (2026-09-02): GCP vinculado a facturación

El dueño vinculó el proyecto GCP `ayr-steel-erp` a una cuenta de facturación desde la consola web. A partir de ahí, todo lo demás se completó de forma autónoma:

- `pnpm secrets:gcp` — habilitó las APIs, creó los 3 secretos en Secret Manager y otorgó los roles IAM que Cloud Build y la revisión de Cloud Run necesitan (ver "Hallazgo — IAM insuficiente" abajo).
- `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app` — API en `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`, `/health` en verde.
- `pnpm deploy:web --api-url https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app` — web de producción re-apuntado al API real.
- `pnpm db:prod` — aplicó la migración `refresh_grace_and_audit_append_only` que había quedado solo en Neon `dev` (ver "Hallazgo — migración desactualizada" abajo).
- `pnpm monitors --api-url ... --web-url ...` — los dos monitores de UptimeRobot activos.
- Login real del administrador verificado contra producción (cookies `httpOnly`/`Secure`/`SameSite` correctas). Luego, con `pnpm e2e:prod` (D-024), los 6 escenarios de `auth.spec.ts` en verde contra `https://ayr-steel-erp-web.vercel.app`, incluidos los cuatro exigidos por el cierre de fase: login correcto, login fallido, usuario desactivado no entra y cambio de rol invalida la sesión.

**Hallazgo — migración de producción desactualizada.** La migración `20260902170000_refresh_grace_and_audit_append_only` se había aplicado en la sesión anterior solo a Neon `dev` (vía `cd apps/api && prisma migrate deploy`, que usa `apps/api/.env`), nunca a `production`. El primer intento de login en prod devolvió 500 (`column sessions.previous_token_hash does not exist`). Se corrigió reejecutando `pnpm db:prod`, que aplica todas las migraciones pendientes contra la rama correcta explícitamente. Lección: tras crear una migración manualmente durante una sesión, volver a correr `pnpm db:prod` antes de dar una fase por cerrada si ya se desplegó a producción.

**Hallazgo — rewrite de Vercel bloqueaba el API (D-022).** El `rewrites()` de `next.config.ts` hacia el dominio por defecto de Cloud Run (`*.a.run.app`) devolvía `DNS_HOSTNAME_RESOLVED_PRIVATE` en producción — falso positivo de la protección SSRF de Vercel contra las IPs de Google Frontend. Se reemplazó por un Route Handler catch-all (`apps/web/src/app/api/[...path]/route.ts`) que hace el proxy con `fetch` server-side dentro de una función Node; Vercel no aplica ese chequeo a un `fetch` normal, solo a `rewrites()` declarativos.

**Hallazgo — IAM insuficiente para `deploy --source` (D-023).** La service account de Compute por defecto (`<project-number>-compute@developer.gserviceaccount.com`) tenía `roles/editor` a nivel de proyecto, pero eso no bastó para: (a) que Cloud Build leyera el zip fuente subido al bucket `run-sources-*`, ni (b) que la revisión de Cloud Run leyera los secretos de Secret Manager. `scripts/gcp-secrets.mjs` ahora otorga explícitamente `roles/secretmanager.secretAccessor` (por secreto) y `roles/{storage.objectViewer,cloudbuild.builds.builder,artifactregistry.writer,logging.logWriter}` (a nivel proyecto) a esa cuenta, así que un proyecto GCP nuevo no debería repetir este bloqueo.

## Notas operativas

- `gcloud` en Git Bash falla ("Python was not found"); funciona vía `cmd /c gcloud ...` o desde PowerShell/cmd. `scripts/lib.mjs#run` ya lo resuelve.
- La rama por defecto de Neon se llama `production` (no `main`). Ver D-016.
- Prisma bloquea `migrate reset` cuando lo invoca un agente. El reset de pruebas es `apps/api/prisma/reset-test-db.ts` (D-018).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel está ligado al repo GitHub: cada push a `main` despliega el web.
- El proxy `/api/*` del web es un Route Handler (fetch server-side), no un `rewrite()` de Next: Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run (D-022).
- Para verificar RF-03 contra producción: `pnpm e2e:prod`. Crea un administrador efímero, corre los 6 escenarios de auth y borra los usuarios `e2e-...@ayr.test` en `finally` (D-024). Nunca usa ni modifica la cuenta del dueño. Si la limpieza fallara, el script lo avisa y hay que revisar `/usuarios` en producción.
- `spawnSync('algo.cmd', ...)` sin `shell: true` falla con `EINVAL` en esta máquina Windows/Node 24; usar `shell: true` (o invocar `cmd.exe /c` explícito) al lanzar `pnpm`/binarios `.cmd` desde Node.
- Hallazgos de revisión pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquí para Fase 7 (hardening).
- SonarCloud: en `.env.setup` `SONAR_ORG` y `SONAR_PROJECT_KEY` venían intercambiados (corregido: org `gsinuiri-coder`, key `gsinuiri-coder_ayr-steel-erp`). El proyecto tenía Automatic Analysis activo; se desactivó por API para que el análisis lo haga CI con cobertura (D-021).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesión de Claude Code; en esta sesión se ejecutaron como `general-purpose` con la definición como prompt.
- **Fase 1.** apis.net.pe: el endpoint real es `v1/tipo-cambio-sunat?fecha=YYYY-MM-DD` (verificado contra la API real), no `v2/sunat/tipo-cambio` como se asumió al principio — devolvía 404 y quedó registrado un momento en el log como "no respondió" antes de corregirlo.
- **Fase 1.** `XLSX.read(buffer, {type:'buffer'})` asume un codepage no-UTF-8 para `.csv`, lo que rompe encabezados con tildes ("Línea" no matcheaba ninguna columna). `parse-spreadsheet.ts` ahora detecta si el archivo es un zip real (firma `PK`, `.xlsx`) y si no lo es, decodifica como UTF-8 y lee en modo `'string'`. Encontrado por el E2E de importación, no es cosmético: sin este fix ninguna fila con encabezados en español se validaba nunca.
- **Fase 1.** El E2E de CI (`imports`) sube archivos reales al bucket R2 de producción (`R2_BUCKET` es el mismo en GCP y en GitHub Secrets); quedan objetos de prueba con prefijo `imports/...` en R2 tras cada corrida de CI. No es un riesgo de seguridad, pero conviene un bucket o prefijo separado para CI si el volumen de corridas crece (anotado para Fase 7).
- Prisma expone el enum `BusinessLineCode` con los nombres declarados en el schema (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`, `metallic-roofing`...); `apps/api/src/common/business-line-code.ts` es el único lugar que traduce entre eso y el `BusinessLine` de `@ayr/shared`. Si se agrega una sexta línea de negocio, hay que tocar ese mapa además del enum de Prisma y el de `@ayr/shared`.
- **`ADMIN_PASSWORD` de `.env.setup` ya no es la contraseña real del admin en `production`.** El dueño la cambió al completar el flujo de `mustChangePassword` en su primer ingreso (cierre de Fase 0). Un intento de `POST /auth/login` contra producción con las credenciales de `.env.setup` devuelve `401 Credenciales inválidas` (evidencia de esta sesión, sin haber tocado nada). **Nunca** intentar loguearse como el admin real contra producción para verificar algo: usar siempre un administrador efímero (`apps/api/prisma/e2e-admin.ts` + `cleanup-e2e-users.ts`, patrón D-024) igual que hace `pnpm e2e:prod`.
