# Revisión independiente — correcciones 04 (tanda A en producción + tanda B, film de bobina D-328)

Revisor: segundo modelo, contexto limpio, solo lectura. No leí el handoff de implementación.

## Alcance revisado

- Rango pedido: `git diff 6033844..HEAD`. Contiene solo la **tanda B** (commits `e57c7e6`, `bab305e`, `755063f`, `4ccc644`, más docs). La **tanda A** entró antes, por el merge `6033844` (PR #32); la revisé como `6033844^1..6033844` (commits `85f2611` a `4d2959d`).
- Al revisar, el HEAD de la rama se movió a `8607008` (test de cobertura del film) y el árbol tiene cambios sin commit (rótulos «vigente» en mensajes) y una **migración sin trackear**, `20260926130000_d328_film_sync_por_fecha`. Otra sesión trabaja en este worktree. Revisé el contenido de `4ccc644`; cuando algo ya está corregido en el árbol sin commitear, lo digo.
- Pruebas puntuales ejecutadas: `jest coil-film.spec, coil-film.service.spec, list-orderings.spec, list-sort.spec, reports.service.spec` → 5 suites, 107 tests verdes. No corrí E2E ni toqué bases.

## Resumen por severidad

- **P0 (bloqueante / datos corruptos): sin hallazgos.**
- **P1 (bug real): 4** — trigger `film_sealed` por orden de inserción y fechas retroactivas sin validar (B-1); herencia del default `CLOSED` de D-117 (B-2); «volver a sellar» compara instantes de grabación y deja un hueco si la bobina se usó antes de que exista un evento (B-3); duplicar cotización confirmada con bobina entera sigue devolviendo 400 (A-1).
- **P2 (mejora / riesgo menor): 11** — A-2 a A-6 y B-4 a B-9.

Lo pedido explícitamente para (B):

- «Volver a sellar» con salida desde la apertura: **bloquea correctamente** para bobinas con historial de eventos (salidas vivas PRODUCTION/SCRAP/SPLIT/CUTTING, con `reversals: none`, y OP viva montada; `coil-film.ts:94-133`, `loadResealFacts`). Hay un hueco para bobinas sin historial y por diseño del filtro `since` (B-3).
- Reporte mensual a fin de mes: **no usa el estado de hoy para el film** (LATERAL `operation_date < inicio del mes siguiente`, `reports.service.ts:104-111`). Solo usa el `status` de hoy para la regla «terminada con saldo 0 → Abiertas» (B-7, riesgo menor). Costos enmascarados por rol (`closingValuePen` y `unitCostPerKg` nulos sin `canSeeCosts`).
- Backfill: **idempotente** (`hasEvents` ⇒ KEEP; segunda pasada verificada al final del execute). Tiene una ventana de carrera (B-5) y una condición de orden de despliegue (B-3).
- (A) Orden en el servidor: **sin inyección** (clave = `z.enum` cerrada + tabla fija clave→fragmento Prisma). Paginación estable solo donde el desempate es único (A-2).

---

## P0

Sin hallazgos.

## P1

### B-1. `film_sealed` seguía el último evento insertado; el resto del sistema ordena por fecha de negocio; y no se valida la fecha retroactiva

- Archivos: `apps/api/prisma/migrations/20260926120000_d328_film_de_bobina/migration.sql` (función `coil_film_events_sync`), `apps/api/src/coils/coil-film.service.ts:32-58` (`open`) y `:68-96` (`reseal`), `apps/api/src/coils/coil-film.ts:35-49` (derivación por `operationDate, at, id`).
- Escenario: la bobina se abrió el 20-sep (montaje) y se resello el 26-sep (baja sin reportes). Un ADMINISTRADOR registra «Abrir bobina» con fecha 22-sep (D-124). Orden por fecha: OPENED 20, OPENED 22, RESEALED 26 ⇒ el reporte y el historial dicen «Sellada»; el trigger dejaba `film_sealed = false` (último insertado) ⇒ la lista y la ficha decían «Abierta» y permitían «Volver a sellar». Dos verdades distintas sobre la misma bobina.
- Estado: la autorrevisión ya lo vio. La migración **sin commit** `20260926130000_d328_film_sync_por_fecha` recalcula la columna con el orden `(operation_date, at, id)`. Está untracked: si la rama se empuja sin ella, producción queda con el trigger viejo. Hay que commitearla y aplicarla junto con la primera (la primera ya corrió en `ci`, no se edita).
- Queda pendiente, y con el trigger nuevo se vuelve más visible: `open`/`reseal` no validan que `operationDate` sea posterior o igual al del último evento (ni a `coil.operationDate`). Un «Volver a sellar» fechado antes de la última apertura inserta un `RESEALED` que el orden por fecha deja **detrás** del `OPENED`: el diálogo dice «Bobina vuelta a sellar» y la bobina sigue «Abierta». Ídem «Abrir» fechado antes de un `RESEALED`.
- Corrección sugerida: en `open` y `reseal`, tras `lockCoil`, leer el último evento (mismo orden) y rechazar con 400 si `operationDate < último.operationDate` («la fecha no puede ser anterior al último movimiento del film del DD/MM»). Agregar un caso de test al spec del servicio.

### B-2. Herencia de D-117(a): compras sin recibir con `coil_status = 'CLOSED'` y bobinas ya recibidas como «Terminada» con saldo

- Archivos: `apps/api/src/purchases/purchases.service.ts:231` y `:407`; `apps/web/src/app/(app)/compras/purchase-form.tsx` (`toApiBody`, ya no manda `coilStatus`); `apps/api/prisma/backfill-film.ts` (`classifyBackfill`, caso `NO_USE`).
- Escenario (a): hasta hoy el formulario mandaba `coilStatus: 'CLOSED'` **explícito** en toda línea de compra de bobina (`item.coilStatus ?? 'CLOSED'`). Toda compra registrada (DRAFT) y no recibida al momento del deploy lleva `purchase_items.coil_status = 'CLOSED'`. Al recibirla, `item.coilStatus ?? CoilStatus.OPEN` respeta ese CLOSED: las bobinas nacen «Terminada», sin film, y el formulario nuevo ya no tiene el selector para cambiarlo. Justo lo que D-328 quiso sacar. Editar y guardar la compra lo limpia (el cuerpo ya no lleva el campo), pero nadie sabe que tiene que hacerlo.
- Escenario (b): las bobinas recibidas desde D-117(a) como `CLOSED` con saldo > 0 (el «proxy de film puesto») no las toca el backfill (`NO_USE` ⇒ sin evento, y el estado sigue `CLOSED`). En pantalla y PDF dicen «Terminada» aunque están sin abrir y con kilos; para montarlas hay que «reabrirlas» (D-193). El dry-run no las cuenta aparte.
- Verificar antes de la ventana (lectura): cantidad de `purchase_items` COIL con `coil_status='CLOSED'` en compras `DRAFT`, y de `coils` con `status='CLOSED'` y saldo > 0.
- Corrección sugerida: decisión del dueño, registrada como `D-nnn`: (a) migración aditiva `UPDATE purchase_items SET coil_status = NULL WHERE coil_status = 'CLOSED'` para compras DRAFT (o ignorar `CLOSED` en `receive` para ese caso); (b) que el dry-run de `backfill:film` liste «Terminadas con saldo > 0» y el dueño decida si esas pasan a `OPEN` + sellada por un servicio de dominio. Mínimo: dejarlo dicho en el handoff y en la guía del cliente.

### B-3. «Volver a sellar»: la comparación `at >= lastOpen.at` deja pasar el uso anterior a la apertura registrada

- Archivos: `apps/api/src/coils/coil-film.ts:113-125` (`since`), `:376-394` (`resealIfOpenedBy` reusa `resealBlocker`), `apps/api/prisma/backfill-film.ts` (orden de ejecución).
- Escenario: una bobina ya usada en agosto (salida `PRODUCTION`, sin evento de film porque el backfill aún no corrió, o porque quedó fuera). Después del deploy, alguien la monta: `openFilmIfSealed` escribe `OPENED/MOUNT` con `at` de hoy; al bajarla sin reportes, `resealIfOpenedBy` → `resealBlocker` filtra las salidas con `at >= lastOpen.at` y **no ve la de agosto**; la vuelve a sellar. Lo mismo con «Abrir» manual y luego «Volver a sellar». Resultado: bobina usada, marcada «Sellada», y el backfill posterior la salta (`HAS_EVENTS`), con el film de meses pasados mal en el reporte.
- Además la comparación mezcla `at` de instantes generados por instancias distintas de Cloud Run: una desviación de reloj de milisegundos puede dejar una salida fuera del filtro.
- Como toda operación de uso abre **antes** de mover kardex (`openFilmIfSealed` va antes de `inventory.record`), no existe un caso legítimo de salida viva previa a la apertura vigente. Un ciclo anterior con uso ya habría bloqueado el resello.
- Corrección sugerida: eliminar el filtro `since`; cualquier salida viva de tipos de uso bloquea el resello (para `MANUAL`, `MOUNT`, `CUTTING_SEND` como ya se hace para `BACKFILL`). Quita la dependencia de relojes y cierra el hueco sin cambiar el comportamiento esperado. En la ventana: `migrate deploy` → `backfill:film --execute` → recién ahí el deploy de la API, para que no exista un periodo con la lógica nueva y sin backfill.

### A-1. D-322 no cubre la cotización **confirmada** (ni despachada) con bobina entera: el duplicado sigue devolviendo 400

- Archivos: `apps/api/src/sales/quotations.service.ts:544-551` (solo `findCoilTies`), `apps/api/src/sales/coil-sale-product.ts:389-411` (`findCoilTies` mira solo cotizaciones `DRAFT`/`EMITTED`), `apps/api/src/sales/sales-lines.ts:962` (`available.lte(0)`).
- Escenario: D-119 permite duplicar «en cualquier estado». Cotización `CONFIRMED` con una línea de bobina entera (D-116). Su pedido reserva esa bobina (ledger firme). `findCoilTies` no la ve (la cotización ya no es `DRAFT`/`EMITTED`), la línea viaja como `saleCoilId` y `resolveSaleCoils` calcula `available = físico − reservado ≤ 0` ⇒ `400 «no tiene saldo disponible para vender»` y **no se duplica nada**, ni siquiera las demás líneas. Idem si la bobina ya se despachó (saldo 0) o quedó montada/anulada. El E2E y el spec de D-322 solo cubren la atadura por otra cotización abierta.
- Corrección sugerida: en `duplicate`, para cada línea de bobina entera aplicar la misma degradación (línea `BOB…` sin bobina + aviso) cuando la bobina ya no se puede vender: estado distinto de `OPEN`/`CLOSED`, `available ≤ 0` (`reservedByItem`), montada, además de la atadura por cotización. Reusar la lógica de `resolveSaleCoils` (extraer el predicado) en vez de duplicarla. Agregar test con cotización confirmada.

---

## P2

### A-2. Desempate del orden no es único en varios listados (paginación puede repetir o perder filas)

- Archivo: `apps/api/src/common/list-orderings.ts:60` (bobinas: `operationDate, createdAt`), `:79` (clientes: `isActive, name`), `:97` (compras), `:118` (comprobantes), `:139` (despachos usa `seq`, ese sí es único). Cotizaciones, pedidos: desempate `seq`, único.
- Escenario: ordenar bobinas por «Estado» o clientes por «Días de crédito»: muchas filas empatan en la columna y en el desempate (las hijas de un partido comparten `operationDate`/`createdAt`; clientes con el mismo nombre). Con `skip/take`, Postgres no garantiza el orden entre empates y una fila puede aparecer en dos páginas o en ninguna.
- Corrección: que `listOrderBy` agregue siempre `{ id: 'asc' }` al final.

### A-3. El web reenvía `?sort=` sin validar; una clave desconocida rompe la lista

- Archivos: `apps/web/src/app/(app)/cotizaciones/cotizaciones-view.tsx:73-76`, `pedidos-view.tsx` (`serverSort`), `use-sort.ts` (`current as K`).
- Escenario: un enlace guardado o editado con `?sort=algo` llega al API como `sort=algo` ⇒ 400 de Zod y la tabla queda en error. `sortRows` sí ignora claves ajenas (comentado), pero el camino del servidor no.
- Corrección: validar contra las `*_SORT_KEYS` antes de armar la consulta y tratar lo demás como «sin orden».

### A-4. Orden de servidor por estado y por fechas nulas

- `quotationOrderBy` y `coilOrderBy` con `status`: Postgres ordena por posición del enum, no por la etiqueta que se ve (y la cotización vencida se muestra `EXPIRED` sin estarlo en la base). En bobinas, la columna ahora muestra Sellada/Abierta/Terminada y el orden por `status` mezcla Sellada con Abierta. `dueDate` nulo: `asc` deja los nulos al final y `desc` al principio. Riesgo de expectativa, no de datos.

### A-5. `RowActions` ignora partes de `HeaderAction`

- `apps/web/src/components/row-actions.tsx:78-104`: una acción con `download` (permitida por el tipo compartido) se pinta como botón sin efecto; una con `href` y `disabled` sigue siendo un enlace activo en el botón principal. Hoy ninguna fila lo usa (latente). Corrección: soportar `download` y `disabled` con `href`, o estrechar el tipo de `RowActions`.

### A-6. D-322: la copia nace `EMITIDA` con una línea `BOB…` sin bobina

- `quotations.service.ts:583-598` y `sales-lines.ts:399`. La copia se emite y genera el PDF (D-184) con una línea de producto de bobina sin bobina concreta. La UI bloquea confirmar (`unassignedCoilLines`), pero el API acepta confirmar y falla luego con el mensaje confuso «BOB… tiene 0.000 KGM disponibles» (D-254 R1). Corrección: blocker explícito en `confirmPreview`/`confirm` («la línea N necesita elegir bobina») y aviso en el PDF o no generarlo hasta asignar.

### B-4. Anular una OP no vuelve a sellar la bobina que el montaje abrió

- `apps/api/src/production/production.service.ts:1293-1296` libera consumos de una OP anulada sin llamar a `resealIfOpenedBy`. Bobina sellada → montada → OP anulada sin reportes: queda «Abierta». Se corrige a mano con «Volver a sellar» (que sí procede), pero D-328 promete resello solo para «liberar» y «cancelar envío». Corrección: llamarlo también ahí, o documentarlo en D-328.

### B-5. Backfill: los hechos se leen fuera de la transacción de escritura

- `apps/api/prisma/backfill-film.ts:157` (`plan()`) y `:195` (transacción). Si entre el plan y el execute alguien abre o resella una bobina (ventana de operación), el evento `BACKFILL` se inserta encima y puede reabrir una recién resellada. Corrección: dentro de la transacción, releer `hasEvents` por bobina (o `lockCoil`) antes de cada `recordFilmEvent`, y correrlo en horario muerto (regla de la ventana).

### B-6. Reporte mensual: las anuladas caen en «Selladas» con 0 kg

- `reports.service.ts:104-125`: las `CANCELLED` (compra anulada, saldo 0) sin evento caen en «Selladas» y ensucian esa tabla. Corrección: excluirlas o marcarlas. La consulta original ya las incluía, así que no es regresión.

### B-7. Reporte mensual: rótulo «Estado» mezcla el estado de hoy con el film del corte

- `reporte-bobinas-view.tsx` (`coilStateLabel({ status: row.status, film })`) y `monthEndTable` usan el `status` de hoy. Una bobina terminada en septiembre con saldo al 31-ago aparece en agosto ubicada por film (correcto) pero rotulada «Terminada» (estado de hoy). Corrección: rotular por film de la tabla salvo que la terminada tenga saldo 0 a fin de mes.

### B-8. El Excel de inventario valorizado rotula «Vigente»

- `apps/api/src/reports/reports-xlsx.ts:109` sigue con `COIL_STATUS_LABELS[c.status]`; con D-328 toda vigente sale «Vigente», sin distinguir film. Solo rótulo; usar `coilStateLabel` si el dueño lo quiere consistente.

### B-9. Migración: sin observaciones bloqueantes, con dos notas

- La migración `20260926120000` es aditiva y la función/trigger son coherentes (enums, CHECK tipo↔fuente, append-only, columna `NOT NULL DEFAULT true` sin reescritura). Prisma no modela CHECK ni triggers: `migrate diff` no los ve, así que la coincidencia con el drift conocido no los verifica; comprobar `\d coils`/triggers tras aplicar. `coil_film_events` no está en la lista de tablas de `production-cleanup-v4.ts` (el `TRUNCATE ... CASCADE` la arrastra igual; solo afecta su conteo).

---

## Qué NO se revisó

- Los E2E (`film-bobina-d328.spec.ts` y demás) y la corrida completa de la suite; no los ejecuté (regla de la tarea). Sí leí el diff de los specs solo de reojo.
- `coil-film.tx.spec.ts` (necesita base) no se ejecutó.
- La tanda A del lado web se revisó por muestreo: `sort-rows.ts`, `use-sort.ts`, `sortable-table-head.tsx`, `row-actions.tsx`, `nav.ts` y `app-sidebar.tsx` completos; las ~30 vistas que los usan, solo cotizaciones, pedidos, usuarios, bobinas y reporte de bobinas. No verifiqué cada acción migrada a `RowActions` (confirmaciones conservadas).
- `docs/`, la guía del cliente y el handoff: leí la fila D-328 como especificación, no auditó el resto de la documentación.
- Comportamiento real de Prisma con `@default(now())` (reloj de app vs. de base) no lo verifiqué contra una base; por eso B-3 recomienda no depender de `at`.
- No revisé la migración sin commit más allá de su SQL, ni el estado de la CI de la rama.

---

## Respuesta de la sesión de implementación (2026-09-26)

Este pase lo hizo un **subagente** sin haber leído el handoff, y por AGENTS.md §2 vale como
**autorrevisión**, no como pase cruzado: la pieza queda **PENDIENTE DE REVISIÓN INDEPENDIENTE** en
`docs/PROGRESO.md`. Cómo se resolvió cada hallazgo antes del deploy:

| Hallazgo                                     | Resolución                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-1** trigger por inserción / fechas       | Migración aparte `20260926130000_d328_film_sync_por_fecha` (recalcula `film_sealed` por (fecha, instante, id)); `recordFilmEvent` **rechaza** la fecha manual anterior al último evento y **ajusta** la de una operación automática; unitarios y E2E.                                                                                 |
| **B-2** compras con `CLOSED` heredado        | Medido en producción (solo lectura): **0** compras de bobinas en borrador, y las 6 bobinas `CLOSED` que existen están **sin saldo**. Nada que migrar.                                                                                                                                                                                 |
| **B-3** filtro `since` por instante          | Eliminado: cualquier salida viva de uso bloquea el resello. Unitario que cambia de sentido.                                                                                                                                                                                                                                           |
| **A-1** duplicar cotización confirmada       | `duplicate` degrada la línea (BOB… sin bobina + aviso) cuando la bobina no tiene saldo para vender, no está vigente/terminada o la reserva otro documento; unitarios.                                                                                                                                                                 |
| **A-2** desempate no único                   | `{ id: 'asc' }` al final del orden por defecto de bobinas, clientes, compras y comprobantes.                                                                                                                                                                                                                                          |
| **B-5** backfill lee fuera de la transacción | Relee `coil_film_events` por bobina dentro de la transacción y salta la que ya tiene historial; correr en horario muerto.                                                                                                                                                                                                             |
| B-4, B-6, B-7, B-8, A-3, A-4, A-5, A-6, B-9  | **Diferidos**, registrados en el handoff como deuda (ninguno bloquea el deploy): anular una OP no resella (se hace a mano con «Volver a sellar»), anuladas de 0 kg en «Selladas», rótulo de estado de hoy en el reporte, rótulo «Vigente» en el Excel de inventario, validar `?sort=`, orden por estado, `RowActions`, D-322 emitida. |
