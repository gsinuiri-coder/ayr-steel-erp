# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                         | Estado                  | Cierre                                                   |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 0 — Bootstrap                                | ✅ Cerrada (2026-09-02) | Login E2E verde en prod, CI verde                        |
| 1 — Maestros, catálogo, precios, importación | ✅ Cerrada (2026-09-02) | E2E de Fase 1 verdes en local + CI, deploy en producción |
| 2a — Kardex + compras + alta de bobinas      | ✅ Cerrada (2026-09-03) | 16/16 E2E verdes en producción, CI verde, deploy hecho   |
| 2b — Partido, merma, cierre, anulación       | 🟡 En curso             | —                                                        |
| 3 — Corte tercerizado + flejes               | ⚪ Pendiente            | —                                                        |
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
| 9   | Revisión de `revisor` y `auditor-seguridad`                                                                             | ✅ 2 bloqueantes + 4 altos corregidos; ver abajo                                 |
| 10  | E2E de Fase 2b                                                                                                          | 🟡 en curso                                                                      |
| 11  | Deploy y migración en `production`                                                                                      | ⚪ pendiente                                                                     |
| 12  | Cierre: handoff, commit, push                                                                                           | ⚪ pendiente                                                                     |

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

**Rendimiento del partido y de la anulación.** Un partido creaba una bobina con ~8 consultas cada una, incluido un `UPDATE suppliers` que retiene el lock del proveedor hasta el commit: 60 hijas eran cientos de viajes a Neon bloqueando cualquier otra alta de ese proveedor. Ahora el máximo es 20 hijas, y proveedor, acabado, producto de catálogo y los N correlativos se resuelven una sola vez (`CoilsService.prepareBatch`). La anulación de una compra revierte hasta 200 movimientos en una transacción: se le subió el timeout a 120 s. Si el volumen crece, la salida es moverla a un job de pg-boss con estado `CANCELLING`.

**Diferido a fases posteriores:**

- `findMovements` de un ítem lee hasta 10 000 movimientos para calcular el saldo corrido. Sirve de sobra hoy; con años de historia hay que paginar hacia atrás desde un saldo de apertura, que ya está implementado para el filtro por fechas.
- El prorrateo de landed cost es siempre **por kg** (D-043). Si aparece un seguro que se cobra sobre el valor CIF, se agrega el criterio como campo de la compra.
- RF-22 (cancelar plan de corte) es de Fase 3 por D-044: en 2b no existe todavía el plan de corte.

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
