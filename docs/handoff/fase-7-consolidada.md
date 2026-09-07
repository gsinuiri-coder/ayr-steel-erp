# Handoff — Sesión 7 consolidada: backdating, entornos y subtipo de cobertura — 2026-09-06/07

## 1. Resumen

Tres frentes, en el orden de prioridad que pediste. **M1** y **M2** completos; **M3** entró
recortado a lo que marcaste como no sacrificable cuando apareció el caso real de COT-000240.

- **D-124 — fecha de operación (backdating).** Todo hecho fechado del dominio tiene ahora un
  día de negocio (Lima) separado del instante en que se grabó. Por defecto hoy: el flujo de
  todos los días no cambia en nada. Retrofechar es privilegio de ADMINISTRADOR.
- **D-125 / D-126 — entornos.** Rama Neon `demo` creada, migrada y sembrada, con
  `pnpm dev:demo`. `pnpm e2e:prod` queda prohibido como rutina; la verificación post-deploy
  pasa a ser `pnpm smoke:prod`, de solo lectura.
- **D-127 — subtipo de cobertura.** `PLANCHA` / `A_MEDIDA` explícito en el catálogo, y la rama
  de confirmación que faltaba: una cobertura a medida reserva **materia prima**, no stock de
  producto terminado.

**D-122 sigue diferido** (mover el acabado a `products.finish_id` y sacarle a coberturas la
dependencia del `ProductBom`). Queda para su propia sesión.

## 2. Qué cambió

### D-124 — fecha de operación

**Columnas nuevas** (`DATE`, día calendario de Lima): `inventory_movements.operation_date`,
`coils.operation_date`, `cutting_orders.operation_date` (envío),
`cutting_order_coils.received_operation_date` (recepción), `production_orders.operation_date` y
`closed_operation_date` (arranque y cierre), `production_reports.operation_date`.

`dispatches.dispatch_date`, `customer_payments.date` y `supplier_payments.date` ya eran fechas
de negocio: no ganan columna, ganan la misma validación. Los timestamps de auditoría (`at`,
`created_at`, `sent_at`, `closed_at`) **no se tocaron**.

**Un solo validador**, `OperationDateService` (`apps/api/src/common/operation-date.service.ts`),
registrado en `ConfigModule` que es `@Global` para que lo inyecten los servicios de cinco
módulos sin cablear nada:

- sin campo → **hoy en Lima**;
- con campo y rol distinto de ADMINISTRADOR → **403**;
- fecha futura → 400; anterior a `HISTORICAL_LOAD_START` (env, default `2026-08-01`) → 400.

**Guardrail de orden cronológico** dentro de `InventoryService.record`, el único escritor del
kardex: si un movimiento retrofechado cae por detrás de movimientos que el ítem ya tiene,
responde 400 con `code: BACKDATE_OUT_OF_ORDER` y el detalle (ítem, fecha pedida, fecha del más
reciente, cuántos quedan por delante). Se reintenta con `confirmBackdate: true`. En el web eso
es un diálogo que muestra el mensaje del API tal cual y ofrece «Registrar igual».

**Reversas con fecha propia.** Ninguna hereda la del hecho que anula. La única excepción es el
recosteo de una bobina (D-045), que es reversa + reingreso del mismo hecho y por eso los dos
movimientos llevan la fecha del ingreso original.

**Lectores auditados.** El kardex ordena y corta por `operationDate` (el `id` bigserial
desempata dentro del día) y el saldo de apertura de un kardex filtrado también. Los listados de
bobinas, comprobantes, despachos y órdenes de corte pasaron de ordenar por `created_at` a
ordenar por su fecha de negocio.

**En el web:** un campo «Fecha de operación» colapsado detrás de un enlace, **solo visible para
ADMINISTRADOR**, en recepción de compra, partido, merma, envío y recepción de corte, creación
de OP, reporte de piezas, cierre de OP y todas las anulaciones. El kardex muestra la fecha de
operación como columna principal y, solo cuando difieren, el instante de grabación debajo.

**Reporte mensual de bobinas** — `/reportes/bobinas` (`GET /reports/coils?month=YYYY-MM`).
Columnas: Código, Tipo, Línea, Color, Ancho, **Saldo inicio mes (kg)**, Peso (kg), **Saldo fin
de mes (kg)**, Costo/kg, Estado.

> Dos aclaraciones sobre este reporte. Primero: **no existía**. La instrucción decía "reemplazar
> la columna EMPRESA", y esa columna no estaba en ninguna pantalla del sistema; se preguntó y
> confirmaste que había que construirlo. Segundo: «Saldo fin de mes» reemplaza a «Disponible».
> En un reporte de agosto, mostrar el saldo de hoy sería mezclar dos cortes en la misma fila; en
> el mes en curso las dos cifras coinciden. Si preferís que diga «Disponible» y sea el de hoy,
> es un cambio de una línea.

### D-125 / D-126 — entornos

Rama Neon **`demo`** (`br-solitary-smoke-aegbos8k`), creada desde `production` **antes** de que
producción tuviera datos reales, ya migrada y sembrada.

```
pnpm env:demo    # escribe .env.demo (no se commitea)
pnpm db:demo     # migraciones + seed en demo
pnpm dev:demo    # api :3000 + web :3001 contra demo
```

`dev:demo` inyecta la conexión por variables de entorno y **no toca** `apps/api/.env`, así que
convive con `pnpm dev` sin pisarlo.

**`pnpm e2e:prod` queda prohibido como rutina** (regla dura 9 de `CLAUDE.md`, D-126). La
verificación post-deploy es **`pnpm smoke:prod`**: `/health` sin sesión, login con el
ADMINISTRADOR efímero de D-024 y cinco GET (líneas, catálogo, inventario, bobinas, reporte
mensual). Lo único que escribe es ese usuario efímero, y lo borra en `finally`.
`pnpm prod:purge-e2e` queda solo para emergencias, documentadas en `PROGRESO.md`.

Todo en `docs/ENTORNOS.md`.

### D-127 — subtipo de cobertura

El caso: COT-000240 fallaba al confirmarse con `0.000 MTR disponibles… necesita 61.000`. Era
una cobertura **a medida** de 61 ml con subítems de largo, y el sistema le pedía stock de un
producto terminado que no existe hasta que planta lo rola.

- **`products.roofing_kind`** (`PLANCHA` / `A_MEDIDA`), obligatorio en Metallic Roofing,
  **visible y corregible** en el diálogo de producto y en la lista del catálogo. Una cobertura
  nueva nace `A_MEDIDA`.
- Largo fijo **obligatorio solo en `PLANCHA`** y prohibido en `A_MEDIDA`, donde el largo lo
  traen los subítems de cada línea. Subtipo y unidad no pueden discrepar (`A_MEDIDA` ⇒ `MTR`),
  sostenido por la validación del servicio **y** un `CHECK` en la base.
- **La rama que faltaba:** `resolveSalesLines` ramifica por el subtipo. Una línea `A_MEDIDA`
  sin bobina elegida a mano calcula los kilos teóricos (`ml × espesor × ancho ×
densityFactor`) y **reserva materia prima**: el API elige la bobina con el mismo filtro que
  el selector de la OP (abierta, color exacto, espesor de la receta ± tolerancia) y se queda
  con la más antigua por fecha de operación que alcance. Una línea `PLANCHA` sigue exigiendo
  stock de producto terminado, sin cambios.
- El filtro se extrajo a `apps/api/src/production/roofing-coil-match.ts` para que el selector
  de la OP y la confirmación no puedan divergir.

**Backfill sin cambio de comportamiento:** la migración deriva el subtipo de la inferencia que
regía hasta hoy (`unit = MTR` → a medida), así que ningún producto existente cambia de
comportamiento al migrar. Lo que cambia es que el dato ahora está escrito y se puede corregir.

## 3. Tu revisión local (el mini-replay)

Levantá con `pnpm dev` (rama `dev`) o con `pnpm dev:demo` (rama `demo`, copia de producción —
recomendado, porque es el entorno en el que vas a ensayar de ahora en más).

**A — el caso que reportaste (D-127).**

1. `/catalogo` → Metallic Roofing → editá **COB035ROJO**. Ahora tiene un campo **Subtipo de
   cobertura**. Dejalo (o ponelo) en **A medida**; fijate que la unidad se ajusta sola a `MTR` y
   que el campo de largo desaparece.
2. Asegurate de que haya una bobina abierta del mismo color y espesor en `/bobinas`.
3. `/cotizaciones` → abrí **COT-000240** → **Confirmar**. Tiene que pasar.
4. En el pedido, la reserva debe ser sobre **la bobina** (no sobre el producto), por los kilos
   teóricos de los 61 ml.
5. `/planta` → la orden aparece en la cola de producción.

**B — el backdating (D-124), cargando un día de agosto.**

1. `/compras` → nueva compra `COIL` → guardá → en el detalle, debajo del botón **Recibir**,
   tocá **«Cambiar fecha de operación»** y poné una fecha de agosto. Recibí.
2. `/bobinas` → la bobina aparece fechada en agosto, no hoy.
3. `/corte` → enviala a corte con fecha de agosto (posterior a la del punto 1) → recibí los
   flejes, también en agosto.
4. `/planta` → creá la OP, reportá piezas y cerrala, todo con fecha de agosto.
5. Importá un comprobante con F. EMISIÓN de agosto (`/comprobantes` → importar) y comprobá que
   el listado lo ubica en agosto.
6. `/despachos` → nuevo despacho, con **Fecha de traslado** en agosto.
7. **`/reportes/bobinas`** → elegí **agosto 2026**: la bobina está, con su saldo. Cambiá a
   **septiembre**: el saldo de apertura de septiembre es el que quedó al cerrar agosto.
8. `/kardex` de esa bobina: los movimientos salen ordenados por fecha de operación y, cuando la
   fecha de registro difiere, se lee debajo en chiquito.

**C — que el guardrail y los roles funcionen.**

9. Entrá con un usuario **VENDEDOR**: el campo de fecha de operación **no aparece** en ninguna
   pantalla.
10. De vuelta como administrador, intentá registrar una merma sobre esa bobina con una fecha
    **anterior** a lo que ya cargaste: tiene que salir la advertencia con el detalle y pedirte
    confirmación.

**D — que el día a día no cambió.**

11. Hacé una operación cualquiera **sin tocar** el campo de fecha: tiene que quedar con la
    fecha de hoy, exactamente como antes.

## 4. Verificación hecha

- `pnpm turbo lint typecheck test build` — verde.
- `pnpm format:check` — verde.
- Migraciones aplicadas a Neon `dev` y a Neon `demo` (`pnpm db:deploy`, `pnpm db:demo`).
- **E2E: 14/14** de los casos nuevos (`fase7-consolidada.spec.ts`, `fase7-consolidada-subtipo.spec.ts`)
  y **45/45** del smoke de fase5a, fase6 y fase7e con sus bordes. La suite completa la corre CI.
- `node scripts/check-roofing-catalog.mjs --branch demo` — ningún producto real queda bloqueado
  por las reglas nuevas de D-127.
- Revisiones de `revisor`, `auditor-seguridad` y `qa`: ver §6.

## 5. Bloqueo preexistente que apareció (no es de esta sesión)

`pnpm db:migrate` (`prisma migrate dev`) no corre contra `dev`: la migración
`20260905150937_fase7b_venta_en_anulacion` fue **editada en el commit `9438677` después** de
haberse aplicado a esa rama, así que Prisma detecta el desvío y exige resetearla. No bloqueó
nada: `pnpm db:deploy` aplica lo pendiente sin ese chequeo y es lo que se usó. Queda anotado
para que la próxima sesión no lo vuelva a descubrir; si molesta, se arregla reseteando `dev`
desde `production` (`pnpm db:reset-dev`).

## 6. Resultado de las revisiones

`revisor` y `auditor-seguridad` corrieron sobre el diff (sin `e2e/`, que `qa` estaba escribiendo
en paralelo). Los dos encontraron cosas reales. **Todo lo bloqueante y todo lo alto está
corregido**; lo que queda abierto está listado al final con su motivo.

### Bloqueantes corregidos (revisor)

1. **El consumo de bobina del reporte de coberturas quedaba fechado hoy.** Era el único de los
   ~34 puntos que escriben kardex que no recibía la fecha de operación. Un reporte retrofechado
   dejaba el consumo de la bobina en un mes y el ingreso de producto terminado en otro, en una
   tabla append-only que no se corrige con un `UPDATE`.
2. **La materia prima se elegía al cotizar, no al confirmar.** Dos consecuencias, las dos
   graves: no se podía **cotizar** una cobertura a medida sin bobina disponible (el caso normal
   del rubro), y la bobina quedaba congelada en la cotización, que vive hasta 365 días — al
   confirmar, meses después, apuntaría a un rollo ya cerrado o consumido, sin forma de
   re-elegir. Ahora la cotización guarda solo su intención y **el pedido resuelve la bobina
   contra el stock del día**, tanto al confirmar como en un alta directa o una venta de
   mostrador.
3. **Las columnas nuevas quedaban `NOT NULL` sin `DEFAULT`.** Entre `pnpm db:prod` y
   `pnpm deploy:api`, la revisión anterior del API sigue sirviendo tráfico e inserta sin conocer
   la columna: toda alta de kardex, bobina, orden de corte, OP o reporte habría fallado durante
   la ventana de deploy. Se agregó el `DEFAULT` (en zona de Lima, no `CURRENT_DATE`) en una
   migración propia — editar la ya aplicada habría dejado a `dev` y `demo` con el mismo desvío
   de checksum que este repo ya sufrió una vez.

### Altos corregidos

- **La tolerancia de espesor se leía de dos fuentes** (la constante compartida en ventas, el
  override de entorno en producción). Con el override puesto, la cotización elegía de un
  conjunto distinto al que la OP acepta montar: la divergencia que el archivo compartido venía
  a cerrar, movida del `where` al argumento. Ahora las dos pasan por `roofingToleranceMm`.
- **`reverse` y `adjustCost` aceptaban fecha sin pasar por el guardrail cronológico.** Un
  administrador podía meter una reversa retrofechada por detrás del saldo corrido sin
  advertencia. Ahora pasan por el mismo control.
- **El recosteo de una bobina (D-045) quedaba roto**: reingresa con la fecha del ingreso
  original, así que cualquier bobina con un movimiento posterior chocaba contra el guardrail sin
  ruta para confirmar. Lleva el acuse explícito: es reversa + reingreso del mismo hecho.
- **La cobranza pasó a ser ADMIN-only y la pantalla no lo decía**: un VENDEDOR recibía un 403
  opaco al fechar un depósito de ayer. El campo ahora está deshabilitado para no-admin, como ya
  estaba en despachos.
- **El subtipo no era corregible en ningún producto real.** Cambiarlo obliga a mover la unidad,
  y el guardrail de "no cambies la unidad si hay receta" lo bloqueaba — pidiendo desactivar una
  receta que el propio subtipo necesita viva. Ahora el cambio acompañado de subtipo está
  permitido, y solo una receta **activa** bloquea (antes bloqueaba también una desactivada, un
  defecto preexistente que D-127 volvía carga de trabajo).
- **Dos líneas a medida del mismo documento elegían la misma bobina.** Se descuenta lo ya
  comprometido por las líneas anteriores del mismo pedido.

### Alto de seguridad corregido (auditor)

**`.env.demo` se escribía con el `JWT_SECRET` de producción.** Como `demo` es un clon de
`production` —mismos usuarios, mismos ids de sesión— y el `AuthGuard` acepta cualquier JWT bien
firmado cuyo `sid` exista, el secreto compartido convertía a demo (y a ese archivo) en una llave
de producción, sin conocer ninguna contraseña. Corregido: `pnpm env:demo` genera `JWT_SECRET` y
contraseña de administrador **propios y aleatorios**, y `pnpm db:demo` **purga siempre las
sesiones heredadas** del clon. El procedimiento de re-clon quedó escrito en `docs/ENTORNOS.md`.

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

### Medios y bajos corregidos

- Una fecha con formato válido pero **día inexistente** (`2026-08-32`) pasaba las cotas y
  reventaba en Prisma; `2026-02-31` era peor porque **no fallaba**, rodaba en silencio al 2 de
  marzo. `operationDateSchema` ahora exige que el día exista.
- El web seguía infiriendo "a medida" de la unidad en el formulario de venta, la misma
  inferencia que D-127 dice haber eliminado.
- El `CHECK` de la base era más laxo que el servicio (`PLANCHA` con cualquier unidad ≠ `MTR` vs.
  `NIU` exacto): se alineó el servicio con la base, que es la regla que de verdad importa.
- `assertChronological` traía el histórico entero del ítem a memoria solo para contarlo.
- Se reusó `findLiveStripAssignments` en vez de repetir la consulta de "montada en una OP viva".
- `void attempt()` dejaba un rechazo sin manejar en cada fallo normal del diálogo de retrofecha.
- El reporte mensual quedó restringido a los mismos roles que el menú ya mostraba.
- `pnpm smoke:prod` valida el `--base-url` (https y dominio del proyecto) y borra el admin
  efímero también ante `Ctrl+C`.
- **`pnpm e2e:prod` ahora se niega a correr** salvo con `AYR_ALLOW_E2E_PROD=1`: una prohibición
  que solo vive en un documento se saltea tecleando el comando de siempre.
- `audit_log` registra con qué fecha se registró cada operación retrofechable y si se confirmó
  saltando la advertencia (despacho, cobranza, pago a proveedor, reportes de piezas, y lo que ya
  estaba: partido, merma, anulaciones, recepción de corte, recepción de compra, cierre de OP).

### Verificado sobre datos reales antes de desplegar

`node scripts/check-roofing-catalog.mjs --branch demo` (demo es la copia de producción de hoy):
236 productos de coberturas, **ninguno sin subtipo**, ninguno con unidad incoherente. Hay 161
`PLANCHA` sin largo fijo que las reglas nuevas dejarían sin poder editar — **todos con prefijo
`E2E` y desactivados**, o sea residuo de pruebas. Ningún producto real queda bloqueado.

### Lo que queda abierto, a propósito

- **`fiscal_documents.issueDate` no pasa por el control de retrofecha.** `assertIssueDateWindow`
  (D-072) permite hasta 7 días de atraso **a cualquier rol**, que es la ventana que SUNAT
  admite; en los primeros 7 días de un mes, eso deja a un VENDEDOR emitiendo un comprobante
  fechado en el mes anterior. Es previo a esta sesión, pero es el hueco de la regla "solo un
  administrador mueve un hecho de mes". **No se tocó a propósito**: cambiar las reglas de
  emisión electrónica la noche anterior a la entrega es más riesgoso que el hueco. La corrección
  natural —exigir ADMINISTRADOR cuando `issueDate` cae en un mes distinto del corriente— es
  chica y queda anotada para la sesión siguiente.
- **El importador de comprobantes admite hasta 10 años atrás**, sin pasar por
  `HISTORICAL_LOAD_START`. Es ADMINISTRADOR-only. Queda como está y anotado: son dos pisos
  distintos para la misma pregunta.
- **`confirmBackdate` es un booleano del cliente.** Un administrador que lo mande siempre en
  `true` desactiva el guardrail sin haber visto la advertencia. Se aplicó la remediación mínima
  que propuso el auditor (queda registrado en `audit_log`); la versión fuerte —un token corto
  ligado al ítem y a la fecha, que el API tenga que reconocer— queda para la sesión siguiente.
- **La modalidad de traslado y el despacho ahora exigen ADMINISTRADOR para cambiar la fecha.**
  Es coherente con D-124 y es lo que pediste, pero es una pérdida de capacidad operativa real:
  una guía emitida ayer y tipeada hoy necesita un administrador. Decime si preferís una ventana
  corta hacia atrás para VENDEDOR y SUPERVISOR_PLANTA.

## 6b. Incidente de seguridad de esta sesión: una cadena de conexión de Neon quedó impresa en el log

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

## 7. Siguiente sesión

1. **D-122 completo**: `products.finish_id` + backfill, `coilOptions`/`mountCoil` contra
   `product.thicknessMm`, `production_orders.bom_id` nullable, DTO y frontend. Hoy la densidad
   del acabado con la que se convierten metros en kilos sigue saliendo de la receta.
2. **Dedup drywall** (lo otro que quedaba de M3): el peso por pieza vive en el SKU y la receta
   queda solo como vínculo fleje→perfil.
3. Fase 8 (auditoría, reportes, UAT) sigue pendiente.
4. `vercel login` sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push.
