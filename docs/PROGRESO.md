# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                                   | Estado                  | Cierre                                                                 |
| ------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------- |
| 0 — Bootstrap                                          | ✅ Cerrada (2026-09-02) | Login E2E verde en prod, CI verde                                      |
| 1 — Maestros, catálogo, precios, importación           | ✅ Cerrada (2026-09-02) | E2E de Fase 1 verdes en local + CI, deploy en producción               |
| 2a — Kardex + compras + alta de bobinas                | ✅ Cerrada (2026-09-03) | 16/16 E2E verdes en producción, CI verde, deploy hecho                 |
| 2b — Partido, merma, cierre, anulación                 | ✅ Cerrada (2026-09-04) | 30/30 E2E verdes en producción, CI verde, deploy hecho                 |
| 3 — Corte tercerizado + flejes                         | ✅ Cerrada (2026-09-02) | 34/34 E2E verdes en producción, CI verde, deploy hecho                 |
| 3b — Reversa de recepción de corte                     | ✅ Cerrada (2026-09-03) | 40/40 E2E verdes en producción, CI verde, deploy hecho                 |
| 4 — Producción drywall + `/planta`                     | ✅ Cerrada (2026-09-03) | 56/56 E2E en producción, CI verde, deploy hecho                        |
| 5a — Cotización → pedido + reserva                     | ✅ Cerrada (2026-09-04) | 83/83 E2E en producción, CI verde, deploy hecho                        |
| 5b — Facturación, GRE, despacho y cobranza             | ✅ Cerrada (2026-09-04) | 19 E2E contra el PSE demo, 89/89 en producción, CI verde, deploy hecho |
| 6 — Producción de coberturas + color                   | ✅ Cerrada (2026-09-05) | 101/101 E2E en producción, CI verde, deploy hecho, purga sin rastros   |
| 7 — Cola, punto de venta e importación de comprobantes | 🟡 En curso (2026-09-05) | Cola de producción cerrada: 110/110 E2E en producción (13 saltados por D-081, no emiten), purga sin rastros, deploy de API hecho (web pendiente: token de Vercel vencido). Faltan RF-60 (POS) y RF-71/72 (importación) |
| 8 — Auditoría, reportes, UAT                           | ⚪ Pendiente            | —                                                                      |

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

- No hay endpoint para revertir una recepción de corte tercerizado (deshacer RF-41 después de recibida): si un operario recibe mal una bobina, hoy no hay forma de deshacerlo — solo de corregirlo hacia adelante (otra merma, otro partido). Simétrico a lo que RF-16 resuelve para el partido interno; se agrega si el negocio lo pide. **Cerrado en Fase 3b.**
- `findMovements`/`applyCuttingOrderCost` heredan las mismas limitaciones ya anotadas para landed cost en Fase 2b (paginación de historial largo, prorrateo siempre por kg).

## Fase 3b — detalle

| #   | Entregable                                                                         | Estado                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Decisiones D-051 (secuenciación) y D-052 (guardrails de la reversa)                | ✅ `docs/ARQUITECTURA.md` §0.2, §3.7; contexto largo en `docs/DECISIONES.md`                                           |
| 2   | Prisma: `cutting_order_coils.reverted_by_id`/`reverted_at`                         | ✅ migración `20260904130000_fase3b_reversa_recepcion_corte`, aplicada a mano en `dev` y `production` (ver nota abajo) |
| 3   | `CuttingService.reverse()` (RF-41 a la inversa), simétrico a RF-16                 | ✅ `apps/api/src/cutting/cutting.service.ts` + endpoint en `cutting.controller.ts`                                     |
| 4   | Fix: `revertSplit` (RF-16) también bloquea si la madre está `IN_THIRD_PARTY`       | ✅ `apps/api/src/coils/coil-operations.service.ts` (D-052)                                                             |
| 5   | Web: botón "Revertir" en `/corte/[id]` para filas `RECEIVED`, mismo `ReasonDialog` | ✅                                                                                                                     |
| 6   | Revisión de `revisor`, `auditor-seguridad` y `qa`, en paralelo                     | ✅ 1 alto + 1 medio + 1 bajo corregidos/cubiertos; ver abajo                                                           |
| 7   | E2E de Fase 3b                                                                     | ✅ 6 tests nuevos; 41/41 en local y 40/40 contra producción                                                            |
| 8   | Deploy y migración en `production`                                                 | ✅ migración aplicada, API redesplegado, web por push a `main`                                                         |
| 9   | `pnpm prod:purge-e2e` extendido para revertir recepciones de corte antes de anular | ✅ producción queda con 0 bobinas abiertas con saldo                                                                   |
| 10  | Cierre: handoff, commit, push                                                      | ✅ este documento + `docs/handoff/fase-3b.md`                                                                          |

**Nota — migración escrita a mano.** `pnpm db:migrate` (`prisma migrate dev`) falla contra el shadow database con `type "CoilStatus" does not exist`: la carpeta de la migración de Fase 3 (`20260903031603_fase3_corte_flejes`) quedó nombrada con una fecha anterior a las de Fase 2a/2b (`20260903120000`/`20260904120000`) aunque depende de tipos que esas crean, así que reproducir todo el historial desde cero en un shadow database nuevo falla — aunque el historial real aplicado a cada rama de Neon es correcto (cada fase se aplicó en el orden real de las sesiones, no en el de sus nombres de carpeta). La migración de esta fase se escribió a mano (mismo SQL que `prisma migrate dev` habría generado: dos columnas nullable) y se aplicó con `prisma migrate deploy` (`pnpm db:deploy`/`pnpm db:prod`), que no usa shadow database. Queda anotado para quien toque el historial de migraciones: renombrar la carpeta de Fase 3 arreglaría el shadow database, pero es una operación de riesgo sobre migraciones ya aplicadas en `production` que no se intentó sin autorización explícita del dueño.

**El diseño de `reverse()` (D-052).** Simétrico a RF-16 en la forma (revierte primero las entradas de los flejes, luego la salida de la madre; "todo o nada": si un fleje ya se movió, falla completo nombrándolo), con un guardrail propio que RF-16 no necesitaba: D-050 permite que una bobina se reenvíe a otra orden de corte sin dejar rastro de kardex, así que antes de revertir la madre debe estar `OPEN`/`CLOSED` (nunca `IN_THIRD_PARTY` de otro envío, nunca `CANCELLED`) y sin movimientos posteriores a la recepción que se revierte. Con ambos guardrails en verde, el resultado es siempre el mismo: la fila vuelve a `SENT` y la madre a `IN_THIRD_PARTY` — el envío queda vivo por construcción, nunca se llega a un "disponible" ambiguo. El mismo guardrail de `IN_THIRD_PARTY` se agregó retroactivamente a `revertSplit` (RF-16), que tenía el mismo hueco sin haberlo necesitado nunca hasta D-050.

**Hallazgos corregidos en esta fase (`revisor` + `qa`).**

- **Alto (`revisor`).** `reverse()` armaba los `strips` de una recepción con `tx.coil.findMany({ where: { cuttingOrderCoilId: row.id } })`, sin filtrar por `status`. Como una fila `cuttingOrderCoil` es reutilizable (recibir → revertir → recibir de nuevo), esa consulta mezclaba los flejes `CANCELLED` de una recepción anterior con los vivos de la actual — en el audit log (`cancelledStrips` con códigos que esa reversa no canceló) y en la relación `strips` que expone `findOne()` a la UI (`/corte/[id]` mostraba flejes fantasma). Corregido: los flejes de la generación actual se derivan de los movimientos de kardex vivos (`movements.filter(m => m.type === 'IN')`), y `findOne()` excluye `status: CANCELLED` de la relación. `qa` agregó un E2E dedicado (recibir → revertir → recibir → revertir) que reproduce exactamente este escenario y confirma que la segunda reversa no toca los flejes de la primera.
- **Medio (`revisor`).** El primer E2E cubría el camino feliz y el bloqueo por fleje consumido, pero no los dos guardrails propios de D-052 (madre reenviada a otra orden, madre con movimiento posterior). Agregados.
- **Bajo (`revisor`).** El DTO expone `revertedAt` pero la UI no lo muestra todavía; queda como dato disponible sin usar, no bloqueante.

**Auditoría de seguridad (`auditor-seguridad`).** Sin hallazgos críticos ni altos: rol heredado del controller (`ADMINISTRADOR`+`SUPERVISOR_PLANTA`, D-046) igual que `revertSplit`; `$queryRaw` parametrizados; sin fuga de datos en mensajes de error; sin secretos; transacción con timeout; el guardrail de `IN_THIRD_PARTY` cierra el mismo hueco que el bloqueante de `qa` en Fase 3 (`registerScrap`/`cancel`/`setStatus`/`PurchasesService.cancel`), ahora también en `reverse()` y `revertSplit`. Un hallazgo bajo, de negocio no de seguridad: un cierre manual (RF-19) previo a la reversa queda sobrescrito por el `IN_THIRD_PARTY` final, comportamiento considerado correcto (el envío tiene prioridad).

**E2E de Fase 3b.** `e2e/tests/fase3b.spec.ts`, 6 escenarios: flujo feliz (recepción total → reversa → saldo original → cancelar envío → anular bobina), reversa bloqueada por fleje consumido (merma), reversa de recepción parcial (envío vivo, madre `IN_THIRD_PARTY` ni `OPEN` ni `CLOSED`), reversa bloqueada porque la madre se reenvió a otra orden, reversa bloqueada porque la madre tuvo un partido local posterior, y el ciclo recibir→revertir→recibir→revertir. `pnpm e2e:prod` corre ahora `auth`+`fase1`+`fase2a`+`fase2b`+`fase3`+`fase3b` con el mismo administrador efímero: **40/40 verdes contra producción; 41/41 en local** (con `usuarios.spec.ts`).

**Producción queda 100% limpia de stock de prueba — el residuo de Fase 3 está resuelto.** `pnpm prod:purge-e2e` ganó un paso previo a la cancelación de órdenes pendientes: para toda orden de corte E2E `RECEIVED`/`PARTIALLY_RECEIVED`, revierte cada fila `RECEIVED` (revirtiendo antes cualquier partido local activo sobre la madre, más reciente primero, para cumplir el guardrail de D-052) y deja la fila `SENT` de nuevo, que el paso siguiente ya sabía cancelar. Verificado después de correrlo: **0 bobinas abiertas con saldo** (las 3 bobinas madre huérfanas que Fase 3 había dejado, más las que generó volver a correr `fase3.spec.ts` en esta misma sesión, todas revertidas y anuladas), 142 bobinas de proveedores E2E en `CANCELLED`, 394 movimientos de kardex conservados (§3.2). Queda **una sola compra sin poder anularse** (`F001-403036715`, `SERVICE RECEIVED`, tiene un pago registrado) — es el mismo límite ya documentado en el cierre de Fase 2a ("tiene un pago, por eso no se puede anular"), no relacionado a corte tercerizado ni nuevo de esta fase.

**Diferido a fases posteriores:** ninguno nuevo. Los pendientes de Fase 2b/3 (paginación de `findMovements`, prorrateo siempre por kg) siguen igual.

## Fase 4 — detalle

| #   | Entregable                                                                                                            | Estado                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Decisiones D-055..D-060, §3.7 (RF-38 pasa a Fase 5), §4.3 con RF-34/RF-35 trazados                                    | ✅ `docs/ARQUITECTURA.md` §0.2, §3.2, §3.7, §4.3; contexto largo en `DECISIONES.md` |
| 2   | Prisma: `product_boms`, `production_orders`, `production_order_consumptions`, `production_reports` + dos enums nuevos | ✅ migración `20260904140000_fase4_produccion_drywall`, aplicada en `dev`           |
| 3   | Módulo `production`: receta (D-059), OP, consumo, reportes parciales, cierre con merma y costeo                       | ✅ `apps/api/src/production/`                                                       |
| 4   | Guardrail D-060 en **todas** las rutas que tocan un fleje (`coils`, `cutting`, `purchases`), no solo las nuevas       | ✅ `production-assignments.ts` como función suelta, sin ciclo de módulos            |
| 5   | Las tres reversas en esta misma fase: reporte de piezas, reapertura de OP cerrada, anulación de OP                    | ✅ `ProductionService.reverseReport/reopen/cancel`                                  |
| 6   | Web: `/planta` (captura de operario, mobile-first), `/produccion`, `/produccion/[id]`, receta en `/catalogo`          | ✅                                                                                  |
| 7   | Tests unit (`theoreticalKgPerPiece`, reparto entre flejes, costeo)                                                    | ✅ 12 nuevos en `production-math.spec.ts` (133 unit en total)                       |
| 8   | Revisión de `revisor` (API y web, por separado), `auditor-seguridad` y `qa`                                           | ✅ 1 bloqueante + 5 altos + 8 medios corregidos; ver abajo                          |
| 9   | E2E de Fase 4                                                                                                         | ✅ 16 tests nuevos: 5 de flujo + 11 de bordes escritos por `qa`                     |
| 10  | Deploy y migración en `production`; `pnpm e2e:prod` y `pnpm prod:purge-e2e`                                           | ✅ 56/56 contra producción; 0 stock de prueba tras la purga                         |
| 11  | Cierre: handoff, commit, push                                                                                         | ✅ CI verde en `main` (corrida 33786845045)                                         |

**El modelo, en cuatro actos.** Una OP fabrica un perfil contra la **receta** del producto (D-059: acabado + espesor + ancho del fleje, más `kgPerPiece`). **Consumir un fleje** lo pone a disposición de la orden y **no mueve kardex** (D-060, mismo criterio que D-050 con el envío a corte). **Reportar piezas** (N veces, D-058) saca del fleje los kilos teóricos de esas piezas y mete las piezas al producto terminado, que se lleva en **unidades, no en kilos** (D-055), valorizadas exactamente por lo que salió del fleje. **Cerrar** saca por diferencia la merma de proceso (D-057) y reparte todo el material —piezas y merma— entre las piezas buenas con un `ADJUST` (D-056). El resultado es que el valor que sale de los flejes es exactamente el que entra al producto: el kardex cierra sin residuo.

**El guardrail de D-060 es el corazón de la fase.** Asignar sin mover kardex tiene un precio: ninguna de las reglas "sin movimientos posteriores" que protegen al resto del sistema (RF-16, RF-21, D-045, D-052) ve una asignación, porque no hay movimiento que ver. Es el mismo hueco que D-050 abrió con `IN_THIRD_PARTY` y que Fase 3 tuvo que tapar a mano en cuatro sitios y Fase 3b en dos más. Esta vez se revisaron **todas** las rutas que tocan un fleje antes de escribir la primera línea de UI: merma (RF-17), partido (RF-15), cierre (RF-19), edición de costo/ancho (RF-20, D-045), anulación de bobina (RF-21), anulación de compra, reversa de recepción de corte (D-052) y consumo en otra OP. `CuttingService.send` no lo necesita: solo acepta `kind=COIL` y una OP solo consume `kind=STRIP`, así que los conjuntos no se cruzan.

**Las tres reversas van en esta fase, no en una "4b".** Revertir un reporte de piezas (solo el último vigente; bloqueado si las piezas salieron o si el cierre de otra OP del mismo perfil las recosteó), **reabrir una OP cerrada** (deshace la merma y el ajuste de costo) y anular la OP (solo sin reportes vigentes; libera los flejes sin tocar el kardex, igual que cancelar un envío `SENT`). La reapertura no estaba en el alcance escrito pero sí en el criterio de cierre: sin ella una OP cerrada sería irreversible y el stock de piezas de prueba quedaría en producción para siempre, sin forma de purgarlo — exactamente el residuo que Fase 3 dejó y que costó una sesión entera (3b) resolver.

**El "SKU de fleje" del enunciado no existe, y por buenas razones.** D-049 decidió que un fleje es una fila de `coils` con `kind=STRIP`, no un producto de catálogo, para no duplicar catálogo, kardex y trazabilidad. La receta identifica el insumo por **acabado + espesor + ancho**, que es exactamente el trío con el que RF-42 ya agrupa el stock de flejes y el que el operario ve en `/flejes`. Inventarle un SKU habría reabierto D-049 por la puerta de atrás.

**Hallazgos corregidos en esta fase (`revisor` API, `revisor` web y `auditor-seguridad`).**

- **Bloqueante (`revisor` API, confirmado por `auditor-seguridad` con el camino de UI exacto).** `cancelScrap` (RF-18) aceptaba **cualquier** movimiento `SCRAP` sobre una bobina, y la merma de proceso del cierre (D-057) tiene esa misma firma. Desde el kardex de la bobina aparecía el botón "anular la merma": pulsarlo devolvía kilos **y** valor al fleje mientras el producto terminado conservaba el costo absorbido (D-056) — valor creado de la nada en el valorizado — y una reapertura posterior ya no veía esa merma, así que devolvía el fleje con `consumedKg` sin descontar. Ahora se distinguen por `refId` (RF-17 apunta a la bobina; producción, a la orden) y la del cierre solo se deshace reabriendo la OP.
- **Alto (seguridad, ajeno a Fase 4).** El árbol de trabajo traía `.claude/settings.json` con el `deny` de `Read(./.env*)` **eliminado** y `Bash(sed:*)` agregado al `allow`, con `Read(**)` y `defaultMode: auto` vigentes: cualquier agente podía leer `.env.setup` —que según la regla dura 5 tiene todas las credenciales— sin pedir permiso. El cambio es anterior a esta sesión (venía como `M` en el `git status` inicial). Restaurado el `deny`, ampliado a `Read(**/.env*)` y quitado `Bash(sed:*)`.
- **Alto ×2 (`revisor` API).** `reopen()` solo rechazaba flejes `CANCELLED`, así que un fleje **cerrado** (RF-19) mientras la OP estaba cerrada volvía a producción sin que `report()` revalidara su estado; y el chequeo de "sin movimientos posteriores al cierre" se saltaba entero para los flejes que se consumieron enteros (no generaron merma, así que no había movimiento propio contra el cual medir "posterior"), de modo que un partido o una merma intermedios pasaban inadvertidos. Ahora se exige `OPEN` y, sin movimiento propio, la referencia es el `closedAt` de la orden.
- **Alto (`revisor` API).** `applyLandedCost` (D-043) y `applyCuttingOrderCost` (RF-41) emitían un `ADJUST` de costo sobre flejes **sin** el guardrail de D-060: es la misma acción que D-045 ya bloqueaba, llegando por otra puerta. Con una OP en curso, los reportes previos y los siguientes salían a costos distintos sin que nada avisara.
- **Alto ×2 (`revisor` web).** El diálogo de receta mandaba **siempre** `kgPerPiece`, y el API lo guarda como override: corregir el ancho dejaba el kilo del ancho anterior, y a partir de ahí cada reporte sacaba del fleje kilos que la máquina no consumió. Es el mismo patrón del tipo de cambio heredado que fue bloqueante en Fase 2b. Ahora el kilo **sigue a la geometría** salvo que el maestro lo escriba a mano, la divergencia se marca en rojo y solo se envía cuando de verdad es un override. Además la consulta de acabados no cubría `isPending`/`isError` (un `/finishes` caído se veía igual que "no hay acabados") y filtraba por `isActive`, ocultando el acabado ya guardado si se había desactivado.
- **Medios corregidos.** El "último reporte vigente" se decidía por `createdAt`, que en Postgres es el inicio de la transacción y puede empatar entre reportes concurrentes (ahora hay un `seq` serial, migración `20260904141000_fase4_orden_de_reportes`); el guardrail de D-060 se evaluaba sin bloquear antes las filas de los flejes, dejando una ventana TOCTOU contra `consume` (ahora `assertStripsNotAssigned` toma el `FOR UPDATE` él mismo, así ningún llamador puede olvidarlo); `boms.upsert` leía las OP vivas fuera de la transacción; `findAll` traía la receta y todas las filas de cada orden para 500 órdenes; los reportes por OP no tenían tope; cerrar no pedía motivo por más merma que dejara; y `catalog.update` dejaba cambiar la unidad o el origen de un producto con receta, esquivando las validaciones de D-055.
- **Bajos corregidos.** El mensaje de fleje que no coincide con la receta no nombraba el acabado, que es justo el dato para buscar otro rollo; `?op=` de `/planta` no se validaba ni se re-leía al cambiar; la meta de piezas no replicaba las cotas del API; `/planta` pedía las 500 órdenes más recientes para mostrar tres; el botón "Receta" aparecía en productos que el API iba a rechazar; faltaban `aria-label` en los botones repetidos de fleje y el tope local de flejes por orden; un `colSpan` de más en `/catalogo`; un `Number()` sobre una cantidad de kardex en el script de diagnóstico; y una constante duplicada en `@ayr/shared`.

**Hallazgo de `qa` (defecto preexistente de Fase 2b/3, corregido acá).** `CoilOperationsService.split()` (RF-15) creaba las hijas sin pasar `kind`, y la columna tiene `@default(COIL)`: partir un **fleje** para reancharlo devolvía hijas `kind=COIL` aunque la madre fuera `STRIP`. Ese material se caía del stock de flejes (RF-42 filtra por `kind=STRIP`), producción lo rechazaba con "es una bobina, no un fleje" y `stripOptions` no lo ofrecía, así que un fleje repartido localmente ya no se podía perfilar nunca. El argumento más fuerte de que era un bug y no diseño: dejaba **inalcanzable** el guardrail que D-060 acababa de agregar a `revertSplit` ("una hija del partido podía ser un fleje ya montado en una OP"). La hija ahora hereda la clase de la madre, y el test de regresión cubre las dos mitades: la hija sale `STRIP`, entra a una OP, y con ella montada `revertSplit` se bloquea nombrando la orden.

**El `qa` cubrió además nueve bordes que el spec de flujo no tocaba**, entre ellos el reparto FIFO de un reporte que cruza de un fleje al siguiente (la suma de las salidas da exactamente el kilo teórico), lo que `consume` y `report` deben rechazar, `release`, la receta del maestro, el reparto de permisos de D-046 (supervisor opera y reabre, no anula ni toca la receta; vendedor no entra), el motivo de la merma del cierre, la regresión del bloqueante de `cancelScrap`, las dos formas en que la reapertura se bloquea, y **un guardrail que nadie había probado**: un fleje montado en una OP bloquea también la recepción de la factura del servicio de corte (RF-41), que le subiría el costo a mitad de corrida.

**Lo que la auditoría de seguridad dejó explícitamente por escrito.** El `ADJUST` que emite el cierre de una OP **no** es equivalente al hallazgo alto de Fase 2b sobre el landed cost: allá el supervisor tipeaba un monto arbitrario que se inyectaba al costo del inventario (por eso D-043 pasó a ADMINISTRADOR); acá el ajuste es derivado y conservativo —`costo total − valor con el que entraron las piezas`— sobre material que §3.4 ya le da al supervisor, es reversible y queda auditado fleje por fleje. Por eso cerrar y reabrir siguen siendo del supervisor de planta y no se restringieron. `agy` rechazó la petición de segunda opinión ("my safety guidelines strictly prohibit performing targeted security auditing"), así que esta auditoría no tuvo contraste externo.

**E2E de Fase 4 contra producción.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` + `fase2b` + `fase3` + `fase3b` + `fase4` + `fase4-bordes` con el mismo administrador efímero: **56/56 verdes**; 57/57 en local (con `usuarios.spec.ts`). La primera corrida tras el deploy dejó 55/56: el primer test de UI de Fase 1 encontró la página de login sin hidratar (arranque en frío de Vercel recién desplegado, `getByLabel('Correo electrónico')` sin aparecer en 45 s). Repetida la corrida completa sin tocar nada, verde. No es un defecto de Fase 4 —los E2E de producción son todos por API— pero queda anotado: **la primera corrida contra producción justo después de un deploy puede fallar por arranque en frío**; conviene reintentarla antes de investigar.

**Producción queda sin stock de prueba.** Verificado con `node scripts/prod-e2e-leftovers.mjs` tras `pnpm prod:purge-e2e`: **0 bobinas abiertas con saldo**, las 364 bobinas E2E en `CANCELLED`, las **44 órdenes de producción E2E anuladas** y **0 perfiles E2E con piezas en stock** — que es lo nuevo de esta fase, porque una OP cerrada deja piezas en el inventario valorizado y sin la reapertura (D-060) no habría forma de sacarlas. 1 218 movimientos de kardex conservados (§3.2).

`prod:purge-e2e` necesitó dos correcciones para llegar a eso: revertir las mermas de prueba de los flejes **antes** de las recepciones de corte (con una sola pasada al final, cuatro recepciones se quedaban sin revertir y sus compras sin anular, porque la merma es justo lo que bloquea la reversa de D-052), y anular también las compras `DRAFT` de proveedores E2E, que antes quedaban como documentos de prueba en `/compras`.

**Residuo conocido: 6 comprobantes de servicio con un pago registrado** (`F001-390581293`, `F001-403036715`, `F001-410928458`, `F001-418751083`, `F001-458009649`, `F001-459185928`). Ninguno tiene efecto en el inventario —cinco están en `DRAFT` y no movieron kardex—, pero no se pueden anular porque **anular un pago a proveedor no existe todavía**: D-039 lo dejó "para Fase 2b junto con el resto de anulaciones" y nunca se construyó. Es lo único que separa a producción de quedar completamente sin rastro de pruebas; conviene resolverlo en la fase que toque cuentas por pagar.

**La migración volvió a nacer con el nombre mal ordenado (D-053).** `prisma migrate dev` la creó como `20260903085114_fase4_produccion_drywall`, que ordena **antes** de las de Fase 2a/2b/3/3b y habría roto el shadow database otra vez. Se detectó al mirar la carpeta, no después: backup de `_prisma_migrations` de `dev`, `git mv` a `20260904140000_fase4_produccion_drywall` y `scripts/migrations-rename.mjs --branch dev`, con `prisma migrate status` limpio después. **El reloj de esta máquina reporta una fecha anterior a la de las migraciones ya aplicadas**, así que cualquier migración nueva va a repetir el problema: revisar el nombre de la carpeta antes de commitear es ahora parte del flujo.

**Diferido a fases posteriores:**

- **Anular un pago a proveedor** (D-039 lo dio por hecho para Fase 2b y no se construyó). Es lo único que impide dejar producción sin ningún rastro de pruebas, y también lo que hace que una compra pagada por error no se pueda corregir hoy.
- La receta de la OP (`bomId`) apunta a la receta **viva**, no a una versión congelada: una OP ya cerrada puede mostrar un `kgPerPiece` distinto del que usó. Los datos reales están a salvo en `production_reports.theoreticalKg`; si hace falta la receta histórica, hay que congelarla en la OP al crearla.
- `MAX_ORDER_STRIPS` (20 flejes) y `MAX_ORDER_REPORTS` (200) por orden, y el orden por `seq` bajo concurrencia, no tienen E2E: exigen escenarios grandes o carreras, y serían lentos o inestables.
- Los pendientes de Fase 2b/3 (paginación de `findMovements`, prorrateo siempre por kg) siguen igual.

## Sesión M-1 — mantenimiento: fix de shadow DB (2026-09-03)

Sesión corta de mantenimiento, fuera del avance por fases: reparar `prisma migrate dev` (D-053) y registrar la decisión de diseño de reservas para Fase 5 (D-054, cierra P-15). No se tocó código de producto ni migraciones nuevas de esquema.

- **Diagnóstico primero, sin tocar nada.** `_prisma_migrations.started_at` en `dev` y `production` (mismo orden en ambas): `init → refresh_grace → fase1 → fase2a → fase2b → fase3 → fase3b`. La carpeta de Fase 3 (`20260903031603...`) ordena antes que `fase2a`/`fase2b` por nombre aunque se aplicó después — de ahí el `type "CoilStatus" does not exist` que Fase 3b había documentado como bloqueo.
- **Backup** de `_prisma_migrations` completo (`dev`, `production` y, más tarde, `ci`) en `docs/backup/prisma-migrations-{dev,production,ci}-*.json` antes de cada cambio.
- **Fix:** carpeta renombrada a `20260904125000_fase3_corte_flejes` (solo el nombre, `.sql` intacto) + `UPDATE _prisma_migrations.migration_name` a mano en `dev` y `production`, verificando `id`/`checksum` sin cambios antes y después.
- **Verificación:** `prisma migrate status` limpio; `prisma migrate dev` reconstruye el shadow database sin error ("Already in sync"); `pnpm turbo lint typecheck test build` verde (121 unit); `pnpm format:check` verde (salvo `.claude/settings.json`, ajeno a esta sesión); **41/41 E2E en local** contra Neon `dev`.
- **`ci` necesitó el mismo fix — no se asuma "se resetea por corrida" para el historial de migraciones.** El primer push a `main` (CI 33731598611) falló en el job de E2E: `reset-test-db.ts` corre `migrate deploy` + `TRUNCATE` de tablas de negocio, pero nunca toca `_prisma_migrations`, que en `ci` es su propia tabla persistente. Con el nombre viejo todavía ahí, `migrate deploy` vio la migración renombrada como nueva y falló (`type "CoilKind" already exists`, P3018). Corregido con el mismo procedimiento (backup, resolver el intento fallido con `prisma migrate resolve --rolled-back` + borrar su fila sin `finished_at`, `UPDATE migration_name` sobre la fila real), verificado reproduciendo `reset-test-db.ts` en local contra `ci`, y confirmado con el segundo push a CI. Detalle completo en `docs/DECISIONES.md` D-053.
- **Nota de la sesión.** `prisma migrate dev --create-only` con un campo dummy en `AuditLog` aplicó el cambio de verdad en vez de solo crear el archivo (contradice su propio `--help` en Prisma 6.19.3). Detectado y revertido a mano (columna, fila de `_prisma_migrations`, carpetas) antes de la verificación real. Queda anotado en D-053 para no asumir que `--create-only` es inerte sin comprobarlo.
- **D-054 (P-15 resuelta).** Modelo de cotización→pedido→reserva para Fase 5: cotizar no reserva; confirmar crea pedido+reserva en una transacción atómica; reserva en ledger propio (no en `inventory_movements`), estados `ACTIVA`/`CONSUMIDA`/`LIBERADA`, invariante `disponible ≥ reservado` que bloquea anulación/merma/corte/consumo ajeno mientras esté `ACTIVA`; OP consume, cancelación libera; sin vencimiento automático, alerta + liberación manual. Detalle largo en `docs/DECISIONES.md`.
- **Scripts nuevos** (solo para este tipo de reparación puntual, no parte del flujo normal): `scripts/migrations-diagnose.mjs`, `scripts/migrations-backup.mjs`, `scripts/migrations-rename.mjs`, `scripts/migrations-status.mjs`, `scripts/migrations-resolve.mjs`, `scripts/migrations-delete-failed.mjs`, cada uno con su contraparte en `apps/api/prisma/migrations-*.ts`.

## Sesión M-2 — mantenimiento: anular un pago a proveedor (2026-09-03)

Sesión corta de mantenimiento, fuera del avance por fases: cerrar el hueco que D-039 dejó pendiente desde Fase 2a/2b ("anular un pago se resuelve en Fase 2b junto con el resto de anulaciones", nunca construido) y que el handoff de Fase 4 documentó como el único residuo que impedía dejar producción sin ningún rastro de pruebas. No se tocó nada de Fase 5 (cotizaciones, pedidos, reservas, Nubefact).

- **`SupplierPayment` gana `reversedAt`/`reversedById` (D-061).** Append-only, mismo criterio que `CoilSplit`/`CuttingOrderCoil`: la fila nunca se borra. `POST /purchases/:id/payments/:paymentId/reverse` (solo ADMINISTRADOR, D-046) marca el pago y escribe el motivo en `audit_log` (RF-95). Migración `20260904150000_reversa_pago_proveedor`, aplicada en `dev`.
- **El bug que el hueco escondía.** `purchaseBalance`/`paidAmount` y el conteo de `cancel()` sumaban/contaban **cualquier** fila de `supplier_payments`, sin distinguir vivo de anulado — porque esa distinción no existía. `purchaseBalance` ahora filtra `reversedAt === null` en el único lugar donde se suman pagos, así que ningún llamador (lista de compras, detalle, estado de cuenta del proveedor) tuvo que tocarse aparte. `cancel()` se corrigió para contar solo pagos vigentes: antes del fix, una compra con un pago —vivo o no— quedaba bloqueada para anular **para siempre**.
- **Guardrails, mismo patrón que D-050/D-052/D-060.** Idempotencia: un pago ya anulado no se puede volver a anular (409, mismo criterio que `InventoryService.reverse`). Defensivo: la compra no puede estar `CANCELLED` — hoy inalcanzable por la API (`cancel()` exige cero pagos vigentes antes de anular), pero se comprueba igual. A diferencia de D-060, un pago no tiene ningún "aguas abajo" real en v1 (no toca stock); el guardrail que de verdad importa es el que ya existía en `cancel()`, ahora corregido.
- **Web:** botón "Anular pago" por fila en `/compras/[id]` (tabla de pagos gana columna "Estado": Vigente/Anulado), mismo `ReasonDialog` que el resto de reversas. `invalidate()` gana la clave `supplier-statement`, que antes ningún flujo de pagos/anulación tocaba.
- **Revisión (`revisor` + `qa`).** Sin bloqueantes. Corregidos: invalidación cruzada faltante del estado de cuenta del proveedor; un `data-state="inactive"` sin efecto visual (reemplazado por una opacidad real); un selector de E2E ambiguo (`getByRole('button', {name:'Anular'})` sin `exact` también matcheaba "Anular pago").
- **`qa` amplió la cobertura de `e2e/tests/m2-reversa-pago.spec.ts`** de 2 a 8 escenarios: varios pagos parciales (se anula el del medio, el saldo baja exacto); pago en moneda distinta a la de la compra (D-039, sin residuo de redondeo al anular); estado de cuenta del proveedor antes/después; rol (SUPERVISOR_PLANTA y VENDEDOR reciben 403); pago inexistente o de otra compra (404); compra `COIL` recibida (el pago nunca roza el kardex ni el saldo de la bobina). Sin defectos nuevos encontrados.
- **E2E contra producción.** `pnpm e2e:prod` corre ahora también `m2-reversa-pago.spec.ts`: **65/65 verdes en local; 64/64 contra producción** (con `usuarios.spec.ts`, que es solo local). **CI verde** (un job de E2E se canceló una vez por el timeout de 20 min de un runner lento; el mismo job reintentado con `gh run rerun` terminó en 7m37s, igual que corridas anteriores — corrida lenta puntual, no relacionada con el código).
- **Purga de producción extendida — el residuo de Fase 4 queda resuelto.** `pnpm prod:purge-e2e` gana el paso 0.7: revierte los pagos vigentes de cada compra de proveedor E2E antes de intentar anularla (pide el detalle por compra, porque la lista no trae el array de pagos). Verificado con `node scripts/prod-e2e-leftovers.mjs` tras correrlo: **0 bobinas abiertas con saldo, 0 piezas de perfiles E2E en stock, y las 224 compras E2E en `CANCELLED`** — incluidos los 6 comprobantes de servicio que Fase 4 había dejado con un pago sin poder anularse. Producción queda sin ningún rastro de pruebas.
- **Política de seguridad registrada, sin incidente nuevo (D-062).** El `deny` de `Read(./.env*)`/`Read(**/.env*)` en `.claude/settings.json` había aparecido eliminado al cerrar Fase 4 (origen desconocido, anterior a esa sesión) y se restauró entonces. Al abrir esta sesión se verificó que seguía intacto — no volvió a faltar. Queda registrado como política **permanente, no removible por un agente**: si alguna vez vuelve a faltar, restaurarlo es la acción por defecto, no una pregunta de "¿se quitó a propósito?". Pendiente que el dueño confirme si la eliminación original (antes de Fase 4) fue intencional; si no lo fue, evaluar rotar las credenciales de `.env.setup`.

## Fase 5a — detalle

| #   | Entregable                                                                                                                                                                                                                     | Estado                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 0   | D-063 (permisos de diagnóstico y comandos desde la raíz), regla dura 8 en `CLAUDE.md`                                                                                                                                          | ✅ commit propio antes de tocar código                                                   |
| 1   | Decisiones D-064..D-069, §3.7 partida en 5a/5b, §3.2 con la segunda regla transversal, RF-51/61/62/63/65/66/69 trazados                                                                                                        | ✅ `docs/ARQUITECTURA.md` §0.2, `docs/DECISIONES.md`                                     |
| 2   | Prisma: `quotations`/`quotation_items`, `sales_orders`/`sales_order_items`, `reservations`, `products.list_price_pen`, `business_lines.quotation_required`, FK de `production_orders.reservation_id`                           | ✅ migraciones `20260904160000`, `20260904161000` y `20260904162000`, aplicadas en `dev` |
| 3   | Módulo `sales`: cotizaciones, pedidos, ledger de reservas, PDF y job de vencimiento                                                                                                                                            | ✅ `apps/api/src/sales/`                                                                 |
| 4   | Invariante `disponible ≥ reservado` en **todas** las rutas que tocan stock, en sus dos formas (D-066)                                                                                                                          | ✅ `reservation-guard.ts` como función suelta, sin ciclo de módulos                      |
| 5   | Las tres reversas en esta misma fase: anular cotización, anular pedido (libera), liberar reserva a mano                                                                                                                        | ✅                                                                                       |
| 6   | Web: `/cotizaciones`, `/cotizaciones/nueva`, `/cotizaciones/[id]`, `/pedidos`, `/pedidos/nuevo`, `/pedidos/[id]`; columnas reservado/disponible en `/inventario`; lookup de RUC en `/clientes`; precio de lista en `/catalogo` | ✅                                                                                       |
| 7   | Tests unit (aritmética comercial + invariante en el kardex)                                                                                                                                                                    | ✅ 16 nuevos (155 en total)                                                              |
| 8   | Revisión de `revisor` (API y web por separado) y `auditor-seguridad`                                                                                                                                                           | ⏳                                                                                       |
| 9   | E2E de Fase 5a                                                                                                                                                                                                                 | ✅ 9 escenarios en `e2e/tests/fase5a.spec.ts`                                            |
| 10  | Deploy y migración en `production`; `pnpm e2e:prod` y `pnpm prod:purge-e2e`                                                                                                                                                    | ⏳                                                                                       |
| 11  | Cierre: handoff, commit, push                                                                                                                                                                                                  | ⏳                                                                                       |

**El modelo, en cuatro actos.** **Cotizar** es una simulación de precio: no toca inventario
y lo único que hace con el stock es _declarar_, línea por línea, qué se reservaría (D-054).
**Emitir** la pasa a `EMITIDA` —el único estado desde el que se confirma— y genera su PDF.
**Confirmar** crea el pedido **y** las reservas en una sola transacción; si a una línea no le
alcanza el disponible, no se crea nada. **Consumir**: la OP nacida del pedido monta el
material reservado y, al emitir el primer material, marca la reserva `CONSUMIDA`.

**La invariante es el corazón de la fase, y son dos guardrails, no uno.** `disponible ≥
reservado` se rompe de dos maneras distintas y cada una necesita su propio mecanismo:

- **Cantidad** — dentro de `InventoryService.record` (salidas) y `reverse` (anulación de un
  ingreso), bajo el mismo lock de saldo que el kardex ya toma. Es el único punto por el que
  pasa toda salida de stock (§3.2), así que de un golpe cubre merma, partido, consumo de
  producción, anulación de compra y de bobina, y cualquier ruta futura.
- **Custodia** — `assertNotReserved`, función suelta, en las rutas que se llevan el ítem
  entero **sin mover kardex**: envío a corte (D-050), asignación a una OP ajena (D-060) y
  cierre de bobina (RF-19).

Ninguna alcanza sola: la de cantidad no ve un envío a corte, la de custodia no ve una merma
parcial. Es el mismo hueco que D-050 abrió y que Fase 3 tapó a mano en cuatro sitios, y que
D-060 volvió a abrir; la novedad acá fue reconocer que son **dos clases** de ruptura.

**Las reservas viven fuera del kardex, y por eso el ledger apunta al mismo par que el
saldo.** `reservations.(item_type, item_id)` es exactamente la clave de
`inventory_balances`, lo que permite comprobar la invariante bajo el `FOR UPDATE` que el
kardex ya toma, sin inventar un segundo mecanismo de bloqueo que habría que mantener
sincronizado con el primero.

**Las reversas van en esta misma fase** (lección de D-051/D-060): anular la cotización
(cualquier estado no confirmado), anular el pedido (libera sus reservas activas) y liberar
una reserva a mano (solo ADMINISTRADOR, con motivo). Todas todo-o-nada, todas idempotentes,
todas con motivo al `audit_log`.

## Hallazgos de la revisión (revisor API, revisor web, auditor-seguridad)

Se corrieron las tres revisiones en paralelo sobre el diff completo. **1 bloqueante, 7 altos
y varios medios corregidos**; sin hallazgos críticos de seguridad.

**Bloqueante (`revisor` API): la invariante estaba aplicada en un solo sentido.** Se
comprobaba que ninguna operación rompiera una reserva viva, pero no que la reserva **naciera
sobre material cuya custodia ya estaba comprometida**. Entre cotizar y confirmar, la bobina
podía irse a un tercero (D-050) o quedar montada en una OP (D-060) — y como ninguna de las
dos mueve kardex, `lockAvailability` la veía intacta. El pedido quedaba prometiendo material
que no estaba y, peor, la recepción del corte o el reporte de esa OP se caían después contra
la invariante, sin más salida que liberar la reserva a mano. `createReservations` revalida
ahora el estado de la bobina y sus asignaciones bajo el mismo lock, y `reservable-coils` no
ofrece flejes montados.

**Altos.**

- **Anular el pedido solo se bloqueaba con reservas `CONSUMIDAS`.** Una OP que ya montó el
  fleje pero todavía no reportó tiene su reserva en `ACTIVA`: el pedido se anulaba en
  silencio, la reserva pasaba a `LIBERADA` y la orden seguía fabricando para un pedido que ya
  no existía. Ahora el bloqueo mira el **estado de la OP**, no el de la reserva — y lo mismo
  la liberación manual.
- **Deshacer la producción no devolvía la reserva.** Revertir el reporte y anular la OP
  dejaban el material otra vez en stock **sin nada que lo protegiera**, con el pedido todavía
  prometiéndoselo al cliente y en `EN_PRODUCCION` sin orden detrás. `restoreReservation` la
  devuelve a `ACTIVA` cuando la OP se queda sin reportes vigentes. Esto es además lo que
  garantiza que el pedido nunca quede inanulable: si el bloqueo dependiera de una reserva
  consumida que no vuelve, sería el mismo agujero que D-061 cerró con los pagos.
- **Deadlock real** entre anular un pedido y reportar producción: tomaban el pedido y sus
  reservas en orden inverso. Los dos van ahora pedido → reservas.
- **`reservationId` no se validaba contra el producto de la OP**: una orden podía citar
  cualquier reserva viva de la línea y, por la excepción de la reserva propia, montar el
  material prometido a otro cliente.
- **(`revisor` web) La reserva no tenía consumidor en la UI.** `/planta` creaba la OP sin
  `reservationId`, así que el guardrail se volvía en contra: al confirmar un pedido el
  material quedaba bloqueado para **toda** orden que no fuera la nacida de esa reserva, y
  planta no tenía forma de crear esa orden. El fleje prometido era inmovilizable hasta que un
  administrador liberara la reserva a mano — lo contrario de para qué se reserva.
- **(web) Pedido directo ofrecía las líneas que lo prohíben** (D-065): formulario completo,
  validación en verde y 400 al guardar. Es el mismo "previsualización verde → 400" del
  partido en 2b.
- **(web) La validación local no comparaba los kilos a reservar contra el disponible**, ni
  sumaba dos líneas de la misma bobina. En una cotización ese error no aparecía al crearla
  sino al **confirmar**, cuando el cliente ya tiene el PDF.
- **(web) Catálogo y bobinas sin cubrir `isError`**: cuarta repetición del hallazgo de 2b/4.

**Medios corregidos.** Fechas de negocio en **Lima** y no en UTC (`businessToday`): entre las
19:00 y la medianoche hora local, una cotización válida "hasta el 10" se rechazaba por
vencida y el pedido nacía fechado el 11. Listas con `_count` en vez del `include` completo de
500 filas. `RoleGate` en las seis vistas nuevas. Búsqueda por el API (RF-84) en vez de filtrar
500 filas en el cliente. El botón de PDF depende del estado y no de `pdfKey` (si la subida a
R2 falló al emitir —fallo tolerado a propósito— no había forma de llegar al documento).
"Anular pedido" deshabilitado cuando una OP está fabricando. Previsualización normalizada a
la escala fija antes de calcular. `validityDays` validado localmente. Invalidación simétrica
entre producción y ventas.

**Auditoría de seguridad: sin hallazgos críticos ni altos.** Dos medios corregidos:

- **Autorización a nivel de objeto.** RF-66 dice "una cotización **propia**", pero no había
  ninguna comprobación: con solo el id, un vendedor podía editar el borrador de un compañero,
  emitirlo, confirmarlo —creando un pedido y una reserva a nombre de su cliente— o anulárselo.
  Editar, emitir, confirmar y anular exigen ahora ser quien la creó (o ADMINISTRADOR); la
  lectura sigue abierta al equipo comercial, que es lo que RF-69 pide.
- **El PDF de una cotización no emitida.** Un borrador nunca emitido —ni confirmable, ni
  registrado como emitido— generaba un PDF idéntico al de una cotización válida, y el de una
  anulada o vencida también. Ahora un borrador no tiene documento y los otros dos salen
  rotulados con su estado, redibujados con el estado de hoy en vez de servir el archivo que se
  congeló al emitir.

Y cuatro bajos: `/customers/lookup` sin `@Roles` (cualquier usuario autenticado gastaba la
cuota del token compartido con el tipo de cambio), el cuerpo del tercero sin cota de tamaño ni
parseo separado, el **número de documento en los logs** (dato personal, Ley 29733) y un `GET`
que escribía. `agy` volvió a rechazar la petición de segunda opinión, así que esta auditoría
tampoco tuvo contraste externo.

**Verificado empíricamente por el auditor:** el `deny` de `Read(**/.env*)` sigue vigente
después de D-063 — un `grep` accidental sobre un `.env.example` fue bloqueado por la regla, o
sea que el `allow` nuevo de `Bash(grep:*)` no la esquiva en la práctica.

**Diferido, con motivo:** el tracker del throttle es la IP, y detrás del proxy de Vercel todos
los usuarios comparten la de salida, así que el límite del lookup es global y no por usuario.
Protege bien la cuota del tercero (que es lo que D-067 quería) pero un usuario en bucle deja
sin autocompletado a toda la empresa. Cambiar el tracker a `user.id` toca el guard global que
también protege el login, así que va con el resto del hardening de Fase 7.

**Los bordes de `qa` encontraron un defecto que las tres revisiones anteriores no vieron.**
El PDF de una cotización **vencida** salía sin rótulo mientras el job diario no la hubiera
marcado: `confirm()` ya la rechazaba por fecha, pero `pdf()` decidía con el `status` guardado
y servía el archivo congelado en R2 — un papel indistinguible de uno vigente sobre una
cotización que el propio API ya no dejaba confirmar. Es exactamente el razonamiento de D-069
(el API escala a cero y el cron puede no correr) aplicado a la puerta por la que el documento
sale al cliente. Corregido con `effectiveStatus`, que recalcula el vencimiento al servir.

Los 10 bordes cubren además: dos líneas sobre la misma bobina (la segunda ve la reserva que la
primera creó **en la misma transacción**, y si la suma excede el disponible fallan enteras);
dos líneas sobre bobinas distintas; reserva sobre el propio producto en piezas con la
invariante bloqueando la salida; el bloqueante de la revisión por sus **dos** caminos (bobina
enviada a corte y fleje montado en una OP entre cotizar y confirmar); editar, emitir y anular
con sus PDF; RF-66; y **dos confirmaciones simultáneas sobre la misma bobina**, donde una gana
y la otra falla con un 400 de dominio, sin reserva huérfana (estable en tres corridas).

**E2E de Fase 5a contra producción.** `pnpm e2e:prod` corre ahora `auth` + `fase1` + `fase2a` +
`fase2b` + `fase3` + `fase3b` + `fase4` + `fase4-bordes` + `m2-reversa-pago` + `fase5a` +
`fase5a-bordes` con el mismo administrador efímero: **83/83 verdes**; 84/84 en local (con
`usuarios.spec.ts`).

**Una corrida se perdió por un error operativo, no del producto.** El primer `pnpm e2e:prod`
se abortó a los 64 tests con un `ENOENT` sobre un archivo de trace: había otra corrida de
Playwright en paralelo verificando los bordes en local, y **todas comparten `test-results/`**,
que Playwright limpia al arrancar. El síntoma (un `ENOENT` junto a un "Test timeout of
45000ms") no se parece en nada a la causa. Repetida sola, verde. Queda anotado: **una suite de
Playwright a la vez**, o `--output` propio para cada una.

**Producción queda sin ningún rastro.** Verificado con `node scripts/prod-e2e-leftovers.mjs`
tras `pnpm prod:purge-e2e`: **0 bobinas abiertas con saldo, 0 reservas ACTIVAS en toda la
base, 0 perfiles E2E con piezas en stock**, y las 20 cotizaciones, 13 pedidos, 114 órdenes de
producción y todas las compras E2E en `CANCELLED`, con los 19 clientes de prueba desactivados.
2 526 movimientos de kardex conservados (§3.2).

`prod:purge-e2e` necesitó dos ampliaciones para llegar ahí. La primera, prevista: un paso
que anula pedidos y cotizaciones E2E, libera las reservas sueltas y desactiva los clientes —
va **después** de las órdenes de producción (una OP viva bloquea la anulación del pedido) y
**antes** de todo lo demás (una reserva activa bloquea la anulación de la bobina, la de su
compra, el envío a corte y el cierre). La segunda salió de correrlo: la reversa de mermas de
prueba filtraba por `kind = STRIP`, porque hasta Fase 3b las únicas mermas de prueba eran
sobre flejes; el test de la invariante de D-066 registra una sobre una **bobina madre**, que
quedó con 1 600 kg y sin poder anularse. Con el filtro ampliado a bobinas y flejes, la purga
cierra en cero.

**Diferido a fases posteriores:**

- El tracker del throttle es `req.ip`, y detrás del proxy de Vercel (D-015) todos los usuarios
  comparten la IP de salida: el límite de 20/min del lookup de RUC es global y no por usuario.
  Protege la cuota del tercero, que es lo que D-067 quería, pero un usuario en bucle deja sin
  autocompletado a toda la empresa. Cambiar el tracker a `user.id` toca el guard global que
  también protege el login, así que va con el hardening de Fase 7.
- **El vendedor puede buscar un RUC pero no dar de alta el cliente**: RF-85 reserva las
  mutaciones de `/customers` a ADMINISTRADOR, así que el botón "Buscar" de D-067 queda sin
  salida para el rol que lo usa. Es coherente con §3.4; si el dueño quiere que el vendedor dé
  de alta clientes, es un cambio de RF-85, no un bug.
- `SalesOrderStatus.FULFILLED` existe y **nada lo alcanza todavía**: el despacho que cierra un
  pedido es Fase 5b.
- La garantía de D-068 de sumar `Σ subtotales + Σ IGV` en vez de `Σ totales de línea` **no es
  falsable con la escala actual** (dinero a 4 decimales, `total = subtotal + igv` sin redondeo
  adicional). El test la verifica igual, para que siga valiendo si la escala cambia.
- Los pendientes de Fase 2b/3/4 (paginación de `findMovements`, prorrateo siempre por kg,
  receta no congelada en la OP) siguen igual.

## Fase 5b — detalle

**Facturación electrónica, guía de remisión, despacho y cobranza** (RF-70, RF-74..RF-79,
RF-86..RF-89; D-070..D-078). El realcance de la fase es D-070: 5b dejó de ser "producción
de coberturas y venta" —eso pasó a **5c**— y pasó a cerrar el tramo que iba **después** del
pedido, que era el hueco real que 5a dejó: el pedido reservaba material y no tenía forma de
salir del almacén, de facturarse ni de cobrarse.

### El puerto, y por qué el dominio no conoce a Nubefact (D-071)

`ElectronicInvoicingProvider` define cuatro operaciones en vocabulario de SUNAT —emitir
comprobante, emitir guía, consultar estado, comunicar baja, más la consulta de la baja que
la revisión obligó a separar— y `NubefactProvider` es la única implementación. Un
`grep -i nubefact` fuera de `invoicing/providers/nubefact/` solo devuelve la fábrica del
módulo, los nombres de las variables de entorno y los comentarios del puerto que explican
la decisión.

`NullInvoicingProvider` se ata cuando faltan credenciales y devuelve **error de envío**, que
es lo mismo que devuelve un PSE caído: un entorno sin PSE ejercita el mismo camino que una
caída real, en vez de un camino falso que solo existe en desarrollo.

### El corazón: dos fases y un correlativo que no se desperdicia (D-072, D-073)

Enviar un comprobante hace, en este orden: (1) toma correlativo, deja el documento en
`ISSUED` y **confirma la transacción**; (2) intenta el envío fuera de esa transacción; (3)
según lo que conteste el PSE, pasa a `ACCEPTED`, `REJECTED` o `SEND_ERROR`. Desde el final
del paso 1 el documento ya habilita el despacho.

Invertirlo —enviar dentro de la transacción— haría que una caída del PSE revirtiera un
correlativo ya tomado, que es exactamente el hueco que D-072 evita, o dejara un camión
esperando a que conteste un tercero.

El job (`invoicing.send-pending`, cada 15 minutos **y al arrancar**) recoge lo que el
intento inline no pudo. Corre al arrancar porque el API escala a cero en Cloud Run: es la
misma advertencia de D-069, y acá vale igual.

### El despacho cierra el pedido, la factura no (D-074)

`dispatches` mueve kardex por `InventoryService` (regla dura 2), consume la reserva **antes**
de la salida —si fuera al revés, la propia reserva del pedido bloquearía contra la invariante
de D-066 justo la salida que viene a cumplirla— y recalcula el estado del pedido desde las
filas de despacho vigentes.

**El cambio fino de esta fase**: la reserva se consume **solo por lo despachado**, no entera.
`reservations.qty` pasó a significar "lo que todavía está prometido"; la promesa original
vive en `sales_order_items.reserve_qty` y no se toca, así que no se pierde información.
Consumirla entera en un despacho parcial habría dejado el resto de la línea —material que el
pedido sigue prometiendo— sin nada que lo proteja: el mismo agujero que la auditoría de 5a
encontró en el otro sentido.

La reversa devuelve stock, restaura la reserva y recalcula el pedido, y se bloquea si un
documento electrónico vigente declara ese traslado (la guía del propio despacho, o un
comprobante vivo que facture sus líneas). Deshacerlo al revés dejaría al kardex diciendo que
la mercadería está en el almacén y a SUNAT diciendo que salió.

### Cobranza, espejo de compras (D-075)

`customer_payments` es `supplier_payments` mirado desde el otro lado: saldo recalculado y
nunca almacenado, cobro contra el **comprobante** —no contra el pedido, que no tiene saldo—
y reversa que marca la fila sin borrarla, con el motivo al `audit_log`. La única asimetría
deliberada es de roles: registrar un cobro es también de VENDEDOR, porque cobrar es parte de
su trabajo y compras es un módulo de planta al que no entra.

### Lo demás

- **D-076**: VENDEDOR da de alta y edita clientes; documento, días de crédito y baja lógica
  siguen siendo de ADMINISTRADOR (y la revisión encontró que faltaba cerrarlo en el **alta**,
  no solo en la edición).
- **D-077**: cliente `PÚBLICO EN GENERAL` sembrado e inmutable, con bloqueo suave del tope de
  S/ 700 y excepción de ADMINISTRADOR registrada en el comprobante y en la auditoría.
- **D-078**: modalidad de traslado por despacho; el catálogo de vehículos y conductores queda
  diferido y lo reemplaza el autocompletado desde despachos anteriores. El **ubigeo** de
  partida y llegada se captura en el despacho —SUNAT lo exige en la guía— por la misma razón
  que todo lo demás de esta fase: un dato mal puesto vuelve rechazado con el correlativo ya
  gastado.

### Hallazgos de la revisión (revisor API, revisor web, auditor-seguridad)

Tres pasadas en paralelo sobre el diff del Milestone 1. **4 bloqueantes, 7 altos, 10 medios
y varios bajos**, todos corregidos antes de seguir con el Milestone 2. Los que cambiaron
decisiones y no solo código:

**Bloqueantes.**

- `SEND_ERROR` no contaba como emitido, así que la misma línea de pedido se podía facturar
  dos veces **justo con el PSE caído** — el escenario para el que existe la contingencia. El
  estado tiene correlativo tomado y el job lo va a reintentar: cuenta.
- Los topes de "cuánto queda por facturar" se comprobaban solo al **crear el borrador**, y un
  borrador no consume nada: dos borradores sobre la misma línea pasaban los dos y, al
  enviarse, tomaban número los dos. Ahora se revalida dentro de la transacción que toma el
  correlativo, que es el último punto en el que todavía se puede decir que no.
- Dos líneas del mismo documento sobre la misma línea de pedido se comparaban cada una contra
  el pendiente completo.
- **La baja se confirmaba sola.** `refreshStatus` de un `VOID_PENDING` preguntaba por el
  **comprobante**, y un documento con baja en trámite es por definición uno que SUNAT ya
  aceptó: la consulta devolvía "aceptado" y el documento se marcaba anulado sin que SUNAT lo
  anulara, con la cuenta por cobrar desapareciendo. Obligó a partir la consulta de baja en un
  método propio del puerto.

**Altos.** 401/403 se clasificaban como **rechazo** en vez de error de envío, así que un token
vencido quemaba el correlativo de cada comprobante; un documento con ticket se **reemitía**
en cada barrido en vez de consultarse; el reintento manual de una guía armaba un payload de
comprobante vacío; corregir una guía rechazada violaba un `CHECK` y salía como 500; el
`VOID_PENDING` era un estado sin salida si SUNAT rechazaba la baja; y `precio_unitario` se
calculaba con `number` —11.86 × 1.18 = 13.994799999999998— sobre un campo cuya coherencia el
PSE valida.

**Seguridad.** El script de secretos de GitHub prefería las credenciales **reales** del PSE y
solo caía a la demo si faltaban, en un job que corre en cada pull request; los archivos que
devuelve el PSE se descargaban de cualquier URL que dijera su respuesta, sin tope de tamaño;
y faltaba la comprobación de propiedad al estilo de RF-66, así que un vendedor podía emitir
el borrador de otro.

**Web.** El total se recalculaba con lo que el usuario está tipeando y `toDecimal` lanzaba con
un estado tan normal como el punto de `.5`, tirando la pantalla entera; y los kilos se
restaban con `number`, rompiendo la regla dura 1 sobre la cifra que decide cuánto se acredita.

### Lo que solo apareció contra el PSE de verdad

Las tres revisiones estáticas no podían ver nada de esto. Salió en la primera corrida de
`qa` contra la cuenta demo de Nubefact, y es el argumento para que los E2E de esta fase
existan contra el PSE y no contra un doble.

- **La guía salía mal armada.** El propio PSE nombró los campos: la placa va bajo
  `transportista_placa_numero` —en `vehiculo_placa` la ignoraba en silencio y rechazaba por
  "placa no puede estar en blanco"— y los apellidos del conductor van aparte. Se partieron
  en dos columnas (`driver_given_names`, `driver_family_names`) en vez de dividir el texto
  en el adaptador: partir un nombre por espacios acierta con "Juan Pérez Gómez" y falla con
  "José Luis Pérez", y esa adivinanza sale impresa en un documento fiscal.
- **La unidad de medida viajaba tal cual desde `products.unit`**, que es texto libre en el
  maestro. Ahora se normaliza contra el catálogo 03 y lo que no se reconoce cae a `NIU`.
- **Con la contingencia levantada se podía revertir un despacho cuya guía ya tenía
  correlativo.** `DECLARED_STATUSES` dejaba fuera `SEND_ERROR` mientras
  `LIVE_DOCUMENT_STATUSES` sí lo contaba, y esa asimetría era el defecto: al recuperarse el
  PSE, el barrido declaraba un traslado que ya no existía.
- **Un comprobante emitido en contingencia no se podía cobrar**, que es la mitad de la
  promesa de D-073 sin cumplir — y la mitad que se lleva el dinero.
- **La purga no veía las boletas a "público en general"**: no salen a nombre del cliente de
  prueba. Ahora se reconocen además por la marca en observaciones.

Y uno que encontré revisando mi propio código, no la suite: **el despacho sacaba del kardex
la cantidad de venta en vez de la que la reserva promete**. En perfiles coinciden —el ítem
reservado es el propio producto—, y por eso el error habría esperado hasta la primera
cobertura para aparecer: vender 100 piezas de una bobina habría descontado 100 kilos.

### Bloqueo abierto: las series del punto de emisión

**La cuenta demo del PSE no tiene autorizadas las series que siembra la migración**
(`F001`, `B001`, `T001`, `FC01`, `BC01`): responde _"No puedes emitir comprobantes con esta
serie"_. Mientras eso siga así, **ningún entorno con esa cuenta llega a `ACCEPTED`**, y cada
intento gasta un correlativo real.

La consecuencia para esta fase es que el tramo posterior a la aceptación —cobro sobre un
comprobante aceptado, nota de crédito sobre uno aceptado, reversa de despacho bloqueada por
factura aceptada— **no se pudo probar de punta a punta**. Todo lo anterior sí: la emisión
toma correlativo, el rechazo es determinista y se corrige con número nuevo, la contingencia
deja salir la mercadería, y los guardrails de 5a siguen en pie.

Lo que se hizo al respecto: **las series pasaron a ser administrables**
(`GET/POST/PATCH /invoicing/series`, solo ADMINISTRADOR) y se muestran en la tarjeta de
contingencia de `/comprobantes`. La autorización de una serie es del PSE **por emisor**, así
que era configuración disfrazada de constante: alinearlas dejó de ser una migración.

Lo que hace falta del dueño: registrar esas series en el panel de Nubefact, o decir cuáles
tiene autorizadas la cuenta para darlas de alta desde el sistema.

### Cierre: qué quedó verificado y cómo

- **195 unit** verdes; `lint`, `typecheck`, `format:check` y `build` limpios en los tres paquetes.
- **19 E2E** contra la cuenta demo del PSE: los diez escenarios obligatorios de la fase más
  nueve bordes. La corrida de cierre volvió a ejecutar los tres que quedaban con el código
  final en vez de repetir la suite entera —cada corrida completa gasta unos veinte documentos
  de un cupo de cincuenta—, así que **no fue un 17/17 de una sola pasada** y conviene decirlo.
- **89 pasados y 13 saltados contra producción**, sin un solo fallo. Los 13 saltados son los que
  emiten: contra producción están apagados a propósito (ver abajo).
- **CI verde** y **purga sin residuo**: producción quedó con 0 documentos electrónicos, 0
  despachos vivos, 0 reservas activas, 0 cobros vigentes y 0 piezas de prueba en stock.

### La compuerta de emisión, y por qué existe

Los E2E de esta fase **no emiten contra producción**, y no es una comodidad: el correlativo lo
asigna nuestra propia `fiscal_series`, no el PSE (D-072). Sin proveedor configurado —que es
como quedó producción por D-080— cada emisión de prueba se llevaría un número de la serie real
y quedaría en `SEND_ERROR` **sin ningún estado terminal al que llevarlo**: la baja exige un
comprobante aceptado. Serían huecos permanentes en la numeración fiscal de la empresa.

Contra producción corre todo lo que no emite —despacho, reversas, despacho parcial, guardrails
de reserva de 5a, progreso del pedido, configuración—, que es donde está el riesgo de kardex.

La suite acabó necesitando **tres modos**, no dos: emisión permitida, emisión prohibida y
**emisión permitida sin proveedor detrás**. El tercero es el que verifica la promesa de
contingencia contra un entorno realmente sin PSE, en vez de simularla con el interruptor
manual — y es el modo en el que corre producción.

El mismo error de fondo apareció dos veces, primero en el producto y después en las pruebas:
**tratar "no hay PSE" como si fuera "el PSE tarda"**. En el producto quemaba correlativos; en
las pruebas agotó el tiempo del job de CI, porque sin proveedor la cola de pendientes solo
crece y el barrido la reprocesaba entera en cada espera.

### Un hueco que la limpieza destapó

Producción quedó con un **borrador** de boleta que ninguna ruta podía quitar: la baja exige un
comprobante aceptado y no había otra puerta. Se agregó `DELETE /invoicing/documents/:id`, que
es **la única fila del módulo que se borra de verdad** — y puede serlo justamente porque un
borrador no existe fiscalmente: no tomó correlativo, no consume pedido, no tiene saldo y SUNAT
nunca supo de él. La auditoría se escribe antes del borrado, porque después no quedaría a qué
apuntar.

## Fase 6 — detalle

| #   | Entregable                                                                                                                                                                                                                                                                                                                   | Estado                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Decisiones D-082..D-091, §3.7 renumerada (5c→6, 6→7, 7→8), RF-30..RF-33/RF-36/RF-39 y RF-54 actualizados; contexto largo en `docs/DECISIONES.md`                                                                                                                                                                             | ✅                                                                                 |
| 2   | Prisma: `colors`, `products.color_id`, `coils.color_id`, `purchase_items.color_id`, `product_boms.kind` (+ nullables y `CHECK`), `production_orders.kind`/`consumed_kg`, `production_order_items`, `production_report_pieces`, `quotation_item_pieces`, `sales_order_item_pieces`, `reservations` unique por `(línea, ítem)` | ✅ dos migraciones, aplicadas en `dev`                                             |
| 3   | `@ayr/shared`: schemas de color y de coberturas, subítems de largo, `piecesMeters`/`describePieces`/`thicknessWithinTolerance`, `ROOFING_THICKNESS_TOLERANCE_MM`                                                                                                                                                             | ✅                                                                                 |
| 4   | API `colors` (CRUD ADMINISTRADOR, baja lógica, auditoría) + color en catálogo, bobinas (3 vías de alta), compras e importación                                                                                                                                                                                               | ✅                                                                                 |
| 5   | Cotización y pedido con línea compuesta: subítems `{cantidad, largo}`, `qty` en metros derivada, descripción con los largos hacia el comprobante                                                                                                                                                                             | ✅                                                                                 |
| 6   | `RoofingProductionService`: OP desde pedido con plan copiado y editable, montaje de bobina filtrada (espesor ±TOL + color estricto), reporte de largos, cierre con consumo declarado y despunte                                                                                                                              | ✅                                                                                 |
| 7   | Traslado de la reserva del insumo al producto (D-088) y despacho que lee la reserva viva                                                                                                                                                                                                                                     | ✅                                                                                 |
| 8   | Reversas: reporte de largos, reapertura del cierre, anulación de OP — todas con motivo y falla completa                                                                                                                                                                                                                      | ✅                                                                                 |
| 9   | Web: paleta de colores en `/catalogo`, color en producto y bobina, editor de subítems en la cotización, rama de coberturas en `/planta`, `/produccion` con las dos clases                                                                                                                                                    | ✅                                                                                 |
| 10  | Tests unit de la aritmética de coberturas (`roofing-math.spec.ts`)                                                                                                                                                                                                                                                           | ✅ 18 nuevos, 213 en total                                                         |
| 11  | Revisión de `revisor` (API y web por separado) y `auditor-seguridad`                                                                                                                                                                                                                                                         | ✅ 3 bloqueantes + 3 altos corregidos; ver abajo                                   |
| 12  | E2E de Fase 6                                                                                                                                                                                                                                                                                                                | ✅ 11 tests nuevos, verdes en local y contra producción                            |
| 13  | Deploy y migración en `production`                                                                                                                                                                                                                                                                                           | ✅ dos migraciones aplicadas, API redesplegado en Cloud Run, web por push a `main` |
| 14  | Cierre: handoff, commit, push                                                                                                                                                                                                                                                                                                | ✅ `docs/handoff/fase-6.md`                                                        |

**El modelo, en un párrafo.** Conviven dos productos de cobertura (D-083). La **plancha de
catálogo** tiene largo fijo en la receta, se cuenta en piezas y se vende como cualquier
producto. La **cobertura a medida** no tiene largo: el pedido lo trae, la línea de cotización
es compuesta —subítems `{cantidad, largo}` cuya suma en metros **es** la cantidad de la línea—
y su kardex se lleva en **metros lineales**, porque en un saldo de piezas una plancha de 3 m y
una de 9 m compartirían promedio ponderado. La OP nace del pedido (D-084), copia sus largos
como plan de corte editable, monta una bobina filtrada por espesor ±0.02 mm y **color idéntico**
(D-085/D-086), reporta los largos reales y cierra declarando los kilos que la bobina consumió de
verdad; la diferencia contra el teórico es el despunte (D-089) y **el resto del rollo vuelve al
almacén**, que es donde esta fase se separa de D-057.

**El hueco de Fase 5b que esta fase destapó (D-088).** El despacho sacaba del kardex las
coordenadas congeladas de `sales_order_items`, que en una cobertura son **la bobina**. Como la
OP ya había sacado esos kilos al reportar, despachar los habría sacado por segunda vez. En
perfiles y trading el defecto es invisible —el ítem reservado es el propio producto—, así que
habría esperado a la primera cobertura real. La corrección es que la promesa **se traslada**: al
reportar, la reserva de bobina se descuenta por los kilos consumidos y nace una reserva sobre
los metros fabricados, de modo que las planchas a medida **nacen reservadas** para el pedido que
las encargó. `reservations.sales_order_item_id` dejó de ser único.

### Hallazgos corregidos en esta fase (revisor ×2 + auditor-seguridad)

- **Bloqueante.** `reverseReport` sacaba los metros del kardex **antes** de reducir la reserva
  que esos mismos metros sostienen, y `InventoryService.reverse` comprueba
  `disponible ≥ reservado`: `0 ≥ 24.600` es falso, así que **RF-33 fallaba en su camino
  principal** —no en un borde— pidiéndole al operario que liberara la reserva del pedido que
  venía a corregir. El orden correcto es el que `report` ya usaba y documentaba.
- **Bloqueante.** El despacho **volvía a caer en la bobina** cuando la reserva de producto
  dejaba de estar `ACTIVA`: bastaba un primer despacho que la consumiera entera, o despachar
  antes de producir, para que el segundo emitiera una salida de kilos de bobina por una venta de
  planchas. Era el mismo hueco de D-088 reaparecido un despacho más tarde. Ahora una línea que
  se fabrica contra el pedido **no vuelve nunca al insumo**: sin producto terminado reservado, el
  despacho se rechaza diciendo que hay que producir primero.
- **Bloqueante (web).** El DTO de la reserva exponía la última OP sin filtrar por estado, y
  anular una de coberturas deja el vínculo puesto: el pedido volvía a estar disponible para el
  API pero **desaparecía del único punto de entrada de `/planta`**, así que RF-33 dejaba el
  pedido imposible de fabricar sin anularlo entero. Ahora el DTO solo muestra la OP viva.
- **Alto.** El `OUT` de despunte del cierre no descontaba la reserva de bobina, así que una
  orden que reservó el rollo entero —el caso normal— **no se podía cerrar con merma**: la propia
  promesa bloqueaba la salida.
- **Alto (web).** El cierre desde `/produccion/[id]` calculaba "¿hace falta motivo?" con la
  fórmula de drywall (`pendiente / asignado`), que en coberturas es siempre alta porque el rollo
  sobrante no es merma: el diálogo exigía explicar una baja de inventario que no iba a ocurrir, y
  su texto afirmaba lo contrario de lo que el API haría.
- **Alto (web).** La precarga del plan de corte convertía mm → m con `number` y dos decimales
  (regla dura 1): un largo de 4 205 mm volvía como 4.20 m y guardar el plan sin tocar nada lo
  reescribía a 4 200. Los otros dos sitios usaban `Decimal`; este era el único que divergía.
- **Medios.** Sobre-reportar dejaba metros prometidos para siempre (ahora el upsert se topa
  contra lo que la línea debe); el peso por defecto de la guía heredaba una cantidad en metros;
  el `colorId` de bobinas y compras se conectaba sin validar, lo que permitía meter a posteriori
  un color desactivado y esquivar el guardrail de la baja lógica; la bobina elegida en la
  terminal no se limpiaba al bajarla; y `invalidateProduction` no refrescaba el material
  reservable que ve el vendedor.
- **Bajos.** `describePieces` dividía milímetros con `number` y ese texto viaja a la descripción
  del comprobante; `ROOFING_THICKNESS_TOLERANCE_MM` no se validaba al arrancar y un valor alto
  **anulaba el filtro en silencio** (fallo abierto); el plan derivado de una plancha de catálogo
  redondeaba hacia abajo; `reservationId` en el filtro de bobinas no se comprobaba contra el
  producto; la restauración de la reserva devolvía kilos a un rollo del que podían no haber
  salido; y varios detalles de accesibilidad y unidades en pantalla.

**Sin hallazgos críticos de seguridad.** El auditor confirmó que ninguna ruta nueva expone
costos a VENDEDOR (`roofingCoilOptionSchema` se diseñó sin ellos y el servicio construye
exactamente esos campos), que los guards y la auditoría cubren las nueve mutaciones nuevas, que
no hay superficie de inyección en los parámetros nuevos y que `pnpm audit --prod` sale limpio.
`agy` rehusó la tarea de segunda opinión, así que la auditoría es de una sola fuente.

### Tres defectos latentes de los helpers de E2E que esta fase hizo visibles

Ninguno es de la Fase 6, y los tres llevaban tiempo esperando la corrida que los despertara.
Van anotados porque el síntoma, en los tres casos, apunta a cualquier parte menos a la causa.

1. **`createInvoiceableCustomer` reusaba el cliente por RUC sin mirar si estaba activo.** El RUC
   facturable es uno solo, así que el helper siempre devuelve el mismo cliente entre corridas —
   y `prod:purge-e2e` lo deja `isActive: false`. Desde ahí, **toda** corrida contra producción
   posterior a una purga moría en `POST /sales/orders` con "El cliente está desactivado", en
   cuatro tests de Fase 5b que parecían haberse roto con lo último que se hubiera tocado. Ahora
   lo reactiva si lo encuentra inactivo.
2. **`today()` partía de UTC.** Es exactamente la lección de D-069, que el API ya había
   aprendido con `businessToday`: Lima va cinco horas detrás, así que a partir de las 19:00 hora
   local `toISOString()` devuelve la fecha de mañana y cualquier documento fechado "hoy" se
   rechaza por futuro. El fallo aparecía **según la hora a la que corrieras la suite**.
3. **Códigos y documentos con poca entropía.** El acabado (`E2E` + 4 letras) y el RUC de
   proveedor (`Date.now()` a secas) chocaban de vez en cuando dentro de una misma corrida, y el
   409 reventaba un test que no tenía nada que ver con lo que estaba probando.

Y una cuarta, operativa: **el job de E2E de CI se quedó sin tiempo**. Estaba en 30 minutos y la
Fase 6 le suma once tests, cada uno con su compra, recepción y ciclo comercial contra Neon.
Subió a 50.

### Ojo operativo — el cupo de la cuenta demo del PSE

Los dos tests de Fase 5b que emiten fallaron **en local** con
_"No puedes enviar mas de 50 documentos en una cuenta DEMO"_. Es lo que ya avisaba
`docs/handoff/fase-5b.md`: son 50 documentos, no se liberan anulándolos —hay que borrarlos en
el panel de Nubefact— y una corrida completa gasta unos veinte. Esta sesión corrió la suite
varias veces mientras se aplicaban las correcciones de la revisión, así que el cupo se agotó.
**No bloquea el cierre**: `e2e:prod` no emite nunca (D-081 fuerza `E2E_FISCAL_EMISSION=0`).

## Fase 7 — detalle (cola de producción; POS e importación quedan pendientes)

| #   | Entregable                                                                     | Estado                                                                                     |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Cola derivada (D-092, D-093): `GET /sales/orders/queue`, sin tabla nueva        | ✅ reusa `resolveDispatchTarget` (D-088) + filtro `kind=ROOFING`                              |
| 2   | Prioridad manual + fecha prometida (D-094, D-096)                              | ✅ 4 columnas en `sales_orders`, `PATCH .../priority`, `PATCH .../promised-delivery-date`     |
| 3   | Semáforo VENCIDO/PROXIMO/A_TIEMPO/SIN_FECHA                                    | ✅ `queueSemaphore()` en `@ayr/shared`, sobre `businessToday()` (D-069)                       |
| 4   | `/planta` como entrada (D-095), `/produccion` admin, badge en `/pedidos/[id]`  | ✅ `RoofingPickerCard` reescrita, `QueueEntrySummary`/`QueueAdminControls` compartidos         |
| 5   | Indicador RF-38 en el menú lateral                                              | ✅ badge en "Terminal de planta" con el conteo de la cola                                     |
| 6   | E2E: los 6 escenarios exigidos + 2 de borde                                    | ✅ `fase7.spec.ts` (7 tests), `fase7-bordes.spec.ts` (2 tests)                                |
| 7   | `pnpm turbo lint typecheck test build`                                         | ✅ verde                                                                                      |
| 8   | Migración de mano + `db:prod`                                                 | ✅ `20260905090000_fase7_cola_prioridad_fecha_prometida`, aplicada en `dev` y `production`     |
| 9   | Revisión: `revisor` + `auditor-seguridad` en paralelo                         | ✅ 1 ALTO (reserva de bobina que sobraba, corregido), 1 MEDIO (filtro `kind`, corregido), 1 BAJO (auditoría antes/después, corregido) |
| 10  | E2E contra producción + purga                                                  | ✅ 110/110 (13 saltados por D-081), purga sin rastros tras remediar un residuo de la propia purga (ver nota) |
| 11  | Deploy                                                                         | 🟡 API en Cloud Run hecho; **web pendiente** — token del CLI de Vercel vencido, requiere `vercel login` |

### Hallazgo del revisor: la reserva de bobina que nunca se drenaba (D-097)

`reserveKg` es una estimación del vendedor; casi nunca coincide con lo que la corrida termina
gastando, y D-086 permite rolar una bobina distinta a la reservada. En los dos casos, la
reserva de materia prima quedaba `ACTIVE` con saldo para siempre —el pedido no salía nunca de
la cola, ni despachado entero—, porque nada en `report()`/`close()` la drena si no coincide
exacto. `close()` ahora libera ese saldo (`releaseRemainingReservation`, `RELEASED` y no
`CONSUMED`: nada de esa bobina se volvió producto). Deliberadamente sin reversa en `reopen()`
— reabrir no depende de esa reserva. Detalle completo en `docs/DECISIONES.md` §D-097.

### Un hueco que la purga de producción destapó, no de la aplicación

`pnpm prod:purge-e2e` revierte cualquier despacho E2E "para devolver su stock al almacén"
(línea ~266 de `scripts/prod-e2e-purge.mjs`), sin distinguir si el ítem despachado es materia
prima (donde eso libera algo que otra limpieza necesita) o un **producto terminado de SKU
único de un solo test**, que nunca se vuelve a usar. Revertir el despacho de una cobertura ya
cerrada reabre en cadena una ventana en la que la orden de producción puede terminar
reabierta (`IN_PROGRESS`) sin que su reporte se revierta, dejando el kardex del producto con
saldo fantasma. Esta sesión lo encontró porque sus E2E fueron las primeras en pasar por
`/planta` → cerrar → **despachar** con un producto de coberturas en el mismo `prod:purge-e2e`
(el ciclo de Fase 6 nunca despachaba en su E2E). Se remedió a mano (reabrir → revertir el
reporte → anular, con el mismo criterio "anula por API" que usa el resto del script) y
`prod:purge-e2e` quedó en cero. **No se tocó el script**: redecidir cuándo conviene revertir
un despacho E2E (según si el ítem es materia prima o producto terminado de un solo uso)
excede el alcance de esta sesión y merece su propia revisión, no un parche apurado.

## Sesión M-3 — mantenimiento: auditoría y guardrail previos al pase a Nubefact real (2026-09-04)

Sesión corta de mantenimiento, fuera del avance por fases: preparar el pase de la cuenta demo
de Nubefact a la cuenta real (checklist de `docs/handoff/fase-5b.md`). **El pase no se hizo**:
el dueño decidió en esta sesión seguir en demo/contingencia hasta nuevo aviso. Lo que sí se
completó no depende de esa decisión y queda cerrado.

- **Auditoría previa (solo lectura, D-073).** `fiscal_documents` en producción: **0 filas**,
  ningún estado — nada en `ISSUED`, `SEND_ERROR` ni `VOID_PENDING`. Las cinco series
  (`F001`/`B001`/`BC01`/`FC01`/`T001`) siguen en `correlative=0`, nunca usadas.
  `invoicing_settings.providerOffline=false`. Confirmado con un script temporal (`prisma`
  `groupBy` + `findMany` sobre `fiscal_documents`/`fiscal_series`, no commiteado, borrado al
  cerrar la auditoría) contra la rama `production` de Neon. Conclusión: el pase, cuando se
  haga, no dispara ningún envío retroactivo — no hay nada en contingencia esperando salir.
- **Correlativos y series: sin cambios, decisión del dueño.** Arrancan en 1 (nunca se facturó
  antes con SUNAT bajo este RUC) y las series son las ya sembradas. El modelo **ya soportaba**
  un correlativo inicial distinto de 1 desde D-072 (`createFiscalSeriesSchema.correlative`,
  `min(0)`, pensado para continuar una numeración externa) — no hizo falta implementar nada.
- **D-081 — guardrail nuevo en `e2e:prod`.** `scripts/e2e-prod.mjs` fuerza
  `E2E_FISCAL_EMISSION: '0'` como última entrada del `env` que recibe Playwright, así que
  gana sin importar qué traiga el shell de quien invoque el script. Antes de este cambio,
  `E2E_FISCAL_EMISSION=1` en el entorno del operador se colaba sin que el script lo tocara —
  inofensivo hoy porque Cloud Run no tiene credenciales del PSE (D-080), pero dejaría de serlo
  el día que se cargue la cuenta real. Detalle y motivo completo en `docs/ARQUITECTURA.md` §0.2
  D-081.
- **`pnpm prod:purge-e2e` auditado, sin cambios.** Ya era seguro: solo actúa sobre comprobantes
  cuyo `customerName` o `notes` empiezan con `E2E ` (`isE2eDocument` en
  `scripts/prod-e2e-purge.mjs`), nunca sobre un documento real.
- **Verificación:** `pnpm turbo lint typecheck test build` en verde; no hubo cambio de schema
  ni de lógica de dominio, solo el script de E2E y documentación.

**Pendiente — el pase en sí.** Sigue abierto exactamente como lo dejó `docs/handoff/fase-5b.md`:
cargar `NUBEFACT_URL`/`NUBEFACT_TOKEN` productivos en Secret Manager
(`scripts/gcp-secrets.mjs`), agregar las dos líneas a `--set-secrets` en `scripts/deploy-api.mjs`
(ya comentadas en su sitio exacto), redesplegar, y hacer el smoke controlado de un comprobante
real. Precondición del dueño para retomarlo: cuenta real de Nubefact activa, RUC habilitado en
SUNAT, series confirmadas por el contador, y `NUBEFACT_URL`/`NUBEFACT_TOKEN` productivos en
`.env.setup`. Mientras no haya aviso del dueño, producción sigue sin credenciales del PSE
(D-080) y toda emisión cae en contingencia.

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
- **Fase 3b (resuelto en Sesión M-1, ver D-053).** `pnpm db:migrate` (`prisma migrate dev`) volvió a funcionar contra `dev`: la carpeta `20260903031603_fase3_corte_flejes` se renombró a `20260904125000_fase3_corte_flejes` (entre `fase2b` y `fase3b`, el orden real de aplicación) y `_prisma_migrations.migration_name` se sincronizó a mano en `dev` y `production`. Ya no hace falta escribir migraciones a mano ni usar `migrate deploy` para esquivar el shadow database; una migración nueva se crea con el flujo normal (`pnpm db:migrate`).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel está ligado al repo GitHub: cada push a `main` despliega el web.
- El proxy `/api/*` del web es un Route Handler (fetch server-side), no un `rewrite()` de Next: Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run (D-022).
- Para verificar RF-03 contra producción: `pnpm e2e:prod`. Crea un administrador efímero, corre los 6 escenarios de auth y borra los usuarios `e2e-...@ayr.test` en `finally` (D-024). Nunca usa ni modifica la cuenta del dueño. Si la limpieza fallara, el script lo avisa y hay que revisar `/usuarios` en producción.
- `spawnSync('algo.cmd', ...)` sin `shell: true` falla con `EINVAL` en esta máquina Windows/Node 24; usar `shell: true` (o invocar `cmd.exe /c` explícito) al lanzar `pnpm`/binarios `.cmd` desde Node.
- **Fase 7 (2026-09-05):** el token del CLI de Vercel (`%APPDATA%/xdg.data/com.vercel.cli/auth.json`) venció; `pnpm deploy:web` falla con `403 invalidToken`. No bloquea: el proyecto Vercel está ligado al repo de GitHub (ver arriba), así que el push a `main` de esta fase dispara igual el deploy del web. `pnpm deploy:web` vuelve a hacer falta el día que se necesite un deploy fuera de un push (p. ej. reapuntar `API_URL` sin cambiar código) — ahí sí hace falta que el dueño corra `vercel login` primero.
- **Fase 7 (2026-09-05):** `pnpm prod:purge-e2e` revierte cualquier despacho E2E para "devolver el stock", sin distinguir materia prima de producto terminado de SKU único — revertir el despacho de una cobertura ya cerrada puede reabrir su OP a medias y dejar el kardex del producto con saldo fantasma. Detalle y remediación en "Fase 7 — detalle" arriba. Pendiente decidir si vale la pena enseñarle al script esa distinción.
- Hallazgos de revisión pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquí para Fase 7 (hardening).
- SonarCloud: en `.env.setup` `SONAR_ORG` y `SONAR_PROJECT_KEY` venían intercambiados (corregido: org `gsinuiri-coder`, key `gsinuiri-coder_ayr-steel-erp`). El proyecto tenía Automatic Analysis activo; se desactivó por API para que el análisis lo haga CI con cobertura (D-021).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesión de Claude Code; en esta sesión se ejecutaron como `general-purpose` con la definición como prompt.
- **Fase 1.** apis.net.pe: el endpoint real es `v1/tipo-cambio-sunat?fecha=YYYY-MM-DD` (verificado contra la API real), no `v2/sunat/tipo-cambio` como se asumió al principio — devolvía 404 y quedó registrado un momento en el log como "no respondió" antes de corregirlo.
- **Fase 1.** `XLSX.read(buffer, {type:'buffer'})` asume un codepage no-UTF-8 para `.csv`, lo que rompe encabezados con tildes ("Línea" no matcheaba ninguna columna). `parse-spreadsheet.ts` ahora detecta si el archivo es un zip real (firma `PK`, `.xlsx`) y si no lo es, decodifica como UTF-8 y lee en modo `'string'`. Encontrado por el E2E de importación, no es cosmético: sin este fix ninguna fila con encabezados en español se validaba nunca.
- **Fase 1.** El E2E de CI (`imports`) sube archivos reales al bucket R2 de producción (`R2_BUCKET` es el mismo en GCP y en GitHub Secrets); quedan objetos de prueba con prefijo `imports/...` en R2 tras cada corrida de CI. No es un riesgo de seguridad, pero conviene un bucket o prefijo separado para CI si el volumen de corridas crece (anotado para Fase 7).
- Prisma expone el enum `BusinessLineCode` con los nombres declarados en el schema (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`, `metallic-roofing`...); `apps/api/src/common/business-line-code.ts` es el único lugar que traduce entre eso y el `BusinessLine` de `@ayr/shared`. Si se agrega una sexta línea de negocio, hay que tocar ese mapa además del enum de Prisma y el de `@ayr/shared`.
- **`ADMIN_PASSWORD` de `.env.setup` ya no es la contraseña real del admin en `production`.** El dueño la cambió al completar el flujo de `mustChangePassword` en su primer ingreso (cierre de Fase 0). Un intento de `POST /auth/login` contra producción con las credenciales de `.env.setup` devuelve `401 Credenciales inválidas` (evidencia de esta sesión, sin haber tocado nada). **Nunca** intentar loguearse como el admin real contra producción para verificar algo: usar siempre un administrador efímero (`apps/api/prisma/e2e-admin.ts` + `cleanup-e2e-users.ts`, patrón D-024) igual que hace `pnpm e2e:prod`.
