# Revisión de segundo modelo: cc42 (drift de schema y seed:escenarios)

- **Fecha:** 2026-10-10
- **Revisor:** segundo modelo, Sonnet, contexto limpio (no es una persona; AGENTS.md §2, punto 2.2).
- **Alcance:** `git diff origin/main...HEAD` de `chore/cc42-drift-escenarios`. Foco A: clasificación del
  drift (`docs/analisis/drift-schema.md`, `schema.prisma`, `drift-esperado.sql`, `scripts/check-drift.mjs`,
  paso nuevo del `ci.yml`). Foco B: el guard de base de `scripts/seed-escenarios.mjs`, su test, su
  prueba de integración y el job `escenarios`.
- **Método:** solo lectura. No se conectó a ninguna base ni se levantó nada. Lo que depende de
  `production` (que su SQL de drift sea idéntico al de la base desde cero) **no se pudo
  comprobar** y se toma del informe de la pieza. Lo que depende del comportamiento interno de
  Prisma (P1-1) viene de la documentación y de memoria, **no se ejecutó**.

Resumen: 0 P0, 1 P1, 6 P2.

---

## Hallazgos

### P1-1. El guard mira la URL con `new URL`, pero Prisma acepta parámetros de consulta que cambian el host

- **Archivo:** `scripts/seed-escenarios.mjs:78-99` (`assertEscenariosDb`); también lo hereda
  `scripts/seed-escenarios.it.mjs:31`.
- **Escenario:** `ESCENARIOS_DATABASE_URL=postgresql://u:p@localhost:5434/ayr_local?host=<host-remoto>`.
  `new URL` da `hostname = localhost` y `pathname = /ayr_local`, y el guard aprueba. Prisma (el
  conector Postgres admite `?host=` para los sockets de Cloud SQL, y el valor puede ser un nombre
  de host) conecta al host del parámetro, no al de la autoridad. Probé solo la parte de
  `new URL`: conserva `?host=...` en `url.search` y `toString()` lo devuelve entero a los hijos
  (`migrate deploy`, `seed.ts`, `seed-view.ts` y la API). El mismo agujero existe para cualquier
  otro parámetro que el conector interprete (`options`, `sslmode`, `schema`).
- **Por qué importa:** el requisito del dueño es «rechaza cualquier otra base antes de conectar».
  Hoy el rechazo depende de que nadie construya (o pegue) una URL así. `seed-view.ts:25-39` tiene
  el mismo patrón (solo mira `hostname`), así que no hay una segunda red detrás.
- **Corrección sugerida:** lista blanca de parámetros. Tras parsear, exigir que
  `[...url.searchParams.keys()]` esté contenido en `['schema']` (y `schema === 'public'`), que no
  haya fragmento, y reconstruir la URL desde partes fijas
  (`postgresql://${user}:${pass}@${hostname}:${port}/ayr_local?schema=public`) en vez de devolver
  `url.toString()`. Añadir al `.test.mjs` los casos `?host=remoto`, `?hostaddr=`, `?options=` y
  `?schema=otro`.

### P2-1. El puerto queda libre: «solo el Postgres del Docker» no se cumple del todo

- **Archivo:** `scripts/seed-escenarios.mjs:72-76` y `:94` (el comentario de cabecera lo declara:
  «mueve el puerto o las credenciales»).
- **Escenario:** un túnel o proxy local a otra máquina (`localhost:5435` hacia una base remota con
  nombre `ayr_local`) o el Postgres de otro proyecto del dueño en `5433` con una base llamada
  igual. El guard acepta cualquier puerto en `localhost`.
- **Corrección sugerida:** fuera de `GITHUB_ACTIONS === 'true'`, exigir `port === DB_PORT` (5434) y
  `ESCENARIOS_DATABASE_URL` solo en CI. En CI, exigir `localhost:5432`.

### P2-2. `voidPrevious` identifica al cliente DEMO por nombre además de por id

- **Archivo:** `scripts/seed-escenarios.mjs:404-405`.
- **Escenario:** el dueño crea a mano en `ayr_local` otro cliente llamado «Cliente Demo» (otro
  DNI) para probar algo. `isCustomer` lo reconoce por `customerName` y le anula comprobantes,
  despachos, pedidos, cotizaciones y reservas. Es una base local, pero el requisito era que lo
  anulado sea solo DEMO. Además, `pedidos`, `cotizaciones` y `reservas` filtran solo por cliente:
  un pedido de «Cliente Demo» con un producto no DEMO también se anula.
- **Corrección sugerida:** comparar solo por `customerId === masters.customer.id` (el cliente se
  resuelve por `docNumber`). Si las listas no traen `customerId`, filtrar por `docNumber`. Para
  pedidos y cotizaciones, exigir además que alguna línea tenga un SKU de `DEMO_SKUS`, o aceptar que
  «todo lo de Cliente Demo es DEMO» y dejarlo escrito en la cabecera.

### P2-3. La API hija hereda variables de `apps/api/.env` que `apiEnv` no apaga

- **Archivo:** `scripts/seed-escenarios.mjs:118-133` y `:230` (`env: { ...process.env, ...apiEnv }`).
- **Escenario:** la base no se desvía: `DATABASE_URL` y `DIRECT_URL` van explícitas y `dotenv` no
  pisa lo ya definido. Pero `main.ts:1` carga `apps/api/.env` y `apiEnv` solo vacía las `R2_*`,
  `NUBEFACT_*`, `PSE_ENABLED` y `JOBS_ENABLED`. `APIS_NET_PE_TOKEN` (y `COMPANY_RUC`, etc.) sí se
  heredan: cualquier ruta que consulte el padrón saldría a internet con el token real.
- **Corrección sugerida:** añadir `APIS_NET_PE_TOKEN: ''` a `apiEnv` (o a `EXTERNAL_OUTPUTS_OFF`,
  que lo comparten otros CLI; en ese caso revisar `run-api-cli`).

### P2-4. `check:drift` conserva el query string de `DATABASE_URL` en CI y colisiona entre sesiones

- **Archivo:** `scripts/check-drift.mjs:28-37` y `:108,129`.
- **Escenario 1 (CI):** `driftDbUrl` cambia solo `pathname`, así que un `?host=` en el
  `DATABASE_URL` del job llegaría a `migrate deploy` (la URL de mantenimiento sí limpia
  `search`, pero la de `migrate` no). Hoy el job trae `?schema=public`, no hay riesgo real.
- **Escenario 2 (local):** dos sesiones del agente corriendo `pnpm check:drift` a la vez usan la
  misma base `ayr_drift_check`; la segunda ejecuta `DROP DATABASE … WITH (FORCE)` y mata las
  conexiones de la primera, que falla lejos de la causa (mismo patrón de `ayr_local_e2e`, ver
  memoria de sesiones paralelas).
- **Qué no puede tocar:** localmente el host es fijo (`127.0.0.1:5434`) y el nombre fijo
  (`ayr_drift_check`), así que no alcanza Neon, `ayr_local` ni las de E2E. Correcto.
- **Corrección sugerida:** limpiar `url.search` (dejar `?schema=public`) y, opcionalmente,
  sufijar el nombre con el pid o con `AYR_DRIFT_SUFFIX` y exigir el prefijo `ayr_drift_check`.

### P2-5. Los cinco `DEFAULT` de `operation_date` quedan sin aviso en `schema.prisma`

- **Archivo:** `apps/api/prisma/schema.prisma:902, 1141, 1252, 1411, 1523` (los cinco campos
  `operationDate`) y `docs/analisis/drift-schema.md` fila 1-5.
- **Evaluación de la decisión:** correcta. En Prisma cualquier `@default(...)`, incluido
  `dbgenerated`, hace opcional el campo en `XCreateInput`/`XUncheckedCreateInput`; un escritor
  que olvide `operationDate` compilaría y tomaría la fecha de la base, saltándose
  `OperationDateService`. Dejarlo ESPERADA es la opción más segura. El argumento de D-124 (cubrir
  a la revisión vieja del API durante el deploy) sigue vigente cada vez que una migración añade
  una columna con fecha.
- **Riesgo residual:** nada en el schema avisa que la base tiene el default. Quien corra
  `prisma migrate dev` obtiene una migración que hace `DROP DEFAULT` en las cinco tablas, y esa
  migración, aplicada en una ventana, reabre el 500 de D-124. El guardián de CI no lo ve (la
  migración y el schema cuadrarían).
- **Corrección sugerida:** un comentario `///` en cada uno de los cinco campos («la base tiene
  DEFAULT a propósito, D-124/D-594; no declararlo ni borrarlo») y una línea en el documento de
  análisis sobre `migrate dev`.

### P2-6. `compareDrift` compara por pertenencia y los tests del guard no cubren los bordes

- **Archivo:** `scripts/check-drift.mjs:80-85`; `scripts/seed-escenarios.test.mjs`.
- **Detalle:** `includes` ignora multiplicidad y orden: una sentencia repetida dos veces en la
  salida real pasa si está una vez en la lista. Como el texto de cada sentencia nombra su tabla,
  hoy no hay caso práctico, pero la comparación es más floja de lo que dice el documento
  («sentencia por sentencia»). Comparar arreglos ordenados lo cierra sin costo.
- **Tests del guard:** faltan `?host=`, parámetros extra, `LOCALHOST` (mayúsculas), `[::1]`,
  `localhost.` y un nombre con codificación (`ayr%5Flocal`). Comprobé a mano con `new URL` que en
  un esquema no especial el host **no** se pasa a minúsculas, por lo que `LOCALHOST` y `[::1]`
  se rechazan (falla segura, aunque incómoda para quien escriba `LOCALHOST`); `ayr_local/` con
  barra final también se rechaza. Conviene dejar esos comportamientos fijados en el test.

---

## Lo que se revisó y no tiene hallazgos

**A. Clasificación del drift**

- Las 13 diferencias contra las migraciones citadas: las cinco FK
  (`dispatches_invoice_id_fkey`, `finishes_color_id_fkey`, `production_orders_bom_id_fkey`,
  `products_finish_id_fkey`, `raw_material_specs_color_id_fkey`) nacen `ON DELETE RESTRICT` en
  `20260915090000`, `20260914120000`, `20260904140000`, `20260907160000` y `20260907120100`; los
  índices `products_finish_id_idx` y `sales_orders_origin_status_idx` los crean `20260907160000` y
  `20260907180000`; `raw_material_specs_lookup_idx` sale de `20260907120100`. Los cinco `SET DEFAULT`
  de `operation_date` están en `20260906140000` y ninguna migración posterior los quita. La
  clasificación SOLO-SCHEMA vs ESPERADA es coherente con eso.
- La afirmación «REAL: ninguna» no se pudo verificar contra `production` (sin acceso). El método
  es válido (SQL de producción contra SQL de la base desde cero, texto contra texto); queda como
  dato del autor.
- `onDelete: Restrict` e `@@index`/`map:`: con `relationMode` por defecto (`foreignKeys`) Prisma no
  emula acciones referenciales, la FK de la base ya era `RESTRICT` y los índices no llegan al
  cliente. Sin cambio de comportamiento en runtime; el autor además comparó `index.d.ts` byte a
  byte. Prisma admite `Restrict` en relaciones opcionales sobre Postgres.
- `check:drift` detecta una diferencia nueva: la salida de `migrate diff` se normaliza (CRLF,
  blancos, aviso de migración vacía, notas `-- #`) y cualquier sentencia que no esté en
  `drift-esperado.sql` (o que falte) hace fallar con código 1; un fallo del propio Prisma lanza
  excepción (falla cerrado). Un cambio de `schema.prisma` sin migración aparece como sentencia
  nueva. Los tests de `check-drift.test.mjs` cubren sobra, falta, CRLF y host remoto.
- Alcance sobre bases: en local la URL sale de `dbUrl('ayr_drift_check')` (127.0.0.1:5434) y se
  ignora el entorno; en CI solo con `GITHUB_ACTIONS=true` y host `localhost`/`127.0.0.1`, y el
  nombre se fuerza a `ayr_drift_check`. El `DROP/CREATE` usa la URL de mantenimiento sin
  parámetros. No puede tocar Neon ni `ayr_local`.
- El paso se ejecuta en el job `e2e` tras `db:generate`; el servicio es `postgres:17-alpine`
  (admite `DROP DATABASE … WITH (FORCE)`) y el usuario es superusuario. No altera la base del E2E.
- `migrations-diff.mjs --script` es un añadido aditivo y de solo lectura.

**B. seed:escenarios**

- `assertEscenariosDb` corre antes de cualquier conexión en `seedEscenarios` (primera línea) y
  rechaza Neon, hosts remotos, otro motor, URL rota, `ayr_local_e2e`, `ayr_localx`, `ayr_ci_e2e`
  y los nombres con codificación o barra final. No lee `DATABASE_URL` ni `DIRECT_URL` del entorno
  heredado: la URL sale solo de `ESCENARIOS_DATABASE_URL` o del Docker fijo.
- Procesos hijos: `prepareDatabase` y `startApi` fijan `DATABASE_URL` y `DIRECT_URL` explícitos
  (`run` los mezcla sobre `process.env` con prioridad al hijo) y `dotenv` no sobrescribe variables
  ya definidas, por lo que `apps/api/.env` (Neon `dev`) no gana. `schema.prisma` solo usa esas dos
  variables (sin `shadowDatabaseUrl`). `seed-view.ts` agrega su propio cerco por host. La API
  nace con `JOBS_ENABLED=false`, `PSE_ENABLED=false` y sin R2/Nubefact.
- `docker compose up` solo se ejecuta sin override; la API usa el puerto 3200 con lista de
  reservados (3000/3001/3002/3100/3101/4000/4001) y se niega si el puerto ya responde.
- La prueba de integración exige `ESCENARIOS_DATABASE_URL`, pasa por el mismo guard y se niega
  a correr contra el puerto 5434 del dueño. El job `escenarios` usa un Postgres de servicio
  propio y no hereda secretos.
- `voidPrevious`: nunca lanza, acota a OP por SKU DEMO, compras/cortes/bobinas por proveedor DEMO
  y usa solo las rutas de la API (sin SQL). Sujeto a P2-2.
- Sin datos reales del negocio en el diff (RUC y DNI son ficticios 2099…/999999…).

---

## Respuesta del autor (cc42, antes del PR)

La autorrevisión (subagente sin el contexto de implementación) coincidió en el P1 y en el P2-2, y
sumó otros riesgos. Lo que se hizo:

| Hallazgo                                        | Qué se hizo                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1 `?host=` / `?dbname=`                      | El guard solo admite `schema=public` y rearma la URL desde sus partes fijas; tests para `?host=`, `?dbname=`, otro schema, `[::1]`, `localhost.` y nombre codificado. `check-drift.mjs` rearma su URL igual. |
| P2-1 puerto libre                               | Se deja: el override es explícito, documentado para la prueba, y `seed:escenarios:test` se niega a correr contra el 5434 del dueño.                                                                          |
| P2-2 cliente por nombre                         | `voidPrevious` y la prueba filtran solo por el id del cliente DEMO (encontrado por su DNI).                                                                                                                  |
| P2-3 `APIS_NET_PE_TOKEN`                        | La API propia lo recibe vacío.                                                                                                                                                                               |
| P2-4 `ayr_drift_check` compartida               | Se deja: dos `check:drift` simultáneos en la misma máquina chocarían; en la CI cada job tiene su Postgres.                                                                                                   |
| P2-5 aviso en el schema                         | Comentario `//` (no `///`, para no tocar los tipos del cliente) en los 5 `operationDate`, citando D-594. `index.d.ts` sigue idéntico.                                                                        |
| P2-6 casos del guard                            | Agregados (ver P1-1). La comparación por conjunto de `check:drift` se deja: hoy no hay sentencias duplicadas ni `;` en literales.                                                                            |
| Autorrevisión: `buyCoils` con `findIndex = -1`  | Ahora lanza en vez de tomar la última bobina.                                                                                                                                                                |
| Autorrevisión: orden de las OP                  | Por el número del correlativo, no por texto.                                                                                                                                                                 |
| Autorrevisión: la prueba no cubría casos usados | Entre las dos corridas, la prueba registra y cierra P2, registra M2 y fabrica y cierra una OP de drywall; la segunda corrida tiene que anularlas sin fallas. Pasa en base nueva (2 min 08 s).                |
| Autorrevisión: `pageSize=200` sin paginar       | Se deja: lo DEMO de una corrida son 6 OP, 7 compras y 25 bobinas.                                                                                                                                            |
