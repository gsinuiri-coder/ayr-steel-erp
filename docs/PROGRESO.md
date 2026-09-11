# Progreso por fase

> Actualizado por el agente al cerrar cada punto grande. Fases en `ARQUITECTURA.md` §3.7.

## Estado general

| Fase                                                                           | Estado                  | Cierre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Bootstrap                                                                  | ✅ Cerrada (2026-09-02) | Login E2E verde en prod, CI verde                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 1 — Maestros, catálogo, precios, importación                                   | ✅ Cerrada (2026-09-02) | E2E de Fase 1 verdes en local + CI, deploy en producción                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2a — Kardex + compras + alta de bobinas                                        | ✅ Cerrada (2026-09-03) | 16/16 E2E verdes en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2b — Partido, merma, cierre, anulación                                         | ✅ Cerrada (2026-09-04) | 30/30 E2E verdes en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3 — Corte tercerizado + flejes                                                 | ✅ Cerrada (2026-09-02) | 34/34 E2E verdes en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3b — Reversa de recepción de corte                                             | ✅ Cerrada (2026-09-03) | 40/40 E2E verdes en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4 — Producción drywall + `/planta`                                             | ✅ Cerrada (2026-09-03) | 56/56 E2E en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5a — Cotización → pedido + reserva                                             | ✅ Cerrada (2026-09-04) | 83/83 E2E en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5b — Facturación, GRE, despacho y cobranza                                     | ✅ Cerrada (2026-09-04) | 19 E2E contra el PSE demo, 89/89 en producción, CI verde, deploy hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6 — Producción de coberturas + color                                           | ✅ Cerrada (2026-09-05) | 101/101 E2E en producción, CI verde, deploy hecho, purga sin rastros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7 — Cola, punto de venta e importación de comprobantes                         | ✅ Cerrada (2026-09-05) | Cola (7), mostrador RF-60 (7b) e importación RF-71/72 (7c) completos. 110/110 E2E en producción (13 saltados por D-081, no emiten), purga sin rastros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7d — Pulido UI/UX pre-entrega al cliente                                       | ✅ Cerrada (2026-09-06) | Paginación server-side (D-113), fechas en zona de Lima (D-112), encabezado fijo sin contenedor de scroll (D-115), afordancia de link (D-114). 119/119 E2E en producción (38 saltados por D-081), deploy hecho, purga corrida — residuo de ventas/mermas ya hechas, ver detalle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7e — Venta de bobinas + catálogo estructurado + cotización                     | ✅ Cerrada (2026-09-06) | A+B+C+D+E (D-116..D-120) + D-121 (pestañas de `/bobinas`, piezas teóricas en planta), aprobados por el dueño y desplegados. D-122 (sacar el `ProductBom` de coberturas) diseñado, diferido al tramo 7e-ii. D-123 documenta la lección del primer push: 25 fallas reales en specs de fases anteriores que asumían comportamiento que D-117/D-118/D-120 cambiaron — corregidas, CI verde (159/159, 9 saltadas). 119/119 E2E en producción (38 saltados por D-081), deploy hecho (API por Cloud Run, web por la integración Vercel-GitHub — el CLI de Vercel sigue con el token expirado), purga corrida — residuo estructural no bloqueante (ventas/producción ya movidas), ver `docs/handoff/fase-7e.md`.                                                                                                                                          |
| 7 consolidada — backdating, entornos, subtipo de cobertura                     | ✅ Cerrada (2026-09-06) | D-124 (fecha de operación), D-125/D-126 (rama `demo` y prohibición de `e2e:prod`), D-127 (subtipo de cobertura y rama de confirmación). D-122 sigue diferido.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Sesión Planta — integridad de producción y tanda                               | ✅ Cerrada (2026-09-08) | D-146 (el plan de corte es un tope duro y el kg declarado es dato, no consumo), D-147 (`/planta/tanda`, todo o nada), D-148 (todas las órdenes de un pedido de una vez), D-149 (hoja de planta en PDF). 306/306 unitarios; 149 E2E locales con 3 fallas del cupo del PSE demo. **Sin desplegar**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Sesión Importadores — borrado de los directos y cotizaciones masivas           | ✅ Cerrada (2026-09-08) | D-150 (se elimina el módulo de importaciones entero), D-151 (padrón en el alta de proveedor), D-152 (importador de cotizaciones: preview sin estado + alta normal, todo o nada). 272/272 unitarios; 60 E2E locales. **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Sesión Comprobantes manuales — D-131 a regla dura y D-153                      | ✅ Cerrada (2026-09-08) | D-131 elevada a regla dura 14 con centinela; D-153 (un borrador tiene dos terminales: emitir por el PSE o registrar manual). 279/279 unitarios; E2E de comprobante manual 5/5 y regresión de facturación con las fallas conocidas del cupo del PSE demo. **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sesión Planta II — guard de reservas, espacio de producción, UX del importador | ✅ Cerrada (2026-09-09) | D-154 (el faltante de materia prima avisa y no bloquea en producción; un pedido no se bloquea a sí mismo), D-155 (`/planta/producir`: una pestaña por orden, guardado por orden, retira la tanda de D-147), D-156 (ningún campo obligatorio es un callejón: alta express y selects buscables). Regla dura 15 (puertos 4000/4001 del dueño) y `pnpm dev:preview`. **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sesión Planta III — importador asentado y una sola forma de producir           | ✅ Cerrada (2026-09-09) | D-157 (una cotización puede no vencer), D-158 (el cliente se crea del padrón), D-159 (plan de corte con largo bloqueado), D-160 (producir queda en un solo lugar). **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sesión Precios — plancha por metro, valor contra precio y piso duro            | ✅ Cerrada (2026-09-09) | D-161 (la plancha de catálogo se cotiza por metro lineal), D-162 («valor de venta» sin IGV contra «precio de venta» con IGV), D-163 (piso duro con el margen sobre la venta, para todos los roles). 341/341 unitarios; 69/69 E2E de los specs afectados. **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sesión Cierre de bobina — remanente liquidado y merma normal en el estándar    | ✅ Cerrada (2026-09-09) | D-164 (cerrar una bobina liquida su remanente como movimiento `CLOSE_ADJUSTMENT` en la misma transacción; reabrir lo revierte), D-165 (el 1 % de merma normal se absorbe en la densidad estándar, en código y en un solo lugar). `pnpm check:price-floor` (solo lectura) para decidir el aviso de mínimo en el POS. Regla dura 16 (ningún texto largo pasa por la shell). 352/352 unitarios; 5/5 E2E de D-164. **Sin desplegar y sin push**, esperando el OK del dueño.                                                                                                                                                                                                                                                                                                                                                                           |
| Sesión Largo de la plancha — el campo pedía mm y el catálogo tenía metros      | ✅ Cerrada (2026-09-09) | D-166 (el largo fijo de una plancha tiene que ser posible, y el campo dice en qué unidad va). Bugfix de la captura del dueño: las tres planchas del catálogo estaban en metros y D-161 multiplicaba por ese número — S/ 0.28 en vez de S/ 330. 357/357 unitarios; 3/3 E2E de pantalla y 33/33 de regresión. **Sin desplegar y sin push.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sesión S11 — T7: escritorio robusto y compacto, color e inspección de flujos   | ✅ Cerrada (2026-09-11) | D-179 (escritorio compacto: el sistema se diseña para una sola clase de pantalla; +76 %/+76 %/+49 %/+103 % de filas por pantalla en las cuatro listas principales) y D-180 (paleta sobria de un solo acento y cuatro tonos de estado de dominio, con rojo y ámbar reservados para error y aviso). Antes de tocar producto, `docs/analisis/s11-inspeccion-flujos.md`: los cinco flujos recorridos en un navegador real, con dos hallazgos que mandan — toda la app se renderizaba en Times New Roman (arreglado), y con transporte no se puede despachar ninguna línea que no se mida en kilos porque el formulario nunca pide el peso por línea que el API exige (documentado para Fase 8, no tocado). 239/239 E2E locales (2 saltados), 399 unitarios, lint/typecheck/format en verde. **Sin desplegar y sin push**, esperando la ventana única. |
| 8 — Auditoría, reportes, UAT                                                   | ⚪ Pendiente            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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

| #   | Entregable                                                                    | Estado                                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cola derivada (D-092, D-093): `GET /sales/orders/queue`, sin tabla nueva      | ✅ reusa `resolveDispatchTarget` (D-088) + filtro `kind=ROOFING`                                                                      |
| 2   | Prioridad manual + fecha prometida (D-094, D-096)                             | ✅ 4 columnas en `sales_orders`, `PATCH .../priority`, `PATCH .../promised-delivery-date`                                             |
| 3   | Semáforo VENCIDO/PROXIMO/A_TIEMPO/SIN_FECHA                                   | ✅ `queueSemaphore()` en `@ayr/shared`, sobre `businessToday()` (D-069)                                                               |
| 4   | `/planta` como entrada (D-095), `/produccion` admin, badge en `/pedidos/[id]` | ✅ `RoofingPickerCard` reescrita, `QueueEntrySummary`/`QueueAdminControls` compartidos                                                |
| 5   | Indicador RF-38 en el menú lateral                                            | ✅ badge en "Terminal de planta" con el conteo de la cola                                                                             |
| 6   | E2E: los 6 escenarios exigidos + 2 de borde                                   | ✅ `fase7.spec.ts` (7 tests), `fase7-bordes.spec.ts` (2 tests)                                                                        |
| 7   | `pnpm turbo lint typecheck test build`                                        | ✅ verde                                                                                                                              |
| 8   | Migración de mano + `db:prod`                                                 | ✅ `20260905090000_fase7_cola_prioridad_fecha_prometida`, aplicada en `dev` y `production`                                            |
| 9   | Revisión: `revisor` + `auditor-seguridad` en paralelo                         | ✅ 1 ALTO (reserva de bobina que sobraba, corregido), 1 MEDIO (filtro `kind`, corregido), 1 BAJO (auditoría antes/después, corregido) |
| 10  | E2E contra producción + purga                                                 | ✅ 110/110 (13 saltados por D-081), purga sin rastros tras remediar un residuo de la propia purga (ver nota)                          |
| 11  | Deploy                                                                        | 🟡 API en Cloud Run hecho; **web pendiente** — token del CLI de Vercel vencido, requiere `vercel login`                               |

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

## Fase 7b — detalle (punto de venta de mostrador; importación de comprobantes sigue pendiente)

Segundo tramo de la Fase 7 (D-092..D-096 dejaron la cola; esto entrega RF-60). Siete
decisiones nuevas, **D-098..D-104**, y una corrección de un hueco de Fase 5b que el
mostrador destapó.

Modelo en una línea: **el POS no es un camino paralelo de stock** (D-099). Es UI rápida que
crea pedido + despacho + comprobante + cobranza en **una transacción**, reusando los cuatro
servicios que ya existían desde la Fase 5b. El módulo `pos` no importa `InventoryModule` —no
escribe kardex, no toca reservas, no comprueba disponible— y esa dependencia ausente es la
prueba estructural de que no abrió un segundo camino.

| #   | Entregable                                                                      | Estado                                                                                                        |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0   | Defecto de `prod:purge-e2e` del tramo 1, corregido **en el guion**              | ✅ el bloque de producción se mueve después del despacho; commit propio                                       |
| 1   | Decisiones D-098..D-104 en §0.2 + contexto largo en `DECISIONES.md`             | ✅                                                                                                            |
| 2   | Prisma: `cash_sessions`, `pos_sales`, `PaymentMethod` += CARD/WALLET, `PICKUP`  | ✅ tres migraciones, aplicadas en `dev` y `production`                                                        |
| 3   | `*InTx` en pedido, despacho, comprobante y cobro (D-099)                        | ✅ el público abre la transacción y delega; el `*InTx` recibe la del llamador                                 |
| 4   | `POST /pos/sales`: los cuatro documentos en una transacción, envío al PSE fuera | ✅ D-073 intacto: la fase 1 se ensancha, el orden no cambia                                                   |
| 5   | Caja: apertura, ventas por medio, cierre con arqueo (D-101)                     | ✅ esperado solo con efectivo, congelado al cerrar; diferencia con motivo y ADMINISTRADOR                     |
| 6   | Anulación encadenada (D-100)                                                    | ✅ cobro → comprobante → despacho → pedido, solo en el turno abierto y con comprobante aceptado               |
| 7   | Web: `/pos` (una pantalla) y `/pos/caja`, aviso de contingencia (D-102)         | ✅ dos toques entre carrito y venta cerrada; `Mostrador` primero del grupo Comercial                          |
| 8   | E2E: los siete escenarios exigidos + cinco de borde                             | ✅ `fase7b.spec.ts` (5, emiten) y `fase7b-bordes.spec.ts` (6, no emiten y corren contra producción)           |
| 9   | `pnpm turbo lint typecheck test build`                                          | ✅ verde (236 unit, +15)                                                                                      |
| 10  | E2E contra producción + purga                                                   | ✅ 6 pasados y 6 saltados (D-081), sin fallos; producción sin rastros                                         |
| 11  | Deploy                                                                          | ✅ API en Cloud Run; **web pendiente** — el token del CLI de Vercel sigue vencido, llega con el push a `main` |

### Lo que más importa de la fase: el hueco de Fase 5b que la boleta escondía

`DispatchesService.reverse` se bloqueaba si **cualquier** comprobante vigente del pedido
facturaba alguna línea del despacho. Parecía correcto hasta que se cruzó con `voidPathFor`
(D-072): **una boleta no se da de baja de forma individual** —su baja va por resumen diario,
fuera de alcance en v1—, así que su único camino es la nota de crédito, que la deja
`ACCEPTED` para siempre. Consecuencia: el despacho de **toda** venta con boleta era
irreversible, y el propio mensaje de error ofrecía un camino ("emite una nota de crédito")
que no desbloqueaba nada.

Fase 5b no lo vio porque probó la nota de crédito y probó la reversa del despacho, pero
nunca las dos sobre la misma línea. El mostrador lo destapó en el primer intento: la boleta
es su caso normal. La corrección (`declaringDocument`) aplica el criterio que el módulo ya
usaba para el saldo (D-075): bloquea solo lo que **todavía** factura, y una línea acreditada
por completo por notas vivas dejó de estarlo. No es una excepción para el POS — cualquier
despacho con boleta, venga de donde venga, ahora se revierte por el camino que su mensaje
anuncia.

### Verificación — lo que se pudo correr y lo que no

- `pnpm turbo lint typecheck test build` **verde**: 236 unit (15 nuevos, todos del arqueo y
  de la forma de la venta de mostrador). `pnpm format:check` verde.
- `pnpm e2e --grep "Fase 7b"` **10 pasados, 1 saltado** en la primera corrida completa; el
  saltado era la anulación, que después se partió en dos (factura → baja, boleta → nota de
  crédito) y se corrigió. Una corrida de regresión de los 21 tests con "anular" en el título
  —Fase 2b, 3b, 5b, 6, 7 y M-2— quedó **19 pasados, 1 saltado y 1 fallo**, y ese fallo es el
  que destapó que la nota de crédito nacía borrador.
- `pnpm e2e:prod --grep "Fase 7b"` **6 pasados y 6 saltados, sin fallos**. Los 6 saltados son
  los que emiten: D-081 fuerza `E2E_FISCAL_EMISSION=0` contra producción y así tiene que ser.
- **Producción sin rastros**, verificado con `prod:purge-e2e` y con el reporte de solo lectura
  `prod:e2e-leftovers`: 0 perfiles con piezas en stock, **0 reservas activas en toda la base**,
  0 despachos vivos, 0 comprobantes E2E, 0 cobros vigentes y **0 turnos de caja E2E**.

**Bloqueo, documentado por la regla dura 9.** La suite local completa (`pnpm e2e`, 136 tests)
**no se pudo terminar** en esta sesión. Se intentó dos veces: la primera avanzó 12 tests en
85 minutos y la segunda, acotada a las ocho suites que tocan lo que la fase cambió, no llegó
a completar ninguno en 20 minutos. La causa es del entorno, no del código: la rama `dev` de
Neon quedó degradada tras las corridas del día, y en paralelo se acumularon procesos de
Chrome huérfanos de las corridas interrumpidas (27 en un momento) que saturaron la máquina.
La misma suite acotada corre contra **producción** en menos de un minuto, que es la prueba de
que el problema es local. La verificación de la suite entera queda en manos de **CI**, que la
ejecuta en cada push con su propia base (Neon rama `ci`, reseteada por corrida).

### Dos defectos de las herramientas que esta fase encontró

- **`scripts/e2e-prod.mjs` no incluía las suites de Fase 7b.** La lista de archivos está
  escrita a mano, así que una fase nueva no entra sola: la primera corrida contra producción
  ejecutó 123 tests y **ninguno era del mostrador**. Se agregaron las dos suites y, de paso,
  el guion pasa ahora a Playwright cualquier bandera extra (`pnpm e2e:prod --grep "Fase 7b"`),
  que es lo que permite verificar una fase sin las dos horas de suite entera.
- **Un argumento con espacios se partía en dos.** `run()` lanza con `shell: true` —pnpm es un
  `.cmd` en Windows—, así que `--grep "Fase 7b"` llegaba como `--grep Fase` más un filtro de
  archivo `7b`, y la corrida "acotada" ejecutaba 121 de los 135 tests. Ahora los argumentos
  con espacios viajan entrecomillados.

**Ojo operativo — el reporte final de `prod:purge-e2e` tarda mucho.** Consulta el saldo de
cada producto E2E **uno por uno** contra Cloud Run, y ya hay 443 acumulados de todas las
sesiones: la limpieza en sí termina rápido, pero el resumen final se va a más de una hora.
Mientras tanto, `node scripts/prod-e2e-leftovers.mjs` da el mismo cuadro leyendo la base
directamente y en segundos. Anotado para Fase 8.

### Hallazgos corregidos en esta fase (revisor + auditor-seguridad)

- **Bloqueante.** La nota de crédito de la anulación **nacía borrador y nadie la emitía**, y
  un borrador no acredita nada: no tiene correlativo, no está en los estados vivos y
  `documentBalance` no lo cuenta. Como una boleta solo se deshace por nota de crédito
  (D-072), el paso siguiente —revertir el despacho— se bloqueaba siempre, y con el cobro ya
  revertido la venta quedaba **a medio anular**. Encontrado dos veces por caminos distintos:
  al escribir el E2E de la anulación y por `revisor`. Ahora se emite en el acto, con el envío
  al PSE fuera de la transacción como toda emisión (D-073).
- **Alto.** `voidSale` **no era idempotente en el paso del comprobante**, en contra de lo que
  prometía su propio JSDoc: un reintento creaba otra nota de crédito, y un documento que
  quedó en `VOID_PENDING` hacía fallar la precondición con un mensaje que decía "todavía no
  fue aceptado". Ahora el paso 2 se salta si el comprobante ya está deshecho —dado de baja,
  en trámite de baja, o con una nota de crédito viva— y el reintento sigue por el despacho.
- **Alto.** `/pos/caja` le mostraba a un ADMINISTRADOR **el turno abierto más reciente de
  cualquier cajero como si fuera el suyo**: `GET /pos/cash-sessions` sin `userId` devolvía los
  de todos y la vista tomaba el primer `OPEN`. Desde ahí contaba billetes contra el esperado
  ajeno y cerraba una caja que no era la suya, sin ninguna señal en pantalla. El turno propio
  sale ahora de `GET /pos/context` (que filtra por el actor); el listado completo sigue
  disponible con `mine=false` y cada fila dice de quién es.
- **Medio (los tres, de concurrencia).** El guardrail "solo dentro del turno abierto" era
  TOCTOU: un cierre de caja podía confirmarse en medio de una anulación y congelar
  `expectedCashPen` contando como vigente una venta cuyo cobro ya se había revertido — un
  faltante inventado sobre el número que el cajero firma. Y dos anulaciones concurrentes de
  la misma venta podían emitir **dos notas de crédito** sobre la misma boleta: dos
  correlativos gastados y un saldo negativo que no se deshace. Los dos se cierran con el
  mismo mecanismo: la venta se **reclama** en un estado nuevo, `VOIDING`, bajo el lock de su
  turno y antes del primer paso. Desde ahí deja de contar para el arqueo, el cierre no puede
  colarse y la segunda anulación no encuentra nada que reclamar. Aparte, `createCreditNote`
  ganó el `FOR UPDATE` sobre el comprobante afectado que le faltaba desde Fase 5b — el mismo
  lock que `addPayment` toma para el saldo, por el mismo motivo.
- **Medios.** `cleanup-e2e-users.ts` se plantaba con una venta **ya anulada** pidiendo
  "anúlala primero" (sin salida); ahora solo bloquea con ventas vivas y se lleva las anuladas
  con su turno. El error de la anulación se pintaba **detrás** del diálogo abierto, así que
  el usuario no veía el motivo del fallo.
- **Bajos.** IDOR de lectura en `GET /pos/sales/:id` (era la única lectura del módulo sin
  comprobación de propiedad); el filtro de proveedores de `prod:purge-e2e` era `E2E` **sin
  separador**, contra lo que decía su propio comentario y contra el criterio del resto del
  guion —y ese guion corre contra producción anulando compras y bobinas—; la excepción al
  tope de S/ 700 se mandaba **implícita** por tener rol de administrador, cuando D-077 la
  describe como una decisión (ahora es una casilla explícita); el buscador cortaba por los
  200 primeros SKU **alfabéticos**, así que con el catálogo crecido un producto con stock
  podía no aparecer nunca (ahora arranca por las filas de saldo positivo); `PICKUP` no
  prohibía `totalWeightKg`; `totalsByMethod` estaba escrita en `@ayr/shared` y reimplementada
  a mano en el servicio; el cobro se registraba por el total del **pedido** contra el
  **comprobante**; y un E2E comprobaba que ninguna cobertura a medida aparece en el buscador
  **sin que hubiera ninguna en la base**, así que pasaba por vacío.

**Sin hallazgos críticos ni altos de seguridad.** El auditor confirmó que ningún VENDEDOR
puede ver o cerrar la caja de otro por API, anular una venta, cerrar con diferencia ni forzar
la boleta sobre el tope; que SUPERVISOR_PLANTA queda fuera del mostrador en las tres capas;
que ninguna ruta nueva expone costos de compra; que el efectivo esperado no entra por el
cuerpo de la petición; y que `pnpm audit --prod` sale limpio. `agy` rehusó la segunda
opinión, así que la auditoría es de una sola fuente.

Dos hallazgos quedan **anotados y sin corregir**, con motivo: el buscador de cliente del
mostrador se trae el maestro entero y filtra en el navegador (hace falta un `search` en
`GET /customers`, que es API de otro módulo), y el override de precio del vendedor no tiene
piso — es D-068 heredado, pero en mostrador el arqueo nunca lo detecta porque el efectivo
esperado se deriva del total de la propia venta. Los dos van a la Fase 8 (hardening).

### La modalidad de traslado que faltaba (D-103)

Una venta de mostrador crea un despacho de verdad, pero el traslado lo hace el **comprador**.
Ninguna de las dos modalidades de Fase 5b es cierta ahí: rellenar una placa y un conductor
inventados habría metido datos falsos en la tabla que alimenta guías reales, y poner al
cliente como "transportista" habría mentido en otro campo. Se agrega `TransferMode.PICKUP`,
sin transporte y sin peso, que **no tiene código en el catálogo 18 de SUNAT** porque nunca
llega a un documento: `issueDispatchNote` lo rechaza y el tipo del puerto
(`Exclude<TransferMode, PICKUP>`) hace que ni siquiera compile mandarlo al PSE. Sirve además
a cualquier recojo en tienda fuera del POS, y `/despachos/nuevo` lo ofrece.

### Frontera conocida — con el PSE en contingencia, una venta de mostrador no se anula

Sin credenciales del PSE (D-080) el comprobante queda `ISSUED`/`SEND_ERROR`: tomó
correlativo y espera al job. Ni la baja ni la nota de crédito existen sobre él, así que la
cadena de D-100 no puede empezar y el API lo rechaza diciendo el estado concreto. Se evaluó
revertir "por dentro" el cobro, el despacho y el pedido dejando el comprobante quieto: se
descartó porque el job de D-073 seguiría enviando después el comprobante de una venta que ya
no existe — que es exactamente lo que el guardrail de D-074 impide desde Fase 5b. Desaparece
sola con el pase a la cuenta real de Nubefact.

### Frontera conocida — el mostrador no entra a `prod:purge-e2e`, a propósito

Una venta de mostrador a **público en general** no lleva ninguna marca de prueba: su pedido
y su despacho salen a nombre del cliente sembrado de D-077, igual que una venta real.
Enseñarle a la purga a reconocerlas habría puesto en riesgo anular una venta de mostrador
**real** contra producción, y ese es el error que ese guion no puede cometer. No hace falta:
todas las ventas de mostrador emiten, y D-081 fuerza `E2E_FISCAL_EMISSION=0` en `e2e:prod`,
así que contra producción esa mitad de la suite se salta y no hay ventas de prueba que
limpiar. Lo que la otra mitad deja —proveedor, compra de producto terminado, producto,
pedido con cliente `E2E `— ya lo cubren los filtros de siempre, y los turnos de caja los
borra `cleanup-e2e-users.ts`, que ahora se planta si alguno tuviera ventas.

## Fase 7c — detalle (importación de comprobantes ya emitidos; la fila de la Fase 7 queda completa)

Tercer y último tramo de la Fase 7 (D-092..D-096 dejaron la cola; D-098..D-104, el
mostrador). Entrega RF-71 y RF-72 con cinco decisiones nuevas, **D-105..D-109**. RF-11, que
aparecía en la misma fila de §3.7, ya estaba entregado desde la Fase 2a: seguía ahí por
arrastre.

Modelo en una línea: **el comprobante importado es el mismo comprobante con otro origen**
(D-105). Vive en `fiscal_documents` con `origin = IMPORTED`, nace `ACCEPTED` porque SUNAT ya
lo recibió, crea su cuenta por cobrar como cualquiera —que es para lo que se importa— y no
habla nunca con el PSE: ni se envía, ni se reintenta, ni se consulta, ni se da de baja, ni
recibe una nota de crédito emitida acá.

| #   | Entregable                                                                        | Estado                                                              |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Decisiones D-105..D-109 en §0.2 + contexto largo en `DECISIONES.md`               | ✅                                                                  |
| 2   | Prisma: `origin`, `archived_at`, `supersedes_document_id`, `warnings`             | ✅ tres migraciones, aplicadas en `dev` y `production`              |
| 3   | Unicidad parcial de `number` (`WHERE archived_at IS NULL`) + `CHECK` de archivado | ✅ conviven la archivada y la vigente; dos vigentes, no             |
| 4   | `GroupedImportAdapter`: N filas de planilla → una entidad (D-107)                 | ✅ el grupo se valida entero y se confirma entero                   |
| 5   | `FiscalImportService` en `invoicing` (patrón `*InTx`, D-099)                      | ✅ las reglas fiscales no se mudan al importador                    |
| 6   | Serie del importado (D-106): empuje atómico, alta inactiva, tope de salto         | ✅ auditado, con el salto absurdo rechazado                         |
| 7   | RF-72: reimportar archiva la anterior, con sus tres puertas cerradas              | ✅ lo emitido acá, lo cobrado y lo acreditado no se reimportan      |
| 8   | Guardrails de D-105 en `invoicing` y en el web                                    | ✅ `assertIssuedHere` + botones apagados en vez de errores del API  |
| 9   | Avisos no bloqueantes (`import_rows.warnings`)                                    | ✅ "esta fila archiva la versión anterior" se ve antes de confirmar |
| 10  | E2E                                                                               | ✅ `fase7c.spec.ts` (4) y `fase7c-bordes.spec.ts` (9), 13 en verde  |
| 11  | `pnpm turbo lint typecheck test build`                                            | ✅ verde (255 unit, +19)                                            |

### Lo que más importa de la fase: lo que **no** miraba al archivado

RF-72 dice que reimportar archive la versión anterior, y eso se implementó desde el
principio. Lo que la revisión encontró es la otra mitad, y estaba fuera del código nuevo:
**todo lo que ya sumaba comprobantes seguía sumando también la versión archivada**, porque
una archivada conserva su `status = ACCEPTED` intacto.

- `receivables()` (RF-88) contaba las dos: reimportar un comprobante —el caso normal de
  RF-72, corregir un total mal tipeado— **duplicaba la deuda del cliente**, y ese total
  contradecía al listado de `/comprobantes`, que sí filtraba.
- El crédito por notas de crédito se sumaba igual desde las dos, así que el saldo del
  comprobante afectado se iba a cero con una sola nota reimportada.
- Nada impedía **cobrar** sobre una versión archivada, a la que se llega con un clic desde
  el enlace que la propia fase agregó.

El arreglo es una sola idea aplicada en todos lados: **`archivedAt: null` acompaña a
`LIVE_DOCUMENT_STATUSES` en cada agregado**. Es la misma lección de D-088 y D-097 —cuando
una entidad puede dejar de ser la vigente, hay que revisar cada punto que la lee— aplicada
por primera vez a un documento fiscal y no a una reserva.

### El correlativo que podía retroceder

`resolveSeriesInTx` hacía `findUnique` y después `update` sobre `fiscal_series.correlative`,
que es exactamente el recurso que D-072 mueve con `UPDATE … RETURNING` por un motivo: si
`allocateNumber` avanzaba la serie entre la lectura y la escritura, el `update` la pisaba y
el correlativo **retrocedía** — y el próximo comprobante repetía un número que SUNAT ya
tiene. Ahora es un `UPDATE … SET correlative = GREATEST(correlative, $n) … RETURNING` que
devuelve el valor anterior y el nuevo, y el salto queda en `audit_log`.

Encima se agregó el tope: adelantar una serie **activa** más de 1000 números se rechaza. No
hay ninguna ruta que baje un correlativo (a propósito, lo dice `setSeriesActive`), así que
un `12345678` tecleado donde iba `123` habría quemado el rango de la serie con la que se
factura de verdad, sin vuelta atrás y sin que nada lo avisara.

### Un defecto de RF-52 que llevaba ahí desde la Fase 1

Encontrado por `qa` al escribir los E2E: `parseSpreadsheet` leía el archivo **sin
`cellDates`**, así que SheetJS entregaba las fechas como el número de serie de Excel
(`2026-09-05` → `46270`) y toda fila con fecha quedaba inválida por formato. Con eso,
**ninguna planilla exportada por otro sistema se podía importar**: entraba solo un archivo
con la columna formateada como texto.

No es un defecto de esta fase: está en el importador desde RF-52. No se había visto porque
productos, clientes y bobinas no tienen ninguna columna de fecha, y el comprobante es la
primera entidad importable que sí. El arreglo tiene dos mitades, y la segunda es la que
habría vuelto: `rawToString` formateaba la fecha con `toISOString()`, que al este de
Greenwich cae en el **día anterior** — en Cloud Run (UTC) y en Lima coincide, así que el
defecto no habría aparecido nunca en producción y sí en la máquina de alguien. Ahora se
formatea con las partes locales, que es como SheetJS construye la fecha.

### Hallazgos corregidos en esta fase (revisor API + revisor web + auditor-seguridad)

Tres pasadas. La del web se hizo aparte, por la lección de la Fase 2b, y encontró un
bloqueante que la del API no podía ver.

**Bloqueantes.** Los tres del archivado (arriba); el correlativo con read-then-write
(arriba); una fila con `"abc"` en Cantidad terminaba en un **500** porque la validación de
grupo se lo pasaba a `toDecimal`; y, en el web, `setBatch(updated)` sin guarda **resucitaba
un lote cancelado**: el `blur` del clic en «Cancelar» dejaba una petición en vuelo cuya
respuesta reabría el preview con su botón de confirmar activo — confirmándolo se importaban
comprobantes que el usuario había descartado y se adelantaba una serie activa.

**Altos.** Una nota de crédito importada podía acreditar un comprobante **emitido por el
ERP** y sin tope de monto: borraba el saldo de una factura real con un documento que SUNAT
nunca vio, y de paso le bloqueaba la baja. El cliente del importado no pasaba las tres
reglas de la emisión normal (activo, genérico solo con boleta, factura solo con RUC), así
que entraban facturas contra un DNI. La columna de cliente vacía dejaba la fila **válida** y
moría recién al confirmar. Y en el web, dos ediciones solapadas podían dejar que la
respuesta vieja pisara a la nueva —con el agravante de que el `blur` del clic en «Confirmar»
ponía un `PATCH` en carrera con el `POST`—.

**Medios y bajos corregidos.** El grupo se arma con lo que **dice** el archivo y no con el
número ya validado (una línea con el correlativo roto se quedaba fuera de su propio
comprobante, y a precio cero ni siquiera movía el total: se habría importado un documento al
que le falta un renglón). Se guarda el total **del papel** y no el recalculado, porque con
la tolerancia de redondeo cobrar el importe exacto del comprobante real se rechazaba por
"excede el saldo pendiente"; el IGV absorbe la diferencia. El lote se reclama antes de crear
nada (dos POST simultáneos creaban el comprobante dos veces) y vuelve a `PARSED` si no entró
ninguno, para poder corregir y reintentar. El preview comprueba las notas de crédito vivas y
avisa del adelanto de serie. Tope de 50 líneas por comprobante, fecha de emisión de más de
diez años rechazada, `notes` es campo de cabecera, la fila que **tiene** el error ya no dice
"otra línea tiene errores", auditoría propia del archivado y de la serie creada al importar,
lock consultivo por número (un `FOR UPDATE` no bloquea nada cuando la fila todavía no
existe), `affectedDocType` en la serie de NC creada al importar, y `confirmErrorMessage`
acotado a las dos excepciones de dominio propias. En el web: el preview resincroniza con lo
que el API normalizó, no guarda si nada cambió, solo relee el lote entero en las entidades
agrupadas, los avisos llevan la palabra "Aviso" y variante para modo oscuro, y una versión
archivada dice que su saldo no cuenta en cobranzas.

### Frontera conocida — el costo del preview

Cada fila del preview hace hasta dos consultas (cliente y SKU), así que un archivo de 2000
filas son varios miles de viajes a Neon en una sola petición. Es el patrón que el importador
tiene desde RF-52 y la ruta es solo de ADMINISTRADOR, así que no se cambió acá; el tope de
50 líneas por comprobante sí acota lo que cuesta **revalidar un grupo** al corregir una
fila, que es lo que esta fase agregó. Resolver clientes y SKUs con dos consultas por archivo
queda anotado para la Fase 8, junto con el buscador de cliente del mostrador.

### Frontera conocida — la suite de esta fase no corre contra producción

Importar escribe numeración fiscal real —empuja el correlativo de una serie, o crea una
inactiva— y deja comprobantes que **no se pueden dar de baja**. Es exactamente el riesgo que
`fiscalEmissionAllowed()` gobierna desde la Fase 5b, así que `fase7c*.spec.ts` se salta
entera contra una URL externa con ese mismo motivo escrito. Las suites igual están listadas
en `scripts/e2e-prod.mjs`: listarlas es lo que hace que el informe diga "saltadas" en vez de
callar, que es el defecto que costó una corrida entera en la Fase 7b.

Aparte, `prod-e2e-purge.mjs` ahora **saltea la baja de un importado** en vez de intentarla:
el API la rechaza siempre (D-105), así que la purga imprimía un fallo perpetuo. Sus cobros
sí se revierten, que es la parte que ensucia cuentas por cobrar.

### El techo de tiempo del E2E en CI, otra vez

La primera corrida de CI de esta fase quedó **cancelada por timeout** a los 50 minutos, con
unos 75 de 149 tests hechos. No es un fallo de la suite: lo que manda no es el número de
tests sino la **varianza de Neon**. La misma suite de 136 tests tardó `22m16s` y `41m06s` el
mismo día (corridas `33975924839` y `33951665233`), así que con 149 la corrida lenta se pasa
del techo. Subido a **75 minutos**, dimensionado sobre el peor caso medido y no sobre el
promedio: un timeout no distingue "lento" de "roto", y averiguar cuál de los dos era obliga a
reejecutar la hora entera.

### Residuo en la rama `dev` de Neon

Las corridas de E2E de esta sesión dejaron en la rama `dev` unos catorce comprobantes
importados vivos, dos archivados, doce series `Z…` inactivas y veintiséis lotes de
importación, todos con marca `E2E `. **No se pueden borrar ni dar de baja por diseño**: un
importado no tiene camino de baja. No afecta a `ci` (se resetea por corrida) ni a
producción (la suite se salta allí). Limpiar `dev` exigiría SQL a mano, y es decisión del
dueño.

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

## Sesión M-4 — mantenimiento: anulación de comprobante importado y limpieza (2026-09-05)

Dos decisiones nuevas, **D-110** y **D-111**. Sesión corta y de una sola idea: **RF-71 había
entregado una operación sin su reversa.**

Un `fiscal_document` con `origin = IMPORTED` nace `ACCEPTED` con su cuenta por cobrar, y las
tres salidas del módulo —`send`, `voidDocument`, `createCreditNote`— exigen hablar con el
PSE, que no lo conoce como nuestro (D-105). Un número mal tecleado en una planilla se
convertía en una deuda que **nadie podía cancelar nunca**: ni un administrador, ni con SQL
sin romper las reglas del proyecto.

| #   | Entregable                                                          | Estado                                                                               |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Auditoría de solo lectura de importados (`prod-imported-audit.mjs`) | ✅ producción: **0**; `dev`: 33 con S/ 7080 de deuda inventada                       |
| 2   | Estado `ANNULLED` + `POST /invoicing/documents/:id/annul` (D-110)   | ✅ solo ADMINISTRADOR, con motivo, saldo a cero, 409 idempotente                     |
| 3   | Censo de lectores de estado antes de escribirlo                     | ✅ todas las listas de "vivos" ya eran blancas; las negras que quedaban, convertidas |
| 4   | `LIVE_DOCUMENT_STATUSES` una sola vez, en `@ayr/shared`             | ✅ estaba escrita **siete** veces                                                    |
| 5   | La purga de producción anula los importados de prueba               | ✅ antes solo podía saltearlos                                                       |
| 6   | `pnpm db:reset-dev` (D-111)                                         | ✅ `neonctl branches reset --parent`: resetea, no borra                              |
| 7   | E2E                                                                 | ✅ `m4-anulacion-importado.spec.ts`, 6 escenarios                                    |
| 8   | Limpieza de `dev`                                                   | ✅ repuesta desde `production`: 0 importados, 0 series inactivas, 0 lotes            |
| 9   | `pnpm turbo lint typecheck test build` + 38 E2E                     | ✅ verde (257 unit)                                                                  |

### La cuarta vez que falta la reversa

D-061 (pago a proveedor), D-088 y D-097 (la reserva), y ahora D-110. El patrón es idéntico
las cuatro veces: se construye una operación que **crea** un hecho y su reversa se deja para
después porque parece un caso raro; el caso raro resulta ser el primer día de uso real.

La regla que queda escrita: **una operación que crea un hecho persistente no está terminada
hasta que existe la que lo deshace**, y se puede llegar a ella desde la pantalla.

### Por qué `ANNULLED` y no `VOIDED`

Reusar `VOIDED` era la opción barata: el efecto buscado es idéntico y **todos** los filtros
existentes ya lo trataban como terminal, así que no habría hecho falta tocar nada. Por eso
estuvo cerca de ser la decisión equivocada.

`VOIDED` no describe un efecto sino un **hecho**: SUNAT aceptó la baja. Sobre un importado
ese hecho nunca ocurrió, y un contador que viera `VOIDED` en la base concluiría que el
comprobante está dado de baja ante SUNAT cuando allí sigue vigente. Es la misma trampa que
D-105 evitó con `ACCEPTED`, y repetirla en el otro extremo del ciclo habría sido peor: un
estado equivocado sobre un documento fiscal es una afirmación falsa en un registro que se
audita.

### La regresión que la propia corrección introdujo

El censo de estados salió mejor de lo previsto: casi todos los cortes del módulo eran
**listas blancas**, y una lista blanca no deja entrar a un estado nuevo por descuido. Las dos
listas negras que quedaban en el API —cuál es la guía de remisión vigente de un despacho— se
convirtieron a lista blanca por eso mismo.

Y ahí estuvo el error: se usó la lista de **vivos**, que no incluye `DRAFT`. Una guía nace
`DRAFT` dentro de su transacción y solo después toma número y sale al PSE (D-073), así que un
fallo entremedio la deja en borrador para siempre. Con el corte en los vivos, reintentar la
emisión habría creado una **segunda guía** para el mismo despacho en vez de encontrar la que
quedó a medias — y el mensaje de error que estaba ahí desde Fase 5b decía "la guía en
borrador", o sea que el caso estaba previsto desde el principio.

Corregido con `STANDING_DOCUMENT_STATUSES` (borrador + vivos), que es el corte que
corresponde a la pregunta "¿hace falta crear otra?". La ironía vale anotarla: **el cambio que
convertía listas negras en blancas para que ningún estado entrara en silencio, metió en
silencio un estado de menos.** Una lista blanca es más segura que una negra, pero solo si se
elige la lista correcta; el nombre del conjunto (`LIVE`) no era el que la pregunta pedía.

### Hallazgos corregidos en esta sesión (revisor + qa)

**Altos.** `actorIdsOf` no incluía `annulledById` ni `voidedById`, así que el nombre de quien
anuló salía `null` **siempre** y el web lo escondía sin fallar: la constancia quedaba muda
justo en lo primero que se pregunta. Y el web contaba las notas de crédito vivas con una lista
negra, así que una NC anulada seguía contando como viva ahí y no en el API — el saldo del
afectado subía del lado del servidor mientras la pantalla escondía el botón de anular y
explicaba que el saldo ya estaba ajustado.

**Medios y bajos.** Una nota de crédito importada podía acreditar un comprobante anulado, y
el afectado no se bloqueaba con `FOR UPDATE` antes de leerlo. El `CHECK` de la constancia era
una implicación y pasa a ser equivalencia: admitía una fila con fecha, autor y motivo de
anulación **y un estado que sigue debiendo**. El aviso que explica por qué no se puede anular
era código muerto en un importado —se renderizaba bajo `voidPath === 'VOID'`, que es `null`
para todos ellos—, así que un importado con cobro vigente perdía el botón sin ninguna
explicación en pantalla. Y `db-reset-dev.mjs` no verificaba que `dev` colgara de verdad de
`production`, ni validaba el argumento de `--preserve-under-name` (`--preserve-under-name
--yes` creaba una rama llamada `--yes`).

### Un patrón de fechas que queda anotado

`formatDate(x.slice(0, 10))` sobre un **timestamp** lo corta en UTC, y Lima va cinco horas
detrás: todo lo ocurrido después de las 19:00 locales se muestra fechado al día siguiente. Es
el mismo desfase que `businessToday` existe para evitar (D-069).

Se corrigió en la pantalla de comprobantes (`formatTimestampDate`, nuevo en `lib/format.ts`).
Quedan **nueve** sitios con el mismo patrón, anotados para la Fase 8 porque cada uno exige
comprobar si el campo es un instante o una columna `DATE` —donde el corte sí es correcto—:
`despacho-detalle-view.tsx:179` y `:312`, `pedido-detalle-view.tsx:322` y `:365`,
`cotizacion-detalle-view.tsx:271`, `corte-view.tsx:155`, `produccion-view.tsx:236`,
`produccion-detalle-view.tsx:355` y `bobina-detalle-view.tsx:232`.

### La suite de importación sigue sin correr contra producción, con motivo nuevo

El motivo original —"deja comprobantes que no se pueden dar de baja"— **dejó de valer**:
D-110 les dio anulación y la purga la usa. Quedan otros dos, revisados en esta sesión y
escritos junto a la lista de suites en `scripts/e2e-prod.mjs`:

1. cada comprobante importado **crea una serie inactiva** (D-106) que no tiene borrado —con
   documentos colgando no se puede eliminar—, y son unas catorce por corrida acumulándose
   para siempre en un maestro fiscal;
2. serían los **primeros** comprobantes fiscales de prueba en el registro real de la empresa,
   y D-081 apagó la emisión contra producción justo para que no los hubiera.

Lo que estas suites prueban no depende de la infraestructura de producción, y CI ya las corre
enteras contra la rama `ci`. Cerrar el punto 1 exigiría que la suite importara sobre una serie
E2E fija en vez de una `Z…` al azar; queda dicho por si algún día se decide.

### Limpieza verificada

- **Producción: cero rastros.** No había ninguno que borrar —la compuerta de D-081 mantuvo la
  suite de Fase 7c fuera de allí— y sigue en cero tras la sesión, comprobado con
  `node scripts/prod-imported-audit.mjs`.
- **`dev`: repuesta desde `production`** con `pnpm db:reset-dev --yes`. Antes: 62 importados
  y S/ 8614 de deuda inventada. Después: 0 importados, 0 series inactivas, 0 lotes de
  importación, `prisma migrate status` con las 33 migraciones y "Database schema is up to
  date!".

## Fase 7d — detalle (pulido UI/UX pre-entrega al cliente)

Fase de pulido, no de features (cero cambios de dominio/schema salvo lo listado). Cuatro
tareas: fechas, tablas, afordancias de link/botón, y un barrido general de estados
vacíos/loading/errores/móvil. Ver handoff completo en `docs/handoff/fase-7d.md`.

### Entregado

- **Fechas (D-112).** Las nueve pantallas pendientes de la Sesión M-4 (`despacho-detalle-view.tsx`
  ×2, `pedido-detalle-view.tsx` ×2, `cotizacion-detalle-view.tsx`, `corte-view.tsx`,
  `produccion-view.tsx`, `produccion-detalle-view.tsx`, `bobina-detalle-view.tsx`) más un
  décimo hallazgo nuevo (`tipo-cambio-view.tsx`, un formulario que ofrecía registrar el tipo
  de cambio de mañana después de las 19:00) ahora usan `formatTimestampDate`. Regla ESLint
  nueva que bloquea `slice(0, 10)` sobre un ISO de acá en adelante.
- **Paginación server-side (D-113).** 10 endpoints (`/customers`, `/coils`, `/sales/orders`,
  `/sales/quotations`, `/dispatches`, `/purchases`, `/invoicing/documents`,
  `/invoicing/receivables` + `/invoicing/receivables/summary` nuevo, `/inventory/movements`,
  `/imports`) devuelven `PaginatedResult<T>`; las 10 vistas correspondientes tienen control de
  página/tamaño (`<PaginationBar>`). Patrón híbrido (`paginateInMemory` +
  `DERIVED_FILTER_FETCH_CAP`) para los 3 filtros derivados que no se pueden expresar en SQL sin
  duplicar D-075. `fetchAllForPicker` para los 4 selectores tipo autocompletado.
- **Tablas: encabezado fijo, sin contenedor de scroll (D-115).** Se implementó el contenedor
  con max-height + scroll interno, pero el dueño pidió revertirlo antes del deploy: vuelve el
  scroll natural de página (`<div className="rounded-lg border">`, como antes de esta fase).
  El encabezado `sticky top-0 z-10 bg-background` de `<TableHeader>` se mantuvo — sigue
  funcionando sin el contenedor. Paginación y columnas responsive (`hidden md:table-cell` /
  `lg:table-cell` en bobinas, pedidos, cotizaciones, despachos, compras, comprobantes, kardex,
  cobranzas, clientes) quedaron intactas, no dependían del contenedor.
- **Afordancia de link unificada (D-114).** `LINK_CLASSNAME` en `apps/web/src/lib/utils.ts`
  reemplaza ~50 sitios que tenían 3 variantes distintas de subrayado escritas a mano.
- **Barrido general.** Loading (`Skeleton`) y estados vacíos ya eran consistentes en casi
  todas las vistas; se agregó el que faltaba en `margenes-view.tsx`. `/planta` y `/pos`
  verificados en viewport 375px (capturas locales): sin overflow horizontal, botones e
  inputs a ancho completo, estados vacíos con mensaje. Breadcrumbs: **no existen en la app**
  y no se construyeron acá (sería una feature nueva, fuera del alcance de pulido) — la
  navegación depende del sidebar persistente, que cubre bien el caso de escritorio; una
  pantalla de detalle en móvil con el sidebar colapsado se queda sin "volver a la lista" más
  que el botón atrás del navegador. Anotado para Fase 8 si se decide agregar un link "←
  Volver" en las vistas de detalle.

### Hallazgos corregidos (revisor web + auditor-seguridad)

**Altos (revisor).** Al mover la búsqueda de pedidos y cotizaciones al servidor se perdió sin
querer el filtro por código (`PED-000123`/`COT-000123`) que antes existía en el cliente —
corregido extrayendo el número del texto de búsqueda y agregando `seq` al `OR` del `where` en
`sales-orders.service.ts`/`quotations.service.ts`. Y `customer-picker.tsx` (identificar
cliente en el mostrador) usaba `fetchAllForPicker` sin `search`, así que un cliente activo
fuera de los primeros 200 alfabéticos dejaba de encontrarse antes de darlo de alta —corregido
pasando el documento tecleado como filtro server-side.

**Bajo (auditor-seguridad).** `page` no tenía cota superior a diferencia de `pageSize`: un
`page` arbitrariamente grande seguía siendo un `OFFSET` arbitrariamente grande para Postgres.
Corregido con `MAX_PAGE = 10_000` en `paginationQuerySchema`.

### E2E

**Local: verde.** El agente `qa` reparó las suites existentes que asumían la forma vieja del
API (`getJson` directo sobre un endpoint que ahora envuelve en `PaginatedResult`) con un
helper nuevo (`getItems`), y agregó `fase7d.spec.ts` (3 pruebas: paginación en clientes y en
compras, fecha de alta de una bobina en zona de Lima). Único residuo conocido: dos pruebas de
`fase5b.spec.ts`/`fase5b-bordes.spec.ts` fallaron por el throttle de `/api/auth/login` (10
intentos/60s) al correr la suite entera sin cortes — no es un defecto de esta fase, y las 13
pruebas restantes de esos dos archivos pasaron limpio en una corrida aislada.

**Producción — primer intento (prematuro), corregido.** Se corrió `pnpm e2e:prod` **antes**
de desplegar el código de esta fase: contra la API vieja (sin `PaginatedResult`), `getItems`
leía `.items` de un array plano y devolvía `undefined`, así que 64 de 155 pruebas fallaron con
`TypeError` en cascada — no era un defecto del código de esta fase, era incompatibilidad
esperada entre E2E nuevos y API vieja. La corrida alcanzó a crear datos reales antes de fallar;
se detectó que `fase7d.spec.ts` (prueba de clientes) no tenía limpieza para producción —
corregido agregando `customerIds` a `deactivateTrail`— y se purgó lo creado.

**Deploy y revert (D-115).** Antes de repetir `e2e:prod`, el dueño pidió revertir el
contenedor de scroll interno de tabla (ver arriba). Con el revert commiteado y con CI verde en
ambos pushes, se deployó de verdad: `pnpm deploy:api --web-origin
https://ayr-steel-erp-web.vercel.app` (mismo Cloud Run de siempre, `/health` en verde) y
`pnpm deploy:web` — que falló por el token del CLI de Vercel vencido (bloqueo ya conocido de
Fase 7, ver `docs/handoff/fase-7.md`), **pero no importó**: el proyecto Vercel está ligado al
repo de GitHub, así que el push a `main` ya había disparado el deploy del web por su cuenta
(confirmado con `gh api repos/.../commits/<sha>/status`: `Vercel` → `success`, "Deployment has
completed").

**Producción — corrida real, contra el código de esta fase.** `pnpm e2e:prod`: **119/119
pruebas pasaron** (38 saltadas por la compuerta de D-081, ninguna falló), incluidas las 3 de
`fase7d.spec.ts`. Es la primera corrida completa de la suite entera que llega al final sin
cortar — expuso residuo real que las corridas parciales anteriores nunca habían llegado a
crear: dos órdenes de producción con planchas ya vendidas (`OUT SALE`) y dos recepciones de
corte con flejes ya mermados (`SCRAP`) que `pnpm prod:purge-e2e` **no pudo revertir**, con el
mismo mensaje que le daría a un administrador desde la UI ("ya se movieron... anula ese
movimiento antes"). No es un defecto de la purga ni de esta fase: es la misma regla de
append-only (§3.2) que el proyecto aplica en todos lados — vender o mermar algo no se deshace
sin revertir esa venta o esa merma primero, y escribir esa reversa es un cambio de dominio
fuera del alcance de "pulido". Corrida la purga dos veces (la segunda sí limpió clientes,
proveedores, productos, acabados y las órdenes de corte pendientes que la primera pasada había
dejado a medias), el residuo final —confirmado con `node scripts/prod-e2e-leftovers.mjs`— es:

- 2 órdenes de producción (`OP-000319`, `OP-000320`) y 2 recepciones de corte, bloqueadas por
  ventas/mermas ya hechas.
- 3 colores de prueba, cada uno usado por 1 bobina todavía abierta (consecuencia de lo de
  arriba).
- 5 productos de prueba con stock remanente (12–40 unidades cada uno).
- Todo lo demás —clientes, proveedores, productos sin stock trabado, compras, cotizaciones,
  pedidos, despachos, comprobantes— en cero activos o revertido.

Todo marcado con prefijo `E2E`/`BOB`, sin costos ni cantidades que se mezclen con inventario
real, y sin ningún rastro visible desde una pantalla que un usuario real use (proveedores,
clientes y productos de prueba quedan desactivados). Queda igual de limpio que lo que cualquier
corrida completa de esta suite iba a dejar contra producción real desde el día que existieran
Fase 6 y Fase 7b juntas — no es nuevo de esta fase, es la primera vez que se ve completo.

## Sesión 7 consolidada — backdating, entornos y subtipo de cobertura (2026-09-06)

Tres frentes en una sesión, en orden de prioridad: **M1** la fecha de operación (D-124),
**M2** el entorno de ensayo y la prohibición de correr E2E contra producción (D-125, D-126), y
**M3** —recortado sobre la marcha por un caso real que apareció en producción— el subtipo de
cobertura y la rama de confirmación que faltaba (D-127). Lo demás de D-122 sigue diferido.

### M1 — Fecha de operación (D-124)

El disparador: el sistema se entrega mañana y el dueño necesita cargar agosto **después**. Sin
separar el día de negocio del instante de grabación, todo lo que se registrara hoy quedaba
fechado hoy y ningún reporte de agosto lo veía.

Columna `operation_date` (DATE, día calendario de Lima) nueva en `inventory_movements`,
`coils`, `cutting_orders`, `cutting_order_coils` (recepción), `production_orders` (arranque y
cierre, en dos columnas) y `production_reports`. `dispatches.dispatch_date`,
`customer_payments.date` y `supplier_payments.date` ya eran fechas de negocio: no ganan
columna, ganan la misma validación. Los timestamps de auditoría no se tocaron.

Un único validador, `OperationDateService` (en `ConfigModule`, que es `@Global`, para que los
servicios de cinco módulos lo inyecten sin cablear nada): sin campo → hoy en Lima; con campo →
solo ADMINISTRADOR, nunca futura, nunca antes de `HISTORICAL_LOAD_START` (env, default
`2026-08-01`).

El **guardrail de orden cronológico** quedó dentro de `InventoryService.record`, el único
escritor del kardex. Se escribió primero repartido por los llamadores y se movió antes de
terminar: son 34 puntos que escriben kardex en siete servicios, y un control que hay que
acordarse de llamar 34 veces es el hueco de D-088 otra vez. Costo cero en el flujo normal: si
la fecha es hoy no puede haber nada posterior y ni consulta.

**La migración tuvo que apagar el trigger de append-only** de `inventory_movements` para poder
backfillear la columna nueva y volver a encenderlo. Se descubrió al aplicarla: `migrate deploy`
falló con `inventory_movements es append-only: no se permite UPDATE`, que es exactamente la
regla haciendo su trabajo. Es la única forma de agregarle una columna a una tabla inmutable y
es seguro (escribe un campo que hasta esa migración no existía, derivado del `at` de la misma
fila). El backfill convierte a **Lima**, no a UTC: cortar en UTC habría fechado al día
siguiente todo lo ocurrido después de las 19:00 locales — el desfase de D-112.

**Reporte mensual de bobinas** (`/reportes/bobinas`, `GET /reports/coils?month=YYYY-MM`), que
es lo que el backdating habilita: la columna "Saldo inicio de mes" sale de sumar los
movimientos anteriores al corte por su fecha de operación, y antes de D-124 no se podía
calcular. Se preguntó al dueño y confirmó que el reporte **no existía** y había que construirlo
(la instrucción original decía "reemplazar la columna EMPRESA", que no estaba en ninguna
pantalla). "Saldo fin de mes" reemplaza a "Disponible": en un reporte de agosto, mostrar el
saldo de hoy sería mezclar dos cortes en la misma fila.

### M2 — Entornos (D-125, D-126)

Rama Neon **`demo`** creada desde `production` (`br-solitary-smoke-aegbos8k`), migrada y
sembrada. `pnpm env:demo` / `db:demo` / `dev:demo`; `dev:demo` inyecta la conexión por entorno
y no toca `apps/api/.env`, así que convive con `pnpm dev`. `docs/ENTORNOS.md` documenta las
cuatro ramas y para qué sirve cada una.

**`pnpm e2e:prod` queda prohibido como rutina** (regla dura 9 de `CLAUDE.md`). La verificación
post-deploy es `pnpm smoke:prod`: `/health` sin sesión, login con el admin efímero de D-024 y
cinco GET; lo único que escribe es ese usuario, y lo borra en `finally`. La suite completa vive
en local y en CI. `prod:purge-e2e` queda solo para emergencias documentadas acá.

### M3 (recortado) — Subtipo de cobertura (D-127)

Entró a mitad de sesión con un caso real: COT-000240 fallaba al confirmarse con `0.000 MTR
disponibles… necesita 61.000`. Era una cobertura **a medida** de 61 ml con subítems de largo, y
el sistema le estaba pidiendo stock de un producto terminado que no existe hasta que planta lo
rola.

`products.roofing_kind` (`PLANCHA` / `A_MEDIDA`), obligatorio en Metallic Roofing, visible y
corregible en el diálogo de producto y en la lista del catálogo; una cobertura nueva nace
`A_MEDIDA`. Largo fijo obligatorio solo en `PLANCHA` y prohibido en `A_MEDIDA`. Subtipo y
unidad no pueden discrepar (validación + `CHECK`). El backfill usa la inferencia que regía
hasta hoy (`unit = MTR` → a medida), así que ningún producto cambia de comportamiento al
migrar: lo que cambia es que el dato ahora está escrito.

`resolveSalesLines` ramifica por el subtipo: una línea a medida sin bobina elegida calcula los
kilos teóricos y **reserva materia prima**, eligiendo la bobina con el mismo filtro que el
selector de la OP (extraído a `roofing-coil-match.ts` para que no diverjan, D-086) y quedándose
con la más antigua por `operationDate` que alcance. Una plancha sigue exigiendo stock.

Lo que **no** entró de D-122: `products.finish_id` y sacarle a coberturas la dependencia del
`ProductBom`. La densidad del acabado sigue saliendo de la receta. Queda para su propia sesión.

### Incidente de seguridad de esta sesión: una cadena de conexión de Neon quedó impresa en el log

**Qué pasó, en orden.** Al escribir `scripts/db-demo.mjs` le pasé la conexión a
`prisma db execute` como argumento (`--url <cadena>`). El comando falló por otro motivo (la
cadena lleva un `&` que el shell de Windows parte en dos), y el manejador de errores del propio
guion —que compone el mensaje con `args.join(' ')`— **imprimió la cadena completa, contraseña
incluida**, en la salida de la terminal.

**Alcance.** La contraseña del rol `neondb_owner` es **la misma en las cuatro ramas** del
proyecto Neon: se verificó comparando huellas SHA-256 de las contraseñas de `production`, `dev`
y `demo`, sin imprimir ninguna, y las tres coinciden. Así que lo expuesto no es la credencial de
demo: es la credencial de **producción**.

Dónde quedó: en la salida de esa terminal y en el registro de la sesión del agente. No se
commiteó, no salió del equipo por ningún otro canal y no está en ningún archivo del repo
(`git ls-files` no lista ningún `.env*`; `.env.demo` está cubierto por el `.gitignore`).

**Qué se corrigió en el código, para que no se repita.**

- `scripts/db-demo.mjs` ya no pasa ninguna conexión por `argv`: van solo por el entorno del
  proceso hijo, y `prisma db execute` toma la suya del `DIRECT_URL` del entorno.
- El mensaje de error de ese guion dejó de repetir los argumentos. `scripts/lib.mjs#run` ya
  filtraba `secret|password|token`; el helper local de `db-demo.mjs` no, y esa fue la diferencia.

**Lo que hace falta que hagas vos (no lo puede hacer el agente).** Rotar la contraseña del rol
en Neon y propagarla:

1. Consola de Neon → proyecto `ayr-steel-erp` → **Roles** → resetear la contraseña de
   `neondb_owner`.
2. `pnpm env:local` y `pnpm env:demo` — regeneran los `.env` locales tomando la cadena nueva de
   `neonctl`.
3. `pnpm secrets:gcp` — actualiza `DATABASE_URL`/`DIRECT_URL` en Secret Manager, y después
   `pnpm deploy:api` para que la revisión de Cloud Run tome los secretos nuevos.
4. `pnpm secrets:gh` — actualiza `CI_DATABASE_URL`/`CI_DIRECT_URL` para las corridas de CI.

Mientras tanto el riesgo real es bajo (la cadena no salió del equipo), pero la credencial es la
de producción y el sistema se entrega mañana: conviene hacerlo antes del deploy, y el paso 3 ya
está en el camino de todos modos.

### Los dos defectos que encontró `qa`, y por qué ninguna otra verificación los veía

El agente `qa` escribió 14 casos nuevos (8 de D-124, 6 de D-127) y corrió un smoke de las
suites que tocan coberturas, ventas y kardex. **No dio verde**: encontró dos defectos reales de
la implementación, los dos invisibles para `lint`, `typecheck`, `test` y `build`.

**1. Un ciclo de imports en `@ayr/shared` borraba campos de schema en silencio (D-130).**
`schemas/operation.ts` importaba `businessToday` de `sales.ts`, que importa de `coil.ts` y
`roofing.ts`, que importan `backdatableFields` de `operation.ts`. En CommonJS un módulo a medio
inicializar devuelve `undefined`, y `{ ...undefined }` no lanza: esparce nada. Seis schemas
—`createRoofingOrderSchema`, `reportRoofingPiecesSchema`, `closeRoofingOrderSchema`,
`reverseMovementSchema`, `createCoilScrapSchema`, `createCoilSplitSchema`— perdían
`operationDate` y `confirmBackdate`. Toda la rama de coberturas y **todas** las anulaciones
ignoraban la retrofecha; y como Zod descartaba el campo antes de que llegara a
`OperationDateService`, **un VENDEDOR no recibía el 403** en esas rutas y una fecha inválida
devolvía 201 — el control de rol que es el corazón de D-124, abierto en seis lugares.
Corregido moviendo el reloj del negocio a `packages/shared/src/business-date.ts`, un módulo
hoja que no importa nada. Verificado: los 15 schemas retrofechables llevan los dos campos.

**2. `500` en vez de `400` con fechas imposibles (D-130, segunda mitad).** El `.refine` de
calendario —agregado dos horas antes por un hallazgo del auditor— hacía `toISOString()` sobre
un `Invalid Date`. `2026-02-31` se rechazaba bien (rueda al 2 de marzo y el ida y vuelta la
delata), pero `2026-08-32` y `2026-13-01` lanzaban `RangeError` dentro del refine. Corregido con
el guard de `Number.isNaN(getTime())`; las cinco formas de fecha imposible dan 400.

`qa` arregló además `e2e/tests/fase6.spec.ts`, que asumía que un pedido rival a medida chocaba
contra el disponible del producto terminado — con D-127 choca contra la materia prima. Dejó
intacta la mitad que sí prueba la protección y cambió solo el motivo del corte.

**Resultado final: 14/14 de los casos nuevos, y 45/45 del smoke** (fase5a, fase5a-bordes,
fase6, fase6-bordes, fase7e, fase7e-bordes). La suite completa la corre CI.

### Verificación

- `pnpm turbo lint typecheck test build` en verde.
- `pnpm db:migrate` bloqueado por un desvío **preexistente**: la migración
  `20260905150937_fase7b_venta_en_anulacion` fue editada en el commit `9438677` **después** de
  aplicarse a `dev`, así que `prisma migrate dev` exige resetear la rama. No es de esta sesión
  y no bloqueó nada: `pnpm db:deploy` aplica lo pendiente sin ese chequeo, y es lo que se usó
  contra `dev` y contra `demo`. Anotado acá para que la próxima sesión no lo descubra de nuevo.

### Lo que encontró CI, y por qué el smoke acotado no alcanzaba (D-131)

El primer push llegó con la verificación local en verde y **CI falló**: 4 suites, con dos causas
distintas y las dos reales.

**La regresión del mostrador.** Al hacer el subtipo explícito (D-127) reemplacé
`product.unit === MTR` por `roofingKind === A_MEDIDA` **en los dos lugares** donde aparecía, y
eran preguntas distintas: si la línea necesita subítems de largo lo decide la **unidad** y vale
para cualquier línea de negocio (D-083); si se fabrica desde materia prima lo decide el
**subtipo** y es exclusivo de coberturas (D-127). Como el subtipo es `null` fuera de coberturas,
la primera dejó de aplicarse a todo producto en `MTR` de otra línea — y con eso **el mostrador
pasó a poder vender material a medida**, justo lo que D-098 prohíbe. Corregido con dos
predicados separados, `sellsByLength` e `isMadeToMeasure`.

Lo importante no es el defecto sino dónde estaba: en `fase7b-bordes`, el spec del mostrador. El
smoke acotado que corrí (fase5a, fase6, fase7e) no lo incluía porque el mostrador no parecía
tener nada que ver con el subtipo de una cobertura. Es **D-123 otra vez, y esta vez me tocó a
mí**: la única muestra que veía este defecto era la completa.

**Las fechas en UTC.** `todayIso()` del web calculaba "hoy" con el reloj del navegador en vez
del día de Lima; como D-124 pasó a validar contra Lima, un cliente en un huso por delante
prellenaba mañana y recibía "la fecha de operación no puede ser futura" en una operación normal.
Y 16 lugares de `e2e/` armaban fechas con `new Date().toISOString().slice(0, 10)` — el corte en
UTC que D-112 prohibió en el web con una regla de ESLint que **no cubre `e2e/`**. Los tres
arreglados; extender esa regla a `e2e/` queda anotado como riesgo residual.

Al reparar esos 16 lugares me comí un error propio que vale registrar: un `replaceAll` ciego
reescribió el **cuerpo** de tres `today()` locales en `return today()` —recursión infinita— y
encima les agregó el import del helper. Lo delató el primer intento de correr las suites
(`Duplicate declaration "today"`), no una revisión.

**Verificación final: 38/38** en las cinco suites que CI marcó. Seis de esas fallas eran
contaminación de una corrida abortada mía (una caja de mostrador que quedó abierta en `dev`, que
en local **no se vacía** entre corridas: solo CI lo hace); con `E2E_RESET_DB=1` dan 6/6.

### El go-live: reset, deploy y smoke

1. **Producción se cayó a mitad de la sesión** con `{"status":"degraded","db":"error"}`: el API
   vivo tenía la credencial de Neon anterior a la rotación. Se restauró adelantando
   `pnpm secrets:gcp` + `pnpm db:prod` + `pnpm deploy:api` sin esperar a CI (decisión del dueño,
   con nadie operando todavía). `db:prod` no estaba en el plan y era imprescindible: el código
   nuevo lee `operation_date` y `roofing_kind`, y producción seguía con el esquema anterior.
2. **Reset de go-live** (D-129): `AYR_CONFIRM_PROD_RESET=1 node scripts/prod-reset-go-live.mjs
--branch production --yes-destroy production`. Inventario posterior: 0 proveedores, 0
   productos, 0 bobinas, 0 movimientos, 0 documentos, 0 saldos; el único cliente es
   `PÚBLICO EN GENERAL`, que crea el seed para el mostrador.
3. `pnpm deploy:api` con los arreglos de CI.
4. **`pnpm smoke:prod` en verde**: health, login con admin efímero y cinco GET. La primera
   corrida encontró un 400 — en el propio guion, que pedía `/api/catalog/products?page=…`, una
   ruta que nunca existió (el catálogo no pagina, D-113). Corregida a `/api/catalog`.
5. Verificado a mano que los dos triggers de append-only (`inventory_movements`, `audit_log`)
   quedaron **activos** tras el reset: `tgenabled = O` en los dos.

## Sesión 7-final (2026-09-07) — hotfix de unicidad, reserva genérica, importadores y D-122

Cinco milestones en el orden que pidió el dueño (M0 → M1 → M3 → M4 → M2). **Los cinco
implementados.**

### M0 — dos hotfix

- **D-132 — la unicidad del comprobante de compra cuenta solo las compras vivas.** Índice único
  parcial (`WHERE status <> 'CANCELLED'`): anular una compra libera su número para que la
  corregida entre con el mismo que dice el papel. Ruta nueva `PATCH /purchases/:id/document`
  (ADMINISTRADOR, auditada) para corregir el número con sufijo `-R` que el dueño tuvo que
  inventar como workaround. Auditado el mismo patrón en el resto del modelo: no hay otro caso
  (los correlativos fiscales no se reutilizan por diseño y los maestros se reactivan, no se
  re-crean).
- **D-133 — la fecha de emisión: VENDEDOR solo hoy, retrofechar es de ADMINISTRADOR.** Cierra el
  hueco que el auditor había dejado anotado: la ventana de 7 días de SUNAT valía para cualquier
  rol y en los primeros días de un mes alcanzaba para cruzar al mes anterior.

### M1 — reserva genérica de materia prima (D-134..D-136)

- La cotización de coberturas **ya no pide elegir bobina**. Una línea a medida promete kilos
  contra el **agregado compatible** (línea + color + espesor ± tolerancia), que es una fila de
  `raw_material_specs` nueva; `reserveFromCoilId` desapareció del schema, del API y del
  formulario.
- La invariante `disponible ≥ reservado` pasa a comprobarse sobre la **suma** del agregado, con
  guardrail nuevo en los seis puntos que le quitan kilos: salida de kardex, envío a corte,
  montaje en una OP ajena, cierre de bobina, cambio de color y venta de bobina entera.
- Panel de stock en vivo en el formulario (`GET /sales/stock-panel`), de solo lectura, con el
  agregado por espesor + color (kg y metros lineales teóricos) y el disponible por SKU.
- El filtro de material queda escrito como espesor ± tolerancia + **color**; el acabado solo
  aporta densidad (D-135).

### M3 / M4 — los dos importadores del Excel real del negocio (D-137, D-138)

- `COILS_HISTORY`: el Excel de bobinas tal como está. Proveedor auto-creado por RUC contra el
  padrón, con fallback marcado `needs_review` si el padrón no responde; acabado que no mapea
  **no se auto-crea** (se elige del maestro en el preview); dos modos por lote (`REPLAY` con
  reporte de saldo vs objetivo, `ADJUST` con salida de ajuste retrofechada).
- `SALES_HISTORY`: el export de ventas, agrupado por `SERIE - NÚMERO`, reusando
  `FiscalImportService` entero. Cliente auto-creado, SKU no; `DOCUMENTO AJUSTADO` con valor deja
  la fila fuera con el motivo escrito.
- Los dos conviven con los importadores canónicos (RF-12, RF-71) en vez de reemplazarlos.

### M2 — D-122 completo, D-139 y la regla de ESLint que faltaba

- **D-122**: `products.finish_id` nuevo con backfill; el largo de la plancha y el peso por pieza
  pasan al SKU; `coilOptions`/`mountCoil`/el kilo teórico del catálogo/la cola de producción
  leen del producto; `production_orders.bom_id` pasa a nullable y la receta queda **exclusiva de
  drywall** (las de coberturas quedan desactivadas y un `CHECK` impide que vuelva a haber una
  viva).
- **D-139**: `product_boms.kg_per_piece` y `piece_length_mm` se eliminan — el peso y el largo de
  la pieza son del SKU.
- `apps/api/src/sales/raw-material.spec.ts`: 9 tests de la invariante del agregado, que es el
  guardrail más nuevo y el que el compilador no protege (el enum es aditivo).
- La regla de ESLint de D-112 ahora cubre `e2e/` (`eslint.config.mjs` en la raíz, `pnpm lint` la
  corre). Encontró **tres** violaciones reales que habían sobrevivido a la limpieza de D-131.

### Hallazgos de las revisiones, corregidos en la misma sesión

`revisor` (API), `revisor` (web, pasada aparte) y `auditor-seguridad` corrieron en paralelo con
`qa`. **Los cuatro encontraron el mismo bloqueante por caminos independientes**: tras la
migración de D-122, `resolveSalesLines` seguía exigiéndole receta activa a una cobertura, así
que ninguna se podía cotizar. Corregido junto con: la cola de producción que dejaba de ver los
pedidos (`computeQueueStatus` consultaba la receta), las etiquetas vacías de `RAW_MATERIAL` en
cotización y despacho, el guardrail que faltaba al revertir una recepción de corte, el partido
que se rechazaba a sí mismo (el guardrail leía un estado transitorio), un ReDoS medido en
2,7 s/fila al parsear `SERIE - NÚMERO`, una carrera real del ledger que permitía prometer
1.000 kg contra 100 físicos (el guardrail no tomaba lock y competía por filas distintas que el
camino que promete), un `GET` que escribía en la base, la coma decimal que se borraba en
silencio y el flag `needsReview` que nadie leía.

### Los tres defectos que solo vio la corrida de E2E

Ninguna de las tres revisiones estáticas podía verlos; los dos los introdujo el guardrail del
agregado. **`mountCoil` se pasaba del presupuesto de 5 s de Prisma** (`P2028`) contra Neon, de
forma intermitente —que fuera intermitente era la pista de que era presupuesto y no lógica—; se
revisaron además todas las transacciones a las que esta sesión les sumó el guardrail y seguían
con el default (`cutting.send`, `coils.setStatus`, `coils.update`). Y **`GET /sales/stock-panel`
devolvía 500** (`P2023`) para un SKU a medida sin fila de agregado todavía: la spec "virtual" de
la variante de solo lectura tiene el id vacío y llegaba a una consulta que lo parsea como UUID.
Y **un reporte de producción parcial se bloqueaba a sí mismo**: la salida que cumple una promesa
se comprobaba contra lo que resta de esa misma promesa, sobre un agregado cuyo único rollo está
montado en la propia orden. `RecordMovementInput` gana `exceptReservationIds`, la misma
excepción que `mountCoil` ya aplicaba.

### Verificación

`pnpm turbo lint typecheck test build` en verde (266/266 unitarios, incluidos 9 nuevos de la
invariante del agregado). `pnpm format:check` y `pnpm exec eslint e2e` en verde. Seis
migraciones aplicadas a Neon `dev` y `demo`.

**E2E: 84/84 en las doce suites afectadas**, todas corridas en local antes de la revisión del
dueño — `fase7final-m0` (8), `fase7final-m1` (5), `fase6` (5), `fase6-bordes` (7),
`fase4-bordes` (11), `fase7-consolidada` (8), `fase5a` (9), `fase5a-bordes` (10),
`fase5b-bordes` (11), `fase7` (7), `fase7-bordes` (2) y `fase7e-bordes` (1). Nada quedó para
descubrir en CI, que es lo que D-123 pide después de un cambio de regla no aditivo.

### Lo que queda abierto, a propósito

- **La fecha de emisión de una cotización y de un pedido directo no se valida** (ni futura ni
  piso histórico). Es previo a esta sesión y no es fiscal; queda anotado.
- El importador de comprobantes sigue admitiendo hasta 10 años atrás sin pasar por
  `HISTORICAL_LOAD_START` (ya estaba anotado en la sesión anterior).

### Continuación 7-final (2026-09-07) — D-140 resuelto, D-139 ratificada, mensaje diagnóstico

El dueño resolvió los dos puntos que habían quedado abiertos y confirmó el fix pendiente de
diagnóstico:

- **D-140 cerrado: "catálogo siempre a stock".** La producción de una plancha de catálogo
  nunca se liga a un pedido — el pedido reserva producto terminado (D-054/D-088) y, sin stock
  suficiente, espera una corrida a stock. `POST /production/roofing` acepta ahora `productId` +
  `targetPieces` como alternativa a `reservationId` (`RoofingProductionService.createToStock`),
  el mismo patrón que drywall ya tenía para una corrida sin pedido detrás. `/planta` suma la
  tarjeta "Nueva orden de coberturas a stock".
- **D-139 ratificada** sin cambios de código: el peso de pieza terminada sigue siendo el único
  dato del SKU.
- **El mensaje de rechazo al confirmar un pedido ahora nombra la OP** cuando el faltante es
  material montado en producción, en vez de "0.000 físicos menos 0.000 comprometidos" sobre un
  almacén que sí tiene el material (solo que en la roladora). `RawMaterialAvailability` gana
  `mountedKg`/`mountedOrderCodes`; `fase5a-bordes` actualizado al texto nuevo.
- Comentario de defensa en profundidad añadido en `assertReservationInvariant`
  (`reservation-guard.ts`): para un ítem `COIL`, más de un pedido sosteniendo a la vez una
  reserva sobre la misma bobina es hoy inalcanzable (D-116/D-134); sigue siendo el caso normal
  para `PRODUCT`/`RAW_MATERIAL`.

Verificación: `pnpm turbo lint typecheck test build` verde (266/266 unitarios), `pnpm
format:check` y `pnpm exec eslint e2e` verdes. E2E local: `fase5a-bordes` (10/10) y
`fase7final-m1` (5/5). Sin migraciones nuevas. Falta la revisión local del dueño con sus Excel
reales y su caso de compra anulada antes de commit + push + CI + despliegue nocturno.

## Sesión 7-final-B (2026-09-07) — el pedido de un comprobante importado (D-141)

**Estado: implementado y verificado en local; nada commiteado.** Falta la revisión del dueño
con su Excel real (marcar sus pendientes de verdad) antes de push + CI + despliegue nocturno.

### Lo que se construyó

Cada documento que entra por la importación de ventas (D-138) crea ahora **un pedido enlazado
1:1**, y un **toggle por documento** en la previsualización decide de qué clase:

- **ENTREGADO (por defecto) — pedido cáscara.** `FULFILLED`, `origin = IMPORTED`, líneas
  espejo del comprobante, fecha de emisión del papel. **Cero efectos de inventario**: sin
  reserva, sin despacho, sin kardex, sin cola. El bypass es estructural
  (`SalesOrdersService.createImportedShellInTx` no tiene código capaz de escribir una reserva)
  y además se comprueba al terminar (`assertNoInventoryEffects`): si el pedido dejó una
  reserva, una OP, un despacho o un movimiento, la importación entera se deshace.
- **PENDIENTE — pedido vivo + OP automática.** `CONFIRMED`, `origin = IMPORTED`, por el flujo
  normal (`createDirectInTx`, que crea las reservas y comprueba la invariante): línea a medida
  ⇒ reserva **genérica** por agregado (D-134); línea de catálogo ⇒ reserva de producto
  terminado (D-054/D-127). Por cada línea a medida el import crea además la **OP en cola**
  (`DRAFT`) enlazada a la reserva, **sin montar bobina** — montar es del dueño (D-086).

### Piezas nuevas

- **Schema:** enum `SalesOrderOrigin` y `sales_orders.origin` (migración
  `20260907180000_fase7finalb_origen_del_pedido`). El enlace documento↔pedido **no agrega
  columna**: `fiscal_documents.sales_order_id` ya existía desde Fase 5b, y se lee desde los
  dos lados (badge «Importado» y link al comprobante en `/pedidos/[id]`; el link al pedido ya
  estaba en el detalle del comprobante).
- **API:** `PATCH /imports/:id/group` (el toggle del documento, que cambia el comprobante de
  una pieza y revalida el grupo una sola vez); `RoofingProductionService.createFromReservationInTx`
  (la OP nace en la misma transacción que el pedido);
  `SalesOrdersService.createImportedShellInTx` / `archiveImportedOrderInTx`;
  `ImportedDocumentInput.salesOrderId` + `ImportedDocumentLine.salesOrderItemId` (así
  `orderProgress` muestra el pedido importado facturado al 100 %, que es la verdad).
- **Web:** cabecera por comprobante en la previsualización con el toggle y la frase de lo que
  va a pasar; columna opcional `Largos (m x cant.)`.

### Las dos excepciones que la sesión abre, y por qué

1. **`ResolveSalesLinesOptions.allowMissingPieces`**, encendida **solo** en el pedido
   importado. Ningún export de facturación desglosa las planchas de una línea a medida; los
   kilos prometidos no dependen del desglose (`metros × espesor × ancho × densidad`) y el plan
   de corte es una intención que planta corrige (D-084). Con la columna `LARGOS` llena, el
   plan nace completo; sin ella nace vacío.
2. **Un pedido importado se salta `quotation_required` (RF-31)**, porque el compromiso ya se
   tomó y ya se facturó: exigir una cotización previa a una venta que ya ocurrió no protege
   nada. Todo lo demás del camino normal sigue corriendo, empezando por la invariante
   `disponible ≥ reservado`.

### Lo que **no** se hizo, a propósito

- **No hay OP a stock automática** para una línea de catálogo sin stock (D-140). La fila se
  marca con el faltante exacto y ese documento solo entra como ENTREGADO. Las alternativas
  eran inventarle al dueño una corrida que no pidió o romper la invariante del ledger.
- **Pendiente parcial** (media línea entregada) queda fuera de v1.
- No se reconstruyen despachos ni kardex históricos, no se elige bobina concreta en el import,
  no hay estados nuevos.

### Reimportación (D-109 + D-141)

Reimportar archiva el documento **y anula su pedido cáscara**. Si ese pedido está **vivo** con
reservas activas, una OP viva o algún despacho, la reimportación del documento **se bloquea
entera** con el motivo y el código del pedido — archivarlo habría dejado material prometido y
producción en curso sin nadie que los devuelva (la quinta vez que este proyecto se cruza con
la misma lección: D-061, D-088, D-097, D-110). El guardrail vive en `sales` y corre bajo el
mismo `pg_advisory_xact_lock` sobre el número que ya toma `FiscalImportService`; la
previsualización repite solo la lectura, para que se vea antes de confirmar.

### Verificación

`pnpm turbo lint typecheck test build` verde (266/266 unitarios), `pnpm format:check` y
`pnpm exec eslint e2e` verdes. Migración aplicada a Neon `dev`.

E2E nuevo: `fase7finalb-pedido-importado` (**3/3**, local) — documento ENTREGADO ⇒ pedido
cumplido y enlazado con **cero movimientos, cero reservas y cero OP**; documento PENDIENTE a
medida ⇒ pedido confirmado, reserva genérica de 60.000 kg y OP `DRAFT` sin bobina montada, con
su plan de corte; y el mismo documento **sin la columna de largos** —el caso realista, porque
ningún export los trae— que entra igual y deja la orden con el plan vacío. La cadena montar →
drenar → cerrar ya la cubre `fase7final-m1` y no se repite.

**El tercer caso nació de un defecto propio de esta sesión, encontrado antes de correr nada:**
`resolveSalesLines` comprueba que los largos sumen la cantidad de la línea, y con
`allowMissingPieces` una línea sin largos sumaba cero contra sus quince metros — el mismo
rechazo que la excepción existe para evitar, por la puerta de al lado. La comprobación pasa a
correr solo cuando los largos vinieron.

### Suites afectadas: 9 fallas heredadas de la sesión anterior, arregladas

Correr las suites que el cambio podía tocar dejó 9 fallas, **ninguna del cambio de hoy**: son
specs que la sesión 7-final dejó desactualizados con su propio trabajo, todo sin commitear, así
que CI todavía no los había visto. Es la lección de D-123 otra vez —un cambio de regla no
aditivo se verifica contra la suite completa— y esta vez el que la pagó fue el archivo que la
tabla de verificación de aquel handoff no listaba.

- **`fase7-consolidada-subtipo` (5)**: el spec entero seguía escrito para el modelo anterior a
  D-134 (la cotización reservaba `PRODUCT`, el pedido una bobina concreta) y un caso reescribía
  una **receta de coberturas**, que D-122 eliminó. Los cinco casos reescritos; dos de ellos
  probaban un mecanismo que D-134 retiró y se reemplazaron por la regla que prueba lo mismo en
  el modelo nuevo, en los dos sentidos (ver `docs/handoff/fase-7-final-b.md` §4).
- **`fase7c` (2)**: desde D-138 hay dos botones «Importar…» en `/comprobantes` y el localizador
  `name: 'Importar'` resolvía a los dos. Ahora usa el nombre completo.
- **`fase6` (1)**: el mensaje de rechazo de D-140 cambió al resolverse la decisión.
- **`fase5a-bordes` (1)**: **flake, no defecto** — el token de acceso dura 15 min y ese archivo
  tardó 15.1 en la corrida combinada, así que se cayó con un 401 a mitad. Corrido solo, 10/10.
  **Conviene correr las suites en tandas chicas por este motivo.**

### Pulido de la cotización (pedido aparte del dueño)

Los solapes del formulario tenían **una sola causa**: las celdas heredan `whitespace-nowrap`
del componente `Table` (pensado para listados de una línea), así que los renglones de ayuda de
debajo de cada campo —la unidad, el kilo teórico, el precio de lista, los kilos a reservar— no
podían partirse y se desbordaban **pintando encima de la columna vecina**. Corregido con
`whitespace-normal` en esas celdas, los renglones en `block` debajo del campo, y un `min-w` en
la tabla para que en pantalla angosta desplace en vez de aplastar. Además: números a la derecha
con `tabular-nums` (la convención que ya usa el resto de la app), totales en rejilla con el
total destacado, anchos rebalanceados y `align-top`. Sin componentes nuevos, sin cambios de
estructura ni de lógica. Ningún E2E maneja este formulario por navegador, así que el cambio no
tiene riesgo para la suite.

## Sesión 7-final-C (2026-09-07) — CLI de importación de ventas (D-142)

**Estado: implementado y verificado en local con el Excel real del dueño; nada commiteado.**
Falta que el dueño complete el JSON de decisiones (línea de negocio de 40 SKUs, y qué
documentos marcar `pendientes`) antes de `--execute`, push, CI y despliegue.

### Lo que se construyó

`pnpm import:ventas --file <xlsx> [--branch dev|demo] [--decisions <json>] [--execute]`:
dry-run por defecto (sube el archivo con `ImportsService.upload`, nunca confirma) y escribe
un esqueleto de decisiones con lo que el dry-run ya detectó. `--execute` se niega si el JSON
no cubre todos los huecos, aplica las correcciones con `updateRow`/`updateGroup` y confirma —
el mismo servicio y el mismo `SalesHistoryImportAdapter` (D-138/D-141) que usa el botón
«Importar ventas (Excel)» de `/comprobantes`, nunca SQL directo.

- **Fixes de parseo verificados contra el archivo real** (`Ventas Detalladas.xlsx`, 141
  filas / 71 documentos): fechas texto DD/MM/AAAA (ya eran correctas; se agregó el test que
  lo fija con día ≤ 12), números con punto decimal y campos opcionales vacíos (ya eran
  correctos), tipo de comprobante case-insensitive (ya era correcto), cliente
  `"RUC - NOMBRE"` (ya era correcto — pero encontró un bug real de verdad, ver abajo).
  **El único gap real era la unidad**: el archivo trae "METRO LINEAL"/"KILOGRAMO"/
  "UNIDAD"/"TONELADA" y el catálogo usa los códigos UN/EDI (`MTR`/`KGM`/`NIU`/`TNE`);
  `normalizeUnit` (D-142) los mapea. Contra el archivo real: **0 errores de fecha, ninguna
  unidad sin mapear.**
- **Hallazgo real en `parseCustomer`:** la clase de recorte del separador era simétrica
  (`[\s\-–—:.]` al principio **y al final**), así que un nombre que termina en punto
  ("...S.A.C.") perdía el punto al auto-crearse. Solo se manifestaba si el padrón de SUNAT no
  respondía (si responde, el nombre real pisa al del archivo) — un escenario ya documentado
  en el código, nunca antes con un test. El punto ahora solo se recorta del lado izquierdo.
- **Diccionario real de SKUs faltantes: 40** (de 41 productos distintos del archivo; uno,
  `P64GALV045`, ya existe en el catálogo dev). El esqueleto de decisiones sale prellenado con
  código, nombre y unidad detectada por cada uno; el dueño completa `linea` y, para los que
  son Metallic Roofing/Drywall (exigen espesor/ancho/acabado que el export no trae), la
  instrucción del propio JSON sugiere crear el producto a mano y usar `"mapear"`.
- **OP a stock consolidada (enmienda a D-140), sin tocar la invariante `disponible ≥
reservado`:** una línea de catálogo pendiente sin stock sigue entrando **solo como
  ENTREGADO** (igual que D-141); el CLI, aparte, suma el déficit de todas las líneas
  pendientes de ese producto en el lote y crea **una** `RoofingProductionService.create`
  a stock por el total, sin ligarla a ninguna reserva — un adelanto de producción para la
  próxima carga, no un desbloqueo de esta. `data.catalogAvailableQty` (nuevo, en el
  adaptador) es lo que hace que el CLI no tenga que releer la disponibilidad.
- **`import_batch_id`** (migración aditiva `20260907190000_fase7finalb_import_batch_id_ventas`,
  nullable en `fiscal_documents`, `sales_orders`, `reservations`, `production_orders`,
  `customers` y `products`): el CLI lo estampa **después** de que el servicio ya creó cada
  fila (documentos/pedidos/reservas/OP en cascada desde el documento — D-141 es 1:1, así que
  todo lo que cuelga de un documento del lote es del lote; clientes y SKUs con un snapshot de
  antes de confirmar, porque a esos si puede haberlos creado una corrida anterior).
- **`purge-imported-sales.ts --batch=<uuid>`**: la misma herramienta de siempre, acotada a un
  lote. Dos guardas nuevas sobre las siete que ya tenía: una OP del lote (en cola **o a
  stock**) fuera de DRAFT/CANCELLED-sin-montar aborta todo; un cliente o SKU del lote que algo
  **de afuera** ya haya usado se conserva y se reporta, nunca se borra a ciegas.

### Un problema de herramientas que no era del dominio: `tsx`/esbuild y la metadata de Nest

El CLI reusa `ImportsService` completo a través de un contexto de Nest standalone
(`NestFactory.createApplicationContext`), y la primera corrida con `tsx` fallaba **en
silencio** — `process.exit(1)` sin una sola línea de error, ni con `.catch()`, ni con
`process.on('uncaughtException', ...)`. Con el logger de Nest encendido apareció la causa
real: `UndefinedDependencyException` en `AuthService` — esbuild (el transpilador de `tsx`) no
emite `emitDecoratorMetadata` de forma confiable en un grafo de dependencias con referencias
circulares de tipos, y Nest no puede resolver el primer argumento del constructor. `nest
build` no sirve (`tsconfig.build.json` excluye `prisma` a propósito). Solución: un
`tsconfig.cli.json` propio que compila el CLI con `tsc` real — el mismo compilador que ya usa
`typecheck` — a `dist-cli/`, y el wrapper (`scripts/import-ventas.mjs`) lo compila antes de
cada corrida y ejecuta el JS resultante con `node` liso. Quedó documentado en el propio
`tsconfig.cli.json` para que nadie vuelva a intentar `tsx` acá y pierda una hora en el mismo
silencio.

**Segundo hallazgo de herramientas, más chico:** `spawnSync('node', args, {shell: true})` en
Windows le comía el espacio de "Ventas Detalladas.xlsx" (`cmd.exe` repartía la ruta en dos
argumentos). `node` es un binario real, no un shim `.cmd`; sin `shell: true` el array de
argumentos llega intacto. Y las rutas de `--file`/`--decisions`/`--out` se resuelven en el
wrapper contra el directorio **desde el que se invocó** `pnpm import:ventas`, no contra
`apps/api` (el `cwd` del proceso hijo) — si no, una ruta relativa apuntaba al lugar
equivocado y el archivo "no existía".

### Lo que no se hizo, a propósito

- **No se corrió `--execute`.** El dry-run local con el Excel real es la verificación de esta
  sesión; `--execute` lo corre el dueño después de completar el JSON de decisiones.
- **No se creó ningún SKU en el catálogo.** El diccionario de 40 faltantes queda en el JSON
  prellenado, sin tocar `dev` más allá de la migración (aditiva) y los lotes `PARSED` que el
  dry-run dejó (inertes: no tocan ninguna tabla de negocio, igual que dejaría la
  previsualización web sin confirmar).
- No se tocó `SalesHistoryImportAdapter.createGroup` ni ninguna de las siete adaptadores de
  `ImportsModule`: el estampado de `import_batch_id` es enteramente del CLI, por fuera de la
  transacción de confirmación (una actualización de metadato sobre lo que el servicio acaba
  de crear, nunca una decisión de negocio).

### Dos ajustes de la revisión del dueño, antes de correr nada de verdad

**`--branch production` con `--confirm-production` (pedido explícito del dueño).** La primera
versión del wrapper rechazaba `production` de plano. El dueño pidió en cambio que `production`
sea una rama válida pero que `--execute` contra ella exija además `--confirm-production` (el
dry-run no, porque solo sube y valida). Aplicado a `import-ventas.mjs` y, para `--batch`, a
`prod-purge-imported-sales.mjs` — la purga general (sin `--batch`) queda como estaba, sin
pedir el flag nuevo. Verificado que las tres combinaciones (sin flag aborta, con flag pasa el
gate, `--batch` sin flag aborta) hacen lo que dicen.

**Un SKU que no se puede `"crear"` ya no tira abajo el lote entero.** El plan del dueño era
completar con espesor/color solo los SKUs de coberturas que estén en `pendientes[]`, y dejar
el resto con los datos mínimos del archivo. Eso rompía contra el diseño original: la primera
vez que `catalog.create` fallara (falta de campos estructurados, lo esperable en Metallic
Roofing/Drywall) abortaba **todo** el `--execute` antes de tocar un solo documento, sin
importar cuántos otros SKUs sí se hubieran resuelto bien. Corregido para que un SKU fallido
solo deje sin resolver las filas que lo usan (conservan el error original de "no existe el
producto", que ya hace que `confirmGroups` salte ese documento) — el resto del lote sigue su
curso, igual que cualquier otro documento con un error de validación. El resumen final ahora
lista los SKUs que fallaron para que quede claro cuáles documentos se excluyeron y por qué.

### Verificación

`pnpm turbo lint typecheck test` verde (286/286 unitarios, +20 nuevos en
`sales-history.adapter.spec.ts`), `pnpm format:check` y `pnpm exec eslint e2e` verdes.
`nest build` (compilación real de `src/`) verde; `prisma generate` tuvo un `EPERM` de Windows
intermitente (`query_engine-windows.dll.node` bloqueado por otro proceso del sistema, no
relacionado con este cambio — ver "Notas operativas"), sin volver a fallar tras confirmar que
`tsc --noEmit` y `nest build` ya pasaban limpios por separado. Migración aplicada a Neon
`dev`.

Dry-run contra `Ventas Detalladas.xlsx` (real, 141 filas / 71 documentos: 119 Factura, 20
Boleta, 2 líneas de 1 Nota de Crédito): 71 documentos leídos, 1 excluido por ser nota de
crédito (con el motivo), 40 SKUs faltantes detectados y volcados al JSON prellenado, **0
errores de fecha, ninguna unidad sin mapear**. El resto de los documentos (68) quedan
`INVALID` únicamente por SKU faltante — el estado esperado hasta que el dueño complete el
diccionario; no es una falla de la herramienta, es exactamente lo que el dry-run existe para
mostrar antes de tocar nada.

### Despliegue a producción y el backfill de D-122 que faltaba (mismo día, con autorización explícita del dueño)

Con luz verde del dueño se corrió, en este orden: commit + push (CI verde, 25 min), `pnpm
db:prod` (sin migraciones pendientes — production ya estaba al día, incluida D-142) y `pnpm
deploy:api`.

**Antes de `smoke:prod`, el chequeo de "cero bobinas sin finish_id" que el dueño pidió
encontró 55 de 56 productos de Metallic Roofing con `finish_id = NULL`.** No era un caso
aislado: era casi todo el catálogo real de coberturas. Causa: el backfill de D-122 copia
`finish_id` desde la receta (`product_boms`) **activa** de cada producto, y estos 55 se
crearon hoy mismo por el dueño, a través del catálogo, **antes de que este mismo deploy
subiera el código de D-122** (que es el que exige `finish_id` en `CatalogService.create`)
— con la API de producción corriendo la revisión anterior, nada se lo pedía. `COB028ROJO`
es el único con `finish_id` porque es el único que tenía una receta activa de la que el
backfill pudo copiarlo (un vínculo fleje→perfil de un flujo más viejo); su propio
`audit_log` no muestra `finishId` en el `after` de su creación, consistente con que se creó
bajo el código anterior.

**Reparado con autorización explícita, mismo día, sin esperar aprobación línea por línea:**
cada uno de los 56 productos ya tenía `colorId` correcto (estructurado, no texto libre), así
que el mapeo color → acabado salió de ahí y no de heurística de nombre — más confiable que
parsear el SKU. AZUL/BLANCO/GRIS/NATURAL tienen una sola opción de acabado (confianza ALTA,
35 productos); ROJO tiene dos variantes RAL y se usó la que ya estaba cargada en `COB028ROJO`
como precedente (confianza MEDIA, 13 productos); VERDE tiene dos variantes sin ningún
precedente en la base, elegida arbitrariamente (confianza BAJA, 7 productos — **el dueño
debería revisar estos 7 por UI**: `COB025VERDE`, `COB030VERDE`, `COB035VERDE`, `COB040VERD`,
`COB040VERDE`, `COB045VERDE`, `COB050VERDE`, todos con `ALZ-VERDE-6002`). Aplicado vía
`CatalogService.update` (audita, corre `assertStructuredFields` y `assertNoLiveRoofingOrders`
— nunca SQL directo): **55 de 55**. Verificado después: **0 productos de Metallic Roofing sin
`finish_id`** en producción. El `pendientes[]` del JSON de decisiones estaba vacío en ese
momento, así que la excepción que pidió el dueño (no tocar sin confirmar los SKUs que
terminen en un documento pendiente) no tuvo ningún caso que aplicar — queda anotado para la
próxima vez que se recalcule `pendientes[]` con datos reales.

**Ticket 7f (registrado, no implementado esta sesión): la creación y la importación de
Metallic Roofing deberían exigir `finish_id` de forma más visible, no solo por el `throw` de
`assertStructuredFields`.** El código ya lo exige desde D-122 (por eso el problema fue de
_despliegue_ — código viejo corriendo contra catálogo nuevo — y no de una brecha en la
validación de hoy en adelante); lo que falta es blindar el camino de **datos existentes que
llegan sin pasar por el formulario** (una importación masiva futura, una migración de otro
sistema) con el mismo `check-roofing-catalog.mjs` que ya existe para D-127, extendido a
`finish_id`. Anotado para Fase 8, no urgente: el catálogo real ya quedó limpio.

### La ejecución real destapó un segundo defecto, ajeno a los SKUs: la tolerancia de "no cuadra" (D-142)

El primer `--execute` del dueño contra producción (`pendientes[]` vacío, todo cáscara)
confirmó 52 de 71 documentos. Los 19 restantes: 1 nota de crédito (esperado) y **18 por un
`BadRequestException` de `FiscalImportService.resolveTotals`** — una capa de validación que
solo corre al confirmar, invisible para el dry-run. Compara el total recalculado (`qty ×
unitPricePen × IGV`, D-003) contra el declarado con una tolerancia de **un céntimo por
línea** (`totalTolerance`), calibrada para RF-71, donde el importe de cada línea ya viene
impreso y redondeado del papel. Acá el precio unitario **se deriva** (VALOR DE VENTA /
CANTIDAD, D-138), y ese redondeo compuesto se acumula más — los 18 diffs reales fueron de
0.02 a 0.21 soles, evidentemente redondeo del propio Excel, no errores de captura.

**Arreglado con una sola fuente de verdad, pedida explícitamente por el dueño**:
`SALES_HISTORY_TOTAL_TOLERANCE_PEN = '0.25'` en `imports/fiscal-import-math.ts` (peor caso
real 0.21 + margen chico), que lee tanto `SalesHistoryImportAdapter.validateGroup` (avisa)
como `FiscalImportService.resolveTotals` (rechaza, vía el nuevo campo opcional
`ImportedDocumentInput.totalTolerancePen`) — antes eran dos números independientes y ahora es
uno solo. RF-71 sigue con su `totalTolerance` de un céntimo por línea, intacta. Tests nuevos
en `fiscal-import-math.spec.ts` y `sales-history.adapter.spec.ts`: el peor caso real (0.21)
pasa, un desvío mayor (0.30) falla, y un canario dinámico que compara contra el valor real
de la constante — si algún día alguien pone un número a mano en vez de leerla, ese test es
el que revienta primero. `pnpm turbo lint typecheck test` verde (293/293), `dist-cli`
recompilado.

**Aviso operativo: el API desplegado en producción todavía corre el umbral viejo (1
céntimo/línea) hasta el próximo `deploy:api`.** El CLI (`dist-cli`, recompilado en esta
sesión) ya tiene el fix y lo usará en el próximo `--execute`; la previsualización web
(`/comprobantes` → «Importar ventas») seguiría rechazando al confirmar lo mismo que hoy
rechazó el CLI, hasta que el deploy de cierre de esta sesión suba el código nuevo. No es un
problema mientras el dueño siga operando por CLI contra este mismo commit.

**Reversa del primer intento:** los 52 documentos que sí habían confirmado (batch
`60bc83ca-3354-4a6c-a5c6-67cbbd2da92c`) se revirtieron con `purge-imported-sales.ts
--batch=<id> --execute --confirm-production` antes de este fix — 52 `fiscal_documents`, 52
`sales_orders`, 101 líneas, cero reservas/OP (todo cáscara). Verificado post-purga: cero
residuo del lote. El dueño está completando `pendientes[]` a mano en el JSON antes del
próximo `--execute`.

### Vuelta atrás completa del segundo ensayo (lote `d4282f5c-...`) y limpieza de la noche (2026-09-08)

El dueño pidió descartar **todo** lo del ensayo de esa noche por flujo normal, nunca
forzando guardas. El lote `d4282f5c-8145-47da-baaf-0b5dafa8e013` (62 documentos/pedidos, 23
reservas, 20 OP) no era "cáscara pura": 3 OP (seq 5, 6, 21) habían llegado a montar bobinas
reales y reportar planchas reales antes de que el dueño decidiera revertir. El primer
dry-run del purge lo confirmó bloqueado (guardas 1/2/3 de `purge-imported-sales.ts`).

**Reversa por flujo normal, no por SQL:** las 3 OP se revirtieron con
`RoofingProductionService.reverseReport` (los reportes ACTIVE más recientes primero) +
`.cancel` (libera las bobinas montadas automáticamente, D-066), vía un CLI standalone
temporal con el mismo patrón de contexto de Nest que D-142. Consumos en `0 kg`, reservas
restauradas a `ACTIVE`. Aun así, el purge seguía bloqueado: **la guarda "bobina montada
alguna vez" es incondicional** — no importa que la reversa esté completa, el hecho
histórico de haber montado una bobina real no se borra nunca. Es diseño, no un estado
corregible.

**`purge-imported-sales.ts` se extendió con `--exclude-touched` (D-143/D-142-ii)** para
cubrir justo este caso: excluye del borrado físico al pedido dueño de una OP tocada (vía su
reserva) en vez de abortar el lote entero. Dry-run confirmó 60 pedidos/comprobantes a
borrar y 2 excluidos (pedido **80**, dueño de las OP 5 y 6; pedido **131**, dueño de la OP 21) — ambos con factura `ACCEPTED` real (`FFA1-00001354`, `FFA1-00001407`). Ejecutado
`--execute --confirm-production`: **60 `fiscal_documents`, 60 `sales_orders`, 121 líneas, 17
reservas, 17 OP borrados físicamente. Cero clientes/SKU afectados** (el lote no creó
ninguno que no existiera ya). Verificado post-purga: `origin = IMPORTED` en producción quedó
en exactamente 2 (los pedidos 80 y 131, intactos, sin tocar de ninguna otra forma). **Los
pedidos 80 y 131 existen hoy en producción porque su producción fue real** (bobinas
montadas y planchas reportadas, luego revertidas) y la herramienta de purga no borra eso
nunca — no porque falte hacer algo más con ellos.

**Hallazgo aparte, no relacionado al CLI de importación: datos de ensayo `CREATED_HERE`
de la misma noche.** Al revisar qué más había en producción sin ser del lote, aparecieron 7
cotizaciones (6 de "TEXAS CITY SELVA S.A.C.", 1 de "3AAMSEQ S.A.") y 2 pedidos directos
(seq 1 CANCELLED, seq 134 IN_PRODUCTION) creados a mano esa misma noche, ajenos al CLI.

- **Cotizaciones:** borradas físicamente por un script puntual con guarda (bloquea si algún
  `sales_orders.quotation_id` la referencia, de cualquier estado — la FK lo rechazaría
  igual). **5 de 7 borradas** (seq 1, 2, 3, 5, 6). Excluidas: seq 4 (la referencia el pedido
  1, CANCELLED) y seq 7 (la referencia el pedido 134, **vivo**).
- **Pedido 134** tenía una factura real emitida, `F001-00000001` (FACTURA, `ISSUED_HERE`,
  `SEND_ERROR`) — tomó correlativo pero el envío nunca se confirmó. Se consultó su estado
  real al PSE (`InvoicingService.refreshStatus`, solo lectura del lado de SUNAT) antes de
  tocar nada: **SUNAT la rechazó** (`rejectionCode 400`, "la fecha del documento debe ser la
  fecha de HOY" — se emitió con la fecha de ensayo, no la de hoy). Nunca fue un documento
  vigente; el correlativo `F001-00000001` queda quemado (no se reutiliza), pero sin ninguna
  obligación fiscal detrás.
- Con la factura confirmada como no vigente, se revirtieron por flujo normal las OP 28
  (CLOSED → `reopen` deshace el cierre → `reverseReport` → `cancel`) y 29 (`reverseReport` →
  `cancel`) del pedido 134.
- **Pendiente de decisión del dueño, sin tocar:** el pedido 134 en sí (sigue
  `IN_PRODUCTION` — sus OP ya están anuladas, sólo falta `SalesOrdersService.cancel` si se
  quiere anular también el pedido), la factura `F001-00000001` (queda `REJECTED`, registro
  histórico del intento — no hay un camino de "anular" para un `REJECTED`, y borrarla no fue
  parte de lo pedido), la cotización 7 (bloqueada mientras el pedido 134 exista) y el pedido
  1 (bloquea la cotización 4).

**Limpieza de archivos.** Los tres archivos de datos reales del ensayo (`Ventas
Detalladas.xlsx` y sus dos `.decisiones.json`) vivían sueltos en la raíz del repo —
ignorados por `.gitignore` desde D-142, nunca llegaron a commitearse, pero sueltos igual.
Se movieron a `local-data/` (carpeta nueva, ignorada por completo) y `.gitignore`/`CLAUDE.md`
quedaron con la regla explícita: los archivos de trabajo de una importación real viven ahí,
nunca en la raíz. No quedó ningún script de un solo uso en el repo: los CLI temporales de
esta noche (reversas de OP, refresh de PSE, purge de cotizaciones) se escribieron, corrieron
y borraron dentro de la misma sesión — nada que archivar en `scripts/oneoff/`.

**Nada más se tocó.** Sin reimport, sin otros fixes, sin más commits que el de cierre de
esta limpieza — a la espera de un nuevo plan del dueño para el pedido 134 y lo que queda
pendiente de él.

### Descarte total de los pedidos 80 y 131 — reversa por flujo normal, después purge físico (2026-09-08)

El dueño pidió el inventario de los pedidos 80 y 131 antes de ejecutar nada. Resultado:
ningún despacho, ningún cobro, ninguna nota de crédito, ningún movimiento de kardex que
referenciara los documentos directamente en ninguno de los dos pedidos — solo las reservas
de materia prima `ACTIVE` que ya habían quedado de la reversa de las OP 5/6/21, y las dos
facturas `FFA1-00001354` (pedido 80, S/ 15,840.00) y `FFA1-00001407` (pedido 131, S/
230.40), ambas `ACCEPTED`, `origin = IMPORTED`.

**Reversa por flujo normal, en el orden pedido:** sin despachos que revertir, se fue directo
a `FiscalImportService.annulImported` (D-110 — baja **interna**, el PSE nunca conoció estos
documentos, D-105) sobre las dos facturas, y `SalesOrdersService.cancel` sobre los dos
pedidos (libera solo las reservas `ACTIVE` que quedaban). Resultado: pedidos 80 y 131
`CANCELLED`, facturas `ANNULLED`, las 6 reservas de ambos pedidos `RELEASED` con `qty=0`.

**`purge-imported-sales.ts` ganó `--include-reverted` (D-143), que necesita
`--exclude-touched`.** No afloja la guarda del historial de montaje — la verifica: promueve
al borrado físico solo el pedido excluido que cumple las cinco condiciones a la vez (pedido
`CANCELLED`, comprobante `ANNULLED`/`VOIDED`/`REJECTED`, reservas `RELEASED`, OP
`CANCELLED`, y **cada movimiento de kardex de sus reportes con su reversa presente**,
releído directo de `inventory_movements` en vez de confiar en `production_reports.status`).
Dry-run confirmó las cinco condiciones para los dos pedidos, sin ningún motivo de bloqueo.
Ejecutado `--execute --confirm-production`: **2 `fiscal_documents`, 2 `sales_orders`, 3
`sales_order_items`, 6 `reservations`, 3 `production_orders`, 8
`production_order_consumptions`, 9 `production_reports`, 3 `fiscal_document_items`
borrados físicamente.**

**Verificación final:**

- `origin = IMPORTED` en producción: **0 comprobantes, 0 pedidos.** El lote `d4282f5c-...`
  no dejó ningún rastro.
- Kardex cuadrado: las 6 bobinas que tocaron las OP 5, 6 y 21 tienen hoy un saldo **igual a
  su peso nominal** (4755, 4549, 3348, 3468, 3470 y 3480 kg) — cero kilos netos consumidos
  por todo el ensayo, de punta a punta.
- Producción real hoy: 2 `users`, 49 `customers`, 174 `products`, 50 `coils`, 9 `finishes`,
  **2 `sales_orders`** (seq 1 `CANCELLED`, seq 134 `IN_PRODUCTION` — sin tocar, ver abajo),
  **2 `quotations`** (seq 4 `CANCELLED`, seq 7 `CONFIRMED` — sin tocar), **1
  `fiscal_document`** (`F001-00000001`, `REJECTED`, correlativo quemado — SUNAT nunca lo
  aceptó, ver la sección de arriba), **3 `production_orders`** (las dos del pedido 134 más
  una fuera de este ensayo).

**Pendiente, sin tocar (fuera de alcance de este pedido — solo cubría 80 y 131):** el pedido
134 sigue `IN_PRODUCTION`, no anulado; su factura sigue `REJECTED`; la cotización 7 sigue
bloqueada por el pedido 134 vivo, y la cotización 4 por el pedido 1. Falta un nuevo plan del
dueño para esos cuatro.

### Limpieza final: borrado físico de lo último que quedaba del ensayo (2026-09-08)

Inventario pedido antes de tocar nada: cotización 4 (`CANCELLED`) y cotización 7
(`CONFIRMED`); pedido 1 (`CANCELLED`) y pedido 134 (`IN_PRODUCTION` — nunca se había anulado
del todo, con una reserva de materia prima **`ACTIVE` de 3193.862 kg** todavía viva sobre la
OP 29); la factura `F001-00000001` (`REJECTED`, sin cobros, sin notas de crédito); las OP 1
(del pedido 1), 28 y 29 (del pedido 134), las tres `CANCELLED` con sus reportes `REVERTED` y
sus consumos liberados. Cero despachos en ningún pedido.

**Reversa pendiente, por flujo normal:** el pedido 134 nunca se había anulado —
`SalesOrdersService.cancel` lo dejó `CANCELLED` y liberó esa última reserva `ACTIVE` (bajó a
`RELEASED`, `qty=0`). Con eso, los dos pedidos y todo lo suyo quedaron limpios para el
borrado físico.

**Borrado físico por script puntual con guardas** (mismo patrón que las cotizaciones TEXAS
CITY y que D-144: sin despachos, sin cobros vigentes, sin notas de crédito, pedidos y OP
`CANCELLED`, y cada movimiento de kardex de los reportes con su reversa presente, releído
del propio kardex). Sin bloqueos. Ejecutado en una sola transacción: **2 `sales_orders`
(seq 1, 134), 1 `fiscal_document` (`F001-00000001`), 2 `quotations` (seq 4, 7), 6
`reservations`, 3 `production_orders` (seq 1, 28, 29), 3 `production_reports` borrados
físicamente.** La factura `REJECTED` se borró porque nunca fue un documento vigente (SUNAT
la rechazó, D-105 dice que el PSE nunca la conoció como propia) — su correlativo
`F001-00000001` sigue quemado para siempre, no se recupera (mismo criterio que la
numeración de Fase 5b): la próxima factura real de `production` empieza en `F001-00000002`.

**Verificación final — producción quedó exactamente en:** `quotations = 0`,
`fiscal_documents = 0`, `sales_orders = 0`, `reservations = 0`, `production_orders = 0`,
`production_reports = 0`, `dispatches = 0`. Lo único que queda es lo estructural: 2 `users`,
49 `customers`, 174 `products`, 50 `coils`, 9 `finishes`, 6 `colors`, 5 `business_lines` —
seed + catálogo + bobinas + acabados. Las 7 bobinas que tocó el ensayo de punta a punta
(incluida la de la OP 29) tienen su saldo exactamente igual a su peso nominal: cero kilos
netos consumidos por toda la noche.

Con esto, el ensayo del 2026-09-07/08 no dejó **ningún** rastro en `production` salvo el
correlativo quemado de `F001-00000001` (documentado acá, irreversible) y las herramientas
que quedaron (`--exclude-touched`, `--include-reverted`, D-143/D-144) para la próxima vez
que algo similar haga falta revertir.

## Sesión de estabilización (2026-09-08) — M0: la OP de coberturas a stock estaba rota en la base (D-145)

**Síntoma:** `POST /api/production/roofing` con `productId` + `targetPieces` (la orden a
stock de D-140, la que ofrece `/planta` y la que arma el CLI de importación de D-142)
devolvía **`500 Internal server error`**, sin ningún mensaje. No había repro documentado.

**Reproducido en local (Docker, base `ayr_local_e2e`) antes de tocar código.** El error real,
que el 500 tapaba:

```
PrismaClientUnknownRequestError en tx.productionOrder.create()
  roofing-production.service.ts:318
PostgresError 23514: new row for relation "production_orders"
  violates check constraint "production_orders_roofing_contra_pedido"
```

**Causa raíz, y una segunda que la primera destapó:**

1. **El `CHECK` de Fase 6 nunca se actualizó.** `production_orders_roofing_contra_pedido`
   (migración `20260904180000_fase6_coberturas_color`, D-084) exige `reservation_id IS NOT
NULL` en toda OP `ROOFING`. D-140 —resuelta un día antes por el dueño— introdujo
   `createToStock`, que crea exactamente eso: una OP `ROOFING` **sin reserva**. El código
   nuevo y la base quedaron diciendo cosas opuestas.
2. **`createToStock` no guardaba `targetPieces`.** Lo valida (`create` falla sin él) y lo
   audita, pero no lo pasaba al `data` del `create` — drywall sí lo hace desde D-048
   (`production.service.ts:291`). Se vio recién al aplicar el fix del constraint: el insert
   seguía fallando porque `target_pieces` llegaba `null`. Además de romper D-145, dejaba
   `/planta` y `/produccion` mostrando «Meta: —» en la única clase de orden que la tiene por
   definición.

**Por qué llegó desplegado sin que nadie lo notara.** Los unitarios de `production` son de
aritmética pura (Prisma mockeado: un `CHECK` de la base les es invisible), y el E2E de Fase 6
cubre el **rechazo** de D-140 (`fase6.spec.ts`, «plancha de catálogo: se vende de stock y
producirla contra el pedido no tiene ruta») y **se detiene en la frase que nombra la salida**
—"producí una orden a stock desde planta"— sin recorrerla nunca. La mitad prohibida estaba
probada; la mitad permitida, no.

**Arreglo (D-145).** Migración
`20260908150000_d145_allow_roofing_production_order_to_stock`: el constraint pasa a
`production_orders_roofing_contra_pedido_o_a_stock`, con forma `kind <> 'ROOFING' OR
reservation_id IS NOT NULL OR target_pieces IS NOT NULL` — conserva la garantía de D-084 (una
OP de coberturas nunca es huérfana) admitiendo las dos formas legítimas de nacer. Más el
`targetPieces: input.targetPieces` que faltaba. **No se tocó el kardex ni
`InventoryService.record`**: el resto del ciclo a stock (`mountCoil`, `report`, `close`,
`reverseReport`, `cancel`) ya trataba `reservationId` como opcional y no necesitó un solo
cambio.

**Regresión, roja antes y verde después:** `e2e/tests/fase7final-op-a-stock.spec.ts`, 2 casos
— el ciclo completo a stock (crear sin reserva → montar → rolar 5 planchas de 4 m = 80 kg →
cerrar con 3 kg de despunte → kardex `IN:PURCHASE`/`OUT:PRODUCTION`/`OUT:SCRAP`) y la
cobertura a medida, que sigue sin camino a stock. El caso del ciclo **verifica lo que D-140
decidió**: sin pedido detrás no hay promesa que trasladar (D-088), así que las planchas entran
como **saldo libre** (`reservedQty = 0.000`, `availableQty = 5.000`) y el pedido de catálogo
que esperaba puede reservarlas después.

Verificado: `pnpm turbo lint typecheck test` verde (293/293) y `pnpm e2e fase6 fase6-bordes`
verde (12/12), sin regresiones.

### M1 — la tolerancia de reserva de MP ya estaba en `main`; queda el checklist de deploy

**Verificado, no construido.** La tolerancia de espesor (±0.02 mm) y la igualdad estricta de
color del agregado genérico de materia prima (D-134) ya estaban commiteadas en `main` — el
último commit que las tocó es `8bfa5bb`. Cobertura:

- **Unit**: `roofing-math.spec.ts` fija el borde exacto (0.32 y 0.28 pasan contra 0.30; 0.33
  no) y `raw-material.spec.ts` comprueba que el agregado suma bobinas de 0.44 y 0.46 para una
  spec de 0.45 y descarta las de otro color. `ROOFING_THICKNESS_TOLERANCE_MM = '0.02'` vive en
  `@ayr/shared` con override por entorno (`ROOFING_THICKNESS_TOLERANCE_MM`).
- **E2E**: `fase7final-m1` (5/5) y `fase6-bordes` caso 1 (filtro por espesor/color/estado).

**Smoke contra Docker, sobre el artefacto compilado.** `pnpm build` verde, y después la suite
`fase7final-op-a-stock` + `fase6` corrida con `CI=true` contra el Postgres de Docker — que es
lo que hace que Playwright levante `node dist/main.js` + `next start` en vez de `nest start`,
o sea **la misma forma que corre en Cloud Run**: **14/14 verdes**.

**No se desplegó nada.** Checklist listo para cuando el dueño dé el OK:

```bash
# 1. Todo verde y commiteado, CI verde en GitHub Actions (D-123)
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e

# 2. Migración primero, y esta vez el orden SÍ es seguro (ver abajo)
pnpm db:prod            # aplica 20260908150000_d145_... (y lo que production tenga pendiente)

# 3. API
pnpm deploy:api

# 4. Web: por push a main (la integración Vercel-GitHub). `pnpm deploy:web` sigue
#    necesitando que el dueño corra `vercel login`: el token del CLI está vencido.

# 5. Verificación post-deploy, solo lectura (D-126). NUNCA pnpm e2e:prod (regla dura 9)
pnpm smoke:prod
```

**Por qué esta vez el orden sí es seguro,** a diferencia del aviso de la sesión anterior: la
migración de D-145 **afloja** un `CHECK`, no lo endurece ni cambia ninguna columna. El API
viejo corriendo contra la base ya migrada sigue funcionando exactamente igual (nunca intenta
insertar una fila que el constraint nuevo rechace y el viejo aceptara), así que no hay ventana
de incompatibilidad entre el paso 2 y el paso 3. No hace falta que nadie deje de operar.

### M2 — ensayo de recarga de agosto en `demo`: parado por decisión del dueño

**Paso 0 hecho.** `demo` estaba **3 migraciones atrasada** respecto de `main`:
`20260907180000_fase7finalb_origen_del_pedido`, `20260907190000_fase7finalb_import_batch_id_ventas`
y `20260908150000_d145_...` (el fix de M0). Las tres aplicadas con `pnpm db:demo` (migrate
deploy + purga de sesiones heredadas + seed del admin de demo). Sin incidentes.

**Inventario de `demo` antes de tocar nada** (solo lectura). Demo es el clon de production al
2026-09-06, o sea **de antes** de la limpieza del ensayo, así que arrastra todo el residuo E2E
que production tenía entonces: 1 985 bobinas (1 927 `CANCELLED`, 48 `OPEN` con 120 729 kg de
saldo), 1 617 productos (mayoría `BOBE2E…`/`IMP-OK-…`/`SKU-…`), 968 acabados, 1 070
proveedores, 6 836 movimientos de kardex, 219 pedidos (215 `CANCELLED`), 2 comprobantes
`DRAFT`. **Si el ensayo se retoma, conviene rehacer `demo` desde `production`** (que hoy sí
está limpia) antes de cargar nada — el procedimiento está en `docs/ENTORNOS.md`.

**Dry-run de ventas contra `demo`** (`Ventas Detalladas.xlsx`: 141 filas, 71 documentos,
03/08/2026 → 31/08/2026 — es el archivo de agosto). Resultado: **40 SKUs faltantes** (los
mismos 40 del ensayo anterior: demo no tiene los 55 productos de Metallic Roofing que el dueño
creó en production el 07-09, posteriores al clon), **ninguna unidad sin mapear**, y 1 nota de
crédito excluida con su motivo (`FFC1-73`). Ningún documento se confirmó: el dry-run no
escribe negocio.

**No se ejecutó la importación y no se va a reimportar** — decisión del dueño en el chat.
La mitad de bobinas del ensayo tampoco se corrió: **no existe ningún archivo de bobinas de
agosto** en `local-data/`, solo el de ventas.

#### Incidente: el dry-run pisó el archivo de decisiones del dueño

Correr el dry-run con `--decisions "local-data/Ventas Detalladas.decisiones.json"` —la forma
natural de preguntar "con mis decisiones puestas, ¿qué falta?"— **borró ese mismo archivo**:
el esqueleto que el dry-run escribe va, por defecto, a `<archivo>.decisiones.json`, que es
exactamente el nombre que el dueño usa para el suyo. Se perdieron las **40 líneas de negocio**
asignadas SKU por SKU y la lista de **23 comprobantes marcados como pendientes**. No estaba en
git (`local-data/` es ignorada por completo, D-142) ni en `dev` (los 40 SKUs no existen ahí).
El dueño decidió rehacerlo a mano en vez de autorizar una lectura de `production` para
recuperarlo.

**Arreglado para que no pueda repetirse** (`apps/api/prisma/import-ventas-cli.ts`,
`safeScaffoldPath`): el dry-run **nunca pisa un archivo que ya existe**. Sin `--out`, si el
destino por defecto existe, no escribe nada y lo dice. Con `--out` explícito manda quien lo
escribe, salvo que apunte al mismo archivo que `--decisions`, que ahora aborta con el motivo.
Es la misma clase de defecto que D-128: una herramienta que hace algo destructivo por defecto
en el camino más natural de usarla.

### Hallazgos de `revisor` corregidos en esta sesión

- **El test nuevo daba por buenas las reversas sin mirarlas.** `purgeRoofingTrail` envuelve
  cada paso en un `catch` silencioso (es limpieza de `finally`), así que `reopen` →
  `reverseReport` → `cancel` sobre una OP **sin reserva** —justo las rutas que el flujo a
  stock estrena— corrían sin que nadie comprobara el resultado: si alguna se rompía, el test
  seguía verde. Ahora la reversa se corre **dentro del `try`, sin `catch`**, y se comprueba
  que la bobina vuelve a sus 2 000 kg y el producto a cero.
- **El spec no miraba el kardex del producto**, solo el de la bobina: se agregó el
  `ADJUST:PRODUCTION` del cierre y el `avgCost` de 83.0000 que ese ajuste produce.
- **`--out` vs `--decisions` se comparaba con `===` sobre cadenas.** En NTFS
  `…DECISIONES.json` y `…decisiones.json` son el mismo archivo, así que el chequeo nuevo
  dejaba pasar el caso que existe para impedir. Ahora la comparación ignora mayúsculas en
  Windows (`samePath`) y **corre al parsear argv**, antes de `ImportsService.upload` — si no,
  abortaba dejando ya creados el lote y sus `import_rows`.
- **RF-31 en `ARQUITECTURA.md` seguía diciendo que `POST /production/roofing` exige
  `reservationId`**, falso desde D-140 y contradicho por la fila D-145 del mismo archivo.
  Corregido con la excepción de la corrida a stock. Lo mismo en el doc de
  `ProductionOrder.reservationId` del schema, que solo nombraba a drywall.
- **`targetPieces` estaba duplicado como tipo local en el spec**; se agregó al DTO compartido
  de `e2e/helpers/production.ts`, que era donde faltaba.

**No corregido, a propósito: el `CHECK` acepta `target_pieces = 0` o negativo.** El revisor
propuso `("target_pieces" IS NOT NULL AND "target_pieces" > 0)`, que es más fiel al comentario.
No se aplicó porque **la migración ya está aplicada en `demo`**: editar su SQL cambia el
checksum y rompe `prisma migrate deploy` contra esa rama con el mismo síntoma que ya apareció
dos veces (ver D-053 y las notas de la sesión 7-final-C). El piso de 1 lo garantiza hoy
`piecesSchema` en `@ayr/shared` (`.int().min(1)`), que es por donde entra el único camino que
crea estas órdenes. Si algún día hace falta en la base, va como migración aparte.

## Sesión Planta (2026-09-08) — integridad de producción y reporte en tanda (D-146..D-149)

Sesión de planta, no una fase. Cinco puntos pedidos por el dueño, los cinco cerrados. Todo
en **local (Docker)**; producción no se tocó en ningún momento, ni para leer, y **no se
desplegó nada**.

### M0 — el plan de corte pasa a ser un tope duro (D-146)

**El hueco:** la única cota de un reporte de coberturas era el **material montado**. Una
orden de 100 ML con un rollo entero encima podía reportar 300 ML y nadie se quejaba; esos
metros de más nacían reservados a nombre del pedido (D-088) o entraban al almacén como stock
que ningún pedido encargó.

`RoofingProductionService.reportInTx` compara ahora el acumulado de los reportes **vigentes**
contra `Σ cantidad × largo` del plan de corte y rechaza el exceso **sin tolerancia** — el
borde exacto entra y el milímetro siguiente no. Producir más de lo planeado sigue siendo
posible, pero por donde corresponde: ajustar el plan (`PUT /production/roofing/:id/plan`) y
recién después reportar.

**Los datos históricos que ya se pasaron del plan no se tocan ni se bloquean para lectura.**
La regla mira hacia adelante: un acumulado excedido deja el restante en cero y rechaza el
reporte **siguiente**, nada más. Hay un caso de regresión que lo fija (`roofing-math.spec.ts`).

La aritmética vive en `@ayr/shared` (`roofingPlanProgress`, `roofingPlanOverrun`,
`remainingPlanPieces`) y la corren los dos lados: el API para rechazar y la terminal para
mostrar el restante antes de que nadie tipee. Dos copias habrían sido dos topes distintos.

### M1 — kg consumido por reporte, opcional y como dato (D-146, segunda mitad)

`consumedKg` opcional en `POST /production/roofing/:id/report`. Se guarda en
`production_reports.consumed_kg` (columna nueva, nullable, migración
`20260908180000_d146_kg_declarado_por_reporte`) y **no toca el kardex**: la salida de la
bobina sigue siendo el kilo teórico de los largos (D-047) y el consumo real se reconcilia al
cerrar (D-089), que es donde sale el despunte. Decisión del dueño entre las dos opciones que
se le plantearon.

El tope es el kilo teórico del **plan completo** con la geometría del rollo montado —también
elegido por el dueño frente a la alternativa más estricta (el teórico de los largos de ese
reporte), que no habría dejado declarar ningún despunte.

La tarjeta "Reportar largos rolados" de `/planta` muestra ahora, en una fila compacta de
cuatro cifras: **ML del plan, ML reportado, ML restante y kg teórico del plan**. El layout se
rehízo: los campos estaban sueltos y desalineados; ahora el kg y el resumen del reporte
comparten una fila con `items-end`, y el botón va con la fecha de operación en la siguiente.

### M2 — página "Reportar producción en tanda" (D-147)

`/planta/tanda`. Una fila por orden de coberturas abierta (filtro de texto por orden,
producto, pedido o cliente; y `?pedido=<id>` para llegar acotado desde el pedido). Cada fila
muestra orden, ítem, ML plan, ML reportado, ML restante, y captura **ML nuevo** y **kg
consumido** (opcional).

**Los largos no se tipean.** Se derivan del plan de la propia orden con `piecesFromPlanMeters`
(`@ayr/shared`), una búsqueda **exacta** —no glotona— que devuelve el desglose en planchas y
lo muestra bajo el input mientras se escribe. Que sea exacta no es refinamiento: con un plan
de `2 × 4.20 m` más `1 × 6.00 m`, el reparto glotón por orden de plan no encuentra los 6.00 m
aunque la respuesta exista. Cuando los metros no salen de un número entero de planchas, la
fila **falla en vez de redondear**: media plancha no existe.

`POST /production/roofing/batch` escribe las N filas en **una** transacción reusando
`reportInTx` —no una segunda copia de la lógica de reporte— y devuelve el error de **cada**
fila cuando alguna no valida, deshaciendo lo que las buenas alcanzaron a escribir. Un error
que no sea de dominio (una violación de constraint) sí corta en el acto: a partir de ahí
Postgres aborta la transacción y seguir juntando errores sería inventarlos.

### M3 — "Generar todas las órdenes" desde el pedido (D-148)

`POST /production/roofing/from-sales-order/:id`: una OP por cada línea del pedido que todavía
no la tiene, en una transacción. No cambia el modelo (**1 ítem = 1 OP**, cada una naciendo de
su reserva por `createFromReservationInTx`, con el `CHECK` de D-145 intacto); lo que agrega es
que un pedido de ocho líneas no pueda quedar con cinco en cola y tres olvidadas. Las líneas de
catálogo se saltan en silencio: su camino es la corrida a stock (D-140), no este botón. Sin
reversa propia — anular una orden por separado ya existe (RF-33).

`planMeters` entra al DTO de la orden (y al listado, que hasta ahora omitía `items`), así que
la tarjeta de `/planta` muestra los **ML a producir** sin abrir el detalle.

### M4 — hoja de planta en PDF (D-149)

`GET /sales/orders/:id/pdf-planta`, con `pdfkit` y el mismo patrón que el PDF de la cotización
(D-068). Lleva número de pedido, cliente, fecha prometida y, por ítem, producto, cuánto hay
que producir, los largos (`10 × 4.20 m`) y las medidas que deciden qué bobina se monta
(espesor, ancho, color — D-086), más un pie para firmar. **Sin ningún importe.**

Dos diferencias deliberadas con el PDF de la cotización: se arma **al vuelo y no se guarda en
R2** (aquel es un documento congelado que se le mandó al cliente; este es una copia de trabajo
del estado actual, y una versión vieja bajando al taller es justo lo que no se quiere), y no
lleva precios (una hoja con márgenes circulando por la planta es la forma más barata de que se
entere todo el mundo). Se descarga desde el pedido y, en el teléfono, se comparte con la Web
Share API — el botón de compartir solo aparece si el navegador declara poder compartir
**archivos** (`navigator.canShare({ files })`).

### Verificación

- `pnpm turbo lint typecheck test`: **306/306** unitarios en verde (13 nuevos en
  `roofing-math.spec.ts` para D-146/D-147: el tope y su borde exacto, el histórico excedido,
  el descuento por largo, y los cuatro casos de `piecesFromPlanMeters` incluida la vuelta
  atrás que el glotón no encuentra).
- E2E local (Docker): `planta-tanda.spec.ts` (API) + `planta-tanda-ui.spec.ts` (pantalla, escrito por `qa`), **7/7** — tope del plan con su borde exacto, kg
  declarado que no mueve kardex, tanda feliz de dos órdenes, tanda con una fila que se pasa
  del tope (**rollback comprobado en el kardex**, no en el mensaje), metros que no cierran en
  planchas enteras, generación de las órdenes de un pedido, descarga de la hoja de planta, y el
  recorrido de la pantalla de tanda de punta a punta (desglose en vivo, error inline del tope,
  envío y kardex comprobado por API).
- Regresión en tandas chicas contra el Postgres local, cubriendo **todo spec que toca
  `/production/roofing`** (que es lo único que D-146 puede cambiar) más los que leen el DTO de
  producción: `fase6 fase6-bordes fase7final-m1 fase7final-op-a-stock planta-tanda` (**25/25**),
  `fase5a-bordes fase7* fase7-consolidada fase7e-bordes` (**84 pasaron, 3 fallaron**) y
  `fase4 fase4-bordes fase7d fase7e fase7e-ajustes-d121 fase7final-m0 fase7finalb-pedido-importado`
  (**40/40**). **149 casos, 3 fallas y ninguna del código:** son las tres de `fase7b` que emiten
  contra el PSE demo y chocan con su cupo (_"No puedes enviar mas de 50 documentos en una cuenta
  DEMO"_), el mismo límite externo ya anotado en el cierre de la Fase 5b.
- Tras aplicar los hallazgos de la revisión, la tanda de coberturas se volvió a correr entera
  (`planta-tanda planta-tanda-ui fase6 fase6-bordes fase7final-m1 fase7final-op-a-stock`):
  **26/26**.
- **En tandas y no de una sola corrida, a propósito:** el token de acceso dura 15 minutos y una
  corrida completa de la suite se pasa de ahí y empieza a caerse con 401 a mitad de camino.
- **No se corrió `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocó producción.
- **Nada desplegado.** Falta el visto bueno del dueño; la migración de esta sesión
  (`20260908180000_d146_kg_declarado_por_reporte`) es **aditiva y nullable**, así que el API
  viejo contra la base ya migrada funciona igual y no hay ventana de incompatibilidad entre
  migrar y desplegar.

**Hallazgo del E2E, que es comportamiento correcto y quedó documentado en el spec:** dos
órdenes del mismo color y espesor no pueden montar cada una un rollo entero mientras la
promesa de la otra siga viva. D-134 saca del disponible del agregado el rollo **completo** —no
los kilos asignados—, así que el segundo montaje deja la otra reserva sin material y el
guardrail lo corta. El test compra la tercera bobina que el propio mensaje del guardrail pide.

### Hallazgos de `revisor` corregidos en esta sesión

Dos pasadas en paralelo (API + `@ayr/shared` por un lado, `apps/web` por el otro) y una de
`qa`. Ningún bloqueante; lo alto y lo que valía la pena, corregido en el mismo commit.

- **La tanda escribía a medias antes de fallar, y las filas siguientes se validaban contra esa
  suciedad.** `reportInTx` no es atómica por dentro: descuenta la reserva, mueve el pedido a
  `EN_PRODUCCION` y crea el reporte **antes** del primer punto que puede fallar por dominio,
  que es `inventory.record`. Al capturar el error y seguir el bucle, la fila 2 veía la reserva
  ya consumida por la fila 1 fallida y devolvía un error que era puro efecto colateral. El
  caso no era exótico: una tanda **retrofechada sin confirmar** hacía fallar a todas las filas
  en el kardex y devolvía N errores fabricados. No había corrupción —el `throw` final revierte
  todo—, pero el contrato que la pantalla promete ("el error de **cada** fila") era falso.
  Corregido con un **`SAVEPOINT` por fila**: la que falla se deshace sola y las que siguen ven
  el estado real.
- **Las filas se bloqueaban en el orden que mandaba el cliente.** Cada una toma un `FOR UPDATE`
  sobre su orden y los acumula hasta el commit, así que dos tandas simultáneas con las mismas
  órdenes en distinto orden se trababan en deadlock — el mismo defecto que ya había costado un
  incidente y que motivó el "pedido primero, reserva después" de `report`. Ahora se ordenan por
  id antes de tocar nada.
- **`piecesTheoreticalKg` quedó duplicada.** El comentario del código compartido decía que
  `roofing-math.ts` "la envuelve" y no la envolvía: eran dos copias byte a byte, y el tope de
  kg declarado usaba la del API. Exactamente las "dos copias serían dos topes distintos" que el
  propio comentario advertía. `roofingTheoreticalKg` pasó a delegar.
- **`MAX_BATCH_ROWS` bajó de 50 a 20.** Con 50 filas, el presupuesto de 120 s daba 2.4 s por
  fila —cada una hace lo que `report` entero, que ya necesita 30 s contra Neon— y la
  transacción retenía los locks de 50 órdenes, sus pedidos y sus bobinas durante dos minutos.
- **El cierre ignoraba los kilos que planta declaró por reporte.** `close` seguía asumiendo
  merma cero cuando no le pasaban `consumedKg`, contradiciendo en silencio la cifra que el
  encargado se había tomado el trabajo de anotar. Ahora los usa como valor por defecto (con
  piso en el kilo teórico ya reportado); lo explícito sigue mandando.
- **`SUPERVISOR_PLANTA` recibía 403 en la hoja de planta**, el único documento que D-149
  diseñó para el taller. La ruta suma ese rol; no lleva importes, así que no le abre nada de lo
  que el módulo comercial le oculta.
- **El mensaje del reparto agotado mentía.** Cuando `piecesFromPlanMeters` se quedaba sin
  presupuesto de nodos decía "esos metros no salen de un número entero de planchas", que puede
  ser falso. Ahora distingue los dos casos y manda a reportar los largos a mano.
- **La tanda del web armaba el envío con las filas visibles.** Escribir tres filas y después
  tipear en el filtro para buscar la cuarta dejaba las tres primeras fuera del envío, y el
  éxito borraba esos borradores sin que nadie se enterara — lo contrario exacto de "la hoja
  entra entera". Ahora el filtro solo decide qué se pinta; además la pantalla avisa cuántas
  filas con metros quedaron fuera de la vista.
- **Medios del web corregidos:** el enlace a la orden navegaba fuera y perdía todos los
  borradores (ahora abre en otra pestaña); la fila no comparaba el kilo teórico contra los
  kilos montados y dejaba tumbar la tanda entera después de un minuto de transacción; una orden
  **sin plan de corte** mandaba a "ajustar el plan de corte" en vez de a la terminal; los
  errores por fila del intento anterior sobrevivían a un segundo intento fallido; y el botón de
  compartir la hoja de planta moría con un 401 sin salida cuando el token de acceso vencía
  (ahora reintenta tras el refresh).
- **Bajos corregidos:** `messageOf` reventaba dentro del `catch` si el cuerpo del error era
  `null` (la tanda salía como 500 opaco); el DTO de la tanda tipaba `status` y `productUnit`
  como `string` suelto; el botón de D-148 no ofrecía fecha de operación pese a que el schema la
  acepta (las OP de un pedido importado con fecha vieja nacían fechadas hoy); la terminal
  mostraba "ML del plan 0.000" y pedía elegir una bobina ya elegida en una orden sin plan; y
  quedaban dos formatos de cantidad conviviendo en la misma tarjeta.
- **Anotado y no corregido:** `GET /production/roofing/batch` corta en 500 órdenes abiertas sin
  avisar que truncó. Con el volumen real está lejísimos, y el filtro por pedido es la salida;
  si algún día importa, va como paginación con `hasMore`.

**Lo que la revisión confirmó, y no es menor:** `productionReport.create` existe en exactamente
dos lugares —el de coberturas, que pasa por el tope, y el de drywall, cuyo `lockOrder` corta por
`assertKind`—, así que **no hay ningún camino que escriba un reporte de coberturas sin tope**.
Y el reparto de metros a planchas se fuzzeó con 20 000 casos contra fuerza bruta: 0 discrepancias.

## Sesión Importadores (2026-09-08) — se borran los directos y entra el de cotizaciones (D-150..D-152)

Sesión de limpieza y reemplazo, no una fase. Todo en **local (Docker)**; producción no se tocó
ni para leer, y **no se desplegó ni se hizo push** (un push a `main` dispara el deploy del web).

### M0 — se elimina el módulo de importaciones entero (D-150)

**Decisión del dueño**, tomada sobre dos opciones y eligiendo la amplia: no solo los dos
importadores de 7-final (bobinas D-137 y ventas D-138/D-141), sino **todo** el módulo. Se le
planteó explícitamente que la opción amplia da de baja RF-52 y RF-71/72, que están desplegados
y no son legacy de 7-final; lo confirmó igual.

**10 313 líneas menos en 49 archivos.** Se fueron los cinco adaptadores (`PRODUCTS`,
`CUSTOMERS`, `COILS`, `FISCAL_DOCUMENTS`, `COILS_HISTORY`, `SALES_HISTORY`), el ciclo de lote
`import_batches`/`import_rows` con su previsualización fila por fila, el `ImportDialog` del web
y las cuatro puertas que lo abrían (catálogo, clientes, comprobantes ×2, bobinas), el CLI
`pnpm import:ventas` (D-142) con `purge-imported-sales` (D-143/D-144) y la auditoría de
importados, los schemas y enums de `@ayr/shared`, `tsconfig.cli.json`, y tres specs E2E
completos (`fase7c`, `fase7c-bordes`, `fase7finalb-pedido-importado`) más dos casos sueltos
(el de RF-52 en `fase1` y el de RF-12 en `fase2a`).

**Tres piezas conservadas, cada una con su motivo escrito en el código:**

- `apps/api/src/imports/parse-spreadsheet.ts`, con los lectores de celda por encabezado
  rescatados del adaptador borrado (tolerantes a tildes y mayúsculas, tope de 512 caracteres,
  la fecha como día calendario). No son del importador viejo: son la parte aburrida y ya
  probada de leer una planilla que llenó un humano.
- `customers/document-lookup.service.ts` (padrón apis.net), que nunca fue del importador — lo
  usa el alta de cliente y ahora también la de proveedor.
- `FiscalImportService.annulImported` (D-110). **No es una vía de ingreso, es el remedio de las
  filas que ya entraron por una**: un `fiscal_document` con `origin = IMPORTED` nace `ACCEPTED`
  con su cuenta por cobrar y el PSE no lo conoce como nuestro (D-105), así que sin este método
  una fila mal cargada es deuda falsa permanente. Producción quedó en cero importados (D-144),
  pero `demo` es un clon anterior a esa limpieza y los conserva. El resto del servicio —el alta
  y el archivado al reimportar— se recortó: eran 400 líneas sin llamador.

**Dos cosas que quedaron a propósito y hay que saber:**

- **Las tablas `import_batches`/`import_rows` y las columnas `import_batch_id` no se tocaron.**
  Borrarlas es irreversible y son el único rastro de las cargas que sí ocurrieron.
- **El spec de M-4 quedó con un solo caso**, el que no necesitaba importar: que la anulación
  interna no alcanza a un comprobante emitido por el ERP. Los otros cinco —el camino feliz, los
  dos guardrails, la idempotencia y el 403 del vendedor— empezaban importando y no hay forma de
  montarlos. Está anotado en el propio archivo.

### M1 — importador masivo de cotizaciones (D-152)

Lo que reemplaza a lo borrado, y cambia de idea, no de implementación: **no escribe contra la
tabla, escribe una cotización**. `QuotationsService.create` se partió con el patrón `*InTx`
(D-099) y el importador llama a `createInTx`, la misma que el formulario.

- `POST /imports/quotations/preview` (multipart) lee el export real de ventas detalladas —una
  fila por línea, agrupadas por `SERIE - NÚMERO`—, resuelve el cliente por su documento y el
  producto por su SKU, y devuelve las filas con lo que no pudo resolver marcado por campo. **No
  escribe nada**: ni el archivo, ni un lote, ni una fila.
- `/cotizaciones/importar` pinta esas filas en una tabla editable en el navegador —cliente,
  producto, cantidad, precio y plan de corte, más quitar filas— y revalida en vivo.
- `POST /imports/quotations` crea una cotización **en BORRADOR** por comprobante, en una
  transacción con un `SAVEPOINT` por documento: todo o nada, con el error de cada uno (mismo
  contrato que D-147).

**Las tres reglas, que son las lecciones de lo que se borró.** Cero creación silenciosa: un
cliente o un SKU que falta detiene su fila y se da de alta por su propio maestro (D-138 los
auto-creaba y por eso terminó necesitando un purge). Nada se adivina: el plan de corte por
defecto es `1 × los ML de la línea`, y **cuando no cabe en una plancha la fila pide el plan
real** en vez de repartirlo — el archivo de agosto tiene 23 de 27 líneas a medida por encima
del tope de 20 m, una de 1 832 m, y ese plan es después el tope duro de lo que planta puede
reportar (D-146). Y el importador **para en la cotización**: emitir y confirmar comprometen
inventario, y eso se mira documento por documento. Decisiones del dueño las dos últimas.

Detalles del contrato con el archivo real (141 filas, 71 comprobantes, 48 clientes, 41 SKUs):
el precio unitario sale de `VALOR DE VENTA ÷ CANTIDAD` (el archivo no lo trae); un documento en
dólares se lleva a soles con **su propio** tipo de cambio, no con el de hoy; el número del
comprobante viaja a las observaciones como `Factura externa: FFA1-1349`; la fecha del papel es
la de la cotización (D-124); y las notas de crédito y las filas con `DOCUMENTO AJUSTADO` se
excluyen diciendo por qué.

**Un defecto real que el E2E destapó de paso.** SheetJS lee las fechas de un csv como M/D/Y:
`03/08/2026` —el 3 de agosto del archivo del negocio— entraba como el **8 de marzo**, sin error
y sin ninguna señal, y el comprobante terminaba en el mes equivocado. El csv pasa a leerse con
`raw: true` y la fecha la interpreta quien conoce el formato del archivo. Tiene su caso de
regresión en `parse-spreadsheet.spec.ts`.

### M2 — el padrón en el alta de proveedor (D-151)

`GET /suppliers/lookup` reusando el `DocumentLookupService` que M0 conservó: `SuppliersModule`
importa `CustomersModule` en vez de duplicar el cliente. Mismo throttle y mismo fallback
silencioso que el alta de cliente (D-067), con el rol **más estrecho** —solo ADMINISTRADOR—
porque el token de apis.net.pe es el mismo que sirve el tipo de cambio (D-029) y la cuota es
una sola.

### Verificación

- `pnpm turbo lint typecheck test`: **272/272** unitarios en verde (el total baja de 306 porque
  se fueron los 22 del adaptador de ventas y los 12 de la aritmética de importación fiscal;
  entran 6 nuevos del plan por defecto y 1 de regresión de la fecha del csv).
- E2E local: `import-cotizaciones` (API) + `import-cotizaciones-ui` (pantalla, escrito por
  `qa`) **7/7**, y `fase5a` de vuelta en verde tras el fix del seed; regresión del borrado sobre
  `fase1 fase2a fase2b fase3 fase3b m2-reversa-pago m4-anulacion-importado fase7-consolidada`,
  **55/55** una vez retirados los dos casos que probaban el importador eliminado.
- `pnpm exec eslint e2e` y `prettier --check` limpios sobre todo lo de esta sesión.
- **No se corrió `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocó producción.

**Trampa del entorno local, que costó tres diagnósticos falsos en esta sesión:**
`playwright.config.ts` usa `reuseExistingServer` en local, así que un servidor colgado en
:3000/:3001 —de `pnpm dev:local`, de otra corrida o de otra sesión— se **reusa** y apunta a
otra base. El síntoma es `Login admin falló: 401 Credenciales inválidas` en el primer test, que
no se parece en nada a su causa. Antes de correr la suite:
`netstat -ano | grep LISTENING | grep ":300"` y matar lo que haya.

### Hallazgos de `revisor` y `qa` corregidos en esta sesión

Una pasada de `revisor` sobre el diff completo y una de `qa` sobre la pantalla. Ningún
bloqueante, pero **tres altos que dejaban el importador inservible justo en las líneas de
coberturas**, que son las que motivaron la sesión.

- **Quien exige los largos es la unidad, no el subtipo — otra vez.** El preview decidía
  `needsPieces` con `roofingKind === A_MEDIDA`, mientras el alta lo decide con
  `unit === 'MTR'` (`sellsByLength`). Es **exactamente** la confusión que D-131 documentó y
  que ya había costado que el mostrador pudiera vender material a medida: son dos preguntas
  distintas y una respondía por la otra. Un SKU en `MTR` que no fuera `A_MEDIDA` pasaba el
  preview sin una marca, la pantalla ni dibujaba la celda del plan, y el archivo entero moría
  en el confirm sin forma de arreglarlo salvo quitando la fila.
- **Un SKU repetido se resolvía solo, y mal.** El índice del catálogo es
  `(business_line_id, sku)`: el mismo código puede existir en dos líneas de negocio, y un
  `new Map(...)` se quedaba con el último — otra línea, otro precio de lista, otra rama de
  reserva, en silencio. Ahora un duplicado devuelve "elige el producto" en vez de adivinar.
  Mismo tratamiento para el documento del cliente, cuyo par único es `(doc_type, doc_number)`.
- **La pantalla no recalculaba los largos al cambiar el producto.** Reasignar una fila a un
  producto por metro lineal dejaba la celda del plan apagada, y a uno simple mandaba `pieces`
  que el API rechaza. Ahora se recalcula con el producto elegido.
- **El desplegable de clientes estaba siempre vacío** (lo encontró `qa` corriendo la pantalla,
  no el revisor leyendo el código): pedía `pageSize=500` y el tope de `paginationQuerySchema`
  es 200, así que el request devolvía 400. Una fila sin cliente **no se podía corregir**: la
  única salida era quitarla. Ahora se pagina de a 200 hasta traer el maestro y se avisa si no
  entró entero.
- **Código muerto que podía revivir mal.** `createImportedShellInTx`, `assertNoInventoryEffects`
  y `archiveImportedOrderInTx` (~180 líneas capaces de escribir pedidos `origin = IMPORTED` sin
  pasar por reservas) y la opción `allowMissingPieces` de `resolveSalesLines` —la relajación que
  D-141 justificaba— se quedaron sin llamador con el borrado. Se fueron con él: una relajación
  latente sin el contexto que la hacía segura es peor que no tenerla.
- **Medios corregidos:** el aviso de unidad bloqueaba el botón como si fuera un error (los
  avisos pasan a tener severidad y solo los errores bloquean); el detalle del comprobante seguía
  instruyendo a "reimportarlo", que ya no existe; `parsePlan` no comprobaba las cotas del schema
  y el error volvía como un Zod que la pantalla no sabía atribuir a ninguna fila; el plan por
  defecto se derivaba de la cantidad **sin** redondear y los largos no sumaban la cantidad de la
  línea; los desplegables ofrecían maestros inactivos, que tumban el archivo entero; y nada
  avisaba al subir dos veces el mismo archivo — ahora el preview marca el comprobante que ya
  tiene cotización viva.
- **Bajos corregidos:** la descripción se recorta a 240 (el tope del schema) y no a 512 (el del
  lector de celdas); `confirm` gana su `@Throttle`; volver a elegir el mismo archivo vuelve a
  disparar la lectura; un campo con dos avisos los muestra los dos; `FiscalImportService` deja
  de exportarse; `scripts/e2e-prod.mjs` deja de nombrar suites borradas; y `e2e-report.json` y
  `subset.json` entran al `.gitignore` (regla dura 13) en vez de quedar sueltos en la raíz.

### Un defecto viejo que apareció de paso: el seed apagaba RF-31

`fase5a.spec.ts` fallaba desde antes de esta sesión con _"POST /api/sales/orders debía fallar y
devolvió 201"_ — el caso que comprueba que **en coberturas no hay pedido directo** (RF-31,
D-065). No era el guardrail: era el dato. `quotation_required = true` para `metallic-roofing` lo
pone un `UPDATE` de la migración de Fase 5a, o sea sobre las filas que existían entonces; en una
base **recién reseteada** —el E2E local y la rama `ci` en cada corrida— las líneas de negocio las
crea el seed, y nacían todas con el `false` por defecto. Con eso, coberturas dejaba de exigir
cotización exactamente donde se lo prueba.

Ahora el seed lleva el dato, y solo lo fuerza donde es una regla del dominio: el resto de la
configuración de una línea la administra el dueño y el seed no la pisa. Producción nunca estuvo
afectada (su fila la actualizó la migración y nadie la recreó). `fase5a` volvió a verde.

## Sesión Comprobantes manuales (2026-09-08) — D-131 pasa a regla dura y entra D-153

Todo en **local (Docker)**; producción no se tocó ni para leer, y **no se desplegó ni se hizo
push**. El diseño de D-153 se presentó al dueño antes de escribir una línea y se implementó lo
que aprobó.

### D-131 pasa a invariante (regla dura 14)

La confusión entre _"¿esta línea necesita el detalle de largos?"_ y _"¿se fabrica a medida?"_ ya
costó dos defectos —el mostrador vendiendo material a medida, y el importador de cotizaciones
dejando pasar sin marca toda línea en `MTR` que no fuera `A_MEDIDA`—, la segunda **el mismo día
que se escribió el código**. Las dos veces el compilador calló, porque las dos preguntas
devuelven `boolean`.

Ahora la respuesta tiene **una sola definición**: `sellsByLength(product)` en `sales-lines.ts`,
que el importador también usa. La regla está en `CLAUDE.md` como la número 14, y el centinela es
`sales-lines.spec.ts`: la tabla completa de combinaciones de unidad × subtipo, más un caso que
se cae si alguien define una pregunta en términos de la otra.

### D-153 — el borrador tiene dos terminales

La empresa sigue emitiendo desde otra app mientras dura la migración. Esos comprobantes ahora se
registran acá, con su cuenta por cobrar y su pedido, sin pasar por Nubefact.

**El modo es un tercer valor de `FiscalDocumentOrigin` (`MANUAL`), no un campo aparte.** El
motivo se pudo medir antes de decidir: hay siete ramas en todo el código que miran `origin`, y
la que importa es una función llamada `assertIssuedHere` cuya prueba era `!== IMPORTED`. Con un
campo ortogonal, esas siete guardas habrían seguido **dejando pasar un manual a Nubefact**; con
un valor nuevo se dan vuelta a `=== ISSUED_HERE` en una pasada y el comportamiento cae solo.

`POST /invoicing/documents/:id/register-manual` cierra el borrador con la serie y el correlativo
del papel: `seriesId = null` —la serie del talonario no es una fila de `fiscal_series`, y
adelantar esa tabla quemaría rango de las series con las que se factura de verdad—,
`status = ACCEPTED` por el mismo motivo que un importado (D-105), sin CDR ni XML. Que los dos
terminales partan del **mismo borrador** es lo que garantiza que un manual pase por las mismas
validaciones que un electrónico: son literalmente las de `createInTx`.

Lo demás que entró: la **nota de crédito hereda el modo de su afectado**, con una guarda en cada
terminal; la anulación interna de D-110 se generaliza (`annulExternal`) y cubre todo lo que el
ERP no emitió; el pre-llenado de serie y correlativo desde el `Factura externa: FFA1-1349` que
el importador (D-152) deja en las observaciones del pedido; un ajuste global
(`invoicing_settings.manual_by_default`) que solo decide **cuál de los dos botones viene
destacado**, con los dos siempre a la vista; y en el listado, el badge de origen para todo lo
que no sea del ERP más un filtro por origen.

### Lo que el dueño pidió y no hizo falta hacer

Pidió que "la salida de stock sea idéntica en ambos modos, misma ruta `InventoryService.record()`".
**El comprobante no mueve kardex en ningún modo**: lo mueve el despacho (D-074), por un solo
camino. La garantía ya existía por construcción y no se tocó nada. Queda anotado con su caso de
prueba porque la pregunta va a volver.

### El defecto de D-145, otra vez — y esta vez lo agarró el E2E

Registrar el primer manual devolvía **`500 Internal server error` sin mensaje**. Dos `CHECK` de
la base escritos cuando la regla era más angosta:

- `fiscal_documents_number_ck` exigía que el número viniera **siempre** con un `series_id`. Un
  comprobante manual tiene número —el del papel— y no tiene serie del ERP.
- `fiscal_documents_annulled_origin_ck` reservaba el estado `ANNULLED` a lo importado, así que
  un manual mal registrado no tenía vuelta y quedaba como deuda falsa permanente.

Es exactamente D-145: código que ensancha una regla y una base que sigue diciendo la anterior,
con un 500 mudo como único síntoma. La diferencia es que esta vez **no llegó a desplegarse**,
porque la sesión escribió el caso feliz y la reversa en el mismo spec. Corregidos en una
migración aparte (`20260908213000_...`), separada a propósito de la que agrega el modo: editar
una migración ya aplicada le cambia el checksum y rompe `migrate deploy`, que es un síntoma que
este proyecto ya se comió dos veces (D-053 y las notas de 7-final-C).

**La lección, que vale más que el fix:** al agregar un valor a un enum que la base conoce, hay
que ir a leer sus `CHECK`. El compilador no los ve, y son la parte del dominio que vive fuera de
TypeScript.

### Hallazgos de revisor y qa

**Los dos bloqueantes fueron del agente, no del diseño, y los dos por la misma causa mecánica:**
las expresiones regulares de la pantalla se escribieron a través de un heredoc de shell, que se
comió las barras invertidas. `/^\d{1,8}$/` quedó como `/^d{1,8}$/` y el botón «Registrar» **nunca
se habilitaba**; el patrón del pre-llenado perdió su `\s` y su `\d`, así que **nunca matcheaba**,
con el fallo tapado por un `catch` silencioso. Los E2E por API no los veían porque no pasan por
la pantalla. Corregidos con la herramienta de edición. **Regla que queda: el código con
expresiones regulares se escribe con el editor, nunca por heredoc.**

Cuatro **altos**, todos la misma familia: código que preguntaba `!== IMPORTED` y con el tercer
valor pasó a decir algo falso. `voidPath` ofrecía «Dar de baja» sobre un manual (una baja ante
SUNAT de un comprobante que el ERP no emitió), `canAnnul` dejaba la reversa **inaccesible desde
la UI** —justo la mitad que el `CHECK` prohibía— y `canQuery` mostraba «Consultar al PSE» en
todos los manuales. Los tres colapsaron en un único `isExternal`, que es la pregunta que las tres
querían hacer. El cuarto: el terminal manual no llamaba a `assertOwnership`, así que un vendedor
podía cerrar el borrador de otro; el terminal electrónico sí lo hacía desde siempre.

Medios corregidos: el choque de número entre dos registros simultáneos salía como `500` en vez de
`409`; `acceptedAt` quedaba nulo y —con `NULLS FIRST` en el desempate— un manual desplazaba a la
factura electrónica como respaldo de una guía; el badge del detalle seguía marcando solo lo
importado. Y dos huecos de prueba que el propio revisor nombró como «el mismo hueco de D-145»:
ahora hay un caso que **anula un manual de verdad** y otro que comprueba que **ninguna de las
cuatro puertas al PSE lo acepta** (`send`, `retry`, `refresh`, `void`).

Ese último caso se escribió mal la primera vez y vale anotarlo: asertaba que el barrido
`send-pending` devolviera cero. **`send-pending` es global** —recorre hasta veinte documentos de
toda la base—, así que el número dependía de lo que otras pruebas hubieran dejado (devolvió 7), y
peor: **llamarlo mandaba al PSE demo comprobantes ajenos al escenario**, quemando cupo de la
cuenta y moviéndoles el estado. El barrido salió del test; queda asertado lo que sí es del dato
—un manual nace `ACCEPTED`, que no está entre los estados reintentables— y la otra mitad del
filtro la sostienen las cuatro puertas, que son las que un refactor a `!== IMPORTED` rompería.
**Un test no puede asertar un contador global en una base compartida.**

De `qa`: la suite de UI (`comprobante-manual-ui.spec.ts`, 2 casos) cubre los dos terminales
visibles a la vez, la validación de serie en el diálogo, la vista previa del número y el
pre-llenado desde las observaciones. Son exactamente los tests que cazan la regresión de las
barras invertidas: si vuelven a caerse, el primer caso falla en «Registrar deshabilitado» y el
segundo en el pre-llenado. `qa` dejó anotado que el E2E local levanta el API con `nest start`, así
que un `.ts` a medio editar en `apps/api` tumba la corrida con un mensaje que no habla de tests
—vale saberlo cuando dos agentes trabajan en paralelo—.

**Anotado y no tocado, porque no es de esta sesión:** `scripts/dev-local-view.mjs` arma su mensaje
de error con `args.join(' ')` en vez de usar `run` de `scripts/lib.mjs`, que es la forma exacta
que la regla dura 5 nombra como el escape de D-128; hoy no viaja ninguna credencial por `argv`,
así que está latente y no abierto. Además imprime la contraseña local y numera los pasos «1/3,
2/4».

### Verificación

- `pnpm turbo lint typecheck test`: **279/279** unitarios (7 nuevos, el centinela de D-131), más
  `pnpm exec eslint e2e` y Prettier sobre lo tocado.
- E2E local: **9/9** entre `comprobante-manual` (7 casos por API) y `comprobante-manual-ui`
  (2 casos por pantalla, de `qa`). La regresión de facturación
  (`fase7b-bordes m4-anulacion-importado fase5b-bordes`) quedó **19 de 23**, con las 4 fallas del
  cupo de la cuenta demo del PSE — el mismo límite externo de siempre, ajeno al código.
- **No se corrió `pnpm e2e:prod`** (regla dura 9, D-126) ni se tocó producción.
- **Sin desplegar y sin push.** Las dos migraciones de D-153 están escritas y aplicadas en local;
  producción sigue sin ellas.

## Sesión Planta II (2026-09-09) — el guard que bloqueaba de más, el espacio de producción y el callejón del importador

Tres cosas, y las tres nacen del mismo lugar: el sistema le decía que no a la persona que no
podía resolverlo.

### D-154 — el faltante de materia prima avisa; no bloquea

**El síntoma:** planta montaba una bobina llena de material y el API la rechazaba con "la
operación dejaría 0.000 kg libres de Bobina 0.45 mm ROJO y hay 150.000 kg prometidos a
PED-000003" — sobre **el pedido que estaba fabricando**. Tres defectos superpuestos detrás
del mismo mensaje, y solo uno de los tres era la severidad.

1. **El pedido se bloqueaba a sí mismo.** `exceptReservationIds` exceptuaba la reserva de la
   línea, pero un pedido de coberturas reserva una vez **por línea** y genera una OP por
   reserva (D-084/D-148): montar la bobina de la línea 1 se comprobaba contra la promesa viva
   de la línea 2 del mismo pedido. Entra `exceptSalesOrderIds` y se exceptúa el pedido
   entero. El centinela es el test que hace la misma cuenta **sin** esa exclusión y comprueba
   que ahí sí falta material: si alguien la saca creyendo que la reserva alcanza, se cae.
2. **Montar sacaba el rollo entero del agregado.** Planta monta los 5 000 kg del rollo para
   cortar los 200 que el pedido prometió, y el pool quedaba en cero sobre un almacén con
   4 800 kg libres. La causa era un **doble descuento**: una OP que nace de un pedido ya
   tiene su compromiso contado como reserva genérica sobre la spec, y sumarle además la
   custodia contaba dos veces el mismo kilo. Ahora `heldKg` es **cero** cuando la orden tiene
   reserva; lo que va a consumir baja las dos cifras a la vez (`consumeReservationQty` con la
   salida de kardex). Solo las corridas **a stock** (D-140) aportan `assignedKg − consumedKg`,
   porque no tienen reserva que las represente.

   **Esto lo encontró la revisión, y vale por sí solo.** El primer intento midió la custodia
   como `assignedKg − consumedKg` para todos, y esa versión **no se activaba nunca**:
   `mountCoil` asigna el rollo entero salvo que alguien mande `qtyKg`, y nadie lo manda. El
   arreglo pasaba por corregir la cuenta, no por pedirle a planta que dijera cuántos kilos va
   a usar. La lección: un test que prueba un parámetro que ningún llamador pasa da una
   sensación de cobertura que el sistema no tiene.

3. **La severidad.** En `mountCoil`, `report` y `close` la invariante devuelve los faltantes
   (`findRawMaterialShortfalls`) en vez de lanzarlos: viajan en la respuesta
   (`ProductionOrderDto.rawMaterialWarnings`), quedan en `audit_log` y se persisten en
   `production_reports.raw_material_warning`. **Fuera de producción no cambia nada**: ventas,
   corte, bobinas y kardex siguen recibiendo el 400 de siempre.

De paso cayó el tope duro de D-146 sobre el **kg declarado**: pasa a aviso de desviación
(`roofingConsumptionDeviation`, ±10 %, más el aviso de acumulado sobre el plan), calculado con
la misma función en el API y en la pantalla. El tope de **metros** del plan sigue siendo duro.

**La lección, que vale más que el fix:** cuando el sistema corta una operación, la pregunta no
es "¿la regla es correcta?" sino "¿la persona que está del otro lado puede hacer algo con
esto?". Quien está en la roladora no anula el pedido de otro cliente ni libera su reserva, así
que el 400 no protegía nada — el material se rolaba igual y lo único que cambiaba era que no
quedaba registrado, que es exactamente lo que la invariante existía para evitar.

Y una segunda, sobre el orden de los arreglos: los tres defectos daban el mismo síntoma. Si se
hubiera tocado solo la severidad, los dos falsos positivos habrían seguido ahí, ahora
convertidos en avisos que nadie podría distinguir de los verdaderos — que es peor que el
rechazo, porque un aviso que casi siempre miente se deja de leer.

**La consecuencia visible, que la regresión de Fase 6 destapó.** Con la bobina montada
contando otra vez en el agregado, el panel de stock de un rollo de 1 000 kg con 48 kg
prometidos pasa de mostrar `0.000` a `952.000` de material reservable. Es correcto —esos
kilos vuelven al almacén cuando la orden cierre— y el `0.000` era el mismo bug mirado desde
la pantalla de ventas: le decía al vendedor que no había material sobre un rollo intacto. La
restricción que **sí** sigue viva es de agenda y no de material: mientras esté montada,
ninguna otra OP puede montar esa bobina, y eso lo sostiene `assertStripsNotAssigned`, no el
agregado. Dos specs de Fase 6 codificaban el comportamiento viejo y se actualizaron; uno de
ellos (`fase6.spec.ts`, "la pieza a medida no se la puede llevar otro pedido") pasó a usar una
bobina de 50 kg en vez de 1 000 para que el rechazo del pedido rival venga de **escasez real**
y no del artefacto de la cuenta.

### D-155 — `/planta/producir` reemplaza a la tanda

La tanda de D-147 dejaba transcribir los metros de N órdenes de una sentada, pero **no montaba
la bobina**: había que entrar orden por orden a la terminal para montar y recién después
volver a la tanda a reportar. Dos pantallas para una tarea.

Ahora una orden es una **pestaña** (lista lateral master-detail por encima de
`MAX_ORDER_TABS = 6`) con indicador **sin bobina / lista / reportada**, y adentro está el ciclo
completo: montar o cambiar la bobina con el mismo selector y los mismos endpoints que el
detalle de la orden, ML plan / reportado / restante / kg teórico, y los inputs de ML nuevo y kg
consumido. Barra de progreso arriba. **El guardado es por orden**, y cada uno sigue siendo
atómico del lado del API (reporte + kardex en una transacción vía `InventoryService.record()`).

`POST /production/roofing/batch` se eliminó junto con sus schemas; `GET` queda y suma
`reservationId` y, por bobina, `consumptionId` y `consumedKg`. `/planta/tanda` quedó como
redirección —conservando `?pedido=`— para no dejar dos caminos vivos. El detalle del pedido
gana el botón **Producir (N)** y el detalle de la orden, el enlace a sus hermanas.

Los rótulos del menú también cambiaron, porque "Producción" y "Terminal de planta" sonaban los
dos al mismo lugar: ahora son **Órdenes de producción** (gestión), **Producir un pedido** (este
espacio) y **Terminal de planta** (una orden suelta).

**Lo que vale como criterio:** el todo-o-nada de D-147 era correcto **para una transacción** y
equivocado **para una persona** — el error de la séptima fila no invalida las otras siete, y
rehacerlas es trabajo que el sistema inventa. Y cuando una pantalla nueva obliga a volver a la
vieja para completar la tarea, no es una pantalla nueva: es medio flujo.

### D-156 — ningún campo obligatorio es un callejón

El preview del importador de cotizaciones pasa a un **acordeón por comprobante** (número,
cliente, total y estado de validación en la cabecera; las líneas al expandir, y solo se abre
solo lo que tiene algo sin resolver). Junto a cada campo que exige elegir de un maestro hay un
botón **crear** que abre **el mismo formulario de alta** —`CustomerDialog` y `ProductDialog`,
movidos a `components/`, con `initial` para prellenar lo que el archivo ya trae y `onCreated`
para devolver el registro—: mismas validaciones, mismo endpoint, y **el estado del preview no
se pierde**. Los desplegables de más de 50 opciones pasan a un modal de búsqueda con tabla,
filtro de texto y columna «Seleccionar» (`SearchSelectModal` / `SearchSelectField`).

No contradice a D-152: lo que aquella prohibió fue la creación **silenciosa** (D-138 creaba
clientes y SKUs por su cuenta y por eso terminó necesitando un purge por lote), no que se
pudiera crear algo desde el importador. La diferencia es quién decide, no dónde está el botón.
El callejón, además, tenía un costo medible: la única salida era irse al maestro y volver, con
las 141 filas revisadas perdidas, así que la conducta que el diseño premiaba era **quitar la
fila** —perder el dato— en vez de resolverla.

### Auditoría «campo sin opción = callejón»

Barrido de todos los formularios con un campo obligatorio que exige elegir de un maestro. Un
campo es **callejón** cuando la opción que falta no se puede crear sin abandonar la pantalla y
perder —o rehacer— lo cargado.

| Pantalla → campo                                    | Maestro           | ¿Callejón?                                                 | Estado       |
| --------------------------------------------------- | ----------------- | ---------------------------------------------------------- | ------------ |
| Cotización / pedido → Cliente                       | clientes          | Sí: enlace a otra pestaña, había que volver y buscarlo     | **Resuelto** |
| Cotización / pedido → Producto de la línea          | catálogo          | Sí, sin ninguna salida                                     | **Resuelto** |
| Importador de cotizaciones → Cliente                | clientes          | Sí, y perdía el archivo revisado entero                    | **Resuelto** |
| Importador de cotizaciones → Producto               | catálogo          | Sí, y perdía el archivo revisado entero                    | **Resuelto** |
| Mostrador (POS) → Cliente                           | clientes          | No: ya tenía «Crear y usar»                                | —            |
| Despacho nuevo → Pedido                             | —                 | No: un pedido no es un maestro que se dé de alta desde ahí | —            |
| Usuario → Rol                                       | —                 | No: es un enum                                             | —            |
| Compra → Proveedor                                  | proveedores       | Sí                                                         | Backlog      |
| Compra → Producto de la línea                       | catálogo          | Sí                                                         | Backlog      |
| Compra → Acabado (línea de bobina)                  | acabados          | Sí                                                         | Backlog      |
| Compra → Color                                      | colores           | Sí (`ColorSelect` no ofrece alta)                          | Backlog      |
| Orden de corte → Proveedor de corte                 | proveedores       | Sí                                                         | Backlog      |
| Orden de corte → Perfil que consume el fleje        | catálogo          | Sí                                                         | Backlog      |
| Alta de producto (`ProductDialog`) → Acabado, Color | acabados, colores | Sí                                                         | Backlog      |
| Comprobante nuevo → Cliente                         | clientes          | Sí                                                         | Backlog      |

Se aplicó el componente en los tres de mayor uso —las dos puntas del formulario de cotización y
pedido, y las dos del importador—, que son también los que más trabajo hacían perder. El resto
queda anotado: `ExpressCreateCustomer` y `ExpressCreateProduct` ya sirven tal cual para
proveedores y acabados agregando su envoltorio, y `SupplierDialog` y el diálogo de acabados ya
existen: lo único que les falta es `initial` / `onCreated`, que son las dos props que esta
sesión agregó a los de cliente y producto.

### Entorno: los puertos del dueño

`pnpm dev:preview` levanta api `:4000` + web `:4001` contra `ayr_local` (nunca contra
`ayr_local_e2e`, que la suite vacía en cada corrida) para que el dueño mire la app mientras el
agente trabaja. Es **regla dura 15**: el agente no usa ni mata esos puertos; su entorno es
`:3000`/`:3001`, que es también donde corre Playwright. El script reemplaza al
`dev-local-view.mjs` de la sesión anterior y usa el `run` de `scripts/lib.mjs` en vez de armar
su mensaje de error con `args.join(' ')` — la forma exacta que la regla dura 5 nombra como el
escape de D-128. Hoy no viajaba ninguna credencial por `argv` ahí; se cerró antes de que sí.

## Sesión Planta III (2026-09-09) — el importador se termina de asentar y producción queda en un solo lugar (D-157..D-160)

Cuatro decisiones y un tema común: **terminar de sacar los pasos que el sistema inventaba**.
D-157 y D-158 cierran el importador de cotizaciones (una cotización importada ya no nace
vencida, y el cliente que falta se da de alta desde el padrón sin salir de la pantalla);
D-159 y D-160 terminan el espacio de producción (el plan se edita ahí, el reporte llega
relleno, la bobina se elige buscando, y cerrar libera el rollo para la orden hermana en la
misma transacción) y **funden las dos entradas a producir en una sola**.

### D-157 — una cotización puede no vencer

El importador creaba las 71 cotizaciones de agosto con la vigencia por defecto —siete días—
sobre una fecha de emisión de hace un mes: **nacían vencidas**, y `confirm()` las rechazaba
una por una en el paso siguiente al que acababa de crearlas. Las tres salidas posibles eran
inventar una fecha lejana, subir la vigencia por defecto (mentirle a todo el resto del
sistema), o decir la verdad: ese comprobante ya se vendió y **no hay vigencia que respetar**.

`quotations.valid_until` pasa a nullable
(`20260909180000_d157_cotizacion_sin_vencimiento`, aditiva: aflojar un `NOT NULL` no toca
ninguna fila y el API viejo contra la base migrada sigue funcionando).
`createQuotationSchema.validityDays` acepta `null` y el importador manda `null`; el formulario
sigue exigiendo la vigencia y el PDF imprime «sin vencimiento».

**Lo que vale del cambio no es el `null` sino la función.** `validUntil < businessToday()`
escrito suelto convierte la ausencia en `'' < hoy`, o sea en «vencida desde siempre», y el
compilador no avisa nunca: las dos son comparaciones de cadenas perfectamente válidas. Por
eso hay **una sola** función que responde la pregunta —`isQuotationExpired(validUntil, hoy)`
en `@ayr/shared`— y los lugares que la hacían pasan por ella: la confirmación del pedido
(`sales-orders.service.ts`), el estado efectivo del listado y del PDF, el `isExpired` del DTO
y la reapertura de la cotización al anular su pedido. El job diario ya las excluía solo, y no
por diseño: `valid_until < cutoff` es `NULL` en SQL cuando la columna lo es, y `NULL` no es
verdadero. Queda anotado en el código para que nadie le agregue un `OR IS NULL` de más.

### D-158 — el padrón en el importador, y el cliente es del comprobante

Dos cambios de la misma pantalla.

**(a) El alta desde el padrón.** Cuando el RUC/DNI del archivo no está en el maestro, el
preview consulta apis.net.pe —el mismo servicio de D-029/D-067, con `MAX_PADRON_LOOKUPS = 80`
y concurrencia 6, porque la cuota es una sola para todo el sistema— y la cabecera del
comprobante muestra **«Nuevo — se creará desde padrón: \<razón social\>»**. Al confirmar, el
cliente se crea con `CustomersService.createInTx` (extraído con el patrón `*InTx`, D-099)
**dentro de la transacción del archivo**: si el archivo no entra, no queda ningún cliente
suelto en el maestro.

Es una **excepción controlada** a la regla de D-152, y lo que la separa de la creación
silenciosa de D-138 son tres cosas concretas: está a la vista antes de apretar, con nombre y
documento; la decide una persona, que puede elegir otro cliente en el mismo campo; y **lo que
se escribe no lo elige el navegador**. Esto último es lo que costó pensar: la fila manda al
servidor **solo el documento**, nunca la razón social. Con el nombre en el request, editar el
cuerpo alcanzaba para dar de alta «PROVEEDOR S.A.C.» bajo un RUC ajeno. Las consultas al
padrón se resuelven **antes** de abrir la transacción —hasta 48 llamadas de 5 s cada una— y si
falta una sola, no se importa nada y esa fila se resuelve con el alta express de D-156.

**(b) El cliente sube a la cabecera.** Una factura es de un solo cliente, y sus diez líneas lo
heredan. Pedir el mismo dato diez veces no era redundancia: era **la única forma de armar un
documento imposible**, y el API lo rechazaba con un error que la pantalla no sabía atribuir a
ninguna fila. Cuando el archivo trae textos de cliente distintos dentro del mismo comprobante,
la cabecera lo dice y se importa con el de arriba.

De paso, el **plan de corte llega relleno** con la sugerencia `1 × los ML de la línea`
(`suggestedRoofingPlanText`). No vuelve válido lo que no lo es —una línea de 81.9 m sigue sin
caber en una plancha de 20 y la celda lo dice—: lo único que cambia es que corregirla sea
editar un número en vez de transcribir la cifra del papel. La regla de D-152 sigue viva y
`defaultRoofingPlan` sigue siendo su centinela, con su test.

### D-159 — el espacio de producción v2

Cuatro cambios sobre el panel de una orden, y el que los obliga a todos es de dominio:

1. **El plan de corte se edita desde el panel** — cantidad y largo en una cobertura a medida,
   **solo cantidad** en una plancha de catálogo, donde el largo lo trae el SKU (D-118) y
   volver a pedirlo es ofrecer un campo cuya única respuesta correcta el sistema ya conoce.
   Hasta acá corregirlo obligaba a irse a la terminal, que era la otra mitad del flujo.
2. **Montar la bobina rellena el reporte con los largos que el plan todavía debe.** El campo
   único de metros/planchas desaparece: el caso normal es rolar lo que el pedido pide, y
   transcribirlo largo por largo era trabajo que el sistema inventaba. Las líneas quedan
   editables y **se pueden borrar** — lo primero que hace quien roló la mitad es sacar las que
   no salieron.
3. **El selector de bobina es un modal de búsqueda con tabla** (código, espesor, color, kg
   disponibles, «Montar»), reusando el `SearchSelectModal` de D-156 con columnas. Lo que
   decide cuál montar no es un nombre sino cuatro cifras que hay que **comparar entre filas**,
   y una lista de tarjetas apiladas no se compara: se recorre.
4. **«Guardar» y «Guardar y cerrar».** El segundo es
   `POST /production/roofing/:id/report-and-close`, que corre `reportInTx` + `closeInTx`
   (extraído acá) en **una transacción**. Cuando lo que se va a reportar cubre el plan, es el
   botón destacado.

**El caso que obliga al cierre atómico**: un pedido de coberturas genera una OP por línea
(D-084/D-148) y todas se rolan **del mismo rollo**, pero mientras la primera siga abierta con
la bobina montada, `assertStripsNotAssigned` no la deja montar en la segunda. Producir un
pedido de cuatro líneas obligaba a cerrar cada orden desde otra pantalla antes de seguir. Y
partido en dos endpoints, el cierre podía fallar con el reporte ya escrito.

El motivo del despunte (D-089) se pide **antes** de mandar cuando la pantalla estima que el
API lo va a exigir; como la estimación puede quedarse corta —el API suma reporte a reporte y
la pantalla solo tiene los totales—, el 400 sigue teniendo su camino de vuelta al mismo
diálogo. Está anotado en el código como lo que es: una estimación, no la regla.

### D-160 — una sola entrada a producción

`/planta` (terminal) y `/planta/producir` (espacio del pedido) se funden en **`/planta`**, con
filtro por pedido (`?pedido=`) o todas las órdenes abiertas, y con las dos clases de orden en
el mismo selector: la de coberturas abre el panel de D-159 y la de drywall el de piezas.
Crear una orden deja de ser el paso 1 de la pantalla y pasa a una sección que se despliega —lo
que se hace todos los días es producir lo que ya está abierto—.

El sidebar queda con **Producción** (producir) y **Órdenes de producción** (gestionar).
`/planta/producir` y `/planta/tanda` quedan como redirecciones conservando `?pedido=`.

El detalle de la orden (`/produccion/:id`) queda de **lectura más corrección** —anular,
revertir un reporte, reabrir— y **pierde el cierre**, que era lo único que estaba en los dos
sitios; sus dos enlaces a planta se unifican en «Producir esta orden», que lleva a `/planta`
con la orden enfocada.

**Lo que vale como criterio:** D-155 había intentado arreglar esto **con los rótulos**
—«Producir un pedido» contra «Terminal de planta»— y el problema no era de nombres. Eran dos
pantallas que hacían lo mismo con la mitad de las herramientas cada una: la terminal montaba y
cerraba pero no mostraba las hermanas del pedido; el espacio mostraba las hermanas pero no
cerraba. Cuando dos pantallas comparten el objeto y se reparten los verbos, no son dos
pantallas: es una partida al medio, y el rótulo no la junta. El corolario sobre el cierre
duplicado es más fino: dos botones que hacen lo mismo en dos sitios terminan divergiendo en lo
que validan **antes** de llamar al API, que es donde vive la mitad de la lógica de una
pantalla.

### Lo que la revisión encontró y se corrigió

Dos pasadas del revisor —API/`shared` y web por separado, que es la separación que ya había
pagado antes— sobre el trabajo sin commitear. Un bloqueante del web, un alto del API y cuatro
altos del web, más una docena de medios y bajos.

**Los dos que rompían el flujo principal.**

1. **«Guardar y cerrar» mandaba lo que había apretado el botón anterior.** El flag que decide
   si el envío cierra la orden vivía en un `useState` que el manejador seteaba y **leía en el
   mismo tick**: React no lo ve hasta el render siguiente, así que el primer clic en «Guardar
   y cerrar» pegaba a `POST /report` —la orden quedaba abierta con la bobina montada, o sea
   justo la atomicidad que D-159 vino a dar— y el clic siguiente en «Guardar» cerraba la orden
   que nadie quiso cerrar. Los dos datos que deciden el envío (cerrar o no, y el motivo del
   despunte) pasaron a `useRef`; el estado quedó solo para el rótulo del botón, que sí se
   pinta en el render siguiente.
2. **El importador se caía en render al tipear una coma.** La sugerencia del plan llamaba a
   `toDecimal(qty)` sin guarda, dentro del `useMemo` que arma las 141 filas: una coma del
   teclado latino en una cantidad lanzaba, la pantalla se caía y **se perdía el archivo
   revisado entero** — el callejón exacto que D-156 vino a sacar, reaparecido por otra puerta.
   Toda comparación de cantidad pasa ahora por `isNumeric`, que corta antes de `toDecimal`.

**Los altos.**

- **Un cliente desactivado con el mismo RUC volvía un 500.** `createFromPadron` buscaba por
  `(docNumber, isActive)` y el índice único de la tabla es `(doc_type, doc_number)`: el
  preview no ve al desactivado —filtra activos—, el padrón sí devuelve el documento, y el alta
  chocaba con un `P2002` que nadie traduce, porque esto corre **antes** del bucle de savepoints
  y por lo tanto fuera del `try` que atribuye errores por documento. Ahora se busca por el par
  único, un desactivado se dice con su nombre en vez de reventar, y el `P2002` de dos
  importaciones simultáneas tiene su propio mensaje.
- **`validityDays: null` se coló en el schema público.** `createQuotationSchema` es también el
  cuerpo de `POST`/`PUT /sales/quotations`: cualquier vendedor podía crear una cotización que
  no vence nunca, que el job no marca y que `confirm()` no rechaza — lo contrario de D-069.
  El `null` volvió a quedar fuera del schema y viaja por un tipo interno que solo acepta
  `createInTx`.
- **Una orden que produjo menos que su plan no se podía cerrar desde ninguna pantalla.** El
  cierre suelto estaba atado a «plan cubierto» y el detalle de la orden ya no cierra (D-160),
  así que el caso más común de todos —la bobina se acaba a los 28 m de un plan de 40— dejaba
  como únicas salidas bajar el plan a mano o reportar 12 m que nadie produjo. El botón existe
  ahora siempre que la orden haya producido algo; el API nunca había exigido el plan cubierto.
- **El `consumedKg` del cierre (D-089) había desaparecido con la terminal**, y con él las dos
  cotas que el API comprueba dentro de la transacción. Volvió como campo propio del cierre,
  con sus cotas y el despunte a la vista, separado del kg declarado **por reporte** (D-146),
  que es otra cosa.
- **`?op=` se descartaba con la caché fría.** El efecto que elige la pestaña no distinguía «no
  hay órdenes» de «todavía no cargaron», así que llegar desde el detalle de una orden abría la
  primera de la lista, y crear una orden abría otra. El efecto no corre mientras las consultas
  viajan, y `?op=` se re-lee cuando cambia.

**De los medios y bajos**, los que valen la pena nombrar: una orden **sin plan de corte** se
mostraba como «Reportada» y contaba en la barra de progreso sin haber producido nada (tiene
`remainingMeters = 0.000`, igual que una cubierta) — ahora tiene su propio estado; las líneas
**excluidas o quitadas** del importador podían imponerle su cliente al comprobante; el editor
se re-sembraba con el DTO viejo entre guardar y el refetch, invitando a duplicar el reporte;
el asiento del cierre repetía en el `audit_log` los faltantes que ya había anotado el del
reporte; y el motivo del despunte sobrevivía a un envío fallido para justificar el siguiente.

**Lo que la revisión confirmó que no se perdió** al borrar la terminal y la vista de la tanda:
el tope duro del plan, la validación y el aviso del kg declarado, el tope de bobinas por
orden, el bloqueo de bajar una bobina que ya roló, los avisos de faltante de materia prima y
las cotas de las tarjetas de alta. Y que D-157 está completo: los cuatro lugares del API que
comparan el vencimiento pasan por `isQuotationExpired`, y ni el mostrador, ni la facturación,
ni los reportes tocan el campo.

### E2E

Los tres specs de planta se renombraron —su nombre nombraba una ruta que D-160 borró—:
`planta-producir-ui` → `planta-espacio-produccion-ui` (reescrito entero),
`planta-producir` → `planta-espacio-produccion` y
`planta-producir-avisos` → `planta-avisos-materia-prima`. `import-cotizaciones-ui` también se
rehízo (acordeón, cliente en la cabecera) y `fase7e-ajustes-d121` dejó de buscar el código de
la OP como `<h1>`: el encabezado de `/planta` ahora es «Producción».

**El caso que el dueño pidió y que justifica «Guardar y cerrar»**: un pedido de dos líneas a
medida, sus dos OP, montar la bobina en la orden 1, guardar y cerrar, y montar **la misma
bobina** en la orden 2 **sin salir de la pantalla** —lo que hasta esta sesión rechazaba
`assertStripsNotAssigned` mientras la primera siguiera abierta—, reportar y cerrar. El kardex
se verifica en las dos puntas: 40 m y 30 m de producto, y la bobina en 1 720 kg
(2 000 − 160 − 120).

Se cubrió además el sembrado del reporte al montar, borrar una línea sembrada antes de
confirmar, el plan de corte editado desde el panel en sus dos formas (largos en «a medida»,
sola cantidad en una plancha `NIU`), el modal de bobinas con su filtro, el cierre «sin
reportar más» con su kg declarado y su despunte, y **D-157** por API: una cotización importada
de un papel de marzo nace con `validUntil: null`, se emite sin degradarse a `VENCIDA` y se
confirma.

**Lo que no se pudo probar**: el badge «Nuevo — se creará desde padrón» (D-158). El entorno
local no tiene token de apis.net.pe, así que todo documento desconocido cae en la rama del
error normal. No se montó un mock: probaría el mock.

**Un spec en rojo que no era de esta sesión.** `fase5a-bordes` —que la sesión de D-154 no
corrió— tenía un caso que codificaba **el comportamiento que D-154 vino a quitar**: «no se
confirma una cotización cuya única bobina compatible quedó montada en una orden de producción
ajena». Con D-154 esa confirmación **entra**, y tiene que entrar: el rollo tiene 1 000 kg y la
orden que lo montó prometió 200, así que hay 800 libres de verdad. Bloquearla era el mismo
defecto que, mirado desde planta, disparó D-154 («la operación dejaría 0.000 kg libres» sobre
una bobina llena). El caso se reescribió para codificar la separación que quedó: **el material
se promete por lo prometido** —el panel muestra 800 y el pedido de otro cliente confirma— y lo
que sigue reservado es **la agenda**, o sea que la OP del segundo pedido no puede montar la
bobina que la primera tiene puesta (`assertStripsNotAssigned`, con el 400 nombrando la orden
que la retiene). Se le sumó un tercer pedido de 1 000 kg que **sí** rebota, para que el caso
siga probando que el agregado corta cuando el faltante es real. Verificado que no venía de
esta sesión: ningún archivo del camino de disponibilidad se tocó, y el último cambio de
`production-assignments.ts` es el commit de D-154.

**Dos defectos que la escritura de los E2E encontró en la pantalla, y que se corrigieron:**

1. **«Cerrar sin reportar más» validaba los kilos contra un reporte que ese botón no manda.**
   El piso del consumo declarado se calculaba una sola vez, con los largos del editor sumados
   — y el editor **se re-siembra solo** con el plan que falta. Escenario medido: plan de 36 m,
   se reportan 30 (120 kg teóricos), el editor vuelve a mostrar las dos planchas que faltan, y
   declarar los 130 kg que la bobina de verdad consumió respondía «las planchas reportadas ya
   consumieron **144.000** kg» y apagaba el botón. O sea: el caso que el botón vino a resolver
   quedaba bloqueado. Ahora cada cierre tiene su propio piso (`closeOnly` / `closeWithReport`)
   y cada botón valida contra el suyo.
2. **La ✕ de la única fila estaba apagada**, así que vaciar el editor obligaba a borrar el
   largo y la cantidad campo por campo. Vacía la fila en vez de sacarla —el editor siempre
   muestra al menos una—, que es lo que el rótulo ya decía.

### Archivos que dejaron de existir

`apps/web/src/app/(app)/planta/roofing-terminal.tsx` y
`apps/web/src/app/(app)/planta/producir/producir-view.tsx`. En su lugar: `planta-view.tsx` (el
workspace), `roofing-order-panel.tsx`, `drywall-order-panel.tsx`, `coil-picker.tsx`,
`new-order-cards.tsx` y `components/production/length-editor.tsx` — el editor de largos, que
ahora usan el plan y el reporte y por eso salió de la terminal.

## Sesión Precios (2026-09-09) — la plancha por metro, valor contra precio y el piso que no existía (D-161..D-163)

### M0 — La plancha de catálogo se cotiza por metro lineal (D-161)

El defecto: una plancha se cobraba `cantidad × valor unitario` con un valor que el vendedor
pensaba **por metro**. Diez planchas de 3.60 m a S/ 7.00 el metro salían **S/ 70.00** en vez de
S/ 252.00 — 3.6 veces menos, que es exactamente el largo del SKU.

Lo que se descartó importa tanto como lo que se hizo. La forma "natural" era pasar la línea a
metros, como una cobertura a medida: cantidad 36.000 MTR, valor unitario 7.0000. **No se
hizo**, y el motivo es de dominio: el kardex, la reserva, la producción y el despacho de una
plancha están en **planchas** (`roofing-production.service.ts` reporta `piecesCount(pieces)` a
stock para todo lo que no es a medida). Meter la línea en metros obligaba a derivar la reserva
y a que un SKU en `NIU` llevara subítems de largo — que es justo lo que la regla dura 14
(D-131) prohíbe, y por la puerta de atrás.

Lo que quedó: la línea sigue en `NIU`, viaja un campo nuevo y explícito (`valuePerMeterPen`) y
el API calcula `unitPricePen = largo del SKU × valor por metro`. Los dos son un decimal en
soles y el compilador nunca avisaría de la confusión, así que **son dos campos y mandar los dos
es un 400** del schema.

En la cotización, el bloque nuevo es el espejo del plan de corte de D-159: **largo bloqueado
con el del SKU, solo la cantidad editable, sin botón para agregar filas** (una plancha de
catálogo tiene un largo y uno solo). El campo de cantidad de la fila queda de solo lectura,
igual que en una línea a medida.

La familia de predicados de D-131 pasa a **tres**, y las tres devuelven `boolean`:

| Pregunta                                              | Función              | La decide                                                     |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| ¿La línea necesita el detalle de largos?              | `sellsByLength`      | la **unidad** (`MTR`)                                         |
| ¿Se fabrica contra pedido desde bobina?               | `isMadeToMeasure`    | el **subtipo** (`A_MEDIDA`)                                   |
| ¿El precio se negocia por metro contra un largo fijo? | `sellsByFixedLength` | el **subtipo y el largo juntos** (`PLANCHA` + `lengthMm > 0`) |

`sellsByFixedLength` pide **dos** campos a propósito: una plancha sin largo en el catálogo
—las hay, ver `roofing-catalog-report.ts`— cae en el camino viejo en vez de multiplicar por
cero y dejar la línea en S/ 0. El centinela `sales-lines.spec.ts` se amplió a la tabla de las
tres y a los tres pares cruzados; el par más peligroso es `sellsByFixedLength` contra
`isMadeToMeasure`, que miran el **mismo** campo y dan lo contrario.

Migración `20260909210000_d161_plancha_por_metro_lineal`, aditiva: `value_per_meter_pen`
nullable en `quotation_items` y `sales_order_items`. **Nada se recalcula** — lo histórico y lo
que carga el importador quedan como están.

### M1 — Valor contra precio, y el piso que la página de márgenes prometía (D-162, D-163)

**Lo que estaba vivo, medido antes de tocar nada:** la fórmula era **markup**,
`costo × (1 + margen)`, en `suggestedPrice`/`minAllowedPrice` de
`packages/shared/src/schemas/pricing.ts`. Y **`minAllowedPrice` no tenía un solo llamador fuera
de su propio test**: D-032 escribía la regla —«un VENDEDOR no puede bajar del margen mínimo»— y
no la aplicaba en ninguna parte. La página `/configuracion/margenes` guardaba dos números que
nadie leía.

**D-162 — el vocabulario.** «Valor de venta» es **sin** IGV; «precio de venta» es **con** IGV.
La fuente de verdad interna no se movió: `unit_price_pen` y `subtotal_pen` siguen siendo
valores, que es sobre lo que factura SUNAT, y no se migró un dato. Lo que cambió es que en la
cotización y el pedido se **tipea el precio con IGV** —el número que el vendedor le promete al
cliente— y el valor se deriva y se muestra debajo. Mientras las dos palabras fueron sinónimas,
el vendedor tipeaba lo acordado bajo el rótulo «P. unitario» y el documento salía 18% más caro.

La traducción vive en `packages/shared/src/tax.ts`, módulo **hoja**, junto con `IGV_RATE_PCT`,
que se mudó ahí desde `schemas/sales`. Es por D-130: `schemas/pricing` lo necesita y se carga
**antes** que `sales` en el índice; el ciclo en CommonJS no lanza, deja `undefined` y borra el
factor en silencio.

**D-163 — el piso duro.** `mínimo = costo promedio del kardex ÷ (1 − margen mínimo) × 1.18`,
con el **margen mínimo** (el margen a secas queda como objetivo sugerido). Es un cambio de
política comercial y los mínimos suben: con 20% sobre un costo de 100, el markup daba 120 y
dejaba un margen real del 16.67%; la fórmula nueva da 125.

Tres cosas que decidieron la forma, y que valen para la próxima:

1. **Se compara valor contra valor, no precio contra precio.** El valor guardado es el precio
   dividido por 1.18 y redondeado a cuatro decimales. Comparando precios, tipear **exactamente**
   el mínimo que la pantalla muestra podía caer una diezmilésima por debajo y rebotar — el caso
   del borde, que es justo el que el usuario prueba. El precio con IGV aparece solo en el
   mensaje.
2. **Sin costo no hay piso.** Un SKU que nunca entró al kardex tiene costo cero. Bloquear con
   «el mínimo es S/ 0.00» no protege ningún margen y sí impide cotizar un producto nuevo.
3. **El mismo código calcula el piso que se muestra y el que rechaza.** `computePriceFloors`
   alimenta el panel de stock del formulario y `assertPriceFloor` lo usa para tirar el 400. Que
   fueran dos cuentas era garantizar que la pantalla prometiera un mínimo y el `POST` exigiera
   otro.

Alcance: alta, edición y **duplicado** de cotización, y pedido directo. **Para todos los
roles, incluido el ADMINISTRADOR**: D-032
dejaba la excepción por línea y D-163 la cierra, porque una excepción por línea no queda en
ningún lado y un cambio de margen sí queda auditado. Quedan **exentos por código**: lo que importa D-152 —y también
su edición, ver más abajo— por la misma razón por la que su cotización no vence (D-157), y el
**mostrador**, que se decidió dejar afuera durante la revisión.

El costo de una cobertura **a medida** no puede salir de su SKU —no tiene saldo hasta que
planta lo rola— así que sale de la bobina: `kg por metro × costo por kg **ponderado por
kilos** del agregado compatible`. El promedio simple habría corrido el piso hacia el rollo más
chico: con 900 kg a S/ 4.00 y 100 kg a S/ 8.00, el ponderado es 4.40 y el simple 6.00.

**Contrapartida asumida y anotada:** el piso viaja al formulario (`minPricePen` en
`ProductStockDto`), y de él se puede despejar el costo, porque el margen lo lee todo el equipo
comercial. Es el precio de que el vendedor vea su piso antes de tipear en vez de descubrirlo
chocando contra un 400.

El margen se acota a **menos de 100%** en el schema (es sobre la venta: 100% es una división
por cero) y una fila vieja fuera de rango rebota con un mensaje legible en vez de un 500.

### M2 — Cierre de bobina con ajuste de remanente: **el flujo no existe** (sin implementar)

Verificado y **reportado al dueño sin tocar nada**, como pedía el alcance. Estado real:

- `CoilOperationsService.setStatus` (RF-19) cambia `coils.status` a `CLOSED` y **no mueve
  kardex**. El comentario del código lo dice explícitamente: «cerrar tampoco mueve kardex, así
  que la invariante de cantidad no lo ve». El saldo remanente queda en `inventory_balances`
  para esa bobina, indefinidamente.
- La herramienta para liquidarlo **sí existe pero es un acto aparte**: `registerScrap` (RF-17)
  escribe un `OUT` con `refType: 'SCRAP'` valorizado al costo promedio vigente, vía
  `InventoryService.record`. En la UI son dos botones vecinos y sin relación: «Registrar merma»
  y «Cerrar».
- Nada avisa del remanente al cerrar, nada lo exige, y una bobina cerrada con saldo positivo
  sigue sumando kilos y valor al inventario valorizado.

**Propuesta para el OK del dueño** (no implementada): que «Cerrar» pregunte por el remanente
cuando el saldo sea distinto de cero y ofrezca liquidarlo **en la misma transacción**, como un
movimiento propio vía `InventoryService.record` —`OUT` si sobra material teórico
(merma/despunte), `IN` si el conteo real da de más (sobrante)—, con motivo obligatorio y
`operationDate` (D-124). Nunca una edición del saldo: append-only (regla dura 2). Queda por
decidir el `refType` (`CLOSE_ADJUSTMENT` nuevo, distinguible del `SCRAP` de RF-17 para que su
anulación no se confunda, que es el mismo cuidado que ya obligó a separar la merma de proceso
del cierre de OP en `cancelScrap`) y si el ajuste positivo necesita permiso de ADMINISTRADOR.

### M3 — Pulido de formularios

- **El botón ancho de «Agregar otro largo» pasa a un `+` al costado de la última fila**, en
  `components/production/length-editor.tsx` (plan de corte y reporte del espacio de producción)
  y en el editor de largos de la cotización. Medía lo mismo que los dos campos juntos y se leía
  como un campo más de la fila siguiente. Queda alineado con la ✕, que es la acción gemela, y
  las filas que no son la última llevan un hueco del mismo ancho para que la ✕ no se desalinee.
- **El `+` funciona también con el editor vacío**: como vive al costado de la última fila, una
  lista sin filas lo dejaba inalcanzable. Hoy ningún llamador pasa un array vacío, pero antes
  esa invariante no hacía falta y ahora sí, así que la sostiene el propio editor.
- **El campo de largo del espacio de producción deja de ser `flex-1`** y pasa a `w-32`, el mismo
  ancho que la cantidad: es un número de cuatro caracteres y estirado ocupaba casi todo el
  contenedor.
- Barrido de rótulos de D-162 en cotización, pedido, comprobantes, el importador y el PDF de
  cotización («P. unit.» → «Valor unit.», «Subtotal»/«Total» del pie → «Valor de venta»/«Precio
  de venta»). Las compras **no** se tocaron: su «precio unitario sin IGV» es un precio de compra
  y la regla de D-162 es sobre la venta.

### Lo que la revisión encontró y se corrigió

Dos pasadas de `revisor` sobre el diff. Dos bloqueantes, cuatro altos y una docena de menores.
Los que importan:

**Bloqueante 1 — el precio mínimo que se mostraba no era tipeable.** El piso se compara en
**valor** (cuatro decimales) y se muestra en **precio** (dos, que es lo que una persona
tipea). Recortando el precio hacia abajo, tipear exactamente el número de la pantalla daba un
valor por debajo del piso y el sistema respondía «sube el precio» sobre el precio que él mismo
acababa de pedir. Medido con las funciones reales: costo 17.50 y 10% de mínimo → se mostraba
S/ 22.94, que vuelve como 19.4407 contra un piso de 19.4444. **Pasaba en cerca de la mitad de
las combinaciones costo/margen**, y es el mismo callejón sin salida que D-156 vino a cerrar.

La corrección no fue redondear hacia arriba y confiar. `minTypeablePrice` **prueba el
candidato contra la cadena de vuelta** —la misma función que convierte lo tipeado en el valor
guardado— y sube de a un céntimo hasta que alcanza. Es la única forma de que el número no
dependa de cuántos redondeos haya en el camino, que en una plancha son tres.

El test que debía haberlo cazado existía y no podía fallar: partía del precio con **cuatro**
decimales, que es lo que ningún vendedor tipea, y comparaba con `Number` y una tolerancia de
`0.0001` —exactamente la diezmilésima que decía vigilar— en un test sobre precisión Decimal.
Se reemplazó por una tabla de cinco combinaciones que tipea el mínimo mostrado y verifica que
pase, más el céntimo de abajo que tiene que bloquear.

**Bloqueante 2 — el cartel de rechazo de una plancha mostraba el mínimo por plancha rotulado
«por metro»**: el mismo factor ×largo que D-161 vino a corregir, reintroducido en el mensaje
de error. El renglón de ayuda debajo del campo sí convertía, así que la pantalla mostraba dos
números que decían ser lo mismo y diferían 3.6 veces. La conversión salió del web: el piso
viaja **ya expresado en la unidad en la que se tipea** (`PriceBasis`), y el web solo lo pinta.

**Alto — una cotización importada nacía exenta del piso pero no se podía volver a guardar.**
El importador crea en borrador y `update` aplicaba el piso sin excepción: corregir el producto
de una línea en una de las 71 de agosto rebotaba con «el precio mínimo es S/ X» sobre una
línea que nadie tocó. La exención pasó a ser del **documento** y no del momento: la marca de
D-152 (`EXTERNAL_INVOICE_NOTES_PREFIX`) se mudó a `@ayr/shared` con la función que la lee, y
la edición de una importada hereda la exención igual que hereda no vencer (D-157).

**Alto — `sellsByFixedLength` ignoraba la unidad.** El CHECK de la base solo prohíbe que una
`PLANCHA` esté en `MTR`, así que una en `KGM` o `MTK` es legal y el catálogo la admite a
propósito (SKU legados). Para ese SKU el formulario pasaba a pedir «Planchas» y precio «por
metro», y el importe salía multiplicado por el largo. Es la regla dura 14 mirada al revés —una
pregunta sobre la aritmética de la unidad respondida con el subtipo— así que el predicado pide
ahora los **tres** campos y el centinela cubre la combinación.

**Alto — el mostrador quedaba bloqueado por precios que hoy funcionan.** El POS siembra el
precio de lista y comparte `createDirectInTx`, así que heredaba el piso. Como D-163 **sube**
los mínimos respecto de D-032, todo SKU cuyo precio de lista quedó entre el piso viejo y el
nuevo dejaba de venderse en caja — y el cajero lo descubriría al cobrar, con el cliente
delante, tirando abajo la transacción entera de D-099 (pedido, despacho, comprobante y cobro).
**El mostrador quedó exento**, con el flag `counterSale` que ya existía. Antes de esta sesión
tampoco tenía piso, así que no abre nada que no estuviera abierto; ponerlo sí rompía algo que
funciona. **Queda para el dueño**: si quiere piso en caja, hay que mostrar el mínimo en el
carrito y medir antes cuántos SKU activos quedan por debajo.

**Otros que se corrigieron:** el valor por metro no llegaba al PDF —justamente el papel que el
cliente compara—; la venta de bobina entera tenía piso en el API y ningún aviso en la pantalla
(ahora el mínimo por kg viaja en `/sales/sellable-coils`); el bloque de totales del propio
formulario de D-162 seguía diciendo «Subtotal»/«Total»; el mostrador seguía rotulando «Precio
sin IGV», que bajo el vocabulario nuevo es una contradicción; `chooseProduct` conservaba el
precio al cambiar a un producto que se negocia en **otra** unidad (antes era un rótulo
desactualizado, con D-161 es un factor de 3.6); el panel de stock resolvía el agregado dos
veces por SKU a medida; el `+` del editor de largos quedaba inalcanzable con la lista vacía; y
el docstring de `stock-panel` seguía diciendo «sin ningún costo», que dejó de ser cierto.

### Lo que la escritura de los E2E encontró

`e2e/tests/precios-d161-d163.spec.ts` (nuevo, diez casos): la plancha por metro con su
propagación al pedido y al despacho, la plancha y la a-medida **lado a lado** dando el mismo
importe con distinta unidad, los dos rechazos de `valuePerMeterPen` (junto al unitario y sobre
un producto que no es plancha con largo), el contrato del API en valores sin IGV, el piso leído
del panel de stock, el mínimo exacto y el céntimo de abajo, **tipear el mínimo que muestra la
pantalla**, el mostrador vendiendo por debajo del costo sin rebotar y la cotización importada
que entra bajo el piso y se puede volver a guardar.

Dos detalles del método que valen para la próxima: el caso del mínimo tipeable usa el costo
17.50, que es la combinación que destapaba el defecto —con redondeo simple la pantalla decía
22.94 y el API exigía 22.95—, así que **el test se cae si alguien vuelve a redondear y
confiar**; y la conversión precio→valor del test se hace con enteros (`P céntimos ÷ 118`,
half-up) y no con `Number(p) / 1.18`, porque el caso vive en la cuarta decimal y un ulp de coma
flotante lo volvería verde por accidente.

**Un defecto que apareció escribiéndolos, y se corrigió:** `PUT /sales/quotations/:id`
reemplazaba las observaciones con lo que viniera en el cuerpo, **y con ellas la marca de
procedencia** del comprobante externo. Como de esa marca dependen el aviso de reimportación
(D-152) y la exención del piso (D-163), editar una cotización importada sin reenviar las
observaciones la dejaba sin marca — y el **segundo** guardado, con el mismo precio histórico,
rebotaba contra el piso. Un documento que se vuelve inválido por haberlo guardado dos veces.
La marca la conserva ahora `keepImportMarker`: es procedencia y no un texto que alguien
escribió, así que sobrevive a la edición y lo que se recorta al tope de la columna es el texto
del vendedor, nunca la marca. Hoy no hay ningún formulario que llame a ese `PUT` —el único
camino es HTTP directo— así que el defecto no llegó a producción; era una trampa puesta para el
primer formulario de edición que se escriba.

**Sin cubrir:** el piso por kg de la venta de bobina entera (`minPricePen` en
`/sales/sellable-coils`). Está implementado y probado en unitarios, pero montar una bobina
vendible entera en E2E cuesta una compra `COIL` más y no entró en esta tanda.

### Verificación

`pnpm turbo lint typecheck test` en verde (**341/341** unitarios, 22 suites), `prettier --check`
y `eslint e2e` limpios. Tests nuevos: la tabla de tres predicados y sus pares cruzados
(`sales-lines.spec.ts`), la plancha y la a-medida **lado a lado** con el mismo importe
(`sales-math.spec.ts`), la conversión valor⇄precio con el caso `10.00 → 8.4746`, la marca de
procedencia que sobrevive a una edición (`quotation-import.spec.ts`), y el piso con sus casos de
borde en `price-floor.spec.ts`: exactamente en el mínimo pasa, un céntimo abajo bloquea, sin
costo no hay piso, el agregado ponderado por kilos, y **el mínimo que se muestra es tipeable**
en cinco combinaciones costo/margen — que es el defecto que la revisión encontró.

**E2E local.** La suite completa dio **183 pasados, 20 fallos y 2 saltados**, y de los 20 solo
**dos** eran de esta sesión: dos fixtures que vendían por debajo del costo —una pieza de S/ 96
de costo vendida a S/ 10 en el caso de fechas de operación, y S/ 20 de costo a S/ 10 en el del
disponible del mostrador—. En los dos el precio era un número arbitrario en un caso que habla de
otra cosa, así que se subieron por encima del piso con el comentario de por qué ahora importa.

Los otros 18 son los dos bloqueos ya conocidos y ajenos a esta sesión: **nueve** por
`409 Ya existe un proveedor con ese documento` —la base `ayr_local_e2e` envejecida, anotada
abajo en Notas operativas— y **nueve** por `No puedes enviar mas de 50 documentos en una cuenta
DEMO`, el cupo de la cuenta demo de Nubefact.

`pnpm e2e precios-d161-d163` → **10/10**, dos corridas seguidas.

## Sesión Cierre de bobina (2026-09-09) — el remanente se liquida y la merma normal entra al estándar (D-164, D-165)

Las dos decisiones son una sola idea partida en dos: **separar la merma normal de la anormal**.
D-165 mete el 1 % que toda corrida pierde adentro de la densidad estándar, así que deja de ser
una sorpresa; D-164 hace que lo que quede por encima de eso salga del inventario al cerrar la
bobina, en vez de quedarse ahí para siempre. Ninguna de las dos sirve sola: sin D-165 el
remanente mezclaba dos cosas y no medía nada, y sin D-164 el 1 % bien calculado igual dejaba
kilos fantasma en el valorizado.

### M0 — El cierre de una bobina liquida su remanente (D-164)

**El defecto.** `CoilOperationsService.setStatus` (RF-19) cambiaba el estado a `CLOSED` y **no
movía un gramo de kardex**. El saldo teórico que quedaba en `inventory_balances` se quedaba ahí
indefinidamente: la bobina cerrada desaparecía de producción y del partido, pero **seguía
sumando kilos y valor al inventario valorizado** de material que ya no existe, y nada avisaba.
La única herramienta era la merma de RF-17 (`registerScrap`), un acto aparte, en un botón
vecino y sin ninguna relación con el cierre.

**La forma.** Cerrar pide ahora **cuántos kilos quedan de verdad** (`physicalKg`) y liquida la
diferencia contra el saldo, en la misma transacción, por el único camino que el kardex admite
(`InventoryService.record`, regla dura 2) y nunca editando el saldo:

- `apps/api/src/coils/coil-close-math.ts` — la aritmética pura, aparte del servicio como
  `coil-split-math.ts`, con su spec de siete casos.
- `refType` propio **`CLOSE_ADJUSTMENT`** (migración `20260909230000_...`, aditiva) y su
  rótulo «Cierre de bobina» en el kardex.
- `CoilDto.avgCostPen` — el promedio vigente del saldo, para poder mostrar el remanente
  **valorizado** con el mismo número con el que el kardex lo va a sacar.
- `apps/web/.../coil-close-dialog.tsx` — el diálogo muestra kg y soles antes de confirmar.
- Reabrir revierte el ajuste con un movimiento inverso, **solo si es el último movimiento vivo
  del rollo** (ver «Alto 1» más abajo: la primera versión decía «el último ajuste vivo» y eso
  creaba inventario de la nada). `cancelScrap` (RF-18) lo rechaza a propósito: es el mismo
  corte que D-057 ya había tenido que hacer para la merma de proceso de una OP.

**Tres decisiones que no eran obvias.**

1. **Se tipea cuánto queda, no cuánto se da de baja.** Es lo que planta ve mirando el rollo, y
   con un solo campo quedan cubiertos los dos sentidos: sobra saldo teórico → `OUT` (merma
   anormal), el conteo da de más → `IN` (sobrante). Preguntar «cuántos kilos mermar» obligaba a
   un segundo formulario para el sentido contrario.
2. **El kardex se mueve ANTES de marcar `CLOSED`.** `assertRawMaterialInvariant` lee el
   agregado desde la base: con la bobina ya cerrada, la salida se comprobaría contra un
   agregado que **acaba de perder ese rollo entero** y rechazaría por kilos que el propio
   cierre sacó de la vista. Es el mismo orden que ya respetaba el partido.
3. **`registerScrap` (RF-17) se queda.** Se evaluó retirarlo para no dejar dos caminos y **no
   conviene**: responden preguntas distintas y se deshacen distinto. RF-17 es la pérdida
   puntual durante la vida del rollo (borde oxidado, empalme fallado), se registra cuando pasa
   y se anula por RF-18; el ajuste del cierre es el corte de cuentas del rollo y se deshace
   reabriendo la bobina. Fusionarlos obligaría a cerrar la bobina para poder registrar una
   merma, o a que una anulación devolviera kilos de un hecho que no ocurrió.

**Un defecto que encontró el propio E2E, en mi guard.** El corte «no hay nada que liquidar»
estaba escrito como `balanceKg <= 0`, y eso mataba justamente el caso del **sobrante sobre una
bobina en cero** — planta encuentra material que el kardex ya dio por consumido—, que es el
caso para el que existe la rama `IN` y para el que se había escrito la valorización al costo
del documento. El síntoma no se parecía a la causa: el cierre **pasaba** y devolvía `CLOSED`,
los kilos simplemente no volvían. El corte correcto es `physicalKg === undefined`: **una
declaración explícita se respeta siempre, en los dos sentidos**; lo que se corta es la ausencia
de declaración. De paso cambió la UI: el diálogo se abre **siempre** al cerrar, también con
saldo cero, que además es la confirmación que el alcance pedía.

**Lo que esto rompe, y es un cambio no aditivo (D-123).** Cerrar una bobina con saldo ahora
exige `physicalKg`. Cinco escenarios E2E de fases anteriores cerraban un rollo **para
guardarlo** —no porque se hubiera agotado— y pasaron a declarar su saldo entero, vía el helper
nuevo `closeCoilKeepingStock`. Los tres que esperaban un error al cerrar (fleje montado en una
OP, bobina reservada) no cambian: esos guardrails corren antes.

**Lo que NO cambia:** el cierre automático del partido (RF-15) y de la recepción de corte
(D-052). Los dos ocurren con el saldo ya en cero y no tienen nada que liquidar, así que no
pasan por este camino.

### M1 — La merma normal del 1 % entra en la densidad estándar (D-165)

**Lo primero que se verificó:** el factor **no estaba en ninguna parte** — ni en código, ni en
las migraciones, ni en los docs. `grep` de `1.01` sobre el repo entero: cero resultados. Así
que M1 no era verificar, era implementar.

Se aplica en **un solo lugar**, `standardDensityFactor` en `@ayr/shared`, dentro de las dos
únicas funciones que traducen geometría a kilos (`theoreticalKgPerPiece` y `kgPerMeter`), y
**nunca** editando `finishes.density_factor`. El motivo de fondo: la densidad del acero es un
dato físico y la merma es una política de la empresa; multiplicarlos en el maestro deja un
número que no es ninguna de las dos cosas y **que nadie puede volver a separar** —revisar el
1 % obligaría a dividir cada acabado por 1.01 primero, adivinando cuáles ya lo tenían— además
de que cada acabado nuevo nacería sin el factor.

Entrando por un punto, se mueven juntos los cuatro números que dependen de él: el kilo teórico
del reporte de planta, el metro equivalente de una bobina, los kilos que reserva una cobertura
a medida y el costo por metro del piso de precio de D-163. **Los cuatro suben ~1 %, y el metro
equivalente baja ~1 %** — el mismo rollo promete menos metros, que es exactamente el sentido de
la decisión.

El centinela es `apps/api/src/production/normal-scrap-factor.spec.ts`, y lo que vigila no es la
multiplicación (es trivial) sino que **las dos cuentas apliquen el mismo factor**: si el kilo
por metro y el kilo por pieza divergieran, los kilos que un pedido promete por metro y los que
el reporte descuenta por metro serían dos números para el mismo hecho.

Cinco expectativas de `roofing-math.spec.ts` y `production-math.spec.ts` cambiaron de valor.
Están actualizadas con el comentario de por qué, no solo con el número nuevo.

### M2 — Query de solo lectura: SKU bajo el mínimo de D-163

`pnpm check:price-floor [--branch production|demo|dev|local]` →
`apps/api/prisma/price-floor-report.ts`. Es el número que le falta al dueño para decidir si el
mostrador lleva aviso de mínimo en el carrito: D-163 lo dejó **exento a propósito** y ponerle
el piso sin medir antes rompe ventas que hoy funcionan.

Compara **valor contra valor** y no precio contra precio, exactamente como `assertPriceFloor`:
`list_price_pen` es el valor sin IGV (D-068, D-162) y el piso es `costo ÷ (1 − margen mínimo)`.
Comparar los precios con IGV metería dos redondeos por 1.18 en una cuenta que se decide en la
cuarta decimal. Los precios se **imprimen** con IGV, que es como el dueño los lee. Los SKU sin
costo en el kardex no salen como infractores (sin costo no hay piso, D-163) pero se cuentan
aparte, para que el total cierre. **No toca el POS.**

### M3 — Regla dura 16: ningún texto largo pasa por la shell

`CLAUDE.md` gana la regla dura **16**, con el incidente de la sesión anterior escrito: un
`node -e` con backticks se lo comió la shell, que ejecutó lo que había adentro y disparó un
`pnpm e2e` accidental que **vació `ayr_local_e2e` a mitad de otra corrida**. Es una regla de
**forma y no de criterio**: el daño no lo hace el comando que uno quiso correr, sino otro que
la shell arma sola con pedazos del texto, y releer el texto no alcanza porque hay que darse
cuenta de que el texto también es código. Se numeró como 16 y no se insertó en el medio a
propósito: hay referencias vivas a «regla dura 15» en `CLAUDE.md` y en `docs/ENTORNOS.md`.

### El precio de D-165: unos setenta kilos esperados escritos a mano

Lo que el 1 % costó de verdad no fue el código —tres líneas en `@ayr/shared`— sino los tests.
La primera corrida completa devolvió **16 fallos**, todos con la misma forma: un kilo esperado
que ahora sale exactamente ×1.01 (`40.000 → 40.400`, `98.400 → 99.384`, `244.000 → 246.440`).
Ninguno era un defecto; todos eran el número viejo escrito como literal.

Y **16 no era el final**: corregir una aserción destapaba la siguiente del mismo caso, que
antes ni se ejecutaba. Hicieron falta **ocho tandas** hasta que la suite paró de encontrar
números, repartidas en doce specs y unos setenta literales. El arrastre llega más lejos de lo
que parece porque el kilo teórico alimenta cuatro cosas encadenadas: los kilos reservados, el
saldo de la bobina después de cada reporte, el **despunte** del cierre (que es `declarado −
teórico`, así que **baja** cuando el teórico sube) y el **costo unitario** del producto
terminado. En una pantalla del espacio de producción hasta el texto que se busca a ojo
(`«pendiente 1,838.400 kg»`) cambia.

**Un cambio de más, que también enseña algo.** Un reemplazo masivo de `qty: '24.600'` agarró,
junto con los kilos, la reserva que nace al reportar — que está en **metros de producto
terminado**, no en kilos de bobina, y a la que el 1 % no la toca. La suite lo cazó en la
corrida siguiente. La lección para la próxima: al mover números por un cambio de factor, **la
unidad manda**; kilos de materia prima sí, metros o planchas de producto no.

**Por qué había tantos.** Los fixtures de coberturas eligieron a propósito una geometría
redonda —1 000 mm × 0.50 mm con densidad 8.0— para que «la aritmética se pueda comprobar a
ojo»: 4 kg por metro exactos. Esa decisión, que hace los tests legibles, es la que multiplica
el costo de mover el factor: cada spec que escribió `'40.000'` en vez de derivarlo quedó atado
a la densidad. Con D-165 el consumo real pasa a **4.04 kg/m** y ningún número redondo sobrevive.

**Cómo quedó.** El factor vive ahora en `e2e/helpers/roofing.ts` como `NORMAL_SCRAP_FACTOR` y
`KG_PER_METER = 4 × 1.01`, y `fase7-consolidada-subtipo.spec.ts` —el único que ya derivaba en
vez de hardcodear— se arregló solo cambiando de dónde importa la constante. Los demás siguen
con el literal actualizado y el comentario al lado diciendo de dónde sale
(`24.6 m × 4.04 kg/m = 99.384`). **El pendiente de revisar el 1 % con datos reales debería
empezar por convertir esos literales a `KG_PER_METER`**, o la próxima revisión del porcentaje
vuelve a costar lo mismo.

**La lección, que es la de D-123 otra vez, con un agregado:** un cambio de regla no aditivo se
mide contra la suite completa y no contra los tests del cambio —los 352 unitarios estaban en
verde y los 9 casos nuevos de D-164 también—, **y una sola corrida completa no alcanza**,
porque cada aserción arreglada destapa la siguiente. Hay que iterar hasta que una corrida
limpia no encuentre ninguna.

### Lo que encontró la revisión

Dos pasadas en paralelo (API + `@ayr/shared` por un lado, web + E2E por el otro, que es lo que
enseñó una sesión anterior: la del web encuentra cosas que la del API no puede ver). **Tres
altos, todos corregidos**, ninguno bloqueante.

**Alto 1 — el ajuste de cierre podía crear inventario de la nada.** La reversa buscaba «el
último `CLOSE_ADJUSTMENT` vivo» de la bobina, sin ningún vínculo con el cierre que se estaba
deshaciendo. Pero una bobina puede volver a `OPEN` por un camino que no es `setStatus`:
**`revertSplit` (RF-16) reabre a la madre con un `update` directo**. La secuencia completa:
madre de 500 kg → partido de 400 → cierre declarando cero (ajuste de 100 kg) → `revertSplit`
devuelve los 400 y la reabre, dejando el ajuste **vivo y sin dueño** → cierre declarando los
400 (sin ajuste nuevo) → **la reapertura adopta el ajuste viejo y mete 100 kg y su valor que
ningún cierre había sacado**. Es exactamente la creación de valor que D-057 ya había tenido que
evitar una vez, con la misma forma: dos hechos que se parecen y una anulación que agarra el
equivocado.

La corrección no fue guardar el vínculo en la bobina sino cambiar la pregunta: **se revierte
solo si el ajuste es el último movimiento vivo del rollo**. Como el kardex es append-only, un
ajuste que dejó de ser el último **nunca vuelve a serlo** y queda inerte para siempre; y la
condición además es la que hace segura la reversa, porque si algo movió la bobina después del
cierre, el saldo ya no es el que el ajuste dejó. Cubierto por un caso E2E que reproduce la
adopción indebida.

**Alto 2 — la pantalla prometía un número que el API rechazaba.** El diálogo normalizaba la
coma decimal para validar y para calcular, pero mandaba el texto **crudo**: con `12,5` el panel
mostraba la liquidación, el botón se habilitaba y el `POST` rebotaba con un 400 del schema. Es
el defecto de D-163 otra vez, en el campo de al lado. Ahora se manda el valor normalizado, y la
validación se acotó a tres decimales —la escala de kilos— porque con más la pantalla mostraba
una liquidación y el API redondeaba y movía otra.

**Alto 3 — reabrir sin motivo cuando el kardex no había cargado.** El botón decidía si pedir
motivo mirando el kardex de la página, y esa lista está vacía mientras la consulta carga, si
falló, y durante el refetch posterior al cierre. En los tres casos se mandaba un `OPEN` sin
motivo y el API respondía «explica el motivo» sobre algo que la pantalla nunca había ofrecido
— y con el kardex caído la bobina no se podía reabrir. Ahora reabrir **siempre** pasa por el
diálogo de motivo; el kardex solo decide el texto.

**Medios corregidos.** `physicalKg` no tenía cota superior: un `5000` tipeado donde iba `500`
daba de alta 4 500 kg valorizados en una sola llamada, así que ahora se rechaza declarar más
kilos de los que la bobina ingresó. El campo del diálogo venía **prellenado en cero**, o sea
con la baja total del saldo, reintroduciendo por la ventana el default que el API rechaza a
propósito: arranca vacío. Y el `findLast` del web recorría la lista al revés de como viene
(del más reciente al más antiguo), así que habría citado los kilos del ajuste equivocado el día
que convivan dos.

**Menores corregidos:** el sobrante no mostraba soles (ahora sí, cuando hay saldo vivo y el
promedio es el que el API va a usar); el panel calculado no tenía `aria-live` ni el campo
`aria-invalid`/`aria-describedby`; la mutación de cambio de estado quedó con una rama muerta
tras mover el cierre al diálogo; un `import` sin uso en `fase6-bordes`; una firma de índice en
el tipo del resumen de auditoría que apagaba el chequeo de propiedades de toda la interfaz; y
el sentido del ajuste se re-derivaba con una comparación propia en vez de leer `plan.kind`.

**El spec de D-164 pasó de 5 a 9 casos** con lo que la revisión marcó como sin cubrir: la
liquidación **parcial**, el sobrante sobre **saldo vivo** (que se valoriza al promedio y no al
costo del documento, una rama que no tocaba ningún test), los rechazos del schema y el caso del
ajuste inerte. Y ganó limpieza contra producción, que le faltaba pese a declararse ejecutable
con `E2E_ALLOW_WRITES=1`.

**Anotado y no hecho:**

- **El diálogo de cierre no tiene E2E de UI.** Los nueve casos son por API; ningún spec aprieta
  el botón «Cerrar» de `/bobinas/:id`. Es el único punto de la interfaz que emite una baja de
  inventario nueva.
- **Los pedidos ya confirmados reservaron kilos con la densidad vieja** y producción ahora
  consume ~1 % más (D-165). No revienta nada —`consumeReservationQty` recorta con
  `Decimal.min`—, pero ese 1 % sale de stock libre y puede disparar el aviso de faltante de
  D-154 sobre pedidos que nadie tocó. Vale mirarlo el día del deploy.
- **`theoreticalKgPerUnit` del catálogo** se muestra en el formulario de venta como «≈ N kg» y,
  con el 1 % adentro, el rótulo quedó ambiguo: es el material que consume, no lo que la plancha
  pesa. No corrompe nada (el peso de la guía de remisión se tipea a mano), pero el texto merece
  una pasada.
- **El reporte de precios cuenta las coberturas a medida como «sin costo en el kardex»**, y el
  API sí les calcula piso por el agregado de materia prima. Para la pregunta del POS no cambia
  la decisión —el mostrador no vende a medida—, pero el total de infractores queda
  subestimado.

### Verificación

`pnpm turbo lint typecheck test` en verde (**352/352** unitarios, 24 suites), `prettier --check`
sobre `apps packages docs CLAUDE.md scripts e2e` y `eslint e2e` limpios. Tests nuevos: los siete
casos de `coil-close-math.spec.ts` (D-164) y los cuatro de `normal-scrap-factor.spec.ts`
(D-165), más cinco expectativas de `roofing-math.spec.ts` y `production-math.spec.ts`
actualizadas con el comentario de por qué, no solo con el número.

**E2E local, corrida completa sobre una base recién creada: 208 pasados, 14 fallos, 2
saltados.** Los 14 son las dos clases conocidas y ajenas a esta sesión: **doce** por el cupo de
50 documentos de la cuenta demo de Nubefact (ocho lo dicen explícito y cuatro son su
consecuencia, un comprobante que no llega a `ACCEPTED`) y **dos** por el 409 de códigos
generados al azar. **Ninguno de esta sesión.**

`pnpm e2e cierre-bobina-d164` → **9/9**. `pnpm e2e planta-espacio` → **8/8**.

**Lo que costó llegar ahí está arriba** («El precio de D-165»): ocho tandas de corrección de
fixtures, porque cada aserción arreglada destapaba la siguiente del mismo caso. Vale anotarlo
como método: para un cambio de factor, presupuestar varias corridas completas, no una.

## Sesión Largo de la plancha (2026-09-09) — el campo pedía milímetros y el catálogo tenía metros (D-166)

Bugfix de una captura del dueño, y de los que más enseñan: **no había ningún error en el
código de D-161**. La cuenta era correcta; lo que estaba mal era el número del maestro, y el
sistema lo multiplicaba sin preguntarse si se podía creer.

### El defecto

En Nueva cotización, `PL028ROJO` —una plancha de 3 metros— mostraba el largo bloqueado en
**0.00** y la línea calculaba **0.030 m lineales** y **S/ 0.28** para diez planchas a S/ 11 el
metro. Debía dar 30 m y S/ 330.

La causa **no** fue la que parecía. El largo sí se hidrataba del catálogo; lo que pasaba es que
el catálogo tenía `length_mm = 3.00`. El campo del maestro pide **milímetros** y todo el resto
de la pantalla de coberturas trabaja en **metros**, así que «3» entró queriendo decir 3 metros.
Y no fue un desliz: las **tres** planchas del catálogo del dueño estaban así (`3.00`, `6.00`,
`6.00`). El campo es una trampa, no hubo un error de tipeo.

De ahí en adelante todo funcionó como estaba escrito: 3 mm ÷ 1000 = 0.003 m por plancha, × 10 =
0.030 m, × S/ 9.3220 el metro (el valor sin IGV de S/ 11) = S/ 0.28. **Dos números correctos en
pantalla que había que saber leer**, y ningún error por ningún lado.

### Lo que decidió la forma del arreglo (D-166)

**El corte no podía ser que `sellsByFixedLength` devolviera `false`.** Es lo primero que uno
piensa —si el largo es imposible, que no cotice por metro— y está mal: con `false` la línea cae
en el camino viejo, el del valor por plancha tipeado a mano, y el vendedor escribe 11 pensando
«por metro». Vuelve a estar mal, en silencio y por otro lado. Hace falta **cortar**, no elegir
otra rama, y por eso la precondición (`assertUsableFixedLength`) vive aparte del predicado.

**El rango no se inventó para este caso.** `MIN_PIECE_LENGTH_MM`..`MAX_PIECE_LENGTH_MM` (0.1 a
20 m) es exactamente el que la rama **a medida** ya exigía a cada largo de su plan de corte
desde D-083. La asimetría era el defecto: el largo que se tipea línea por línea estaba
validado, y el que vive en el maestro —el único que nadie mira al cotizar— no. Unificarlos en
`isPlausiblePieceLength` deja una sola definición para las tres preguntas.

### Tres cortes, en los tres momentos

1. **Al cargar el producto** (`assertStructuredFields`): el catálogo no guarda un largo
   imposible, y el mensaje **traduce el número y nombra la unidad** («3.00 mm son 0.003 m; el
   campo va en milímetros, una plancha de 3 metros son 3000»). Decir solo «fuera de rango»
   dejaba a quien lo lee sin saber qué esperaba el campo, que es la mitad de la confusión.
2. **Al tipearlo** (`PlateLengthHint` en el diálogo del catálogo): el equivalente en metros,
   en vivo, debajo del campo. Es la mitad barata del arreglo y la que de verdad previene: ver
   «= 0.003 m» mientras se escribe desarma la confusión en el momento, que es cuando corregirla
   no cuesta nada.
3. **Al cotizar** (`assertUsableFixedLength`): un producto **ya guardado** con el largo roto no
   se cotiza — la línea lo dice en pantalla y el API la rechaza nombrando el SKU. Es el corte
   que importa de verdad, porque los tres productos del dueño siguen rotos hasta que alguien
   los corrija, y sin esto seguirían produciendo documentos mil veces más baratos.

Y `pnpm check:roofing-catalog` los lista, que es cómo encontrarlos en una base que ya los
tiene. Se le agregó además `--branch local|local-e2e`, como ya tenía `check-price-floor`.

### Lo que NO se hizo, a propósito

**No se migró ni un dato.** Multiplicar por 1000 los largos que están por debajo del mínimo
sería casi siempre correcto y ocasionalmente desastroso, y es una decisión del dueño sobre sus
propios datos, no de una migración. Son tres productos y se corrigen en el catálogo en menos de
un minuto; el reporte los nombra.

### Verificación

`pnpm turbo lint typecheck test` en verde (**357/357** unitarios, 25 suites), `prettier --check`
y `eslint e2e` limpios. Tests nuevos: `apps/api/src/sales/fixed-length-plausible.spec.ts`, ocho
casos — el importe **exacto de la captura** con el largo bien cargado (S/ 330), el defecto
reproducido (S/ 0.28 y `sellsByFixedLength` diciendo que sí), los bordes del rango, el par
cruzado contra `sellsByFixedLength`, y los tres casos del guard.

E2E: `e2e/tests/plancha-largo-d166.spec.ts`, **3/3 por pantalla** — el catálogo rechazando el
largo en metros, el diálogo traduciendo mientras se tipea, y la cotización de una plancha de
3 m mostrando **30.000 m lineales** y cobrando **S/ 330.00**, que es la regresión directa de la
captura. Regresión de ventas y catálogo: `precios-d161-d163`, `fase7e`, `fase1` y
`fase7-consolidada-subtipo`, **33/33**.

**Sin desplegar y sin push.**

## Sesión HOTFIX post-deploy (2026-09-10) — servicios, importes del papel, SKU de bobina, reventa de bobina y plancha contra pedido (D-167..D-171)

La ventana de deploy expuso cuatro flujos que nunca se habían ejercitado de punta a punta con
datos reales. Dos eran defectos de una línea; dos eran premisas de negocio equivocadas.

**Entorno LOCAL en toda la sesión** (Docker, `:3000`/`:3001`). Contra `production` se corrieron
únicamente los dos guiones de **solo lectura**, con el OK del dueño. **Nada desplegado y sin
push.**

### M0 — Un servicio no se podía cotizar por ninguna puerta (D-167)

«Línea 1: el producto CONFORMADO es de una línea sin inventario: no se cotiza». El rechazo
estaba en `resolveSalesLines` y cortaba **antes** de llegar al kardex, que ya trataba el caso
como el no-op explícito que es (§2.2) — la mitad de abajo del sistema estaba lista y la de
arriba no dejaba llegar.

La exención la decide ahora `carriesInventory(line)` en `@ayr/shared`, por el **atributo**
`inventory_strategy` y nunca por el código de la línea. Reemplaza a las tres comparaciones
sueltas que había (`inventory.service` ×2, `purchases.service`). Cinco puntos tocados: la
resolución de líneas, la reserva, el piso de precio, el despacho y el web.

**Lo que la revisión encontró y obligó a ampliar el alcance:** el web filtraba el selector de
línea de negocio por `inventoryStrategy === 'STOCK'`, así que Servicios **ni siquiera se podía
elegir** y todo lo que M0 había agregado del lado del navegador era código muerto. Sin ese
segundo arreglo, el único camino que ejercitaba D-167 era el importador.

Dos consecuencias que había que decidir y no se podían dejar implícitas:

- **El despacho rechaza una línea de servicio.** No sale nada del almacén y no hay peso que
  declarar en una guía; dejarla pasar hacía que el despacho pidiera «el peso en kilos» de un
  conformado y lo escribiera en la guía de remisión como si fuera un bulto.
- **`recomputeOrderStatus` no la espera** para llegar a `FULFILLED`. Sin esto, todo pedido que
  mezclara mercadería con un servicio quedaba en `PARCIALMENTE DESPACHADO` para siempre.
- Un pedido de **solo** servicios se queda en `CONFIRMADO`: el ERP no modela la ejecución de un
  servicio y fingir que sí sería peor. Queda anotado.

### M1 — El rechazo por céntimos vivía en la cobranza, no en el importador (D-169)

El brief decía que las importaciones rechazaban por céntimos y ubicaba el rechazo aguas abajo.
**No estaba en el importador**: ahí no hay ninguna comparación de importes (el piso de precio ya
está desactivado por D-163). Se reprodujo el camino completo contra el API local hasta
encontrarlo.

**Dónde estaba.** Una línea de 3 × S/ 33.3333 da un subtotal de 99.9999 y un total de
**117.9999**. El papel dice S/ 118.00. Cobrar los 118 del papel se rechazaba con:

```
El cobro excede el saldo pendiente (S/ 118.00)
```

sobre un cobro de exactamente S/ 118.00 — el mensaje redondeaba para mostrar y la comparación
no. Dos cifras idénticas en pantalla y un 400 sin salida, sobre una factura que no se podía
cerrar nunca.

**Dos arreglos, y hacen falta los dos:**

1. **La causa** (D-169): el importe de una línea importada **se copia del papel** en vez de
   recalcularse. `netAmountPen` viaja por fila y `resolveSalesLines`, bajo `exactAmounts`, lo
   persiste como subtotal. El unitario sigue siendo la cuenta derivada, porque es lo que el
   comprobante electrónico declara como `valorUnitario`.
2. **La clase entera**: `payableBalance` compara el saldo **en céntimos**, redondeando hacia
   arriba. Un total con cola de diezmilésimas también lo produce un precio tipeado a mano, así
   que arreglar solo el importador habría dejado el mismo callejón por otra puerta.

Y dos cierres más que la revisión encontró en el camino:

- El **comprobante** recalculaba el subtotal e ignoraba el del pedido, así que el importe exacto
  moría al facturar — literalmente el daño que D-169 dice cerrar, una pantalla más adelante. La
  línea que factura un pedido entero a su propio precio ahora **copia** su importe; la parcial o
  la de precio editado se sigue recalculando, que es lo único defendible.
- **Editar** una cotización importada le borraba los importes a todas sus líneas, en silencio.
  Ahora conserva el del papel en las líneas cuyo producto, cantidad y precio no cambiaron.

**La tolerancia tuvo que dejar de ser un número fijo.** El techo plano de S/ 0.10 que pidió el
brief rechazaba **justo los documentos que la decisión venía a poder importar**: el desvío que
el redondeo del unitario puede producir es `cantidad × 0.00005`, o sea S/ 0.12 en una línea de
2 500 kg, que es el tamaño normal de una de acero. La cota es ahora
`max(S/ 0.10, Σ (cantidad + 1) × 0.00005)` — el colchón del dueño como piso, y la aritmética
como techo. Lo que queda por encima es lo único que el redondeo no pudo haber hecho.

### M2 — El guion es un separador, no un carácter a borrar (D-168)

`coilSkuFromTypeKey` hacía `typeKey.replace(/-/g, '')` y `coilSku` conservaba los guiones del
acabado. Con un código de acabado sin guiones (`GALV`) las dos coinciden y el test que había
pasaba; con uno real del cliente (`ALZ-ROJO-3002`) no:

```
catálogo   → BOBALZ-ROJO-30020.45   (coilSku, es lo que está en la base)
venta      → BOBALZROJO30020.45     (coilSkuFromTypeKey)
```

y RF-73 respondía «no existe el producto de venta directa» sobre una bobina que sí tenía el
suyo. Ahora hay **una sola** función que arma el SKU y la otra parte el `typeKey` por su
**último** guion y delega — el mismo criterio que `describeTypeKey` ya usaba en el valorizado.

**Auditado contra `production` y `local`** (`pnpm check:coil-skus`, solo lectura, con OK del
dueño): los **11** tipos de bobina de producción y los 3 de local resuelven a su producto con la
función arreglada. **No hay ningún dato que migrar.** Los dos `BOB…` sin bobinas de cada base
(`BOB38AZUL`/`BOB38ROJO` en producción) son SKU creados a mano, no restos de la forma vieja.

### M3 — La venta de bobina entera ya existía; le faltaba el cierre (D-170)

Al leer el código antes de diseñar apareció que **RF-73/D-116 ya estaba casi entero** desde la
Fase 7e: saldo vigente y no nominal, sin fracciones, reserva del rollo completo, `OUT` directo
sobre la bobina sin pasar por ningún kardex intermedio, y una bobina reservada que ni se monta
en producción ni se manda a corte. **Lo que la rompía en la práctica era M2.**

Lo que faltaba, y se agregó: el despacho **cierra** el rollo que quedó en cero y sin reservas
vivas, y la reversa lo **reabre**. Un despacho parcial que deja remanente no lo cierra: ese
camino sigue siendo el cierre manual de D-164, el que pide cuántos kilos quedan y liquida la
diferencia como merma anormal.

**`refType` propio se descartó, con el OK del dueño.** El movimiento ya es `SALE` sobre
`itemType = COIL`, que es inequívoco; agregar `COIL_SALE` al enum obligaba a una migración y a
revisar la reversa a cambio de distinguir algo que el `itemType` ya distingue solo.

### M4 — La plancha no es stock terminado (D-171, revierte D-140)

Regla de negocio del dueño. Con el modelo viejo el mostrador exigía tener planchas en el almacén
—«0.000 NIU disponibles… necesita 10»— sobre un producto que nunca vive ahí: se rola contra el
pedido igual que una cobertura a medida.

**Una cuarta pregunta, no un cambio a las que había** (regla dura 14). `isMadeToOrder(product)`
responde _¿se fabrica desde bobina contra el pedido?_, y la contestan que sí la cobertura a
medida y la plancha **con largo fijo usable**. `isMadeToMeasure` deja de decidir la rama de la reserva y se
queda con lo que su nombre dice. El centinela `sales-lines.spec.ts` cubre ahora las cuatro
combinaciones, con el par nuevo escrito aparte porque es el más peligroso: responder «¿se
produce?» con `isMadeToMeasure` devuelve la plancha al modelo viejo en silencio.

`orderedMeters(product, qty, at)` es la conversión que hace que las dos formas prometan con la
misma aritmética: en una plancha, `cantidad × largo del SKU`. **El 1 % de merma normal no se
suma aparte** —vive dentro de la densidad estándar desde D-165— y sumarlo lo habría contado dos
veces.

**Producir coberturas a stock se eliminó**, con el OK explícito del dueño y registrado como
decisión de negocio **reversible**. Es la contracara necesaria: si además se pudiera producir a
stock, quedaría un saldo de producto terminado que ningún pedido consume nunca. Para reabrirla
hay que responder primero qué hace una línea de pedido cuando ese saldo existe, que es la
pregunta que hoy no tiene respuesta. `createToStock` quedó en el archivo sin llamadores, para
que reabrirla sea volver a enchufarla y no volver a escribirla.

**Un defecto viejo que apareció al mirar el camino del despacho:** `resolveDispatchTarget`
decidía «se fabrica contra el pedido» con `productBom.count`, y desde D-122 una cobertura **ya
no tiene receta** — el caso central de esa rama daba cero y se sostenía solo por que la
producción ya hubiera abierto la reserva de producto. Un despacho **anterior** a producir caía
al camino de las coordenadas congeladas y emitía una salida de **kilos de bobina** por una venta
de planchas, que es exactamente lo que D-088 vino a cerrar. Ahora decide por el subtipo.

**Censo previo, con el OK del dueño** (`pnpm check:roofing-catalog`, ampliado en esta sesión,
solo lectura):

|                              | `production` | `local` |
| ---------------------------- | ------------ | ------- |
| SKU de plancha               | 19           | 3       |
| Líneas en cotizaciones vivas | 0            | 5       |
| Líneas en pedidos vivos      | 0            | 0       |
| Saldo de producto terminado  | 0            | 0       |
| OP de plancha «a stock»      | 0            | 0       |

**Ninguna migración**, y no por suerte: la rama de la reserva se recalcula al **confirmar** el
pedido (`resolveRawMaterial`), no al cotizar, así que las cotizaciones vivas se confirman solas
bajo el modelo nuevo. Es el mismo mecanismo con el que D-134 arregló las anteriores a él.

### Lo que encontró la revisión

Dos bloqueantes, los dos reales y los dos corregidos antes de seguir:

1. **La tolerancia de D-169 era más chica que el error que existe para tolerar** — ver M1.
2. **El web tapiaba la puerta que M0 abrió en el API** — ver M0.

Y cuatro más, todos corregidos: el comprobante que recalculaba el importe; la edición que lo
perdía; la línea de servicio atrapada en el despacho; y el guard de `netAmountPen`, que estaba
**después** del `return` de la rama de venta de bobina, así que en esa rama el campo se ignoraba
en silencio en vez de dar 400 — el contrato decía una cosa y una de las dos ramas hacía otra.

De los bajos se tomaron: unificar las tres comparaciones crudas de `NOOP` en `carriesInventory`,
dejar escrita la exclusión del mostrador (su lista nace del saldo, y un servicio no tiene saldo
del que salir), validar `--branch` en el guion nuevo, y mostrar el ajuste de redondeo en el
detalle de la cotización — viajaba en el DTO y no lo pintaba ninguna pantalla.

**La segunda pasada, sobre M3 y M4, encontró otros dos altos**, los dos del mismo tipo — la
regla nueva alcanzaba a datos que no sabía describir:

1. **`isMadeToOrder` era `roofingKind !== null`, y eso no alcanza.** Ver M4: el `CHECK` de la
   base admite una `PLANCHA` en `KGM` y una sin largo, y en esas dos la cantidad no son
   planchas. Corregido a `isMadeToMeasure || sellsByFixedLength`, con el caso en el centinela.
2. **La tarjeta «Nueva orden de coberturas a stock» de `/planta` quedó como callejón**: el API
   ya respondía 400 fijo y la pantalla seguía ofreciendo elegir la plancha y tipear la meta.
   Se retiró en el mismo commit que cerró la puerta, que es lo que D-156 pide.

Y cinco medios, corregidos: la **reversa parcial** dejaba el rollo `CLOSED` con saldo vivo —dos
despachos sobre la misma bobina, el segundo la cierra, revertir el primero le devuelve kilos—,
así que la reapertura pasó a mirar el **último cierre del rollo** y no el `closedCoils` del
despacho que se revierte; la reversa **no tomaba el lock de bobinas** aunque su propio
comentario prometía el orden «pedido → bobinas → saldos»; el bloque canónico de la familia de
preguntas en `schemas/roofing.ts` seguía enseñando que `isMadeToMeasure` decide la rama de la
reserva, que es exactamente la confusión que la regla dura 14 prohíbe; el navegador respondía
la pregunta de la unidad con el subtipo en el cálculo de metros; y el **mostrador** seguía
ofreciendo planchas con saldo legado que ya no se pueden despachar por ninguna puerta.

De los bajos de esa pasada se tomaron: la fecha de operación en el cierre automático (el manual
la escribe y un reporte por fecha de negocio se saltearía los automáticos), el plan de corte
derivado en el **PDF de planta** —imprimía «—» justo en la línea que ahora hay que rolar— y el
`madeToMeasure` mal nombrado de `roofing-production.service.ts`, que es la clase de nombre que
no conviene reutilizar con cuatro predicados en juego.

### Lo que encontró la escritura de los E2E

**Un defecto del API, y era mío: la cabecera del comprobante no sumaba sus propias líneas.**
`resolveLines` copiaba el importe del papel en la línea (la mitad de D-169 que sí estaba
implementada) y, un renglón más abajo, `createInTx` calculaba el total de la cabecera con
`salesTotals(lines.map(l => ({ qty, unitPricePen })))` — recalculando desde el unitario. La
línea decía S/ 4 179.13 y la cabecera S/ 4 179.00.

No era cosmético y era **exactamente el daño que D-169 vino a cerrar, sobrevivido una pantalla
más adelante**: la cuenta por cobrar sale de `totalPen`, así que el saldo quedaba trece
céntimos por debajo del papel y cobrar el importe del papel se rechazaba por exceso. Pasaba
desapercibido porque el total recalculado, al perder la cola de diezmilésimas, se ve **más
limpio** que el correcto.

Corregido con `sumLineTotals` —suma subtotal e IGV por separado, nunca totales ya redondeados,
el mismo criterio que `documentTotals` en ventas— y aplicado también a la **nota de crédito**,
que tenía el mismo defecto por partida doble: su cabecera lo recalculaba y, peor, una NC
**total** sobre un comprobante importado acreditaba menos que el total del afectado, así que la
cuenta por cobrar no cerraba nunca y quedaban céntimos que ya nadie podía acreditar ni cobrar.
Acreditar la línea entera copia su importe entero; una acreditación parcial se sigue calculando,
porque una fracción de un importe exacto hay que derivarla.

El caso nació en la suite marcado `test.fail()` —corría, afirmaba la regla nueva y dejaba la
suite verde mientras el defecto existiera— y se le quitó la marca al corregirlo.

**Dos más, que no se tocaron** (ninguno es de esta sesión):

- **El selector de cliente no ve más de 200 clientes y no busca.**
  `sales-document-form.tsx` los pide con `fetchAllForPicker('/customers')` (`pageSize=200`) y
  los pinta en un `<Select>` plano. `/customers` ordena por `isActive desc, name asc`, así que
  con más de 200 activos **el vendedor no puede elegir a la mayoría**: no hay error, sencillamente
  no están. El propio helper lo advierte de sí mismo y `/customers` ya soporta `search`.
- **La cuenta demo del PSE está en su tope** («No puedes enviar mas de 50 documentos en en una
  cuenta DEMO»), y con eso quedan 12 casos rojos en `fase5b`, `fase5b-bordes` y `fase7b`. **No
  es una regresión** y no se silenció: `probePse` no cubre este caso —el PSE está configurado,
  solo sin cupo— y saltear esos casos por cuota escondería regresiones reales. Necesita acción
  del dueño: vaciar los comprobantes de la cuenta demo.

### Verificación

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e
pnpm exec eslint e2e

pnpm check:coil-skus --branch local        # y --branch production, solo lectura
pnpm check:roofing-catalog --branch local  # incluye el censo de exposición de PLANCHA

# Recrear `ayr_local_e2e` antes de una tanda larga (ver notas operativas).
# Matar servidores viejos en :3000/:3001; NO tocar :4000/:4001 (regla dura 15).
pnpm e2e servicios-d167 bobina-sku-guiones-d168 importe-importado-d169 \
         venta-bobina-entera-d170 plancha-contra-pedido-d171     # 22/22, los cinco frentes
pnpm e2e fase6 fase7-consolidada-subtipo fase7final-op-a-stock precios-d161-d163 \
         planta-avisos-materia-prima planta-espacio-produccion-ui  # regresión de D-171
```

La suite completa quedó en **13 fallados / 230 pasados**, y los 12 que sobreviven al último
arreglo son todos el cupo del PSE demo. El baseline antes de esta sesión era **26 fallados**.

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

## Ventana de deploy (2026-09-10) — D-167..D-171 a producción

Mini-ventana aprobada por el dueño, con cada comando contra producción anunciado y ejecutado
uno por uno tras su OK. **Sin migraciones nuevas en la tanda.**

|                     |                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Commits desplegados | `c908980`, `46b885a`, `946ce0e` (D-167..D-171)                                                   |
| Respaldo previo     | rama Neon `respaldo-pre-hotfix-2026-09-10` (`br-muddy-flower-ae8ik7ae`)                          |
| Revisión de API     | `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`, CORS `https://ayr-steel-erp-web.vercel.app` |
| Web                 | por push a `main`; verificación en navegador, a cargo del dueño                                  |
| CI                  | run `34475912275`, disparada por el push                                                         |

**Verificación post-deploy.** `pnpm smoke:prod` en verde (health, login, 5 líneas, 174
productos, 52 saldos, 5 bobinas, 50 filas del reporte). Y **dos marcadores de que sirve la
revisión nueva y no la anterior**, leídos con un administrador efímero borrado en el `finally`:
`avgCostPen` en `/sales/sellable-coils` (D-170, 43 bobinas) y `carriesInventory` en
`/sales/stock-panel` (D-167). Un smoke que solo mira que el API responda no distingue una
revisión de la otra; por eso el marcador es un **campo que solo existe en los commits de la
tanda**, y conviene elegir uno nuevo en cada ventana.

**El selector de clientes no es urgente.** El defecto que encontró QA (pide 200 y los pinta sin
búsqueda) se midió contra la base real: **49 clientes activos de 49 totales**, o sea 151 de
margen. Sigue anotado y hay tiempo de resolverlo con `SearchSelectField` (D-156) en vez de a las
apuradas.

### Incidente de seguridad — credencial de `neondb_owner` expuesta

**2026-09-10, 11:54 UTC.** `neonctl branches create` **imprime `connection_uris` en su salida de
éxito**, y esa cadena lleva la contraseña de `neondb_owner` en texto plano. Quedó en la salida
del comando y en el transcript de la sesión.

**Alcance: las cuatro ramas de Neon, `production` incluida**, porque esa contraseña es la misma
en todas (regla dura 5). No se escribió en ningún archivo, no se commiteó y no se repitió.

**Por qué pasó, que no es lo que la regla decía.** La regla dura 5 cubría dos vías —la
credencial no viaja por `argv`, y los helpers no repiten argumentos al componer un error— y de
las dos nos cuidamos. La tercera vía es que **el comando la imprima al salir bien**, que no
estaba nombrada. `scripts/lib.mjs#run` tiene `quiet: true` exactamente para esto; el comando se
invocó directo por `cmd /c` con la salida a la vista. La regla dura 5 se amplió con este caso.

**Decisión del dueño:** continuar la ventana sin rotar, asumiendo el riesgo, con la rotación
como paso **obligatorio** de cierre.

**Rotación ejecutada.** `neondb_owner` se reseteó (`neonctl roles reset-password`) y se
propagó a `.env.setup`, Secret Manager en GCP y los secretos de GitHub Actions. Incidente
cerrado.

## Sesión Saneamiento E2E (2026-09-10) — la suite deja de tener rojos que no son regresiones

Entorno **LOCAL** en toda la sesión. **Nada desplegado y sin push**; el commit de la ventana
(`207bdf9`) sigue pendiente y sale con estos.

**Resultado: `pnpm e2e` da verde pleno.** De **26 fallados** al empezar el día a **0**. El
tiempo de la suite ronda los **50 minutos**, con un desvío de ±4 entre corridas del mismo
código (ver M1: esa dispersión es la que impidió medir la mejora de velocidad):

| corrida                             | resultado                                       |
| ----------------------------------- | ----------------------------------------------- |
| baseline heredado (sesión anterior) | 26 fallados                                     |
| tras el hotfix D-167..D-171         | 13 fallados                                     |
| primera completa de esta sesión     | 10 fallados — todos causados por el reset nuevo |
| **final**                           | **234 pasados, 0 fallados, 2 saltados**         |

Los 2 saltados son los dos casos de `fase7b` que exigen que una **boleta** llegue a aceptada;
SUNAT las resuelve por resumen diario y el PSE demo puede tardar más que la corrida. Se saltan
por diseño desde la Fase 7b, no son deuda nueva.

### M0 — la suite deja de depender de recursos externos

Tres piezas, documentadas en `docs/ENTORNOS.md` bajo «La corrida por defecto no depende de nada
externo».

**Los 12 casos que necesitan cupo del PSE salen de la corrida por defecto** (`@pse`,
`pnpm e2e:pse` para correrlos). La lista no se armó leyendo: se corrieron los tres archivos y se
tomó a los que fallan con «No puedes enviar mas de 50 documentos en en una cuenta DEMO».

Dos cosas decidieron la forma. **El opt-in va por entorno y no por bandera** porque un `--grep`
de la línea de comandos pisa a `grep` pero **no** a `grepInvert`: con bandera, `e2e:pse` habría
corrido cero casos. Y **no se amplió `probePse`**, que era la alternativa obvia: la sonda ya
saltea cuando no hay PSE atado o falta el RUC del receptor —eso es _en este entorno no se puede
llegar a una aceptación_—, pero enseñarle además «…y tampoco si el servidor contestó que no hay
cupo» sería saltear casos según **la respuesta que dio el servidor**, y esa misma condición
taparía una regresión que hiciera fallar la emisión por cualquier otro motivo.

**El 409 al azar se arregló en la causa.** `reset-test-db.ts` truncaba nueve tablas escritas a
mano y dejaba fuera **todos los maestros**, que se acumulaban entre corridas. Ahora enumera
desde `information_schema` y vacía **45 tablas** —todo menos `_prisma_migrations`—, que es tabla
por tabla el estado de una base recién creada. Se enumera y no se lista a mano a propósito: la
lista escrita a mano fue justamente lo que envejeció.

**El padrón se responde con un stub local.** `e2e/padron-stub.mjs` corre como tercer `webServer`
en `:3002` y el API lo consulta vía `APIS_NET_PE_BASE_URL`, que se hizo configurable. Existía un
motivo real para que el badge «Nuevo — se creará desde padrón» fuera intestable: **la consulta
sale del API, no del navegador** (D-158), así que `page.route()` nunca la veía. El stub responde
200 si el documento termina en dígito par y 404 si en impar, así un test elige la rama del alta
desde padrón o la del alta express sin listas que mantener.

**Dos E2E nuevos**: el badge del padrón —con los dos lados en el mismo archivo, para que el
contraste no dependa de dos corridas— y el diálogo de cierre de bobina de D-164 por pantalla.

### Lo que el reset destapó, que es la mitad del valor de M0

La primera corrida completa dio **10 rojos, y los diez eran del cambio**. La migración de la
Fase 5b sembraba tres datos iniciales —el cliente **«público en general»** (D-077), las **cinco
series fiscales** (D-072) y la **fila de configuración del PSE** (D-073)— y una migración corre
**una vez**: al vaciarlas, nada las repuso.

El síntoma no se parecía a la causa: «la migración de 5b siembra el cliente "público en
general"» en un test de importación, y «No hay una serie activa para emitir FACTURA» en diez
casos repartidos por cinco archivos que no hablan de series.

Los tres se mudaron al **seed**, que responde otra pregunta —_qué necesita esta base para ser
usable_, la misma que ya respondían las líneas de negocio y sus márgenes— y corre siempre. Todo
idempotente: contra producción o demo no hace nada. **El seed no pisa una serie que ya existe**:
el correlativo es un hecho fiscal y `isActive` lo administra el dueño.

**La regla, para lo que venga: un dato inicial que inserta una migración tiene que estar también
en el seed**, o desaparece en el primer reset y reaparece como un fallo lejos de su causa. Queda
escrita en `seed.ts`.

### M1 — el informe apuntaba al lugar equivocado, y la medición lo dice

Perfil real de la suite, medido sobre las duraciones que imprime el reporter:

| franja      | casos   | tiempo       | %        |
| ----------- | ------- | ------------ | -------- |
| > 60 s      | 0       | —            | —        |
| 30–60 s     | 7       | 4.6 min      | 9 %      |
| **10–30 s** | **128** | **35.2 min** | **71 %** |
| ≤ 10 s      | 98      | 9.7 min      | 20 %     |

**No hay punto caliente**: el archivo más pesado es el 6.3 % del total y el caso más caro, 51.7 s.
La suite tarda porque hace 233 cosas de punta a punta.

Dos de las tres recomendaciones del informe **no se sostienen**, y se descartaron con números:

- **`storageState` para el login («ALTA, 10-15 min»)**: son **15 llamadas a
  `loginAndSetPassword` en 6 archivos**, no «198 tests» — el resto usa `adminApi()`, que es un
  POST. Techo real ≈ 1 minuto, contra una refactorización que toca seis roles distintos y varios
  casos que ejercitan a propósito el cambio de contraseña obligatorio.
- **Los `setTimeout` fijos de `fase7b`**: son polls de un servicio asíncrono real (SUNAT por
  resumen diario) y viven en los dos tests que quedan **saltados**. Ahorro: cero.

El informe se escribió leyendo el código sin correrlo, y ahí está su error: estimó el login por
cuántos specs mencionan la palabra, no por cuántas veces se llama.

Lo que sí se hizo, que es lo que paga en un perfil plano —**el setup que todos comparten**—:
`Promise.all` en las altas **independientes entre sí** de `setupRoofingScenario` (lo montan **51
casos**), `setupScenario` de producción y `setupOrderScenario`; y `purgeInvoicingTrail` dejó de
leer los mismos documentos **tres veces** con un GET por documento en cada pasada.

Las **mutaciones** de la limpieza siguen secuenciales y no es una omisión: cobros antes que
bajas, notas de crédito antes que su afectado. Ahí el orden **es** la regla.

**La ganancia NO se pudo medir, y eso es el resultado.** Cuatro corridas completas de la suite,
las dos últimas con el código final, dieron **49.5 · 47.3 · 45.7 · 49.7 min** de suma de
duraciones (y 53.9 · 50.3 · 48.8 · 54.3 de reloj de pared). El desvío entre corridas del
**mismo** código es de ±4 minutos, o sea **más grande que el efecto que se estaba buscando**.

Durante la sesión llegué a reportar «≈5 minutos, 9 %» comparando dos corridas sueltas. Estaba
leyendo ruido como señal: con esa dispersión, un solo par antes/después no puede resolver un
efecto de dos minutos. Medirlo de verdad pide varias corridas de cada lado, o sea horas.

Lo que sí se puede contar sin medir es lo estructural: los tres helpers se montan **94 veces**
entre todos los specs, y cada uno ahorra 1 o 2 viajes secuenciales; `purgeInvoicingTrail` pasó
de `3 × N` viajes en fila a 3 vueltas en paralelo. Son unos pocos segundos en total —por eso no
se ven—. El cambio es correcto y no se deshace, pero **la velocidad de la suite no mejoró de
forma observable**, y presentarlo de otra manera sería inventar.

**La palanca grande sería paralelizar workers**, y ahí sí hay minutos de verdad. No se tocó: los
233 casos comparten una base y muchos dependen de saldos, correlativos y reservas globales.
Queda propuesta, no hecha.

### M3 — el selector de cliente pasa a `SearchSelectField`, y el umbral baja a 20

El desplegable sin búsqueda de la cotización pasa al mismo campo que usa el importador (D-156).

**Y el umbral bajó de 50 a 20, por decisión del dueño tomada con el dato delante**: producción
tiene **49 clientes activos**, así que con el umbral en 50 el vendedor quedaba a un cliente de
distancia del buscador y mientras tanto elegía de una lista de 49 nombres reconociéndolos de
vista. Alcanza a tres campos: el cliente de la cotización, el cliente del comprobante en el
importador y el producto de la fila (que ya estaba del lado del buscador, con 174 productos).

**Lo que M3 no arregla**, y quedó escrito en el código: `fetchAllForPicker` sigue trayendo como
mucho 200 clientes. Esto da **búsqueda sobre lo cargado**, no «ver todos». Levantar el tope es
buscar del lado del servidor —`/customers` ya acepta `search`— y es un cambio propio.

### El fallo que enseñó más que su arreglo

El caso de D-166 **pasaba aislado y fallaba en la suite completa**, que es la peor forma de
fallar. La causa: el reset vacía la base **una vez por corrida, no por test**, así que para
cuando ese caso corre ya hay más de veinte clientes creados por sus vecinos, y el campo que en
solitario es un `<select>` ahí es un modal. Con el modal abierto, `getByLabel('Cliente')`
resuelve a **tres** elementos —el botón del campo, el diálogo y el botón «Seleccionar…»— y
Playwright corta por modo estricto.

Dos cosas quedaron de ahí: el locator con `exact: true`, y los helpers que manejan las dos formas
del campo movidos de dentro del spec del importador a `e2e/helpers/ui.ts`. Vivían ahí porque esa
era la única pantalla con el componente; desde M3 son dos, y tener la solución copiada en un
spec era esperar a que la segunda la reescribiera peor.

### Verificación

```bash
pnpm turbo lint typecheck test          # verde (399 unitarios)
pnpm exec eslint e2e
pnpm format:check

pnpm e2e                                # 234 pasados, 0 fallados, 2 saltados (~50 min)
pnpm e2e:pse                            # los 12 del PSE — antes hay que vaciar la cuenta demo
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

## Sesión S9 — Trazabilidad y links (T4) + Reporte de bobinas PDF (T6) (2026-09-10)

Entorno **LOCAL** en toda la sesión. **Nada desplegado y sin push**: PROHIBIDO por el brief de
la sesión, que acumula commits locales para la ventana única post-T7.

**M1 (T4) — links donde antes había texto plano, cero cambios de lógica de negocio.**

- **Bobina ↔ pedido/OP, la punta que faltaba.** `/produccion/:id` ya listaba las bobinas
  montadas por una OP (D-060); faltaba el sentido contrario. `GET /coils/:id/consumptions`
  recorre `ProductionOrderConsumption` por `coilId` y sube por
  `productionOrder.reservation.salesOrder`, y una tarjeta nueva "Órdenes de producción" en
  `/bobinas/:id` lo muestra con links a `/produccion/:id` y `/pedidos/:id` (D-172). Se
  descartó ir por `Reservation.itemId`: una reserva `RAW_MATERIAL` apunta a un agregado
  color+espesor (D-134), no a una bobina física — la bobina concreta recién se decide al
  armar la OP.
- **Cliente sin ficha propia.** No existe `/clientes/[id]`. El link es `/clientes?search=<RUC>`;
  `clientes-view.tsx` lee `?search=` con `useSearchParams()` solo al montar (mismo patrón que
  `?pedido=` en despachos/comprobantes nuevos) y `customerSearchHref()` en `@/lib/utils` arma
  el href. Aplicado en cotizaciones, pedidos, despachos, comprobantes y cobranzas (lista y
  detalle donde correspondía). Dos DTO ganaron un campo aditivo para poder armar el link:
  `DispatchDto.customerId`/`customerDocNumber` y `PurchaseItemDto.coilId` — los dos ya se
  resolvían en el `include` de Prisma, solo faltaba devolverlos.
- **Quedan afuera a propósito** las filas dentro de un `<Select>` de un formulario (elegir
  qué pedido despachar o facturar): ahí un clic ya significa "elegir esta fila", convertirlo
  en link rompería la selección.
- Decisión completa: D-172.

**M2 (T6) — reporte de bobinas en PDF, no sacrificado.**

- Mismo criterio que la hoja de planta del pedido (D-149) y no el de la cotización (D-068):
  es un reporte interno y regenerable, así que se arma al vuelo con `pdfkit` y **no** se
  persiste en R2. `apps/api/src/coils/coil-pdf.ts` concentra los dos armados —
  `GET /coils/:id/pdf` (identificación, saldo, las OP que la montaron, kardex completo) y
  `GET /coils/report-pdf?<mismos filtros que GET /coils>` (la tabla del conjunto filtrado
  actual, topada a `MAX_PAGE_SIZE`/200 filas con aviso en el pie si el filtro trae más) —
  y se descargan con un `<a href="/api/coils/...">` directo, igual que el PDF de planta.
- **Dos bugs reales, ninguno del código que ya tenía cobertura — los dos, de probar de
  verdad.** El primero, probando en el navegador: la primera versión de la tabla genérica
  dejaba que un código de bobina sin espacios (no tiene dónde partirse) se escribiera
  encima de la columna siguiente cuando no entraba en el ancho declarado — y además los
  anchos de columna sumaban más que `CONTENT_WIDTH` en dos de las tres tablas. Se corrigió
  recalculando los anchos y truncando cada celda a una línea con `ellipsis: true`. El
  segundo, encontrado por `revisor`: el salto de página dentro del loop de filas
  (`doc.addPage()`) no volvía a dibujar la fila de encabezados, así que un `report-pdf` de
  varias páginas dejaba la mayoría sin decir qué columna es cuál. Se extrajo
  `drawHeaderRow()` y se llama también ahí.
- Decisión completa: D-173.

**Verificación de esta sesión:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e                           # 234 pasados, 0 fallados, 2 saltados (53.9 min) — mismo
                                    # baseline que la Sesión Saneamiento E2E, sin regresiones
```

Probado a mano en `pnpm dev:local` (Chrome, vía `claude-in-chrome`): los dos PDFs descargan
y su contenido es correcto (bobina con 3 consumos de producción, y una con cero); el link
pedido→cliente filtra `/clientes?search=` a exactamente esa fila; el link compra→bobina
navega a la bobina correcta.

**Cobertura E2E nueva** (agente `qa`, ambas verdes, corridas de nuevo por mí después del
arreglo de `revisor`): `e2e/tests/bobina-consumos-pdf-d172.spec.ts` (3 casos —
`GET /coils/:id/consumptions` vacío/con fila, y los dos PDF con la firma `%PDF` real, no
solo el `Content-Type`) y `e2e/tests/bobina-consumos-ui-d172.spec.ts` (2 casos — la tarjeta
nueva y su link a `/produccion/:id`, y el link de cliente desde `/pedidos` a
`/clientes?search=`). `revisor` no encontró bloqueantes; los dos hallazgos de arriba
(tabla del PDF) y una mejora defensiva en `clientes-view.tsx` (sincronizar `search` con la
URL vía `useEffect`, para cuando en el futuro haya un link hacia `/clientes?search=...`
que navegue **dentro** de la propia pantalla de clientes sin desmontarla) ya están
aplicados.

Ver handoff completo en `docs/handoff/s9-trazabilidad-links-reporte-bobinas.md`.

## Sesión S10 — UX batch: renombres, sidebar, avance de producción (2026-09-10)

Entorno **LOCAL** en toda la sesión. **Nada desplegado y sin push**: PROHIBIDO por el
brief; los commits se suman a los pendientes de sesiones anteriores para la ventana única.

**M1 — Renombres de línea (D-174).** `BUSINESS_LINE_LABELS` cambia de valores, no de
claves: Metallic Roofing → Coberturas Aluzinc, Roofing (UPVC) → Coberturas (UPVC), Trading
→ Reventa, Services → Servicios (Drywall no cambia). Mapeo dado por el dueño, no una
traducción — se preguntó antes de tocar nada porque el brief lo marcaba como pendiente de
confirmar y no había ningún precedente en los docs. Un censo por grep confirmó que
`BUSINESS_LINE_LABELS` es el único punto de renderizado en toda la app: cero strings
sueltos que corregir aparte. Dos ajustes en E2E por selectores que dejaron de ser únicos o
dejaron de existir: `plancha-largo-d166.spec.ts` (un tab por `/Coberturas/` ya no alcanza,
hay dos líneas que empiezan así) y `auth.spec.ts` ("Inicio" → "Panel").

**M2 — Sidebar (D-175).** Grupos reordenados a Comercial, Catálogo, Planta,
Administración; "General" desaparece y "Inicio" (ahora "Panel") queda sin grupo, a la
cabeza. "Márgenes" y "Tipo de cambio" se funden en un ítem con pestañas
(`configuracion/layout.tsx` nuevo, `Tabs` controlado por ruta) — las dos rutas siguen
existiendo, ningún `href` cambió de destino. `NavItem.activePrefix` nuevo para que el ítem
fusionado se resalte en las dos rutas. Ajustado en E2E: `fase1.spec.ts` (el link ahora se
llama "Márgenes y tipo de cambio").

**M3 — Avance en la fila de bobina/fleje montado (D-176).** En `/planta`, cada fila de
material montado gana una línea de solo lectura con datos que el DTO ya traía:
`reportedMeters`/`piecesReported` (agregado de **toda la orden**) · `consumedKg` (de esa
asignación puntual, ya vivía en el DTO sin mostrarse). Cero cálculo nuevo. Verificado
contra `planta-espacio-produccion*.spec.ts`, `planta-avisos-materia-prima.spec.ts` y
`fase4*.spec.ts` (drywall) sin tocarlos — el texto nuevo no colisionó con ningún locator
existente.

**M4 (tablas y cajas info) se difiere a S10b**, por la regla de presupuesto de contexto
que el propio brief puso (`>60% antes de M4 → /compact; si no alcanza, pasa a S10b`).
Antes de diferirlo se hizo el primer paso que pedía el brief — listar, no tocar —: el
"orden descendente por defecto" que pedía ya está en las cuatro listas principales
(cotizaciones y pedidos por `seq desc`, bobinas por `operationDate desc`, órdenes de
producción por `seq desc`); lo que falta de M4 es sort interactivo por columna (no
construido) y la conversión de cajas info largas a popover, con dos candidatos ya
identificados como punto de partida: la nota de D-146 en `roofing-order-panel.tsx`
("El plan es una intención...") y la de D-054 en `pedido-detalle-view.tsx` ("Una reserva
activa descuenta..."). Un censo completo de "vistas afectadas" —el primer paso que M4
exige antes de tocar nada— no se terminó: la mayoría de los párrafos grises de la app son
el subtítulo corto de cada página (no un candidato) y separar esos de una nota larga de
verdad exige leer cada uno, no un grep.

**Lo que encontró `revisor`, ya corregido.** El grep de M1 no podía ver un string que no
está en el código: `pos.service.ts` armaba el badge de línea del Mostrador y dos mensajes
de error (venta mixta, piso de margen en `price-floor.ts`) leyendo `businessLine.name`, la
columna cruda de `business_lines` que sembró el seed en inglés — antes de esta sesión
coincidía por casualidad con `BUSINESS_LINE_LABELS`, después de D-174 divergía. Los tres
pasan a resolver el nombre por el código (`BUSINESS_LINE_LABELS[toSharedLineCode(...)]`);
`PosProductDto.businessLineName` se elimina del todo — el código de línea ya viajaba en el
DTO y el front resuelve el label ahí. De paso, dos mensajes de error apuntaban a
"Configuración → Márgenes", una ruta de menú que nunca existió con ese nombre y que D-175
aleja un paso más: ahora dicen "Administración → Márgenes y tipo de cambio". También:
la línea nueva de M3 podía leerse como si "reportados"/"piezas" fueran de esa bobina o
fleje puntual — el texto ahora dice "de la orden"/"de esta bobina"/"de este fleje" para
que la única cifra realmente propia de la fila (`consumidos`) no se confunda con el
agregado de toda la orden.

**Verificación de esta sesión:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e                           # 239 pasados, 0 fallados, 2 saltados (52.6 min) —
                                    # corrida limpia con las correcciones de revisor adentro
```

Ver handoff completo en `docs/handoff/s10-ux-batch-renombres-sidebar-produccion.md`.

## Sesión S10b — Cierre de M4: sort en tablas + cajas info a popover (2026-09-10)

Sesión corta (brief: ~30-45 min), sin push. Cierra M4, la mitad de S10 que quedó
diferida.

**M1 — Sort de columna (D-177).** `apps/web/src/lib/use-sort.ts` (hook `useSort` +
`compareBy`/`compareDecimalBy`, esta última por `Decimal.comparedTo` — regla dura 1) y
`apps/web/src/components/sortable-table-head.tsx` son el mecanismo único, aplicado a
cotizaciones, pedidos, bobinas (paginadas: sort solo de la página actual) y producción
(sin paginar: sort del conjunto entero). `key: null` es el default — sin clickear nada, el
orden es el que ya manda el servidor (descendente, D-113/D-124), intacto.

**M2 — Cajas info → popover (D-178).** `apps/web/src/components/ui/popover.tsx` (nuevo,
`radix-ui`) + `apps/web/src/components/info-popover.tsx`. Aplicado a los dos candidatos
que dejó identificados el handoff de S10: la nota de D-146 en "Plan de corte"
(`roofing-order-panel.tsx`) y la de D-054 en "Reservas de material"
(`pedido-detalle-view.tsx`). Avisos condicionales de negocio no se tocaron — siguen
siempre visibles, por criterio explícito.

**Un desvío que costó tiempo y no era un bug:** a mitad de sesión, un `pnpm e2e` en
background con la salida canalizada a `tail -60` mostró 0 bytes durante varios minutos, y
el proceso del API resultó ser `node .../dist/main` en vez de lo que se esperaba de
`nest start`. Se interpretó como servidor con código viejo (mismo síntoma que ya había
costado una corrida completa en S10) y se mató el proceso dos veces antes de confirmar que
**`nest start` sin `--watch` compila a `dist/` y corre desde ahí siempre** — ver esto en
la lista de procesos es normal, no evidencia de caché ni de modo CI. La demora real la
causó canalizar la salida de un comando en background a `tail` sin `-f`: eso junta toda la
salida hasta el final y no imprime nada mientras tanto, así que 0 bytes no quería decir
"colgado". Ninguno de los dos hallazgos tocó código de producto.

**Verificación de esta sesión:**

```bash
pnpm turbo lint typecheck test     # verde (399 unitarios)
pnpm exec eslint e2e               # verde
pnpm format:check                  # verde
pnpm e2e e2e/tests/fase1.spec.ts e2e/tests/fase5a.spec.ts \
  e2e/tests/planta-espacio-produccion-ui.spec.ts   # 17 pasados, dirigidos a M1/M2
pnpm e2e                           # 239 pasados, 0 fallados, 2 saltados (51.1 min) —
                                    # mismo baseline que S10, sin regresiones
```

`revisor` no encontró bloqueantes. Dos hallazgos BAJO en `roofing-order-panel.tsx`: dos
notas estáticas más que cumplían el criterio de M2 y se habían dejado afuera. Una
("Dato de planta: el kardex sale por el kilo teórico...", junto al campo "kg consumido")
pasó a `InfoPopover` en la misma sesión. La otra ("Sin este dato se asume que la bobina
consumió...", junto al cierre sin reportar) se dejó **a propósito**: mezcla un valor en
vivo (`consumedFloorKg`) con dos avisos de validación condicionales que el propio criterio
de M2 dice que tienen que seguir siempre visibles — convertirla entera habría escondido un
error de validación detrás de un clic.

Ver handoff completo en `docs/handoff/s10b-cierre-m4-sort-popover.md`.

## Sesión S11 — T7: escritorio robusto y compacto, color e inspección de flujos (2026-09-11)

Sobre S10b cerrado. **Todo local: nada desplegado y sin push**, prohibido por el brief —
los commits se suman a los pendientes de S9/S10/S10b para la ventana única.

El perfil de uso lo fijó el dueño como decisión de negocio y no se cuestionó: el ERP se
opera **solo en PC de escritorio**, el operario de planta no usa la app y el supervisor
ingresa todo, incluida producción. No hay objetivo móvil ni tablet, y no se agregó ni una
media query para pantallas chicas.

### Fase 1 — inspección de flujos (`docs/analisis/s11-inspeccion-flujos.md`)

Se recorrieron los cinco flujos del brief en un Chrome real contra `pnpm dev:local`, y se
ejecutaron de verdad —no solo se miraron— una cotización completa (COT-000054 creada,
emitida y rechazada al confirmar por falta de materia prima), una orden de producción
reportada y cerrada desde `/planta` (OP-000007) y un despacho (DES-000001). El reporte
clasifica cada hallazgo en (a) fix barato de UI, (b) lógica o schema —solo documentado— y
(c) fricción de flujo, y se commiteó **antes** de tocar una sola línea de producto.

Los dos hallazgos que mandan sobre el resto:

- **T-01 — toda la app se renderizaba en Times New Roman.** `globals.css` declaraba
  `--font-sans: var(--font-sans)` dentro de `@theme inline`, una autorreferencia que no
  resuelve, y `layout.tsx` aplicaba las variables de `next/font` en `<body>` cuando quien
  consume `font-sans` es `<html>`. La declaración quedaba inválida y el navegador caía a su
  fuente serif por defecto. Verificado con `getComputedStyle(document.documentElement)
.fontFamily === '"Times New Roman"'`. Es un fix de dos líneas y cambia la lectura de todas
  las pantallas del sistema.
- **F2-01 — con transporte no se puede despachar ninguna línea que no se mida en kilos.**
  `apps/api/src/invoicing/dispatches.service.ts:243-250` exige `weightKg` por línea cuando la
  modalidad no es recojo y la unidad no es `KGM` (la regla es correcta y está bien razonada:
  en una cobertura a medida `reserveQty` son metros, y heredarlo declararía 24.6 kg en la
  guía por 268 kg de planchas). El formulario **nunca pide ese campo**: no aparece en
  `nuevo-despacho-view.tsx`, aunque el schema compartido lo tiene
  (`packages/shared/src/schemas/invoicing.ts:637`) y el detalle del despacho ya lo muestra.
  Reproducido de punta a punta con PED-000023 (`NIU`) y «Transporte privado»: 400 y ningún
  campo donde escribir el peso; con «Recojo en mostrador» el mismo despacho pasa. **La suite
  E2E no lo ve porque despacha por API** (`e2e/helpers/invoicing.ts` manda `weightKg` en el
  payload), así que la pantalla nunca se ejerce en ese punto. Es (b): queda documentado para
  Fase 8 y no se tocó.

El resto del reporte: el toast tapaba —y se comía el clic de— la barra de acciones (T-02);
la tira de cuatro tarjetas KPI copiada en seis vistas (T-04); los badges de estado sin
convención única (T-05); el rojo decorativo de `/cobranzas` (T-06); el menú más alto que la
pantalla (T-07); el sort que llegó solo a cuatro listas (T-08); dos pantallas con el mismo
`<h1>` (F1-01); los botones de cierre de orden a escala táctil (F1-02); el botón de
despachar apagado sin decir qué falta (F2-02); el motivo del kardex cortado sin forma de
leerlo (F3-01); el vacío del mostrador que contestaba una búsqueda que nadie hizo (F4-01).

**Un hallazgo se cayó al medirlo, y quedó anotado en vez de borrado.** F4-02 decía que el
carrito del mostrador quedaba en «~270 px»: salió de leer píxeles de una captura escalada
como si fueran píxeles CSS. El carrito es `lg:grid-cols-[1fr_24rem]`, o sea 384 px. Una
captura escalada no es una medida.

### Fase 2 — densidad y robustez (D-179)

**B1 — densidad.** Línea base y resultado, medidos con el primer `<tr>` de cada lista y
normalizados a un viewport de 950 px de alto (lo que deja una ventana maximizada a 1080p):

| Lista           | Antes | Después |        |
| --------------- | ----: | ------: | -----: |
| `/cotizaciones` |  13.3 |    23.4 |  +76 % |
| `/pedidos`      |  13.3 |    23.4 |  +76 % |
| `/bobinas`      |  15.5 |    23.1 |  +49 % |
| `/produccion`   |   6.5 |    13.2 | +103 % |

Tres de las cuatro superan el objetivo del brief (≥50 % más filas) y bobinas queda en +49 %:
es lo que había para ganar ahí, porque sus filas ya eran de una sola línea y no tenían la
grasa que tenían las otras. La densidad salió de **sacar andamiaje** —cromo de página,
tarjetas de una cifra, líneas de más en una celda— y no de achicar el dato: el texto de
tabla sigue en 14 px.

Además del arreglo de la fuente: cabecera de 48→32 px, `main` de `gap-6 p-6` a `gap-3 p-4`,
`h1` a 18 px, `h2` unificados a 14 px, `Label` a 12 px, celda `px-2.5 py-1.5` con encabezado
atenuado y `tabular-nums`, `Badge` de 20→18 px, `--card-spacing` a 12 px, `StatStrip`/`Stat`
en lugar del bloque de cuatro `Card` repetido en cinco vistas, el documento del cliente al
lado del nombre en vez de debajo, y la nota de la cola de producción a `InfoPopover` (mismo
criterio de D-178). Dos `inline-flex` apoyados en la línea base —la muestra de color y el
badge— estiraban cada fila ~4 px: `align-middle`.

**B2 — robustez 1366-1920.** El hallazgo grande: **`SidebarInset` no tenía `min-w-0`**, así
que el panel de contenido no bajaba de su ancho mínimo automático y quedaba tan ancho como
la ventana **además** del menú de 256 px. Toda la app scrolleaba 256 px en horizontal a
cualquier ancho de pantalla, y a 1366 px los botones de acción de cada lista quedaban fuera
de la ventana. Medido antes y después con el viewport en 1366:
`document.documentElement.scrollWidth` 1622 → 1366.

Lo otro: una razón social de ochenta caracteres con `whitespace-nowrap` empujaba la tabla de
cotizaciones 363 px más allá del ancho disponible — el nombre ahora se corta con elipsis y
queda entero en el `title`, y el documento **no** se corta porque es el que desambigua. Y el
menú lateral pasó de 944 a ~780 px (ítem 32→28, encabezado de grupo 32→24, pie 113→69).

Verificado a 960, 1366 y 1920 px con un navegador de viewport real: sin desborde horizontal
de página en listas, detalles ni formularios. Las tablas anchas siguen scrolleando dentro de
su propio contenedor, que es lo que corresponde.

**B3 — los fixes baratos (a) de la Fase 1.** Toast a `bottom-right`; `/produccion` pasa a
titularse «Órdenes de producción» (`/planta` conserva «Producción», que es lo que D-160
separó); los veinte controles `h-12`/`h-16 text-lg` de `/planta` vuelven al tamaño del resto
de la app y los dos botones de cierre de orden dejan de ocupar media tarjeta cada uno; el
«por» huérfano de la línea sin producto; el formulario de despacho dice **qué** falta, en
palabras, con las mismas condiciones que habilitan el envío; el motivo del kardex completo
en el `title`; el mostrador deja de contestar una búsqueda que nadie hizo.

### Fase 3 — color (D-180)

Un solo color de marca —azul acero, `oklch(0.46 0.105 248)`— sobre la escala de neutros que
ya estaba, y cuatro tonos de estado con un significado fijo: `progress`, `done`, `warning` y
`danger`, más neutro para lo anulado o revertido. El mapa de estado a tono vive en
`apps/web/src/components/status-tone.ts` y es `Record<Status, StatusTone>` **exhaustivo**
para las nueve familias de estado: un estado nuevo en `@ayr/shared` no compila hasta que
alguien decida qué significa.

El problema que resolvía no era que faltara color, era que el mismo color quería decir cosas
distintas: el negro sólido era «Aceptada» en comprobantes (terminó bien), «En producción» en
pedidos (sigue en curso) y «Activa» en reservas, mientras «Atendido» —el terminal bueno de un
pedido— era el gris más apagado de la paleta.

**Rojo y ámbar quedan reservados para error y aviso.** El único uso decorativo que quedaba
—«Vencido S/ 0.00» en rojo fijo— ahora se pinta solo cuando el vencido es mayor que cero,
comparado con `Decimal`. Un estado anulado se pinta **neutro y no rojo** a propósito: es una
decisión tomada, no un problema, y teñir de rojo cada cotización anulada convierte el rojo en
ruido justo donde tiene que gritar.

Contrastes medidos en el navegador (canvas + fórmula WCAG), en claro y en oscuro: `progress`
7.41/8.05, `done` 7.83/8.51, `warning` 7.07/8.64, primario 6.83/7.66, texto atenuado 4.74.
Ninguno baja de 4.5:1.

### El cierre de la revisión, y la única falla de E2E

`revisor` no encontró bloqueantes, y confirmó lo que más importaba: el `canSubmit` reescrito
del formulario de despacho es **exactamente equivalente** al anterior, condición por condición
— era el único lugar donde una sesión de presentación podía haberse llevado puesta una regla
de negocio sin que nadie lo notara. Los cinco hallazgos MEDIO eran incoherencias de las
decisiones que esta misma sesión acababa de tomar (tres enums sin mapa de tono, el detalle de
compra eligiendo variante a mano, el semáforo de la cola sin pasar por la convención, el badge
derivado del pedido, los campos numéricos de planta sin criterio de tamaño), así que se
cerraron todos: dejarlos habría hecho que D-180 dijera algo que el código no cumple. Después
de ese commit **no queda ningún `Badge` de estado eligiendo variante a mano en la app**.

La suite tardó tres corridas y vale la pena decir por qué:

1. La primera se cortó al 16 %: el `revisor` volvió con esos hallazgos mientras corría, y
   seguir 45 minutos para después tener que correrla de nuevo con los arreglos adentro era
   gastar una corrida por nada.
2. La segunda terminó en **238 pasados, 1 fallado**. La falla era real y era mía, no un
   selector viejo: `fase7e-ajustes-d121.spec.ts:92` busca las piezas teóricas con
   `getByText('1200.0', { exact: true })`, y al pasar el detalle de la OP a `StatStrip` la
   cifra quedó pegada al renglón de contexto en el mismo nodo de texto —«1200.0Del fleje
   montado, vs. 0 reportadas»—, así que ningún elemento tenía por texto la cifra. **Se arregló
   el componente, no el spec**: el spec tiene razón en buscarlo así, porque lo que la pantalla
   promete es mostrar la cifra y no una cadena que la contenga. El mismo patrón se corrigió
   preventivamente en el peso bruto del despacho y en el saldo del comprobante, que mezclaban
   cifra y nota de la misma forma.
3. La tercera cerró en **239 pasados, 0 fallados, 2 saltados (54.6 min)** — el mismo baseline
   que S9/S10/S10b.

Un solo spec se tocó en toda la sesión, y por un cambio de presentación:
`e2e/tests/auth.spec.ts` busca el correo del usuario por `title` en vez de como texto visible,
porque el pie del menú lo movió ahí al bajar de 113 a 69 px.

Handoff completo en `docs/handoff/s11-escritorio-compacto-color.md`.

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

## Pendientes abiertos de la Sesión Cierre de bobina (2026-09-09)

- **Revisar el 1 % de merma normal con datos reales (D-165).** El factor lo fijó el dueño como
  regla del cliente, sin datos detrás. Ahora que D-164 hace visible la merma **anormal** —el
  remanente que se liquida al cerrar, con su `refType` propio en el kardex—, con **2 o 3
  cierres reales** se puede comparar lo liquidado contra lo que el estándar ya absorbió y ver
  si el 1 % está bien puesto. La pregunta que sigue abierta es si conviene que sea **por
  acabado** en vez de uno solo: un prepintado delgado y un galvanizado grueso no tienen por qué
  perder lo mismo. Si se decide por acabado, la forma **no** es tipearlo en
  `finishes.density_factor` (ver el porqué en D-165) sino una columna propia de merma normal
  que `standardDensityFactor` lea. **Antes de tocar el porcentaje**, convertir a
  `KG_PER_METER` los kilos que los fixtures de coberturas todavía escriben como literal (ver
  «El precio de D-165» arriba): son 16 y hoy atan la suite a este 1 % concreto.
- **Decidir el aviso de mínimo en el mostrador.** El insumo ya está: `pnpm check:price-floor`
  dice cuántos SKU activos quedan por debajo del piso de D-163. Correrlo contra `production`
  necesita el OK del dueño (es solo lectura, pero contra la base real). Si la respuesta es
  "pocos", el aviso en el carrito es barato; si es "muchos", primero hay que revisar la lista
  de precios o los márgenes mínimos, no poner el bloqueo.
- ~~**Migraciones pendientes de desplegar**, acumuladas de esta sesión y las anteriores: D-145,
  D-146, las dos de D-153, la de D-154, la de D-157, la de D-161
  (`20260909210000_d161_plancha_por_metro_lineal`) y la de esta sesión
  (`20260909230000_d164_liquidacion_de_remanente_al_cierre`). **La de D-164 va antes que el
  API nuevo**: es aditiva (un valor más en el enum `InventoryRefType`), así que el API viejo
  contra la base migrada funciona igual, pero el API nuevo contra la base sin migrar escribe
  `CLOSE_ADJUSTMENT` y revienta.~~
  **RESUELTO (ventana del 2026-09-10):** `prisma migrate status` contra `production` responde
  **«Database schema is up to date!»** con las 55 migraciones del repo. Las ocho de esta lista
  ya se habían aplicado en la ventana anterior y la lista quedó sin limpiar. **Lección: esta
  lista se comprueba, no se cree** — `node scripts/migrations-status.mjs --branch production`
  es de solo lectura y tarda diez segundos, y una lista de pendientes que envejece sin
  verificarse hace exactamente lo contrario de lo que existe para hacer: en esta ventana estuvo
  a punto de motivar un `pnpm db:prod` que no hacía falta.

## Pendientes abiertos de la Sesión HOTFIX (2026-09-10)

- **Un pedido de solo servicios no llega a `FULFILLED`** y se queda en `CONFIRMADO` para
  siempre (D-167). Es honesto —el ERP no modela la ejecución de un servicio, así que no tiene
  con qué decidir que terminó— pero deja una fila viva en la lista de pedidos que nadie va a
  poder cerrar. Las salidas posibles son un cierre manual con motivo (el patrón de D-164) o
  dejarlo así y filtrarlo en la lista. **Decisión del dueño**, y conviene tomarla recién cuando
  aparezca el primer pedido de solo servicios: hasta hoy no existe ninguno.
- **La edición de una cotización importada conserva el importe solo si el trío no cambió**
  (producto, cantidad, valor unitario). Si alguien corrige el **precio** de una línea, esa
  línea vuelve a calcularse y el documento deja de coincidir con el papel en esa línea. Es lo
  correcto —quien edita el precio está diciendo que el papel decía otra cosa— pero no hay nada
  en la pantalla que lo avise. Un cartel en el formulario de edición de una cotización
  importada sería barato.
- **El importador sigue derivando el unitario y no deja editar el importe.** El campo editable
  del preview es el **precio unitario**, así que corregir una fila obliga a pensar al revés
  (qué unitario da el importe que quiero). Lo natural, ahora que el importe manda, sería que el
  campo editable **fuera el importe** y el unitario se derivara a la vista. No se hizo en esta
  sesión para no mover la forma de una pantalla que el dueño ya conoce en medio de un hotfix.
- **Reabrir la producción a stock de coberturas** (D-171) exige responder antes qué hace una
  línea de pedido cuando ese saldo existe: ¿lo toma?, ¿lo ignora y produce igual?, ¿lo toma
  hasta donde alcanza y produce el resto? `createToStock` quedó en el archivo, sin llamadores,
  esperando esa respuesta.
- **`BOB38AZUL` y `BOB38ROJO` en `production`** son productos `BOB…` que ninguna bobina nombra
  (los lista `pnpm check:coil-skus`). No son restos de D-168 —su forma no es la que genera
  `coilSku`— sino SKU creados a mano. Antes de darlos de baja hay que ver si alguno está
  cotizado o vendido; el guion no borra nada a propósito.

### Necesitan acción tuya

- **Vaciar los comprobantes de la cuenta demo del PSE.** Sigue en su tope («No puedes enviar mas
  de 50 documentos en en una cuenta DEMO»). **Desde el saneamiento E2E ya no ensucia la corrida
  por defecto**: esos 12 casos están etiquetados `@pse` y salen aparte con `pnpm e2e:pse`. Pero
  la deuda sigue viva — mientras la cuenta esté llena, **esos 12 casos no se están corriendo**,
  y son los que cubren el ciclo fiscal completo hasta la aceptación. Vaciarla y correr
  `pnpm e2e:pse` es lo que los vuelve a poner en verde.
- ~~**El selector de cliente de la cotización no ve más de 200 clientes y no tiene
  búsqueda.**~~ **Medio resuelto en el saneamiento E2E**: pasó a `SearchSelectField` (D-156) y
  el umbral bajó a 20, así que con los 49 clientes activos de producción el vendedor ya tiene
  buscador. **Lo que sigue abierto es el tope**: `fetchAllForPicker` trae como mucho 200 y
  `/customers` ordena por `isActive desc, name asc`, así que con más de 200 activos los últimos
  siguen sin aparecer — y sin ningún error, simplemente no están. Levantarlo es **buscar del
  lado del servidor** (`/customers` ya acepta `search`), y alcanza a los tres campos que usan el
  componente. Hoy no aprieta: 49 de 200.

## Notas operativas

- **RESUELTO en el saneamiento E2E (2026-09-10).** Las dos notas de abajo —recrear la base a
  mano, y los 409 al azar por maestros acumulados— describen un problema que **ya no existe**:
  `reset-test-db.ts` vacía las 45 tablas en cada corrida, así que la base nunca envejece. Se
  dejan porque explican por qué el reset es como es, y porque la segunda documenta el otro
  efecto de la acumulación —**la pantalla que cambia de forma según cuántas filas haya**— que
  **sigue vivo dentro de una misma corrida** y volvió a morder en esta sesión (ver «El fallo que
  enseñó más que su arreglo»).
- **Sesión Cierre de bobina (2026-09-09). La base de E2E se recreó desde cero, y conviene
  volver a hacerlo.** El 409 anotado abajo (proveedores/colores repetidos al azar contra un
  maestro que el reset no trunca) dejó de ser ruido de fondo y pasó a tapar la señal: con
  varias corridas seguidas en una misma sesión, `ayr_local_e2e` llegó a **1 874 proveedores,
  841 colores, 2 902 productos, 1 576 acabados y 1 195 clientes**, y los 409 aleatorios se
  llevaban puestos una decena de casos por corrida, en specs que no hablan ni de proveedores
  ni de colores. Verificar un cambio no aditivo con ese ruido encima es imposible.

  La salida fue **recrear la base**, que no es lo mismo que cambiar qué trunca el reset (eso
  sigue sin tocarse, por el motivo de siempre): `ayr_local_e2e` es descartable y de uso
  exclusivo de la suite, y una base recién creada es exactamente lo que tiene CI, que está en
  verde. Con el contenedor arriba:

  ```bash
  docker exec ayr-local-db psql -U ayr -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='ayr_local_e2e' AND pid <> pg_backend_pid();"
  docker exec ayr-local-db psql -U ayr -d postgres -c "DROP DATABASE ayr_local_e2e;"
  docker exec ayr-local-db psql -U ayr -d postgres -c "CREATE DATABASE ayr_local_e2e OWNER ayr;"
  ```

  El `globalSetup` de Playwright aplica migraciones y seed en la corrida siguiente, así que no
  hay nada más que hacer. **Nunca contra `ayr_local`**, que es la base de `pnpm dev:preview` y
  del dueño (regla dura 15). Vale la pena correr esto **antes** de una tanda larga de E2E, no
  después de pelear con los 409.

- **Sesión Planta III (2026-09-09). La base de E2E envejece y produce 409 al azar.**
  `apps/api/prisma/reset-test-db.ts` trunca el kardex, las bobinas, las compras, los pagos, las
  sesiones, la auditoría y los usuarios; **no** trunca `customers`, `products`, `suppliers`,
  `colors` ni `finishes`, y esas tablas tampoco caen por CASCADE. Medido en esta sesión sobre
  `ayr_local_e2e`: **1 019 proveedores, 1 582 productos, 860 acabados, 627 clientes y 471
  colores** acumulados entre corridas. Dos consecuencias reales, las dos observadas:
  (a) `409 Ya existe un proveedor con ese documento` y `409 Ya existe un color con ese código`
  lanzados **desde dentro de `setupRoofingScenario`**, en casos que no hablan ni de proveedores
  ni de colores — los helpers generan códigos de 6 caracteres al azar contra un maestro de mil
  filas; se mitigó agregando un correlativo de proceso a los generadores de `e2e/helpers`, pero
  la causa sigue en el reset. (b) Con 627 clientes, el `SearchSelectField` de D-156 está
  **siempre en modo modal** en local y en modo `<select>` en una base recién creada: el
  importador cambia de forma según la edad de la base, y un spec que asuma una sola forma pasa
  en una máquina y falla en CI. Sigue sin tocarse por el mismo motivo que la sesión anterior:
  cambiar qué trunca el reset puede romper specs que hoy dependen de que algo sobreviva, y eso
  se mira con la suite completa delante, no de paso.
- **Sesión Planta III (2026-09-09).** En una corrida de Playwright el API de `:3000` **murió a
  mitad**: todo pasó a `500` y después el puerto quedó sin escuchar, tumbando once casos con
  `Login admin falló: 500`. Al relanzar, verde. No se encontró causa y no se reprodujo; queda
  anotado por si vuelve, porque el síntoma (`500` en el login) no se parece en nada a "el
  servidor se cayó".
- **Sesión de estabilización (2026-09-08).** Un archivo de trabajo de `local-data/` no está
  en git y no tiene copia en ningún lado: si una herramienta lo pisa, se perdió. Pasó con
  `Ventas Detalladas.decisiones.json` (ver el incidente arriba). El CLI ya no puede pisarlo,
  pero la regla general vale para todo lo que viva ahí: **antes de correr una herramienta que
  escriba en `local-data/`, copiar a mano lo que costó trabajo llenar.**
- **Sesión de estabilización (2026-09-08).** Para smokear el artefacto **compilado** (lo que
  corre en Cloud Run) sin desplegar nada: `pnpm build` y después `pnpm e2e <suite>` con
  `CI=true` más `DATABASE_URL`/`DIRECT_URL`/`JWT_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`
  apuntando al Postgres de Docker. Con `CI=true`, `playwright.config.ts` levanta
  `node dist/main.js` + `next start` en vez de `nest start` + `next dev`.
- **Sesión 7-final-C.** `pnpm db:migrate` (`prisma migrate dev`) volvió a pedir un `migrate
reset` contra `dev` ("la migración X fue modificada después de aplicarse", tres migraciones
  de sesiones anteriores) — el mismo síntoma que D-053 ya había resuelto una vez, de vuelta.
  **No se investigó la causa ni se resetea nada**: la migración de esta sesión se escribió a
  mano (mismo formato que las demás, carpeta con timestamp) y se aplicó con `prisma migrate
deploy` (que no hace el diff contra un shadow DB y no dispara el aviso). Si esto se repite,
  vale la pena mirarlo con más calma antes de la próxima migración — por ahora, `migrate
deploy` es la vía de escape que no arriesga los datos de `dev`.
- **Sesión 7-final-C.** Un script standalone que reusa un servicio de Nest completo
  (`NestFactory.createApplicationContext`, no un endpoint HTTP) **no se puede correr con
  `tsx`**: esbuild no emite `emitDecoratorMetadata` de forma confiable en un grafo de
  dependencias con tipos circulares (síntoma: `UndefinedDependencyException` al resolver
  `AuthService`, y **sin ningún error visible** — el proceso termina con `process.exit(1)` en
  silencio incluso con `.catch()` y `process.on('uncaughtException', ...)` puestos, porque
  Nest lo logea con su propio logger interno y `{logger: false}` lo apaga entero). `nest
build` tampoco sirve si el script vive en `prisma/` (`tsconfig.build.json` lo excluye a
  propósito). La solución fue un `tsconfig.cli.json` que compila con `tsc` real a `dist-cli/`
  y correr el `.js` con `node` liso — ver `apps/api/tsconfig.cli.json` y
  `scripts/import-ventas.mjs`. Cualquier script futuro que necesite reusar un `Service` de
  Nest fuera de un request HTTP debería copiar este patrón, no `tsx`.
- **Sesión 7-final-C.** `prisma generate` puede fallar con `EPERM: ... query_engine-windows.dll.node`
  si otro proceso de Node (de esta sesión o de otra) todavía tiene el binario abierto — no es
  un defecto del código, es un lock de Windows. Si pasa, confirmar con `tsc --noEmit` y `nest
build` por separado (no dependen del binario recién generado si el cliente ya estaba
  generado de una corrida anterior) antes de asumir que algo se rompió.
- `gcloud` en Git Bash falla ("Python was not found"); funciona vía `cmd /c gcloud ...` o desde PowerShell/cmd. `scripts/lib.mjs#run` ya lo resuelve.
- La rama por defecto de Neon se llama `production` (no `main`). Ver D-016.
- Prisma bloquea `migrate reset` cuando lo invoca un agente. El reset de pruebas es `apps/api/prisma/reset-test-db.ts` (D-018).
- **Fase 3b (resuelto en Sesión M-1, ver D-053).** `pnpm db:migrate` (`prisma migrate dev`) volvió a funcionar contra `dev`: la carpeta `20260903031603_fase3_corte_flejes` se renombró a `20260904125000_fase3_corte_flejes` (entre `fase2b` y `fase3b`, el orden real de aplicación) y `_prisma_migrations.migration_name` se sincronizó a mano en `dev` y `production`. Ya no hace falta escribir migraciones a mano ni usar `migrate deploy` para esquivar el shadow database; una migración nueva se crea con el flujo normal (`pnpm db:migrate`).
- `vercel build` local falla en Windows por symlinks; el deploy es con build remoto (D-019). El proyecto Vercel está ligado al repo GitHub: cada push a `main` despliega el web.
- El proxy `/api/*` del web es un Route Handler (fetch server-side), no un `rewrite()` de Next: Vercel bloquea rewrites hacia el dominio por defecto de Cloud Run (D-022).
- Para verificar RF-03 contra producción: `pnpm e2e:prod`. Crea un administrador efímero, corre los 6 escenarios de auth y borra los usuarios `e2e-...@ayr.test` en `finally` (D-024). Nunca usa ni modifica la cuenta del dueño. Si la limpieza fallara, el script lo avisa y hay que revisar `/usuarios` en producción.
- `spawnSync('algo.cmd', ...)` sin `shell: true` falla con `EINVAL` en esta máquina Windows/Node 24; usar `shell: true` (o invocar `cmd.exe /c` explícito) al lanzar `pnpm`/binarios `.cmd` desde Node.
- **Fase 7 (2026-09-05):** el token del CLI de Vercel (`%APPDATA%/xdg.data/com.vercel.cli/auth.json`) venció; `pnpm deploy:web` falla con `403 invalidToken`. No bloquea: el proyecto Vercel está ligado al repo de GitHub (ver arriba), así que el push a `main` de esta fase dispara igual el deploy del web. `pnpm deploy:web` vuelve a hacer falta el día que se necesite un deploy fuera de un push (p. ej. reapuntar `API_URL` sin cambiar código) — ahí sí hace falta que el dueño corra `vercel login` primero.
- **Fase 7 (2026-09-05), RESUELTO en Fase 7b:** `pnpm prod:purge-e2e` revertía el despacho E2E **después** de deshacer la producción, así que `reverseReport` se topaba con su propia salida de despacho —bloquea si el producto tuvo movimientos posteriores vivos que no sean `IN`— y la orden quedaba reabierta a medias con saldo fantasma en el kardex. El bloque de órdenes de producción se movió **después** del ciclo fiscal y logístico y antes de los pedidos: con el despacho ya revertido, reabrir → revertir el reporte → anular pasa en una sola corrida. No hizo falta enseñarle al guion a distinguir materia prima de producto terminado: bastaba el orden.
- Hallazgos de revisión pendientes (bajos): pinear acciones de GitHub a SHA, CSP en el web, job de limpieza de `sessions` expiradas, `Permissions-Policy`. Registrados aquí para Fase 7 (hardening).
- SonarCloud: en `.env.setup` `SONAR_ORG` y `SONAR_PROJECT_KEY` venían intercambiados (corregido: org `gsinuiri-coder`, key `gsinuiri-coder_ayr-steel-erp`). El proyecto tenía Automatic Analysis activo; se desactivó por API para que el análisis lo haga CI con cobertura (D-021).
- Los subagentes de `.claude/agents/` solo aparecen en el selector tras reiniciar la sesión de Claude Code; en esta sesión se ejecutaron como `general-purpose` con la definición como prompt.
- **Fase 1.** apis.net.pe: el endpoint real es `v1/tipo-cambio-sunat?fecha=YYYY-MM-DD` (verificado contra la API real), no `v2/sunat/tipo-cambio` como se asumió al principio — devolvía 404 y quedó registrado un momento en el log como "no respondió" antes de corregirlo.
- **Fase 1.** `XLSX.read(buffer, {type:'buffer'})` asume un codepage no-UTF-8 para `.csv`, lo que rompe encabezados con tildes ("Línea" no matcheaba ninguna columna). `parse-spreadsheet.ts` ahora detecta si el archivo es un zip real (firma `PK`, `.xlsx`) y si no lo es, decodifica como UTF-8 y lee en modo `'string'`. Encontrado por el E2E de importación, no es cosmético: sin este fix ninguna fila con encabezados en español se validaba nunca.
- **Fase 1.** El E2E de CI (`imports`) sube archivos reales al bucket R2 de producción (`R2_BUCKET` es el mismo en GCP y en GitHub Secrets); quedan objetos de prueba con prefijo `imports/...` en R2 tras cada corrida de CI. No es un riesgo de seguridad, pero conviene un bucket o prefijo separado para CI si el volumen de corridas crece (anotado para Fase 7).
- Prisma expone el enum `BusinessLineCode` con los nombres declarados en el schema (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`, `metallic-roofing`...); `apps/api/src/common/business-line-code.ts` es el único lugar que traduce entre eso y el `BusinessLine` de `@ayr/shared`. Si se agrega una sexta línea de negocio, hay que tocar ese mapa además del enum de Prisma y el de `@ayr/shared`.
- **`ADMIN_PASSWORD` de `.env.setup` ya no es la contraseña real del admin en `production`.** El dueño la cambió al completar el flujo de `mustChangePassword` en su primer ingreso (cierre de Fase 0). Un intento de `POST /auth/login` contra producción con las credenciales de `.env.setup` devuelve `401 Credenciales inválidas` (evidencia de esta sesión, sin haber tocado nada). **Nunca** intentar loguearse como el admin real contra producción para verificar algo: usar siempre un administrador efímero (`apps/api/prisma/e2e-admin.ts` + `cleanup-e2e-users.ts`, patrón D-024) igual que hace `pnpm e2e:prod`.
