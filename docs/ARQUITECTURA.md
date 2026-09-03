# AYR STEEL ERP — Documento vivo de Arquitectura, Análisis y Requisitos

> **Documento vivo.** Fuente de verdad del proyecto. El agente (Claude Code) lo actualiza al cerrar cada fase: nuevas decisiones van a §0.2, avances a `docs/PROGRESO.md`, requisitos nuevos o cambiados se editan aquí con su RF.
> Origen: `AYR-Steel-ERP-Arquitectura-2026-09-01.docx` (v1, 2026-09-01). Convertido y ampliado el 2026-09-02.

## 0. Control del documento

### 0.1 Reglas de edición

- Identificadores de código (variables, propiedades, columnas, funciones, archivos, rutas API) en **inglés**. Todo lo demás (UI, mensajes, comentarios, docs, commits) en **español**.
- Cada requisito lleva ID `RF-nn`. Un RF sin referencia a módulo/ruta que lo implemente = pendiente.
- Decisiones se registran como `D-nnn` en §0.2 con fecha, decisión y motivo. No se borran; se marcan `SUPERSEDIDA por D-nnn`.
- Preguntas abiertas viven en §5 hasta resolverse; al resolverse pasan a §0.2.

### 0.2 Bitácora de decisiones (ADR corto)

| ID    | Fecha      | Decisión                                                                                                                                                                                                                                                                                                                                                                                                                          | Motivo                                                                                                                                                                                                                                                  |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-001 | 2026-09-02 | Greenfield. **No existe data real** que migrar de la versión previa (Firebase). Toda carga histórica entra por importación masiva desde planilla (RF-12, RF-52, RF-71).                                                                                                                                                                                                                                                           | Confirmado por el dueño del proyecto.                                                                                                                                                                                                                   |
| D-002 | 2026-09-02 | Monorepo `pnpm` + Turborepo: `apps/api`, `apps/web`, `packages/shared`.                                                                                                                                                                                                                                                                                                                                                           | Tipos y esquemas Zod compartidos API↔Web.                                                                                                                                                                                                               |
| D-003 | 2026-09-02 | API: NestJS + Prisma. Dinero, pesos (kg) y medidas (mm) en columnas `NUMERIC` → tipo `Decimal` de Prisma. Prohibido operar montos/pesos con `number`.                                                                                                                                                                                                                                                                             | Precisión exacta para kardex, costeo, IGV.                                                                                                                                                                                                              |
| D-004 | 2026-09-02 | Web: Next.js App Router + shadcn/ui + Tailwind + TanStack Query/Table + React Hook Form + Zod.                                                                                                                                                                                                                                                                                                                                    | Densidad de ejemplos para agentes; shadcn vive en el repo.                                                                                                                                                                                              |
| D-005 | 2026-09-02 | DB: Neon Postgres 17, proyecto `ayr-steel-erp`, región `aws-us-east-2`. Ramas: `main` (prod), `dev`, `ci`.                                                                                                                                                                                                                                                                                                                        | Wake ~300 ms; branching para tests.                                                                                                                                                                                                                     |
| D-006 | 2026-09-02 | Colas/jobs: **pg-boss** sobre Postgres. Sin Redis.                                                                                                                                                                                                                                                                                                                                                                                | Una pieza menos; suficiente para SUNAT, PDFs, importaciones.                                                                                                                                                                                            |
| D-007 | 2026-09-02 | Storage de archivos: Cloudflare R2 (API S3), bucket `ayr-steel-erp-docs`.                                                                                                                                                                                                                                                                                                                                                         | XML de facturas, planillas, PDFs.                                                                                                                                                                                                                       |
| D-008 | 2026-09-02 | Hosting API: Google Cloud Run `us-central1` (proyecto GCP `ayr-steel-erp`), deploy `--source`. Web: Vercel.                                                                                                                                                                                                                                                                                                                       | Sin sleep, free tier.                                                                                                                                                                                                                                   |
| D-009 | 2026-09-02 | Facturación electrónica vía Nubefact (sandbox hasta validación del cliente).                                                                                                                                                                                                                                                                                                                                                      | Proveedor ya conocido; cubre factura, boleta, NC/ND, GRE.                                                                                                                                                                                               |
| D-010 | 2026-09-02 | Auth propia: email+password (argon2), JWT access corto + refresh en tabla `sessions`; cambiar rol o desactivar usuario invalida sesiones (RF-03).                                                                                                                                                                                                                                                                                 | Sin dependencia externa; RF-01..04.                                                                                                                                                                                                                     |
| D-011 | 2026-09-02 | Calidad: ESLint estricto + typecheck + unit (Vitest/Jest) + E2E Playwright en CI. SonarCloud solo si su plan gratuito cubre repo privado; si no, Semgrep OSS.                                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                       |
| D-012 | 2026-09-02 | Agentes: Claude Code principal (auto mode + `/goal`). Antigravity CLI `agy` secundario, solo lectura/opinión (revisión, auditoría, research).                                                                                                                                                                                                                                                                                     | Nunca dos agentes editando el mismo archivo.                                                                                                                                                                                                            |
| D-013 | 2026-09-02 | App móvil fuera de alcance. RF-39 (terminal de operario) = ruta web responsive `/planta`.                                                                                                                                                                                                                                                                                                                                         | Alcance = app web lista para cliente.                                                                                                                                                                                                                   |
| D-014 | 2026-09-02 | Entorno de desarrollo: Windows (cmd/PowerShell). Scripts del repo deben ser cross-platform (`pnpm` scripts, sin bash-isms).                                                                                                                                                                                                                                                                                                       | Máquina del dueño.                                                                                                                                                                                                                                      |
| D-015 | 2026-09-02 | El web consume el API por proxy same-origin `/api/*` → `API_URL` (mecanismo actualizado por D-022). Cookies httpOnly `SameSite=Lax` sin `domain`. CORS del API solo para `WEB_ORIGIN`. Detalle en `DECISIONES.md`.                                                                                                                                                                                                                | Evita cookies de terceros entre Vercel y Cloud Run.                                                                                                                                                                                                     |
| D-016 | 2026-09-02 | La rama de producción de Neon se llama `production` (no `main`, corrige D-005). `dev` y `ci` cuelgan de ella. Endpoint prod `ep-square-cherry`.                                                                                                                                                                                                                                                                                   | El proyecto Neon ya venía creado así.                                                                                                                                                                                                                   |
| D-017 | 2026-09-02 | Versiones fijadas sin `^`: NestJS 11.2, Next 15.5, Prisma 6.19, TS 5.9, ESLint 9, Zod 3.25, Jest 29 (API). Detalle en `DECISIONES.md`.                                                                                                                                                                                                                                                                                            | Reproducibilidad; NestJS 12/Next 16/Prisma 7/TS 7 existen pero cambian el tooling.                                                                                                                                                                      |
| D-018 | 2026-09-02 | Reset de DB de pruebas = `prisma migrate deploy` + `TRUNCATE` (`apps/api/prisma/reset-test-db.ts`), con bloqueo si la conexión apunta a `production`. Nunca `migrate reset`.                                                                                                                                                                                                                                                      | Prisma bloquea `migrate reset` invocado por agentes; el truncate es más seguro.                                                                                                                                                                         |
| D-019 | 2026-09-02 | Deploy web: build remoto en Vercel desde la raíz del monorepo con `rootDirectory=apps/web` (proyecto `ayr-steel-erp-web`, ligado al repo GitHub → auto-deploy en push a `main`).                                                                                                                                                                                                                                                  | `vercel build` local falla en Windows (symlinks).                                                                                                                                                                                                       |
| D-020 | 2026-09-02 | Auth: access token JWT 15 min con `sid`; el guard consulta la sesión en cada request (una lectura indexada) para que revocar sea inmediato (RF-03). Refresh 7 días, rotado en cada uso.                                                                                                                                                                                                                                           | Simplicidad y revocación inmediata sobre rendimiento marginal.                                                                                                                                                                                          |
| D-021 | 2026-09-02 | SonarCloud analiza desde CI (`sonarqube-scan-action`, con cobertura lcov del API); Automatic Analysis del proyecto desactivado. Semgrep OSS solo si `SONAR_TOKEN` está vacío.                                                                                                                                                                                                                                                     | Ambos modos a la vez fallan; CI permite cobertura y bloquear el pipeline.                                                                                                                                                                               |
| D-022 | 2026-09-02 | El proxy `/api/*` del web es un Route Handler (`apps/web/src/app/api/[...path]/route.ts`, fetch server-side en runtime Node), no un `rewrites()` de `next.config.ts`.                                                                                                                                                                                                                                                             | Vercel bloquea rewrites declarativos hacia el dominio por defecto de Cloud Run (`*.a.run.app`) con `DNS_HOSTNAME_RESOLVED_PRIVATE`, falso positivo de su protección SSRF; un `fetch` normal no pasa por ese chequeo.                                    |
| D-023 | 2026-09-02 | `scripts/gcp-secrets.mjs` otorga explícitamente a la service account de Compute por defecto: `roles/secretmanager.secretAccessor` por secreto, y `roles/{storage.objectViewer,cloudbuild.builds.builder,artifactregistry.writer,logging.logWriter}` a nivel proyecto.                                                                                                                                                             | `roles/editor` (rol por defecto de esa cuenta) no basta para que Cloud Build lea el zip fuente de `gcloud run deploy --source` ni para que la revisión de Cloud Run lea Secret Manager.                                                                 |
| D-024 | 2026-09-02 | Los E2E de escritura contra producción corren solo vía `pnpm e2e:prod`, que crea un ADMINISTRADOR efímero (`e2e-admin@ayr.test`, contraseña aleatoria en memoria) y borra en `finally` todo usuario `e2e-...@ayr.test`. La cuenta real del dueño nunca se usa ni se modifica; `audit_log` no se toca.                                                                                                                             | Verificar RF-03 de punta a punta en producción exige crear y desactivar usuarios; hacerlo con la cuenta real obligaría a cambiar su contraseña, y dejar cuentas de prueba ensuciaría `/usuarios` del cliente.                                           |
| D-025 | 2026-09-03 | (P-02) El ERP emite comprobantes directo a SUNAT vía Nubefact desde la venta. RF-71 (importación de comprobantes) queda como ruta de histórico/contingencia, no como flujo normal.                                                                                                                                                                                                                                                | Emisión en línea es el flujo real del negocio; importar es solo para datos previos o caídas de Nubefact.                                                                                                                                                |
| D-026 | 2026-09-03 | (P-03) Una cotización confirmada genera una `production_orders` separada, con FK a `quotes`. Permite fabricar en parciales y reprogramar sin tocar la cotización original.                                                                                                                                                                                                                                                        | Separar la orden de la cotización evita que un cambio de programación de planta reabra el compromiso comercial ya aceptado por el cliente.                                                                                                              |
| D-027 | 2026-09-03 | **SUPERSEDIDA por D-037.** (P-04) La venta directa de bobina (sin transformar) crea un producto en la línea `trading`, con SKU `BOB-{finishCode}-{thicknessMm}-{widthMm}`, unidad kg; la venta referencia la bobina específica en el kardex.                                                                                                                                                                                      | Mantener todo lo vendible como `product` unifica el catálogo y el reporte de ventas; la referencia a la bobina concreta conserva la trazabilidad física que pedía P-04.                                                                                 |
| D-028 | 2026-09-03 | (P-05) Valorización de kardex por promedio ponderado, calculado por producto y por línea de negocio.                                                                                                                                                                                                                                                                                                                              | Más simple que PEPS, aceptado por SUNAT, y suficiente para el tamaño de operación.                                                                                                                                                                      |
| D-029 | 2026-09-03 | (P-06) Compras y ventas en PEN o USD. Se calcula un equivalente en PEN automático con el tipo de cambio SUNAT del día vía apis.net.pe (`APIS_NET_PE_TOKEN`), con caché en `exchange_rates` y fallback al último tipo de cambio conocido, editable a mano. Cada registro guarda `exchangeRate`, `exchangeRateSource` (API\|MANUAL) y `exchangeRateDate`. PEN es la moneda por defecto en ventas; USD permitido con la misma regla. | Evita depender de que el usuario tipee el TC en cada operación, sin bloquear el flujo si la API externa falla.                                                                                                                                          |
| D-030 | 2026-09-03 | (P-07) Módulo de compras completo, sin contabilidad: proveedor → compra tipada (`COIL`\|`FINISHED_GOOD`\|`SERVICE`\|`EXPENSE`) → recepción → cuenta por pagar → pagos. Las compras `EXPENSE` no generan movimiento de kardex. El formulario varía según el tipo; hay una lista central filtrable por línea de negocio. Se construye en Fase 2 junto con bobinas; sus RF se numeran al iniciar esa fase.                           | v1 no necesita asientos contables, pero sí necesita saber cuánto se debe a cada proveedor y de qué compra viene cada kilo o unidad que entra a inventario.                                                                                              |
| D-031 | 2026-09-03 | (P-08) Las secciones faltantes del documento origen eran clientes/proveedores y reportes: §4.7 = clientes y proveedores (RF-80..RF-89), §4.8 = reportes (RF-90..RF-94), agregadas en esta versión con su alcance mínimo.                                                                                                                                                                                                          | Confirma la hipótesis de P-08; sin estas secciones el catálogo de requisitos quedaba incompleto frente al docx original.                                                                                                                                |
| D-032 | 2026-09-03 | (P-09) Precio sugerido de venta = costo promedio ponderado del kardex × (1 + margen%). El margen (y el margen mínimo) vive por línea de negocio en `pricing_settings`, editable solo por ADMINISTRADOR. VENDEDOR puede subir el precio libremente pero no bajarlo del margen mínimo; bajar del mínimo requiere ADMINISTRADOR.                                                                                                     | Da un precio de partida objetivo sin congelar al vendedor a una lista fija, y pone un piso que protege el margen sin pasar por contabilidad.                                                                                                            |
| D-033 | 2026-09-03 | (P-10) El corte tercerizado admite varios proveedores de corte a la vez, marcados con `providesCuttingService` en `suppliers`. El costo por kg del servicio se ingresa al momento de recibir los flejes, no antes.                                                                                                                                                                                                                | El costo real de corte varía por proveedor y por lote; fijarlo de antemano no reflejaría lo que realmente se pagó.                                                                                                                                      |
| D-034 | 2026-09-03 | Se reordenan las fases de construcción (§3.7): Fase 1 = maestros (líneas, acabados, catálogo, clientes, proveedores, precios, tipo de cambio) + importación desde planilla; Fase 2 = compras + bobinas completas + kardex. Las fases 3 en adelante no cambian de contenido, solo de número relativo.                                                                                                                              | Bobinas y compras comparten el mismo kardex y las mismas cuentas por pagar; construirlas en la misma fase evita mockear compras para poder probar bobinas.                                                                                              |
| D-035 | 2026-09-03 | (P-11) El costo de producción de un producto terminado = materia prima consumida (costo promedio del kardex) + servicios directos imputados (corte tercerizado, flete) + un `overheadPerKg` por línea de negocio (campo `Decimal` nuevo en `pricing_settings`, editable solo por ADMINISTRADOR).                                                                                                                                  | v1 no lleva contabilidad de costos: un overhead por kilo configurable por línea absorbe la fábrica sin exigir centros de costo, y deja el costo del kardex comparable entre líneas.                                                                     |
| D-036 | 2026-09-03 | (P-08) Los reportes de v1 son exactamente cinco: inventario valorizado por línea, kardex por producto/bobina, ventas por período, cuentas por pagar por proveedor y cola de producción. §4.8 se reescribe como RF-90..RF-94 con esa lista; se elimina cualquier RF de reportes fuera de ella.                                                                                                                                     | Acotar los reportes a los cinco que el negocio pide de verdad evita construir un generador genérico en v1; exportar a Excel/CSV pasa a ser una propiedad de cada reporte, no un requisito aparte.                                                       |
| D-037 | 2026-09-03 | **Supersede D-027.** El SKU de la bobina para venta directa es `BOB{finishCode}{thicknessMm}`, sin ancho y sin guiones, uno por `typeKey` (RF-14). El ancho no entra al SKU porque no cambia el tipo de material vendido.                                                                                                                                                                                                         | Un SKU por acabado+espesor hace que el catálogo de `trading` no explote con una entrada por cada ancho comprado, y coincide exactamente con el `typeKey` de RF-14 que ya agrupa el inventario de bobinas.                                               |
| D-038 | 2026-09-03 | El costo con el que una bobina entra al kardex es su valor de compra **sin IGV**. El IGV se guarda por separado en la compra (`purchases.igv`) y nunca forma parte del `unitCost` del movimiento de inventario.                                                                                                                                                                                                                   | El IGV de compra es crédito fiscal, no costo del material; incluirlo inflaría el costo promedio y, con él, el precio sugerido de D-032.                                                                                                                 |
| D-039 | 2026-09-03 | Las cuentas por pagar admiten **pagos parciales** (`supplier_payments`, N pagos por compra). El saldo de una compra = total − pagos aplicados; el estado de cuenta por proveedor lista sus compras con saldo, su antigüedad y el total adeudado.                                                                                                                                                                                  | El negocio paga a sus proveedores en armadas; un modelo de pago único obligaría a partir compras artificialmente para reflejar la realidad.                                                                                                             |
| D-040 | 2026-09-03 | La merma es un movimiento de kardex de salida (`OUT`, `refType=MERMA`) valorizado al **costo promedio vigente** del ítem en el momento de registrarla. Anular una merma emite un movimiento inverso que referencia el original (`reversalOfId`); nunca se borra la fila.                                                                                                                                                          | Trata la pérdida física como cualquier otra salida de inventario, así el promedio ponderado y el valorizado por línea siguen cuadrando sin lógica especial.                                                                                             |
| D-041 | 2026-09-03 | La Fase 2 se ejecuta en dos sesiones: **2a** = kardex base, compras y alta de bobinas (3 vías); **2b** = partido de bobina, merma, cierre, anulación, edición y vistas de inventario de bobinas. §3.7 se actualiza para reflejar las dos sub-fases.                                                                                                                                                                               | El alcance completo de Fase 2 no cabe en una sesión con la calidad exigida (revisión, auditoría, E2E, deploy); partirla por dependencia técnica —2b necesita el kardex y las bobinas que crea 2a— mantiene el cierre de fase verificable en cada mitad. |

| D-042 | 2026-09-03 | El kardex se lleva **siempre en soles**: `inventory_movements.unitCost` e `inventory_balances.avgCost` guardan el costo ya convertido con el tipo de cambio de la operación. El documento (compra, bobina) conserva su moneda original y su `exchangeRate`. | Sin esto, comprar el mismo ítem una vez en USD y otra en PEN promediaba dos escalas distintas y el inventario valorizado (RF-90) sumaba dólares con soles. Detectado por el `revisor` al cerrar los puntos 1-3 de Fase 2a. |
| D-043 | 2026-09-04 | (P-12) **Landed cost.** Una compra `SERVICE` con `serviceKind` `FREIGHT`, `CUSTOMS` o `INSURANCE` puede vincularse a una compra `COIL` por `relatedPurchaseId`. Al recibirla, su costo **sin IGV** (en soles, D-042) se prorratea **por kilo** entre las bobinas de la compra vinculada: cada una recibe un movimiento `ADJUST` de **costo, no de cantidad** (`qty` = 0 lógico: el movimiento lleva la cantidad vigente y solo mueve `avgCost`) y su `unitCostPerKg` efectivo se actualiza. Default por recomendación del agente; el dueño puede revertirlo antes de Fase 3. | Sin esto, el flete y la aduana de una importación de bobinas quedan como gasto suelto y el costo promedio del acero sale por debajo del real, arrastrando el precio sugerido de D-032 y el costo de producción de D-035. El prorrateo por kg (y no por valor) es la práctica habitual cuando el servicio se contrata por peso transportado. |
| D-044 | 2026-09-04 | RF-22 (cancelar el plan de corte de una bobina) se implementa en **Fase 3**, junto con el plan de corte tercerizado (RF-40..42), no en 2b. | En 2b no existe todavía el plan de corte: no hay nada que cancelar. Anotado en §4.2. |
| D-045 | 2026-09-04 | RF-20: editar la **moneda o el tipo de cambio** de una bobina solo se permite si la bobina no tiene movimientos posteriores a su `IN` inicial. El cambio **recuesta** el ingreso vía reversa del `IN` original más un nuevo `IN` al costo corregido; nunca se hace `UPDATE` sobre un movimiento. Los campos que no afectan al kardex (ancho, notas) se editan libremente mientras la bobina esté `OPEN`. | El kardex es append-only (§3.2) y el promedio ponderado de D-028 es acumulativo: recostear un ingreso ya consumido por una salida o un partido reescribiría hacia atrás un promedio que ya valorizó otras operaciones. Reversa + nuevo movimiento deja la corrección visible en el kardex, que es justo lo que RF-95 pide. |
| D-046 | 2026-09-04 | **Quién anula qué** (precisa §3.4). SUPERVISOR_PLANTA puede deshacer lo que él mismo registra en planta: revertir un partido (RF-16) y anular una merma (RF-18). ADMINISTRADOR es el único que anula una **bobina** (RF-21), anula una **compra** y edita moneda, tipo de cambio o costo (RF-20, D-045). | Una merma mal tipeada o un partido con el ancho equivocado se detectan en el turno, y obligar a un administrador para corregirlos empuja a la planta a "arreglarlo" con otra merma compensatoria, que es peor para el kardex que la reversa. Anular una bobina o una compra, en cambio, toca el documento de compra y la cuenta por pagar, que no son de planta. Lo señaló el `revisor` como ambigüedad entre §3.4 y el controlador. |
| D-047 | 2026-09-02 | (P-13, cierra) **Consumo de producción.** El kg que consume una corrida de producción es el **kg teórico** calculado desde las dimensiones × `densityFactor` del acabado (drywall: kg/metro de perfil desde el fleje; coberturas: ancho × espesor × largo × densidad), con **override** de kg real que el operario puede escribir a mano. La diferencia entre el teórico (u override) y lo que el kardex de verdad tenía disponible se registra automáticamente como merma de proceso (`SCRAP`). Aplica a las dos líneas de transformación (drywall y coberturas). | Sin un cálculo teórico, cada corrida obligaría al operario a pesar y tipear a mano; con un teórico + override, el caso normal no exige nada extra y el caso real (la plancha pesó distinto de lo calculado) queda igual de auditable que cualquier otra merma (D-040), sin inventar un tercer mecanismo de ajuste. Se implementa en Fase 4. |
| D-048 | 2026-09-02 | **Reorden de fases por dependencia RF-31** (coberturas exigen cotización, §4.3). Fase 4 = producción drywall + terminal `/planta`. Fase 5 = cotizaciones + `production_orders` + producción de coberturas + ventas. §3.7 se reescribe con este orden. | RF-31 prohíbe producción suelta de coberturas: necesitan una cotización confirmada, que es de Fase 5. Meter coberturas en Fase 4 obligaría a mockear cotizaciones para poder probar producción, exactamente el problema que D-034 evitó entre compras y bobinas. Drywall no tiene esa dependencia y puede salir antes. |
| D-049 | 2026-09-02 | **Los flejes son bobinas.** `coils` gana la columna `kind COIL\|STRIP` (default `COIL`); un fleje es una fila `kind=STRIP` con `parentCoilId` a la bobina madre (comprada o, en corte tercerizado, la bobina enviada). Reusa el partido (RF-15/`planCoilSplit`), el código RF-13, el `typeKey` RF-14 y el kardex tal cual. El stock de flejes (RF-42) se agrupa por `typeKey` + `widthMm`, a diferencia del inventario de bobinas (RF-51), que agrupa solo por `typeKey`. | Un fleje no es una entidad nueva: es una bobina angosta con otro origen. Modelarlo como fila de `coils` evita duplicar código, kardex y trazabilidad; la única diferencia real con una hija de partido interno es el `refType` del movimiento (`CUTTING` en vez de `SPLIT`) y que el ancho sí importa para su stock, porque el drywall consume fleje por ancho exacto. |
| D-050 | 2026-09-02 | **Envío a corte no saca del kardex.** La bobina enviada a un tercero pasa a `status = IN_THIRD_PARTY` (nuevo valor de `CoilStatus`) sin movimiento de inventario: la mercadería sigue siendo propiedad de la empresa, solo cambió de ubicación física. Mientras está `IN_THIRD_PARTY` queda excluida de producción y del partido local (RF-15). Recién al **recibir** los flejes se emite la salida `OUT refType=CUTTING` de la madre y las entradas `IN` de los flejes, igual que un partido. | Un movimiento de kardex por un envío que puede no volver nunca (el proveedor de corte puede tardar semanas) inflaría el kardex con salidas que no son verdad —la empresa no perdió el material— y complicaría la reversa de RF-22 (cancelar antes de recibir) sin ganar nada: el kardex real ocurre en la recepción, que es cuando el peso y el ancho reales se conocen. |

### 0.3 Alcance de esta versión (v1 "lista para cliente")

Incluye: auth/roles, bobinas (alta manual/XML/planilla, partido, merma, cierre), producción drywall y coberturas, corte tercerizado, catálogo e inventario valorizado por línea, cotizaciones/ventas con comprobante electrónico (Nubefact sandbox), importación de comprobantes, auditoría inmutable, terminal de planta.
Excluye: app móvil nativa, contabilidad general (asientos), planillas de personal, integración bancaria.

---

## 1. Propósito y alcance

### 1.1 Qué es

AYR Steel ERP es una aplicación web interna de gestión para una empresa peruana de **transformación y comercialización de acero**. Cubre el ciclo desde la compra de materia prima (bobinas de acero) hasta la venta del producto terminado, incluyendo compra y venta de producto terminado y de productos de terceros.

Gestiona: compras afines al rubro (bobina, producto terminado, producto de terceros) y compras que son gastos a crédito, notas de débito, etc.; producción; ventas con facturación electrónica, guías y notas de crédito; y una vista por rol coherente con sus funcionalidades.

### 1.2 Qué cubre

- Registro de materia prima (bobinas) por alta manual, por XML de factura de compra y por importación masiva desde planilla.
- Transformación de bobina a producto terminado en dos líneas de producción físicas distintas (perfilería drywall y coberturas metálicas).

---

## 2. Contexto de negocio

### 2.1 El rubro

La empresa compra **bobinas de acero** (rollos planos, en inglés _coils_) y las transforma. Una bobina se caracteriza por su peso (kg), su ancho (mm), su espesor (mm) y su **acabado** —el recubrimiento superficial—, y se compra por peso a un precio por kilogramo.

De la bobina salen dos caminos productivos físicamente distintos:

- **Corte longitudinal (slitting):** la bobina se parte a lo largo en tiras de menor ancho llamadas **flejes**. Los flejes alimentan una perfiladora que produce perfiles de drywall.

- **Conformado:** la bobina pasa por una máquina conformadora que le da perfil ondulado o trapezoidal y produce coberturas y planchas metálicas.

Además la empresa revende productos que no fabrica.

### 2.2 Las cinco líneas de negocio

| **Línea**        | **Identificador** | **Modelo**     | **Materia prima**       |
| ---------------- | ----------------- | -------------- | ----------------------- |
| Drywall          | drywall           | Transformación | Bobina → fleje → perfil |
| Metallic Roofing | metallic-roofing  | Transformación | Bobina → conformado     |
| Roofing (UPVC)   | roofing           | Compra-venta   | Producto terminado      |
| Trading          | trading           | Compra-venta   | Producto de terceros    |
| Services         | services          | Sin stock      | N/A                     |

La línea services es deliberadamente una operación nula sobre inventario: su estrategia de inventario es `noop` (no crea movimientos de kardex).

---

## 3. Arquitectura técnica

### 3.1 Estructura del repositorio

```
ayr-steel-erp/
  apps/
    api/          NestJS 11 + Prisma + pg-boss      → Cloud Run
    web/          Next.js 15 (App Router) + shadcn  → Vercel
  packages/
    shared/       Zod schemas, tipos, enums, utilidades Decimal
  docs/
    ARQUITECTURA.md   (este archivo)
    DECISIONES.md     (espejo de §0.2, formato ADR largo cuando haga falta)
    PROGRESO.md       (estado por fase, qué falta, bloqueos)
    handoff/          (resúmenes de cierre de sesión)
  .claude/        settings.json, agents/, commands/
  .mcp.json       playwright (headless), context7
  CLAUDE.md       reglas operativas del agente
```

### 3.2 Módulos del API (NestJS)

`auth` · `users` · `business-lines` · `finishes` (acabados) · `coils` (bobinas, partidos, mermas, cierre) · `strips` (flejes, corte tercerizado) · `production` (drywall, coberturas, cola) · `catalog` (productos por línea) · `inventory` (kardex, movimientos, valorización) · `quotes` · `sales` · `invoicing` (Nubefact, XML UBL 2.1) · `imports` (planillas, XML) · `documents` (R2) · `audit` · `jobs` (pg-boss).

Regla transversal: **todo cambio de stock pasa por `inventory`** como movimiento de kardex inmutable; los módulos nunca escriben stock directamente.

### 3.3 Modelo de datos — principios

- Toda entidad con stock lleva `businessLineId`. `services` no tiene stock (estrategia `noop`).
- Bobina: `weightKg`, `widthMm`, `thicknessMm`, `finishId`, `currency`, `exchangeRate`, `unitCostPerKg`, `typeKey` (acabado+espesor), `code` (proveedor-acabado-espesor-peso-correlativo). Partido = bobina hija con `parentCoilId`.
- Kardex: tabla `inventory_movements` append-only (`type`, `qty`, `unitCost`, `refType`, `refId`, `reversalOfId`). Anulaciones = movimiento inverso, nunca delete.
- Auditoría: `audit_log` append-only con `actorId`, `action`, `entity`, `entityId`, `before`, `after`, `at`.
- Todos los `Decimal` con escala explícita: dinero 4, kg 3, mm 2.

### 3.4 Roles (RF-02)

| Rol               | Alcance                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| ADMINISTRADOR     | Todo, incl. usuarios, catálogos, anulaciones, auditoría                |
| SUPERVISOR_PLANTA | Bobinas, producción, corte tercerizado, inventario, terminal `/planta` |
| VENDEDOR          | Cotizaciones, ventas, catálogo (lectura), inventario (lectura)         |

### 3.5 Integraciones

| Servicio      | Uso                              | Credencial                       |
| ------------- | -------------------------------- | -------------------------------- |
| Nubefact      | Emisión factura/boleta/NC/ND/GRE | `NUBEFACT_URL`, `NUBEFACT_TOKEN` |
| Cloudflare R2 | Archivos                         | `R2_*`                           |
| Neon          | DB + ramas                       | `DATABASE_URL`, `DIRECT_URL`     |
| UptimeRobot   | Monitores `/health` y web        | `UPTIMEROBOT_API_KEY`            |

### 3.6 Entornos

| Entorno | API                         | Web            | DB                                 |
| ------- | --------------------------- | -------------- | ---------------------------------- |
| local   | `pnpm dev` (localhost:3000) | localhost:3001 | Neon rama `dev`                    |
| ci      | GitHub Actions              | build          | Neon rama `ci` (reset por corrida) |
| prod    | Cloud Run                   | Vercel         | Neon `main`                        |

### 3.7 Fases de construcción

| Fase | Entrega                                                                                                                                        | Cierre (`/goal`)                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 0    | Bootstrap: monorepo, CLAUDE.md, CI, auth, deploy vacío, monitores                                                                              | Login E2E verde en prod, CI verde                                                         |
| 1    | Maestros: líneas, acabados, catálogo, clientes, proveedores, márgenes, tipo de cambio (RF-25, RF-50, RF-80..94) + importación planilla (RF-52) | RF-25, RF-50, RF-52 E2E                                                                   |
| 2a   | Kardex base (`inventory`) + compras (D-030) + alta de bobinas por 3 vías (RF-10, RF-11, RF-12, RF-13, RF-14)                                   | E2E compra→recepción→pago parcial; alta de bobina manual/XML/planilla con kardex correcto |
| 2b   | Bobinas: partido (RF-15, RF-16), merma (RF-17, RF-18), cierre (RF-19), edición (RF-20), anulación (RF-21, RF-22), inventario por línea (RF-23) | E2E partido→reversa, merma→anulación, cierre bloquea producción                           |
| 3    | Corte tercerizado + flejes (RF-40..42, RF-22, D-049/D-050)                                                                                     | E2E envío/recepción/prorrateo                                                             |
| 4    | Producción drywall + terminal `/planta` (RF-32..35, RF-38, RF-39, D-047)                                                                       | E2E corrida y anulación de drywall                                                        |
| 5    | Cotizaciones + `production_orders` + producción de coberturas + ventas (RF-30, RF-31, RF-36, RF-37, RF-60..69, RF-73)                          | E2E cotización→producción→venta→anulación                                                 |
| 6    | Facturación Nubefact + XML + importación comprobantes (RF-11, RF-71, RF-72)                                                                    | Comprobante sandbox aceptado                                                              |
| 7    | Auditoría, reportes, hardening, UAT (RF-90..96)                                                                                                | Checklist cliente                                                                         |

> D-034 (2026-09-03): reordenado desde el plan de `docs/handoff/fase-0.md`. Fase 1 crece para incluir clientes, proveedores, precios y tipo de cambio; Fase 2 absorbe el módulo de compras porque comparte kardex y cuentas por pagar con bobinas.
> D-041 (2026-09-03): la Fase 2 se parte en 2a y 2b. 2b depende de 2a (necesita el kardex y bobinas ya dadas de alta); las fases 3 en adelante no cambian.
> D-048 (2026-09-02): Fase 4 y 5 se reordenan por RF-31 (producción de coberturas exige cotización, que es de Fase 5). Fase 4 queda solo con drywall (sin esa dependencia) + terminal `/planta`; Fase 5 absorbe cotizaciones, `production_orders`, producción de coberturas y ventas.

---

## 4. Requisitos funcionales

Cada requisito está trazado a la ruta, el callable o el módulo que lo implementa. Si un requisito no tiene una referencia de código al lado, no está en esta lista.

### 4.1 Autenticación y usuarios

| **#** | **Requisito**                                                                      |
| ----- | ---------------------------------------------------------------------------------- |
| RF-01 | El usuario inicia sesión con correo y contraseña.                                  |
| RF-02 | Cada usuario tiene exactamente un rol: ADMINISTRADOR, SUPERVISOR PLANTA, VENDEDOR. |
| RF-03 | Bajar el rol de un usuario o desactivarlo invalida sus sesiones abiertas.          |
| RF-04 | Un administrador gestiona el alta, edición y baja de usuarios.                     |

### 4.2 Materia prima (bobinas)

| **#** | **Requisito**                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------ |
| RF-10 | Alta individual de bobina con datos de factura de compra.                                              |
| RF-11 | Alta de bobina a partir del XML de la factura electrónica del proveedor.                               |
| RF-12 | Alta masiva desde planilla, con revisión previa fila por fila.                                         |
| RF-13 | El identificador de bobina se genera con formato compuesto proveedor-acabado-espesor-peso-correlativo. |
| RF-14 | Cada bobina lleva una clave de tipo que agrupa por acabado y espesor, ignorando el ancho.              |
| RF-15 | Partir una bobina en hijas por ancho, conservando trazabilidad a la madre.                             |
| RF-16 | Revertir un partido, devolviendo peso y ancho a la madre.                                              |
| RF-17 | Registrar merma sobre una bobina.                                                                      |
| RF-18 | Anular una merma mal registrada.                                                                       |
| RF-19 | Abrir y cerrar una bobina; una bobina cerrada no entra a producción.                                   |
| RF-20 | Editar los datos de una bobina, incluida su moneda y tipo de cambio.                                   |
| RF-21 | Anular una bobina solo si no tiene ningún movimiento.                                                  |
| RF-22 | Cancelar el plan de corte de una bobina. **Fase 3** (D-044): depende del plan de corte de RF-40..42.   |
| RF-23 | Consultar inventario de bobinas separado por línea de negocio.                                         |
| RF-25 | Gestionar el catálogo de acabados con su factor de densidad.                                           |

### 4.3 Producción

| **#** | **Requisito**                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------- |
| RF-30 | Producir cobertura o plancha consumiendo una o varias bobinas a la vez.                           |
| RF-31 | Toda producción de coberturas debe ir contra una cotización; no se admite producción suelta.      |
| RF-32 | Una misma corrida no puede mezclar bobinas de acabados distintos.                                 |
| RF-33 | Anular una producción de coberturas devuelve a cada bobina el peso exacto que consumió.           |
| RF-34 | Producir perfiles de drywall desde fleje.                                                         |
| RF-35 | Revertir una producción de drywall.                                                               |
| RF-36 | No se puede anular una producción si el producto resultante ya tiene una venta cerrada posterior. |
| RF-37 | La cola muestra las cotizaciones confirmadas pendientes de fabricar, con su avance.               |
| RF-38 | Un indicador en el menú lateral muestra cuántas cotizaciones esperan producción.                  |
| RF-39 | Terminal simplificada para el operario de planta.                                                 |

### 4.4 Corte tercerizado

| **#** | **Requisito**                                                   |
| ----- | --------------------------------------------------------------- |
| RF-40 | Enviar bobinas a un tercero para corte, con plan de anchos.     |
| RF-41 | Recibir los flejes y prorratear el costo del servicio por peso. |
| RF-42 | Consultar el stock de flejes por ancho.                         |

### 4.5 Catálogo e inventario

| **#** | **Requisito**                                                             |
| ----- | ------------------------------------------------------------------------- |
| RF-50 | Cada línea tiene su catálogo propio de productos.                         |
| RF-51 | Cada línea con stock tiene su vista de inventario valorizado.             |
| RF-52 | Importación masiva de catálogo desde planilla, con edición fila por fila. |
| RF-53 | Consultar el kardex de un producto o de una bobina.                       |

### 4.6 Ventas y cotizaciones

| **#** | **Requisito**                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| RF-60 | Emitir una venta desde el punto de venta interno.                                                                                   |
| RF-61 | Emitir una cotización.                                                                                                              |
| RF-62 | Confirmar una cotización para producción.                                                                                           |
| RF-63 | Registrar que el cliente aceptó una cotización y con ello mandarla a producción. **Pendiente P-03:** ¿orden de producción separada? |
| RF-64 | Convertir una cotización en venta, descontando stock.                                                                               |
| RF-65 | Cancelar una cotización.                                                                                                            |
| RF-66 | Editar una cotización propia que no tenga producción viva.                                                                          |
| RF-67 | Anular una venta, con cascada sobre su cotización gemela y reversa de stock.                                                        |
| RF-68 | Listar ventas con búsqueda, filtros y totales agregados del conjunto filtrado.                                                      |
| RF-69 | Listar cotizaciones por separado de las ventas.                                                                                     |
| RF-71 | Importar comprobantes ya emitidos desde planilla, incluidas notas de crédito.                                                       |
| RF-72 | Reimportar un comprobante ya importado archiva la versión anterior en vez de pisarla.                                               |
| RF-73 | Venta directa de bobina (sin transformar). Ver P-04.                                                                                |

### 4.7 Clientes y proveedores (D-031)

| **#** | **Requisito**                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-80 | Alta, edición y baja lógica de clientes: tipo y número de documento (DNI, RUC o CE), nombre/razón social, dirección, correo, teléfono y días de crédito.    |
| RF-81 | Alta, edición y baja lógica de proveedores: los mismos datos que un cliente, más si presta servicio de corte tercerizado (`providesCuttingService`, D-033). |
| RF-82 | No se permite repetir número de documento entre clientes activos.                                                                                           |
| RF-83 | No se permite repetir número de documento entre proveedores activos.                                                                                        |
| RF-84 | Buscar cliente o proveedor por nombre o número de documento.                                                                                                |
| RF-85 | Solo ADMINISTRADOR crea, edita o da de baja clientes y proveedores; el resto del personal solo los consulta.                                                |

### 4.8 Reportes (D-031, alcance fijado por D-036)

Los reportes de v1 son exactamente estos cinco. Cualquier otro reporte queda fuera de alcance.

| **#** | **Requisito**                                          |
| ----- | ------------------------------------------------------ |
| RF-90 | Reporte de inventario valorizado por línea de negocio. |
| RF-91 | Reporte de kardex por producto o por bobina.           |
| RF-92 | Reporte de ventas por período.                         |
| RF-93 | Reporte de cuentas por pagar por proveedor.            |
| RF-94 | Reporte de cola de producción.                         |

### 4.9 Auditoría y configuración

| **#** | **Requisito**                                            | **Implementación** |
| ----- | -------------------------------------------------------- | ------------------ |
| RF-95 | Toda acción crítica queda registrada de forma inmutable. |
| RF-96 | Consultar el registro de auditoría.                      |                    |

---

## 5. Preguntas abiertas (pendientes de grill)

| #    | Pregunta                                                                                                                                       | Recomendación del agente                                                                                                                                                        | Estado                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| P-01 | ¿Data real que migrar?                                                                                                                         | —                                                                                                                                                                               | **Resuelta → D-001**                                                                                                        |
| P-02 | ¿El ERP emite comprobantes directo a SUNAT (Nubefact API) o solo registra/importa los emitidos fuera?                                          | Emitir directo desde ventas; importación (RF-71) solo para histórico/contingencia.                                                                                              | **Resuelta → D-025**                                                                                                        |
| P-03 | RF-63: ¿cotización confirmada genera **orden de producción** separada o la cotización misma es la orden?                                       | Orden de producción separada (`production_orders`), con FK a cotización. Permite parciales y reprogramación.                                                                    | **Resuelta → D-026**                                                                                                        |
| P-04 | Venta directa de bobina: ¿se genera SKU en catálogo o se vende por código de bobina?                                                           | Vender por código de bobina, línea `trading`, sin SKU; kardex descuenta la bobina completa.                                                                                     | **Resuelta → D-027, luego D-037** (vigente: SKU `BOB{finishCode}{thicknessMm}`, uno por `typeKey`, sin ancho ni guiones)    |
| P-05 | Método de valorización del kardex: promedio ponderado vs PEPS.                                                                                 | Promedio ponderado por producto/línea (más simple, aceptado por SUNAT).                                                                                                         | **Resuelta → D-028**                                                                                                        |
| P-06 | Moneda: ¿ventas en PEN y USD? ¿Tipo de cambio manual o SUNAT diario?                                                                           | Ambas monedas; TC manual editable con default del último usado.                                                                                                                 | **Resuelta → D-029** (decisión final: TC SUNAT diario vía apis.net.pe con fallback manual editable, no solo manual)         |
| P-07 | Compras que son gastos/crédito y notas de débito (§1.1): ¿módulo de compras completo con cuentas por pagar, o solo registro?                   | v1: registro de compras + saldo por proveedor; sin contabilidad.                                                                                                                | **Resuelta → D-030** (decisión final: módulo completo con recepción y pagos, no solo registro)                              |
| P-08 | Secciones faltantes del docx (3, 4.7, 4.8, RF-15, RF-24, RF-70): ¿existían (reportes, clientes, proveedores)?                                  | Asumir 4.7 = clientes/proveedores, 4.8 = reportes; confirmar.                                                                                                                   | **Resuelta → D-031 y D-036** (§4.8 acotada a cinco reportes; RF-15 recuperado en §4.2)                                      |
| P-09 | Precio de venta: ¿lista de precios por línea, por cliente, o manual por cotización?                                                            | Lista base por producto + override manual con permiso.                                                                                                                          | **Resuelta → D-032** (decisión final: precio sugerido = costo promedio × (1+margen%) por línea, no lista fija por producto) |
| P-10 | Corte tercerizado: ¿un solo proveedor de corte o varios? ¿costo por kg fijo?                                                                   | Varios proveedores; costo por kg ingresado al recibir.                                                                                                                          | **Resuelta → D-033**                                                                                                        |
| P-11 | Costo de producción: ¿solo materia prima, o incluye servicios directos y gastos indirectos de fábrica?                                         | Materia prima + servicios directos + overhead por kg configurable por línea; sin centros de costo en v1.                                                                        | **Resuelta → D-035**                                                                                                        |
| P-12 | Flete, aduana y seguro de una compra de bobinas: ¿son gasto del período o forman parte del costo del material (landed cost)?                   | Landed cost: la compra `SERVICE` se vincula a la compra `COIL` y su costo sin IGV se prorratea por kg entre las bobinas, como `ADJUST` de costo en el kardex.                   | **Resuelta → D-043** (default por recomendación; el dueño puede revertirlo antes de Fase 3)                                 |
| P-13 | Consumo de producción (RF-30, RF-34): ¿el kg que se descuenta del kardex es el kg teórico por dimensiones o el kg real pesado por el operario? | Kg teórico desde dimensiones × `densityFactor` del acabado, con override de kg real; la diferencia contra el teórico (u override) se registra como merma de proceso automática. | **Resuelta → D-047**                                                                                                        |

---
