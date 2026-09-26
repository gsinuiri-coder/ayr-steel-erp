# Handoff — Correcciones 04 del cliente, 2026-09-25

**Estado al cierre de esta sesión (2026-09-25):** la **tanda A está en producción** (PR #32, merge
`6033844`, API `ayr-steel-erp-api-00056-hm8`, git-sha `4d2959d`); la **tanda B no se empezó** y va en
una **sesión nueva**. Ramas `fix/correcciones-04` y `docs/cierre-corr04a`: borradas del remoto con OK del
dueño. Decisiones **D-320 a D-327** (`docs/ARQUITECTURA.md` §0.2); **D-328 y D-329 están reservadas** para
la tanda B (film y pool de conexiones). Texto del cliente: `docs/cliente/correcciones-04.md`. Estado de
partida de la tanda A: API `00055-8cs` (git-sha `fbd2c04`).

Hay **dos tandas con deploy propio**. Las secciones «Tanda A» cubren lo hecho (sin migración); la
sección «Tanda B» dice **qué falta y qué hay que preguntar antes de empezar**.

## Tanda A

### 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0.1      | D-321    | «Desde» y «Hasta» del kardex escritos seguidos no se pisan (`kardexCustomPatch`).                                                                                         |
| M0.2      | D-320    | Agregar ítems a un pedido confirmado aplica «bobina atada a otro documento vivo» (D-310).                                                                                 |
| M0.3      | D-322    | Duplicar una cotización con una bobina entera atada crea la copia con la línea `BOB…` sin bobina y un aviso (`warnings[]` + aviso permanente en el detalle).              |
| M1        | D-323    | Se retiran los filtros por columna; los encabezados reordenan. Orden del servidor (`sort`/`dir`) en los 7 listados paginados; `sortRows` en las demás. Reemplaza a D-295. |
| M2        | D-324    | Historial de `/planta`: «Bobinas usadas» con dos códigos y «+N» en un popover; la página no se ensancha.                                                                  |
| M3        | D-325    | Se saca «Bobinas montadas» del detalle de la orden. PASO 0: la sección no tenía acciones; todo lo que se opera vive en `/planta`.                                         |
| M4        | D-326    | Menú por tarea: Comercial, Compras, Almacén, Planta, Catálogo, Reportes, Administración. Enmienda a D-175.                                                                |
| M5        | D-327    | `RowActions`: una principal y «⋯» en las tablas con varias acciones por fila.                                                                                             |

### 2. Censo de tablas (M1)

«Orden» dice **cómo** ordena hoy. **S** = el servidor ordena todo el listado; **T** = ordena todas las
filas ya cargadas (la tabla no pagina); **P** = solo las filas de la página (columna derivada, lo dice
el `title` del encabezado).

| Vista                                | Pagina   | Orden hoy → columnas                                                                      |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| Cotizaciones                         | servidor | **S** código, cliente, emisión, total, estado                                             |
| Pedidos                              | servidor | **S** código, cliente, fecha, total · **P** estado mostrado                               |
| Bobinas                              | servidor | **S** código, estado · **P** disponible                                                   |
| Clientes                             | servidor | **S** documento, nombre, días de crédito, estado                                          |
| Compras                              | servidor | **S** comprobante, proveedor, tipo, emisión, vence, total, estado (el saldo no: derivado) |
| Comprobantes                         | servidor | **S** número, tipo, cliente, emisión, vencimiento, total, estado (el saldo no: derivado)  |
| Despachos                            | servidor | **S** código, pedido, cliente, fecha, peso, estado                                        |
| Historial de órdenes (`/planta`)     | cliente  | **T** pedido, cliente, fecha, cerradas, metros, estado                                    |
| Catálogo (por línea)                 | no       | **T** SKU, nombre, unidad, estado, precio                                                 |
| Colores                              | no       | **T** código, color, estado                                                               |
| Acabados                             | no       | **T** código, nombre, línea, tipo, color, densidad, estado                                |
| Proveedores                          | no       | **T** código, documento, nombre, corte, crédito, estado                                   |
| Usuarios                             | no       | **T** nombre, correo, rol, estado                                                         |
| Flejes (stock)                       | no       | **T** acabado, espesor, ancho, stock, costo, valorizado, bobinas                          |
| Corte tercerizado                    | no       | **T** proveedor, línea, bobinas, enviada, estado                                          |
| Reservas temporales                  | no       | **T** cotización, cliente, vence                                                          |
| Cobranzas (por cliente y pendientes) | no       | **T** dos tablas con prefijos `r` y `p` en la URL                                         |
| Estado de cuenta del proveedor       | no       | **T** comprobante, línea, tipo, emisión, vence, total, saldo, saldo en soles, antigüedad  |
| Tipo de cambio                       | no       | **T** fecha, moneda, compra, venta, origen                                                |
| Reporte de bobinas                   | no       | **T** todas las columnas (se rehace en la tanda B)                                        |
| Kardex de un ítem                    | no       | **T** solo fecha (el saldo corrido se lee en orden)                                       |
| Órdenes de un pedido                 | no       | **T** orden, producto, estado                                                             |

**No ordenan, y por qué:** auditoría (bitácora cronológica, filtra por fecha y usuario), inventario y
inventario valorizado y ventas y margen (reportes con totales y filas agrupadas o expandibles), líneas
y márgenes (pocas filas, editables), importar precios (vista previa), las líneas de un documento
(cotización, pedido, comprobante, despacho), cobros y notas de crédito, reportes de piezas, los
buscadores y selectores de un formulario y el carrito del mostrador.

### 3. Tablas con acciones por fila (M5)

Con `RowActions`: catálogo (Editar · Receta · Desactivar), acabados, colores, clientes, proveedores
(Estado de cuenta · Editar · Desactivar), usuarios, líneas del pedido (Precio · Cantidad · Bobina) y
filas de borrador de reportes de `/planta` (Corregir · **Quitar**, destructiva). **Sin cambio (una sola
acción):** cobros de un comprobante (Revertir), órdenes de un pedido (Producir), márgenes.

### 4. Mapa del menú (M4)

Antes → ahora, sin cambiar rutas. Comercial: Mostrador, Clientes, Cotizaciones, Reservas temporales,
Pedidos, Comprobantes, Despachos, Cobranzas → **Cotizaciones, Reservas temporales, Pedidos, Despachos,
Comprobantes, Cobranzas, Mostrador, Clientes**. Catálogo (antes con Inventario, Kardex y Flejes) →
**Productos, Líneas, Acabados, Colores**. Planta (antes con Bobinas, Compras, Corte, Proveedores,
Reporte de bobinas) → **Producción, Órdenes de producción**. Nuevos: **Compras** (Compras, Proveedores),
**Almacén** (Bobinas, Flejes, Corte tercerizado, Inventario, Kardex) y **Reportes** (Ventas y margen,
Inventario valorizado, Reporte mensual de bobinas). Administración → **Usuarios, Márgenes y tipo de
cambio, Auditoría, Configuración**. Ubicado con criterio (el mapa no lo nombraba): **Reservas
temporales**, en Comercial. «Configuración» apunta a `/configuracion/reservas` (la tercera pestaña de
esa pantalla), la única ruta de configuración que el mapa no cubría con «Márgenes y tipo de cambio».

### 5. Verificación

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (API 1320, web 67) y `pnpm format:check`: en verde.
- **Suite E2E completa local: no terminó.** Se corrió con builds de producción y la base Docker de la suite
  (`E2E_API_PORT=3010`), y el sistema la mató por memoria a ~100 casos; no se relanzó. Sus rojos se
  repitieron por separado: `huecos-cobertura-f8s3b:399` era una regresión real de M5 (el selector
  «Más acciones» coincidía con los menús de fila; corregido con `exact: true`), `fase5a:100` es
  infraestructura (R2 sin credenciales en el worktree) y `fase2a:359` (lectura del XML) falla también
  en modo dev y no toca lo cambiado, pero **no se comprobó contra `main`**; pasó en CI.
- **CI del PR #32:** todo verde, incluido el E2E completo del runner (427 casos) y Sonar (95 % de
  cobertura de código nuevo). Dos rojos intermedios: un spec propio (`acciones-fila-d327`) que abría el
  menú de una fila mientras la lista la reordenaba, y un lint del spec del menú.
- **Producción:** ver `docs/PROGRESO.md`, «Ventana de Correcciones 04, tanda A».
- **Autorrevisión:** `docs/revision/correcciones-04-autorrevision.md` (1 P0 y 2 P1 corregidos; 9 P2, con
  su resolución al final). **Pendiente de revisión independiente.**

### 6. Para el dueño

1. **Las imágenes del cliente no llegaron a `local-data/corr04/`.** M2 y M4 se hicieron con el texto y
   el mapa; conviene mirarlas contra lo entregado.
2. **Duplicar con bobina atada** deja una cotización **emitida y con PDF** que tiene una línea sin
   bobina y no se puede confirmar (D-322). Alternativa si molesta: crearla en borrador.
3. **El aviso de D-322 no dice «Convertir en venta de bobina»** (solo existe para importadas): dice
   «Bobina completa (venta directa)».
4. **Puerto 3000:** hay un `nuxt dev` de otro proyecto en `[::1]:3000` (no es de este repo). Los E2E
   locales corrieron con `E2E_API_PORT=3010`.

## Tanda B — pendiente, sesión nueva (con migración)

**No se empezó, a propósito.** Espera las respuestas del cliente de la revisión de la noche del
2026-09-25 sobre el film. Sin ellas, M6 tendría que adivinar dos cosas de negocio (regla dura 16):

1. **El nombre de los estados.** El brief propone «Con film» / «Sin film» y las acciones «Quitar film» y
   «Volver a sellar», y prohíbe «cerrada/abierta» para el film (el cliente usó esas palabras, pero
   `coils.status` OPEN/CLOSED ya significa otra cosa, D-164). Hay que confirmar con el cliente que
   esos nombres le sirven, porque son los que verá en la lista, el detalle y el reporte mensual.
2. **Qué cuenta como «ya usada»** para impedir volver a sellar una bobina. El brief lo define como: hubo
   algún movimiento de salida **vivo** (producción, merma, partido, corte o envío a tercero, venta) con
   fecha posterior al último «quitar film», o la bobina está montada en una OP viva o en poder de un
   tercero. Falta que el cliente diga si esa regla coincide con su idea (por ejemplo, si un simple montaje
   sin reportes ya la deja «usada»). El brief lo resuelve a favor de poder volver a sellar mientras no haya
   una salida viva.

**Cuando lleguen las respuestas**, la sesión nueva arranca con `ayr-arranque` y lee este handoff. Alcance
de M6 y M7 tal como lo dejó el dueño (resumen; el detalle vive en el brief de esa sesión):

- **M6 — Film de protección (puntos 6 y 7).** Estado aparte del ciclo de consumo; `coils.status` no cambia.
  Tabla append-only `coil_film_events` (`coil_id`, `kind` REMOVED|RESEALED, `operation_date` D-124,
  `actor_id`, `reason`, `created_at`) con trigger append-only como `inventory_movements`; estado
  derivado del último evento (opcional `coils.has_film` denormalizada en la misma transacción: elegir y
  justificar). Quitar el film: rol de planta o administrador, solo si tiene film; montar una bobina con
  film (`mountCoil` y multi-montar D-192) pide confirmación y registra REMOVED en la misma transacción;
  volver a sellar solo sin salida viva posterior, con el motivo concreto en el mensaje; reversa en la misma
  fase (RESEALED revierte un REMOVED; liberar un montaje sin reportes resella solo). La venta de bobina
  entera (D-170) vale con o sin film. Todo auditado con `reason`.
  - **Bobinas existentes:** CLI `pnpm backfill:coil-film --branch <b>`, dry-run por defecto; sin film si tuvo
    una salida viva o está CLOSED, con film el resto; escribe REMOVED con fecha = la primera salida. El
    dry-run imprime la lista a `local-data/corr04/film-dry-run-<rama>.txt` para que el dueño la revise;
    `--execute` solo con OK y, contra production, además `--confirm-production`.
  - **UI:** badge «Con film/Sin film» y chip en lista y detalle de bobinas, acciones con `RowActions`
    (D-327), historial de eventos en el detalle.
  - **Reporte mensual de bobinas:** dos tablas, «Con film (cerradas)» y «Sin film (abiertas)», cada bobina
    según su estado **al último día del mes** (eventos con `operation_date <= fin de mes`), con subtotales
    de kg y valor y total general; igual en el PDF (D-173) y el export. La tabla actual está en
    `apps/web/src/app/(app)/reportes/bobinas/reporte-bobinas-view.tsx` (hoy una sola tabla ordenable, D-323).
  - **Antes de migrar:** leer los CHECK y triggers de `coils` (lección D-145/D-205); migración aditiva
    generada contra una **base descartable**, nunca `ayr_local`.
- **M7 — Pool de conexiones (P2024).** Primero **diagnóstico de solo lectura**: logs de Cloud Run de la hora
  del P2024 (ver «M4» en `docs/PROGRESO.md`: 2026-09-25 08:06:30 UTC, `session.findUnique` en `AuthGuard`,
  `connection_limit=5`, `timeout=10`), configuración efectiva (¿`DATABASE_URL` usa el pooler `-pooler` de
  Neon?, `pool_timeout`, `max-instances`, límite del pooler) y candidatos (ráfagas de `Promise.all`,
  transacciones largas, `stock-shortages`/`floor-summary` del Panel). Luego una **propuesta con valores
  concretos** (p. ej. `connection_limit=10`, `pool_timeout=20`) y la cuenta contra el límite del pooler,
  **antes de aplicar**; cambiar el secreto y redesplegar solo con OK del dueño por comando, con la
  credencial fuera de argv (regla dura 2; `scripts/gcp-secrets.mjs` o equivalente con `run` quiet).
- **Deploy B**, igual que el A: respaldo `respaldo-pre-corr04b-<fecha>`, `migrations-status`, `pnpm db:prod`
  solo con la migración de M6 (el `migrate diff` debe coincidir **exacto** con el drift conocido más la
  migración; si no, parar), deploy de API con label `git-sha` (14 nombres de variable), merge, Vercel,
  smoke y diff de runtime; después el backfill del film en dry-run contra production, revisión del dueño
  y `--execute --confirm-production`, con verificación de conteos y del reporte de agosto y septiembre.
- **Cierre de la tanda B:** `docs/uat/correcciones-04.md`, este handoff, PROGRESO, §0.2 con D-328 y D-329, y
  la sección «Correcciones 04» de la guía del cliente.

## Lo que la sesión siguiente tiene que saber (aprendido en esta)

- **Puertos:** hay un `nuxt dev` de otro proyecto del dueño en `[::1]:3000` (no es de este repo; no se
  toca). Los E2E locales van con `E2E_API_PORT=3010`. Con `CI=true` el config no aplica sus defaults
  locales: se exportan `DATABASE_URL`/`DIRECT_URL` de `ayr_local_e2e` (`scripts/local-docker-env.mjs`),
  `JWT_SECRET` y las credenciales del admin local, o el guard de la base de pruebas lo rechaza.
- **Memoria:** la suite E2E completa con builds de producción **fue matada por el sistema** por falta de
  memoria a unos 100 casos. Si se necesita la suite entera, cerrar lo demás antes, o apoyarse en la CI del
  runner (que la corre entera en unos 20 min).
- **`.next` compartido:** correr un E2E en modo dev (sin `CI=true`) pisa el build de producción de
  `apps/web/.next`; después hay que reconstruir (`pnpm build`) antes de volver a correr en modo
  producción («routesManifest.dataRoutes is not iterable»).
- **Verificar en producción:** script de un solo uso en `local-data/` (ignorada) que crea un admin efímero
  (`prisma/e2e-admin.ts`), maneja el web con Playwright y lo borra en el `finally`; corre con
  `AYR_ENV_SETUP=<.env.setup del checkout principal>`. Se borra al cerrar. `gcloud` no corre desde Git
  Bash: un `.mjs` con `spawnSync('cmd.exe', ['/c', 'gcloud', …])`, mostrando solo campos elegidos.
- **Antes de empujar:** `pnpm lint` **completo** (no solo el archivo tocado: dos rojos de CI de esta
  sesión eran lint de specs nuevos), `pnpm format:check` y una medición de cobertura de código nuevo
  (Sonar exige 80 %; los cambios en servicios grandes necesitan un spec propio o extraer la lógica a un
  módulo puro probable).
- **Selectores de E2E:** «Más acciones» ahora también nombra los menús de fila («Más acciones de <fila>»);
  usar `exact: true` o el helper `rowAction` (`e2e/helpers/ui.ts`). Abrir el menú de una fila mientras
  la lista la reordena lo cierra: esperar a que la fila se asiente.
- **Pendientes de la tanda A para el dueño:** las cinco imágenes del cliente no llegaron a
  `local-data/corr04/` (M2 y M4 se hicieron con el texto y el mapa del brief); la autorrevisión de la tanda A
  queda **pendiente de revisión independiente**; `fase2a:359` (lectura del XML) falla local y pasa en CI, sin
  comprobar contra `main`.

## Estado de ramas y worktrees al cerrar

- Remoto: `fix/correcciones-04` y `docs/cierre-corr04a` borradas (`git ls-remote --heads origin` no las
  lista). `docs/handoff-corr04-cierre` (este cierre) la borra el dueño tras el merge (AGENTS §4).
- Local: worktree `../ayr-steel-erp-corr04` y sus ramas locales eliminados al terminar, con `local-data/`
  copiada y verificada en el checkout principal (`local-data/corr04-2026-09-25/`).
